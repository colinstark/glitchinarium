import { bufFromDrawable, boxDownsample, bufToCanvas } from "./buffer.js";
import { createContext, planExport } from "./context.js";
import { renderAsync } from "./pipeline.js";

/**
 * Export.
 *
 * The stack is re-run from the ORIGINAL image at an internal supersample
 * (quality-tier dependent), then box-downsampled to the requested size.
 * The planner reduces supersampling when the active stack would exceed the
 * browser working-memory budget.
 *
 * No layer cache here: a single snapshot at high res is hundreds of megabytes
 * and there is nothing to reuse in a one-shot render anyway.
 */
export async function exportImage({
  drawable,
  srcW,
  srcH,
  layers,
  seed,
  multiplier = 2,
  format = "png",
  quality = 0.95,
  /** "fast" | "balanced" | "quality" — caps SSAA before memory clamps. */
  exportQuality = "quality",
  onProgress = null,
  shouldAbort = null,
}) {
  const plan = planExport(srcW, srcH, multiplier, layers, exportQuality);

  const totalSteps = Math.max(1, layers.length) + 2;
  onProgress?.({ phase: "decode", done: 0, total: totalSteps, plan });
  const source = bufFromDrawable(drawable, plan.renderW, plan.renderH);

  const ctx = createContext({
    renderW: plan.renderW,
    renderH: plan.renderH,
    ssaa: plan.ssaa,
    seed,
    mode: "export",
  });

  const rendered = await renderAsync(
    layers,
    source,
    ctx,
    null,
    (s) => {
      onProgress?.({
        phase: "render",
        done: s.done,
        total: totalSteps,
        layer: s.layer,
        plan,
      });
    },
    shouldAbort,
    { yieldMs: 6, preferTimeout: true }
  );
  if (!rendered) return null;

  onProgress?.({ phase: "resolve", done: layers.length + 1, total: totalSteps, plan });
  // plan.ssaa is integer ≥ 1; non-integer would leave the buffer at the wrong size.
  const factor = Math.max(1, Math.round(plan.ssaa));
  const final = boxDownsample(rendered, factor);

  const canvas = bufToCanvas(final);
  const mime = format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const blob = await new Promise((res) => canvas.toBlob(res, mime, quality));
  if (!blob) {
    throw new Error(
      "Browser refused to encode the image (usually out of memory). Try a smaller export scale or Fast quality."
    );
  }

  onProgress?.({ phase: "done", done: totalSteps, total: totalSteps, plan });
  return { blob, width: final.w, height: final.h, plan };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Human-readable estimate shown in the export panel before you commit. */
export function describeExport(srcW, srcH, multiplier, layers = [], exportQuality = "quality") {
  const plan = planExport(srcW, srcH, multiplier, layers, exportQuality);
  const askedW = Math.round(srcW * multiplier);
  const askedH = Math.round(srcH * multiplier);
  const mp = (plan.targetW * plan.targetH) / 1e6;
  const bufferMB = (plan.renderW * plan.renderH * 4) / 1e6;
  const workingMB = plan.estimatedWorkingBytes / 1e6;
  const sizeNote =
    plan.targetW !== askedW || plan.targetH !== askedH
      ? ` (clamped from ${askedW}×${askedH})`
      : "";
  const ssaaNote = plan.ssaa > 1 ? ` · ${plan.ssaa}× SSAA` : " · 1×";
  return {
    ...plan,
    label: `${plan.targetW} × ${plan.targetH} (${mp.toFixed(1)} MP)${sizeNote}`,
    workingLabel: `${plan.renderW} × ${plan.renderH} internal${ssaaNote} · ~${workingMB.toFixed(0)} MB peak (${bufferMB.toFixed(0)} MB/buffer)`,
    heavy: workingMB > 400 || plan.clamped,
  };
}
