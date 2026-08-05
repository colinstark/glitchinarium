/**
 * RGBA typed-array buffers — the currency of the whole pipeline.
 *
 * A Buf is { w, h, data: Uint8ClampedArray } with data.length === w * h * 4.
 * A Mask is { w, h, data: Float32Array } with values in 0..1.
 *
 * Nothing here knows about p5. p5 only ever hands us an ImageData-shaped thing
 * at the very start and takes one back at the very end.
 */

export function createBuf(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneBuf(b) {
  return { w: b.w, h: b.h, data: new Uint8ClampedArray(b.data) };
}

export function createMask(w, h, fill = 0) {
  const data = new Float32Array(w * h);
  if (fill !== 0) data.fill(fill);
  return { w, h, data };
}

export function bufFromImageData(imgData) {
  return {
    w: imgData.width,
    h: imgData.height,
    data: new Uint8ClampedArray(imgData.data),
  };
}

export function bufToImageData(buf) {
  return new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h);
}

/** Draw a buffer onto a canvas, resizing the canvas to match. */
export function bufToCanvas(buf, canvas = document.createElement("canvas")) {
  canvas.width = buf.w;
  canvas.height = buf.h;
  canvas.getContext("2d").putImageData(bufToImageData(buf), 0, 0);
  return canvas;
}

/**
 * Decode any drawable source (HTMLImageElement, ImageBitmap, canvas) into a
 * buffer at an explicit size. Uses the browser's own resampler, which is
 * higher quality and far faster than anything we'd write here.
 */
export function bufFromDrawable(src, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return bufFromImageData(ctx.getImageData(0, 0, w, h));
}

// ---------------------------------------------------------------------------
// Edge handling
// ---------------------------------------------------------------------------

export const EDGE_MODES = ["clamp", "wrap", "mirror"];

/** Fold an out-of-range coordinate back into 0..n-1. */
export function foldCoord(v, n, mode) {
  if (v >= 0 && v < n) return v;
  switch (mode) {
    case "wrap": {
      const m = v % n;
      return m < 0 ? m + n : m;
    }
    case "mirror": {
      const period = 2 * n;
      let m = v % period;
      if (m < 0) m += period;
      return m < n ? m : period - 1 - m;
    }
    default:
      return v < 0 ? 0 : n - 1;
  }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Bilinear sample at floating-point (x, y). Writes RGBA into `out` (length >= 4).
 *
 * Warp processors must use this rather than nearest-neighbour: at 4x export
 * resolution nearest-neighbour warps alias badly, and the whole point of the
 * supersampled pipeline is that geometry stays smooth.
 */
export function sampleBilinear(buf, x, y, out, edge = "clamp") {
  const { w, h, data } = buf;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const xa = foldCoord(x0, w, edge);
  const xb = foldCoord(x0 + 1, w, edge);
  const ya = foldCoord(y0, h, edge);
  const yb = foldCoord(y0 + 1, h, edge);

  const i00 = (ya * w + xa) * 4;
  const i10 = (ya * w + xb) * 4;
  const i01 = (yb * w + xa) * 4;
  const i11 = (yb * w + xb) * 4;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  for (let c = 0; c < 4; c++) {
    out[c] =
      data[i00 + c] * w00 +
      data[i10 + c] * w10 +
      data[i01 + c] * w01 +
      data[i11 + c] * w11;
  }
  return out;
}

export function sampleNearest(buf, x, y, out, edge = "clamp") {
  const xi = foldCoord(Math.round(x), buf.w, edge);
  const yi = foldCoord(Math.round(y), buf.h, edge);
  const i = (yi * buf.w + xi) * 4;
  out[0] = buf.data[i];
  out[1] = buf.data[i + 1];
  out[2] = buf.data[i + 2];
  out[3] = buf.data[i + 3];
  return out;
}

/** Average colour of an axis-aligned region. Used by tiling/mosaic processors. */
export function regionAverage(buf, x0, y0, x1, y1, out) {
  const { w, h, data } = buf;
  const xa = Math.max(0, Math.min(w - 1, Math.floor(x0)));
  const xb = Math.max(0, Math.min(w, Math.ceil(x1)));
  const ya = Math.max(0, Math.min(h - 1, Math.floor(y0)));
  const yb = Math.max(0, Math.min(h, Math.ceil(y1)));
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let y = ya; y < yb; y++) {
    let i = (y * w + xa) * 4;
    for (let x = xa; x < xb; x++, i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      a += data[i + 3];
      n++;
    }
  }
  if (n === 0) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return out;
  }
  out[0] = r / n;
  out[1] = g / n;
  out[2] = b / n;
  out[3] = a / n;
  return out;
}

