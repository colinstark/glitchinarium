/**
 * App bootstrap.
 *
 * The stage is a plain Canvas 2D element that letterboxes the preview. Every
 * pixel of actual image processing happens in the pipeline on typed arrays —
 * never through a sketch library.
 */

import { bufFromDrawable, bufToCanvas } from "./buffer.js";
import { planPreview, ARTWORK_UNITS, PREVIEW_EDGE } from "./context.js";
import { exportImage, downloadBlob, describeExport } from "./export.js";
import {
  getRenderClient,
  workerSupported,
  installRenderWorker,
  paintLayerPatch,
  layerLivePatch,
  onRenderFontsLoaded,
} from "./render/client.js";
import { createLayerStack } from "./ui/layers.js";
import { pickFile } from "./ui/controls.js";
import { brushState, attachBrush, onBrushChange, endPaint } from "./ui/brush.js";
import { randomizeParams, randomizeStack, SCOPES } from "./ui/randomize.js";
import { soleDirtyLayerId, clearDirtyLayers, stackSignature } from "./pipeline.js";
import {
  BUILTIN,
  instantiate,
  serialise,
  loadUserPresets,
  saveUserPreset,
} from "./ui/presets.js";

// Static entry URL so Bun HTML bundler can rewrite a real worker chunk.
installRenderWorker(new URL("./render/worker.js", import.meta.url));

const $ = (id) => document.getElementById(id);

const state = {
  layers: [],
  seed: 1,
  scale: 2,
  format: "png", // "png" | "jpg"
  /** Caps SSAA: "fast" | "balanced" | "quality" */
  exportQuality: "balanced",
  image: null, // { drawable, w, h, name }
  /** Decoded preview buffer on main (also sticky-copied into the worker). */
  previewSource: null,
  previewCanvas: null,
  /** Size/seed key for preview source + worker sticky source. */
  cacheKey: "",
  /** True when the worker already holds the buffer for `cacheKey`. */
  workerHasSource: false,
  /**
   * Signature of the stack the worker last received IN FULL, or null. Layer
   * patches are only valid while this still matches the live stack.
   */
  workerLayerSig: null,
  rendering: false,
  /** Where the preview was letterboxed on the canvas — the brush needs it. */
  viewport: null,
  /** Masks from the last render, so the brush can show a quick-mask overlay. */
  lastMasks: null,
  /** Layer id whose mask is overlaid on the stage (View mask / paint mode). */
  previewMaskId: null,
};

// ----------------------------------------------------------------- stage

const holder = $("canvas-holder");
const stage = $("stage");

const stageCanvas = document.createElement("canvas");
stageCanvas.style.width = "100%";
stageCanvas.style.height = "100%";
stageCanvas.style.display = "block";
holder.appendChild(stageCanvas);
const stageCtx = stageCanvas.getContext("2d");

/**
 * Stage size in CSS pixels (layout). Drawing uses a devicePixelRatio-backed
 * buffer so the stage stays sharp on retina; coordinates stay in CSS space via
 * setTransform(dpr, …).
 */
let stageW = 1;
let stageH = 1;
/** Active backing scale (usually window.devicePixelRatio). */
let stageDpr = 1;

let quickMask = null;
let quickMaskImg = null;
/** Stamp / data ref for last baked overlay — avoids full float→RGBA each frame. */
let maskOverlayStamp = "";
let maskOverlayData = null;

/** Stage size in CSS pixels — never trust a 0×0 first paint. */
function stageSize() {
  const w = Math.max(1, Math.floor(holder.clientWidth || stage.clientWidth || 1));
  const h = Math.max(1, Math.floor(holder.clientHeight || stage.clientHeight || 1));
  return { w, h };
}

/** Cap DPR so a huge desktop canvas does not balloon memory (3× is plenty). */
function stageDevicePixelRatio() {
  const raw = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return Math.max(1, Math.min(3, raw));
}

/** Keep the drawing buffer matched to the stage so letterboxing stays accurate. */
function fitStage() {
  const { w, h } = stageSize();
  const dpr = stageDevicePixelRatio();
  if (stageW !== w || stageH !== h || stageDpr !== dpr) {
    stageW = w;
    stageH = h;
    stageDpr = dpr;
    // Backing store in device pixels; CSS size stays 100% via style.
    stageCanvas.width = Math.max(1, Math.round(w * dpr));
    stageCanvas.height = Math.max(1, Math.round(h * dpr));
  }
  paintStage();
}

/** Map drawing into CSS-pixel space on the DPR-scaled buffer. */
function stageCssTransform() {
  stageCtx.setTransform(stageDpr, 0, 0, stageDpr, 0, 0);
}

