import { bufFromImageData, regionAverage } from "../buffer.js";
import { luma, parseHex } from "../color.js";
import { curlAngle, noise2 } from "../rng.js";

/**
 * Halftone made of marks rather than dots — crosses, axes, ticks, characters.
 *
 * The difference from `dither` is orientation: every mark can rotate to follow
 * a curl-noise field, so the hatching flows around the forms in the image the
 * way an engraver's burin does, instead of sitting on a rigid grid. That is
 * what stops it reading as a Photoshop halftone.
 */
export default {
  id: "hatch",
  name: "Hatch",
  category: "halftone",
  feature: ["cellSize"],
  params: [
    {
      key: "mode",
      type: "select",
      label: "Mark",
      options: ["crosshatch", "cross", "plus", "tick", "ring", "chars"],
      default: "crosshatch",
    },
    { key: "chars", type: "text", label: "Characters", default: "·+x*#", showIf: (p) => p.mode === "chars" },
    { key: "cellSize", type: "range", label: "Cell size", min: 2, max: 60, step: 0.5, default: 10, unit: "u" },
    { key: "weight", type: "range", label: "Weight", min: 0.2, max: 8, step: 0.1, default: 1.2, unit: "u", mod: true },
    { key: "markScale", type: "range", label: "Mark size", min: 0.2, max: 2, step: 0.05, default: 0.9 },
    {
      key: "rotate",
      type: "select",
      label: "Orientation",
      options: ["curl", "none", "radial", "noise"],
      default: "curl",
    },
    { key: "flowScale", type: "range", label: "Flow scale", min: 10, max: 500, step: 5, default: 160, unit: "u" },
    { key: "levels", type: "range", label: "Levels", min: 2, max: 6, step: 1, default: 4, mod: true },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0, mod: true },
    { key: "invert", type: "toggle", label: "Invert", default: false },
    { key: "jitter", type: "range", label: "Jitter", min: 0, max: 1, step: 0.01, default: 0.15 },
    { key: "ink", type: "color", label: "Ink", default: "#0b0c10" },
    { key: "bg", type: "color", label: "Background", default: "#f4f1e8" },
    { key: "bgAlpha", type: "range", label: "Background alpha", min: 0, max: 1, step: 0.01, default: 1 },
  ],

  apply(ctx, src, p) {
    const cell = Math.max(2, ctx.u(p.cellSize));
    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);

    if (p.bgAlpha > 0) {
      const [br, bgc, bb] = parseHex(p.bg);
      g.fillStyle = `rgba(${br},${bgc},${bb},${p.bgAlpha})`;
      g.fillRect(0, 0, canvas.width, canvas.height);
    }

    g.strokeStyle = p.ink;
    g.fillStyle = p.ink;
    g.lineCap = "round";
    const weightMod = ctx.modPx("weight", p.weight);
    const levelsMod = ctx.mod("levels", p.levels);
    const contrastMod = ctx.mod("contrast", p.contrast);
    let lastWeight = -1;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `${cell * p.markScale * 1.4}px "JetBrains Mono", monospace`;

    const cols = Math.ceil(src.w / cell);
    const rows = Math.ceil(src.h / cell);
    const flowPx = ctx.u(p.flowScale);
    const avg = new Float32Array(4);
    const half = (cell * p.markScale) / 2;
    const cx0 = src.w / 2;
    const cy0 = src.h / 2;

    const stroke = (x, y, a, len) => {
      g.beginPath();
      g.moveTo(x - Math.cos(a) * len, y - Math.sin(a) * len);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let x = (c + 0.5) * cell;
        let y = (r + 0.5) * cell;

        regionAverage(src, x - cell / 2, y - cell / 2, x + cell / 2, y + cell / 2, avg);
        if (avg[3] < 8) continue;

        // Setting lineWidth invalidates canvas stroke state, so only touch it
        // when the modulated value actually moves.
        const wt = Math.max(0.4, weightMod.at(x, y));
        if (wt !== lastWeight) {
          g.lineWidth = wt;
          lastWeight = wt;
        }
        const levels = Math.max(2, Math.round(levelsMod.at(x, y)));
        const k = contrastMod.at(x, y) * 0.9;

        let t = luma(avg[0], avg[1], avg[2]) / 255;
        t = (t - 0.5) * (1 + k) + 0.5;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        // darkness drives mark density
        const dark = p.invert ? t : 1 - t;

        // Jitter from spatial noise, not from a call sequence — resolution safe.
        if (p.jitter > 0) {
          x += (noise2(c * 0.731, r * 0.917, ctx.noiseSeed) - 0.5) * cell * p.jitter;
          y += (noise2(c * 0.617, r * 0.833, ctx.noiseSeed + 51) - 0.5) * cell * p.jitter;
        }

        let base;
        switch (p.rotate) {
          case "none": base = 0; break;
          case "radial": base = Math.atan2(y - cy0, x - cx0) + Math.PI / 2; break;
          case "noise": base = noise2(x / flowPx, y / flowPx, ctx.noiseSeed) * Math.PI * 2; break;
          default: base = curlAngle(x, y, ctx.noiseSeed, flowPx);
        }

        const level = Math.round(dark * levels);
        if (level <= 0) continue;

        switch (p.mode) {
          case "crosshatch": {
            // Each darkness step adds another stroke direction, exactly as in
            // pen-and-ink hatching.
            for (let l = 0; l < level; l++) stroke(x, y, base + (l * Math.PI) / levels, half);
            break;
          }
          case "cross":
            stroke(x, y, base + Math.PI / 4, half * dark);
            stroke(x, y, base - Math.PI / 4, half * dark);
            break;
          case "plus":
            stroke(x, y, base, half * dark);
            stroke(x, y, base + Math.PI / 2, half * dark);
            break;
          case "tick":
            stroke(x, y, base, half * dark);
            break;
          case "ring":
            g.beginPath();
            g.arc(x, y, Math.max(0.3, half * dark), 0, Math.PI * 2);
            g.stroke();
            break;
          case "chars": {
            const set = p.chars || "·+x";
            const ch = set[Math.min(set.length - 1, Math.max(0, Math.round(dark * (set.length - 1))))];
            if (ch === " ") break;
            g.save();
            g.translate(x, y);
            g.rotate(base);
            g.fillText(ch, 0, 0);
            g.restore();
            break;
          }
        }
      }
    }

    return bufFromImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
