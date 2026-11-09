'use strict';
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { ConfigStore, publicConfig } = require('./lib/config');
const { OpError } = require('./lib/model');
const { Auth } = require('./lib/auth');
const { Media } = require('./lib/media');
const { Converter } = require('./lib/convert');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const sysstats = require('./lib/sysstats');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const store = new ConfigStore(DATA_DIR);
const auth = new Auth(DATA_DIR);
const media = new Media(path.join(DATA_DIR, 'media'), path.join(DATA_DIR, 'thumbs'));

const converter = new Converter({
  uploadDir: path.join(DATA_DIR, 'uploads'), mediaDir: media.dir,
  getSettings: () => { const c = store.get().convert; return { maxWidth: c.maxWidth, maxHeight: c.maxHeight, fps: c.fps, process: c.process }; },
});
converter.recover();

const MAX_UPLOAD = 4 * 1024 ** 3;        // 4 GB por ficheiro
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const app = express();
app.disable('x-powered-by');

// ---------- utilitários ----------
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// Autorizado se: não há PIN, ou o pedido vem do próprio Pi (player), ou traz uma sessão válida.
function isAuthorized(req) {
  if (!store.get().pinHash) return true;
  if (Auth.isLoopback(req.socket.remoteAddress)) return true;
  return auth.verify(Auth.cookie(req.headers.cookie, 'session'));
}
const requireAuth = (req, res, next) => (isAuthorized(req) ? next() : res.status(401).json({ error: 'auth' }));

// ---------- rotas abertas ----------
app.get('/api/info', async (_req, res) => {
  const ips = lanAddresses();
  const urls = ips.map(ip => `http://${ip}:${PORT}`);
  const mdns = `http://${os.hostname()}.local:${PORT}`;
  const qr = urls[0] ? await QRCode.toString(urls[0], { type: 'svg', margin: 1 }) : null;
  res.set('Cache-Control', 'no-store').json({ port: PORT, ips, urls, mdns, qr });
});

app.get('/api/session', (req, res) =>
  res.set('Cache-Control', 'no-store').json({ hasPin: !!store.get().pinHash, authed: isAuthorized(req) }));

app.post('/api/login', express.json({ limit: '1kb' }), (req, res) => {
  const ip = req.socket.remoteAddress;
  const wait = auth.lockedFor(ip);
  if (wait) return res.status(429).json({ error: 'locked', retryAfter: wait });
  const pin = req.body && req.body.pin;
  if (typeof pin !== 'string' || !store.verifyPin(pin)) {
    auth.fail(ip);
    return res.status(401).json({ error: 'pin' });
  }
  auth.success(ip);
  res.set('Set-Cookie', auth.setCookieHeader()).json({ ok: true });
});

app.post('/api/logout', (_req, res) => res.set('Set-Cookie', Auth.clearCookieHeader()).json({ ok: true }));

// ---------- rotas protegidas ----------
app.get('/api/stats', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(sysstats.sample()));
app.get('/api/config', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(publicConfig(store.get())));

app.get('/api/media', requireAuth, async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await media.list()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/thumb/:name', requireAuth, async (req, res) => {
  try {
    const file = await media.thumb(req.params.name);
    res.set('Cache-Control', 'private, max-age=300').sendFile(file);
  } catch { res.status(404).end(); }
});

// Mudar o PIN: troca o segredo (termina as outras sessões) e dá uma sessão nova a quem o mudou.
app.post('/api/pin', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  try {
    store.apply({ op: 'setPin', pin: req.body && req.body.pin });
  } catch (e) {
    return res.status(400).json({ error: e instanceof OpError ? e.message : 'erro' });
  }
  auth.rotate();
  for (const c of wss.clients) if (!c.loopback) c.close(4401, 'pin alterado');
  if (store.get().pinHash) res.set('Set-Cookie', auth.setCookieHeader());
  res.json({ ok: true, hasPin: !!store.get().pinHash });
});

// Quais layers usam um ficheiro de media.
const usageOf = name => store.get().layers.filter(l => l.video === name || l.mask === name);

