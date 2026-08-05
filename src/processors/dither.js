import { createBuf, regionAverage } from "../buffer.js";
import { luma, buildRamp, parseHex, clamp255 } from "../color.js";
import { noise2 } from "../rng.js";
import { BAYER, bayerAt } from "../patterns.js";
import { subdivideCells, densityProbe } from "../quadtree.js";

/**
 * Chunky quantisation — the Mac OS 9 / early-web look.
 *
 * The image is first reduced to a grid of blocks (block size in artwork units,
 * so the chunkiness is identical at preview and export), dithered AT BLOCK
 * RESOLUTION, then expanded back as hard squares. Diffusing error at full pixel
 * resolution and then blocking it would just average the dither away.
 *
 * `crisp` snaps the block to a multiple of the SSAA resolve factor so the hard
 * edges survive the downsample instead of turning to grey mush.
 */

const ORDERED = { bayer2: BAYER[2], bayer4: BAYER[4], bayer8: BAYER[8] };

/**
 * Variable-chunkiness dithering: the block grid becomes a quadtree driven by a
 * mask, so a painted gradient makes the image coarsely blocky in one region and
 * finely stippled in another — the shifting block scale seen across the castle
 * and holly references.
 */
function adaptive(ctx, src, p, block, probe, contrastMod, biasMod) {
  const out = createBuf(src.w, src.h);
  const d = out.data;
  const s = src.data;
  const steps = p.levels - 1;
  const quant = (v) => Math.max(0, Math.min(1, Math.round(Math.max(0, Math.min(1, v)) * steps) / steps));
  const tmp = new Float32Array(4);
  const mono = p.colorMode !== "rgb";

  let lut = null;
  if (p.colorMode === "duotone") lut = buildRamp([{ pos: 0, color: p.ink }, { pos: 1, color: p.paper }]);
  const inkRGB = parseHex(p.ink);
  const paperRGB = parseHex(p.paper);

  subdivideCells(src.w, src.h, block, block, p.subdivide, probe, (x0, y0, cw, ch) => {
    regionAverage(src, x0, y0, x0 + cw, y0 + ch, tmp);
    const mx = x0 + cw / 2;
    const my = y0 + ch / 2;
    const k = contrastMod.at(mx, my) * 0.9;
    const bias = biasMod.at(mx, my);

    // Threshold coordinates come from the cell's position on ITS OWN level's
    // lattice, so neighbouring cells of different sizes still interlock.
    const cxi = Math.floor(x0 / cw);
    const cyi = Math.floor(y0 / ch);
    const t = p.method === "noise"
      ? noise2(cxi * 0.9137, cyi * 0.7391, ctx.noiseSeed) - 0.5
      : bayerAt(cxi, cyi, p.method === "bayer2" ? 2 : p.method === "bayer4" ? 4 : 8) - 0.5;

    const px1 = Math.min(src.w, Math.ceil(x0 + cw));
    const py1 = Math.min(src.h, Math.ceil(y0 + ch));
    const px0 = Math.max(0, Math.floor(x0));
    const py0 = Math.max(0, Math.floor(y0));

    if (mono) {
      const v = quant((luma(tmp[0], tmp[1], tmp[2]) / 255 - 0.5) * (1 + k) + 0.5 + bias + t / steps);
      let r; let g; let b;
      if (lut) {
        const i = Math.round(v * 255) * 3;
        r = lut[i]; g = lut[i + 1]; b = lut[i + 2];
      } else {
        r = inkRGB[0] + (paperRGB[0] - inkRGB[0]) * v;
        g = inkRGB[1] + (paperRGB[1] - inkRGB[1]) * v;
        b = inkRGB[2] + (paperRGB[2] - inkRGB[2]) * v;
      }
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          const i = (y * src.w + x) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
        }
      }
    } else {
      const c0 = quant((tmp[0] / 255 - 0.5) * (1 + k) + 0.5 + bias + t / steps) * 255;
      const c1 = quant((tmp[1] / 255 - 0.5) * (1 + k) + 0.5 + bias + t / steps) * 255;
      const c2 = quant((tmp[2] / 255 - 0.5) * (1 + k) + 0.5 + bias + t / steps) * 255;
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          const i = (y * src.w + x) * 4;
          d[i] = c0; d[i + 1] = c1; d[i + 2] = c2; d[i + 3] = s[i + 3];
        }
      }
    }
  });

  return out;
}

const DIFFUSION = {
  // [dx, dy, weight] — Atkinson deliberately loses 2/8 of the error, which is
  // what crushes the midtones into that high-contrast classic-Mac look.
  atkinson: { div: 8, taps: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]] },
  floyd: { div: 16, taps: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]] },
};

