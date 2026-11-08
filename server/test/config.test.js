'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../lib/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-test-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

test('cria config.json por defeito e escreve de forma atómica (sem temporários)', () => {
  const d = tmp(); const s = new ConfigStore(d, { watch: false });
  assert.ok(fs.existsSync(path.join(d, 'config.json')));
  s.apply({ op: 'addLayer', layer: { name: 'A' } }); s.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'))).layers[0].name, 'A');
  assert.deepEqual(fs.readdirSync(d).filter(f => f.endsWith('.tmp')), []);
  s.close();
});

test('várias alterações seguidas são juntas numa escrita (debounce) e o flush grava tudo', async () => {
  const d = tmp(); const s = new ConfigStore(d, { watch: false });
  let id; s.apply({ op: 'addLayer' }); id = s.get().layers[0].id; s.flush();
  const before = fs.statSync(path.join(d, 'config.json')).mtimeMs;
  for (let i = 1; i <= 50; i++) s.apply({ op: 'updateLayer', id, patch: { x: i } });
  assert.equal(fs.statSync(path.join(d, 'config.json')).mtimeMs, before);       // ainda não escreveu
  await wait(400);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'))).layers[0].x, 50);
  s.apply({ op: 'updateLayer', id, patch: { x: 7 } }); s.close();               // close() faz flush
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'config.json'))).layers[0].x, 7);
});

test('falha a meio da escrita: o temporário deixado é ignorado e apagado, a config mantém-se', () => {
  const d = tmp(); let s = new ConfigStore(d, { watch: false });
  s.apply({ op: 'addLayer', layer: { name: 'segura' } }); s.close();
  fs.writeFileSync(path.join(d, 'config.json.99999.tmp'), '{"layers": [ {"name": "meio escr');   // escrita interrompida
  s = new ConfigStore(d, { watch: false });
  assert.equal(s.get().layers[0].name, 'segura');
  assert.deepEqual(fs.readdirSync(d).filter(f => f.endsWith('.tmp')), []);
  s.close();
});

test('ficheiro principal corrompido: recupera da cópia .bak e guarda o corrompido', () => {
  const d = tmp(); let s = new ConfigStore(d, { watch: false });
  s.apply({ op: 'addLayer', layer: { name: 'v1' } }); s.flush();
  s.apply({ op: 'addLayer', layer: { name: 'v2' } }); s.close();                 // .bak = estado com só 'v1'
  fs.writeFileSync(path.join(d, 'config.json'), '{{ lixo');
  s = new ConfigStore(d, { watch: false });
  assert.equal(s.get().layers[0].name, 'v1');
  assert.ok(fs.readdirSync(d).some(f => f.startsWith('config.json.corrupt-')));
  s.close();
});

test('sem ficheiro bom nem cópia: arranca com defaults sem rebentar', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'config.json'), 'não é json');
  const s = new ConfigStore(d, { watch: false });
  assert.equal(s.get().layers.length, 0); s.close();
});

test('edição manual do ficheiro é recarregada e emitida', async () => {
  const d = tmp(); const s = new ConfigStore(d);
  const got = new Promise(r => s.once('change', r));
  const c = JSON.parse(fs.readFileSync(path.join(d, 'config.json')));
  c.layers = [{ id: 'x', name: 'manual' }];
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(c));
  const next = await Promise.race([got, wait(2000).then(() => null)]);
  assert.ok(next, 'devia ter emitido change');
  assert.equal(next.layers[0].name, 'manual');
  s.close();
});

test('PIN guardado no disco é um hash, nunca o PIN', () => {
  const d = tmp(); const s = new ConfigStore(d, { watch: false });
  s.apply({ op: 'setPin', pin: '8642' }); s.close();
  const raw = fs.readFileSync(path.join(d, 'config.json'), 'utf8');
  assert.ok(!raw.includes('8642')); assert.ok(raw.includes('scrypt$'));
  assert.equal(new ConfigStore(d, { watch: false }).verifyPin('8642'), true);
});
