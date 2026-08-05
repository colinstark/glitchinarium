import { cloneBuf } from "../buffer.js";
import { luma, hueOf, saturationOf, parseHex, clamp255 } from "../color.js";

/**
 * Flat spot ink over a selected tonal or hue range.
 *
 * The red horse: one saturated colour replacing a band of the original, laid in
 * like a second pass on a press. `preserve` keeps the underlying luminance
 * modulation so the ink still describes form instead of flooding it — that is
 * the difference between a spot colour and a paint-bucket fill.
 */
export default {
  id: "spot-color",
  name: "Spot colour",
  category: "tone",
  params: [
    { key: "target", type: "select", label: "Select", options: ["luma", "hue", "saturation"], default: "luma" },
    { key: "low", type: "range", label: "Low", min: 0, max: 1, step: 0.01, default: 0.0, showIf: (p) => p.target !== "hue", mod: true },
    { key: "high", type: "range", label: "High", min: 0, max: 1, step: 0.01, default: 0.35, showIf: (p) => p.target !== "hue", mod: true },
    { key: "hueTarget", type: "range", label: "Hue", min: 0, max: 360, step: 1, default: 20, showIf: (p) => p.target === "hue" },
    { key: "hueWidth", type: "range", label: "Hue width", min: 5, max: 180, step: 1, default: 45, showIf: (p) => p.target === "hue" },
    { key: "softness", type: "range", label: "Softness", min: 0, max: 0.5, step: 0.01, default: 0.08 },
    { key: "color", type: "color", label: "Ink", default: "#ff2d16" },
    { key: "amount", type: "range", label: "Amount", min: 0, max: 1, step: 0.01, default: 1, mod: true },
    { key: "preserve", type: "range", label: "Preserve tone", min: 0, max: 1, step: 0.01, default: 0.45 },
    { key: "mode", type: "select", label: "Mode", options: ["replace", "multiply", "screen"], default: "replace" },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const d = out.data;
    const s = src.data;
    const [ir, ig, ib] = parseHex(p.color);
    const lowMod = ctx.mod("low", p.low);
    const highMod = ctx.mod("high", p.high);
    const amountMod = ctx.mod("amount", p.amount);
    const soft = Math.max(1e-4, p.softness);

    const ramp = (v, e0, e1) => {
      const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0 || 1e-4)));
      return t * t * (3 - 2 * t);
    };

    for (let i = 0, px = 0; i < s.length; i += 4, px++) {
      const r = s[i];
      const gch = s[i + 1];
      const b = s[i + 2];

      let sel;
      if (p.target === "hue") {
        let dh = Math.abs(hueOf(r, gch, b) - p.hueTarget);
        if (dh > 180) dh = 360 - dh;
        sel = Math.max(0, 1 - dh / (p.hueWidth / 2)) * saturationOf(r, gch, b);
      } else {
        const v = p.target === "saturation" ? saturationOf(r, gch, b) : luma(r, gch, b) / 255;
        const lo = lowMod.atIndex(px);
        const hi = highMod.atIndex(px);
        sel = ramp(v, lo - soft, lo + soft) * (1 - ramp(v, hi - soft, hi + soft));
      }

      const k = sel * amountMod.atIndex(px);
      if (k <= 0.002) continue;

      // Keep some of the original luminance so the flat ink still has form.
      const l = luma(r, gch, b) / 255;
      const shade = 1 - p.preserve + p.preserve * (0.35 + l * 0.9);

      for (let c = 0; c < 3; c++) {
        const base = s[i + c];
        const ink = [ir, ig, ib][c] * shade;
        let v;
        if (p.mode === "multiply") v = (base * ink) / 255;
        else if (p.mode === "screen") v = 255 - ((255 - base) * (255 - ink)) / 255;
        else v = ink;
        d[i + c] = clamp255(base + (v - base) * k);
      }
    }
    return out;
  },
};