/** Blit the preview (and optional mask overlay) into the stage with letterboxing. */
function paintStage() {
  stageCssTransform();
  stageCtx.clearRect(0, 0, stageW, stageH);
  const src = state.previewCanvas;
  if (!src) {
    state.viewport = null;
    return;
  }

  // Letterbox the preview into the stage with a small margin (CSS pixels).
  const k = Math.min(stageW / src.width, stageH / src.height) * 0.96;
  const w = src.width * k;
  const h = src.height * k;
  const x = (stageW - w) / 2;
  const y = (stageH - h) / 2;
  state.viewport = { x, y, w, h };

  stageCtx.imageSmoothingEnabled = true;
  stageCtx.imageSmoothingQuality = "high";
  stageCtx.drawImage(src, x, y, w, h);

  // Mask overlay while viewing or painting — pink where the mask is white.
  // Rebuild only when size / revision / buffer identity changes.
  const overlayId = brushState.layer?.id ?? state.previewMaskId;
  if (overlayId) {
    const mask = state.lastMasks?.get(overlayId);
    if (mask) {
      const stamp =
        mask._rev != null
          ? `${overlayId}|${mask.w}x${mask.h}|r${mask._rev}`
          : `${overlayId}|${mask.w}x${mask.h}|${mask.data.length}`;
      const dataRef = mask.data;
      if (
        !quickMask ||
        quickMask.width !== mask.w ||
        quickMask.height !== mask.h ||
        maskOverlayStamp !== stamp ||
        (mask._rev == null && maskOverlayData !== dataRef)
      ) {
        if (!quickMask || quickMask.width !== mask.w || quickMask.height !== mask.h) {
          quickMask = document.createElement("canvas");
          quickMask.width = mask.w;
          quickMask.height = mask.h;
        }
        maskOverlayStamp = stamp;
        maskOverlayData = dataRef;
        const qc = quickMask.getContext("2d");
        // Reuse ImageData backing store across rebuilds of the same size.
        if (!quickMaskImg || quickMaskImg.width !== mask.w || quickMaskImg.height !== mask.h) {
          quickMaskImg = qc.createImageData(mask.w, mask.h);
        }
        const px = quickMaskImg.data;
        const md = mask.data;
        for (let i = 0, n = md.length; i < n; i++) {
          const o = i * 4;
          const v = md[i];
          px[o] = 255;
          px[o + 1] = 40;
          px[o + 2] = 70;
          px[o + 3] = v * 160;
        }
        qc.putImageData(quickMaskImg, 0, 0);
      }
      stageCtx.drawImage(quickMask, x, y, w, h);
    }
    stageCtx.strokeStyle = "rgba(255,255,255,0.85)";
    // 1 CSS px stroke (becomes ~dpr device pixels) — visible hairline on retina.
    stageCtx.lineWidth = 1;
    stageCtx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  }
}

// Match holder after layout settles (first paint can be 0×0 without absolute fill).
queueMicrotask(fitStage);

document.addEventListener("glitchinarium:mask-preview", () => paintStage());

// The worker registers its webfonts after boot rather than blocking on them.
// Glyph layers measure text, so whatever it rendered first used fallback
// metrics — drop the layer cache and redraw once the real faces land.
onRenderFontsLoaded(() => {
  invalidateCache();
  if (state.image) scheduleRender();
});

// Observe the stage (not only the holder) so flex/grid reflows always refit.
const stageResize = new ResizeObserver(() => fitStage());
stageResize.observe(stage);
stageResize.observe(holder);

// Cross-monitor / zoom: DPR can change without a layout-only ResizeObserver fire.
if (typeof window !== "undefined") {
  window.addEventListener("resize", () => fitStage());
  if (typeof window.matchMedia === "function") {
    let dprMq = null;
    const watchDpr = () => {
      try {
        dprMq?.removeEventListener?.("change", onDprMq);
      } catch {
        /* ignore */
      }
      try {
        dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        dprMq.addEventListener?.("change", onDprMq);
      } catch {
        dprMq = null;
      }
    };
    const onDprMq = () => {
      fitStage();
      watchDpr();
      // Preview pixel budget tracks DPR — re-render so the image is not soft.
      if (state.image) scheduleRender();
    };
    watchDpr();
  }
}

// ----------------------------------------------------------------- render

let pending = null;
let pendingPaintRaf = 0;
/** True when a render was requested while export held the pipeline. */
let renderAfterExport = false;
/** Monotonic id so a superseded async preview can bail out. */
let previewSeq = 0;
/** Serialise preview runs so two jobs never race on the stage canvas. */
let previewChain = Promise.resolve();
const PAINT_PREVIEW_EDGE = 540;
/** Long-edge while dragging a slider — cheap enough to re-run the stack live. */
const SCRUB_PREVIEW_EDGE = 520;
/** Trailing debounce for non-scrub slider/stack edits (ms). */
const PREVIEW_DEBOUNCE_MS = 40;
/** Settle debounce after scrub ends before full-res preview (ms). */
const SCRUB_SETTLE_MS = 80;

