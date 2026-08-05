import { cloneBuf } from "../buffer.js";
import { luma, hueOf, saturationOf } from "../color.js";
import { curl } from "../rng.js";

/**
 * Pixel sorting along traced paths.
 *
 * Rows and columns are the usual thing. The mode that matters here is `flow`:
 * paths follow a curl-noise field, so sorted runs curve like water or smoke
 * instead of lying in hard horizontal bars. Sorting *along a streamline* rather
 * than a scanline is the whole difference between this reading as an image
 * that has been disturbed and one that has been filtered.
 *
 * Scale behaviour: seeds are spaced by the SSAA factor so a 4× supersampled
 * export starts the same density of streaks the preview would (the resolve
 * then keeps them). Run LENGTH is capped in artwork units, so streak geometry
 * stays compositionally stable across sizes.
 */

const KEYS = ["luma", "hue", "saturation", "red", "green", "blue"];

function keyValue(kind, r, g, b) {
  switch (kind) {
    case "hue": return hueOf(r, g, b) / 360;
    case "saturation": return saturationOf(r, g, b);
    case "red": return r / 255;
    case "green": return g / 255;
    case "blue": return b / 255;
    default: return luma(r, g, b) / 255;
  }
}

export default {
  id: "pixel-sort",
  name: "Pixel sort",
  category: "glitch",
  params: [
    {
      key: "direction",
      type: "select",
      label: "Direction",
      options: ["flow", "rows", "columns", "angle"],
      default: "flow",
    },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 6.283, step: 0.01, default: 0, showIf: (p) => p.direction === "angle" },
    { key: "flowScale", type: "range", label: "Flow scale", min: 10, max: 600, step: 5, default: 180, unit: "u", showIf: (p) => p.direction === "flow" },
    { key: "key", type: "select", label: "Sort by", options: KEYS, default: "luma" },
    { key: "gate", type: "select", label: "Gate on", options: KEYS, default: "luma" },
    { key: "low", type: "range", label: "Threshold low", min: 0, max: 1, step: 0.01, default: 0.25, mod: true },
    { key: "high", type: "range", label: "Threshold high", min: 0, max: 1, step: 0.01, default: 0.8, mod: true },
    { key: "maxRun", type: "range", label: "Max run", min: 2, max: 500, step: 1, default: 90, unit: "u", mod: true },
    { key: "minRun", type: "range", label: "Min run", min: 0, max: 100, step: 0.5, default: 3, unit: "u" },
    { key: "reverse", type: "toggle", label: "Reverse", default: false },
  ],

  apply(ctx, src, p) {
    const out = cloneBuf(src);
    const { w, h } = src;
    const d = out.data;
    const visited = new Uint8Array(w * h);
    // Run length is sampled once per path at its seed, so a mask can make
    // streaks long in one region and barely present in another. Buffers are
    // sized to the modulator's upper bound.
    const runMod = ctx.modPx("maxRun", p.maxRun);
    const lowMod = ctx.mod("low", p.low);
    const highMod = ctx.mod("high", p.high);
    const runCap = Math.max(2, Math.round(runMod.max));
    const minRun = Math.max(2, Math.round(ctx.u(p.minRun)));
    const flowPx = Math.max(4, ctx.u(p.flowScale));
    const flow = { x: 0, y: 0 };

    const fixedAngle =
      p.direction === "rows" ? 0 : p.direction === "columns" ? Math.PI / 2 : p.angle;
    const useFlow = p.direction === "flow";

    // Reused across paths to avoid millions of array allocations.
    const path = new Int32Array(runCap * 2 + 2);
    const keys = new Float64Array(runCap * 2 + 2);
    const gates = new Float64Array(runCap * 2 + 2);
    const order = new Int32Array(runCap * 2 + 2);
    const scratch = new Uint8Array((runCap * 2 + 2) * 4);
    // Seed stride tracks SSAA so export doesn't start 16× more paths than the
    // preview for the same composition. Paths still fill in between seeds.
    const seedStride = Math.max(1, Math.round(ctx.ssaa || 1));

    const trace = (sx, sy, dir, store, count, maxRun) => {
      let x = sx + 0.5;
      let y = sy + 0.5;
      let n = count;
      for (let step = 0; step < maxRun; step++) {
        let ax;
        let ay;
        if (useFlow) {
          curl(x, y, ctx.noiseSeed, flowPx, flow);
          ax = flow.x * dir;
          ay = flow.y * dir;
        } else {
          ax = Math.cos(fixedAngle) * dir;
          ay = Math.sin(fixedAngle) * dir;
        }
        x += ax;
        y += ay;
        const px = Math.floor(x);
        const py = Math.floor(y);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        const idx = py * w + px;
        if (visited[idx]) break;
        visited[idx] = 1;
        store[n++] = idx;
        if (n >= runCap * 2) break;
      }
      return n;
    };

    for (let sy = 0; sy < h; sy += seedStride) {
      for (let sx = 0; sx < w; sx += seedStride) {
        const seed = sy * w + sx;
        if (visited[seed]) continue;
        visited[seed] = 1;

        // Trace forward from the seed, then backward, then rotate so the path
        // runs in field order — done in-place (no slice allocations).
        const maxRun = Math.max(2, Math.min(runCap, Math.round(runMod.at(sx, sy))));
        path[0] = seed;
        let n = trace(sx, sy, 1, path, 1, maxRun);
        const forwardLen = n;
        n = trace(sx, sy, -1, path, n, maxRun);
        if (n > forwardLen) {
          // path is [seed, f1..fk, b1..bm]. Want [bm..b1, seed, f1..fk].
          // reverse all → [bm..b1, fk..f1, seed]; reverse the last forwardLen
          // → [bm..b1, seed, f1..fk]. No allocations.
          reverseRange(path, 0, n);
          reverseRange(path, n - forwardLen, n);
        }
        if (n < minRun) continue;

        for (let i = 0; i < n; i++) {
          const o = path[i] * 4;
          keys[i] = keyValue(p.key, d[o], d[o + 1], d[o + 2]);
          gates[i] = keyValue(p.gate, d[o], d[o + 1], d[o + 2]);
        }

        // Sort each contiguous run whose gate value falls inside the window.
        let runStart = -1;
        for (let i = 0; i <= n; i++) {
          const inside =
            i < n && gates[i] >= lowMod.atIndex(path[i]) && gates[i] <= highMod.atIndex(path[i]);
          if (inside && runStart < 0) runStart = i;
          if (!inside && runStart >= 0) {
            const len = i - runStart;
            if (len >= minRun) sortRun(d, path, keys, order, scratch, runStart, len, p.reverse);
            runStart = -1;
          }
        }
      }
    }

    return out;
  },
};

function reverseRange(arr, start, end) {
  let i = start;
  let j = end - 1;
  while (i < j) {
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
    i++;
    j--;
  }
}

function sortRun(data, path, keys, order, scratch, start, len, reverse) {
  for (let i = 0; i < len; i++) order[i] = start + i;
  const slice = order.subarray(0, len);
  slice.sort((a, b) => (reverse ? keys[b] - keys[a] : keys[a] - keys[b]));

  // Stash the run's pixels before overwriting — sources and destinations
  // overlap once the order changes.
  for (let i = 0; i < len; i++) {
    const o = path[slice[i]] * 4;
    scratch[i * 4] = data[o];
    scratch[i * 4 + 1] = data[o + 1];
    scratch[i * 4 + 2] = data[o + 2];
    scratch[i * 4 + 3] = data[o + 3];
  }
  for (let i = 0; i < len; i++) {
    const o = path[start + i] * 4;
    data[o] = scratch[i * 4];
    data[o + 1] = scratch[i * 4 + 1];
    data[o + 2] = scratch[i * 4 + 2];
    data[o + 3] = scratch[i * 4 + 3];
  }
}
