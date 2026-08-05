/**
 * Deterministic randomness.
 *
 * THE RESOLUTION RULE: processors must derive per-pixel variation from SPATIAL
 * noise sampled in artwork units — noise2(x / 40, y / 40) — never from a
 * sequential rng() call per pixel. A call sequence produces a different pattern
 * when the pixel count changes, so a preview and a 4x export would diverge.
 * Sequential rng() is fine for per-*feature* decisions (which block to smear,
 * where to seed a voronoi cell) as long as the feature count is scale-invariant.
 */

/** Small fast PRNG. Same seed always yields the same stream. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix a string or number into a 32-bit seed. */
export function hashSeed(value, salt = 0) {
  let h = 2166136261 ^ salt;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic 0..1 from an integer lattice point. */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in 0..1. Coordinates are in artwork units. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);

  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fy;
}

/** Fractal brownian motion. Returns roughly 0..1. */
export function fbm(x, y, seed = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Curl of an fbm potential field — a divergence-free vector field.
 *
 * This is the organic backbone of the tool: flow-field pixel sorting, curl
 * ripple, hatch orientation and mask edge jitter all read from it. Because it
 * is divergence-free the flow swirls and never sinks into a point, which is
 * what makes it read as water/smoke rather than as a radial blur.
 *
 * `scale` is the feature size in artwork units.
 */
export function curl(x, y, seed = 0, scale = 100, out = { x: 0, y: 0 }) {
  const sx = x / scale;
  const sy = y / scale;
  // Two octaves, not four. Differentiating a high-octave fbm amplifies its
  // finest detail, and the field degenerates into turbulent hair instead of
  // the sweeping currents that make sorted runs and hatching read as flow.
  const ex = 0.05;

  const n1 = fbm(sx, sy + ex, seed, 2);
  const n2 = fbm(sx, sy - ex, seed, 2);
  const n3 = fbm(sx + ex, sy, seed, 2);
  const n4 = fbm(sx - ex, sy, seed, 2);

  let dx = (n1 - n2) / (2 * ex);
  let dy = -(n3 - n4) / (2 * ex);

  const len = Math.hypot(dx, dy) || 1;
  out.x = dx / len;
  out.y = dy / len;
  return out;
}

/** Angle of the curl field at a point, in radians. */
export function curlAngle(x, y, seed = 0, scale = 100) {
  const v = curl(x, y, seed, scale);
  return Math.atan2(v.y, v.x);
}

/**
 * Jittered-grid point set — cheap Poisson-ish blue-noise distribution.
 * Point count scales with area / spacing^2, so it is scale-invariant when
 * `spacing` is given in artwork units and coords are artwork units.
 */
export function jitteredPoints(w, h, spacing, seed = 0, jitter = 0.8) {
  const cols = Math.max(1, Math.ceil(w / spacing));
  const rows = Math.max(1, Math.ceil(h / spacing));
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const j1 = hash2(c, r, seed);
      const j2 = hash2(c, r, seed + 7919);
      pts.push({
        x: (c + 0.5 + (j1 - 0.5) * jitter) * spacing,
        y: (r + 0.5 + (j2 - 0.5) * jitter) * spacing,
        i: pts.length,
      });
    }
  }
  return pts;
}

/** Deterministic per-point random in 0..1, stable across resolutions. */
export function pointRandom(pt, seed = 0) {
  return hash2(Math.round(pt.x * 16), Math.round(pt.y * 16), seed);
}