/** True while a range control is being dragged (or key-held). */
let scrubActive = false;

/**
 * Preview long-edge budget.
 * - Paint / scrub: lower edge for interactive feel
 * - Idle: scale with DPR so retina is not a soft upscale of a 1× buffer
 */
function previewMaxEdge(painting) {
  const dpr = stageDevicePixelRatio();
  if (painting) return Math.round(PAINT_PREVIEW_EDGE * Math.min(dpr, 1.5));
  if (scrubActive) return Math.round(SCRUB_PREVIEW_EDGE * Math.min(dpr, 1.5));
  return Math.round(PREVIEW_EDGE * Math.min(dpr, 2));
}

const renderClient = getRenderClient();

/**
 * Consecutive retries after a still-current preview returned null (unexpected
 * abort). Deliberately NOT keyed on the preview seq: each retry goes through
 * scheduleRender, which mints a new seq, so a per-seq counter would reset every
 * attempt and never reach its cap. Reset on the next successful render.
 */
let previewRetries = 0;

function enqueuePreview() {
  const seq = ++previewSeq;
  // Abort in-flight work — only the latest seq is allowed to paint the stage.
  renderClient.abort();
  previewChain = previewChain.then(() => renderPreview(seq)).catch((err) => {
    console.error(err);
    const msg = String(err?.message || err);
    if (/worker/i.test(msg)) {
      setStatus("Preview using main thread");
      // Worker path failed open — force a main-thread retry with a full payload.
      if (seq === previewSeq && state.image) {
        state.workerLayerSig = null;
        state.workerHasSource = false;
        scheduleRender();
      }
      return;
    }
    setStatus(`Preview failed: ${msg}`);
  });
}

/**
 * Schedule a preview re-render.
 * - Paint / scrub: coalesce to one rAF (input flood → single latest job)
 * - Everything else: trailing debounce so discrete edits stay smooth
 */
function scheduleRender() {
  updateExportMeta();

  const interactive = brushState.active || scrubActive;

  if (interactive) {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    if (pendingPaintRaf) return;
    pendingPaintRaf = requestAnimationFrame(() => {
      pendingPaintRaf = 0;
      enqueuePreview();
    });
    return;
  }

  if (pendingPaintRaf) {
    cancelAnimationFrame(pendingPaintRaf);
    pendingPaintRaf = 0;
  }
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    enqueuePreview();
  }, PREVIEW_DEBOUNCE_MS);
}

document.addEventListener("glitchinarium:scrub", (e) => {
  const on = !!e.detail?.active;
  if (on === scrubActive) return;
  scrubActive = on;
  if (!on && state.image) {
    // Drop interactive rAF and settle at full preview resolution.
    if (pendingPaintRaf) {
      cancelAnimationFrame(pendingPaintRaf);
      pendingPaintRaf = 0;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      enqueuePreview();
    }, SCRUB_SETTLE_MS);
  }
});

/**
 * Drop layer cache (worker + local fallback). Optionally drop sticky source
 * and/or sticky layer DTO. Source size changes should keep the layer DTO —
 * params are artwork-unit and stay valid across preview resolutions.
 */
function invalidateCache({ clearSource = false, clearLayers = true } = {}) {
  if (clearSource) state.workerHasSource = false;
  if (clearLayers) state.workerLayerSig = null;
  renderClient.invalidateCache({ clearSource, clearLayers });
}

/** Merge worker mask payload into sticky lastMasks (supports deltas). */
function mergeMasks(result) {
  if (!result) return;
  if (!result.maskDeltas) {
    if (result.masks?.size) state.lastMasks = result.masks;
    return;
  }
  if (!state.lastMasks) state.lastMasks = new Map();
  for (const [id, m] of result.masks ?? []) {
    state.lastMasks.set(id, m);
  }
  for (const id of result.removedMaskIds ?? []) {
    state.lastMasks.delete(id);
  }
  // unchangedMaskIds: keep existing entries as-is
}

/** Apply a preview result buffer or ImageBitmap onto state.previewCanvas. */
function applyPreviewPixels(result) {
  if (!result || result.paintOnly) return false;
  if (result.bitmap) {
    const bmp = result.bitmap;
    const w = bmp.width;
    const h = bmp.height;
    if (!w || !h) {
      if (typeof bmp.close === "function") {
        try {
          bmp.close();
        } catch {
          /* ignore */
        }
      }
      return false;
    }
    if (!state.previewCanvas || state.previewCanvas.width !== w || state.previewCanvas.height !== h) {
      state.previewCanvas = document.createElement("canvas");
      state.previewCanvas.width = w;
      state.previewCanvas.height = h;
    }
    const g = state.previewCanvas.getContext("2d");
    g.clearRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0);
    if (typeof bmp.close === "function") {
      try {
        bmp.close();
      } catch {
        /* ignore */
      }
    }
    return true;
  }
  if (result.buf) {
    state.previewCanvas = bufToCanvas(result.buf, state.previewCanvas ?? undefined);
    return true;
  }
  return false;
}

