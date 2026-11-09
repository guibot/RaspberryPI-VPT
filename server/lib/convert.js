'use strict';
// Fila de conversão de vídeos (uma de cada vez) com ffmpeg:
// H.264 yuv420p, tamanho máximo configurável (mantém a proporção, sem ampliar), fps constante, sem áudio,
// +faststart, GOP curto sem B-frames (ajuda o loop) e HDR convertido para SDR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
// Sem conversão só se aceita o que o Chromium toca e o servidor lista como vídeo; o resto é convertido na mesma.
const COPY_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const COPY_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);

const probe = file => new Promise((resolve, reject) =>
  execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,color_transfer,codec_name:format=duration', '-of', 'json', file],
    { timeout: 30000 }, (err, out) => { if (err) return reject(err); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } }));

// Constrói a cadeia de filtros. Exportada para os testes.
function buildFilters({ maxWidth, maxHeight, fps }, hdr) {
  const f = [];
  if (hdr) f.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  f.push(`scale=w='min(${maxWidth},iw)':h='min(${maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  f.push(`fps=${fps}`, 'format=yuv420p');
  return f.join(',');
}

class Converter extends EventEmitter {
  constructor({ uploadDir, mediaDir, getSettings }) {
    super();
    this.uploadDir = uploadDir; this.mediaDir = mediaDir; this.getSettings = getSettings;
    this.jobs = [];                 // { id, name, status: queued|converting|done|error, progress, error }
    this.current = null;
    this.running = false;
    fs.mkdirSync(uploadDir, { recursive: true });
    this._lastEmit = 0;
  }

  list() { return this.jobs.map(({ id, name, status, progress, error }) => ({ id, name, status, progress, error })); }
  _emit(force = true) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 500) return;
    this._lastEmit = now; this.emit('jobs', this.list());
  }

  // Reencaminha ficheiros que ficaram na pasta de uploads (ex.: reinício a meio) e apaga uploads incompletos.
  recover() {
    for (const f of fs.readdirSync(this.uploadDir)) {
      const full = path.join(this.uploadDir, f);
      if (f.endsWith('.part') || f.endsWith('.out.mp4')) { try { fs.unlinkSync(full); } catch {} continue; }
      const m = f.match(/^([0-9a-f]{8})__(.+)$/);
      if (m) this.enqueue(m[1], full, m[2]);
    }
  }

  enqueue(id, src, origName) {
    this.jobs.push({ id, name: origName, src, status: 'queued', progress: 0, error: null });
    this._emit(); this._run();
  }

  // Cancela um trabalho em curso/na fila, ou remove da lista um já terminado.
  dismiss(id) {
    const j = this.jobs.find(x => x.id === id);
    if (!j) return false;
    if (j.status === 'converting' && this.child) { j.cancelled = true; this.child.kill('SIGKILL'); return true; }
    if (j.status === 'queued') { try { fs.unlinkSync(j.src); } catch {} }
    this.jobs = this.jobs.filter(x => x !== j);
    this._emit();
    return true;
  }

  uniqueName(base, ext = '.mp4') {
    let name = base + ext, n = 2;
    while (fs.existsSync(path.join(this.mediaDir, name))) name = `${base}-${n++}${ext}`;
    return name;
  }

  async _run() {
    if (this.running) return;
    this.running = true;
    try {
      let job;
      while ((job = this.jobs.find(j => j.status === 'queued'))) await this._convert(job);
    } finally { this.running = false; }
  }

  async _convert(job) {
    job.status = 'converting'; job.progress = 0; this._emit();
    const tmp = path.join(this.uploadDir, `${job.id}.out.mp4`);
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch {} try { fs.unlinkSync(job.src); } catch {} };
    try {
      const info = await probe(job.src);
      const st = info.streams && info.streams[0];
      if (!st) throw new Error('the file has no video');
      const duration = Number(info.format && info.format.duration) || 0;
      const settings = this.getSettings();
      const ext = path.extname(job.name).toLowerCase();
      if (settings.process === false && COPY_EXT.has(ext) && COPY_CODECS.has(st.codec_name)) {
        const base = path.basename(job.name, ext).replace(/^\.+/, '') || 'video';
        const final = this.uniqueName(base, ext);                 // guarda o ficheiro tal como foi enviado
        fs.renameSync(job.src, path.join(this.mediaDir, final));
        job.status = 'done'; job.progress = 100; job.result = final;
        this._emit(); this.emit('media', final);
        setTimeout(() => { this.jobs = this.jobs.filter(x => x !== job); this._emit(); }, 30000).unref();
        return;
      }
      const vf = buildFilters(settings, HDR_TRANSFERS.has(st.color_transfer));
      const args = ['-v', 'error', '-y', '-i', job.src, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', vf,
        '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-bf', '0', '-g', String(settings.fps * 2), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
      await new Promise((resolve, reject) => {
        const child = this.child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '', buf = '';
        child.stdout.on('data', d => {
          buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
            if (m && duration) { job.progress = Math.min(99, Math.round(100 * Number(m[1]) / 1e6 / duration)); this._emit(false); }
          }
        });
        child.stderr.on('data', d => { err = (err + d).slice(-2000); });
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(job.cancelled ? 'cancelled' : (err.trim().split('\n').pop() || `ffmpeg exited with code ${code}`)))));
      });
      const base = path.basename(job.name, path.extname(job.name)).replace(/^\.+/, '') || 'video';
      const final = this.uniqueName(base);
      fs.renameSync(tmp, path.join(this.mediaDir, final));
      try { fs.unlinkSync(job.src); } catch {}
      job.status = 'done'; job.progress = 100; job.result = final;
      this._emit(); this.emit('media', final);
      setTimeout(() => { this.jobs = this.jobs.filter(x => x !== job); this._emit(); }, 30000).unref();
    } catch (e) {
      cleanup();
      if (job.cancelled) this.jobs = this.jobs.filter(x => x !== job);
      else { job.status = 'error'; job.error = e.message; }
      this._emit();
    } finally { this.child = null; }
  }
}

module.exports = { Converter, buildFilters };
