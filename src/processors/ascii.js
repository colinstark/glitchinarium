import { bufFromOwnedImageData, regionAverage } from "../buffer.js";
import { luma, buildRamp, PALETTES, PALETTE_NAMES, parseHex } from "../color.js";
import { curlAngle, noise2 } from "../rng.js";
import { phyllotaxisPoints } from "../geometry.js";
import { subdivideCells, densityProbe } from "../quadtree.js";

/**
 * ASCII rendering.
 *
 * `columns` is inherently scale-free — it is a count across the image width —
 * so the glyph grid is identical at preview and export by construction; the
 * export just rasterises each glyph with 4x the detail.
 *
 * Placement modes are where this stops being a plain ASCII filter:
 *   grid         classic rows and columns
 *   flow         glyphs rotate to follow a curl-noise field, so text wraps
 *                around forms the way hatching does in an engraving
 *   phyllotaxis  glyphs sit on golden-angle seed packing — sunflower spiral
 *
 * Combine any of them with a mask and you get the reference still life: ASCII
 * erupting only in ragged patches over an otherwise untouched painting.
 */

export const CHARSETS = {
  default: " .:-=+*#%@",
  dense: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  minimal: " .:*#",
  blocks: " ░▒▓█",
  horizontal: " ▁▂▃▄▅▆▇█",
  vertical: " ▏▎▍▌▋▊▉█",
  letters: " ZYXWVUTSRQPONMLKJIHGFEDCBA",
  digits: " 0123456789",
  arcs: " ·⌒◜◝◞◟○◍◉●",
};

export const FONTS = [
  "JetBrains Mono",
  "Press Start 2P",
  "IBM Plex Mono",
  "Courier New",
  "monospace",
];

/** Registered by the font-upload control in ui/controls.js. */
export const customFonts = new Set();

