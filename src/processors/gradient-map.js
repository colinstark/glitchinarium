import { createBuf } from "../buffer.js";
import { luma, saturationOf, buildRamp, PALETTES, PALETTE_NAMES } from "../color.js";

/**
 * Map a scalar channel of the image onto a colour ramp — black becomes one
 * colour, white another, with as many stops in between as you like.
 *
 * Placed before an ASCII layer it recolours what the glyphs sample; placed
 * after, it recolours the glyphs themselves. That is purely a matter of stack
 * position, which is why this is a plain layer and not a global setting.
 */
export default {
  id: "gradient-map",
  name: "Gradient map",
  category: "tone",
  params: [
    {
      key: "palette",
      type: "select",
      label: "Palette",
      options: [...PALETTE_NAMES, "custom"],
      default: "park-guell",
    },
    {
      key: "stops",
      type: "gradient",
      label: "Custom stops",
      default: [
        { pos: 0, color: "#10233f" },
        { pos: 1, color: "#f6e6cd" },
      ],
      showIf: (p) => p.palette === "custom",
    },
    {
      key: "source",
      type: "select",
      label: "Driven by",
      options: ["luma", "saturation", "red", "green", "blue"],
      default: "luma",
    },
    { key: "mix", type: "range", label: "Mix", min: 0, max: 1, step: 0.01, default: 1, mod: true },
    { key: "shift", type: "range", label: "Shift", min: -0.5, max: 0.5, step: 0.01, default: 0 },
    { key: "spread", type: "range", label: "Spread", min: 0.2, max: 3, step: 0.01, default: 1 },
    { key: "reverse", type: "toggle", label: "Reverse", default: false },
  ],

  apply(ctx, src, p) {
    const stops = p.palette === "custom" ? p.stops : PALETTES[p.palette] ?? PALETTES.duotone;
    const lut = buildRamp(stops);

    const out = createBuf(src.w, src.h);
    const s = src.data;
    const d = out.data;
    const mixMod = ctx.mod("mix", p.mix);

    for (let i = 0, px = 0; i < s.length; i += 4, px++) {
      const mix = mixMod.atIndex(px);
      const r = s[i];
      const g = s[i + 1];
      const b = s[i + 2];

      let t;
      switch (p.source) {
        case "saturation": t = saturationOf(r, g, b); break;
        case "red": t = r / 255; break;
        case "green": t = g / 255; break;
        case "blue": t = b / 255; break;
        default: t = luma(r, g, b) / 255;
      }

      t = (t - 0.5) * p.spread + 0.5 + p.shift;
      if (p.reverse) t = 1 - t;
      const idx = (t < 0 ? 0 : t > 1 ? 255 : Math.round(t * 255)) * 3;

      d[i] = r + (lut[idx] - r) * mix;
      d[i + 1] = g + (lut[idx + 1] - g) * mix;
      d[i + 2] = b + (lut[idx + 2] - b) * mix;
      d[i + 3] = s[i + 3];
    }
    return out;
  },
};
