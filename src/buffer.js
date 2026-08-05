/**
 * RGBA typed-array buffers — the currency of the whole pipeline.
 *
 * A Buf is { w, h, data: Uint8ClampedArray } with data.length === w * h * 4.
 * A Mask is { w, h, data: Float32Array } with values in 0..1.
 *
 * Nothing here knows about the stage canvas. Callers hand us ImageData-shaped
 * things (or drawables) at the edges of the pipeline.
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

/**
 * Wrap an ImageData we exclusively own — no copy.
 *
 * getImageData already returns a fresh, unaliased buffer, so the glyph
 * processors would otherwise pay a second full-frame allocation and memcpy on
 * their way out (~90 MB each at a capped export). Use bufFromImageData instead
 * whenever the caller keeps using the ImageData afterwards.
 */
export function bufFromOwnedImageData(imgData) {
  return { w: imgData.width, h: imgData.height, data: imgData.data };
}

export function bufToImageData(buf) {
  // Share the underlying buffer — no intermediate clone. Callers that will
  // mutate `buf` after painting to a canvas should clone first.
  return new ImageData(buf.data, buf.w, buf.h);
}

/** Create a blank canvas-like surface (DOM canvas on main, OffscreenCanvas in workers). */
export function createSurface(w = 1, h = 1) {
  if (typeof OffscreenCanvas === "function" && typeof document === "undefined") {
    return new OffscreenCanvas(w, h);
  }
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas === "function") {
    return new OffscreenCanvas(w, h);
  }
  throw new Error("No canvas surface available");
}

/** Draw a buffer onto a canvas, resizing the canvas to match. */
export function bufToCanvas(buf, canvas = createSurface(buf.w, buf.h)) {
  if (canvas.width !== buf.w || canvas.height !== buf.h) {
    canvas.width = buf.w;
    canvas.height = buf.h;
  }
  canvas.getContext("2d").putImageData(bufToImageData(buf), 0, 0);
  return canvas;
}

/**
 * Decode any drawable source (HTMLImageElement, ImageBitmap, canvas) into a
 * buffer at an explicit size. Uses the browser's own resampler, which is
 * higher quality and far faster than anything we'd write here.
 *
 * Main-thread only (needs drawImage from a DOM/ImageBitmap source).
 */