export default {
  id: "dither",
  name: "Dither",
  category: "halftone",
  feature: ["blockSize"],
  params: [
    {
      key: "method",
      type: "select",
      label: "Method",
      options: ["atkinson", "floyd", "bayer2", "bayer4", "bayer8", "noise"],
      default: "atkinson",
      hint: "atkinson/floyd diffuse error, so the export reproduces the preview's tone and block grid but not its exact speckle; bayer/noise are pixel-stable across scales",
    },
    { key: "blockSize", type: "range", label: "Block size", min: 1, max: 40, step: 0.5, default: 5, unit: "u" },
    {
      key: "subdivide",
      type: "range",
      label: "Subdivide",
      min: 0,
      max: 3,
      step: 1,
      default: 0,
      mod: true,
      hint: "bind a mask to vary block size by region; ordered methods only — error diffusion needs a uniform grid",
    },
    { key: "levels", type: "range", label: "Levels", min: 2, max: 8, step: 1, default: 2 },
    {
      key: "colorMode",
      type: "select",
      label: "Colour",
      options: ["mono", "rgb", "duotone"],
      default: "mono",
    },
    { key: "ink", type: "color", label: "Ink", default: "#0b0c10", showIf: (p) => p.colorMode !== "rgb" },
    { key: "paper", type: "color", label: "Paper", default: "#f4f1e8", showIf: (p) => p.colorMode !== "rgb" },
    { key: "contrast", type: "range", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0, mod: true },
    { key: "bias", type: "range", label: "Bias", min: -0.5, max: 0.5, step: 0.01, default: 0, mod: true },
    { key: "crisp", type: "toggle", label: "Crisp", default: true, hint: "Keep hard edges through export" },
  ],

  apply(ctx, src, p) {
    let block = ctx.u(p.blockSize);
    if (p.crisp) block = ctx.snap(block);
    block = Math.max(1, block);

    const contrastMod = ctx.mod("contrast", p.contrast);
    const biasMod = ctx.mod("bias", p.bias);

    // Error diffusion needs a uniform neighbour grid to push error into, so the
    // adaptive path is ordered-only. Contrast and bias modulate either way,
    // which is the other half of "how heavy the dithering is".
    const probe = densityProbe(ctx, "subdivide");
    if (probe && p.subdivide > 0 && !DIFFUSION[p.method]) {
      return adaptive(ctx, src, p, block, probe, contrastMod, biasMod);
    }

    const cols = Math.max(1, Math.ceil(src.w / block));
    const rows = Math.max(1, Math.ceil(src.h / block));
    const nCh = p.colorMode === "rgb" ? 3 : 1;

    // --- reduce to blocks ---
    const grid = new Float32Array(cols * rows * nCh);
    const tmp = new Float32Array(4);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        regionAverage(src, c * block, r * block, (c + 1) * block, (r + 1) * block, tmp);
        const gi = (r * cols + c) * nCh;
        const mx = (c + 0.5) * block;
        const my = (r + 0.5) * block;
        const k = contrastMod.at(mx, my) * 0.9;
        const bias = biasMod.at(mx, my);
        if (nCh === 1) {
          const v = luma(tmp[0], tmp[1], tmp[2]) / 255;
          grid[gi] = (v - 0.5) * (1 + k) + 0.5 + bias;
        } else {
          for (let ch = 0; ch < 3; ch++) {
            const v = tmp[ch] / 255;
            grid[gi + ch] = (v - 0.5) * (1 + k) + 0.5 + bias;
          }
        }
      }
    }

    // --- dither at block resolution ---
    const steps = p.levels - 1;
    const quant = (v) => Math.max(0, Math.min(1, Math.round(Math.max(0, Math.min(1, v)) * steps) / steps));
    const diff = DIFFUSION[p.method];
    const bayer = ORDERED[p.method];

    if (diff) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const gi = (r * cols + c) * nCh;
          for (let ch = 0; ch < nCh; ch++) {
            const old = grid[gi + ch];
            const nv = quant(old);
            grid[gi + ch] = nv;
            const err = old - nv;
            for (const [dx, dy, wt] of diff.taps) {
              const nc = c + dx;
              const nr = r + dy;
              if (nc < 0 || nc >= cols || nr >= rows) continue;
              grid[(nr * cols + nc) * nCh + ch] += (err * wt) / diff.div;
            }
          }
        }
      }
    } else {
      const size = bayer ? bayer.length : 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const gi = (r * cols + c) * nCh;
          // Threshold offset comes from the block's own coordinates, never from
          // a call-order rng — that is what keeps preview and export identical.
          const t = bayer
            ? (bayer[r % size][c % size] + 0.5) / (size * size) - 0.5
            : noise2(c * 0.9137, r * 0.7391, ctx.noiseSeed) - 0.5;
          for (let ch = 0; ch < nCh; ch++) {
            grid[gi + ch] = quant(grid[gi + ch] + t / steps);
          }
        }
      }
    }

    // --- expand back to pixels ---
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const s = src.data;

    let lut = null;
    if (p.colorMode === "duotone") lut = buildRamp([{ pos: 0, color: p.ink }, { pos: 1, color: p.paper }]);
    const inkRGB = parseHex(p.ink);
    const paperRGB = parseHex(p.paper);

    for (let y = 0; y < src.h; y++) {
      const r = Math.min(rows - 1, Math.floor(y / block));
      for (let x = 0; x < src.w; x++) {
        const c = Math.min(cols - 1, Math.floor(x / block));
        const gi = (r * cols + c) * nCh;
        const i = (y * src.w + x) * 4;

        if (nCh === 3) {
          d[i] = clamp255(grid[gi] * 255);
          d[i + 1] = clamp255(grid[gi + 1] * 255);
          d[i + 2] = clamp255(grid[gi + 2] * 255);
        } else {
          const v = grid[gi];
          if (lut) {
            const idx = Math.round(Math.max(0, Math.min(1, v)) * 255) * 3;
            d[i] = lut[idx];
            d[i + 1] = lut[idx + 1];
            d[i + 2] = lut[idx + 2];
          } else {
            d[i] = inkRGB[0] + (paperRGB[0] - inkRGB[0]) * v;
            d[i + 1] = inkRGB[1] + (paperRGB[1] - inkRGB[1]) * v;
            d[i + 2] = inkRGB[2] + (paperRGB[2] - inkRGB[2]) * v;
          }
        }
        d[i + 3] = s[i + 3];
      }
    }
    return out;
  },
};
