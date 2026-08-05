/** Colour maths, gradient ramps and the Barcelona palettes. */

/** Rec. 709 luma, 0..255. */
export function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function saturationOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  if (h < 0) h += 1;
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hk(h + 1 / 3) * 255, hk(h) * 255, hk(h - 1 / 3) * 255];
}

/**
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → [r, g, b]. Alpha is dropped;
 * nothing downstream consumes it (layer opacity is the alpha channel here).
 *
 * The two traps this avoids: an 8-digit value overflows int32, so a bare `>>`
 * sign-extends it and reports the wrong channels entirely (`#ff0000ff` came out
 * blue), and 4-digit shorthand needs the same expansion 3-digit does.
 */
export function parseHex(hex) {
  let s = String(hex).trim().replace(/^#/, "");
  if (s.length === 3 || s.length === 4) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  } else if (s.length === 6 || s.length === 8) {
    s = s.slice(0, 6);
  } else {
    return [0, 0, 0];
  }
  const n = Number.parseInt(s, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** The hex forms parseHex understands. Shared by the colour input and presets. */
export const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function toHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// ---------------------------------------------------------------------------
// Gradient ramps
// ---------------------------------------------------------------------------

/**
 * Build a 256-entry RGB lookup table from gradient stops.
 * Stops are [{ pos: 0..1, color: '#rrggbb' }], any order.
 *
 * A LUT rather than per-pixel interpolation: the gradient-map processor runs
 * over tens of millions of pixels at export size and the LUT makes it a single
 * indexed read.
 */
export function buildRamp(stops) {
  const sorted = [...stops]
    .map((s) => ({ pos: Math.max(0, Math.min(1, s.pos)), rgb: parseHex(s.color) }))
    .sort((a, b) => a.pos - b.pos);

  if (sorted.length === 0) sorted.push({ pos: 0, rgb: [0, 0, 0] });
  if (sorted[0].pos > 0) sorted.unshift({ pos: 0, rgb: sorted[0].rgb });
  if (sorted[sorted.length - 1].pos < 1) {
    sorted.push({ pos: 1, rgb: sorted[sorted.length - 1].rgb });
  }

  const lut = new Uint8ClampedArray(256 * 3);
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    while (seg < sorted.length - 2 && t > sorted[seg + 1].pos) seg++;
    const a = sorted[seg];
    const b = sorted[seg + 1];
    const span = b.pos - a.pos;
    const f = span <= 0 ? 0 : (t - a.pos) / span;
    lut[i * 3] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f;
    lut[i * 3 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f;
    lut[i * 3 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f;
  }
  return lut;
}

/**
 * Named ramps. The Barcelona set is pulled from Gaudí's actual material
 * palettes — the trencadís mosaics of Park Güell, the stained glass of the
 * Sagrada nave, the sea-and-coral facade of Casa Batlló.
 */
export const PALETTES = {
  duotone: [
    { pos: 0, color: "#0b0c10" },
    { pos: 1, color: "#f2f4f8" },
  ],
  "park-guell": [
    { pos: 0, color: "#10233f" },
    { pos: 0.35, color: "#1c6f8c" },
    { pos: 0.62, color: "#e0b64a" },
    { pos: 0.85, color: "#d4703a" },
    { pos: 1, color: "#f6e6cd" },
  ],
  sagrada: [
    { pos: 0, color: "#161033" },
    { pos: 0.3, color: "#5b2a86" },
    { pos: 0.55, color: "#c94f3d" },
    { pos: 0.78, color: "#e8a33d" },
    { pos: 1, color: "#fbf0d2" },
  ],
  "casa-batllo": [
    { pos: 0, color: "#07253c" },
    { pos: 0.32, color: "#1b7f9e" },
    { pos: 0.58, color: "#67c2c0" },
    { pos: 0.8, color: "#ef7d63" },
    { pos: 1, color: "#f7e9dd" },
  ],
  trencadis: [
    { pos: 0, color: "#1a2f4b" },
    { pos: 0.25, color: "#2f6fb0" },
    { pos: 0.5, color: "#f4f1e8" },
    { pos: 0.72, color: "#c9a227" },
    { pos: 1, color: "#3f6b4a" },
  ],
  "sunset-sea": [
    { pos: 0, color: "#0a3a5c" },
    { pos: 0.28, color: "#1f9bb5" },
    { pos: 0.5, color: "#8fb9a8" },
    { pos: 0.72, color: "#f2a03d" },
    { pos: 1, color: "#e8402a" },
  ],
  ember: [
    { pos: 0, color: "#000000" },
    { pos: 0.45, color: "#7a1f0f" },
    { pos: 0.75, color: "#ef6c1a" },
    { pos: 1, color: "#ffe9a8" },
  ],
  cyanotype: [
    { pos: 0, color: "#03192e" },
    { pos: 0.5, color: "#2b6b9e" },
    { pos: 1, color: "#dcefff" },
  ],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/** Clamp helper used all over the processors. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
