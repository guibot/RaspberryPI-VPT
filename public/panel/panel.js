'use strict';
/*
 * Painel de controlo. JavaScript simples, sem frameworks.
 * - Fala com o servidor por WebSocket (operações do modelo, ver docs/MODELO.md) e por HTTP (login, media, PIN).
 * - A pré-visualização usa /shared/geometry.js, o mesmo código do player, para coincidir com o ecrã.
 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  };

  // ---------- estado ----------
  let cfg = null;                 // configuração atual (cópia local; o servidor é a fonte de verdade)
  let media = [];                 // biblioteca: [{name, kind, width, height, mtime}]
  let sel = null;                 // id da layer selecionada
  let ws = null, retry = 500;
  let boot = null;                // arranque do servidor; se mudar, recarrega (código novo)
  let awaitNew = false;           // depois de adicionar/duplicar, seleciona a layer nova
  const lastEdit = new Map();     // id -> hora da última edição local (evita "saltos" com ecos do servidor)
  const pending = new Map();      // id -> alterações ainda por enviar
  let flushTimer = null;
  let jobs = [];                  // conversões no servidor
  const uploads = [];             // envios deste browser: {name, pct, error, done}

  const layerById = id => cfg && cfg.layers.find(l => l.id === id);
  const mediaByName = n => media.find(m => m.name === n);
  const thumbUrl = m => `/api/thumb/${encodeURIComponent(m.name)}?v=${m.mtime}`;
  const maskUrl = n => `/media/${encodeURIComponent(n)}`;
  // Miniatura de máscara a preto e branco: a zona opaca (visível) a branco sobre preto, seja qual for a cor do PNG.
  const maskPreview = n => maskPreviewCss(`url("${maskUrl(n)}")`);
  const maskPreviewCss = u => h('i', { style: `-webkit-mask-image:${u};mask-image:${u}` });
  const layerMaskCss = l => l.vmask ? VMask.cssUrl(l.vmask) : l.mask ? `url("${maskUrl(l.mask)}")` : 'none';   // a desenhada substitui o PNG
  // vidDims: tamanho do vídeo; boxDims: tamanho da caixa (a máscara manda; sem máscara, o vídeo).
  const vidDims = l => { const m = mediaByName(l.video); return m && m.width ? [m.width, m.height] : [640, 480]; };
  const boxDims = l => {
    if (l.vmask) return [l.vmask.width, l.vmask.height];
    const m = l.mask && mediaByName(l.mask); return m && m.width ? [m.width, m.height] : vidDims(l);
  };
  const mediaSig = () => media.map(m => `${m.name}:${m.mtime}`).join('|');

  // ---------- rede ----------
  async function api(path, body, method) {
    const opt = body === undefined ? (method ? { method } : {}) : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    let json = null; try { json = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json };
  }

  function setStatus(kind, text) {
    const s = $('#status'); s.className = 'status ' + kind; $('span', s).textContent = text;
  }

  function connect() {
    setStatus('', 'connecting');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; setStatus('on', 'connected'); if (debugOn) ws.send(JSON.stringify({ type: 'subscribe', stats: true })); if (editor.active) editor.announce(); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') { if (boot && m.boot !== boot) { flush(); location.reload(); return; } boot = m.boot; }
      else if (m.type === 'config') onConfig(m.config);
      else if (m.type === 'jobs') { jobs = m.jobs; renderQueue(); }
      else if (m.type === 'media') refreshMedia();
      else if (m.type === 'stats') renderDebug(m);
      else if (m.type === 'error') toast(m.message);
    };
    ws.onclose = async () => {
      setStatus('off', 'disconnected');
      const s = await api('/api/session').catch(() => null);
      if (s && s.ok && s.json.hasPin && !s.json.authed) return showLogin();      // sessão terminada ou PIN alterado
      setTimeout(connect, retry); retry = Math.min(retry * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  function sendOp(op) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'op', op }));
    else toast('No connection to the server');
  }

  // Alteração a uma layer: aplica-se já localmente e envia-se no máximo a cada 40 ms (o último valor vence).
  function patchLayer(id, patch) {
    const l = layerById(id); if (!l) return;
    Object.assign(l, patch);
    lastEdit.set(id, Date.now());
    pending.set(id, { ...(pending.get(id) || {}), ...patch });
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 40);
    scheduleRender();
  }
  function flush() {
    for (const [id, patch] of pending) sendOp({ op: 'updateLayer', id, patch });
    pending.clear();
  }

  function onConfig(next) {
    const old = cfg;
    if (old) {   // layers editadas há pouco mantêm o valor local (o eco do servidor pode vir atrasado)
      next.layers = next.layers.map(l => {
        const ol = old.layers.find(x => x.id === l.id);
        return ol && Date.now() - (lastEdit.get(l.id) || 0) < 400 ? ol : l;
      });
    }
    cfg = next;
    if (awaitNew && old) {
      const fresh = cfg.layers.find(l => !old.layers.some(o => o.id === l.id));
      if (fresh) { sel = fresh.id; awaitNew = false; }
    }
    if (!sel || !layerById(sel)) sel = cfg.layers.length ? cfg.layers[cfg.layers.length - 1].id : null;
    renderAll();
    syncSettings();
    editor.sync();
  }

  async function refreshMedia() {
    const r = await api('/api/media').catch(() => null);
    if (!r || !r.ok) return;
    const before = mediaSig();
    media = r.json;
    if (before !== mediaSig() && cfg) renderAll();
    renderLibrary();
  }

  // ---------- lista de layers ----------
  let listSig = '';
  let reorder = null;             // arrastar uma layer na lista para mudar a ordem
  function renderList() {
    if (reorder) { reorder.stale = true; return; }          // não reconstruir a lista a meio de um arrasto
    const ul = $('#layer-list');
    const sig = JSON.stringify([cfg.layers.map(l => [l.id, l.name, l.visible, l.video, l.mask, l.vmask]), sel, mediaSig()]);
    if (sig === listSig) return;
    listSig = sig;
    ul.textContent = '';
    if (!cfg.layers.length) ul.append(h('li', { class: 'empty', text: 'No layers yet.' }));
    // O topo da lista é a layer de cima (último do array).
    [...cfg.layers].map((l, i) => [l, i]).reverse().forEach(([l, i]) => {
      const m = mediaByName(l.video);
      const li = h('li', { class: 'li' + (l.id === sel ? ' sel' : '') + (l.visible ? '' : ' hidden-layer') },
        h('div', { class: 'li-main', onclick: () => select(l.id) },
          h('div', { class: 'li-grip', title: 'Drag to reorder', 'aria-label': 'Drag to reorder', text: '⋮⋮', onpointerdown: e => startReorder(e, l.id) }),
          h('div', { class: 'li-thumb', style: m ? `background-image:url("${thumbUrl(m)}")` : '' }),
          l.vmask || l.mask ? h('div', { class: 'li-mask', title: l.vmask ? 'drawn mask' : l.mask }, maskPreviewCss(layerMaskCss(l))) : null,
          h('div', { class: 'li-name', text: l.name }),
          h('button', { class: 'li-eye', title: l.visible ? 'Hide' : 'Show', 'aria-label': l.visible ? 'Hide' : 'Show',
            text: l.visible ? '●' : '○', onclick: e => { e.stopPropagation(); patchLayer(l.id, { visible: !l.visible }); } })));
      if (l.id === sel) li.append(h('div', { class: 'li-actions' },
        h('button', { text: '▲', title: 'Move up', 'aria-label': 'Move up', disabled: i === cfg.layers.length - 1, onclick: () => sendOp({ op: 'moveLayer', id: l.id, index: i + 1 }) }),
        h('button', { text: '▼', title: 'Move down', 'aria-label': 'Move down', disabled: i === 0, onclick: () => sendOp({ op: 'moveLayer', id: l.id, index: i - 1 }) }),
        h('button', { text: '⧉', title: 'Duplicate', 'aria-label': 'Duplicate', onclick: () => { awaitNew = true; sendOp({ op: 'duplicateLayer', id: l.id }); } }),
        h('button', { class: 'danger', text: '✕', title: 'Delete', 'aria-label': 'Delete', onclick: () => { if (confirm(`Delete layer “${l.name}”?`)) sendOp({ op: 'removeLayer', id: l.id }); } })));
      ul.append(li);
    });
  }

  // Arrastar pela pega: a layer segue o dedo/rato e uma linha mostra onde vai ficar. Ao largar, envia moveLayer.
  // O topo da lista é a layer de cima, por isso a posição p na lista (0 = topo) corresponde ao índice n-1-p do array.
  function startReorder(e, id) {
    if (e.button > 0 || reorder) return;
    const ul = $('#layer-list'), items = [...ul.children].filter(x => x.classList.contains('li'));
    const li = e.currentTarget.closest('.li'), from = items.indexOf(li);
    if (from < 0 || items.length < 2) return;
    e.preventDefault(); e.stopPropagation();
    const grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
    const rects = items.map(x => x.getBoundingClientRect());
    const mid = rects.map(r => (r.top + r.bottom) / 2);
    const line = h('div', { class: 'drop-line' }); ul.append(line);
    reorder = { id, stale: false };
    li.classList.add('dragging'); ul.classList.add('reordering');
    let to = from;
    const place = () => {                                    // linha entre o item to-1 e to (a ficar na posição "to" final)
      const ref = items.filter((_, k) => k !== from);
      const top = to === 0 ? rects[0].top : ref[to - 1].getBoundingClientRect().bottom;
      line.style.top = (top - ul.getBoundingClientRect().top + ul.scrollTop) + 'px';
    };
    place();
    const move = ev => {
      li.style.transform = `translateY(${ev.clientY - e.clientY}px)`;
      const others = items.map((_, k) => k).filter(k => k !== from);
      to = others.filter(k => mid[k] < ev.clientY).length;      // nº de itens (sem o arrastado) acima do ponteiro
      place();
    };
    const end = ev => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      const cancel = ev.type === 'pointercancel';
      line.remove(); li.classList.remove('dragging'); ul.classList.remove('reordering'); li.style.transform = '';
      const stale = reorder.stale; reorder = null;
      if (!cancel && to !== from) {
        const n = cfg.layers.length, idx = n - 1 - to, cur = cfg.layers.findIndex(x => x.id === id);
        if (cur >= 0) { const [m] = cfg.layers.splice(cur, 1); cfg.layers.splice(idx, 0, m); }   // já se vê; o servidor confirma
        sendOp({ op: 'moveLayer', id, index: idx });
        listSig = ''; renderAll();
      } else if (stale) { listSig = ''; renderList(); }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  }

  function select(id) { if (id !== sel) editor.stop(); sel = id; renderAll(); }

  // ---------- propriedades ----------
  const LIM = { scale: [0.01, 20], maskScale: [0.01, 20], videoScale: [0.01, 20], videoOffset: [-5000, 5000], xy: [-10000, 10000], pin: [-3000, 3000] };
  let propsKey = '';
  let rows = [];                  // controlos numéricos, para sincronizar valores
  const selects = [];             // [{el, key}]

  const fmt = v => String(Math.round(v * 100) / 100);

  // Campo numérico: arrasta na horizontal para mudar o valor; um toque abre-o para escrever.
  // Setas ↑↓ ajustam um passo (Shift: dez passos). A barra de fundo mostra a posição no intervalo.
  function numRow(label, range, limit, step, get, set) {
    const fill = h('i', { class: 'fill' });
    const inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': label });
    const el = h('div', { class: 'nf' }, fill, h('span', { class: 'lb', text: label }), inp);
    const snap = v => +Math.min(limit[1], Math.max(limit[0], v)).toFixed(step < 1 ? 2 : 0);
    let d = null;
    el.addEventListener('pointerdown', e => {
      if (el.classList.contains('edit')) return;
      d = { x: e.clientX, v: get(), moved: false, w: el.clientWidth };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!d) return;
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 4) return;
      d.moved = true; el.classList.add('drag');
      set(snap(d.v + dx / Math.max(d.w, 320) * (range[1] - range[0]) * (e.shiftKey ? 0.1 : 1)));   // intervalo todo ≈ 320 px
    });
    el.addEventListener('pointerup', () => {
      if (!d) return;
      const moved = d.moved; d = null; el.classList.remove('drag');
      if (!moved) { el.classList.add('edit'); inp.focus(); inp.select(); }
    });
    el.addEventListener('pointercancel', () => { d = null; el.classList.remove('drag'); });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value.replace(',', '.'));
      if (Number.isFinite(v)) { inp.classList.remove('bad'); set(snap(v)); } else inp.classList.add('bad');
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Escape') inp.blur();
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); set(snap(get() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
      }
    });
    inp.addEventListener('blur', () => { el.classList.remove('edit'); inp.classList.remove('bad'); sync(); });
    const sync = () => {
      const v = get();
      if (document.activeElement !== inp) inp.value = fmt(v);
      fill.style.width = Math.max(0, Math.min(1, (v - range[0]) / (range[1] - range[0]))) * 100 + '%';
    };
    rows.push(sync);
    return el;
  }

  // Controlo segmentado (2 ou mais opções).
  function seg(options, get, set) {
    const btns = options.map(([val, text]) => h('button', { type: 'button', text, onclick: () => set(val) }));
    const el = h('div', { class: 'seg' }, btns);
    selects.push(() => btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === get())));
    return el;
  }

  function mediaSelect(label, key, kind) {
    const sl = h('select', { 'aria-label': label });
    const fill = () => {
      const l = layerById(sel); const cur = l ? l[key] : null;
      sl.textContent = '';
      sl.append(h('option', { value: '', text: '— none —' }));
      const items = media.filter(m => m.kind === kind);
      if (cur && !items.some(m => m.name === cur)) sl.append(h('option', { value: cur, text: `(missing) ${cur}` }));
      for (const m of items) sl.append(h('option', { value: m.name, text: m.width ? `${m.name}  (${m.width}×${m.height})` : m.name }));
      sl.value = cur || '';
    };
    fill();
    sl.addEventListener('change', () => patchLayer(sel, { [key]: sl.value || null }));
    sl.addEventListener('focus', refreshMedia);
    selects.push(() => { if (document.activeElement !== sl) fill(); });
    return h('label', { class: 'field' }, label, sl);
  }

  function buildProps() {
    const box = $('#props'); box.textContent = ''; rows = []; selects.length = 0;
    const l = layerById(sel);
    if (!l) { box.append(h('p', { class: 'empty', text: 'Select or add a layer.' })); return; }
    const L = () => layerById(sel);
    const patch = p => patchLayer(sel, p);
    const W = cfg.output.width, H = cfg.output.height;
    const group = (title, ...kids) => h('div', { class: 'group' }, h('div', { class: 'gt', text: title }), ...kids);
    const g2 = (...kids) => h('div', { class: 'g2' }, ...kids);

    const name = h('input', { type: 'text', maxlength: 80, 'aria-label': 'Name' });
    name.addEventListener('input', () => patch({ name: name.value || 'Layer' }));
    selects.push(() => { if (document.activeElement !== name) name.value = L().name; });

    const modeSeg = seg([['alpha', 'ALPHA'], ['luminance', 'LUMINANCE']], () => L().maskMode, v => patch({ maskMode: v }));
    const PIN_NAMES = ['TOP LEFT', 'TOP RIGHT', 'BOTTOM RIGHT', 'BOTTOM LEFT'];

    box.append(
      group('Layer',
        h('label', { class: 'field' }, 'NAME', name),
        mediaSelect('VIDEO', 'video', 'video'),
        mediaSelect('MASK', 'mask', 'mask')),
      group('Position',
        g2(numRow('X', [0, W], LIM.xy, 1, () => L().x, v => patch({ x: v })),
           numRow('Y', [0, H], LIM.xy, 1, () => L().y, v => patch({ y: v }))),
        numRow('Scale', [0.1, 5], LIM.scale, 0.01, () => L().scale, v => patch({ scale: v }))),
      group('Mask',
        modeSeg,
        h('div', { class: 'row-btns tight' },
          h('button', { type: 'button', class: 'primary', text: l.vmask ? 'Edit drawing' : 'Draw mask', onclick: () => editor.start() }),
          l.vmask ? h('button', { type: 'button', class: 'danger', text: 'Delete drawing', onclick: () => {
            if (confirm('Delete the drawn mask of this layer?' + (l.mask ? ' It goes back to using the PNG.' : ''))) { editor.stop(); patch({ vmask: null }); scheduleProps(); }
          } }) : null),
        l.vmask && l.mask ? h('p', { class: 'hint', text: 'The drawn mask replaces the PNG chosen above.' }) : null,
        numRow('Scale', [0.1, 5], LIM.maskScale, 0.01, () => L().maskScale, v => patch({ maskScale: v }))),
      group('Video',
        g2(numRow('Offset X', [-500, 500], LIM.videoOffset, 1, () => L().videoOffsetX, v => patch({ videoOffsetX: v })),
           numRow('Offset Y', [-500, 500], LIM.videoOffset, 1, () => L().videoOffsetY, v => patch({ videoOffsetY: v }))),
        numRow('Scale', [0.1, 5], LIM.videoScale, 0.01, () => L().videoScale, v => patch({ videoScale: v }))),
      group('Corner pin (px)',
        h('div', { class: 'pins' }, PIN_NAMES.map((t, i) =>
          h('div', { class: 'pin-block' }, h('b', { text: t }),
            ['x', 'y'].map(ax => numRow(ax.toUpperCase(), [-300, 300], LIM.pin, 1, () => L().pins[i][ax], v => {
              const pins = L().pins.map(p => ({ ...p })); pins[i][ax] = v; patch({ pins });
            }))))),
        h('button', { text: 'Reset corners', onclick: () => patch({ pins: [0, 1, 2, 3].map(() => ({ x: 0, y: 0 })) }) })));
    syncProps(true);
  }

  const scheduleProps = () => { propsKey = ''; scheduleRender(); };
  function syncProps(force) {
    if (!cfg) return;
    const l = layerById(sel);
    const key = [sel, cfg.output.width, mediaSig(), !!(l && l.vmask), !!(l && l.mask)].join('|');
    if (key !== propsKey && !force) { propsKey = key; buildProps(); return; }
    propsKey = key;
    if (!layerById(sel)) return;
    rows.forEach(f => f()); selects.forEach(f => f());
  }

  // ---------- pré-visualização ----------
  const preview = $('#preview'), pstage = $('#pstage'), wrap = $('#preview-wrap');
  const NS = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(NS, 'svg'); overlay.id = 'overlay';
  const poly = document.createElementNS(NS, 'polygon'); overlay.append(poly);
  pstage.append(overlay);
  const handles = [0, 1, 2, 3].map(i => { const e = h('div', { class: 'handle', 'data-i': i }); pstage.append(e); return e; });
  const pl = new Map();           // id -> elemento .layer da pré-visualização
  const editor = MaskEditor({
    layer: () => layerById(sel), output: () => cfg.output, boxDims, geo: l => geo(l),
    patch: p => patchLayer(sel, p), scale: () => scale, svg: overlay, toolbar: $('#mask-tools'),
    send: msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    render: () => scheduleRender(), toast: t => toast(t),
  });
  let scale = 1, raf = 0;

  function fitPreview() {
    const { width: W, height: H } = cfg.output;
    // Computador e telemóvel deitado: a pré-visualização ocupa a área que tem. Telemóvel de pé: uma fração do ecrã
    // (menos a desenhar máscaras, porque a barra de ferramentas também precisa de espaço).
    const fill = matchMedia('(min-width: 900px) and (min-height: 521px), (max-height: 520px) and (orientation: landscape)').matches;
    const maxH = fill ? wrap.clientHeight : innerHeight * (editor.active ? 0.32 : 0.38);
    scale = Math.max(0.05, Math.min(wrap.clientWidth / W, maxH / H));
    preview.style.width = W * scale + 'px'; preview.style.height = H * scale + 'px';
    pstage.style.width = W + 'px'; pstage.style.height = H + 'px';
    pstage.style.transform = `scale(${scale})`;
    overlay.setAttribute('width', W); overlay.setAttribute('height', H);
  }

  const geo = l => Geometry.compute(l, boxDims(l), vidDims(l));

  function renderPreview() {
    if (!cfg) return;
    fitPreview();
    const ids = new Set(cfg.layers.map(l => l.id));
    for (const [id, e] of pl) if (!ids.has(id)) { e.remove(); pl.delete(id); }
    cfg.layers.forEach((l, i) => {
      let e = pl.get(l.id);
      if (!e) { e = h('div', { class: 'layer' }); pl.set(l.id, e); pstage.insertBefore(e, overlay); }
      e.style.zIndex = i;
      e.style.display = l.visible ? '' : 'none';
      const m = mediaByName(l.video);
      const src = m ? thumbUrl(m) : '';
      if (e.dataset.src !== src) {            // miniatura (frame extraído pelo ffmpeg), não vídeo ao vivo
        e.dataset.src = src; e.textContent = '';
        e.append(src ? h('img', { src, draggable: 'false', alt: '' }) : h('div', { class: 'ph' }));
      }
      const mk = layerMaskCss(l);
      if (e.dataset.mask !== mk) { e.dataset.mask = mk; e.style.webkitMaskImage = e.style.maskImage = mk; }
      Geometry.apply(e, [e.firstChild], l, boxDims(l), vidDims(l));
    });
    // contorno e pegas da layer selecionada
    const l = layerById(sel);
    overlay.style.zIndex = 1000;
    handles.forEach(e => { e.style.zIndex = 1001; e.style.display = l && !editor.active ? '' : 'none'; });   // a desenhar: sem pegas de canto
    poly.style.display = l ? '' : 'none';
    editor.render();
    if (!l) return;
    const g = geo(l);
    poly.setAttribute('points', g.pinned.map(p => p.join(',')).join(' '));
    poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', '#8fb3e6'); poly.setAttribute('stroke-width', 2 / scale);
    poly.setAttribute('stroke-dasharray', `${6 / scale} ${4 / scale}`);
    const hs = (matchMedia('(pointer: coarse)').matches ? 34 : 22) / scale;
    handles.forEach((e, i) => {
      e.style.width = e.style.height = hs + 'px';
      e.style.left = g.pinned[i][0] + 'px'; e.style.top = g.pinned[i][1] + 'px';
    });
  }

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderPreview(); syncProps(); });
  }

  const inQuad = ([x, y], q) => {            // ponto dentro do quadrilátero (ray casting)
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const point = e => { const r = preview.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; };

  let drag = null;
  preview.addEventListener('pointerdown', e => {
    if (!cfg) return;
    if (editor.active) { editor.down(point(e)); preview.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    const p = point(e), hEl = e.target.closest && e.target.closest('.handle');
    if (hEl) {                                              // arrastar um canto (corner pin)
      const l = layerById(sel); if (!l) return;
      const i = +hEl.dataset.i, g = geo(l);
      drag = { mode: 'pin', i, grab: [p[0] - g.pinned[i][0], p[1] - g.pinned[i][1]], el: hEl };
      hEl.classList.add('drag');
    } else {                                                // selecionar / mover a layer
      let l = layerById(sel);
      if (!(l && inQuad(p, geo(l).pinned))) {
        l = [...cfg.layers].reverse().find(x => x.visible && inQuad(p, geo(x).pinned));
        if (!l) return;
        select(l.id);
      }
      drag = { mode: 'move', id: l.id, start: p, x0: l.x, y0: l.y };
    }
    preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  preview.addEventListener('pointermove', e => {
    if (editor.active) { editor.hover(point(e)); return editor.move(point(e)); }
    if (!drag) return;
    const p = point(e), l = layerById(sel); if (!l) return;
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    if (drag.mode === 'pin') {
      const base = geo(l).base[drag.i];                      // posição do canto sem corner pin
      const pins = l.pins.map(q => ({ ...q }));
      pins[drag.i] = { x: Math.round(clamp(p[0] - drag.grab[0] - base[0], LIM.pin)), y: Math.round(clamp(p[1] - drag.grab[1] - base[1], LIM.pin)) };
      patchLayer(sel, { pins });
    } else {
      patchLayer(drag.id, { x: Math.round(clamp(drag.x0 + p[0] - drag.start[0], LIM.xy)), y: Math.round(clamp(drag.y0 + p[1] - drag.start[1], LIM.xy)) });
    }
  });
  const endDrag = () => { if (editor.active) editor.up(); if (drag && drag.el) drag.el.classList.remove('drag'); drag = null; };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointerleave', () => { if (editor.active && !drag) editor.leave(); });
  preview.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => { if (cfg) scheduleRender(); }).observe(wrap);
  addEventListener('resize', () => { if (cfg) scheduleRender(); });

  function renderAll() { renderList(); syncProps(); renderPreview(); }

  // ---------- botões, separadores ----------
  $('#btn-add').addEventListener('click', () => {
    awaitNew = true;
    const v = media.find(m => m.kind === 'video');
    sendOp({ op: 'addLayer', layer: { name: `Layer ${cfg.layers.length + 1}`, video: v ? v.name : null } });
  });
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => {
    document.body.dataset.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    scheduleRender();
  });

  // ---------- definições ----------
  const dlg = $('#settings');
  function syncSettings() {
    if (!cfg) return;
    $('#set-res').value = `${cfg.output.width}x${cfg.output.height}`;
    $('#set-conv-size').value = `${cfg.convert.maxWidth}x${cfg.convert.maxHeight}`; $('#set-conv-fps').value = String(cfg.convert.fps);
    $('#set-conv-on').checked = cfg.convert.process !== false;
    $('#set-conv-size').disabled = $('#set-conv-fps').disabled = cfg.convert.process === false;
    $('#pin-state').textContent = cfg.hasPin ? 'The panel is protected by a PIN.' : 'No PIN: anyone on the local network can control the screen.';
    $('#btn-pin-remove').hidden = !cfg.hasPin; $('#btn-logout').hidden = !cfg.hasPin;
  }
  $('#btn-settings').addEventListener('click', () => { $('#set-msg').textContent = ''; $('#set-pin').value = ''; syncSettings(); dlg.showModal(); });
  $('#set-res').addEventListener('change', e => { const [w, hh] = e.target.value.split('x').map(Number); sendOp({ op: 'setOutput', width: w, height: hh }); });
  const sendConvert = () => { const [w, hh] = $('#set-conv-size').value.split('x').map(Number); sendOp({ op: 'setConvert', width: w, height: hh, fps: +$('#set-conv-fps').value, process: $('#set-conv-on').checked }); };
  $('#set-conv-on').addEventListener('change', sendConvert);
  $('#set-conv-size').addEventListener('change', sendConvert);
  $('#set-conv-fps').addEventListener('change', sendConvert);
  async function savePin(pin) {
    const r = await api('/api/pin', { pin });
    const msg = $('#set-msg');
    msg.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
    msg.textContent = r.ok ? (r.json.hasPin ? 'PIN saved.' : 'PIN removed.') : (r.json && r.json.error) || 'Could not save the PIN';
    if (r.ok) $('#set-pin').value = '';
  }
  $('#btn-pin-save').addEventListener('click', () => savePin($('#set-pin').value));
  $('#btn-pin-remove').addEventListener('click', () => savePin(''));
  $('#btn-logout').addEventListener('click', async () => { await api('/api/logout', {}); location.reload(); });

  // ---------- media: envio, fila e biblioteca ----------
  const mdlg = $('#media-dlg');
  const MB = n => n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n >= 10485760 ? Math.round(n / 1048576) : Math.round(n / 104857.6) / 10) + ' MB';

  function uploadFiles(files) {
    for (const f of files) {
      const up = { name: f.name, pct: 0, error: null, done: false };
      uploads.push(up); queueUploads.push([f, up]);
    }
    renderQueue(); runUploads();
  }
  const queueUploads = []; let uploading = false;
  async function runUploads() {          // um envio de cada vez (ligações móveis são lentas)
    if (uploading) return; uploading = true;
    while (queueUploads.length) {
      const [f, up] = queueUploads.shift();
      await new Promise(resolve => {
        const x = new XMLHttpRequest();
        x.open('PUT', '/api/upload');
        x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
        x.upload.onprogress = e => { if (e.lengthComputable) { up.pct = Math.round(100 * e.loaded / e.total); renderQueue(); } };
        x.onload = () => { if (x.status === 200) up.done = true; else { try { up.error = JSON.parse(x.responseText).error; } catch { up.error = 'erro ' + x.status; } } renderQueue(); resolve(); };
        x.onerror = () => { up.error = 'falha de rede'; renderQueue(); resolve(); };
        x.send(f);
      });
    }
    uploading = false;
  }

  function renderQueue() {
    const ul = $('#queue'); ul.textContent = '';
    const rows = [];
    uploads.forEach((u, i) => { if (!u.done || u.error) rows.push(h('li', { class: 'mrow qrow' },
      h('div', { class: 'info' }, h('div', { class: 'nm', text: u.name }),
        u.error ? h('div', { class: 'sub err', text: 'Error: ' + u.error }) : h('div', { class: 'sub', text: `Uploading ${u.pct} %` }),
        u.error ? null : h('progress', { max: 100, value: u.pct })),
      u.error ? h('button', { text: '✕', 'aria-label': 'Remove', onclick: () => { uploads.splice(i, 1); renderQueue(); } }) : null)); });
    for (const j of jobs) {
      const txt = { queued: 'Queued', converting: `Converting ${j.progress} %`, done: 'Done ✓', error: 'Error: ' + j.error }[j.status];
      rows.push(h('li', { class: 'mrow qrow' },
        h('div', { class: 'info' }, h('div', { class: 'nm', text: j.name }), h('div', { class: 'sub' + (j.status === 'error' ? ' err' : ''), text: txt }),
          j.status === 'converting' ? h('progress', { max: 100, value: j.progress }) : null),
        j.status === 'done' ? null : h('button', { text: j.status === 'error' ? '✕' : 'Cancel', 'aria-label': 'Remove', onclick: () => api('/api/jobs/' + j.id, undefined, 'DELETE') })));
    }
    if (!rows.length) rows.push(h('li', { class: 'hint', text: 'Nothing in progress.' }));
    rows.forEach(r => ul.append(r));
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'converting').length + uploads.filter(u => !u.done && !u.error).length;
    const b = $('#jobs-badge'); b.hidden = !active; b.textContent = active;
  }

  function renderLibrary() {
    const ul = $('#library'); ul.textContent = '';
    if (!media.length) ul.append(h('li', { class: 'hint', text: 'The library is empty.' }));
    for (const m of media) {
      const users = cfg ? cfg.layers.filter(l => l.video === m.name || l.mask === m.name).map(l => l.name) : [];
      const img = m.kind === 'video' ? thumbUrl(m) : maskUrl(m.name);
      ul.append(h('li', { class: 'mrow' },
        m.kind === 'mask' ? h('div', { class: 'thumb mk' }, maskPreview(m.name))
          : h('div', { class: 'thumb', style: `background-image:url("${img}")` }),
        h('div', { class: 'info' }, h('div', { class: 'nm', text: m.name }),
          h('div', { class: 'sub', text: `${m.kind === 'video' ? `video ${m.width}×${m.height}` : 'mask'} · ${MB(m.size)}${users.length ? ' · in use: ' + users.join(', ') : ''}` })),
        h('div', { class: 'btns' },
          h('button', { text: 'Rename', onclick: () => renameMedia(m) }),
          h('button', { class: 'danger', text: 'Delete', onclick: () => deleteMedia(m, users) }))));
    }
  }

  async function renameMedia(m) {
    const ext = m.name.slice(m.name.lastIndexOf('.'));
    const to = prompt('New name (without the extension):', m.name.slice(0, -ext.length));
    if (!to || !to.trim()) return;
    const r = await api(`/api/media/${encodeURIComponent(m.name)}/rename`, { name: to });
    if (!r.ok) toast((r.json && r.json.error) || 'Could not rename');
  }
  async function deleteMedia(m, users) {
    const aviso = users.length ? `“${m.name}” is used by these layers: ${users.join(', ')}.\nDelete anyway? (the layers will be left without a file)` : `Delete “${m.name}”?`;
    if (!confirm(aviso)) return;
    const r = await api(`/api/media/${encodeURIComponent(m.name)}?force=1`, undefined, 'DELETE');
    if (!r.ok) toast((r.json && r.json.error) || 'Could not delete');
  }

  $('#btn-media').addEventListener('click', () => { refreshMedia(); renderQueue(); renderLibrary(); mdlg.showModal(); });
  $('#media-close').addEventListener('click', () => mdlg.close());
  $('#file-input').addEventListener('change', e => { uploadFiles([...e.target.files]); e.target.value = ''; });
  // arrastar e largar ficheiros para qualquer ponto da página
  addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging'); } });
  addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); document.body.classList.remove('dragging');
    if (!mdlg.open) { renderLibrary(); mdlg.showModal(); }
    uploadFiles([...e.dataTransfer.files]);
  });

  // ---------- debug: FPS, frames perdidos, CPU, GPU, temperatura ----------
  let debugOn = false;
  try { debugOn = localStorage.getItem('debug') === '1'; } catch {}
  const dbg = $('#debug'), dbtn = $('#btn-debug');
  const lvl = (v, warn, bad) => (v == null ? 'off' : v >= bad ? 'bad' : v >= warn ? 'warn' : '');
  const span = (cls, text) => h('span', { class: cls, text });
  function renderDebug(m) {
    if (!debugOn) return;
    const p = m.player;
    dbg.textContent = '';
    const line1 = p ? [span('', 'FPS '), h('b', { text: p.fps.toFixed(0) }), span('', '  dropped '), span(p.recent > 0 ? 'warn' : '', `${p.recent}`), span('off', ` (10 s) / ${p.dropped}`)]
      : [span('off', 'player not responding')];
    dbg.append(
      ...line1,
      '\n',
      span('', 'CPU '), span(lvl(m.cpu, 70, 90), m.cpu == null ? '-' : m.cpu + '%'),
      span('', '  GPU '), span(lvl(m.gpu, 80, 95), m.gpu == null ? '-' : m.gpu + '%'),
      span('', '  '), span(lvl(m.temp, 70, 80), m.temp == null ? '- °C' : m.temp + ' °C'));
  }
  function setDebug(on) {
    debugOn = on;
    try { localStorage.setItem('debug', on ? '1' : '0'); } catch {}
    dbtn.classList.toggle('on', on); dbtn.setAttribute('aria-pressed', on);
    dbg.hidden = !on;
    if (on) { dbg.textContent = 'measuring…'; dbg.className = ''; }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', stats: on }));
  }
  dbtn.addEventListener('click', () => setDebug(!debugOn));
  setDebug(debugOn);

  // ---------- login ----------
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false; $('#login-msg').textContent = ''; $('#login-pin').value = ''; $('#login-pin').focus();
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('/api/login', { pin: $('#login-pin').value });
    const msg = $('#login-msg');
    if (r.ok) { msg.textContent = ''; $('#login').hidden = true; start(); }
    else if (r.status === 429) msg.textContent = `Too many attempts. Try again in ${r.json.retryAfter} s.`;
    else msg.textContent = 'Wrong PIN.';
    $('#login-pin').value = '';
  });

  // ---------- aviso ----------
  let toastTimer = null;
  function toast(text) {
    const t = $('#toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ---------- versão (vem do servidor, de server/package.json) ----------
  api('/api/info').then(r => { if (r.ok && r.json.version) $('#version').textContent = 'v' + r.json.version; }).catch(() => {});

  // ---------- arranque ----------
  let started = false;
  async function start() {
    $('#app').hidden = false;
    await refreshMedia();
    if (started) { if (ws) ws.close(); return; }
    started = true;
    connect();
  }
  addEventListener('focus', () => { if (started) refreshMedia(); });

  (async () => {
    const s = await api('/api/session').catch(() => null);
    if (s && s.ok && s.json.hasPin && !s.json.authed) showLogin(); else start();
  })();
})();
