/**
 * Ordered tile patterns — thresholds arranged on a grid rather than sampled
 * from noise.
 *
 * These are shared because the same handful of tiles show up everywhere in the
 * reference work: bayer thresholds behind dithering AND behind the dissolving
 * mask edges, checkerboards as both a halftone weave and a mask boundary, dot
 * screens as classic print halftone. One definition, many consumers.
 *
 * Every lookup takes INTEGER CELL COORDINATES, not pixels. Callers derive those
 * cells from an artwork-unit size, which is what keeps the pattern the same
 * physical size at preview and export.
 */

/** Recursive Bayer / ordered-dither matrix. `n` must be a power of two. */
export function bayerMatrix(n) {
  if (n === 1) return [[0]];
  const half = bayerMatrix(n / 2);
  const m = Array.from({ length: n }, () => new Array(n));
  for (let y = 0; y < n / 2; y++) {
    for (let x = 0; x < n / 2; x++) {
      const v = half[y][x] * 4;
      m[y][x] = v;
      m[y][x + n / 2] = v + 2;
      m[y + n / 2][x] = v + 3;
      m[y + n / 2][x + n / 2] = v + 1;
    }
  }
  return m;
}

export const BAYER = {
  2: bayerMatrix(2),
  4: bayerMatrix(4),
  8: bayerMatrix(8),
  16: bayerMatrix(16),
};

/** Normalised 0..1 bayer threshold at a cell. */
export function bayerAt(cx, cy, size = 8) {
  const m = BAYER[size] ?? BAYER[8];
  const n = m.length;
  const x = ((cx % n) + n) % n;
  const y = ((cy % n) + n) % n;
  return (m[y][x] + 0.5) / (n * n);
}

/** Checkerboard: 0 or 1. */
export function checkerAt(cx, cy) {
  return ((cx + cy) & 1) === 0 ? 0 : 1;
}

/**
 * Threshold field for a weave / cross-stitch tile — the tight × texture that
 * covers the still life and the peaches basket. Returns 0..1: low where the
 * stitch sits, high in the gaps, so thresholding against coverage fills the
 * stitch first.
 */
export function weaveAt(cx, cy, size = 4) {
  const x = ((cx % size) + size) % size;
  const y = ((cy % size) + size) % size;
  const onDiag = x === y || x === size - 1 - y;
  if (onDiag) return 0.15;
  const nearDiag = Math.abs(x - y) === 1 || Math.abs(x - (size - 1 - y)) === 1;
  return nearDiag ? 0.55 : 0.95;
}

/**
 * Classic AM halftone dot screen. Returns the distance-from-dot-centre as a
 * 0..1 threshold, on a grid rotated by `angle`. Print uses different angles per
 * channel (15/75/0/45) so the dots interleave into a rosette instead of moiré.
 */
export function dotScreenAt(x, y, pitch, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rx = (x * c - y * s) / pitch;
  const ry = (x * s + y * c) / pitch;
  const fx = rx - Math.floor(rx) - 0.5;
  const fy = ry - Math.floor(ry) - 0.5;
  // 0 at the cell centre, ~1 at the corners
  return Math.min(1, Math.hypot(fx, fy) * 2);
}

/** Line screen — the same idea collapsed to one axis. */
export function lineScreenAt(x, y, pitch, angle) {
  const v = (x * Math.cos(angle) - y * Math.sin(angle)) / pitch;
  const f = v - Math.floor(v);
  return Math.abs(f - 0.5) * 2;
}

/** Standard per-channel screen angles from offset lithography, in radians. */
export const SCREEN_ANGLES = {
  cyan: (15 * Math.PI) / 180,
  magenta: (75 * Math.PI) / 180,
  yellow: 0,
  black: (45 * Math.PI) / 180,
};
