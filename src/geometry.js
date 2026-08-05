/**
 * Natural-form geometry. Everything here works in artwork units.
 *
 * These are the shapes that separate this tool from a generic glitch filter:
 * Gaudí derived his structures from hanging chains and ruled surfaces rather
 * than from drawn curves, and plants pack their seeds on the golden angle.
 * Warps and tilings built on them read as grown rather than applied.
 */

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 137.507°

/**
 * Catenary — the curve of a chain hanging under its own weight, y = a·cosh(x/a).
 * Gaudí hung weighted strings to find these, then inverted them into arches.
 * Normalised so f(0) = 0 and f(±1) = 1.
 */
export function catenary(t, a = 0.6) {
  const denom = Math.cosh(1 / a) - 1;
  if (denom === 0) return 0;
  return (Math.cosh(t / a) - 1) / denom;
}

/**
 * Hyperbolic paraboloid ("hypar") height at (x, y), both normalised -1..1.
 * The doubly-ruled saddle surface of the Sagrada Família roofs and the
 * Colònia Güell vaults — straight lines swept into a curved sheet.
 */
export function hypar(x, y, twist = 1) {
  return (x * x - y * y) * twist;
}

/** Logarithmic (equiangular) spiral radius at angle θ. Nautilus growth. */
export function logSpiralRadius(theta, a = 1, b = 0.18) {
  return a * Math.exp(b * theta);
}

/**
 * Phyllotaxis seed packing — sunflower head / pine cone arrangement.
 * Returns `count` points around (0,0); `spacing` is the seed pitch in
 * artwork units.
 */
export function phyllotaxisPoints(count, spacing) {
  const pts = new Array(count);
  for (let i = 0; i < count; i++) {
    const theta = i * GOLDEN_ANGLE;
    const r = spacing * Math.sqrt(i);
    pts[i] = { x: Math.cos(theta) * r, y: Math.sin(theta) * r, i, theta, r };
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Voronoi / trencadís
// ---------------------------------------------------------------------------

/**
 * Nearest-site lookup over a scattered point set, bucketed into a uniform grid
 * so each query only tests a 3x3 neighbourhood. Sites are expected to be
 * roughly `spacing` apart (jitteredPoints from rng.js produces exactly that).
 *
 * `nearest2` also returns the second-nearest distance, which gives the shard
 * boundary for free: d2 - d1 approaches zero on a cell edge, and that is the
 * grout line of a trencadís mosaic.
 */
export class SiteGrid {
  constructor(points, w, h, spacing) {
    this.points = points;
    this.spacing = spacing;
    this.cols = Math.max(1, Math.ceil(w / spacing));
    this.rows = Math.max(1, Math.ceil(h / spacing));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    for (const p of points) {
      const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / spacing)));
      const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / spacing)));
      this.buckets[cy * this.cols + cx].push(p);
    }
  }

  nearest2(x, y, out = { site: null, d1: Infinity, d2: Infinity }) {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.spacing)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.spacing)));
    let best = null;
    let d1 = Infinity;
    let d2 = Infinity;

    for (let dy = -1; dy <= 1; dy++) {
      const by = cy + dy;
      if (by < 0 || by >= this.rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const bx = cx + dx;
        if (bx < 0 || bx >= this.cols) continue;
        const bucket = this.buckets[by * this.cols + bx];
        for (let k = 0; k < bucket.length; k++) {
          const p = bucket[k];
          const ex = p.x - x;
          const ey = p.y - y;
          const d = ex * ex + ey * ey;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = p;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
    }
    out.site = best;
    out.d1 = Math.sqrt(d1);
    out.d2 = d2 === Infinity ? out.d1 : Math.sqrt(d2);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Regular tilings
// ---------------------------------------------------------------------------

/**
 * Flat-top hexagonal grid — the Barcelona *panot*, the hexagonal paving slab
 * Gaudí designed that still covers Passeig de Gràcia.
 *
 * Returns the centre of the hex containing (x, y) plus its axial coords.
 */
export function hexCell(x, y, size, out = { cx: 0, cy: 0, q: 0, r: 0 }) {
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / size;

  // cube rounding
  let cx = q;
  let cz = r;
  let cy = -cx - cz;
  let rx = Math.round(cx);
  let ry = Math.round(cy);
  let rz = Math.round(cz);
  const dx = Math.abs(rx - cx);
  const dy = Math.abs(ry - cy);
  const dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;

  out.q = rx;
  out.r = rz;
  out.cx = size * (1.5 * rx);
  out.cy = size * (Math.sqrt(3) * (rz + rx / 2));
  return out;
}

/** Mirror-fold a coordinate into a repeating tile of width `period`. */
export function mirrorFold(v, period) {
  const p2 = period * 2;
  let m = v % p2;
  if (m < 0) m += p2;
  return m < period ? m : p2 - m;
}

/**
 * Fold a point into an n-fold kaleidoscope wedge around a centre.
 * Returns the source coordinate to sample from.
 */
export function kaleidoFold(x, y, cx, cy, folds, rotation, out = { x: 0, y: 0 }) {
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  let a = Math.atan2(dy, dx) - rotation;

  const wedge = (Math.PI * 2) / folds;
  a = a % wedge;
  if (a < 0) a += wedge;
  // mirror within the wedge so adjacent segments reflect rather than repeat
  if (a > wedge / 2) a = wedge - a;
  a += rotation;

  out.x = cx + Math.cos(a) * r;
  out.y = cy + Math.sin(a) * r;
  return out;
}