/**
 * Blit the decoded source into the stage immediately so a slow/aborted stack
 * render cannot leave "metadata set, blank stage". Full preview overwrites this.
 */
function showSourcePlaceholder() {
  if (!state.image?.drawable) return;
  try {
    const plan = planPreview(
      state.image.w,
      state.image.h,
      previewMaxEdge(false)
    );
    state.previewSource = bufFromDrawable(
      state.image.drawable,
      plan.renderW,
      plan.renderH
    );
    state.cacheKey = `${plan.renderW}x${plan.renderH}`;
    state.workerHasSource = false;
    state.previewCanvas = bufToCanvas(state.previewSource, state.previewCanvas ?? undefined);
    paintStage();
  } catch (err) {
    console.warn("[preview] source placeholder failed:", err?.message || err);
  }
}

/**
 * Replace the whole stack. Ends paint mode and clears mask preview so we never
 * keep a brush attached to a layer that is no longer in the list.
 */
function replaceStack(next) {
  if (brushState.layer) endPaint();
  state.previewMaskId = null;
  state.layers = next;
  // Layer identities change — cache keys are invalid.
  invalidateCache();
}

async function renderPreview(seq) {
  if (!state.image) return;
  // Export owns the pipeline; don't drop the request — run once it finishes.
  if (state.rendering) {
    renderAfterExport = true;
    return;
  }
  // Superseded while waiting on the serialisation chain.
  if (seq !== previewSeq) return;

  const painting = !!(brushState.active && brushState.layer);
  const paintLayer = painting ? brushState.layer : null;
  const paintIndex = paintLayer
    ? state.layers.findIndex((l) => l.id === paintLayer.id)
    : -1;

  const plan = planPreview(state.image.w, state.image.h, previewMaxEdge(painting));
  // Source pixels depend only on image + size. Seed is not in the sticky key —
  // it only invalidates the layer cache (processors re-roll).
  const sourceKey = `${plan.renderW}x${plan.renderH}`;
  let sendSource = false;
  if (sourceKey !== state.cacheKey) {
    state.previewSource = bufFromDrawable(
      state.image.drawable,
      plan.renderW,
      plan.renderH
    );
    state.cacheKey = sourceKey;
    state.workerHasSource = false;
    // Keep sticky layer DTO across scrub/full size flips — only drop source cache.
    invalidateCache({ clearSource: true, clearLayers: false });
    sendSource = true;
  } else if (!state.workerHasSource || !state.previewSource) {
    if (!state.previewSource) {
      state.previewSource = bufFromDrawable(
        state.image.drawable,
        plan.renderW,
        plan.renderH
      );
    }
    sendSource = true;
  }
  // Mid-stroke: recompute only through the paint mask for the pink overlay.
  // Keep the last full-stack preview canvas so the image does not flicker.
  const paintFast = painting && paintIndex >= 0 && !!state.previewCanvas;

  const t0 = performance.now();
  await renderClient.ready;
  if (seq !== previewSeq || state.rendering) {
    if (state.rendering) renderAfterExport = true;
    return;
  }

  // Sticky worker layers: paint sends strokes only; sliders send one-layer patch.
  //
  // A patch rewrites ONE layer of the worker's sticky DTO, so it is only a
  // valid substitute for the full stack while two things hold: the DTO still
  // describes this exact stack (adding / deleting / reordering changes the
  // signature), and exactly one layer has pending edits (a patch cannot carry
  // the second layer's changes).
  const stackSig = stackSignature(state.layers);
  const workerStackFresh = renderClient.supported && state.workerLayerSig === stackSig;

  const usePaintPatch = paintFast && workerStackFresh && !!paintLayer;

  const dirtyId = paintFast ? null : soleDirtyLayerId();
  const editLayer = dirtyId ? state.layers.find((l) => l.id === dirtyId) : null;
  const useLivePatch = !usePaintPatch && !!editLayer && workerStackFresh;

  // Masks only when overlay/paint needs them — skip transfer while scrubbing params.
  const needMasks =
    paintFast ||
    !!brushState.layer ||
    !!state.previewMaskId;

  const scrubbing = scrubActive && !painting;

  // The worker folds a patch into its sticky DTO on receipt, whether or not the
  // render that carried it completes — so once this job is posted the edits are
  // accounted for. A full DTO covers them by definition.
  clearDirtyLayers();

  const result = await renderClient.renderJob(
    {
      mode: "preview",
      sourceBuf: state.previewSource,
      sourceKey,
      sendSource,
      layers:
        usePaintPatch || useLivePatch
          ? undefined
          : paintFast
            ? state.layers.slice(0, paintIndex + 1)
            : state.layers,
      layerPatch: usePaintPatch
        ? paintLayerPatch(paintLayer)
        : useLivePatch
          ? layerLivePatch(editLayer)
          : null,
      seed: state.seed,
      ssaa: 1,
      renderW: plan.renderW,
      renderH: plan.renderH,
      interactivePaint: painting,
      endIndex: paintFast ? paintIndex + 1 : undefined,
      skipCache: paintFast,
      useCache: !paintFast,
      returnMasks: needMasks,
      paintOnly: paintFast,
      maskDeltas: true,
      maskIds: paintFast && paintLayer ? [paintLayer.id] : null,
      preferBitmap: true,
      // Fewer yields while scrubbing — progress is not shown mid-drag.
      yieldMs: paintFast || scrubbing ? 32 : 8,
    },
    {
      shouldAbort: () => seq !== previewSeq || state.rendering,
    }
  );

  if (seq !== previewSeq || state.rendering) {
    if (state.rendering) renderAfterExport = true;
    return;
  }

  // Aborted (null) while still the active request — re-schedule a few times so
  // a cancelled worker job cannot strand the stage with only source metadata.
  if (!result) {
    if (previewRetries < 2) {
      previewRetries++;
      scheduleRender();
    } else {
      setStatus("Preview interrupted — nudge a slider or reload the image");
    }
    return;
  }

  previewRetries = 0;

  if (sendSource) state.workerHasSource = true;
  // Full DTO landed on the worker (or local). Patches keep sticky.
  // The paint fast-path sends only a PREFIX of the stack, so it must not leave
  // the worker's DTO marked authoritative — the layers above would be lost.
  if (!usePaintPatch && !useLivePatch) {
    state.workerLayerSig = renderClient.supported && !paintFast ? stackSig : null;
  }

  const ms = performance.now() - t0;
  if (needMasks) mergeMasks(result);
  const painted = applyPreviewPixels(result);
  if (!painted && !result.paintOnly && state.previewSource) {
    // Missing bitmap/buffer — keep the stage honest with the decoded source.
    state.previewCanvas = bufToCanvas(state.previewSource, state.previewCanvas ?? undefined);
  }
  paintStage();

  const active = state.layers.filter((l) => l.enabled).length;
  const backend = renderClient.supported ? "worker" : "main";
  setStatus(
    paintFast
      ? `paint · ${plan.renderW}×${plan.renderH} · ${ms.toFixed(0)} ms · ${backend}`
      : scrubbing
        ? `scrub · ${plan.renderW}×${plan.renderH} · ${ms.toFixed(0)} ms · ${backend}`
        : `${plan.renderW}×${plan.renderH} preview · ${active}/${state.layers.length} layers · ${ms.toFixed(0)} ms · ${backend}`
  );
}

