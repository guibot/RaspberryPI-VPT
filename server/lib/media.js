'use strict';
// Biblioteca de media: lista ficheiros, lê dimensões (ffprobe) e gera miniaturas (ffmpeg), com cache.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const MASK_EXT = new Set(['.png']);

const run = (cmd, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

class Media {
  constructor(dir, thumbDir) {
    this.dir = dir; this.thumbDir = thumbDir;
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(thumbDir, { recursive: true });
    this.dims = new Map();        // "nome:mtime" -> {width,height}
    this.queue = Promise.resolve();   // as miniaturas são geradas uma de cada vez
    this.pending = new Map();
  }

  static safeName(n) { return typeof n === 'string' && n && !/[\/\\\0]/.test(n) && !n.startsWith('.') ? n : null; }
  // Limpa o nome de um ficheiro enviado: só o nome base, sem caracteres problemáticos.
  static sanitize(n) {
    n = String(n || '').split(/[\/\\]/).pop().normalize('NFC').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^[. ]+/, '').trim();
    return n.slice(0, 100);
  }

  // Nome livre na pasta de media (acrescenta -2, -3... se já existir).
  uniqueName(base, ext) {
    let name = base + ext, n = 2;
    while (fs.existsSync(path.join(this.dir, name))) name = `${base}-${n++}${ext}`;
    return name;
  }

  remove(name) {
    const f = this.file(name); if (!f || !fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    try { fs.unlinkSync(path.join(this.thumbDir, name + '.jpg')); } catch {}
    return true;
  }

  rename(from, to) {
    const a = this.file(from), b = this.file(to);
    if (!a || !b || !fs.existsSync(a)) return 'inexistente';
    if (fs.existsSync(b)) return 'existe';
    fs.renameSync(a, b);
    try { fs.renameSync(path.join(this.thumbDir, from + '.jpg'), path.join(this.thumbDir, to + '.jpg')); } catch {}
    return 'ok';
  }

  file(name) { const n = Media.safeName(name); return n ? path.join(this.dir, n) : null; }

  async probe(file, st) {
    const key = `${file}:${st.mtimeMs}`;
    if (this.dims.has(key)) return this.dims.get(key);
    let d = { width: 0, height: 0 };
    try {
      const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
      const [w, h] = out.trim().split(',').map(Number);
      if (w > 0 && h > 0) d = { width: w, height: h };
    } catch {}
    this.dims.set(key, d);
    return d;
  }

  async list() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (Media.safeName(name) !== name) continue;
      const ext = path.extname(name).toLowerCase();
      const kind = VIDEO_EXT.has(ext) ? 'video' : MASK_EXT.has(ext) ? 'mask' : null;
      if (!kind) continue;
      const file = path.join(this.dir, name);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      const item = { name, kind, size: st.size, mtime: Math.round(st.mtimeMs) };
      Object.assign(item, await this.probe(file, st));      // largura/altura (vídeos e máscaras)
      out.push(item);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Devolve o caminho da miniatura (frame do vídeo), gerando-a se faltar ou estiver desatualizada.
  thumb(name) {
    const src = this.file(name);
    if (!src) return Promise.reject(new Error('nome inválido'));
    const dst = path.join(this.thumbDir, name + '.jpg');
    if (this.pending.has(dst)) return this.pending.get(dst);
    const job = this.queue.then(async () => {
      const s = fs.statSync(src);
      try { if (fs.statSync(dst).mtimeMs >= s.mtimeMs) return dst; } catch {}
      for (const ss of ['0.5', '0']) {                  // vídeos muito curtos: tenta o 1.º frame
        try {
          await run('ffmpeg', ['-v', 'error', '-y', '-ss', ss, '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', dst], 30000);
          if (fs.existsSync(dst)) return dst;
        } catch {}
      }
      throw new Error('não foi possível gerar a miniatura');
    }).finally(() => this.pending.delete(dst));
    this.pending.set(dst, job);
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = { Media };
