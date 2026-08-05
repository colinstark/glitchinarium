/**
 * RenderContext — the object that enforces the scale contract.
 *
 * THE SCALE CONTRACT
 * ------------------
 * The source image defines an artwork-unit space whose LONGEST EDGE IS 1000
 * units, regardless of pixel size. Every processor parameter is stored in
 * artwork units (or normalised 0..1) and converted to pixels at use time via
 * `ctx.u(value)`.
 *
 * A ~900px preview and a 6000px export therefore describe the *same*
 * composition; the export simply resolves it with more detail. A processor
 * that reaches for a raw pixel count instead will silently produce a different
 * artwork at export size — that is the single most common way tools like this
 * break, and it is not visible until you export.
 */

import { mulberry32, hashSeed } from "./rng.js";

export const ARTWORK_UNITS = 1000;

/** Hard ceiling on the internal render edge — see the memory note in the plan. */
export const MAX_RENDER_EDGE = 8192;

/** Conservative browser working-set ceiling for a single export. */
export const MAX_WORKING_BYTES = 512 * 1024 * 1024;

// Peak live bytes per render pixel. The base pipeline retains the decoded
// source and accumulator; entries add each processor's largest temporary set.
// Unknown processors get the conservative default so adding one stays safe.
const BASE_WORKING_BPP = 16;
const PROCESSOR_WORKING_BPP = {
  glow: 32,
  mask: 28,
  detection: 28,
  dither: 24,
  crt: 28,
  ascii: 24,
  "edge-trace": 24,
  "symbol-scatter": 24,
  hatch: 24,
  contour: 24,
};

export function estimateWorkingBpp(layers = []) {
  let bpp = BASE_WORKING_BPP;
  for (const layer of layers) {
    if (layer?.enabled === false) continue;
    bpp = Math.max(bpp, PROCESSOR_WORKING_BPP[layer?.type] ?? 20);
  }
  return bpp;
}

/** Max supersample factor for the "quality" export tier. */
export const SUPERSAMPLE = 4;

/**
 * Export quality tiers — caps internal supersampling before memory clamps.
 * `fast` renders at output size (ssaa=1). `quality` keeps the classic 4× path.
 */
export const EXPORT_QUALITY = {
  fast: 1,
  balanced: 2,
  quality: 4,
};

/** Longest edge of the live preview, in pixels. */
export const PREVIEW_EDGE = 900;

/**
 * Work out the internal render size and the resolve factor for an export.
 *
 * `multiplier` is the user output scale (1, 2 or 4). Internal supersampling is
 * `min(qualityCap, SUPERSAMPLE / multiplier)`, so even 1× can be SSAA'd on the
 * quality tier, while fast always renders 1:1 with the target.
 *
 * @param {string} [quality="quality"]  "fast" | "balanced" | "quality"
 */
