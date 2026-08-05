import { cloneBuf, createBuf } from "../buffer.js";
import { parseHex } from "../color.js";

/**
 * Rectangular regions copied and pasted offset.
 *
 * The castle reference is full of these: crops of the picture repeated at a
 * shift, some outlined in a thin blue keyline, edges stepping in a staircase
 * rather than cutting straight. It reads as a working file left open — layers
 * that were never flattened.
 *
 * Region count and geometry come from `ctx.rng` in normalised coordinates. That
 * is the legitimate use of a sequential generator: the number of regions does
 * not depend on how many pixels there are, so the same rectangles appear at
 * every render size.
 */
export default {
  id: "region-echo",
  name: "Region echo",
  category: "glitch",
  params: [
    { key: "count", type: "range", label: "Regions", min: 1, max: 40, step: 1, default: 7 },
    { key: "minSize", type: "range", label: "Min size", min: 0.02, max: 1, step: 0.01, default: 0.12, hint: "fraction of the frame" },
    { key: "maxSize", type: "range", label: "Max size", min: 0.05, max: 1.5, step: 0.01, default: 0.45 },
    { key: "offset", type: "range", label: "Offset", min: 0, max: 400, step: 1, default: 60, unit: "u", mod: true },
    { key: "offsetAngle", type: "range", label: "Offset angle", min: 0, max: 6.283, step: 0.01, default: 0 },
    { key: "angleJitter", type: "range", label: "Angle jitter", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "opacity", type: "range", label: "Region opacity", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "steps", type: "range", label: "Stepped edges", min: 0, max: 40, step: 0.5, default: 0, unit: "u", hint: "staircase the rectangle edges instead of cutting straight" },
    { key: "stroke", type: "toggle", label: "Keyline", default: true },
    { key: "strokeColor", type: "color", label: "Keyline colour", default: "#2f6fe0" },
    { key: "strokeWidth", type: "range", label: "Keyline width", min: 0.25, max: 10, step: 0.25, default: 1, unit: "u" },
    { key: "strokeOnly", type: "toggle", label: "Keyline only", default: false, hint: "draw the frames without moving any pixels" },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const d = out.data;
    const s = src.data;
    const { w, h } = src;
    const offsetMod = ctx.modPx("offset", p.offset);
    const stepPx = ctx.u(p.steps);
    const strokeW = Math.max(1, Math.round(ctx.u(p.strokeWidth)));
    const [sr, sg, sb] = parseHex(p.strokeColor);
    const minS = Math.min(p.minSize, p.maxSize);
    const maxS = Math.max(p.minSize, p.maxSize);

    for (let n = 0; n < p.count; n++) {
      // Clamp to the frame — maxSize can exceed 1.0, and a region larger than
      // the image yields a negative position range that corrupts the copy.
      const rw = Math.max(1, Math.min(w, Math.round((minS + ctx.rng() * (maxS - minS)) * w)));
      const rh = Math.max(1, Math.min(h, Math.round((minS + ctx.rng() * (maxS - minS)) * h)));
      const rx = Math.round(ctx.rng() * Math.max(0, w - rw));
      const ry = Math.round(ctx.rng() * Math.max(0, h - rh));

      const a = p.offsetAngle + (ctx.rng() - 0.5) * Math.PI * 2 * p.angleJitter;
      const dist = offsetMod.at(rx + rw / 2, ry + rh / 2);
      const ox = Math.round(Math.cos(a) * dist);
      const oy = Math.round(Math.sin(a) * dist);

      // A staircase edge: the row's horizontal extent is quantised, so the
      // rectangle's sides climb in blocks.
      // MUST return an integer. A fractional offset makes `sx`/`dx` fractional,
      // and a fractional typed-array index silently drops the write while
      // deoptimising the whole copy loop into dictionary lookups — it measured
      // 43x slower and rendered incompletely.
      const stepFor = (y) => {
        if (stepPx < 1) return 0;
        const q = Math.floor((y - ry) / stepPx);
        return Math.round(((((q * 2654435761) % 7) + 7) % 7 - 3) * stepPx);
      };

      if (!p.strokeOnly) {
        for (let y = 0; y < rh; y++) {
          const dy = ry + y + oy;
          if (dy < 0 || dy >= h) continue;
          const wob = stepFor(ry + y);
          for (let x = 0; x < rw; x++) {
            const sx = rx + x + wob;
            const dx = rx + x + ox + wob;
            if (dx < 0 || dx >= w || sx < 0 || sx >= w) continue;
            const si = ((ry + y) * w + sx) * 4;
            const di = (dy * w + dx) * 4;
            for (let c = 0; c < 3; c++) {
              d[di + c] = d[di + c] + (s[si + c] - d[di + c]) * p.opacity;
            }
            d[di + 3] = Math.max(d[di + 3], s[si + 3]);
          }
        }
      }

      if (p.stroke) {
        const bx = rx + (p.strokeOnly ? 0 : ox);
        const by = ry + (p.strokeOnly ? 0 : oy);
        const put = (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return;
          const i = (y * w + x) * 4;
          d[i] = sr;
          d[i + 1] = sg;
          d[i + 2] = sb;
          d[i + 3] = 255;
        };
        for (let t = 0; t < strokeW; t++) {
          for (let x = 0; x < rw; x++) {
            put(bx + x, by + t);
            put(bx + x, by + rh - 1 - t);
          }
          for (let y = 0; y < rh; y++) {
            put(bx + t, by + y);
            put(bx + rw - 1 - t, by + y);
          }
        }
      }
    }
    return out;
  },
};
