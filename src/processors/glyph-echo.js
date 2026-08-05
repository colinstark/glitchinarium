import { cloneBuf, sampleBilinear } from "../buffer.js";
import { luma, parseHex, clamp255 } from "../color.js";

/**
 * Offset colour echoes of whatever is inked below.
 *
 * In the goose reference the same letters repeat in orange and pink, shifted —
 * print misregistration applied to type. Rather than needing a special glyph
 * layer, this keys on the ink itself: pixels that pass the key test get copied
 * to an offset position in a new colour, so it echoes ASCII, hatching, edge
 * traces or any dark mark already in the stack.
 */
export default {
  id: "glyph-echo",
  name: "Echo",
  category: "glyph",
  params: [
    { key: "keyMode", type: "select", label: "Key on", options: ["dark", "light", "alpha"], default: "dark" },
    { key: "threshold", type: "range", label: "Key threshold", min: 0, max: 1, step: 0.01, default: 0.45 },
    { key: "copies", type: "range", label: "Copies", min: 1, max: 6, step: 1, default: 2 },
    { key: "offset", type: "range", label: "Offset", min: 0, max: 200, step: 0.5, default: 26, unit: "u", mod: true },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 6.283, step: 0.01, default: 0 },
    { key: "spread", type: "range", label: "Spread", min: 0, max: 1, step: 0.01, default: 0, hint: "fan the copies apart instead of stacking them in a line" },
    { key: "colorA", type: "color", label: "Colour 1", default: "#e8862a" },
    { key: "colorB", type: "color", label: "Colour 2", default: "#f0a8c0" },
    { key: "colorC", type: "color", label: "Colour 3", default: "#7ea8d8" },
    { key: "falloff", type: "range", label: "Falloff", min: 0, max: 1, step: 0.01, default: 0.15 },
    { key: "behind", type: "toggle", label: "Behind original", default: true },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const d = out.data;
    const s = src.data;
    const { w, h } = src;
    const offsetMod = ctx.modPx("offset", p.offset);
    const cols = [parseHex(p.colorA), parseHex(p.colorB), parseHex(p.colorC)];
    const px = new Float32Array(4);

    /** How much ink is at this sample, 0..1. */
    const keyOf = (r, g, b, a) => {
      if (p.keyMode === "alpha") return a / 255;
      const l = luma(r, g, b) / 255;
      if (p.keyMode === "light") return l > p.threshold ? 1 : 0;
      return l < p.threshold ? 1 : 0;
    };

    // Painted back to front so copy 1 ends up nearest the original.
    for (let c = p.copies - 1; c >= 0; c--) {
      const col = cols[c % cols.length];
      const step = c + 1;
      const a = p.angle + p.spread * step * 0.7;
      const alpha = Math.max(0, 1 - p.falloff * c);

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const dist = offsetMod.at(x, y) * step;
          const sx = x - Math.cos(a) * dist;
          const sy = y - Math.sin(a) * dist;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;

          sampleBilinear(src, sx, sy, px, "clamp");
          const k = keyOf(px[0], px[1], px[2], px[3]) * alpha;
          if (k <= 0.01) continue;

          // Skip where the original already has ink, so echoes sit around the
          // marks rather than muddying them.
          if (p.behind) {
            const own = keyOf(s[i], s[i + 1], s[i + 2], s[i + 3]);
            if (own > 0.5) continue;
          }

          for (let ch = 0; ch < 3; ch++) {
            d[i + ch] = clamp255(d[i + ch] + (col[ch] - d[i + ch]) * k);
          }
          d[i + 3] = Math.max(d[i + 3], 255 * k);
        }
      }
    }
    return out;
  },
};
