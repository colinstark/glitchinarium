/**
 * Shared message shapes for main ↔ render worker.
 * Keep this free of DOM so both sides can import it.
 */

/**
 * ERROR code for "your patch does not fit my sticky DTO".
 *
 * A live patch rewrites ONE layer of the stack the worker is holding, so the
 * main thread may only send one while it believes that stack is the current
 * one. When the belief turns out to be wrong (missing layer id, or
 * stackSignature mismatch) the worker cannot render the edit, and rendering
 * the sticky stack regardless would silently drop it. This code distinguishes
 * that recoverable desync from a genuinely broken worker: the caller resends a
 * full stack and everything resyncs, no demotion to main.
 */
export const ERR_STALE_PATCH = "stale-patch";

export const MSG = {
  INIT: "init",
  INIT_OK: "init-ok",
  INIT_ERR: "init-err",
  LOAD_FONTS: "load-fonts",
  FONTS_OK: "fonts-ok",
  RENDER: "render",
  PROGRESS: "progress",
  RESULT: "result",
  ERROR: "error",
  ABORT: "abort",
  ABORTED: "aborted",
  INVALIDATE: "invalidate",
};

/**
 * Deep-clone a live stack into a structured-cloneable DTO that preserves
 * layer ids (so mask bindings and mods keep working).
 * @param {number} [endIndex] exclusive — omit trailing layers for paint-fast jobs
 */
export function layersToDTO(layers, endIndex = layers.length) {
  const end = Math.min(layers.length, endIndex ?? layers.length);
  const out = [];
  for (let i = 0; i < end; i++) {
    const l = layers[i];
    out.push({
      id: l.id,
      type: l.type,
      label: l.label,
      enabled: l.enabled !== false,
      opacity: l.opacity ?? 1,
      blend: l.blend ?? "normal",
      mask: l.mask ?? null,
      maskInvert: !!l.maskInvert,
      maskFeather: l.maskFeather ?? 0,
      collapsed: !!l.collapsed,
      params: structuredClone(l.params ?? {}),
      mods: structuredClone(l.mods ?? {}),
      locks: structuredClone(l.locks ?? {}),
    });
  }
  return out;
}

/**
 * Paint-fast patch: only the strokes for one mask layer.
 * Worker merges onto its sticky layer DTO.
 */
export function paintLayerPatch(layer) {
  if (!layer) return null;
  return {
    id: layer.id,
    params: {
      strokes: structuredClone(layer.params?.strokes ?? []),
    },
  };
}

/**
 * Full live patch for one layer (slider / opacity / mask chrome).
 * Replaces params+mods on the worker sticky DTO for that id.
 */
export function layerLivePatch(layer) {
  if (!layer) return null;
  return {
    id: layer.id,
    enabled: layer.enabled !== false,
    opacity: layer.opacity ?? 1,
    blend: layer.blend ?? "normal",
    mask: layer.mask ?? null,
    maskInvert: !!layer.maskInvert,
    maskFeather: layer.maskFeather ?? 0,
    params: structuredClone(layer.params ?? {}),
    mods: structuredClone(layer.mods ?? {}),
  };
}

/** True when this environment can run the off-main render worker. */
export function workerSupported() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof URL !== "undefined"
  );
}
