'use strict';
/*
 * Modelo de dados: valores por defeito, limites, normalização e operações sobre a configuração.
 * Funções puras (não tocam no disco). A persistência está em config.js.
 * Descrição completa e ordem das transformações: docs/MODELO.md
 */
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const RESOLUTIONS = [[1920, 1080], [1280, 720]];
const MAX_LAYERS = 32;
const CONVERT_SIZES = [[640, 480], [800, 600]];   // tamanho máximo dos vídeos convertidos
const CONVERT_FPS = [25, 30];

// [mínimo, máximo] aceites por campo numérico; valores fora do intervalo são cortados.
const LIMITS = {
  maskScale: [0.01, 20],
  videoScale: [0.01, 20],
  scale: [0.01, 20],
  videoOffsetX: [-5000, 5000],
  videoOffsetY: [-5000, 5000],
  x: [-10000, 10000],
  y: [-10000, 10000],
  pin: [-3000, 3000],          // cada deslocamento de canto (corner pin), em píxeis de saída
};
const NAME_MAX = 80;
const PIN_RE = /^\d{4,8}$/;

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const num = (v, d, lim) => (typeof v === 'number' && Number.isFinite(v) ? (lim ? clamp(v, lim) : v) : d);
const newId = () => crypto.randomBytes(6).toString('hex');

// Nome de ficheiro de media: só o nome base, sem caminhos (evita ../ e subpastas).
function mediaName(v) {
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  if (/[\/\\\0]/.test(v) || v.startsWith('.')) return null;
  return v;
}

function normalizeLayer(l, output) {
  l = l && typeof l === 'object' ? l : {};
  const pins = Array.isArray(l.pins) ? l.pins : [];
  return {
    id: typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : newId(),
    name: (typeof l.name === 'string' && l.name.trim() ? l.name : 'Layer').slice(0, NAME_MAX),
    visible: l.visible !== false,
    video: mediaName(l.video),
    mask: mediaName(l.mask),
    maskScale: num(l.maskScale, 1, LIMITS.maskScale),
    maskMode: l.maskMode === 'luminance' ? 'luminance' : 'alpha',
    videoScale: num(l.videoScale, 1, LIMITS.videoScale),
    videoOffsetX: num(l.videoOffsetX, 0, LIMITS.videoOffsetX),
    videoOffsetY: num(l.videoOffsetY, 0, LIMITS.videoOffsetY),
    x: num(l.x, output.width / 2, LIMITS.x),         // centro da layer, em píxeis de saída
    y: num(l.y, output.height / 2, LIMITS.y),
    scale: num(l.scale, 1, LIMITS.scale),
    pins: [0, 1, 2, 3].map(i => ({                    // TL, TR, BR, BL
      x: num(pins[i] && pins[i].x, 0, LIMITS.pin),
      y: num(pins[i] && pins[i].y, 0, LIMITS.pin),
    })),
  };
}

// Normaliza uma configuração qualquer (lida do disco ou recebida) para o formato atual.
function normalize(c) {
  c = c && typeof c === 'object' ? c : {};
  const o = c.output || {};
  const ok = RESOLUTIONS.some(([w, h]) => w === o.width && h === o.height);
  const output = ok ? { width: o.width, height: o.height } : { width: 1920, height: 1080 };
  const seen = new Set();
  const layers = [];
  for (const raw of Array.isArray(c.layers) ? c.layers : []) {
    if (layers.length >= MAX_LAYERS) break;
    const l = normalizeLayer(raw, output);
    if (seen.has(l.id)) continue;
    seen.add(l.id); layers.push(l);
  }
  const cv = c.convert || {};
  const okSize = CONVERT_SIZES.some(([w, h]) => w === cv.maxWidth && h === cv.maxHeight);
  const convert = { maxWidth: okSize ? cv.maxWidth : 640, maxHeight: okSize ? cv.maxHeight : 480, fps: CONVERT_FPS.includes(cv.fps) ? cv.fps : 30,
    process: cv.process !== false };      // false = guarda os vídeos como vêm (já comprimidos, ex.: HandBrake)
  return {
    version: SCHEMA_VERSION,
    rev: Number.isInteger(c.rev) && c.rev >= 0 ? c.rev : 0,    // sobe a cada alteração (sincronização)
    output,
    convert,
    pinHash: typeof c.pinHash === 'string' ? c.pinHash : '',    // '' = sem PIN
    layers,
  };
}