/** Live status line + optional export plan, painted as one stage pill. */
let statusLine = "Ready · drop an image";
let exportLine = "";
let exportHeavy = false;

function paintStatus() {
  const el = $("status");
  el.textContent = exportLine ? `${statusLine} · ${exportLine}` : statusLine;
  el.classList.toggle("is-heavy", exportHeavy);
}

function setStatus(text) {
  statusLine = text;
  paintStatus();
}

// ------------------------------------------------------------ image input

/** Some OS/browser drops leave `file.type` empty — accept by extension too. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;

function isImageFile(file) {
  if (!file) return false;
  if (file.type) return file.type.startsWith("image/");
  return IMAGE_EXT.test(file.name || "");
}

function hasFileDrag(e) {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // DOMStringList or array — both support includes / contains.
  if (typeof types.includes === "function") return types.includes("Files");
  if (typeof types.contains === "function") return types.contains("Files");
  return [...types].includes("Files");
}

async function decodeImageFile(file) {
  // Prefer createImageBitmap: no object URL lifecycle, works for most formats.
  try {
    const bmp = await createImageBitmap(file);
    return { drawable: bmp, w: bmp.width, h: bmp.height };
  } catch {
    // Fallback for environments/formats createImageBitmap rejects.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("browser could not decode this file"));
        im.src = url;
      });
      return { drawable: img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Bumped on every load attempt so a slower earlier decode cannot win. */
let loadGen = 0;

/** Sidebar Source dropzone thumb — letterboxed into a fixed square. */
function updateSourceThumb(drawable, w, h) {
  const thumb = $("source-thumb");
  if (!thumb || !drawable || !w || !h) {
    if (thumb) {
      thumb.hidden = true;
      const g = thumb.getContext("2d");
      if (g) g.clearRect(0, 0, thumb.width, thumb.height);
    }
    return;
  }

  const size = 48;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(size * dpr);
  thumb.width = px;
  thumb.height = px;
  thumb.hidden = false;

  const g = thumb.getContext("2d");
  if (!g) return;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, px, px);
  g.fillStyle = getComputedStyle(thumb).backgroundColor || "#000";
  g.fillRect(0, 0, px, px);

  const scale = Math.min(px / w, px / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const dx = Math.floor((px - dw) / 2);
  const dy = Math.floor((px - dh) / 2);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(drawable, dx, dy, dw, dh);
}

