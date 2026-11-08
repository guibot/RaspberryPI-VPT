'use strict';
/*
 * Geometria de uma layer, partilhada pelo player e pela pré-visualização do painel (para coincidirem).
 * A CAIXA da layer tem o tamanho nativo da máscara (ou o do vídeo, se não houver máscara): é a máscara que
 * define a posição e a proporção da layer. O vídeo encaixa na caixa em modo "cover" (enche-a sem deformar).
 * Ordem das transformações: ver docs/MODELO.md
 *   1. vídeo dentro da caixa (cover × videoScale, videoOffsetX/Y)   2. máscara no espaço da layer (maskScale)
 *   3. posição e escala da layer (x,y = centro)                      4. corner pin final (pins[i])
 */
const Geometry = (() => {
  // Homografia que leva o retângulo (0,0,w,h) para o quadrilátero dst (TL, TR, BR, BL).
  function homography(w, h, dst) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [];
    for (let k = 0; k < 4; k++) {
      const [x, y] = src[k], [X, Y] = dst[k];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = 0; r < 8; r++) if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
      }
    }
    const s = A.map((row, i) => row[8] / row[i]);
    return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]];
  }

  // c = layer da configuração; box = [largura, altura] da caixa (máscara ou, sem máscara, vídeo);
  // vid = [largura, altura] nativas do vídeo.
  function compute(c, box, vid) {
    const [vw, vh] = box;
    const cover = Math.max(vw / vid[0], vh / vid[1]) * c.videoScale;       // "cover": enche a caixa sem deformar
    const vidW = vid[0] * cover, vidH = vid[1] * cover;
    const half = [[-vw / 2, -vh / 2], [vw / 2, -vh / 2], [vw / 2, vh / 2], [-vw / 2, vh / 2]];
    const base = half.map(([px, py]) => [c.x + px * c.scale, c.y + py * c.scale]);       // sem corner pin
    const pinned = base.map(([x, y], i) => [x + c.pins[i].x, y + c.pins[i].y]);          // com corner pin
    const m = homography(vw, vh, pinned);
    return {
      box: { width: vw, height: vh },
      video: { width: vidW, height: vidH, left: (vw - vidW) / 2 + c.videoOffsetX, top: (vh - vidH) / 2 + c.videoOffsetY },
      maskSize: c.maskScale * 100 + '%',
      transform: `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,1)`,
      base, pinned,
    };
  }

  // Aplica a geometria a um elemento-caixa (.layer) e aos elementos de média (vídeos ou miniaturas) lá dentro.
  function apply(boxEl, mediaEls, c, box, vid) {
    const g = compute(c, box, vid);
    boxEl.style.width = g.box.width + 'px';
    boxEl.style.height = g.box.height + 'px';
    for (const el of mediaEls) {
      const s = el.style;
      s.width = g.video.width + 'px'; s.height = g.video.height + 'px';
      s.left = g.video.left + 'px'; s.top = g.video.top + 'px';
    }
    boxEl.style.webkitMaskSize = boxEl.style.maskSize = `${g.maskSize} ${g.maskSize}`;
    boxEl.style.maskMode = c.maskMode;
    boxEl.style.transform = g.transform;
    return g;
  }

  return { homography, compute, apply };
})();
