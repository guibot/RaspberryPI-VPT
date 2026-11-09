'use strict';
/*
 * Máscara desenhada (vetorial), partilhada pelo player e pelo painel.
 * Uma layer com `vmask` usa-a em vez do PNG: as formas são convertidas num SVG que serve de mask-image.
 * Formato (ver docs/MODELO.md):
 *   { width, height, feather, invert, shapes: [ {type:'poly', op, points:[[x,y],...]} | {type:'ellipse', op, cx, cy, rx, ry} ] }
 * Coordenadas em píxeis da máscara (0,0 = canto superior esquerdo). op: 'add' soma, 'sub' recorta.
 * As formas aplicam-se pela ordem da lista, por isso um recorte só apaga o que está antes dele.
 */
const VMask = (() => {
  const r = v => Math.round(v * 10) / 10;

  // Pontos que contornam uma forma (a elipse é aproximada por um polígono), em coordenadas da máscara.
  function outline(s, n = 48) {
    if (s.type !== 'ellipse') return s.points;
    const pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; pts.push([s.cx + s.rx * Math.cos(a), s.cy + s.ry * Math.sin(a)]); }
    return pts;
  }

  function toSvg(vm) {
    const w = vm.width, h = vm.height;
    const on = vm.invert ? '#000' : '#fff', off = vm.invert ? '#fff' : '#000';
    let body = `<rect x="${-w}" y="${-h}" width="${3 * w}" height="${3 * h}" fill="${off}"/>`;   // maior que a caixa: o desfoque não escurece as bordas
    for (const s of vm.shapes) {
      const fill = s.op === 'sub' ? off : on;
      if (s.type === 'ellipse') body += `<ellipse cx="${r(s.cx)}" cy="${r(s.cy)}" rx="${r(s.rx)}" ry="${r(s.ry)}" fill="${fill}"/>`;
      else if (s.points.length >= 3) body += `<polygon points="${s.points.map(p => r(p[0]) + ',' + r(p[1])).join(' ')}" fill="${fill}"/>`;
    }
    const blur = vm.feather > 0;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>` +
      (blur ? `<filter id="f" filterUnits="userSpaceOnUse" x="${-w}" y="${-h}" width="${3 * w}" height="${3 * h}"><feGaussianBlur stdDeviation="${r(vm.feather / 2)}"/></filter>` : '') +
      `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><g${blur ? ' filter="url(#f)"' : ''}>${body}</g></mask>` +
      `</defs><rect width="${w}" height="${h}" fill="#fff" mask="url(#m)"/></svg>`;
  }

  const toDataUrl = vm => 'data:image/svg+xml,' + encodeURIComponent(toSvg(vm));
  const cssUrl = vm => `url("${toDataUrl(vm)}")`;

  return { outline, toSvg, toDataUrl, cssUrl };
})();
