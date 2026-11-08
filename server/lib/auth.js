'use strict';
// Autenticação por PIN: sessões em cookie assinado (HMAC) e limite de tentativas por IP.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_DAYS = 30;
const MAX_FAILS = 5;            // falhas seguidas antes de bloquear
const LOCK_MS = 30_000;         // duração do bloqueio

class Auth {
  constructor(dir) {
    this.file = path.join(dir, '.secret');
    this.secret = this._loadSecret();
    this.fails = new Map();     // ip -> { n, until }
  }

  _loadSecret() {
    try { const s = fs.readFileSync(this.file, 'utf8').trim(); if (s.length >= 32) return s; } catch {}
    return this._newSecret();
  }
  _newSecret() {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.file, s, { mode: 0o600 });
    return s;
  }
  // Trocar o segredo invalida todas as sessões (usado quando o PIN muda).
  rotate() { this.secret = this._newSecret(); }

  _sign(exp) { return crypto.createHmac('sha256', this.secret).update(String(exp)).digest('hex'); }
  issue() {
    const exp = Date.now() + SESSION_DAYS * 864e5;
    return `${exp}.${this._sign(exp)}`;
  }
  verify(token) {
    if (typeof token !== 'string') return false;
    const [exp, sig] = token.split('.');
    if (!/^\d+$/.test(exp || '') || Number(exp) < Date.now() || !sig) return false;
    const want = Buffer.from(this._sign(exp)), got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  static cookie(header, name) {
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  setCookieHeader() {
    return `session=${encodeURIComponent(this.issue())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  }
  static clearCookieHeader() { return 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'; }

  // O player corre no próprio Pi (localhost) e não precisa de PIN.
  static isLoopback(addr) { return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'; }

  // ---- limite de tentativas ----
  lockedFor(ip) {
    const f = this.fails.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }
  fail(ip) {
    const f = this.fails.get(ip) || { n: 0, until: 0 };
    if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; }
    f.n++;
    if (f.n >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.n = 0; }
    this.fails.set(ip, f);
  }
  success(ip) { this.fails.delete(ip); }
}

module.exports = { Auth, MAX_FAILS, LOCK_MS };
