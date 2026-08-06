/**
 * Render worker — runs the layer pipeline off the main thread.
 *
 * Receives a transferable RGBA source + layer DTO, returns transferable pixels
 * (or an ImageBitmap for preview). Preview layer cache and sticky source live
 * here (not re-transferred each frame).
 */

import { createContext } from "../context.js";
import { renderAsync, stackSignature } from "../pipeline.js";
import {
  boxDownsample,
  bufFromTransfer,
  bufToTransfer,
  bufToImageData,
  createSurface,
} from "../buffer.js";
import { MSG, ERR_STALE_PATCH } from "./protocol.js";

/** @type {Array<{key:string, buf:any, masks:Map}>} */
let previewCache = [];
/** Sticky decoded source so preview frames only transfer when size/seed changes. */
let stickySource = null;
let stickySourceKey = null;
/** Last full layer DTO for preview — paint jobs patch strokes onto this. */
let stickyLayers = null;
/** Signature of stickyLayers (id:type order) — compared on patch jobs. */
let stickyStackSig = null;
/** Last transferred mask stamp per id — skip unchanged masks. */
let maskStamps = new Map();
let activeJobId = 0;
let abortRequested = false;
/** Serialises render jobs — see the RENDER case. */
let jobChain = Promise.resolve();

/** Reused OffscreenCanvas for preview ImageBitmap encoding. */
let bitmapCanvas = null;

async function loadFonts(fonts = []) {
  if (!fonts.length || typeof FontFace === "undefined" || !self.fonts) return;
  await Promise.all(
    fonts.map(async ({ family, buffer, weight = "400", style = "normal" }) => {
      try {
        const face = new FontFace(family, buffer, { weight, style });
        await face.load();
        self.fonts.add(face);
      } catch (err) {
        console.warn(`[render.worker] font “${family}” failed:`, err?.message || err);
      }
    })
  );
}

function clearSticky() {
  stickySource = null;
  stickySourceKey = null;
}

function clearLayerSticky() {
  stickyLayers = null;
  stickyStackSig = null;
  maskStamps = new Map();
}

/** Throw ERR_STALE_PATCH so main resends a full stack instead of demoting us. */
function throwStalePatch(message) {
  const err = new Error(message);
  err.code = ERR_STALE_PATCH;
  throw err;
}

function maskStamp(m) {
  if (m._rev != null) return `${m.w}x${m.h}|r${m._rev}`;
  // Fallback when processor did not stamp a revision.
  return `${m.w}x${m.h}|${m.data.length}|${m.bbox ? `${m.bbox.x0},${m.bbox.y0},${m.bbox.x1},${m.bbox.y1}` : "-"}`;
}

/**
 * Pack masks for transfer. With maskDeltas, skip payloads whose stamp matches
 * the last send. maskIds (if set) filters to those ids only.
 *
 * A stamp is a claim that MAIN ALREADY HOLDS this field, so it only becomes
 * true once the payload is delivered — which is why the new stamps are built
 * aside and handed back as `commitMaskStamps()` for the caller to run AFTER a
 * successful postMessage. Committing before postMessage (or at pack time) left
 * a job whose transfer threw, or one superseded before post, claiming main had
 * fields it never received; every later frame then reported those masks
 * `unchanged` and main kept an old one, freezing the overlay.
 */