// ---------------------------------------------------------------------------
// Downsampling (the supersample resolve)
// ---------------------------------------------------------------------------

/**
 * Integer box downsample by `factor`. This is the SSAA resolve: the pipeline
 * renders at 4x the source and this brings it to the requested export size.
 *
 * A box filter is deliberate — a Lanczos/bicubic resolve would ring on the
 * hard glyph and dither edges this tool produces.
 */
export function boxDownsample(buf, factor) {
  if (factor <= 1) return buf;
  const f = Math.round(factor);
  const w = Math.max(1, Math.floor(buf.w / f));
  const h = Math.max(1, Math.floor(buf.h / f));
  const out = createBuf(w, h);
  const src = buf.data;
  const dst = out.data;
  const inv = 1 / (f * f);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const sy0 = y * f;
      const sx0 = x * f;
      for (let dy = 0; dy < f; dy++) {
        let i = ((sy0 + dy) * buf.w + sx0) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      dst[o] = r * inv;
      dst[o + 1] = g * inv;
      dst[o + 2] = b * inv;
      dst[o + 3] = a * inv;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "difference",
  "add",
  "lighten",
  "darken",
];

function blendChannel(mode, b, s) {
  switch (mode) {
    case "multiply":
      return (b * s) / 255;
    case "screen":
      return 255 - ((255 - b) * (255 - s)) / 255;
    case "overlay":
      return b < 128 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255;
    case "difference":
      return Math.abs(b - s);
    case "add":
      return b + s;
    case "lighten":
      return Math.max(b, s);
    case "darken":
      return Math.min(b, s);
    default:
      return s;
  }
}

/**
 * Composite `src` onto `dst` in place.
 *
 * `mask` (optional Float32 mask at the same dimensions) scales the effect
 * per-pixel, which is how the named-mask system selectively applies a layer.
 * `src` alpha is respected so glyph layers can draw on transparency.
 */
export function compositeInto(dst, src, { mode = "normal", opacity = 1, mask = null } = {}) {
  const d = dst.data;
  const s = src.data;
  const n = dst.w * dst.h;
  const plain = mode === "normal";

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    let coverage = opacity;
    if (mask) coverage *= mask.data[p];
    const sa = Math.max(0, Math.min(1, (s[i + 3] / 255) * coverage));
    if (sa <= 0) continue;

    if (plain && sa >= 1) {
      d[i] = s[i];
      d[i + 1] = s[i + 1];
      d[i + 2] = s[i + 2];
      d[i + 3] = 255;
      continue;
    }

    const da = d[i + 3] / 255;
    // Opaque photographs are the overwhelmingly common path. Source-over then
    // reduces to the original three-channel lerp and needs no alpha division.
    if (da >= 1) {
      for (let c = 0; c < 3; c++) {
        const base = d[i + c];
        const blended = plain ? s[i + c] : blendChannel(mode, base, s[i + c]);
        d[i + c] = base + (blended - base) * sa;
      }
      continue;
    }
    if (da <= 0) {
      d[i] = s[i];
      d[i + 1] = s[i + 1];
      d[i + 2] = s[i + 2];
      d[i + 3] = sa * 255;
      continue;
    }

    const outA = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) {
      const base = d[i + c];
      const source = s[i + c];
      const blended = plain ? source : blendChannel(mode, base, source);
      // W3C source-over blending in premultiplied form, converted back to the
      // straight-alpha representation used by ImageData. In particular, RGB
      // must not be attenuated when painting onto a transparent destination.
      const premult =
        sa * (1 - da) * source +
        sa * da * blended +
        (1 - sa) * da * base;
      d[i + c] = outA > 0 ? premult / outA : 0;
    }
    d[i + 3] = outA * 255;
  }
  return dst;
}

