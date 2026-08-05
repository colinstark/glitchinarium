import { cloneBuf, createMask, sampleBilinear } from "../buffer.js";
import { noise2 } from "../rng.js";

/**
 * Compression and codec failure.
 *
 *   blocks    macroblocks displaced by a noise field
 *   smear     blocks propagate along a drift direction, the frozen-P-frame
 *             look where motion vectors keep applying to a stale reference
 *   dct       genuine 8x8 DCT with an aggressive quantisation table, so you get
 *             real ringing and mosquito noise rather than a fake blur
 *   rowshift  horizontal band displacement with channel corruption
 *
 * Whatever the mode, the layer also publishes a mask of the regions it
 * disturbed (`Emit mask`). Point an ASCII or hatch layer at that mask and the
 * glyphs appear exactly where the image broke — the codec picks the composition
 * rather than you drawing a selection.
 */

// --- 8x8 DCT ---------------------------------------------------------------
const COS = new Float32Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}
const C = new Float32Array(8).fill(1);
C[0] = Math.SQRT1_2;

// Standard JPEG luminance quantisation table.
const QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/**
 * Scratch for dctQuantIdct. Module-level is safe: the transform is synchronous
 * and never re-entered, and a small block size schedules hundreds of thousands
 * of calls per export — allocating two 64-float arrays inside each one was
 * millions of allocations.
 */
const _dctTmp = new Float32Array(64);
const _dctFreq = new Float32Array(64);

/**
 * Forward DCT → quantise → inverse, in place on an 8x8 block.
 *
 * Done separably (rows, then columns). The direct 2-D form is O(n⁴) per pass —
 * ~8k multiplies a block, which at a fine block size turns an export into
 * minutes of frozen tab. Four 8x8x8 passes is ~4x cheaper and identical output.
 */
function dctQuantIdct(block, qScale) {
  const tmp = _dctTmp;
  const freq = _dctFreq;

  // Forward, y → v (rows of the [x][y] layout), then x → u.
  for (let x = 0; x < 8; x++) {
    const row = x * 8;
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += block[row + y] * COS[y * 8 + v];
      tmp[row + v] = sum;
    }
  }
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += tmp[x * 8 + v] * COS[x * 8 + u];
      const q = QUANT[u * 8 + v] * qScale;
      const coef = 0.25 * C[u] * C[v] * sum;
      // Fold C[u]*C[v] back in here so the inverse passes stay bare sums.
      freq[u * 8 + v] = Math.round(coef / q) * q * C[u] * C[v];
    }
  }

  // Inverse, v → y then u → x.
  for (let u = 0; u < 8; u++) {
    const row = u * 8;
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += freq[row + v] * COS[y * 8 + v];
      tmp[row + y] = sum;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += tmp[u * 8 + y] * COS[x * 8 + u];
      block[x * 8 + y] = 0.25 * sum;
    }
  }
}

