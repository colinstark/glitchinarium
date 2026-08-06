/**
 * Content-aware brush reach.
 *
 * The paint brush stamps a circle, which knows nothing about the picture under
 * it: masking a house means dabbing its silhouette by hand, and every stamp
 * bleeds across the roofline into the sky. This module supplies the two pieces
 * that let brush radius mean REACH instead of RADIUS —
 *
 *   buildGuide()     per-pixel "how expensive is it to walk through here",
 *                    derived from local contrast in luma and colour;
 *   geodesicFlood()  shortest-path distance from a stroke's polyline under
 *                    that cost, bounded to the reach.
 *
 * Where the cost is flat, geodesic distance IS Euclidean distance and the
 * result is the disc the brush already draws. Where an edge cuts across, paths
 * have to pay to cross it, so paint runs along the wall and stops at the sky.
 *
 * Both are plain typed-array sweeps: no priority queue, no allocation per
 * stamp, and every radius is taken in artwork units so the same stroke means
 * the same thing at 540px and at 8192px.
 */

import { boxDownsample, blurMask } from "./buffer.js";
import { luma } from "./color.js";

/**
 * Cells the guide and the flood are allowed to work over. Reach is in artwork
 * units, so a 300u brush at an 8192px export would otherwise flood ~50M cells
 * and hang the download. Above this budget the guide is decimated and the
 * DISTANCE field is upsampled back — distances interpolate cleanly, so the
 * mask boundary stays crisp; only the falloff is evaluated at full resolution.
 */
const WORK_BUDGET_PX = 1_600_000;

/**
 * Blur applied to the guide planes before differencing, in artwork units.
 * This is what keeps the guide approximately scale-consistent: it removes the
 * fine grain that only exists at export resolution and would otherwise make a
 * stroke stop short of where the preview said it would.
 */
const GUIDE_BLUR_U = 1.5;

/** Sobel tap spacing, artwork units — matches the `edge` mask source. */
const GRAD_RADIUS_U = 2;

/**
 * How much a full-strength edge multiplies travel cost at cling = 1.
 *
 * Deliberately large. How many cells wide an edge reads as depends on render
 * size, so a gentle penalty would block a stroke at preview resolution and let
 * it leak at export, where the same edge spans more cells but the reach also
 * grew. A wall this steep is crossed at neither. What keeps that from blocking
 * everything is the cost floor below: ordinary texture costs exactly nothing.
 */
const CLING_K = 60;

/**
 * Percentile band the gradient is mapped across. Below EDGE_LO travel is free,
 * so a cling brush in a smooth region reaches exactly as far as the circular
 * one does — turning cling up must not shrink the brush. Above EDGE_HI it is a
 * wall. Taking both from the image's own histogram is what makes the dial mean
 * the same thing on a flat studio shot and on a noisy street photograph.
 */
const EDGE_LO = 0.85;
const EDGE_HI = 0.995;

/**
 * Sweeps are capped only to bound a pathological cost field. The loop normally
 * reaches its exact fixed point in a handful of passes, and reaching it matters:
 * see the monotonicity note on geodesicFlood.
 */
const MAX_SWEEPS = 32;

const SQRT2 = Math.SQRT2;

/** Warned once per session; a repeat every dab would bury the first one. */
let warnedUnconverged = false;

// The pool is optional so this module stays usable from a bare context.
const acquireF32 = (ctx, len) =>
  typeof ctx?.acquireF32 === "function" ? ctx.acquireF32(len) : new Float32Array(len);
const releaseF32 = (ctx, arr) => {
  if (arr && typeof ctx?.releaseF32 === "function") ctx.releaseF32(arr);
};

/**
 * Sum weight * |grad|^2 of a plane into `acc`, Sobel taps at radius r.
 *
 * The tap columns are clamped once into a table rather than per sample: this
 * runs nine reads per cell across three planes over the whole working grid, and
 * a bounds-checking closure per read was most of the pause on the first dab of
 * a stroke.
 */
function addSobelSquared(plane, w, h, r, acc, weight, xm, xp) {
  // 0.25 normalises the Sobel kernel; squared, that is 0.0625.
  const k = weight * 0.0625;
  for (let y = 0; y < h; y++) {
    const up = (y - r < 0 ? 0 : y - r) * w;
    const mid = y * w;
    const dn = (y + r >= h ? h - 1 : y + r) * w;
    for (let x = 0; x < w; x++) {
      const a = xm[x];
      const b = xp[x];
      const tl = plane[up + a];
      const tm = plane[up + x];
      const tr = plane[up + b];
      const ml = plane[mid + a];
      const mr = plane[mid + b];
      const bl = plane[dn + a];
      const bm = plane[dn + x];
      const br = plane[dn + b];
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bm + br - tl - 2 * tm - tr;
      acc[mid + x] += k * (gx * gx + gy * gy);
    }
  }
}

/**
 * Build the travel-cost field for `src` (the accumulator as it stands at this
 * point in the stack, not the original photo — so "edges of whatever the
 * datamosh just broke" works here too).
 *
 * Returns { w, h, factor, cost } where cost is 0..1 per working-grid cell and
 * `factor` is how many render pixels one cell spans.
 */
