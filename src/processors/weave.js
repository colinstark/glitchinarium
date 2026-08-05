import { createBuf, regionAverage } from "../buffer.js";
import { luma, parseHex } from "../color.js";
import { weaveAt, checkerAt, bayerAt } from "../patterns.js";
import { subdivideCells, densityProbe } from "../quadtree.js";

/**
 * Cross-stitch / weave texture.
 *
 * The tight × pattern that covers the still life, the red horse and the peaches
 * basket. Unlike `dither`, which quantises a block to a flat value, this fills
 * a repeating STITCH SHAPE progressively: the diagonals ink first, then their
 * neighbours, then the ground. Dark regions read as solid cloth, mid regions as
 * an open weave, and the transition is a texture rather than a grey.
 */
export default {
  id: "weave",
  name: "Weave",
  category: "halftone",
  feature: ["cellSize"],
  params: [
    { key: "style", type: "select", label: "Stitch", options: ["cross", "checker", "basket", "bayer"], default: "cross" },
    { key: "cellSize", type: "range", label: "Cell size", min: 1, max: 40, step: 0.25, default: 4, unit: "u" },
    { key: "tile", type: "range", label: "Tile", min: 2, max: 12, step: 1, default: 4, hint: "cells per stitch repeat" },
    {
      key: "subdivide",
      type: "range",
      label: "Subdivide",
      min: 0,
      max: 3,
      step: 1,
      default: 0,
      mod: true,
      hint: "bind a mask to vary the weave scale by region",
    },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0.2, mod: true },
    { key: "coverage", type: "range", label: "Coverage", min: -0.5, max: 0.5, step: 0.01, default: 0, mod: true },
    { key: "ink", type: "color", label: "Ink", default: "#1a1a1a" },
    { key: "paper", type: "color", label: "Paper", default: "#f4f1e8" },
    { key: "paperAlpha", type: "range", label: "Paper alpha", min: 0, max: 1, step: 0.01, default: 1, hint: "0 keeps the image showing through the gaps" },
    { key: "keepColor", type: "toggle", label: "Ink from image", default: false },
    { key: "invert", type: "toggle", label: "Invert", default: false },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const s = src.data;
    const cell = Math.max(1, ctx.u(p.cellSize));
    const tile = Math.round(p.tile);
    const contrastMod = ctx.mod("contrast", p.contrast);
    const coverMod = ctx.mod("coverage", p.coverage);
    const [ir, ig, ib] = parseHex(p.ink);
    const [pr, pg, pb] = parseHex(p.paper);
    const avg = new Float32Array(4);

    const threshold = (cx, cy) => {
      switch (p.style) {
        case "checker": return checkerAt(cx, cy) * 0.6 + 0.2;
        case "basket": {
          // Over-under basket weave: alternating blocks of horizontal and
          // vertical runs.
          const bx = Math.floor(cx / tile) % 2;
          const by = Math.floor(cy / tile) % 2;
          const along = bx === by ? cx % tile : cy % tile;
          return (along / tile) * 0.7 + 0.15;
        }
        case "bayer": return bayerAt(cx, cy, 8);
        default: return weaveAt(cx, cy, tile);
      }
    };

    const paint = (x0, y0, cw, ch) => {
      regionAverage(src, x0, y0, x0 + cw, y0 + ch, avg);
      const k = contrastMod.at(x0 + cw / 2, y0 + ch / 2) * 0.9;
      let dark = 1 - luma(avg[0], avg[1], avg[2]) / 255;
      dark = (dark - 0.5) * (1 + k) + 0.5 + coverMod.at(x0 + cw / 2, y0 + ch / 2);
      if (p.invert) dark = 1 - dark;
      dark = dark < 0 ? 0 : dark > 1 ? 1 : dark;

      const cx = Math.floor(x0 / cw);
      const cy = Math.floor(y0 / ch);
      const inked = threshold(cx, cy) < dark;

      const x1 = Math.min(src.w, Math.ceil(x0 + cw));
      const y1 = Math.min(src.h, Math.ceil(y0 + ch));
      const ax = Math.max(0, Math.floor(x0));
      const ay = Math.max(0, Math.floor(y0));

      for (let y = ay; y < y1; y++) {
        for (let x = ax; x < x1; x++) {
          const i = (y * src.w + x) * 4;
          if (inked) {
            if (p.keepColor) {
              d[i] = avg[0];
              d[i + 1] = avg[1];
              d[i + 2] = avg[2];
            } else {
              d[i] = ir;
              d[i + 1] = ig;
              d[i + 2] = ib;
            }
            d[i + 3] = 255;
          } else {
            // Gaps show paper, or the untouched image when paperAlpha is 0.
            d[i] = s[i] + (pr - s[i]) * p.paperAlpha;
            d[i + 1] = s[i + 1] + (pg - s[i + 1]) * p.paperAlpha;
            d[i + 2] = s[i + 2] + (pb - s[i + 2]) * p.paperAlpha;
            d[i + 3] = s[i + 3];
          }
        }
      }
    };

    const probe = densityProbe(ctx, "subdivide");
    if (probe && p.subdivide > 0) {
      subdivideCells(src.w, src.h, cell, cell, p.subdivide, probe, paint);
    } else {
      const cols = Math.ceil(src.w / cell);
      const rows = Math.ceil(src.h / cell);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) paint(c * cell, r * cell, cell, cell);
      }
    }
    return out;
  },
};