async function loadImageFile(file) {
  if (!file) return;
  if (state.rendering) {
    setStatus("Export in progress — wait before loading a new image");
    return;
  }
  if (!isImageFile(file)) {
    setStatus(`Not an image: ${file.name || "unknown file"}`);
    return;
  }

  const gen = ++loadGen;
  setStatus(`Loading ${file.name}…`);
  try {
    const decoded = await decodeImageFile(file);
    // A newer pick/drop started while we were decoding — discard this result.
    if (gen !== loadGen) {
      if (decoded.drawable && typeof decoded.drawable.close === "function") {
        try {
          decoded.drawable.close();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // Release a previous ImageBitmap so we don't leak GPU memory.
    if (state.image?.drawable && typeof state.image.drawable.close === "function") {
      try {
        state.image.drawable.close();
      } catch {
        /* ignore */
      }
    }
    state.image = { ...decoded, name: file.name };

    $("dropzone-label").textContent = state.image.name;
    $("source-meta").textContent = `${state.image.w} × ${state.image.h}`;
    $("dropzone").classList.add("has-file");
    updateSourceThumb(state.image.drawable, state.image.w, state.image.h);
    $("stage").classList.add("has-image");
    $("export-btn").disabled = false;
    state.cacheKey = "";
    state.workerHasSource = false;
    state.workerLayerSig = null;
    state.lastMasks = null;
    invalidateCache({ clearSource: true, clearLayers: true });
    // Drop stale stack pixels, show source immediately, then full preview.
    // Avoids "metadata filled in, blank stage" when the first job is aborted
    // or delayed (worker boot, supersede race, fonts, etc.).
    state.previewCanvas = null;
    showSourcePlaceholder();
    updateExportMeta();
    // Immediate enqueue (not debounced) — supersedes in-flight work via seq.
    enqueuePreview();
  } catch (err) {
    if (gen !== loadGen) return;
    console.error(err);
    setStatus(`Could not load image: ${err.message || err}`);
  }
}

const dropzone = $("dropzone");
const sourceInput = $("source-input");

function openSourcePicker() {
  sourceInput.value = "";
  sourceInput.click();
}

dropzone.addEventListener("click", openSourcePicker);
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openSourcePicker();
  }
});
sourceInput.addEventListener("change", () => {
  const file = sourceInput.files?.[0];
  if (file) loadImageFile(file);
});

// Stop the browser from navigating away when a file is dropped anywhere.
window.addEventListener("dragover", (e) => {
  if (hasFileDrag(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (hasFileDrag(e)) e.preventDefault();
});

for (const node of [dropzone, stage]) {
  node.addEventListener("dragenter", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    dropzone.classList.add("is-over");
  });
  node.addEventListener("dragover", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dropzone.classList.add("is-over");
  });
  node.addEventListener("dragleave", (e) => {
    // Ignore leave events that are still inside this target (child spans).
    if (e.relatedTarget && node.contains(e.relatedTarget)) return;
    dropzone.classList.remove("is-over");
  });
  node.addEventListener("drop", (e) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("is-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) loadImageFile(file);
  });
}

// ------------------------------------------------------------------ brush

/** Canvas client coords → normalised 0..1 image coords, or null if outside. */
function stageToImage(clientX, clientY) {
  const vp = state.viewport;
  if (!vp) return null;
  const rect = stageCanvas.getBoundingClientRect();
  // Pointer is in CSS pixels; viewport is stored in the same CSS space (DPR is
  // only applied via setTransform when painting).
  const sx = ((clientX - rect.left) / rect.width) * stageW;
  const sy = ((clientY - rect.top) / rect.height) * stageH;
  const nx = (sx - vp.x) / vp.w;
  const ny = (sy - vp.y) / vp.h;
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
  return { x: nx, y: ny };
}

attachBrush(stage, stageToImage);

onBrushChange(() => {
  stage.classList.toggle("is-painting", !!brushState.layer);
  paintStage();
});

// ---------------------------------------------------------------- globals

const seedInput = $("seed");
seedInput.addEventListener("input", () => {
  const n = Number(seedInput.value);
  state.seed = Number.isFinite(n) ? n : 1;
  $("seed-value").textContent = state.seed;
  // Seed does not change source pixels — only drop layer cache.
  invalidateCache();
  scheduleRender();
});

$("seed-random").addEventListener("click", () => {
  seedInput.value = String(1 + Math.floor(Math.random() * 9999));
  seedInput.dispatchEvent(new Event("input"));
});

// ----------------------------------------------------------------- layers