export function buildGuide(ctx, src) {
  const factor = Math.max(1, Math.ceil(Math.sqrt((src.w * src.h) / WORK_BUDGET_PX)));
  const work = factor > 1 ? boxDownsample(src, factor) : src;
  const w = work.w;
  const h = work.h;
  const n = w * h;
  const d = work.data;

  // Luma plus two opponent-colour planes. Luma alone misses a red wall against
  // green foliage at matched brightness, which is an ordinary photograph.
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const r = d[q];
    const g = d[q + 1];
    const b = d[q + 2];
    L[i] = luma(r, g, b) / 255;
    A[i] = (r - g) / 255;
    B[i] = (b - (r + g) / 2) / 255;
  }

  const blur = ctx.u(GUIDE_BLUR_U) / factor;
  if (blur >= 0.5) {
    // blurMask only reads w/h/data, so a bare plane can borrow it.
    blurMask({ w, h, data: L }, blur);
    blurMask({ w, h, data: A }, blur);
    blurMask({ w, h, data: B }, blur);
  }

  const r = Math.max(1, Math.round(ctx.u(GRAD_RADIUS_U) / factor));
  const xm = new Int32Array(w);
  const xp = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xm[x] = x - r < 0 ? 0 : x - r;
    xp[x] = x + r >= w ? w - 1 : x + r;
  }
  const cost = new Float32Array(n);
  addSobelSquared(L, w, h, r, cost, 1, xm, xp);
  addSobelSquared(A, w, h, r, cost, 0.5, xm, xp);
  addSobelSquared(B, w, h, r, cost, 0.5, xm, xp);

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.sqrt(cost[i]);
    cost[i] = v;
    if (v > peak) peak = v;
  }
  if (peak <= 1e-6) {
    cost.fill(0);
    return { w, h, factor, cost };
  }

  // Calibrate on the image's own histogram rather than on the maximum. One
  // specular highlight is enough to make a max-normalised field read as "no
  // edges anywhere", and the brush has to feel the same from photo to photo.
  const BINS = 256;
  const hist = new Int32Array(BINS);
  const toBin = (BINS - 1) / peak;
  for (let i = 0; i < n; i++) hist[(cost[i] * toBin) | 0]++;

  const percentile = (frac) => {
    const target = n * frac;
    for (let b = 0, cum = 0; b < BINS; b++) {
      cum += hist[b];
      if (cum >= target) return (b + 1) / toBin;
    }
    return peak;
  };
  const lo = percentile(EDGE_LO);
  let hi = percentile(EDGE_HI);
  if (hi <= lo) hi = lo + Math.max(1e-6, peak / BINS);

  const span = hi - lo;
  for (let i = 0; i < n; i++) {
    const t = (cost[i] - lo) / span;
    cost[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }

  return { w, h, factor, cost };
}

/**
 * Shortest-path distance from `poly` (flat x,y pairs in working-grid cells)
 * under the guide's travel cost, bounded to `reach` cells.
 *
 * Returns { x0, y0, w, h, dist } — a box-local field where unreached cells hold
 * exactly `reach` — or null when there is nothing to flood.
 *
 * Clipping to the box is safe because a step never costs less than its length,
 * so geodesic distance is never below Euclidean distance: anything within
 * `reach` of a seed is inside the box, and so is every prefix of its path.
 *
 * The sweep runs to its exact fixed point rather than stopping at an epsilon,
 * and that is load-bearing. At the fixed point the field is the true minimum
 * over paths, which makes distance MONOTONE in the seed set — adding seeds can
 * only shorten. mask.js's incremental brush cache relies on exactly that.
 */