export function planExport(srcW, srcH, multiplier, layers = [], quality = "quality") {
  let targetW = Math.round(srcW * multiplier);
  let targetH = Math.round(srcH * multiplier);
  let outputClamped = false;

  // Hard cap on output first: even ssaa=1 must fit under MAX_RENDER_EDGE, or
  // a 40MP phone photo at 2× will allocate multi-gigabyte intermediate buffers.
  const targetEdge = Math.max(targetW, targetH);
  if (targetEdge > MAX_RENDER_EDGE) {
    const k = MAX_RENDER_EDGE / targetEdge;
    targetW = Math.max(1, Math.round(targetW * k));
    targetH = Math.max(1, Math.round(targetH * k));
    outputClamped = true;
  }

  const qualityCap = EXPORT_QUALITY[quality] ?? SUPERSAMPLE;
  // Classic contract: full quality wants SUPERSAMPLE/multiplier (e.g. 4× at 1× out).
  const idealSsaa = SUPERSAMPLE / Math.max(1, multiplier);
  let ssaa = Math.min(qualityCap, idealSsaa);
  // SSAA factor must stay an integer ≥ 1 so boxDownsample can resolve cleanly.
  ssaa = Math.max(1, Math.round(ssaa));
  // Keep ssaa a power-of-two when possible for clean box filters (1,2,4).
  if (ssaa === 3) ssaa = 2;

  let renderW = targetW * ssaa;
  let renderH = targetH * ssaa;
  const workingBpp = estimateWorkingBpp(layers);
  const maxPixels = Math.floor(MAX_WORKING_BYTES / workingBpp);
  let memoryLimited = false;

  // Drop supersampling before we drop output resolution further.
  while (
    ssaa > 1 &&
    (Math.max(renderW, renderH) > MAX_RENDER_EDGE || renderW * renderH > maxPixels)
  ) {
    if (renderW * renderH > maxPixels) memoryLimited = true;
    ssaa = Math.max(1, Math.floor(ssaa / 2));
    renderW = targetW * ssaa;
    renderH = targetH * ssaa;
  }

  // Final belt-and-braces: fit both the edge and total working-set ceilings.
  const renderEdge = Math.max(renderW, renderH);
  const pixelScale = Math.sqrt(maxPixels / (renderW * renderH));
  const edgeScale = MAX_RENDER_EDGE / renderEdge;
  const fit = Math.min(1, pixelScale, edgeScale);
  if (fit < 1) {
    memoryLimited ||= pixelScale < 1;
    targetW = Math.max(1, Math.floor(targetW * fit));
    targetH = Math.max(1, Math.floor(targetH * fit));
    renderW = targetW * ssaa;
    renderH = targetH * ssaa;
    outputClamped = true;
  }

  const idealAtQuality = Math.min(qualityCap, idealSsaa);
  return {
    renderW: Math.round(renderW),
    renderH: Math.round(renderH),
    targetW,
    targetH,
    ssaa,
    quality,
    qualityCap,
    workingBpp,
    estimatedWorkingBytes: Math.round(renderW * renderH * workingBpp),
    memoryLimited,
    clamped: outputClamped || ssaa < idealAtQuality,
  };
}

export function planPreview(srcW, srcH, maxEdge = PREVIEW_EDGE) {
  const long = Math.max(srcW, srcH);
  const k = Math.min(1, maxEdge / long);
  return {
    renderW: Math.max(1, Math.round(srcW * k)),
    renderH: Math.max(1, Math.round(srcH * k)),
    ssaa: 1,
  };
}