function packMasks(ctx, { returnMasks, maskDeltas, maskIds }) {
  const masks = [];
  const transferList = [];
  const removedMaskIds = [];
  const nextStamps = new Map(maskStamps);
  const commitMaskStamps = () => {
    maskStamps = nextStamps;
  };
  if (!returnMasks || !ctx.masks?.size) {
    if (maskDeltas && nextStamps.size) {
      for (const id of nextStamps.keys()) removedMaskIds.push(id);
      nextStamps.clear();
    }
    return { masks, transferList, removedMaskIds, commitMaskStamps };
  }

  const allow = maskIds?.length ? new Set(maskIds) : null;
  const seen = new Set();

  for (const [maskId, m] of ctx.masks) {
    if (allow && !allow.has(maskId)) continue;
    seen.add(maskId);
    const stamp = maskStamp(m);
    if (maskDeltas && maskStamps.get(maskId) === stamp) {
      masks.push({ id: maskId, unchanged: true });
      continue;
    }
    nextStamps.set(maskId, stamp);
    const copy = m.data.buffer.slice(
      m.data.byteOffset,
      m.data.byteOffset + m.data.byteLength
    );
    masks.push({
      id: maskId,
      w: m.w,
      h: m.h,
      buffer: copy,
      rev: m._rev ?? null,
      bbox: m.bbox ?? null,
    });
    transferList.push(copy);
  }

  if (maskDeltas) {
    for (const id of [...nextStamps.keys()]) {
      if (!seen.has(id) && (!allow || allow.has(id))) {
        // Only drop stamps for masks we would have considered this frame.
        if (!allow || !ctx.masks.has(id)) {
          nextStamps.delete(id);
          removedMaskIds.push(id);
        }
      }
    }
    // Full mask map: remove stamps for masks no longer present.
    if (!allow) {
      for (const id of [...nextStamps.keys()]) {
        if (!ctx.masks.has(id)) {
          nextStamps.delete(id);
          if (!removedMaskIds.includes(id)) removedMaskIds.push(id);
        }
      }
    }
  }

  return { masks, transferList, removedMaskIds, commitMaskStamps };
}

async function bufToBitmap(buf) {
  if (typeof createImageBitmap !== "function") return null;
  try {
    if (!bitmapCanvas || bitmapCanvas.width !== buf.w || bitmapCanvas.height !== buf.h) {
      bitmapCanvas = createSurface(buf.w, buf.h);
    } else {
      // ensure size
      if (bitmapCanvas.width !== buf.w) bitmapCanvas.width = buf.w;
      if (bitmapCanvas.height !== buf.h) bitmapCanvas.height = buf.h;
    }
    const g = bitmapCanvas.getContext("2d");
    g.putImageData(bufToImageData(buf), 0, 0);
    return await createImageBitmap(bitmapCanvas);
  } catch {
    return null;
  }
}

/**
 * Run one render job to completion.
 *
 * Callers must have already claimed `activeJobId` (see the RENDER case) so an
 * in-flight predecessor sees itself superseded before this one starts.
 */