/** Fill a buffer with a solid RGBA colour. */
export function fillBuf(buf, r, g, b, a = 255) {
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
  return buf;
}

/**
 * Separable box blur on an RGBA buffer, radius in pixels. Two passes so it
 * approximates a gaussian; used by glow and by CRT phosphor bleed.
 */
export function boxBlurBuf(buf, radiusX, radiusY = radiusX) {
  const rx = Math.max(0, Math.round(radiusX));
  const ry = Math.max(0, Math.round(radiusY));
  if (rx < 1 && ry < 1) return buf;
  const { w, h, data } = buf;
  const tmp = new Float32Array(w * h * 4);

  for (let pass = 0; pass < 2; pass++) {
    if (rx >= 1) {
      const inv = 1 / (2 * rx + 1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        const sum = [0, 0, 0, 0];
        for (let x = -rx; x <= rx; x++) {
          const i = (row + Math.min(w - 1, Math.max(0, x))) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[i + c];
        }
        for (let x = 0; x < w; x++) {
          const o = (row + x) * 4;
          for (let c = 0; c < 4; c++) tmp[o + c] = sum[c] * inv;
          const out = (row + Math.min(w - 1, Math.max(0, x - rx))) * 4;
          const add = (row + Math.min(w - 1, Math.max(0, x + rx + 1))) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[add + c] - data[out + c];
        }
      }
      for (let i = 0; i < data.length; i++) data[i] = tmp[i];
    }

    if (ry >= 1) {
      const inv = 1 / (2 * ry + 1);
      for (let x = 0; x < w; x++) {
        const sum = [0, 0, 0, 0];
        for (let y = -ry; y <= ry; y++) {
          const i = (Math.min(h - 1, Math.max(0, y)) * w + x) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[i + c];
        }
        for (let y = 0; y < h; y++) {
          const o = (y * w + x) * 4;
          for (let c = 0; c < 4; c++) tmp[o + c] = sum[c] * inv;
          const out = (Math.min(h - 1, Math.max(0, y - ry)) * w + x) * 4;
          const add = (Math.min(h - 1, Math.max(0, y + ry + 1)) * w + x) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[add + c] - data[out + c];
        }
      }
      for (let i = 0; i < data.length; i++) data[i] = tmp[i];
    }
  }
  return buf;
}

/**
 * Separable box blur on a mask, radius in pixels. Used for mask feathering and
 * for the local-detail mask source. Two passes approximate a gaussian well
 * enough for a soft edge and stay O(n).
 */
export function blurMask(mask, radius) {
  if (radius < 0.5) return mask;
  const r = Math.max(1, Math.round(radius));
  const { w, h } = mask;
  let src = mask.data;
  let tmp = new Float32Array(w * h);

  for (let pass = 0; pass < 2; pass++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      const inv = 1 / (2 * r + 1);
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        const out = row + Math.min(w - 1, Math.max(0, x - r));
        const add = row + Math.min(w - 1, Math.max(0, x + r + 1));
        sum += src[add] - src[out];
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      const inv = 1 / (2 * r + 1);
      for (let y = 0; y < h; y++) {
        src[y * w + x] = sum * inv;
        const out = Math.min(h - 1, Math.max(0, y - r)) * w + x;
        const add = Math.min(h - 1, Math.max(0, y + r + 1)) * w + x;
        sum += tmp[add] - tmp[out];
      }
    }
  }
  return mask;
}
