'use strict';
// Persistência da configuração: ficheiro JSON com escrita atómica, cópia de segurança e deteção de edições externas.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const model = require('./model');

const WRITE_DELAY_MS = 250;   // junta várias alterações seguidas (ex.: arrastar um slider) numa só escrita

class ConfigStore extends EventEmitter {
  constructor(dir, { watch = true } = {}) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    this._cleanTmp();
    this.config = this._load();
    this._lastSerialized = this._serialize(this.config);
    this._dirty = !fs.existsSync(this.file);
    this._timer = null;
    if (this._dirty) this.flush();
    if (watch) this._watch();
  }

  _serialize(c) { return JSON.stringify(c, null, 2); }

  // Ficheiros temporários deixados por uma falha a meio de uma escrita nunca são usados: apagam-se.
  _cleanTmp() {
    for (const f of fs.readdirSync(this.dir)) if (/^config\.json\.\d+\.tmp$/.test(f)) {
      try { fs.unlinkSync(path.join(this.dir, f)); } catch {}
    }
  }

  _load() {
    for (const f of [this.file, this.file + '.bak']) {            // tenta o principal e depois a cópia
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (f !== this.file) console.error('[config] a usar a cópia de segurança', path.basename(f));
        return model.normalize(raw);
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        console.error(`[config] ${path.basename(f)} inválido:`, e.message);
        if (f === this.file) { try { fs.copyFileSync(f, `${f}.corrupt-${Date.now()}`); } catch {} }
      }
    }
    return model.normalize({});
  }

  // Escrita atómica: temporário no mesmo diretório + fsync + rename. A versão anterior fica em config.json.bak.
  _writeAtomic(text) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {}
    fs.renameSync(tmp, this.file);
  }

  flush() {
    clearTimeout(this._timer); this._timer = null;
    if (!this._dirty) return;
    this._lastSerialized = this._serialize(this.config);
    this._writeAtomic(this._lastSerialized);
    this._dirty = false;
  }

  get() { return this.config; }

  // Aplica uma operação do modelo (ver model.applyOp). Lança OpError se for inválida.
  apply(op) {
    this.config = model.applyOp(this.config, op);
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.emit('change', this.config);
    return this.config;
  }

  verifyPin(pin) { return model.verifyPin(pin, this.config.pinHash); }

  // Permite editar o JSON à mão: recarrega quando o ficheiro muda por fora.
  _watch() {
    let timer = null;
    this._watcher = fs.watch(this.dir, (_ev, name) => {
      if (name !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (this._dirty) return;                                    // há uma escrita nossa pendente
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { console.error('[config] edição externa inválida, ignorada'); return; }
        const next = model.normalize(parsed);
        if (this._serialize(next) === this._lastSerialized) return;
        next.rev = this.config.rev + 1;
        this.config = next; this._lastSerialized = this._serialize(next);
        console.log('[config] recarregada após edição externa');
        this.emit('change', this.config);
      }, 150);
    });
    this._watcher.unref();
  }

  close() { this.flush(); if (this._watcher) this._watcher.close(); }
}

module.exports = { ConfigStore, publicConfig: model.publicConfig, normalize: model.normalize };