// ---------- PIN (hash com sal; nunca em texto simples) ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}
function verifyPin(pin, hash) {
  if (!hash) return true;                                      // sem PIN definido
  const [kind, saltHex, hashHex] = String(hash).split('$');
  if (kind !== 'scrypt' || typeof pin !== 'string') return false;
  const got = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(hashHex, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Versão enviada aos clientes: nunca inclui o hash do PIN.
const publicConfig = c => ({ version: c.version, rev: c.rev, output: c.output, hasPin: !!c.pinHash, convert: c.convert, layers: c.layers });

// ---------- operações ----------
class OpError extends Error {}
const findIndex = (c, id) => {
  const i = c.layers.findIndex(l => l.id === id);
  if (i < 0) throw new OpError(`layer inexistente: ${id}`);
  return i;
};
// Campos que o painel pode alterar (o id nunca muda).
const PATCHABLE = ['name', 'visible', 'video', 'mask', 'maskScale', 'maskMode', 'videoScale', 'videoOffsetX',
  'videoOffsetY', 'x', 'y', 'scale', 'pins'];

// Aplica uma operação e devolve uma configuração nova (a original não é alterada).
function applyOp(config, op) {
  if (!op || typeof op !== 'object') throw new OpError('operação inválida');
  const c = JSON.parse(JSON.stringify(config));
  switch (op.op) {
    case 'addLayer': {
      if (c.layers.length >= MAX_LAYERS) throw new OpError(`máximo de ${MAX_LAYERS} layers`);
      const l = normalizeLayer({ ...(op.layer || {}), id: undefined }, c.output);
      c.layers.push(l);
      break;
    }
    case 'removeLayer':
      c.layers.splice(findIndex(c, op.id), 1);
      break;
    case 'duplicateLayer': {
      if (c.layers.length >= MAX_LAYERS) throw new OpError(`máximo de ${MAX_LAYERS} layers`);
      const i = findIndex(c, op.id);
      const copy = { ...c.layers[i], id: undefined, name: (c.layers[i].name + ' (cópia)').slice(0, NAME_MAX),
        x: c.layers[i].x + 40, y: c.layers[i].y + 40 };
      c.layers.splice(i + 1, 0, normalizeLayer(copy, c.output));   // fica logo acima do original
      break;
    }
    case 'moveLayer': {                                            // índice 0 = fundo, último = topo
      const i = findIndex(c, op.id);
      if (!Number.isInteger(op.index)) throw new OpError('índice inválido');
      const [l] = c.layers.splice(i, 1);
      c.layers.splice(clamp(op.index, [0, c.layers.length]), 0, l);
      break;
    }
    case 'updateLayer': {
      const i = findIndex(c, op.id);
      const patch = {};
      for (const k of PATCHABLE) if (op.patch && k in op.patch) patch[k] = op.patch[k];
      c.layers[i] = normalizeLayer({ ...c.layers[i], ...patch, id: c.layers[i].id }, c.output);
      break;
    }
    case 'setOutput': {
      if (!RESOLUTIONS.some(([w, h]) => w === op.width && h === op.height)) throw new OpError('resolução não suportada');
      // Mantém a composição igual em proporção (as duas resoluções são 16:9): posição, escala e pins.
      const k = op.width / c.output.width;
      for (const l of c.layers) { l.x *= k; l.y *= k; l.scale *= k; for (const p of l.pins) { p.x *= k; p.y *= k; } }
      c.output = { width: op.width, height: op.height };
      break;
    }
    case 'setConvert': {
      if (!CONVERT_SIZES.some(([w, h]) => w === op.width && h === op.height) || !CONVERT_FPS.includes(op.fps)) throw new OpError('definições de conversão inválidas');
      c.convert = { maxWidth: op.width, maxHeight: op.height, fps: op.fps, process: op.process !== false };
      break;
    }
    case 'setPin':
      if (op.pin === '' || op.pin === null) c.pinHash = '';
      else if (typeof op.pin === 'string' && PIN_RE.test(op.pin)) c.pinHash = hashPin(op.pin);
      else throw new OpError('o PIN deve ter 4 a 8 dígitos');
      break;
    default:
      throw new OpError(`operação desconhecida: ${op.op}`);
  }
  const out = normalize(c);
  out.rev = config.rev + 1;
  return out;
}

module.exports = { normalize, applyOp, publicConfig, verifyPin, hashPin, OpError, LIMITS, RESOLUTIONS, MAX_LAYERS, SCHEMA_VERSION };
