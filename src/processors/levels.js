import { createBuf } from "../buffer.js";
import { luma, clamp255 } from "../color.js";

/** Tone shaping. Cheap, scale-free, and the usual first layer in a stack. */
export default {
  id: "levels",
  name: "Levels",
  category: "tone",
  params: [
    { key: "exposure", type: "range", label: "Exposure", min: -1, max: 1, step: 0.01, default: 0 },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0 },
    { key: "gamma", type: "range", label: "Gamma", min: 0.2, max: 3, step: 0.01, default: 1 },
    { key: "saturation", type: "range", label: "Saturation", min: 0, max: 2, step: 0.01, default: 1, mod: true },
    { key: "posterize", type: "range", label: "Posterize", min: 0, max: 16, step: 1, default: 0, hint: "0 = off" },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const s = src.data;
    const d = out.data;

    // Build a 256-entry curve once rather than doing pow() per channel per pixel.
    const curve = new Uint8ClampedArray(256);
    const gain = Math.pow(2, p.exposure);
    const k = p.contrast * 0.9; // keep it short of a hard clip at ±1
    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * gain;
      v = Math.pow(Math.max(0, v), 1 / p.gamma);
      v = (v - 0.5) * (1 + k) + 0.5;
      if (p.posterize >= 2) {
        const steps = p.posterize;
        v = Math.round(v * (steps - 1)) / (steps - 1);
      }
      curve[i] = clamp255(v * 255);
    }

    const satMod = ctx.mod("saturation", p.saturation);
    for (let i = 0, px = 0; i < s.length; i += 4, px++) {
      let r = curve[s[i]];
      let g = curve[s[i + 1]];
      let b = curve[s[i + 2]];
      const sat = satMod.atIndex(px);
      if (sat !== 1) {
        const l = luma(r, g, b);
        r = clamp255(l + (r - l) * sat);
        g = clamp255(l + (g - l) * sat);
        b = clamp255(l + (b - l) * sat);
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = s[i + 3];
    }
    return out;
  },
};
