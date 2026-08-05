import { cloneBuf } from "../buffer.js";
import { parseHex } from "../color.js";
import { noise2 } from "../rng.js";

/**
 * Macroblocks replaced with saturated flat colour.
 *
 * The bird reference is punctuated with clusters of pure green, orange and red
 * squares where the decoder gave up and emitted garbage. The clustering matters
 * more than the colours: isolated blocks read as dust, but a run of them reads
 * as corruption, so a coarse noise field gates the whole thing and a separate
 * run-length pass drags colours sideways.
 */

const SETS = {
  vivid: ["#ff3b1f", "#ffd400", "#22c55e", "#2f6fe0", "#f0f", "#00e5d0"],
  primary: ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"],
  warm: ["#ff5a1f", "#ffb01f", "#ffe74c", "#d92b2b"],
  cool: ["#1fa8ff", "#22d3c5", "#7c5cff", "#0b3a8c"],
  mono: ["#000000", "#ffffff"],
};

export default {
  id: "block-palette",
  name: "Block corruption",
  category: "glitch",
  params: [
    { key: "blockSize", type: "range", label: "Block size", min: 1, max: 80, step: 0.5, default: 9, unit: "u" },
    {
      key: "set",
      type: "select",
      label: "Palette",
      options: [...Object.keys(SETS), "sampled"],
      default: "vivid",
      hint: "sampled pulls the flat colours out of the image itself",
    },
    { key: "amount", type: "range", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.08, mod: true },
    { key: "clusterScale", type: "range", label: "Cluster scale", min: 1, max: 60, step: 0.5, default: 7, hint: "blocks per cluster feature — low makes big contiguous zones" },
    { key: "runLength", type: "range", label: "Run length", min: 0, max: 20, step: 1, default: 3, hint: "how far a corrupt colour drags sideways" },
    { key: "saturate", type: "range", label: "Saturate", min: 0, max: 1, step: 0.01, default: 1, showIf: (p) => p.set === "sampled" },
    { key: "opacity", type: "range", label: "Opacity", min: 0, max: 1, step: 0.01, default: 1 },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const d = out.data;
    const s = src.data;
    const { w, h } = src;
    const block = Math.max(1, Math.round(ctx.u(p.blockSize)));
    const cols = Math.ceil(w / block);
    const rows = Math.ceil(h / block);
    const amountMod = ctx.mod("amount", p.amount);
    const cs = Math.max(0.5, p.clusterScale);
    const palette = p.set === "sampled" ? null : SETS[p.set].map(parseHex);

    for (let by = 0; by < rows; by++) {
      // A run carries one colour across several blocks before resetting.
      let run = 0;
      let runColor = null;

      for (let bx = 0; bx < cols; bx++) {
        const x0 = bx * block;
        const y0 = by * block;
        const x1 = Math.min(w, x0 + block);
        const y1 = Math.min(h, y0 + block);
        const mx = x0 + block / 2;
        const my = y0 + block / 2;

        let color = null;
        if (run > 0) {
          run--;
          color = runColor;
        } else {
          const cluster = noise2(bx / cs, by / cs, ctx.noiseSeed);
          const gate = amountMod.at(mx, my);
          // Square the cluster field so corruption concentrates instead of
          // sprinkling evenly.
          if (cluster * cluster > 1 - gate) {
            if (palette) {
              const pick = Math.floor(noise2(bx * 1.7, by * 1.3, ctx.noiseSeed + 55) * palette.length);
              color = palette[Math.min(palette.length - 1, Math.max(0, pick))];
            } else {
              const si = (Math.min(h - 1, y0) * w + Math.min(w - 1, x0)) * 4;
              const r = s[si];
              const g = s[si + 1];
              const b = s[si + 2];
              const mx2 = Math.max(r, g, b) || 1;
              color = [
                r + (255 * (r / mx2) - r) * p.saturate,
                g + (255 * (g / mx2) - g) * p.saturate,
                b + (255 * (b / mx2) - b) * p.saturate,
              ];
            }
            runColor = color;
            run = Math.floor(noise2(bx * 2.9, by * 3.7, ctx.noiseSeed + 91) * p.runLength);
          }
        }

        if (!color) continue;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 3; c++) {
              d[i + c] = s[i + c] + (color[c] - s[i + c]) * p.opacity;
            }
          }
        }
      }
    }
    return out;
  },
};
