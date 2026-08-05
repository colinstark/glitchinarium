import { createBuf } from "../buffer.js";
import { luma, parseHex, clamp255 } from "../color.js";
import { dotScreenAt, lineScreenAt, SCREEN_ANGLES } from "../patterns.js";

/**
 * AM halftone — a proper print screen, not a dither.
 *
 * Dithering scatters fixed-size pixels; a halftone screen varies DOT SIZE on a
 * fixed rotated lattice. That is what produces the dense rosette texture over
 * the whole bird reference and the tonal gradients in the pixel posters.
 *
 * In `cmyk` each channel gets its own classic lithography angle (15/75/0/45)
 * so the dots interleave into a rosette instead of beating into moiré.
 */
export default {
  id: "screen",
  name: "Screen",
  category: "halftone",
  feature: ["pitch"],
  params: [
    { key: "mode", type: "select", label: "Mode", options: ["mono", "cmyk", "rgb"], default: "mono" },
    { key: "shape", type: "select", label: "Dot shape", options: ["dot", "line", "cross"], default: "dot" },
    { key: "pitch", type: "range", label: "Pitch", min: 1, max: 60, step: 0.25, default: 6, unit: "u", mod: true },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 3.15, step: 0.01, default: 0.785, showIf: (p) => p.mode !== "cmyk" },
    { key: "sharpness", type: "range", label: "Sharpness", min: 0.02, max: 1, step: 0.01, default: 0.35, hint: "low keeps dots soft-edged, high makes them hard" },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0, mod: true },
    { key: "ink", type: "color", label: "Ink", default: "#141414", showIf: (p) => p.mode === "mono" },
    { key: "paper", type: "color", label: "Paper", default: "#f4f1e8", showIf: (p) => p.mode === "mono" },
    { key: "invert", type: "toggle", label: "Invert", default: false },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const s = src.data;
    const d = out.data;
    const pitchMod = ctx.modPx("pitch", p.pitch);
    const contrastMod = ctx.mod("contrast", p.contrast);
    const [ir, ig, ib] = parseHex(p.ink);
    const [pr, pg, pb] = parseHex(p.paper);

    const screenAt = (x, y, pitch, angle) => {
      switch (p.shape) {
        case "line":
          return lineScreenAt(x, y, pitch, angle);
        case "cross":
          // Two perpendicular line screens multiplied — a cross-shaped dot.
          return Math.min(
            1,
            lineScreenAt(x, y, pitch, angle) * 0.6 + lineScreenAt(x, y, pitch, angle + Math.PI / 2) * 0.6
          );
        default:
          return dotScreenAt(x, y, pitch, angle);
      }
    };

    // Coverage 0..1 → how much of the cell the dot fills at this threshold.
    const cover = (level, thresh) => {
      const e = p.sharpness;
      const t = (level - thresh) / e + 0.5;
      return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    };

    for (let y = 0, i = 0, px = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++, i += 4, px++) {
        const pitch = Math.max(1, pitchMod.atIndex(px));
        const k = contrastMod.atIndex(px) * 0.9;
        const shape = (v) => {
          let t = v;
          t = (t - 0.5) * (1 + k) + 0.5;
          if (p.invert) t = 1 - t;
          return t < 0 ? 0 : t > 1 ? 1 : t;
        };

        if (p.mode === "mono") {
          const level = shape(1 - luma(s[i], s[i + 1], s[i + 2]) / 255);
          const c = cover(level, screenAt(x, y, pitch, p.angle));
          d[i] = pr + (ir - pr) * c;
          d[i + 1] = pg + (ig - pg) * c;
          d[i + 2] = pb + (ib - pb) * c;
        } else if (p.mode === "cmyk") {
          // Under-colour removal: pull the common grey into a black plate so
          // the three chromatic plates carry only the colour.
          const r = s[i] / 255;
          const g = s[i + 1] / 255;
          const b = s[i + 2] / 255;
          const kk = 1 - Math.max(r, g, b);
          const inv = 1 - kk || 1e-6;
          const cy = shape((1 - r - kk) / inv);
          const mg = shape((1 - g - kk) / inv);
          const yl = shape((1 - b - kk) / inv);
          const bk = shape(kk);

          const cC = cover(cy, screenAt(x, y, pitch, SCREEN_ANGLES.cyan));
          const cM = cover(mg, screenAt(x, y, pitch, SCREEN_ANGLES.magenta));
          const cY = cover(yl, screenAt(x, y, pitch, SCREEN_ANGLES.yellow));
          const cK = cover(bk, screenAt(x, y, pitch, SCREEN_ANGLES.black));

          d[i] = clamp255(255 * (1 - cC) * (1 - cK));
          d[i + 1] = clamp255(255 * (1 - cM) * (1 - cK));
          d[i + 2] = clamp255(255 * (1 - cY) * (1 - cK));
        } else {
          for (let c = 0; c < 3; c++) {
            const angle = [SCREEN_ANGLES.cyan, SCREEN_ANGLES.magenta, SCREEN_ANGLES.black][c];
            const level = shape(s[i + c] / 255);
            d[i + c] = clamp255(255 * cover(level, screenAt(x, y, pitch, angle)));
          }
        }
        d[i + 3] = s[i + 3];
      }
    }
    return out;
  },
};
