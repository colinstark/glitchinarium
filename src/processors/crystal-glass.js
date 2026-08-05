import { cloneBuf, createMask } from "../buffer.js";
import { parseHex, luma } from "../color.js";
import { noise2 } from "../rng.js";

/**
 * Crystal glass pixel — the Halt and Catch Fire title look.
 *
 * Irregular glass-brick tessellation (not a uniform pixel grid) filled with
 * oil-flat region colour, then horizontal signal crush and sparse spark
 * needles. Silhouette survives; the field becomes crushed graphic signal.
 *
 * Passes, in order:
 *   1. pack uneven bricks (size jitter + optional detail bias + row warp)
 *   2. fill each brick with averaged, posterised, tint-mixed colour
 *   3. horizontal hold-sample streaks gated by a noise field
 *   4. bright filament sparks (smoke-as-light-debris, not fluid sim)
 *   5. optional vertical seam (half-frame split)
 */

function posterizeChannel(v, steps) {
  if (steps <= 1) return v;
  const n = Math.max(2, Math.round(steps));
  return Math.round((v / 255) * (n - 1)) * (255 / (n - 1));
}

/** Cheap local variance proxy from four corner samples of a brick. */
function cornerVariance(s, w, h, x0, y0, x1, y1) {
  const sample = (x, y) => {
    const xi = Math.max(0, Math.min(w - 1, x | 0));
    const yi = Math.max(0, Math.min(h - 1, y | 0));
    const i = (yi * w + xi) * 4;
    return luma(s[i], s[i + 1], s[i + 2]);
  };
  const a = sample(x0, y0);
  const b = sample(x1 - 1, y0);
  const c = sample(x0, y1 - 1);
  const d = sample(x1 - 1, y1 - 1);
  const m = (a + b + c + d) * 0.25;
  return (
    ((a - m) ** 2 + (b - m) ** 2 + (c - m) ** 2 + (d - m) ** 2) * 0.25
  ) / (255 * 255);
}

function averageBrick(s, w, x0, y0, x1, y1, step = 1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const st = Math.max(1, step | 0);
  for (let y = y0; y < y1; y += st) {
    const row = y * w;
    for (let x = x0; x < x1; x += st) {
      const i = (row + x) * 4;
      r += s[i];
      g += s[i + 1];
      b += s[i + 2];
      n++;
    }
  }
  if (!n) return [0, 0, 0];
  return [r / n, g / n, b / n];
}

function fillRect(d, w, x0, y0, x1, y1, r, g, b) {
  const rr = Math.max(0, Math.min(255, r));
  const gg = Math.max(0, Math.min(255, g));
  const bb = Math.max(0, Math.min(255, b));
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const o = (row + x) * 4;
      d[o] = rr;
      d[o + 1] = gg;
      d[o + 2] = bb;
      d[o + 3] = 255;
    }
  }
}

