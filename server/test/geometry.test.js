'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// geometry.js é um script de browser (define `const Geometry`); carrega-se num contexto isolado.
const code = fs.readFileSync(path.join(__dirname, '../../public/shared/geometry.js'), 'utf8');
const raw = vm.runInNewContext(code + '\nGeometry');
// Os objetos criados no contexto isolado têm outros protótipos; passa-se por JSON para o assert os comparar bem.
const Geometry = { compute: (...a) => JSON.parse(JSON.stringify(raw.compute(...a))) };

const layer = (o = {}) => ({ x: 960, y: 540, scale: 1, videoScale: 1, videoOffsetX: 0, videoOffsetY: 0, maskScale: 1, maskMode: 'alpha',
  pins: [0, 1, 2, 3].map(() => ({ x: 0, y: 0 })), ...o });
const MASK = [800, 600];

test('a caixa tem o tamanho da máscara, seja qual for o vídeo (a máscara não muda de proporção)', () => {
  const a = Geometry.compute(layer(), MASK, [640, 480]);     // vídeo 4:3
  const b = Geometry.compute(layer(), MASK, [1280, 720]);    // vídeo 16:9
  const c = Geometry.compute(layer(), MASK, [270, 480]);     // vídeo vertical
  for (const g of [a, b, c]) assert.deepEqual(g.box, { width: 800, height: 600 });
  assert.equal(a.transform, b.transform); assert.equal(b.transform, c.transform);   // mesma posição no ecrã
  assert.deepEqual(a.pinned, b.pinned);
});

test('cover: o vídeo enche a caixa sem deformar e fica centrado', () => {
  const g = Geometry.compute(layer(), MASK, [1280, 720]);    // 16:9 numa caixa 4:3 -> escala pela altura
  assert.ok(Math.abs(g.video.height - 600) < 1e-9);
  assert.ok(Math.abs(g.video.width - 600 * 1280 / 720) < 1e-9);
  assert.ok(g.video.width >= 800 && g.video.height >= 600);                 // cobre a caixa toda
  assert.ok(Math.abs(g.video.left - (800 - g.video.width) / 2) < 1e-9);     // centrado
  const v = Geometry.compute(layer(), MASK, [270, 480]);     // vertical -> escala pela largura
  assert.ok(Math.abs(v.video.width - 800) < 1e-9 && v.video.height >= 600);
  assert.ok(Math.abs(v.video.width / v.video.height - 270 / 480) < 1e-9);   // proporção do vídeo mantida
});

test('sem máscara a caixa é o vídeo (cover = identidade)', () => {
  const g = Geometry.compute(layer(), [640, 480], [640, 480]);
  assert.deepEqual(g.box, { width: 640, height: 480 });
  assert.deepEqual([g.video.width, g.video.height, g.video.left, g.video.top], [640, 480, 0, 0]);
});

test('videoScale e deslocamento ajustam o vídeo por cima do cover', () => {
  const g = Geometry.compute(layer({ videoScale: 2, videoOffsetX: 30, videoOffsetY: -10 }), [640, 480], [640, 480]);
  assert.deepEqual([g.video.width, g.video.height], [1280, 960]);
  assert.equal(g.video.left, (640 - 1280) / 2 + 30); assert.equal(g.video.top, (480 - 960) / 2 - 10);
});

test('posição, escala e corner pin aplicam-se à caixa da máscara', () => {
  const g = Geometry.compute(layer({ x: 400, y: 300, scale: 2, pins: [{ x: 5, y: 7 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }), MASK, [640, 480]);
  assert.deepEqual(g.base[0], [400 - 800, 300 - 600]);        // canto sup. esq. = centro - metade*escala
  assert.deepEqual(g.pinned[0], [400 - 800 + 5, 300 - 600 + 7]);
  assert.deepEqual(g.base[2], [400 + 800, 300 + 600]);
});

test('toMask é a inversa de toScreen, também com corner pin e maskScale', () => {
  const c = layer({ x: 700, y: 400, scale: 1.7, maskScale: 0.8, pins: [{ x: 30, y: -20 }, { x: -50, y: 10 }, { x: 80, y: 60 }, { x: -10, y: -40 }] });
  const g = raw.compute(c, MASK, [640, 480]);
  for (const p of [[0, 0], [800, 600], [123.4, 456.7], [-50, 900]]) {
    const back = raw.toMask(g, c, raw.toScreen(g, c, p));
    assert.ok(Math.abs(back[0] - p[0]) < 1e-6 && Math.abs(back[1] - p[1]) < 1e-6, `${p} -> ${back}`);
  }
  // sem transformações: espaço da máscara = caixa centrada em (x, y)
  const g0 = raw.compute(layer(), MASK, [640, 480]);
  const s = raw.toScreen(g0, layer(), [0, 0]);
  assert.ok(Math.abs(s[0] - 560) < 1e-9 && Math.abs(s[1] - 240) < 1e-9);
});
