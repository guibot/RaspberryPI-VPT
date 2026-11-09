'use strict';
/*
 * Editor de máscaras desenhadas (vetoriais).
 * As formas vivem na própria layer (layer.vmask, ver docs/MODELO.md e /shared/vmask.js), em píxeis da máscara.
 * Desenha-se na pré-visualização, no espaço do ecrã de saída: cada ponto passa para o espaço da máscara com a
 * inversa da transformação da layer (posição, escala, maskScale, corner pin). Assim o desenho coincide com o
 * ecrã mesmo numa layer já deformada. Cada alteração é um updateLayer normal, por isso o player mostra-a ao vivo.
 *
 * Ferramentas: polígono (toque a toque), mão livre (laço), elipse e editar (arrastar pontos e formas,
 * inserir pontos nos pontos médios). Desfazer/refazer guarda cópias da máscara inteira.
 */
window.MaskEditor = function (d) {
  // d: { layer(), output(), boxDims(l), geo(l), patch(p), scale(), svg, toolbar, send(msg), render(), toast(t) }
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  };
  const clone = v => JSON.parse(JSON.stringify(v));
  const MAX_SHAPES = 32, MAX_POINTS = 256;
  const coarse = () => matchMedia('(pointer: coarse)').matches;

  const layerG = svgEl('g', {}); d.svg.append(layerG);

  let active = false, tool = 'poly', op = 'add';
  let cur = -1;                    // polígono ainda por fechar (ferramenta polígono)
  let selShape = -1, selPoint = -1;
  let undo = [], redo = [];
  let drag = null;

  const L = () => d.layer();
  const VM = () => { const l = L(); return l && l.vmask; };
  const G = () => d.geo(L());
  const toMask = p => Geometry.toMask(G(), L(), p);
  const toScreen = (p, g = G()) => Geometry.toScreen(g, L(), p);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const R = () => (coarse() ? 22 : 11) / d.scale();          // raio de toque, em píxeis de saída

  // ---------- alterações (todas passam por aqui) ----------
  const snap = () => { undo.push(JSON.stringify(VM())); if (undo.length > 100) undo.shift(); redo = []; };
  const mutate = fn => { const v = clone(VM()); fn(v); d.patch({ vmask: v }); };
  const dropEmptySnap = () => { if (undo.length && undo[undo.length - 1] === JSON.stringify(VM())) undo.pop(); };

  function closeCurrent() {
    if (cur < 0) return;
    const i = cur; cur = -1;
    const s = VM() && VM().shapes[i];
    if (s && s.type === 'poly' && s.points.length < 3) { mutate(v => v.shapes.splice(i, 1)); selShape = -1; }
    else selShape = i;
    selPoint = -1;
    refresh();
  }

  // Simplificação de Ramer-Douglas-Peucker (para a mão livre).
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const dd = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
        if (dd > best) { best = dd; bi = i; }
      }
      if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ---------- pontos de controlo (para desenhar e para tocar) ----------
  function handles() {
    const v = VM(); if (!v) return [];
    const out = [], g = G();
    const list = tool === 'edit' ? v.shapes.map((s, i) => i) : (cur >= 0 ? [cur] : []);
    for (const i of list) {
      const s = v.shapes[i]; if (!s) continue;
      const sel = i === selShape || i === cur;
      if (s.type === 'ellipse') {
        out.push({ s: i, kind: 'c', pos: toScreen([s.cx, s.cy], g), sel });
        if (sel) {
          out.push({ s: i, kind: 'rx', pos: toScreen([s.cx + s.rx, s.cy], g), sel });
          out.push({ s: i, kind: 'ry', pos: toScreen([s.cx, s.cy + s.ry], g), sel });
        }
      } else {
        s.points.forEach((p, j) => out.push({ s: i, kind: 'pt', i: j, pos: toScreen(p, g), sel }));
        if (sel && tool === 'edit' && s.points.length < MAX_POINTS) s.points.forEach((p, j) => {
          const q = s.points[(j + 1) % s.points.length];
          out.push({ s: i, kind: 'mid', i: j, pos: toScreen([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], g), sel });
        });
      }
    }
    return out;
  }
  function hitHandle(p) {
    let best = null, bd = R();
    for (const hd of handles()) {         // o selecionado ganha empates; pontos ganham a pontos médios
      const dd = dist(p, hd.pos) - (hd.sel ? 0.5 : 0) + (hd.kind === 'mid' ? 0.3 : 0);
      if (dd < bd) { bd = dd; best = hd; }
    }
    return best;
  }
  function inShape(s, [x, y]) {
    if (s.type === 'ellipse') return s.rx > 0 && s.ry > 0 && ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1;
    const q = s.points; let inside = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const shapeAt = m => { const v = VM(); for (let i = v.shapes.length - 1; i >= 0; i--) if (inShape(v.shapes[i], m)) return i; return -1; };

  // ---------- ponteiro (coordenadas de saída, vindas da pré-visualização) ----------
  function down(p) {
    const v = VM(); if (!v) return;
    const m = toMask(p);
    if (tool === 'poly') {
      const s = cur >= 0 && v.shapes[cur];
      if (s && s.points.length >= 3 && dist(p, toScreen(s.points[0])) < R()) { closeCurrent(); return; }   // tocar no 1.º ponto fecha
      if (s) {
        if (s.points.length >= MAX_POINTS) { d.toast(`Maximum of ${MAX_POINTS} points per shape`); return; }
        snap(); mutate(v => v.shapes[cur].points.push(m));
      } else {
        if (v.shapes.length >= MAX_SHAPES) { d.toast(`Maximum of ${MAX_SHAPES} shapes`); return; }
        snap(); mutate(v => v.shapes.push({ type: 'poly', op, points: [m] }));
        cur = selShape = VM().shapes.length - 1;
      }
      drag = { kind: 'pt', s: cur, i: VM().shapes[cur].points.length - 1, grab: [0, 0] };   // o ponto acabado de pôr pode ser arrastado
    } else if (tool === 'free' || tool === 'ellipse' || tool === 'rect') {
      if (v.shapes.length >= MAX_SHAPES) { d.toast(`Maximum of ${MAX_SHAPES} shapes`); return; }
      snap();
      if (tool === 'free') mutate(v => v.shapes.push({ type: 'poly', op, points: [m] }));
      else if (tool === 'rect') mutate(v => v.shapes.push({ type: 'poly', op, points: [m, m, m, m] }));   // retângulo = polígono de 4 pontos (editável)
      else mutate(v => v.shapes.push({ type: 'ellipse', op, cx: m[0], cy: m[1], rx: 0, ry: 0 }));
      selShape = VM().shapes.length - 1; selPoint = -1;
      drag = { kind: tool, s: selShape, a: m, last: p };
    } else {                                                   // editar
      const hd = hitHandle(p);
      if (hd) {
        snap();
        selShape = hd.s; selPoint = hd.kind === 'pt' ? hd.i : -1;
        if (hd.kind === 'mid') {                               // arrastar um ponto médio insere um ponto novo
          mutate(v => v.shapes[hd.s].points.splice(hd.i + 1, 0, m));
          drag = { kind: 'pt', s: hd.s, i: hd.i + 1, grab: [0, 0] }; selPoint = hd.i + 1;
        } else if (hd.kind === 'pt') {
          const q = v.shapes[hd.s].points[hd.i];
          drag = { kind: 'pt', s: hd.s, i: hd.i, grab: [m[0] - q[0], m[1] - q[1]] };
        } else if (hd.kind === 'c') drag = { kind: 'move', s: hd.s, last: m };
        else drag = { kind: hd.kind, s: hd.s };
      } else {
        selShape = shapeAt(m); selPoint = -1;
        if (selShape >= 0) { snap(); drag = { kind: 'move', s: selShape, last: m }; }
      }
    }
    refresh();
  }

  function move(p) {
    if (!drag || !VM()) return;
    const m = toMask(p), k = drag;
    if (k.kind === 'pt') mutate(v => { v.shapes[k.s].points[k.i] = [m[0] - k.grab[0], m[1] - k.grab[1]]; });
    else if (k.kind === 'free') {
      if (dist(p, k.last) < 3 / d.scale()) return;
      k.last = p;
      mutate(v => {
        const s = v.shapes[k.s]; s.points.push(m);
        if (s.points.length > MAX_POINTS - 16) s.points = simplify(s.points, 2);
      });
    } else if (k.kind === 'rect') {
      mutate(v => { v.shapes[k.s].points = [[k.a[0], k.a[1]], [m[0], k.a[1]], [m[0], m[1]], [k.a[0], m[1]]]; });
    } else if (k.kind === 'ellipse') {
      mutate(v => Object.assign(v.shapes[k.s], { cx: (k.a[0] + m[0]) / 2, cy: (k.a[1] + m[1]) / 2, rx: Math.abs(m[0] - k.a[0]) / 2, ry: Math.abs(m[1] - k.a[1]) / 2 }));
    } else if (k.kind === 'rx' || k.kind === 'ry') {
      mutate(v => { const s = v.shapes[k.s]; if (k.kind === 'rx') s.rx = Math.abs(m[0] - s.cx); else s.ry = Math.abs(m[1] - s.cy); });
    } else if (k.kind === 'move') {
      const dx = m[0] - k.last[0], dy = m[1] - k.last[1]; k.last = m;
      mutate(v => {
        const s = v.shapes[k.s];
        if (s.type === 'ellipse') { s.cx += dx; s.cy += dy; } else s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
      });
    }
    d.render();
  }

  function up() {
    const k = drag; drag = null;
    if (!k || !VM()) return;
    if (k.kind === 'free') {
      const s = VM().shapes[k.s];
      if (!s || s.points.length < 3) { undo.pop(); mutate(v => v.shapes.splice(k.s, 1)); selShape = -1; }
      else mutate(v => { v.shapes[k.s].points = simplify(v.shapes[k.s].points, 1.2); });
    } else if (k.kind === 'ellipse' || k.kind === 'rect') {
      const s = VM().shapes[k.s];
      const small = !s || (s.type === 'ellipse' ? s.rx < 2 || s.ry < 2
        : Math.abs(s.points[2][0] - s.points[0][0]) < 2 || Math.abs(s.points[2][1] - s.points[0][1]) < 2);
      if (small) { undo.pop(); mutate(v => v.shapes.splice(k.s, 1)); selShape = -1; }
    } else dropEmptySnap();                                     // um toque sem arrastar não fica no histórico
    refresh();
  }

  // ---------- ações da barra ----------
  function doUndo() {
    if (!undo.length) return;
    redo.push(JSON.stringify(VM())); d.patch({ vmask: JSON.parse(undo.pop()) });
    cur = -1; selShape = selPoint = -1; refresh();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(JSON.stringify(VM())); d.patch({ vmask: JSON.parse(redo.pop()) });
    cur = -1; selShape = selPoint = -1; refresh();
  }
  function del() {
    const v = VM(); if (!v) return;
    const i = cur >= 0 ? cur : selShape; if (i < 0 || !v.shapes[i]) return;
    snap();
    const s = v.shapes[i];
    if (cur >= 0 && s.points.length > 1) mutate(v => v.shapes[i].points.pop());         // a desenhar: apaga o último ponto
    else if (selPoint >= 0 && s.type === 'poly' && s.points.length > 3) { mutate(v => v.shapes[i].points.splice(selPoint, 1)); selPoint = -1; }
    else { mutate(v => v.shapes.splice(i, 1)); cur = selShape = selPoint = -1; }
    refresh();
  }
  function setOp(o) {
    op = o;
    const i = cur >= 0 ? cur : selShape, v = VM();
    if (i >= 0 && v && v.shapes[i] && v.shapes[i].op !== o) { snap(); mutate(v => { v.shapes[i].op = o; }); }   // muda também a forma selecionada
    refresh();
  }
  function setTool(t) { closeCurrent(); tool = t; selPoint = -1; if (t !== 'edit') selShape = -1; refresh(); }

  // ---------- barra de ferramentas ----------
  const tb = d.toolbar;
  const segBtns = (opts, get, set) => {
    const btns = opts.map(([val, text, title]) => h('button', { type: 'button', text, title, onclick: () => set(val) }));
    return { el: h('div', { class: 'seg' }, btns), sync: () => btns.forEach((b, i) => b.classList.toggle('on', opts[i][0] === get())) };
  };
  const tools = segBtns([['poly', 'POLYGON', 'Tap to place points; tap the first one to close'], ['free', 'FREEHAND', 'Drag to draw'],
    ['ellipse', 'ELLIPSE', 'Drag from corner to corner'], ['rect', 'RECTANGLE', 'Drag from corner to corner']], () => tool, setTool);
  const bEdit = h('button', { type: 'button', class: 'me-edit', text: 'EDIT', title: 'Drag points and shapes; the hollow points insert new points', onclick: () => setTool('edit') });
  const ops = segBtns([['add', '+ ADD', 'The shape shows the video'], ['sub', '− SUBTRACT', 'The shape hides the video']], () => op, setOp);
  const bClose = h('button', { type: 'button', text: 'Close shape', onclick: closeCurrent });
  const bUndo = h('button', { type: 'button', text: '↶', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: doUndo });
  const bRedo = h('button', { type: 'button', text: '↷', title: 'Redo (Ctrl+Shift+Z)', 'aria-label': 'Redo', onclick: doRedo });
  const bDel = h('button', { type: 'button', class: 'danger', text: 'Delete', title: 'Delete the selected point or shape (Delete)', onclick: del });
  const bInv = h('button', { type: 'button', text: 'Invert', title: 'Swaps what is visible and hidden', onclick: () => { snap(); mutate(v => { v.invert = !v.invert; }); refresh(); } });
  const feather = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Soften edges' });
  const featherVal = h('span', { class: 'mono' });
  let featherSnap = false;
  feather.addEventListener('pointerdown', () => { featherSnap = false; });
  feather.addEventListener('input', () => { if (!featherSnap) { snap(); featherSnap = true; } mutate(v => { v.feather = +feather.value; }); refresh(); });
  feather.addEventListener('change', () => { featherSnap = false; });
  const bDone = h('button', { type: 'button', class: 'primary', text: 'Done', onclick: () => stop() });
  const hint = h('div', { class: 'hint' });
  tb.append(
    h('div', { class: 'me-row' }, tools.el, h('span', { class: 'spacer' }), bEdit),
    h('div', { class: 'me-row' }, ops.el, bInv,
      h('label', { class: 'me-feather', title: 'Soften edges (blur, in mask pixels)' }, 'Soften', feather, featherVal)),
    h('div', { class: 'me-row' }, bUndo, bRedo, bDel, bClose, h('span', { class: 'spacer' }), bDone),
    hint);

  const HINTS = {
    poly: 'Tap to place points. Tap the first point (or “Close shape”) to close.',
    free: 'Drag to draw the outline; when you let go, the shape closes.',
    ellipse: 'Drag from one corner to the other.',
    rect: 'Drag from one corner to the other. Then, in Edit, you can move each corner.',
    edit: 'Drag points, the center of ellipses or the inside of shapes. The hollow points insert new points.',
  };
  function syncToolbar() {
    const v = VM();
    tools.sync(); ops.sync(); bEdit.classList.toggle('on', tool === 'edit');
    bClose.hidden = cur < 0;
    bUndo.disabled = !undo.length; bRedo.disabled = !redo.length;
    bDel.disabled = !(v && (cur >= 0 || selShape >= 0));
    bDel.textContent = cur >= 0 ? 'Delete point' : selPoint >= 0 ? 'Delete point' : 'Delete shape';
    bInv.classList.toggle('on', !!(v && v.invert));
    if (v && document.activeElement !== feather) feather.value = v.feather;
    featherVal.textContent = v ? Math.round(v.feather) : 0;
    const n = v ? v.shapes.length : 0;
    hint.textContent = HINTS[tool] + (n ? '' : ' No shapes yet: the layer stays hidden.');
  }

  // ---------- desenho na pré-visualização ----------
  function render() {
    layerG.textContent = '';
    const v = VM(); if (!active || !v) return;
    const k = 1 / d.scale(), g = G();
    v.shapes.forEach((s, i) => {
      const pts = VMask.outline(s).map(p => toScreen(p, g));
      const open = i === cur, sel = i === selShape || open;
      const col = s.op === 'sub' ? '#e9b98f' : '#8fb3e6';
      layerG.append(svgEl(open ? 'polyline' : 'polygon', {
        points: pts.map(p => p.join(',')).join(' '), fill: open ? 'none' : (s.op === 'sub' ? 'rgba(233,185,143,.14)' : 'rgba(143,179,230,.14)'),
        stroke: col, 'stroke-width': (sel ? 2.5 : 1.5) * k, 'stroke-linejoin': 'round' }));
    });
    const rr = (coarse() ? 8 : 5) * k;
    for (const hd of handles()) {
      const first = hd.kind === 'pt' && hd.s === cur && hd.i === 0;
      const on = hd.kind === 'pt' && hd.s === selShape && hd.i === selPoint;
      layerG.append(svgEl('circle', { cx: hd.pos[0], cy: hd.pos[1], r: hd.kind === 'mid' ? rr * 0.7 : first ? rr * 1.4 : hd.sel ? rr : rr * 0.7,
        fill: hd.kind === 'mid' ? 'rgba(17,20,27,.6)' : on ? '#8fb3e6' : '#fff', stroke: '#8fb3e6', 'stroke-width': 1.5 * k }));
    }
  }

  let lastAnnounce = '';
  function announce(force) {
    const l = L();
    const msg = { type: 'maskEdit', id: active && l ? l.id : null, shape: cur >= 0 ? cur : selShape };
    const key = JSON.stringify(msg);
    if (key !== lastAnnounce || force) { lastAnnounce = key; d.send(msg); }
  }
  function refresh() { syncToolbar(); d.render(); announce(); }

  // Posição do rato/dedo na pré-visualização, mostrada como uma mira no ecrã de saída.
  let curPos = null, curTimer = null, curSent = '';
  function sendCursor() {
    curTimer = null;
    const msg = { type: 'maskCursor', x: curPos ? Math.round(curPos[0]) : null, y: curPos ? Math.round(curPos[1]) : null };
    const key = msg.x + ',' + msg.y;
    if (key !== curSent) { curSent = key; d.send(msg); }
  }
  function hover(p) { if (!active) return; curPos = p; if (!curTimer) curTimer = setTimeout(sendCursor, 33); }
  function leave() { curPos = null; clearTimeout(curTimer); sendCursor(); }

  // ---------- entrar / sair ----------
  function start() {
    const l = L(); if (!l) return;
    if (!l.vmask) {
      if (l.mask && !confirm('The drawn mask replaces the PNG on this layer (the PNG stays in the library). Continue?')) return;
      // A máscara desenhada fica com o tamanho da caixa atual (o PNG ou, sem máscara, o vídeo):
      // a layer não muda de tamanho nem de sítio, e só se desenha onde há vídeo.
      const [w, hh] = d.boxDims(l);
      d.patch({ vmask: { width: Math.round(w), height: Math.round(hh), feather: 0, invert: false, shapes: [] } });
    }
    active = true; tool = 'poly'; cur = selShape = selPoint = -1; undo = []; redo = []; drag = null;
    tb.hidden = false; document.body.classList.add('mask-editing');
    refresh();
  }
  function stop() {
    if (!active) return;
    closeCurrent();
    active = false; drag = null; selShape = selPoint = -1;
    tb.hidden = true; document.body.classList.remove('mask-editing');
    leave();
    refresh();
  }

  addEventListener('keydown', e => {
    if (!active || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
    else if (e.key === 'Enter') closeCurrent();
    else if (e.key === 'Escape') { if (cur >= 0) closeCurrent(); else stop(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del(); }
  });

  return {
    get active() { return active; },
    start, stop, down, move, up, render, hover, leave, announce: () => announce(true),
    sync: () => { if (active) { if (!VM()) stop(); else syncToolbar(); } },
  };
};