const stack = createLayerStack({
  root: $("layer-stack"),
  addButton: $("add-layer"),
  getLayers: () => state.layers,
  setLayers: (next) => {
    state.layers = next;
  },
  onChange: scheduleRender,
  getPreviewScale: () => {
    if (!state.image) return 0;
    const plan = planPreview(state.image.w, state.image.h);
    return Math.max(plan.renderW, plan.renderH) / ARTWORK_UNITS;
  },
  getIntensity: () => randomizeIntensity,
  getPreviewMaskId: () => state.previewMaskId,
  setPreviewMaskId: (id) => {
    state.previewMaskId = id;
  },
});

$("stack-clear").addEventListener("click", () => {
  replaceStack([]);
  stack.render();
  scheduleRender();
});

// -------------------------------------------------------------- randomize

const scopeState = new Set(["tone", "halftone", "glyph", "warp", "glitch", "texture"]);
const scopesRoot = $("scopes");
let randomizeIntensity = 0.7;

const intensityInput = $("rand-intensity");
const intensityReadout = $("rand-intensity-value");
const syncIntensity = () => {
  randomizeIntensity = Number(intensityInput.value);
  intensityReadout.textContent = `${Math.round(randomizeIntensity * 100)}%`;
};
intensityInput.addEventListener("input", syncIntensity);
syncIntensity();

for (const cat of SCOPES) {
  const label = document.createElement("label");
  label.className = "scope";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = scopeState.has(cat.id);
  input.addEventListener("change", () => {
    if (input.checked) scopeState.add(cat.id);
    else scopeState.delete(cat.id);
  });
  label.append(input, document.createTextNode(cat.label));
  scopesRoot.append(label);
}

$("shuffle-params").addEventListener("click", () => {
  randomizeParams(state.layers, scopeState, randomizeIntensity);
  invalidateCache();
  stack.render();
  scheduleRender();
});

$("shuffle-stack").addEventListener("click", () => {
  replaceStack(randomizeStack(scopeState, randomizeIntensity));
  state.seed = 1 + Math.floor(Math.random() * 9999);
  seedInput.value = String(state.seed);
  $("seed-value").textContent = state.seed;
  // replaceStack already invalidates layer cache; seed change keeps sticky source.
  stack.render();
  scheduleRender();
});

// ---------------------------------------------------------------- presets

const presetSelect = $("preset");

function populatePresets() {
  const user = loadUserPresets();
  presetSelect.replaceChildren();

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Load preset…";
  presetSelect.append(blank);

  const group = (label, entries) => {
    if (!Object.keys(entries).length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [key, preset] of Object.entries(entries)) {
      const o = document.createElement("option");
      o.value = `${label}:${key}`;
      o.textContent = preset.name ?? key;
      g.append(o);
    }
    presetSelect.append(g);
  };

  group("Built in", BUILTIN);
  group("Saved", user);
}

function applyPreset(preset) {
  replaceStack(instantiate(preset));
  if (preset.seed != null) {
    state.seed = preset.seed;
    seedInput.value = String(preset.seed);
    $("seed-value").textContent = preset.seed;
  }
  // replaceStack already dropped layer cache; sticky source still valid.
  stack.render();
  scheduleRender();
}

presetSelect.addEventListener("change", () => {
  const value = presetSelect.value;
  if (!value) return;
  const [group, key] = value.split(":");
  const preset = group === "Built in" ? BUILTIN[key] : loadUserPresets()[key];
  if (preset) applyPreset(preset);
});

$("preset-save").addEventListener("click", () => {
  const name = prompt("Preset name");
  if (!name) return;
  try {
    saveUserPreset(
      name.trim().toLowerCase().replace(/\s+/g, "-"),
      serialise(name, state.seed, state.layers)
    );
    populatePresets();
    setStatus(`Saved preset “${name.trim()}”`);
  } catch (err) {
    setStatus(`Could not save preset: ${err.message || err}`);
  }
});

$("preset-export").addEventListener("click", () => {
  const spec = serialise("Untitled", state.seed, state.layers);
  const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
  downloadBlob(blob, "glitchinarium-preset.json");
});

$("preset-import").addEventListener("click", async () => {
  const file = await pickFile("application/json,.json");
  if (!file) return;
  try {
    applyPreset(JSON.parse(await file.text()));
  } catch (err) {
    setStatus(`Could not read preset: ${err.message}`);
  }
});

// ----------------------------------------------------------------- export

function activateSeg(group, active) {
  for (const b of group.querySelectorAll(".seg-btn")) {
    const on = b === active;
    b.classList.toggle("is-active", on);
    if (b.getAttribute("role") === "radio") b.setAttribute("aria-checked", on ? "true" : "false");
  }
}

const scaleGroup = $("export-scale");
scaleGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.scale = Number(btn.dataset.scale);
  activateSeg(scaleGroup, btn);
  updateExportMeta();
});

const formatGroup = $("export-format");
const exportBtn = $("export-btn");

