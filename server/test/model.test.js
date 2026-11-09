'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, applyOp, publicConfig, verifyPin, OpError, MAX_LAYERS } = require('../lib/model');

const base = () => normalize({});

test('configuração vazia fica com valores por defeito', () => {
  const c = base();
  assert.deepEqual(c.output, { width: 1920, height: 1080 });
  assert.equal(c.layers.length, 0);
  assert.equal(c.pinHash, '');
  assert.equal(c.rev, 0);
});

test('layer nova: defaults, centrada no ecrã, 4 pins a zero', () => {
  const c = applyOp(base(), { op: 'addLayer' });
  const l = c.layers[0];
  assert.equal(l.x, 960); assert.equal(l.y, 540);
  assert.equal(l.scale, 1); assert.equal(l.maskMode, 'alpha'); assert.equal(l.visible, true);
  assert.equal(l.pins.length, 4);
  assert.ok(l.pins.every(p => p.x === 0 && p.y === 0));
  assert.match(l.id, /^[\w-]+$/);
});

test('valores fora dos limites são cortados e lixo é substituído por defaults', () => {
  const c = normalize({ layers: [{ id: 'a', scale: 9999, maskScale: -5, x: 'abc', videoOffsetX: Infinity, maskMode: 'xpto',
    pins: [{ x: 1e9, y: -1e9 }] }] });
  const l = c.layers[0];
  assert.equal(l.scale, 20); assert.equal(l.maskScale, 0.01); assert.equal(l.x, 960);
  assert.equal(l.videoOffsetX, 0); assert.equal(l.maskMode, 'alpha');
  assert.equal(l.pins[0].x, 3000); assert.equal(l.pins[0].y, -3000);
  assert.equal(l.pins[3].x, 0);
});

test('nomes de ficheiro com caminhos são rejeitados (sem path traversal)', () => {
  const l = normalize({ layers: [{ video: '../../etc/passwd', mask: 'a/b.png' }, { video: '.escondido', mask: 'ok.png' }] }).layers;
  assert.equal(l[0].video, null); assert.equal(l[0].mask, null);
  assert.equal(l[1].video, null); assert.equal(l[1].mask, 'ok.png');
});

test('ids duplicados são removidos; resolução inválida volta a 1920x1080', () => {
  const c = normalize({ output: { width: 800, height: 600 }, layers: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] });
  assert.deepEqual(c.layers.map(l => l.id), ['a', 'b']);
  assert.deepEqual(c.output, { width: 1920, height: 1080 });
});

test('máximo de layers', () => {
  let c = base();
  for (let i = 0; i < MAX_LAYERS; i++) c = applyOp(c, { op: 'addLayer' });
  assert.throws(() => applyOp(c, { op: 'addLayer' }), OpError);
  assert.equal(normalize({ layers: Array.from({ length: 50 }, (_, i) => ({ id: 'l' + i })) }).layers.length, MAX_LAYERS);
});

test('operações não alteram a configuração original e sobem o rev', () => {
  const a = base();
  const b = applyOp(a, { op: 'addLayer' });
  assert.equal(a.layers.length, 0); assert.equal(b.layers.length, 1);
  assert.equal(b.rev, a.rev + 1);
});

test('duplicar: cópia logo acima do original, id novo, deslocada', () => {
  let c = applyOp(base(), { op: 'addLayer', layer: { name: 'A', video: 'v.mp4' } });
  c = applyOp(c, { op: 'addLayer', layer: { name: 'B' } });
  c = applyOp(c, { op: 'duplicateLayer', id: c.layers[0].id });
  assert.deepEqual(c.layers.map(l => l.name), ['A', 'A (cópia)', 'B']);
  assert.notEqual(c.layers[0].id, c.layers[1].id);
  assert.equal(c.layers[1].video, 'v.mp4');
  assert.equal(c.layers[1].x, c.layers[0].x + 40);
});

