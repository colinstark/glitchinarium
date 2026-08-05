import { bufFromImageData } from "../buffer.js";
import { luma, buildRamp, PALETTES, PALETTE_NAMES } from "../color.js";
import { jitteredPoints, pointRandom, noise2, curlAngle } from "../rng.js";

/**
 * Sparse scattered marks.
 *
 * Loose annotation chips (arrows, bullets, brackets) scattered the way hand
 * marks sit on a collage — not a grid and not a fill. Placement is a blue-noise
 * distribution thinned by a noise field so they clump and gap.
 *
 * Point placement uses a jittered grid whose spacing is in artwork units, so
 * the same symbols land in the same places at any render size.
 */

export const SYMBOL_SETS = {
  arrows: "→←↑↓↗↘⇢⇠",
  marks: "•◦×+·∘⁘⁙",
  brackets: "[]{}()⟨⟩",
  blocks: "▘▝▖▗▚▞█▄",
  digits: "0123456789",
  letters: "AZXYWQKM",
};

export default {
  id: "symbol-scatter",
  name: "Scatter",
  category: "glyph",
  params: [
    {
      key: "set",
      type: "select",
      label: "Symbols",
      options: [...Object.keys(SYMBOL_SETS), "custom"],
      default: "marks",
    },
    { key: "customChars", type: "text", label: "Characters", default: "•×+·", showIf: (p) => p.set === "custom" },
    { key: "spacing", type: "range", label: "Spacing", min: 4, max: 200, step: 1, default: 34, unit: "u" },
    { key: "density", type: "range", label: "Density", min: 0, max: 1, step: 0.01, default: 0.35, mod: true },
    { key: "size", type: "range", label: "Size", min: 2, max: 120, step: 0.5, default: 16, unit: "u", mod: true },
    { key: "sizeJitter", type: "range", label: "Size jitter", min: 0, max: 1, step: 0.01, default: 0.4 },
    { key: "clump", type: "range", label: "Clumping", min: 0, max: 400, step: 5, default: 120, unit: "u", hint: "scale of the field that thins the scatter — 0 for even spread" },
    {
      key: "bias",
      type: "select",
      label: "Prefer",
      options: ["none", "dark", "light"],
      default: "none",
      hint: "steer marks toward one end of the tonal range",
    },
    {
      key: "rotate",
      type: "select",
      label: "Rotation",
      options: ["none", "random", "curl"],
      default: "none",
    },
    {
      key: "colorMode",
      type: "select",
      label: "Colour",
      options: ["mono", "ramp", "source"],
      default: "mono",
    },
    { key: "color", type: "color", label: "Colour", default: "#c8ff2e", showIf: (p) => p.colorMode === "mono" },
    { key: "palette", type: "select", label: "Ramp", options: PALETTE_NAMES, default: "sunset-sea", showIf: (p) => p.colorMode === "ramp" },
    { key: "font", type: "font", label: "Font", options: ["JetBrains Mono", "IBM Plex Mono", "Press Start 2P", "monospace"], default: "JetBrains Mono" },
    { key: "weight", type: "select", label: "Weight", options: ["400", "500", "700"], default: "700" },
  ],

  apply(ctx, src, p) {
    const chars =
      p.set === "custom" ? p.customChars || "+" : SYMBOL_SETS[p.set] || SYMBOL_SETS.marks;
    if (!chars?.length) return null;

    const { w, h } = src;
    const s = src.data;
    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.textAlign = "center";
    g.textBaseline = "middle";

    const spacing = Math.max(4, ctx.u(p.spacing));
    const pts = jitteredPoints(w, h, spacing, ctx.noiseSeed, 0.9);
    const densityMod = ctx.mod("density", p.density);
    const sizeMod = ctx.modPx("size", p.size);
    const clump = ctx.u(p.clump);
    const lut = p.colorMode === "ramp" ? buildRamp(PALETTES[p.palette] ?? PALETTES.duotone) : null;
    const family = /\s/.test(p.font) ? `"${p.font}", monospace` : `${p.font}, monospace`;

    let lastSize = -1;
    for (const pt of pts) {
      const x = pt.x;
      const y = pt.y;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;

      // Two gates: a per-point random against density, and a smooth field that
      // makes the survivors clump rather than spread evenly.
      const roll = pointRandom(pt, ctx.noiseSeed + 3);
      let keep = densityMod.at(x, y);
      if (clump > 1) keep *= 0.35 + 1.3 * noise2(x / clump, y / clump, ctx.noiseSeed + 61);

      const i = (Math.floor(y) * w + Math.floor(x)) * 4;
      const l = luma(s[i], s[i + 1], s[i + 2]) / 255;
      if (p.bias === "dark") keep *= 1 - l;
      else if (p.bias === "light") keep *= l;

      if (roll > keep) continue;

      const jitter = 1 + (pointRandom(pt, ctx.noiseSeed + 17) - 0.5) * 2 * p.sizeJitter;
      const size = Math.max(2, Math.round(sizeMod.at(x, y) * jitter));
      if (size !== lastSize) {
        g.font = `${p.weight} ${size}px ${family}`;
        lastSize = size;
      }

      const glyph = chars[Math.floor(pointRandom(pt, ctx.noiseSeed + 29) * chars.length) % chars.length];

      if (p.colorMode === "mono") {
        g.fillStyle = p.color;
      } else if (lut) {
        const t = Math.round(l * 255) * 3;
        g.fillStyle = `rgb(${lut[t]},${lut[t + 1]},${lut[t + 2]})`;
      } else {
        g.fillStyle = `rgb(${s[i]},${s[i + 1]},${s[i + 2]})`;
      }

      let angle = 0;
      if (p.rotate === "random") angle = pointRandom(pt, ctx.noiseSeed + 43) * Math.PI * 2;
      else if (p.rotate === "curl") angle = curlAngle(x, y, ctx.noiseSeed, Math.max(20, clump || 150));

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

    return bufFromImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