export function geodesicFlood(ctx, guide, poly, reach, cling) {
  if (!poly || poly.length < 4 || !(reach > 0)) return null;
  const gw = guide.w;
  const gh = guide.h;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < poly.length; i += 2) {
    if (poly[i] < minX) minX = poly[i];
    if (poly[i] > maxX) maxX = poly[i];
    if (poly[i + 1] < minY) minY = poly[i + 1];
    if (poly[i + 1] > maxY) maxY = poly[i + 1];
  }

  const pad = Math.ceil(reach) + 1;
  const x0 = Math.max(0, Math.floor(minX) - pad);
  const y0 = Math.max(0, Math.floor(minY) - pad);
  const x1 = Math.min(gw - 1, Math.ceil(maxX) + pad);
  const y1 = Math.min(gh - 1, Math.ceil(maxY) + pad);
  if (x1 < x0 || y1 < y0) return null;

  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const area = bw * bh;

  // Pooled at FULL working-grid size, not box size. The box grows with every
  // dab of a live stroke, and the pool is keyed by length — asking for a new
  // size each time would miss on every dab and hand the worker's hot path a
  // couple of megabytes per stroke to collect. One length always hits.
  const dist = acquireF32(ctx, gw * gh);
  const cost = acquireF32(ctx, gw * gh);
  dist.fill(Infinity, 0, area);

  // Local copy of the cost window: the sweeps touch it four times per cell, and
  // striding the full-frame field for that thrashes cache on big exports.
  for (let y = 0; y < bh; y++) {
    const s = (y0 + y) * gw + x0;
    const t = y * bw;
    for (let x = 0; x < bw; x++) cost[t + x] = guide.cost[s + x];
  }

  // Seed the polyline at roughly one cell per step so the stroke is a
  // continuous source, not a string of separate stamps.
  let seeded = false;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const ax = poly[i];
    const ay = poly[i + 1];
    const bx = poly[i + 2];
    const by = poly[i + 3];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const cx = Math.round(ax + (bx - ax) * t) - x0;
      const cy = Math.round(ay + (by - ay) * t) - y0;
      if (cx < 0 || cy < 0 || cx >= bw || cy >= bh) continue;
      dist[cy * bw + cx] = 0;
      seeded = true;
    }
  }
  if (!seeded) {
    releaseF32(ctx, dist);
    releaseF32(ctx, cost);
    return null;
  }

  const hk = 0.5 * cling * CLING_K;
  let improved = true;
  let sweep = 0;
  for (; improved && sweep < MAX_SWEEPS; sweep++) {
    improved = false;
    if ((sweep & 1) === 0) {
      for (let y = 0; y < bh; y++) {
        const row = y * bw;
        for (let x = 0; x < bw; x++) {
          const i = row + x;
          const ci = cost[i];
          let best = dist[i];
          if (x > 0) {
            const j = i - 1;
            const v = dist[j] + 1 + hk * (cost[j] + ci);
            if (v < best) best = v;
          }
          if (y > 0) {
            const up = i - bw;
            let v = dist[up] + 1 + hk * (cost[up] + ci);
            if (v < best) best = v;
            if (x > 0) {
              const j = up - 1;
              v = dist[j] + SQRT2 * (1 + hk * (cost[j] + ci));
              if (v < best) best = v;
            }
            if (x < bw - 1) {
              const j = up + 1;
              v = dist[j] + SQRT2 * (1 + hk * (cost[j] + ci));
              if (v < best) best = v;
            }
          }
          // Round to storage precision BEFORE testing for improvement. `best`
          // is a float64 sum; dist is a Float32Array. Where the narrowing
          // rounds up, `best < dist[i]` stayed true against the value it had
          // just written, so the cell "improved" on every sweep forever and the
          // loop never converged — it silently burned the full sweep budget on
          // every flood.
          const next = Math.fround(best);
          if (next <= reach && next < dist[i]) {
            dist[i] = next;
            improved = true;
          }
        }
      }
    } else {
      for (let y = bh - 1; y >= 0; y--) {
        const row = y * bw;
        for (let x = bw - 1; x >= 0; x--) {
          const i = row + x;
          const ci = cost[i];
          let best = dist[i];
          if (x < bw - 1) {
            const j = i + 1;
            const v = dist[j] + 1 + hk * (cost[j] + ci);
            if (v < best) best = v;
          }
          if (y < bh - 1) {
            const dn = i + bw;
            let v = dist[dn] + 1 + hk * (cost[dn] + ci);
            if (v < best) best = v;
            if (x < bw - 1) {
              const j = dn + 1;
              v = dist[j] + SQRT2 * (1 + hk * (cost[j] + ci));
              if (v < best) best = v;
            }
            if (x > 0) {
              const j = dn - 1;
              v = dist[j] + SQRT2 * (1 + hk * (cost[j] + ci));
              if (v < best) best = v;
            }
          }
          // Round to storage precision BEFORE testing for improvement. `best`
          // is a float64 sum; dist is a Float32Array. Where the narrowing
          // rounds up, `best < dist[i]` stayed true against the value it had
          // just written, so the cell "improved" on every sweep forever and the
          // loop never converged — it silently burned the full sweep budget on
          // every flood.
          const next = Math.fround(best);
          if (next <= reach && next < dist[i]) {
            dist[i] = next;
            improved = true;
          }
        }
      }
    }
  }

  // Leaving on the sweep cap rather than on convergence is the one thing that
  // breaks the monotonicity mask.js's incremental cache depends on, and it
  // would surface as an unexplained pop when a stroke settles. It should never
  // happen; say so loudly once if it does.
  if (improved && !warnedUnconverged) {
    warnedUnconverged = true;
    console.warn(
      `[geodesic] flood hit MAX_SWEEPS (${MAX_SWEEPS}) without converging on a ` +
      `${bw}x${bh} box — incremental paint may drift from the exported mask.`
    );
  }

  // Unreached cells carry the cutoff rather than Infinity: the falloff is zero
  // there either way, and a finite value keeps the bilinear read at export
  // resolution from smearing NaN back across the boundary.
  for (let i = 0; i < area; i++) if (!(dist[i] < reach)) dist[i] = reach;

  releaseF32(ctx, cost);
  // `dist` belongs to the caller now — it must hand it back with releaseFlood.
  return { x0, y0, w: bw, h: bh, dist };
}

/** Return a flood's pooled distance field once the caller has sampled it. */
export function releaseFlood(ctx, flood) {
  if (flood) releaseF32(ctx, flood.dist);
}