async function runRenderJob(id, job) {
  if (job.invalidateCache) {
    previewCache = [];
    maskStamps = new Map();
  }

  // Layers: full DTO replaces sticky; patch merges onto one sticky layer.
  let layers;
  if (job.layers) {
    stickyLayers = job.layers;
    // Derive from what we actually hold — do not trust a caller-supplied
    // signature, which would be the FULL stack even when the job carried only
    // a paint-fast PREFIX of the DTO.
    stickyStackSig = stackSignature(job.layers);
    layers = stickyLayers;
  } else if (job.layerPatch) {
    const patch = job.layerPatch;
    // Main only patches while it believes our sticky DTO is its current stack.
    // A missing target or a shape mismatch proves that belief is wrong.
    // Rendering the sticky stack anyway would drop the edit with no error —
    // the failure that looked like brush strokes silently refusing to land,
    // unrecoverable because every following patch preserved the same
    // divergence. Fail loudly: the client keeps us alive and main resends a
    // full stack.
    if (
      job.stackSignature != null &&
      stickyStackSig != null &&
      job.stackSignature !== stickyStackSig
    ) {
      throwStalePatch(
        `render worker: patch stack signature mismatch (got ${job.stackSignature}, sticky ${stickyStackSig})`
      );
    }
    const target = stickyLayers?.find((l) => l.id === patch.id);
    if (!target) {
      throwStalePatch(
        `render worker: patch target ${patch.id} is not in the sticky stack`
      );
    }
    if (patch.enabled !== undefined) target.enabled = patch.enabled;
    if (patch.opacity !== undefined) target.opacity = patch.opacity;
    if (patch.blend !== undefined) target.blend = patch.blend;
    if (patch.mask !== undefined) target.mask = patch.mask;
    if (patch.maskInvert !== undefined) target.maskInvert = patch.maskInvert;
    if (patch.maskFeather !== undefined) target.maskFeather = patch.maskFeather;
    if (patch.params) {
      // Full replace for slider patches; shallow merge for stroke-only paint.
      if (patch.params.strokes != null && Object.keys(patch.params).length === 1) {
        Object.assign(target.params, patch.params);
      } else {
        target.params = patch.params;
      }
    }
    if (patch.mods) target.mods = patch.mods;
    layers = stickyLayers;
  } else if (stickyLayers) {
    layers = stickyLayers;
  } else {
    throw new Error("render worker: layer stack missing");
  }

  const mode = job.mode === "export" ? "export" : "preview";

  // Source: export always carries its own buffer (do not clobber preview sticky).
  // Preview transfers when size changes, otherwise reuses sticky.
  let source;
  if (mode === "export") {
    if (!job.source) throw new Error("render worker: export requires a source buffer");
    source = bufFromTransfer(job.source);
  } else if (job.source) {
    stickySource = bufFromTransfer(job.source);
    stickySourceKey = job.sourceKey ?? null;
    source = stickySource;
  } else if (stickySource && (job.sourceKey == null || job.sourceKey === stickySourceKey)) {
    source = stickySource;
  } else {
    throw new Error("render worker: source buffer missing for this preview size");
  }

  // Superseded while queued behind the previous job. The sticky merges above had
  // to happen anyway — they are how the main thread's edits reach us, and it
  // stops resending them once the job is posted — but there is no point paying
  // for pixels nobody will look at.
  if (abortRequested || id !== activeJobId) {
    self.postMessage({ type: MSG.ABORTED, id });
    return;
  }

  const ctx = createContext({
    renderW: job.renderW,
    renderH: job.renderH,
    ssaa: job.ssaa ?? 1,
    seed: job.seed ?? 1,
    mode,
    interactivePaint: !!job.interactivePaint,
  });

  // Preview cache only when requested; paint-fast and export skip it.
  const useCache = mode === "preview" && job.useCache !== false && !job.skipCache;
  const cache = useCache ? previewCache : null;

  const totalSteps =
    mode === "export"
      ? Math.max(1, layers.length) + 2
      : Math.max(1, job.endIndex ?? layers.length);

  const rendered = await renderAsync(
    layers,
    source,
    ctx,
    cache,
    (s) => {
      if (abortRequested || id !== activeJobId) return;
      self.postMessage({
        type: MSG.PROGRESS,
        id,
        phase: "render",
        done: s.done,
        total: totalSteps,
        layerLabel: s.layer?.label ?? s.layer?.type ?? "",
      });
    },
    () => abortRequested || id !== activeJobId,
    {
      yieldMs: job.yieldMs ?? (mode === "export" ? 6 : 8),
      // Always the timer off-main: rAF is not implemented on
      // DedicatedWorkerGlobalScope in every engine, and where it is, its
      // callbacks stop firing in a backgrounded tab.
      preferTimeout: true,
      endIndex: job.endIndex,
      skipCache: job.skipCache || !useCache,
    }
  );

  if (!rendered || abortRequested || id !== activeJobId) {
    self.postMessage({ type: MSG.ABORTED, id });
    return;
  }

  let final = rendered;
  if (mode === "export") {
    const factor = Math.max(1, Math.round(job.ssaa ?? 1));
    final = boxDownsample(rendered, factor);
    self.postMessage({
      type: MSG.PROGRESS,
      id,
      phase: "resolve",
      done: layers.length + 1,
      total: totalSteps,
    });
  }

  const { masks, transferList, removedMaskIds, commitMaskStamps } = packMasks(ctx, {
    returnMasks: job.returnMasks,
    maskDeltas: !!job.maskDeltas,
    maskIds: job.maskIds ?? null,
  });

  // Paint-fast: main keeps the previous full-stack canvas; only masks.
  // Commit stamps only after postMessage succeeds — a transfer/clone throw
  // must leave stamps unchanged so the next job re-sends full mask bytes.
  if (job.paintOnly) {
    self.postMessage(
      {
        type: MSG.RESULT,
        id,
        image: null,
        bitmap: null,
        masks,
        removedMaskIds,
        renderW: job.renderW,
        renderH: job.renderH,
        paintOnly: true,
      },
      transferList
    );
    commitMaskStamps();
    return;
  }

  // Preview prefers ImageBitmap (GPU-friendly draw on main). Export needs Buf for encode.
  let bitmap = null;
  let image = null;
  if (mode === "preview" && job.preferBitmap !== false) {
    bitmap = await bufToBitmap(final);
  }
  if (!bitmap) {
    image = bufToTransfer(final);
    transferList.push(image.buffer);
  } else {
    transferList.push(bitmap);
  }

  if (abortRequested || id !== activeJobId) {
    if (bitmap?.close) try { bitmap.close(); } catch { /* ignore */ }
    self.postMessage({ type: MSG.ABORTED, id });
    return;
  }

  self.postMessage(
    {
      type: MSG.RESULT,
      id,
      image,
      bitmap,
      masks,
      removedMaskIds,
      renderW: job.renderW,
      renderH: job.renderH,
    },
    transferList
  );
  commitMaskStamps();
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  try {
    switch (msg.type) {
      case MSG.INIT: {
        await loadFonts(msg.fonts ?? []);
        self.postMessage({ type: MSG.INIT_OK });
        break;
      }

      case MSG.LOAD_FONTS: {
        await loadFonts(msg.fonts ?? []);
        // Glyph layers measure text, so anything already rendered was laid out
        // against fallback metrics — tell main to re-render.
        self.postMessage({ type: MSG.FONTS_OK });
        break;
      }

      case MSG.INVALIDATE: {
        previewCache = [];
        // Keep sticky source — size/seed key still matches; only layer cache dies.
        // Full source reset is driven by a new sourceKey + source payload.
        if (msg.clearSource) clearSticky();
        if (msg.clearLayers) clearLayerSticky();
        // Mask stamps are invalid when layer cache dies (masks may recompute).
        maskStamps = new Map();
        break;
      }

      case MSG.ABORT: {
        if (msg.id == null || msg.id === activeJobId) abortRequested = true;
        break;
      }

      case MSG.RENDER: {
        const { id, job } = msg;
        // Claim the slot synchronously, on receipt: an in-flight predecessor
        // watches `activeJobId` and must see itself superseded now, not once we
        // get around to running.
        activeJobId = id;
        abortRequested = false;

        // Then queue. `onmessage` is async, so without this two renders would
        // interleave across their yield points and both mutate `previewCache` —
        // one appending snapshots while the other has just truncated it. The
        // predecessor bails at its next yield, so the wait is one yield long.
        const previous = jobChain;
        jobChain = (async () => {
          try {
            await previous;
          } catch {
            /* a failed predecessor must not cancel its successor */
          }
          try {
            await runRenderJob(id, job);
          } catch (err) {
            self.postMessage({
              type: MSG.ERROR,
              id,
              message: err?.message || String(err),
              code: err?.code ?? null,
            });
          }
        })();
        break;
      }

      default:
        break;
    }
  } catch (err) {
    self.postMessage({
      type: MSG.ERROR,
      id: msg.id,
      message: err?.message || String(err),
      code: err?.code ?? null,
    });
  }
};
