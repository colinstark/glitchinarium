import { cloneBuf } from "../buffer.js";
import { noise2 } from "../rng.js";

/**
 * Long horizontal streaking.
 *
 * The train reference dissolves its bottom third into pure horizontal colour
 * runs — a readout that lost sync and kept holding the last sample. Distinct
 * from `datamosh`, which displaces intact blocks: here a single column of
 * pixels is STRETCHED across a long span, so structure is destroyed rather
 * than moved.
 */
export default {
  id: "scanline-smear",
  name: "Scanline smear",
  category: "glitch",
  params: [
    { key: "mode", type: "select", label: "Mode", options: ["stretch", "echo", "shear"], default: "stretch" },
    { key: "bandHeight", type: "range", label: "Band height", min: 0.5, max: 60, step: 0.5, default: 3, unit: "u" },
    { key: "amount", type: "range", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.35, mod: true, hint: "fraction of bands that break" },
    { key: "length", type: "range", label: "Length", min: 5, max: 900, step: 5, default: 260, unit: "u", mod: true },
    { key: "jitter", type: "range", label: "Start jitter", min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: "fieldScale", type: "range", label: "Field scale", min: 0.5, max: 60, step: 0.5, default: 4, hint: "bands per noise feature — low groups them into thick zones" },
    { key: "taper", type: "range", label: "Taper", min: 0, max: 1, step: 0.01, default: 0.35, hint: "fade the streak back toward the image" },
    { key: "direction", type: "select", label: "Direction", options: ["right", "left", "both"], default: "right" },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const { w, h } = src;
    const d = out.data;
    const s = src.data;
    const band = Math.max(1, Math.round(ctx.u(p.bandHeight)));
    const amountMod = ctx.mod("amount", p.amount);
    const lengthMod = ctx.modPx("length", p.length);
    const fs = Math.max(0.25, p.fieldScale);
    const rows = Math.ceil(h / band);

    for (let bi = 0; bi < rows; bi++) {
      const y0 = bi * band;
      const y1 = Math.min(h, y0 + band);
      const my = (y0 + y1) / 2;

      const n = noise2(bi / fs, 3.11, ctx.noiseSeed);
      if (n > amountMod.at(w / 2, my)) continue;

      const len = Math.max(2, Math.round(lengthMod.at(w / 2, my)));
      const jit = noise2(bi / fs, 71.3, ctx.noiseSeed);
      const startX = Math.floor(jit * p.jitter * w);

      const dirs = p.direction === "both" ? [1, -1] : [p.direction === "left" ? -1 : 1];

      for (const dir of dirs) {
        for (let y = y0; y < y1; y++) {
          const rowBase = y * w;
          const srcI = (rowBase + Math.min(w - 1, Math.max(0, startX))) * 4;

          if (p.mode === "shear") {
            // Whole row slides; nothing is stretched.
            const shift = Math.round((jit - 0.5) * 2 * len) * dir;
            for (let x = 0; x < w; x++) {
              const sx = Math.min(w - 1, Math.max(0, x - shift));
              const o = (rowBase + x) * 4;
              const i = (rowBase + sx) * 4;
              d[o] = s[i];
              d[o + 1] = s[i + 1];
              d[o + 2] = s[i + 2];
              d[o + 3] = s[i + 3];
            }
            continue;
          }

          for (let k = 0; k < len; k++) {
            const x = startX + k * dir;
            if (x < 0 || x >= w) break;
            const o = (rowBase + x) * 4;

            // `stretch` holds one sample; `echo` re-reads a short loop, which
            // keeps a rhythmic ghost of the original detail.
            const i = p.mode === "echo"
              ? (rowBase + Math.min(w - 1, Math.max(0, startX + (k % Math.max(2, Math.round(len / 12))) * dir))) * 4
              : srcI;

            const t = p.taper > 0 ? 1 - p.taper * (k / len) : 1;
            d[o] = s[o] + (s[i] - s[o]) * t;
            d[o + 1] = s[o + 1] + (s[i + 1] - s[o + 1]) * t;
            d[o + 2] = s[o + 2] + (s[i + 2] - s[o + 2]) * t;
          }
        }
      }
    }
    return out;
  },
};