export default {
  id: "ascii",
  name: "ASCII",
  category: "glyph",
  params: [
    { key: "columns", type: "range", label: "Columns", min: 12, max: 400, step: 1, default: 110 },
    {
      key: "subdivide",
      type: "range",
      label: "Subdivide",
      min: 0,
      max: 3,
      step: 1,
      default: 0,
      mod: true,
      hint: "bind a mask here and its grey level drives how fine the glyph grid gets — each step halves the cell",
    },
    { key: "cellRatio", type: "range", label: "Cell ratio", min: 0.4, max: 3, step: 0.05, default: 2 },
    {
      key: "charset",
      type: "select",
      label: "Charset",
      options: [...Object.keys(CHARSETS), "custom"],
      default: "default",
    },
    { key: "customChars", type: "text", label: "Characters", default: " .:-=+*#%@", showIf: (p) => p.charset === "custom" },
    { key: "font", type: "font", label: "Font", options: FONTS, default: "JetBrains Mono" },
    { key: "fontScale", type: "range", label: "Glyph size", min: 0.3, max: 2, step: 0.05, default: 1 },
    { key: "invert", type: "toggle", label: "Invert", default: false },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0, mod: true },
    {
      key: "placement",
      type: "select",
      label: "Placement",
      options: ["grid", "flow", "phyllotaxis"],
      default: "grid",
    },
    { key: "flowScale", type: "range", label: "Flow scale", min: 10, max: 500, step: 5, default: 140, unit: "u", showIf: (p) => p.placement === "flow" },
    { key: "jitter", type: "range", label: "Jitter", min: 0, max: 1, step: 0.01, default: 0, showIf: (p) => p.placement !== "grid" },
    {
      key: "colorMode",
      type: "select",
      label: "Glyph colour",
      options: ["mono", "source", "ramp"],
      default: "source",
    },
    { key: "color", type: "color", label: "Colour", default: "#0b0c10", showIf: (p) => p.colorMode === "mono" },
    {
      key: "palette",
      type: "select",
      label: "Ramp",
      options: PALETTE_NAMES,
      default: "sunset-sea",
      showIf: (p) => p.colorMode === "ramp",
    },
    { key: "bg", type: "color", label: "Background", default: "#f6e6cd" },
    { key: "bgAlpha", type: "range", label: "Background alpha", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "crisp", type: "toggle", label: "Snap to pixel grid", default: false },
  ],

  apply(ctx, src, p) {
    const chars = p.charset === "custom" ? p.customChars || " ." : CHARSETS[p.charset];
    if (!chars.length) return null;

    let cellW = src.w / p.columns;
    if (p.crisp) cellW = ctx.snap(cellW);
    const cellH = Math.max(1, cellW * p.cellRatio);
    cellW = Math.max(1, cellW);

    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);

    if (p.bgAlpha > 0) {
      const [br, bg_, bb] = parseHex(p.bg);
      g.fillStyle = `rgba(${br},${bg_},${bb},${p.bgAlpha})`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }

    g.textAlign = "center";
    g.textBaseline = "middle";
    const family = /\s/.test(p.font) ? `"${p.font}", monospace` : `${p.font}, monospace`;

    // Cells vary in size once subdivision kicks in, but only across a handful
    // of discrete depths — re-parsing the font string per glyph would dominate
    // the render, so only set it when the size actually changes.
    let lastFont = -1;
    const useFontSize = (px) => {
      if (px !== lastFont) {
        g.font = `${px}px ${family}`;
        lastFont = px;
      }
    };

    const lut = p.colorMode === "ramp" ? buildRamp(PALETTES[p.palette] ?? PALETTES.duotone) : null;
    const monoColor = p.colorMode === "mono" ? p.color : null;
    const contrastMod = ctx.mod("contrast", p.contrast);
    const avg = new Float32Array(4);
    const last = chars.length - 1;

    const drawGlyph = (cx, cy, cw, ch, angle) => {
      regionAverage(src, cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2, avg);
      if (avg[3] < 8) return;

      useFontSize(ch * p.fontScale);
      const k = contrastMod.at(cx, cy) * 0.9;

      let t = luma(avg[0], avg[1], avg[2]) / 255;
      t = (t - 0.5) * (1 + k) + 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const shade = p.invert ? 1 - t : t;
      const glyph = chars[Math.round(shade * last)];
      if (glyph === " ") return;

      if (monoColor) {
        g.fillStyle = monoColor;
      } else if (lut) {
        const i = Math.round(t * 255) * 3;
        g.fillStyle = `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
      } else {
        g.fillStyle = `rgb(${avg[0] | 0},${avg[1] | 0},${avg[2] | 0})`;
      }

      if (angle) {
        g.save();
        g.translate(cx, cy);
        g.rotate(angle);
        g.fillText(glyph, 0, 0);
        g.restore();
      } else {
        g.fillText(glyph, cx, cy);
      }
    };

    if (p.placement === "phyllotaxis") {
      // Cover the whole frame: the seed at index i sits at radius spacing·√i,
      // so reaching the far corner takes (R / spacing)² seeds.
      const spacing = Math.sqrt(cellW * cellH);
      const cx = src.w / 2;
      const cy = src.h / 2;
      const R = Math.hypot(src.w, src.h) / 2;
      // Cap by canvas area (~1 glyph per cell) so a fine grid at 4× export
      // cannot schedule hundreds of thousands of fillText calls.
      const areaCap = Math.ceil((src.w / Math.max(1, cellW)) * (src.h / Math.max(1, cellH)) * 1.15);
      const count = Math.min(80000, areaCap, Math.ceil((R / spacing) ** 2));
      const pts = phyllotaxisPoints(count, spacing);
      for (const pt of pts) {
        let x = cx + pt.x;
        let y = cy + pt.y;
        if (p.jitter > 0) {
          x += (noise2(pt.x / 40, pt.y / 40, ctx.noiseSeed) - 0.5) * spacing * p.jitter;
          y += (noise2(pt.x / 40, pt.y / 40, ctx.noiseSeed + 99) - 0.5) * spacing * p.jitter;
        }
        if (x < -cellW || y < -cellH || x > src.w + cellW || y > src.h + cellH) continue;
        drawGlyph(x, y, cellW, cellH, pt.theta % (Math.PI * 2));
      }
    } else {
      const flow = p.placement === "flow";
      const flowPx = ctx.u(p.flowScale);

      // With a mask bound to `subdivide` the grid becomes a quadtree: coarse
      // cells where the mask is dark, split down to fine ones where it is
      // bright. Unbound, the probe is null and this is a plain uniform grid.
      const probe = densityProbe(ctx, "subdivide");
      const maxDepth = probe ? p.subdivide : 0;

      subdivideCells(src.w, src.h, cellW, cellH, maxDepth, probe ?? (() => 0), (cx0, cy0, cw, ch) => {
        let x = cx0 + cw / 2;
        let y = cy0 + ch / 2;
        let angle = 0;
        if (flow) {
          angle = curlAngle(x, y, ctx.noiseSeed, flowPx);
          if (p.jitter > 0) {
            x += Math.cos(angle) * cw * p.jitter * 0.5;
            y += Math.sin(angle) * ch * p.jitter * 0.5;
          }
        }
        drawGlyph(x, y, cw, ch, angle);
      });
    }

    return bufFromOwnedImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