export default {
  id: "datamosh",
  name: "Datamosh",
  category: "glitch",
  emitsMask: (p) => !!p.emitMask,
  params: [
    { key: "mode", type: "select", label: "Mode", options: ["smear", "blocks", "dct", "rowshift"], default: "smear" },
    { key: "blockSize", type: "range", label: "Block size", min: 2, max: 160, step: 1, default: 26, unit: "u" },
    { key: "amount", type: "range", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.4, mod: true },
    { key: "drift", type: "range", label: "Drift", min: 0, max: 200, step: 0.5, default: 30, unit: "u", mod: true },
    { key: "angle", type: "range", label: "Drift angle", min: 0, max: 6.283, step: 0.01, default: 0 },
    { key: "fieldScale", type: "range", label: "Field scale", min: 1, max: 40, step: 0.5, default: 6, hint: "blocks per noise feature" },
    { key: "quality", type: "range", label: "Quality", min: 0.02, max: 3, step: 0.01, default: 0.35, showIf: (p) => p.mode === "dct" },
    { key: "emitMask", type: "toggle", label: "Emit mask", default: true },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const { w, h } = src;
    const d = out.data;
    const s = src.data;
    const block = Math.max(2, Math.round(ctx.u(p.blockSize)));
    // Sampled at each block's centre, so a painted mask can decide which
    // regions rot and how far they smear.
    const amountMod = ctx.mod("amount", p.amount);
    const driftMod = ctx.modPx("drift", p.drift);
    const cols = Math.ceil(w / block);
    const rows = Math.ceil(h / block);
    const fs = Math.max(0.5, p.fieldScale);
    const mask = p.emitMask ? createMask(w, h) : null;
    const dirX = Math.cos(p.angle);
    const dirY = Math.sin(p.angle);
    const px = new Float32Array(4);
    // Hoisted: dct mode refills this for every block and channel.
    const cell = new Float32Array(64);

    const markBlock = (bx, by, v) => {
      if (!mask) return;
      const x0 = bx * block;
      const y0 = by * block;
      const x1 = Math.min(w, x0 + block);
      const y1 = Math.min(h, y0 + block);
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) mask.data[row + x] = v;
      }
    };

    if (p.mode === "rowshift") {
      for (let by = 0; by < rows; by++) {
        const n = noise2(by / fs, ctx.layerIndex * 3.7, ctx.noiseSeed);
        const rowY = by * block + block / 2;
        if (n > 1 - amountMod.at(w / 2, rowY)) {
          const drift = driftMod.at(w / 2, rowY);
          const shift = Math.round((noise2(by / fs, 41.3, ctx.noiseSeed) - 0.5) * 2 * drift);
          const swap = noise2(by / fs, 77.1, ctx.noiseSeed) > 0.7;
          const y0 = by * block;
          const y1 = Math.min(h, y0 + block);
          for (let y = y0; y < y1; y++) {
            for (let x = 0; x < w; x++) {
              let sx = x - shift;
              sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx;
              const o = (y * w + x) * 4;
              const i = (y * w + sx) * 4;
              if (swap) {
                d[o] = s[i + 2];
                d[o + 1] = s[i];
                d[o + 2] = s[i + 1];
              } else {
                d[o] = s[i];
                d[o + 1] = s[i + 1];
                d[o + 2] = s[i + 2];
              }
              if (mask) mask.data[y * w + x] = 1;
            }
          }
        }
      }
      if (mask) ctx.masks.set(ctx.layerId, mask);
      return out;
    }

    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        // Per-block decisions come from a spatial noise field indexed by block
        // coordinates. Block coords derive from an artwork-unit size, so the
        // same blocks break at every render resolution.
        const n = noise2(bx / fs, by / fs, ctx.noiseSeed);
        const x0 = bx * block;
        const y0 = by * block;
        const x1 = Math.min(w, x0 + block);
        const y1 = Math.min(h, y0 + block);
        const mx = x0 + block / 2;
        const my = y0 + block / 2;
        const amount = amountMod.at(mx, my);

        if (p.mode === "dct") {
          const strength = 1 + (1 - p.quality) * 40 * (0.4 + n * amount);
          for (let c = 0; c < 3; c++) {
            const cw = (x1 - x0) / 8;
            const ch = (y1 - y0) / 8;
            for (let u = 0; u < 8; u++) {
              for (let v = 0; v < 8; v++) {
                // average the sub-cell so the artifact scale tracks blockSize
                let sum = 0;
                let cnt = 0;
                for (let y = Math.floor(y0 + v * ch); y < Math.min(y1, y0 + (v + 1) * ch); y++) {
                  for (let x = Math.floor(x0 + u * cw); x < Math.min(x1, x0 + (u + 1) * cw); x++) {
                    sum += s[(y * w + x) * 4 + c];
                    cnt++;
                  }
                }
                cell[u * 8 + v] = (cnt ? sum / cnt : 0) - 128;
              }
            }
            dctQuantIdct(cell, strength);
            for (let y = y0; y < y1; y++) {
              const v = Math.min(7, Math.floor(((y - y0) / (y1 - y0)) * 8));
              for (let x = x0; x < x1; x++) {
                const u = Math.min(7, Math.floor(((x - x0) / (x1 - x0)) * 8));
                d[(y * w + x) * 4 + c] = cell[u * 8 + v] + 128;
              }
            }
          }
          markBlock(bx, by, Math.min(1, (1 - p.quality) * (0.4 + n)));
          continue;
        }

        if (n <= 1 - amount) continue;

        const mag = driftMod.at(mx, my) * (0.3 + n);
        const ox = dirX * mag + (noise2(bx / fs, by / fs, ctx.noiseSeed + 313) - 0.5) * mag;
        const oy = dirY * mag + (noise2(bx / fs, by / fs, ctx.noiseSeed + 977) - 0.5) * mag;

        // `smear` reads from the output buffer, so a displaced block can be
        // re-displaced by its neighbour and the corruption propagates.
        const readFrom = p.mode === "smear" ? out : src;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            sampleBilinear(readFrom, x - ox, y - oy, px, "clamp");
            const o = (y * w + x) * 4;
            d[o] = px[0];
            d[o + 1] = px[1];
            d[o + 2] = px[2];
            d[o + 3] = px[3];
          }
        }
        markBlock(bx, by, 1);
      }
    }

    if (mask) ctx.masks.set(ctx.layerId, mask);
    return out;
  },
};