export function bufFromDrawable(src, w, h) {
  const c = createSurface(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  // The scratch canvas is discarded here, so the ImageData is ours to keep.
  return bufFromOwnedImageData(ctx.getImageData(0, 0, w, h));
}

/** Pack a Buf into a transferable ArrayBuffer message payload. */
export function bufToTransfer(buf) {
  // Copy so the original remains usable if the caller still needs it.
  const copy = buf.data.buffer.slice(
    buf.data.byteOffset,
    buf.data.byteOffset + buf.data.byteLength
  );
  return { w: buf.w, h: buf.h, buffer: copy };
}

/** Rebuild a Buf from a transferable payload. */
export function bufFromTransfer(payload) {
  return {
    w: payload.w,
    h: payload.h,
    data: new Uint8ClampedArray(payload.buffer),
  };
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
  // floor: |0 truncates toward 0 (fine for the common non-negative case).
  const ix = x < 0 ? Math.floor(x) : x | 0;
  const iy = y < 0 ? Math.floor(y) : y | 0;
  const fx = x - ix;
  const fy = y - iy;

  const xa = foldCoord(ix, w, edge);
  const xb = foldCoord(ix + 1, w, edge);
  const ya = foldCoord(iy, h, edge);
  const yb = foldCoord(iy + 1, h, edge);

  const i00 = (ya * w + xa) << 2;
  const i10 = (ya * w + xb) << 2;
  const i01 = (yb * w + xa) << 2;
  const i11 = (yb * w + xb) << 2;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  out[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
  out[3] = data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11;
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
 * Mask may set `invert: true` for a zero-copy inverted view, and optional
 * `bbox: {x0,y0,x1,y1}` to skip empty regions (paint masks).
 * `src` alpha is respected so glyph layers can draw on transparency.
 * `srcOpaque` (optional) short-circuits the whole-frame alpha scan below when
 * the caller has already established the answer — see pipeline.renderSteps.
 */
export function compositeInto(
  dst,
  src,
  { mode = "normal", opacity = 1, mask = null, srcOpaque = null } = {}
) {
  const d = dst.data;
  const s = src.data;
  const w = dst.w;
  const h = dst.h;
  const plain = mode === "normal";
  const maskData = mask?.data ?? null;
  const maskInvert = !!mask?.invert;

  let x0 = 0;
  let y0 = 0;
  let x1 = w - 1;
  let y1 = h - 1;
  if (mask?.bbox && !maskInvert) {
    // Inverted sparse masks are dense outside the bbox — cannot clip.
    x0 = Math.max(0, mask.bbox.x0 | 0);
    y0 = Math.max(0, mask.bbox.y0 | 0);
    x1 = Math.min(w - 1, mask.bbox.x1 | 0);
    y1 = Math.min(h - 1, mask.bbox.y1 | 0);
    if (x1 < x0 || y1 < y0) return dst;
  }

  // Fast path: full-frame opaque normal replace (no mask, full opacity).
  if (plain && opacity >= 1 && !maskData && x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) {
    let opaque = srcOpaque;
    if (opaque === null) {
      opaque = true;
      for (let i = 3; i < s.length; i += 4) {
        if (s[i] < 255) {
          opaque = false;
          break;
        }
      }
    }
    if (opaque) {
      d.set(s);
      return dst;
    }
  }

  for (let y = y0; y <= y1; y++) {
    let p = y * w + x0;
    for (let x = x0; x <= x1; x++, p++) {
      const i = p << 2;
      let coverage = opacity;
      if (maskData) {
        const m = maskData[p];
        coverage *= maskInvert ? 1 - m : m;
      }
      let sa = (s[i + 3] / 255) * coverage;
      if (sa <= 0) continue;
      if (sa > 1) sa = 1;

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
        const inv = 1 - sa;
        if (plain) {
          d[i] = d[i] * inv + s[i] * sa;
          d[i + 1] = d[i + 1] * inv + s[i + 1] * sa;
          d[i + 2] = d[i + 2] * inv + s[i + 2] * sa;
        } else {
          d[i] = d[i] + (blendChannel(mode, d[i], s[i]) - d[i]) * sa;
          d[i + 1] = d[i + 1] + (blendChannel(mode, d[i + 1], s[i + 1]) - d[i + 1]) * sa;
          d[i + 2] = d[i + 2] + (blendChannel(mode, d[i + 2], s[i + 2]) - d[i + 2]) * sa;
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
      const invOut = outA > 0 ? 1 / outA : 0;
      for (let c = 0; c < 3; c++) {
        const base = d[i + c];
        const source = s[i + c];
        const blended = plain ? source : blendChannel(mode, base, source);
        // W3C source-over blending in premultiplied form, converted back to the
        // straight-alpha representation used by ImageData.
        const premult =
          sa * (1 - da) * source + sa * da * blended + (1 - sa) * da * base;
        d[i + c] = premult * invOut;
      }
      d[i + 3] = outA * 255;
    }
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
 *
 * Pass `ctx` so the full-frame scratch comes from the render context's pool:
 * it is then reused across preview frames but released with the context, rather
 * than pinning an export-sized Float32Array for the life of the worker.
 */
export function boxBlurBuf(buf, radiusX, radiusY = radiusX, ctx = null) {
  const rx = Math.max(0, Math.round(radiusX));
  const ry = Math.max(0, Math.round(radiusY));
  if (rx < 1 && ry < 1) return buf;
  const { w, h, data } = buf;
  const n = w * h * 4;
  const pooled = typeof ctx?.acquireF32 === "function";
  const tmp = pooled ? ctx.acquireF32(n) : new Float32Array(n);

  for (let pass = 0; pass < 2; pass++) {
    if (rx >= 1) {
      const inv = 1 / (2 * rx + 1);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum0 = 0;
        let sum1 = 0;
        let sum2 = 0;
        let sum3 = 0;
        for (let x = -rx; x <= rx; x++) {
          const i = (row + (x < 0 ? 0 : x >= w ? w - 1 : x)) << 2;
          sum0 += data[i];
          sum1 += data[i + 1];
          sum2 += data[i + 2];
          sum3 += data[i + 3];
        }
        for (let x = 0; x < w; x++) {
          const o = (row + x) << 2;
          tmp[o] = sum0 * inv;
          tmp[o + 1] = sum1 * inv;
          tmp[o + 2] = sum2 * inv;
          tmp[o + 3] = sum3 * inv;
          const outX = x - rx;
          const addX = x + rx + 1;
          const out = (row + (outX < 0 ? 0 : outX >= w ? w - 1 : outX)) << 2;
          const add = (row + (addX < 0 ? 0 : addX >= w ? w - 1 : addX)) << 2;
          sum0 += data[add] - data[out];
          sum1 += data[add + 1] - data[out + 1];
          sum2 += data[add + 2] - data[out + 2];
          sum3 += data[add + 3] - data[out + 3];
        }
      }
      for (let i = 0; i < n; i++) data[i] = tmp[i];
    }

    if (ry >= 1) {
      const inv = 1 / (2 * ry + 1);
      for (let x = 0; x < w; x++) {
        let sum0 = 0;
        let sum1 = 0;
        let sum2 = 0;
        let sum3 = 0;
        for (let y = -ry; y <= ry; y++) {
          const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
          const i = (yy * w + x) << 2;
          sum0 += data[i];
          sum1 += data[i + 1];
          sum2 += data[i + 2];
          sum3 += data[i + 3];
        }
        for (let y = 0; y < h; y++) {
          const o = (y * w + x) << 2;
          tmp[o] = sum0 * inv;
          tmp[o + 1] = sum1 * inv;
          tmp[o + 2] = sum2 * inv;
          tmp[o + 3] = sum3 * inv;
          const outY = y - ry;
          const addY = y + ry + 1;
          const oy = outY < 0 ? 0 : outY >= h ? h - 1 : outY;
          const ay = addY < 0 ? 0 : addY >= h ? h - 1 : addY;
          const out = (oy * w + x) << 2;
          const add = (ay * w + x) << 2;
          sum0 += data[add] - data[out];
          sum1 += data[add + 1] - data[out + 1];
          sum2 += data[add + 2] - data[out + 2];
          sum3 += data[add + 3] - data[out + 3];
        }
      }
      for (let i = 0; i < n; i++) data[i] = tmp[i];
    }
  }
  if (pooled) ctx.releaseF32(tmp);
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
