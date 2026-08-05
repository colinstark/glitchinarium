import { bufFromImageData } from "../buffer.js";
import { luma, buildRamp, PALETTES, PALETTE_NAMES, parseHex } from "../color.js";
import { CHARSETS } from "./ascii.js";

/**
 * Glyphs stamped along contours instead of on a grid.
 *
 * The neon `@` outlines tracing the fruit in the oranges reference. A normal
 * ASCII layer fills area; this one finds where the image CHANGES and lays type
 * along the boundary, so the glyphs describe form rather than tone.
 *
 * Each glyph rotates to the edge tangent, which is why the runs read as drawn
 * outlines rather than as scattered characters.
 */
export default {
  id: "edge-trace",
  name: "Edge trace",
  category: "glyph",
  params: [
    {
      key: "charset",
      type: "select",
      label: "Charset",
      options: [...Object.keys(CHARSETS), "custom"],
      default: "minimal",
    },
    { key: "customChars", type: "text", label: "Characters", default: "@", showIf: (p) => p.charset === "custom" },
    { key: "cellSize", type: "range", label: "Spacing", min: 2, max: 60, step: 0.5, default: 8, unit: "u" },
    { key: "glyphScale", type: "range", label: "Glyph size", min: 0.3, max: 3, step: 0.05, default: 1.1 },
    { key: "radius", type: "range", label: "Edge radius", min: 0.5, max: 30, step: 0.5, default: 3, unit: "u" },
    { key: "threshold", type: "range", label: "Threshold", min: 0.01, max: 1, step: 0.01, default: 0.16, mod: true },
    { key: "follow", type: "toggle", label: "Follow tangent", default: true },
    { key: "byStrength", type: "toggle", label: "Glyph from strength", default: false, hint: "pick the character by edge strength rather than always the first" },
    {
      key: "colorMode",
      type: "select",
      label: "Colour",
      options: ["mono", "source", "ramp"],
      default: "mono",
    },
    { key: "color", type: "color", label: "Colour", default: "#b6ff2e", showIf: (p) => p.colorMode === "mono" },
    { key: "palette", type: "select", label: "Ramp", options: PALETTE_NAMES, default: "ember", showIf: (p) => p.colorMode === "ramp" },
    { key: "bg", type: "color", label: "Background", default: "#000000" },
    { key: "bgAlpha", type: "range", label: "Background alpha", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "font", type: "font", label: "Font", options: ["JetBrains Mono", "IBM Plex Mono", "Press Start 2P", "monospace"], default: "JetBrains Mono" },
  ],

  apply(ctx, src, p) {
    const chars = p.charset === "custom" ? p.customChars || "@" : CHARSETS[p.charset];
    if (!chars.length) return null;

    const { w, h } = src;
    const s = src.data;
    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);

    if (p.bgAlpha > 0) {
      const [br, bg_, bb] = parseHex(p.bg);
      g.fillStyle = `rgba(${br},${bg_},${bb},${p.bgAlpha})`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }

    const cell = Math.max(2, ctx.u(p.cellSize));
    const r = Math.max(1, Math.round(ctx.u(p.radius)));
    const family = /\s/.test(p.font) ? `"${p.font}", monospace` : `${p.font}, monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `${cell * p.glyphScale}px ${family}`;

    const lut = p.colorMode === "ramp" ? buildRamp(PALETTES[p.palette] ?? PALETTES.duotone) : null;
    const threshMod = ctx.mod("threshold", p.threshold);

    const L = (x, y) => {
      const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
      const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
      const i = (yy * w + xx) * 4;
      return luma(s[i], s[i + 1], s[i + 2]) / 255;
    };

    const cols = Math.ceil(w / cell);
    const rows = Math.ceil(h / cell);
    const last = chars.length - 1;

    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const x = Math.round((rx + 0.5) * cell);
        const y = Math.round((ry + 0.5) * cell);

        // Sobel at an artwork-unit radius, same rule as the edge mask.
        const gx =
          L(x + r, y - r) + 2 * L(x + r, y) + L(x + r, y + r) -
          L(x - r, y - r) - 2 * L(x - r, y) - L(x - r, y + r);
        const gy =
          L(x - r, y + r) + 2 * L(x, y + r) + L(x + r, y + r) -
          L(x - r, y - r) - 2 * L(x, y - r) - L(x + r, y - r);

        const mag = Math.hypot(gx, gy) / 4;
        if (mag < threshMod.at(x, y)) continue;

        // The gradient points across the edge; the tangent runs along it.
        const angle = p.follow ? Math.atan2(gy, gx) + Math.PI / 2 : 0;
        const glyph = p.byStrength
          ? chars[Math.min(last, Math.round(Math.min(1, mag) * last))]
          : chars[last];
        if (glyph === " ") continue;

        if (p.colorMode === "mono") {
          g.fillStyle = p.color;
        } else {
          const i = (Math.min(h - 1, y) * w + Math.min(w - 1, x)) * 4;
          if (lut) {
            const t = Math.round((luma(s[i], s[i + 1], s[i + 2]) / 255) * 255) * 3;
            g.fillStyle = `rgb(${lut[t]},${lut[t + 1]},${lut[t + 2]})`;
          } else {
            g.fillStyle = `rgb(${s[i]},${s[i + 1]},${s[i + 2]})`;
          }
        }

        if (angle) {
          g.save();
          g.translate(x, y);
          g.rotate(angle);
          g.fillText(glyph, 0, 0);
          g.restore();
        } else {
          g.fillText(glyph, x, y);
        }
      }
    }

    return bufFromImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