test('reordenar (z-index) e remover', () => {
  let c = base();
  for (const n of ['A', 'B', 'C']) c = applyOp(c, { op: 'addLayer', layer: { name: n } });
  const [a, , cc] = c.layers;
  c = applyOp(c, { op: 'moveLayer', id: cc.id, index: 0 });
  assert.deepEqual(c.layers.map(l => l.name), ['C', 'A', 'B']);
  c = applyOp(c, { op: 'moveLayer', id: a.id, index: 99 });
  assert.deepEqual(c.layers.map(l => l.name), ['C', 'B', 'A']);
  c = applyOp(c, { op: 'removeLayer', id: cc.id });
  assert.deepEqual(c.layers.map(l => l.name), ['B', 'A']);
  assert.throws(() => applyOp(c, { op: 'removeLayer', id: 'nao-existe' }), OpError);
});

test('updateLayer: só altera campos permitidos e nunca o id', () => {
  let c = applyOp(base(), { op: 'addLayer', layer: { name: 'A' } });
  const id = c.layers[0].id;
  c = applyOp(c, { op: 'updateLayer', id, patch: { scale: 2, id: 'roubado', visible: false, pins: [{ x: 10, y: -5 }] } });
  const l = c.layers[0];
  assert.equal(l.id, id); assert.equal(l.scale, 2); assert.equal(l.visible, false);
  assert.deepEqual(l.pins[0], { x: 10, y: -5 }); assert.deepEqual(l.pins[1], { x: 0, y: 0 });
});

test('mudar para 720p mantém a composição em proporção', () => {
  let c = applyOp(base(), { op: 'addLayer', layer: { x: 960, y: 540, scale: 3, pins: [{ x: 30, y: 60 }] } });
  c = applyOp(c, { op: 'setOutput', width: 1280, height: 720 });
  const l = c.layers[0];
  assert.deepEqual(c.output, { width: 1280, height: 720 });
  assert.ok(Math.abs(l.x - 640) < 1e-9 && Math.abs(l.y - 360) < 1e-9);
  assert.ok(Math.abs(l.scale - 2) < 1e-9);
  assert.ok(Math.abs(l.pins[0].x - 20) < 1e-9 && Math.abs(l.pins[0].y - 40) < 1e-9);
  assert.throws(() => applyOp(c, { op: 'setOutput', width: 800, height: 600 }), OpError);
});

test('PIN: validação, hash com sal, verificação e nunca exposto', () => {
  let c = applyOp(base(), { op: 'setPin', pin: '1234' });
  assert.match(c.pinHash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.ok(!c.pinHash.includes('1234'));
  assert.equal(verifyPin('1234', c.pinHash), true);
  assert.equal(verifyPin('4321', c.pinHash), false);
  assert.equal(verifyPin('', c.pinHash), false);
  assert.notEqual(applyOp(base(), { op: 'setPin', pin: '1234' }).pinHash, c.pinHash);   // sal diferente
  for (const bad of ['12', '123456789', 'abcd', 1234]) assert.throws(() => applyOp(base(), { op: 'setPin', pin: bad }), OpError);
  const pub = publicConfig(c);
  assert.equal(pub.hasPin, true); assert.ok(!('pinHash' in pub)); assert.ok(!JSON.stringify(pub).includes('scrypt'));
  assert.equal(verifyPin('qualquer', applyOp(c, { op: 'setPin', pin: '' }).pinHash), true);   // PIN removido
});

test('operações inválidas lançam OpError', () => {
  assert.throws(() => applyOp(base(), null), OpError);
  assert.throws(() => applyOp(base(), { op: 'fazerCafe' }), OpError);
});

test('conversão de vídeos: ligada por defeito e pode ser desligada', () => {
  let c = base();
  assert.equal(c.convert.process, true);
  c = applyOp(c, { op: 'setConvert', width: 800, height: 600, fps: 25, process: false });
  assert.deepEqual(c.convert, { maxWidth: 800, maxHeight: 600, fps: 25, process: false });
  assert.equal(normalize(c).convert.process, false);
  c = applyOp(c, { op: 'setConvert', width: 640, height: 480, fps: 30 });
  assert.equal(c.convert.process, true);
});
