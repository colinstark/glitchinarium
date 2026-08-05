import { createBuf, cloneBuf, boxBlurBuf } from "../buffer.js";
import { luma, parseHex, clamp255 } from "../color.js";

/**
 * Threshold bloom.
 *
 * Bright areas are isolated, blurred and added back — the soft white halos
 * around the ornaments in the swimming-dog reference. Because the bright pass
 * is thresholded rather than the whole image being blurred, edges stay sharp
 * and only the highlights bleed.
 */
export default {
  id: "glow",
  name: "Glow",
  category: "texture",
  params: [
    { key: "threshold", type: "range", label: "Threshold", min: 0, max: 1, step: 0.01, default: 0.68 },
    { key: "knee", type: "range", label: "Knee", min: 0.01, max: 0.6, step: 0.01, default: 0.18, hint: "how gradually highlights enter the bloom" },
    { key: "radius", type: "range", label: "Radius", min: 1, max: 200, step: 1, default: 26, unit: "u", mod: true },
    { key: "intensity", type: "range", label: "Intensity", min: 0, max: 3, step: 0.01, default: 1, mod: true },
    { key: "mode", type: "select", label: "Mode", options: ["screen", "add", "lighten"], default: "screen" },
    { key: "tint", type: "color", label: "Tint", default: "#ffffff" },
    { key: "tintAmount", type: "range", label: "Tint amount", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "desaturate", type: "range", label: "Desaturate", min: 0, max: 1, step: 0.01, default: 0.3 },
  ],

  apply(ctx, src, p) {
    const { w, h } = src;
    const s = src.data;

    // --- isolate the highlights ---
    const bright = createBuf(w, h);
    const b = bright.data;
    const [tr, tg, tb] = parseHex(p.tint);

    for (let i = 0; i < s.length; i += 4) {
      const l = luma(s[i], s[i + 1], s[i + 2]) / 255;
      const t = Math.max(0, Math.min(1, (l - p.threshold) / p.knee));
      const k = t * t * (3 - 2 * t);
      for (let c = 0; c < 3; c++) {
        let v = s[i + c] * k;
        if (p.desaturate > 0) v += (l * 255 * k - v) * p.desaturate;
        if (p.tintAmount > 0) v += ([tr, tg, tb][c] * k - v) * p.tintAmount;
        b[i + c] = v;
      }
      b[i + 3] = 255;
    }

    // A modulated radius would mean a spatially varying blur, which a separable
    // box filter cannot express — blur at the widest requested radius, then
    // scale the contribution per pixel. Visually equivalent for a bloom.
    const radiusMod = ctx.modPx("radius", p.radius);
    boxBlurBuf(bright, Math.max(1, radiusMod.max), undefined, ctx);

    const out = cloneBuf(src);
    const d = out.data;
    const intensityMod = ctx.mod("intensity", p.intensity);
    const falloff = radiusMod.constant ? null : radiusMod;

    for (let i = 0, px = 0; i < s.length; i += 4, px++) {
      let k = intensityMod.atIndex(px);
      if (falloff) k *= falloff.atIndex(px) / (falloff.max || 1);
      if (k <= 0) continue;

      for (let c = 0; c < 3; c++) {
        const base = s[i + c];
        const bloom = b[i + c] * k;
        let v;
        if (p.mode === "add") v = base + bloom;
        else if (p.mode === "lighten") v = Math.max(base, bloom);
        else v = 255 - ((255 - base) * (255 - Math.min(255, bloom))) / 255;
        d[i + c] = clamp255(v);
      }
    }
    return out;
  },
};
