/**
 * Adaptive cell subdivision.
 *
 * A uniform grid cannot have a per-pixel cell size — the cells would not tile.
 * So when a grid processor's density is bound to a mask, it starts from the
 * COARSEST grid and recursively splits each cell into four wherever the mask
 * asks for more detail. Every split doubles the local resolution, cells still
 * tile exactly, and the result is genuinely variable-resolution ASCII or
 * dithering: coarse where the mask is dark, fine where it is bright.
 *
 * This is what makes a painted gradient able to control *how coarse the effect
 * is* rather than merely how much of it shows through.
 */

/**
 * @param w,h          image size in px
 * @param cellW,cellH  size of a level-0 (coarsest) cell in px
 * @param maxDepth     how many times a cell may split (0 = uniform grid)
 * @param depthAt      (cx, cy) → 0..1, how much detail is wanted here
 * @param visit        (x, y, w, h, depth) → void, called once per final cell
 */
export function subdivideCells(w, h, cellW, cellH, maxDepth, depthAt, visit) {
  const cols = Math.ceil(w / cellW);
  const rows = Math.ceil(h / cellH);

  const rec = (x, y, cw, ch, depth) => {
    if (depth < maxDepth) {
      const cx = x + cw / 2;
      const cy = y + ch / 2;
      if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
        // Split when the requested depth exceeds the current one. The +0.5
        // biases toward the nearer level so a mask at 0.5 with maxDepth 2
        // settles on depth 1 rather than flickering between 0 and 2.
        if (depthAt(cx, cy) * maxDepth > depth + 0.5) {
          const hw = cw / 2;
          const hh = ch / 2;
          rec(x, y, hw, hh, depth + 1);
          rec(x + hw, y, hw, hh, depth + 1);
          rec(x, y + hh, hw, hh, depth + 1);
          rec(x + hw, y + hh, hw, hh, depth + 1);
          return;
        }
      }
    }
    visit(x, y, cw, ch, depth);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rec(c * cellW, r * cellH, cellW, cellH, 0);
    }
  }
}

/**
 * Build the depth probe a grid processor should pass to `subdivideCells`.
 * Returns null when the key is not bound to a mask, which is the caller's
 * signal to take the plain uniform-grid path.
 */
export function densityProbe(ctx, key) {
  if (!ctx.isModulated(key)) return null;
  const m = ctx.mods[key];
  const mask = ctx.masks.get(m.mask);
  const data = mask.data;
  const mw = mask.w;
  const invert = !!m.invert;
  return (x, y) => {
    const t = data[(y | 0) * mw + (x | 0)];
    return invert ? 1 - t : t;
  };
}