export default {
  id: "crystal-glass",
  name: "Crystal glass",
  category: "glitch",
  feature: ["cellW", "cellH"],
  emitsMask: (p) => !!p.emitMask,
  params: [
    { key: "cellW", type: "range", label: "Brick width", min: 4, max: 120, step: 1, default: 28, unit: "u" },
    { key: "cellH", type: "range", label: "Brick height", min: 2, max: 80, step: 1, default: 10, unit: "u" },
    { key: "sizeJitter", type: "range", label: "Size jitter", min: 0, max: 1, step: 0.01, default: 0.55, hint: "how uneven the glass bricks get" },
    { key: "detailBias", type: "range", label: "Detail bias", min: 0, max: 1, step: 0.01, default: 0.35, hint: "shrink bricks where the image has detail" },
    { key: "warp", type: "range", label: "Row warp", min: 0, max: 1, step: 0.01, default: 0.25, hint: "wave the brick rows" },
    { key: "posterize", type: "range", label: "Posterize", min: 0, max: 32, step: 1, default: 12, hint: "0 keeps full averages; low values crush like JPEG" },
    { key: "tint", type: "color", label: "Tint", default: "#c01018" },
    { key: "tintMix", type: "range", label: "Tint mix", min: 0, max: 1, step: 0.01, default: 0.72, hint: "0 = photo mosaic, 1 = pure graphic field" },
    { key: "crush", type: "range", label: "Crush", min: 0, max: 1, step: 0.01, default: 0.45, mod: true, hint: "horizontal streak intensity" },
    { key: "streakLength", type: "range", label: "Streak length", min: 10, max: 800, step: 5, default: 220, unit: "u", mod: true },
    { key: "streakHeight", type: "range", label: "Streak height", min: 0.5, max: 40, step: 0.5, default: 2.5, unit: "u" },
    { key: "streakField", type: "range", label: "Crush field", min: 0.5, max: 40, step: 0.5, default: 5, hint: "bands per noise feature — low = big crush zones" },
    { key: "sparks", type: "range", label: "Sparks", min: 0, max: 1, step: 0.01, default: 0.35, mod: true },
    { key: "sparkLength", type: "range", label: "Spark length", min: 2, max: 200, step: 1, default: 48, unit: "u" },
    { key: "sparkColor", type: "color", label: "Spark colour", default: "#f0e8ff" },
    { key: "seam", type: "range", label: "Seam", min: 0, max: 1, step: 0.01, default: 0, hint: "vertical split (half-frame black)" },
    { key: "seamX", type: "range", label: "Seam position", min: 0.05, max: 0.95, step: 0.01, default: 0.42, showIf: (p) => p.seam > 0.01 },
    { key: "emitMask", type: "toggle", label: "Emit mask", default: false, hint: "publish where crush/sparks ran for layers above" },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const { w, h } = src;
    const d = out.data;
    const s = src.data;

    const baseW = Math.max(2, Math.round(ctx.u(p.cellW)));
    const baseH = Math.max(1, Math.round(ctx.u(p.cellH)));
    const jitter = p.sizeJitter;
    const detailBias = p.detailBias;
    const warpAmt = p.warp;
    const steps = p.posterize;
    const [tr, tg, tb] = parseHex(p.tint);
    const tintMix = p.tintMix;
    const [spr, spg, spb] = parseHex(p.sparkColor);

    const crushMod = ctx.mod("crush", p.crush);
    const streakLenMod = ctx.modPx("streakLength", p.streakLength);
    const sparkMod = ctx.mod("sparks", p.sparks);
    const bandH = Math.max(1, Math.round(ctx.u(p.streakHeight)));
    const sparkLenPx = Math.max(2, Math.round(ctx.u(p.sparkLength)));
    const fs = Math.max(0.25, p.streakField);
    const mask = p.emitMask ? createMask(w, h) : null;

    // Sample step in pixels from a fixed artwork-unit pitch so 1×/4× averages
    // see the same relative structure.
    const sampleStep = Math.max(1, Math.round(ctx.u(1.2)));

    // ------------------------------------------------------------------ 1+2
    // Pack irregular bricks and oil-fill them.
    // Noise is indexed in artwork units so row/cell decisions match at every
    // render resolution (rowIndex would change with pixel height).
    let y = 0;
    while (y < h) {
      const yU = ctx.toUnits(y + baseH * 0.5);
      const jh = noise2(yU / 22, 2.11, ctx.noiseSeed);
      let rowH = Math.max(1, Math.round(baseH * (1 + (jh - 0.5) * 2 * jitter)));

      if (detailBias > 0.01) {
        const midY = Math.min(h - 1, y + (rowH >> 1));
        let varSum = 0;
        const probes = 6;
        const probeGap = Math.max(1, Math.round(ctx.u(3)));
        for (let k = 0; k < probes; k++) {
          const px = Math.floor(((k + 0.5) / probes) * w);
          const i = (midY * w + px) * 4;
          const i2 = (midY * w + Math.min(w - 1, px + probeGap)) * 4;
          const L1 = luma(s[i], s[i + 1], s[i + 2]);
          const L2 = luma(s[i2], s[i2 + 1], s[i2 + 2]);
          varSum += Math.abs(L1 - L2) / 255;
        }
        const detail = varSum / probes;
        rowH = Math.max(1, Math.round(rowH * (1 - detailBias * 0.55 * detail)));
      }
      const y1 = Math.min(h, y + rowH);

      const rowWarp =
        warpAmt > 0.001
          ? Math.round((noise2(yU / 40, 9.7, ctx.noiseSeed) - 0.5) * 2 * warpAmt * baseW * 0.65)
          : 0;

      let x = 0;
      while (x < w) {
        const xU = ctx.toUnits(x + baseW * 0.5);
        const jw = noise2(xU / 28, yU / 24, ctx.noiseSeed + 17);
        let cellW = Math.max(2, Math.round(baseW * (1 + (jw - 0.5) * 2 * jitter)));

        if (detailBias > 0.01) {
          const x1probe = Math.min(w, x + cellW);
          const v = cornerVariance(s, w, h, x, y, x1probe, y1);
          cellW = Math.max(2, Math.round(cellW * (1 - detailBias * Math.min(1, v * 8))));
        }

        const x0 = x;
        const x1 = Math.min(w, x + cellW);

        const sx0 = Math.max(0, Math.min(w - 1, x0 + rowWarp));
        const sx1 = Math.max(sx0 + 1, Math.min(w, x1 + rowWarp));
        let [r, g, b] = averageBrick(s, w, sx0, y, sx1, y1, sampleStep);
        if (steps > 1) {
          r = posterizeChannel(r, steps);
          g = posterizeChannel(g, steps);
          b = posterizeChannel(b, steps);
        }
        if (tintMix > 0) {
          const L = luma(r, g, b) / 255;
          const tintR = tr * (0.35 + 0.65 * L);
          const tintG = tg * (0.35 + 0.65 * L);
          const tintB = tb * (0.35 + 0.65 * L);
          r = r + (tintR - r) * tintMix;
          g = g + (tintG - g) * tintMix;
          b = b + (tintB - b) * tintMix;
        }

        fillRect(d, w, x0, y, x1, y1, r, g, b);
        x = x1;
      }

      y = y1;
    }

    // ------------------------------------------------------------------ 3
    // Horizontal crush — hold-sample streaks on the mosaicked buffer.
    if (p.crush > 0.001) {
      const rows = Math.ceil(h / bandH);
      for (let bi = 0; bi < rows; bi++) {
        const y0 = bi * bandH;
        const y1b = Math.min(h, y0 + bandH);
        const my = (y0 + y1b) / 2;
        // Index noise by artwork-unit band position, not band index.
        const bandU = ctx.toUnits(my);
        const n = noise2(bandU / (fs * 8), 3.11, ctx.noiseSeed + 4);
        const crush = crushMod.at(w / 2, my);
        if (n * n > 1 - crush) continue;

        const len = Math.max(2, Math.round(streakLenMod.at(w / 2, my)));
        const jit = noise2(bandU / (fs * 8), 71.3, ctx.noiseSeed + 4);
        const startX = Math.floor(jit * w);
        const dir = noise2(bandU / (fs * 8), 12.9, ctx.noiseSeed + 4) > 0.5 ? 1 : -1;

        for (let yb = y0; yb < y1b; yb++) {
          const rowBase = yb * w;
          const sx = Math.min(w - 1, Math.max(0, startX));
          const srcI = (rowBase + sx) * 4;
          const sr = d[srcI];
          const sg = d[srcI + 1];
          const sb = d[srcI + 2];

          for (let k = 0; k < len; k++) {
            const xx = startX + k * dir;
            if (xx < 0 || xx >= w) break;
            const o = (rowBase + xx) * 4;
            const t = 1 - 0.35 * (k / len);
            d[o] = d[o] + (sr - d[o]) * t;
            d[o + 1] = d[o + 1] + (sg - d[o + 1]) * t;
            d[o + 2] = d[o + 2] + (sb - d[o + 2]) * t;
            if (mask) mask.data[rowBase + xx] = Math.max(mask.data[rowBase + xx], t);
          }
        }
      }
    }

    // ------------------------------------------------------------------ 4
    // Sparks on an artwork-unit lattice so density is resolution-stable.
    if (p.sparks > 0.001) {
      const pitchU = 28; // artwork units between candidate spark sites
      const pitch = Math.max(2, Math.round(ctx.u(pitchU)));
      const thick = Math.max(1, Math.round(ctx.u(0.9)));
      const cols = Math.ceil(w / pitch);
      const srows = Math.ceil(h / pitch);

      for (let sy = 0; sy < srows; sy++) {
        for (let sx = 0; sx < cols; sx++) {
          const x0 = Math.min(w - 1, Math.floor((sx + 0.5) * pitch));
          const y0 = Math.min(h - 1, Math.floor((sy + 0.5) * pitch));
          const xU = ctx.toUnits(x0);
          const yU = ctx.toUnits(y0);
          const gate = noise2(xU / 40, yU / 40, ctx.noiseSeed + 90);
          const local = sparkMod.at(x0, y0);
          // Density: only a fraction of lattice sites fire
          if (gate > local * 0.55) continue;

          const L = luma(d[(y0 * w + x0) * 4], d[(y0 * w + x0) * 4 + 1], d[(y0 * w + x0) * 4 + 2]) / 255;
          if (noise2(xU / 33, yU / 33, ctx.noiseSeed + 91) < L * 0.4) continue;

          const len = Math.max(
            2,
            Math.round(sparkLenPx * (0.35 + noise2(xU / 50, yU / 50, ctx.noiseSeed + 92) * 0.9))
          );
          const dir = noise2(xU / 60, yU / 60, ctx.noiseSeed + 93) > 0.5 ? 1 : -1;

          for (let k = 0; k < len; k++) {
            const xx = x0 + k * dir;
            if (xx < 0 || xx >= w) break;
            const fade = 1 - (k / len) ** 1.2;
            const core = k < Math.max(1, thick) ? 1 : fade;
            for (let ty = 0; ty < thick; ty++) {
              const yy = y0 + ty;
              if (yy < 0 || yy >= h) continue;
              const o = (yy * w + xx) * 4;
              d[o] = d[o] + (spr - d[o]) * core;
              d[o + 1] = d[o + 1] + (spg - d[o + 1]) * core;
              d[o + 2] = d[o + 2] + (spb - d[o + 2]) * core;
              if (mask) mask.data[yy * w + xx] = Math.max(mask.data[yy * w + xx], core);
            }
          }

          if (noise2(xU / 70, yU / 70, ctx.noiseSeed + 94) > 0.72) {
            const o = (y0 * w + x0) * 4;
            d[o] = 255;
            d[o + 1] = 255;
            d[o + 2] = 255;
          }
        }
      }
    }

    // ------------------------------------------------------------------ 5
    // Vertical seam — wipe one side toward black (highway / split frame).
    if (p.seam > 0.01) {
      const sx = Math.floor(p.seamX * w);
      const strength = p.seam;
      // Soft edge around the cut
      const feather = Math.max(1, Math.round(ctx.u(8)));
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          // Right side goes dark (matches the references)
          if (x < sx) continue;
          const dist = x - sx;
          const edge = dist < feather ? dist / feather : 1;
          const t = strength * edge;
          if (t <= 0) continue;
          const o = (row + x) * 4;
          d[o] *= 1 - t;
          d[o + 1] *= 1 - t;
          d[o + 2] *= 1 - t;
          if (mask) mask.data[row + x] = Math.max(mask.data[row + x], t);
        }
      }
    }

    if (mask) ctx.masks.set(ctx.layerId, mask);
    return out;
  },
};
