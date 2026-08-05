import { createBuf } from "../buffer.js";
import { parseHex, clamp255 } from "../color.js";
import { bayerAt } from "../patterns.js";
import { noise2 } from "../rng.js";

/**
 * Strict palette quantisation.
 *
 * Every colour in the image is snapped to one of a handful, with an optional
 * ordered dither so gradients survive as texture rather than banding. This is
 * the discipline behind the pixel-poster reference grid — two or three inks and
 * nothing else, which forces the dither to do all the tonal work.
 *
 * `auto` derives the palette from the image by median cut, so you get a limited
 * set that still belongs to the picture.
 */

const PALETTES = {
  "mac-2": ["#000000", "#ffffff"],
  "ink-3": ["#12100e", "#8a8578", "#f2ede1"],
  "oxblood": ["#2a1220", "#8c2f39", "#e0a458", "#f5e6cc"],
  "forest": ["#1b2a25", "#3f6b4a", "#c9a227", "#e8e1cf"],
  "night-blue": ["#10162b", "#2f4b7c", "#7aa6c2", "#f0e6d2"],
  "ember": ["#14090a", "#7a1f0f", "#ef6c1a", "#ffe9a8"],
  "gameboy": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
  "riso-3": ["#1a1a1a", "#ff5252", "#4b6bff"],
};

/** Median-cut palette extraction — splits the colour cube along its widest axis. */
function medianCut(data, count) {
  const samples = [];
  const stride = Math.max(4, Math.floor(data.length / 4 / 20000) * 4);
  for (let i = 0; i < data.length; i += stride) {
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!samples.length) return [[0, 0, 0]];

  let boxes = [samples];
  while (boxes.length < count) {
    // Split the box with the largest spread on its longest channel.
    let bi = -1;
    let best = -1;
    let axis = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const s of box) {
          if (s[c] < lo) lo = s[c];
          if (s[c] > hi) hi = s[c];
        }
        if (hi - lo > best) { best = hi - lo; bi = i; axis = c; }
      }
    });
    if (bi < 0) break;
    const box = boxes[bi].slice().sort((a, b) => a[axis] - b[axis]);
    const mid = box.length >> 1;
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
  }

  return boxes.map((box) => {
    const avg = [0, 0, 0];
    for (const s of box) { avg[0] += s[0]; avg[1] += s[1]; avg[2] += s[2]; }
    return avg.map((v) => v / (box.length || 1));
  });
}

export default {
  id: "palette",
  name: "Palette lock",
  category: "tone",
  feature: ["blockSize"],
  params: [
    {
      key: "palette",
      type: "select",
      label: "Palette",
      options: [...Object.keys(PALETTES), "auto"],
      default: "ink-3",
    },
    { key: "count", type: "range", label: "Colours", min: 2, max: 16, step: 1, default: 4, showIf: (p) => p.palette === "auto" },
    {
      key: "dither",
      type: "select",
      label: "Dither",
      options: ["bayer8", "bayer4", "bayer2", "noise", "none"],
      default: "bayer8",
    },
    { key: "ditherAmount", type: "range", label: "Dither amount", min: 0, max: 1.5, step: 0.01, default: 0.6, mod: true },
    { key: "blockSize", type: "range", label: "Dither block", min: 0.5, max: 20, step: 0.25, default: 1.5, unit: "u" },
    { key: "mix", type: "range", label: "Mix", min: 0, max: 1, step: 0.01, default: 1, mod: true },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const s = src.data;
    const d = out.data;

    const colors =
      p.palette === "auto"
        ? medianCut(s, p.count)
        : (PALETTES[p.palette] ?? PALETTES["mac-2"]).map(parseHex);

    const block = Math.max(1, ctx.u(p.blockSize));
    const amountMod = ctx.mod("ditherAmount", p.ditherAmount);
    const mixMod = ctx.mod("mix", p.mix);
    const bayerSize = p.dither === "bayer2" ? 2 : p.dither === "bayer4" ? 4 : 8;

    for (let y = 0, i = 0, px = 0; y < src.h; y++) {
      const cy = Math.floor(y / block);
      for (let x = 0; x < src.w; x++, i += 4, px++) {
        const cx = Math.floor(x / block);

        // Perturb the colour BEFORE snapping. Nudging the sample rather than
        // the palette is what turns banding into texture.
        let t = 0;
        if (p.dither === "noise") t = noise2(cx * 0.9137, cy * 0.7391, ctx.noiseSeed) - 0.5;
        else if (p.dither !== "none") t = bayerAt(cx, cy, bayerSize) - 0.5;
        const kick = t * amountMod.atIndex(px) * 64;

        const r = s[i] + kick;
        const g = s[i + 1] + kick;
        const b = s[i + 2] + kick;

        let bestI = 0;
        let bestD = Infinity;
        for (let c = 0; c < colors.length; c++) {
          const col = colors[c];
          const dr = r - col[0];
          const dg = g - col[1];
          const db = b - col[2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestD) { bestD = dist; bestI = c; }
        }

        const col = colors[bestI];
        const mix = mixMod.atIndex(px);
        d[i] = clamp255(s[i] + (col[0] - s[i]) * mix);
        d[i + 1] = clamp255(s[i + 1] + (col[1] - s[i + 1]) * mix);
        d[i + 2] = clamp255(s[i + 2] + (col[2] - s[i + 2]) * mix);
        d[i + 3] = s[i + 3];
      }
    }
    return out;
  },
};
