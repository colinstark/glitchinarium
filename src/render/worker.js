/**
 * Render worker — runs the layer pipeline off the main thread.
 *
 * Receives a transferable RGBA source + layer DTO, returns transferable pixels.
 * Preview layer cache and sticky source live here (not re-transferred each frame).
 */

import { createContext } from "../context.js";
import { renderAsync } from "../pipeline.js";
import { boxDownsample, bufFromTransfer, bufToTransfer } from "../buffer.js";
import { MSG } from "./protocol.js";

/** @type {Array<{key:string, buf:any, masks:Map}>} */
let previewCache = [];
/** Sticky decoded source so preview frames only transfer when size/seed changes. */
let stickySource = null;
let stickySourceKey = null;
let activeJobId = 0;
let abortRequested = false;

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
        break;
      }

      case MSG.INVALIDATE: {
        previewCache = [];
        // Keep sticky source — size/seed key still matches; only layer cache dies.
        // Full source reset is driven by a new sourceKey + source payload.
        if (msg.clearSource) clearSticky();
        break;
      }

      case MSG.ABORT: {
        if (msg.id == null || msg.id === activeJobId) abortRequested = true;
        break;
      }

      case MSG.RENDER: {
        const { id, job } = msg;
        // Supersede any in-flight job (shouldAbort checks activeJobId).
        activeJobId = id;
        abortRequested = false;

        if (job.invalidateCache) previewCache = [];

        const layers = job.layers;
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
            preferTimeout: mode === "export",
            endIndex: job.endIndex,
            skipCache: job.skipCache || !useCache,
          }
        );

        if (!rendered || abortRequested || id !== activeJobId) {
          self.postMessage({ type: MSG.ABORTED, id });
          break;
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

        // Masks for stage overlay (preview / paint). Transfer Float32 buffers.
        const masks = [];
        const transferList = [];
        if (job.returnMasks && ctx.masks?.size) {
          for (const [maskId, m] of ctx.masks) {
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
        }

        // Paint-fast: main keeps the previous full-stack canvas; still send
        // image so callers can ignore it, but prefer not to transfer a huge
        // unused buffer when paintOnly is set.
        if (job.paintOnly) {
          self.postMessage({
            type: MSG.RESULT,
            id,
            image: null,
            masks,
            renderW: job.renderW,
            renderH: job.renderH,
            paintOnly: true,
          }, transferList);
          break;
        }

        const image = bufToTransfer(final);
        transferList.push(image.buffer);

        self.postMessage(
          {
            type: MSG.RESULT,
            id,
            image,
            masks,
            renderW: job.renderW,
            renderH: job.renderH,
          },
          transferList
        );
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
    });
  }
};
