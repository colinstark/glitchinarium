import { createBuf, cloneBuf, createMask, blurMask } from "../buffer.js";
import { luma, buildRamp, PALETTES, PALETTE_NAMES, parseHex } from "../color.js";

/**
 * Topographic iso-lines of luminance.
 *
 * Blur the tone, quantise it into bands, then draw where the band index
 * changes. The result is the concentric ring structure in the kaleidoscopic
 * figure reference — contours that describe the form the way a map describes a
 * hill, tightening where the image falls away steeply.
 *
 * `bands` fills the levels instead of outlining them, which is a posterise that
 * respects the same blurred topology.
 */
export default {
  id: "contour",
  name: "Contour",
  category: "glyph",
  params: [
    { key: "mode", type: "select", label: "Mode", options: ["lines", "bands", "both"], default: "lines" },
    { key: "levels", type: "range", label: "Levels", min: 2, max: 60, step: 1, default: 14, mod: true },
    { key: "smooth", type: "range", label: "Smoothing", min: 0, max: 60, step: 0.5, default: 6, unit: "u", hint: "blur before contouring — higher gives longer, calmer rings" },
    { key: "thickness", type: "range", label: "Thickness", min: 0.5, max: 20, step: 0.25, default: 1.5, unit: "u", mod: true },
    { key: "lineColor", type: "color", label: "Line colour", default: "#141414" },
    { key: "bgAlpha", type: "range", label: "Background alpha", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "bg", type: "color", label: "Background", default: "#f4f1e8" },
    {
      key: "bandPalette",
      type: "select",
      label: "Band ramp",
      options: PALETTE_NAMES,
      default: "duotone",
      showIf: (p) => p.mode !== "lines",
    },
    { key: "invert", type: "toggle", label: "Invert", default: false },
  ],

  apply(ctx, src, p) {
    const { w, h } = src;
    const s = src.data;

    // Blur the tone first: contouring raw pixels produces noise confetti, not
    // topography.
    const field = createMask(w, h);
    for (let i = 0, q = 0; i < field.data.length; i++, q += 4) {
      field.data[i] = luma(s[q], s[q + 1], s[q + 2]) / 255;
    }
    const smooth = ctx.u(p.smooth);
    if (smooth >= 0.5) blurMask(field, smooth);

    const out = p.bgAlpha > 0 || p.mode !== "lines" ? createBuf(w, h) : cloneBuf(src);
    const d = out.data;
    const levelsMod = ctx.mod("levels", p.levels);
    const thickMod = ctx.modPx("thickness", p.thickness);
    const [lr, lg, lb] = parseHex(p.lineColor);
    const [br, bgc, bb] = parseHex(p.bg);
    const lut = p.mode !== "lines" ? buildRamp(PALETTES[p.bandPalette] ?? PALETTES.duotone) : null;

    const levelAt = (x, y, n) => {
      const v = field.data[y * w + x];
      return Math.floor((p.invert ? 1 - v : v) * n);
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = Math.max(2, Math.round(levelsMod.at(x, y)));
        const lv = levelAt(x, y, n);

        // --- background / bands ---
        if (p.mode === "lines") {
          if (p.bgAlpha > 0) {
            d[i] = s[i] + (br - s[i]) * p.bgAlpha;
            d[i + 1] = s[i + 1] + (bgc - s[i + 1]) * p.bgAlpha;
            d[i + 2] = s[i + 2] + (bb - s[i + 2]) * p.bgAlpha;
            d[i + 3] = 255;
          }
        } else {
          const t = Math.round((lv / Math.max(1, n - 1)) * 255) * 3;
          d[i] = lut[t];
          d[i + 1] = lut[t + 1];
          d[i + 2] = lut[t + 2];
          d[i + 3] = 255;
        }

        if (p.mode === "bands") continue;

        // --- line: does any neighbour within the stroke radius sit on a
        // different level? ---
        const r = Math.max(1, Math.round(thickMod.at(x, y)));
        let edge = false;
        for (let k = 1; k <= r && !edge; k++) {
          if (x + k < w && levelAt(x + k, y, n) !== lv) edge = true;
          else if (y + k < h && levelAt(x, y + k, n) !== lv) edge = true;
        }
        if (!edge) continue;

        d[i] = lr;
        d[i + 1] = lg;
        d[i + 2] = lb;
        d[i + 3] = 255;
      }
    }
    return out;
  },
};