app.get('/api/jobs', requireAuth, (_req, res) => res.set('Cache-Control', 'no-store').json(converter.list()));
app.delete('/api/jobs/:id', requireAuth, (req, res) => res.status(converter.dismiss(req.params.id) ? 200 : 404).json({}));

// Upload: o corpo do pedido é o próprio ficheiro (sem multipart); o nome vai no cabeçalho X-Filename.
app.put('/api/upload', requireAuth, async (req, res) => {
  const fail = (code, error) => { if (!res.headersSent) res.status(code).json({ error }); req.resume(); };
  let orig;
  try { orig = Media.sanitize(decodeURIComponent(req.headers['x-filename'] || '')); } catch { orig = ''; }
  const size = Number(req.headers['content-length']);
  if (!orig) return fail(400, 'nome de ficheiro em falta');
  if (!size) return fail(411, 'tamanho em falta');
  if (size > MAX_UPLOAD) return fail(413, 'ficheiro demasiado grande (máx. 4 GB)');
  try { const f = fs.statfsSync(DATA_DIR); if (f.bavail * f.bsize < size * 2 + 512 * 1024 ** 2) return fail(507, 'sem espaço livre suficiente'); } catch {}
  const ext = path.extname(orig).toLowerCase();
  const isPng = ext === '.png';
  const id = crypto.randomBytes(4).toString('hex');
  const part = path.join(converter.uploadDir, `${id}__${orig}.part`);
  let received = 0;
  const limit = new Transform({ transform(chunk, _e, cb) { received += chunk.length; cb(received > size ? new Error('excedeu o tamanho') : null, chunk); } });
  try {
    await pipeline(req, limit, fs.createWriteStream(part));
  } catch { try { fs.unlinkSync(part); } catch {} return fail(400, 'envio interrompido'); }
  if (received !== size) { try { fs.unlinkSync(part); } catch {} return fail(400, 'envio incompleto'); }
  if (isPng) {                                          // máscara: valida e guarda diretamente
    const head = Buffer.alloc(8); const fd = fs.openSync(part, 'r'); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
    if (!head.equals(PNG_MAGIC)) { fs.unlinkSync(part); return fail(415, 'não é um PNG válido'); }
    const name = media.uniqueName(path.basename(orig, ext), '.png');
    fs.renameSync(part, path.join(media.dir, name));
    broadcast({ type: 'media' });
    return res.json({ ok: true, kind: 'mask', name });
  }
  const final = path.join(converter.uploadDir, `${id}__${orig}`);
  fs.renameSync(part, final);
  converter.enqueue(id, final, orig);                   // vídeo: vai para a fila de conversão
  res.json({ ok: true, kind: 'video', id });
});

app.delete('/api/media/:name', requireAuth, (req, res) => {
  const name = req.params.name, users = usageOf(name);
  if (users.length && req.query.force !== '1') return res.status(409).json({ error: 'em uso', layers: users.map(l => l.name) });
  if (!media.remove(name)) return res.status(404).json({ error: 'inexistente' });
  for (const l of users) {                              // as layers deixam de apontar para um ficheiro que já não existe
    store.apply({ op: 'updateLayer', id: l.id, patch: { [l.video === name ? 'video' : 'mask']: null } });
  }
  broadcast({ type: 'media' });
  res.json({ ok: true });
});

app.post('/api/media/:name/rename', requireAuth, express.json({ limit: '1kb' }), (req, res) => {
  const from = req.params.name, ext = path.extname(from);
  const base = Media.sanitize(String((req.body && req.body.name) || '')).replace(new RegExp(ext.replace('.', '\\.') + '$', 'i'), '');
  if (!base) return res.status(400).json({ error: 'nome inválido' });
  const to = base + ext;
  const r = to === from ? 'ok' : media.rename(from, to);
  if (r === 'inexistente') return res.status(404).json({ error: 'inexistente' });
  if (r === 'existe') return res.status(409).json({ error: 'já existe um ficheiro com esse nome' });
  for (const l of usageOf(from)) {                      // as layers continuam a apontar para o ficheiro renomeado
    const patch = {}; if (l.video === from) patch.video = to; if (l.mask === from) patch.mask = to;
    store.apply({ op: 'updateLayer', id: l.id, patch });
  }
  broadcast({ type: 'media' });
  res.json({ ok: true, name: to });
});

