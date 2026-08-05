/**
 * Shared message shapes for main ↔ render worker.
 * Keep this free of DOM / p5 so both sides can import it.
 */

export const MSG = {
  INIT: "init",
  INIT_OK: "init-ok",
  INIT_ERR: "init-err",
  LOAD_FONTS: "load-fonts",
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

/** True when this environment can run the off-main render worker. */
export function workerSupported() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof URL !== "undefined"
  );
}