function syncExportButtonLabel() {
  const label = state.format === "jpg" ? "JPG" : "PNG";
  exportBtn.textContent = `Export ${label}`;
}

formatGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  state.format = btn.dataset.format === "jpg" ? "jpg" : "png";
  activateSeg(formatGroup, btn);
  syncExportButtonLabel();
});

function updateExportMeta() {
  if (!state.image) {
    exportLine = "";
    exportHeavy = false;
    paintStatus();
    return;
  }
  const info = describeExport(
    state.image.w,
    state.image.h,
    state.scale,
    state.layers,
    state.exportQuality
  );
  // One long stage pill: preview stats · export size · peak memory.
  const bits = [
    info.label,
    `${info.ssaa}× SSAA`,
    `~${(info.estimatedWorkingBytes / 1e6).toFixed(0)} MB peak`,
  ];
  if (info.clamped) bits.push("clamped");
  exportLine = bits.join(" · ");
  exportHeavy = info.heavy || info.clamped;
  paintStatus();
}

const qualityGroup = $("export-quality");
if (qualityGroup) {
  qualityGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn?.dataset.quality) return;
    state.exportQuality = btn.dataset.quality;
    activateSeg(qualityGroup, btn);
    updateExportMeta();
  });
}

/** Set by the overlay's Cancel button; read by the export's shouldAbort. */
let exportCancelled = false;

const overlayCancel = $("overlay-cancel");
overlayCancel?.addEventListener("click", () => {
  if (!state.rendering) return;
  exportCancelled = true;
  overlayCancel.disabled = true;
  $("overlay-title").textContent = "Cancelling…";
});

exportBtn.addEventListener("click", async () => {
  if (!state.image || state.rendering) return;
  // Snapshot job inputs so a later stack edit cannot mutate the in-flight export.
  // (Image load is also blocked while rendering.)
  const job = {
    drawable: state.image.drawable,
    srcW: state.image.w,
    srcH: state.image.h,
    name: state.image.name,
    layers: state.layers,
    seed: state.seed,
    multiplier: state.scale,
    format: state.format,
    exportQuality: state.exportQuality,
  };

  state.rendering = true;
  exportCancelled = false;
  // Cancel any in-flight preview so it does not touch the cache mid-export.
  previewSeq++;
  exportBtn.disabled = true;
  const overlay = $("overlay");
  const fill = $("overlay-fill");
  if (overlayCancel) overlayCancel.disabled = false;
  overlay.hidden = false;

  try {
    const result = await exportImage({
      drawable: job.drawable,
      srcW: job.srcW,
      srcH: job.srcH,
      layers: job.layers,
      seed: job.seed,
      multiplier: job.multiplier,
      format: job.format,
      exportQuality: job.exportQuality,
      quality: job.format === "jpg" ? 0.92 : 0.95,
      shouldAbort: () => exportCancelled,
      onProgress: ({ phase, done, total, layer, plan }) => {
        fill.style.transform = `scaleX(${total ? done / total : 0})`;
        const titles = {
          decode: "Decoding…",
          render: `Rendering ${layer?.label ?? ""}…`,
          resolve: "Encoding…",
          done: "Done",
        };
        $("overlay-title").textContent = titles[phase] ?? `${phase}…`;
        $("overlay-note").textContent = `${plan.renderW} × ${plan.renderH} · ${plan.ssaa}× · ${done}/${total}`;
      },
    });
    if (!result) {
      setStatus("Export cancelled");
      return;
    }
    const { blob, width, height } = result;

    const base = job.name.replace(/\.[^.]+$/, "");
    const ext = job.format === "jpg" ? "jpg" : "png";
    downloadBlob(blob, `${base}-glitchinarium-${job.multiplier}x.${ext}`);
    setStatus(`Exported ${width} × ${height} · ${ext.toUpperCase()}`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
    console.error(err);
  } finally {
    overlay.hidden = true;
    fill.style.transform = "scaleX(0)";
    state.rendering = false;
    exportBtn.disabled = false;
    if (renderAfterExport) {
      renderAfterExport = false;
      scheduleRender();
    }
  }
});

// ------------------------------------------------------------------- init

// Warm the render worker (fonts + module graph). Falls back to main thread
// if the worker cannot boot (common under some dev servers).
renderClient.ready
  .then(() => {
    setStatus(
      renderClient.supported
        ? "Ready · drop an image · worker"
        : "Ready · drop an image · main"
    );
  })
  .catch(() => {
    setStatus("Ready · drop an image · main");
  });

populatePresets();
stack.render();
syncExportButtonLabel();
setStatus(
  workerSupported() ? "Ready · drop an image · starting…" : "Ready · drop an image · main"
);

// Glyph layers measure text, so the first render must wait for the webfonts —
// otherwise ASCII lays out against the fallback metrics and shifts once the
// real face arrives.
document.fonts.ready.then(() => {
  if (state.image) scheduleRender();
});