app.use('/media', requireAuth, express.static(media.dir, { fallthrough: false, maxAge: 0, etag: true }));
app.use('/player', express.static(path.join(ROOT, 'public', 'player'), { maxAge: 0 }));
app.use('/shared', express.static(path.join(ROOT, 'public', 'shared'), { maxAge: 0 }));
app.use('/', express.static(path.join(ROOT, 'public', 'panel'), { maxAge: 0 }));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const refuse = code => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (new URL(req.url, 'http://x').pathname !== '/ws') return refuse('404 Not Found');
  // Impede que outro site aberto no browser use a sessão para falar com o servidor (CSWSH).
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return refuse('403 Forbidden'); } catch { return refuse('403 Forbidden'); } }
  if (!isAuthorized(req)) return refuse('401 Unauthorized');
  wss.handleUpgrade(req, socket, head, ws => { ws.loopback = Auth.isLoopback(req.socket.remoteAddress); wss.emit('connection', ws, req); });
});

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(text);
}

// ---- estatísticas para o painel (debug): só se medem enquanto houver painéis a pedir ----
let statsTimer = null, lastPlayer = null;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
function updateStatsTimer() {
  const subs = [...wss.clients].filter(c => c.statsSub).length;
  const players = [...wss.clients].filter(c => c.loopback);
  if (subs && !statsTimer) {
    statsTimer = setInterval(() => {
      const sys = sysstats.sample();
      const player = lastPlayer && Date.now() - lastPlayer.t < 3500 ? lastPlayer.s : null;   // null = player sem resposta
      const text = JSON.stringify({ type: 'stats', cpu: sys.cpu, gpu: sys.gpu, temp: sys.temp, player });
      for (const c of wss.clients) if (c.statsSub && c.readyState === 1) c.send(text);
    }, 1000);
  } else if (!subs && statsTimer) { clearInterval(statsTimer); statsTimer = null; lastPlayer = null; }
  for (const p of players) send(p, { type: 'debug', on: subs > 0 });     // o player só mede quando alguém vê
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.statsSub = false;
  ws.on('close', updateStatsTimer);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && msg.type === 'subscribe') { ws.statsSub = !!msg.stats; updateStatsTimer(); return; }
    if (msg && msg.type === 'player-stats') {                    // só o player local (loopback) pode reportar
      if (ws.loopback) lastPlayer = { t: Date.now(), s: { fps: num(msg.fps), dropped: num(msg.dropped), recent: num(msg.recent), total: num(msg.total), layers: num(msg.layers) } };
      return;
    }
    if (!msg || msg.type !== 'op') return;
    // O PIN só se altera por /api/pin (precisa de renovar a sessão); a última alteração prevalece.
    if (msg.op && msg.op.op === 'setPin') return send(ws, { type: 'error', message: 'use /api/pin' });
    try { store.apply(msg.op); }
    catch (e) { send(ws, { type: 'error', message: e instanceof OpError ? e.message : 'operação inválida' }); }
  });
  send(ws, { type: 'config', config: publicConfig(store.get()) });
  send(ws, { type: 'jobs', jobs: converter.list() });
  if (ws.loopback && statsTimer) send(ws, { type: 'debug', on: true });
});

setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; c.ping(); }
}, 15000).unref();

converter.on('jobs', jobs => broadcast({ type: 'jobs', jobs }));
converter.on('media', name => { media.thumb(name).catch(() => {}); broadcast({ type: 'media' }); });
store.on('change', cfg => broadcast({ type: 'config', config: publicConfig(cfg) }));

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[servidor] http://0.0.0.0:${PORT}  (dados: ${DATA_DIR})`);
    for (const ip of lanAddresses()) console.log(`[servidor] painel: http://${ip}:${PORT}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); server.close(); process.exit(0); });
}

module.exports = { app, server, store, auth };