export function createContext({
  renderW,
  renderH,
  ssaa = 1,
  seed = 1,
  mode = "preview",
  onProgress = null,
  /** While painting: skip expensive mask post-process for interactive feel. */
  interactivePaint = false,
}) {
  const longEdge = Math.max(renderW, renderH);
  const scale = longEdge / ARTWORK_UNITS;

  /** Scratch Float32 pools keyed by length — mask stages reuse these. */
  const f32Pool = new Map();
  const acquireF32 = (len) => {
    const free = f32Pool.get(len);
    if (free?.length) return free.pop();
    return new Float32Array(len);
  };
  const releaseF32 = (arr) => {
    if (!arr) return;
    try {
      if (arr.buffer?.detached) return;
    } catch {
      return;
    }
    const len = arr.length;
    let free = f32Pool.get(len);
    if (!free) {
      free = [];
      f32Pool.set(len, free);
    }
    // Cap pool depth so a long session does not pin hundreds of export-sized buffers.
    if (free.length < 4) {
      arr.fill(0);
      free.push(arr);
    }
  };

  const ctx = {
    w: renderW,
    h: renderH,
    scale,
    ssaa,
    mode,
    seed,
    onProgress,
    interactivePaint,
    acquireF32,
    releaseF32,

    /** Artwork units → render pixels. */
    u: (v) => v * scale,

    /** Render pixels → artwork units. */
    toUnits: (px) => px / scale,

    /** Normalised 0..1 of the long edge → render pixels. */
    n: (v) => v * longEdge,

    /**
     * Quantise a pixel length so it survives the SSAA resolve as a hard edge.
     * A dither block of 4.7px would smear into grey after downsampling; snapped
     * to a multiple of the resolve factor it stays 1-bit crisp.
     */
    snap: (px) => Math.max(ssaa, Math.round(px / ssaa) * ssaa),

    /** Masks published by mask layers, keyed by layer id. */
    masks: new Map(),

    /** Per-layer state; set by the pipeline before each apply(). */
    layerIndex: 0,
    layerId: null,
    mods: null,
    rng: mulberry32(seed),

    /**
     * Seed for spatial noise. Processors pass this to noise2/fbm/curl so the
     * field is tied to the global seed but differs per layer.
     */
    noiseSeed: seed,

    /**
     * Shared 2D surface for glyph rasterisation.
     * Uses OffscreenCanvas in workers (and modern main threads when available)
     * so the same processors run off-main without document access.
     */
    _glyphCanvas: null,
    glyphCanvas() {
      if (!ctx._glyphCanvas) {
        if (typeof OffscreenCanvas === "function") {
          ctx._glyphCanvas = new OffscreenCanvas(renderW, renderH);
        } else if (typeof document !== "undefined") {
          ctx._glyphCanvas = document.createElement("canvas");
        } else {
          throw new Error("No canvas surface available for glyph processors");
        }
      }
      const c = ctx._glyphCanvas;
      if (c.width !== renderW || c.height !== renderH) {
        c.width = renderW;
        c.height = renderH;
      }
      return c;
    },
  };

  /**
   * Parameter modulation.
   *
   * A parameter can be bound to a mask so its value varies per pixel: mask
   * black gives `min`, mask white gives `max`. This is the displacement-map
   * idea generalised — grey level drives effect INTENSITY rather than opacity,
   * so a painted gradient can control how coarse the ASCII gets or how hard the
   * dither bites, not merely how much of it shows through.
   *
   * Returns a modulator with a monomorphic `at(x, y)`. When nothing is bound it
   * closes over a constant, so the call is free enough to sit in a hot loop and
   * processors do not need two code paths.
   *
   * `modPx` folds in the artwork-unit → pixel conversion, so a modulated length
   * obeys the scale contract exactly like a constant one would.
   */
  const makeModulator = (key, base, toPx) => {
    const k = toPx ? scale : 1;
    const m = ctx.mods?.[key];
    const mask = m && m.mask ? ctx.masks.get(m.mask) : null;

    if (!mask) {
      const v = base * k;
      return { constant: true, base: v, max: v, at: () => v, atIndex: () => v };
    }

    const lo = (m.min ?? 0) * k;
    const hi = (m.max ?? base) * k;
    const invert = !!m.invert;
    const data = mask.data;
    const mw = mask.w;
    const mh = mask.h;

    return {
      constant: false,
      base: base * k,
      /** Upper bound over the whole image — callers that pre-size buffers need it. */
      max: Math.max(lo, hi),
      at(x, y) {
        // Callers sample at cell/block centres, which can land just outside the
        // image at the right and bottom edges — clamp rather than read garbage
        // from the next row.
        const xi = x < 0 ? 0 : x >= mw ? mw - 1 : x | 0;
        const yi = y < 0 ? 0 : y >= mh ? mh - 1 : y | 0;
        const t = data[yi * mw + xi];
        return lo + (hi - lo) * (invert ? 1 - t : t);
      },
      /** Flat pixel index — masks are always at render resolution. */
      atIndex(i) {
        const t = data[i];
        return lo + (hi - lo) * (invert ? 1 - t : t);
      },
    };
  };

  ctx.mod = (key, base) => makeModulator(key, base, false);
  ctx.modPx = (key, base) => makeModulator(key, base, true);

  /** True if `key` is bound to a mask — lets grid processors switch to quadtree. */
  ctx.isModulated = (key) => {
    const m = ctx.mods?.[key];
    return !!(m && m.mask && ctx.masks.has(m.mask));
  };

  ctx.forLayer = (index, layer) => {
    const layerId = typeof layer === "object" ? layer?.id : layer;
    ctx.layerIndex = index;
    ctx.layerId = layerId ?? null;
    ctx.mods = typeof layer === "object" ? layer?.mods ?? null : null;
    const s = hashSeed(`${layerId ?? index}`, seed);
    ctx.rng = mulberry32(s);
    ctx.noiseSeed = s;
    return ctx;
  };

  return ctx;
}
