/**
 * The layer stack executor.
 *
 * A stack is an ordered list of layers. Each layer is either a `mask` layer
 * (computes a named grayscale field from the image AS IT IS at that point and
 * publishes it) or a processor layer (transforms the image and composites the
 * result back, optionally scoped by a previously published mask).
 *
 * Because masks read the live accumulator, "edge-detect whatever the datamosh
 * just did" falls out naturally from stack order.
 */

import { cloneBuf, compositeInto, createMask, blurMask } from "./buffer.js";
import { PROCESSORS } from "./processors/index.js";

let idCounter = 0;
export function nextLayerId() {
  return `L${++idCounter}`;
}

/**
 * Deep-copy a mask map so cache snapshots own their Float32 data.
 * Unchanged mask identities (same data buffer reference as previous snapshot)
 * are shared to avoid re-copying multi-megabyte fields on every layer.
 */
function cloneMasks(map, prevSnap) {
  const out = new Map();
  const prev = prevSnap?.masks;
  for (const [id, m] of map) {
    const old = prev?.get(id);
    if (old && old.data === m.data && old.w === m.w && old.h === m.h) {
      out.set(id, old);
    } else {
      out.set(id, {
        w: m.w,
        h: m.h,
        data: new Float32Array(m.data),
        bbox: m.bbox ?? null,
        _rev: m._rev ?? null,
      });
    }
  }
  return out;
}

/** Build a layer with defaults filled in from the processor's param schema. */
export function createLayer(type, overrides = {}) {
  const proc = PROCESSORS[type];
  if (!proc) throw new Error(`Unknown processor: ${type}`);
  const params = {};
  for (const p of proc.params) params[p.key] = structuredClone(p.default);
  return {
    id: nextLayerId(),
    type,
    label: proc.name,
    enabled: true,
    opacity: 1,
    blend: "normal",
    mask: null,
    maskInvert: false,
    maskFeather: 0,
    collapsed: false,
    params,
    /** paramKey → { mask, min, max, invert }. See ctx.mod in context.js. */
    mods: {},
    ...overrides,
  };
}

/**
 * Layers the UI has marked dirty since the last render dispatch — used for
 * worker sticky param patches so slider previews do not re-clone the whole
 * stack DTO every frame.
 *
 * It is a SET, not a single id: a patch only describes one layer, so it is only
 * a safe substitute for the full DTO when exactly one layer changed. Two edits
 * landing inside one debounce window would otherwise leave the worker's sticky
 * stack holding stale values for the layer we did not describe.
 */
const dirtyLayerIds = new Set();

/**
 * Hint that a layer's params changed. Fingerprint still rebuilds from live
 * params; we also record which layer was edited for live IPC patches.
 */
export function touchLayerKey(layer) {
  if (layer?.id) dirtyLayerIds.add(layer.id);
}

/** The one dirty layer id, or null when zero — or several — layers changed. */
export function soleDirtyLayerId() {
  return dirtyLayerIds.size === 1 ? dirtyLayerIds.values().next().value : null;
}

/** Call once a render carrying these edits has been dispatched. */
export function clearDirtyLayers() {
  dirtyLayerIds.clear();
}

/**
 * Identity of a stack as the render worker sees it: which layers, of what type,
 * in what order. A live patch may only be sent when this still matches what the
 * worker was last given in full — otherwise adding, deleting or reordering a
 * layer would leave the worker replaying its stale sticky DTO.
 */
export function stackSignature(layers) {
  let sig = "";
  for (const l of layers) sig += `${l.id}:${l.type};`;
  return sig;
}

/**
 * Compact fingerprint for brush stroke lists. Avoids JSON.stringify of every
 * point on every cache probe — painting was dominated by key serialisation.
 * Callers bump `strokes._v` on each mutation (see ui/brush.js); when that is
 * missing we fall back to a cheap content hash.
 */
function strokesKey(strokes) {
  if (!strokes?.length) return 0;
  if (strokes._v != null) return strokes._v;
  let h = strokes.length;
  for (let s = 0; s < strokes.length; s++) {
    const st = strokes[s];
    const pts = st.pts;
    h = Math.imul(h ^ (pts?.length ?? 0), 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ ((st.r * 100) | 0) ^ (st.erase ? 1 : 0), 16777619) >>> 0;
    if (!pts) continue;
    // Sample endpoints + a few mid points; enough to catch real edits without
    // walking tens of thousands of coordinates on every key build.
    for (let i = 0; i < pts.length; i += Math.max(1, (pts.length / 16) | 0)) {
      h = Math.imul(h ^ ((pts[i] * 1e5) | 0), 16777619) >>> 0;
    }
    if (pts.length >= 2) {
      h = Math.imul(h ^ ((pts[pts.length - 2] * 1e5) | 0), 16777619) >>> 0;
      h = Math.imul(h ^ ((pts[pts.length - 1] * 1e5) | 0), 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

/** Everything that affects output. Used for cache invalidation. */
function layerKey(layer) {
  const params = layer.params;
  let paramsPart = params;
  if (params && params.strokes) {
    const { strokes, ...rest } = params;
    paramsPart = { ...rest, _strokes: strokesKey(strokes) };
  }
  return JSON.stringify([
    layer.id,
    layer.type,
    layer.enabled,
    layer.opacity,
    layer.blend,
    layer.mask,
    layer.maskInvert,
    layer.maskFeather,
    paramsPart,
    layer.mods,
  ]);
}

/**
 * Stamp a freshly computed mask with a content revision.
 *
 * The worker skips re-transferring a mask whose stamp is unchanged, so the
 * stamp has to track content. Deriving one from the buffer's shape cannot —
 * every luma mask of a given size looks identical that way, and the overlay
 * would freeze on its first value. A monotonic counter is exact for what we
 * need: a mask restored from a cache snapshot keeps its old number (it really
 * is the same field), and anything recomputed gets a new one.
 */
let maskRev = 0;
function stampMask(mask) {
  if (mask && mask._rev == null) mask._rev = ++maskRev;
  return mask;
}

/** True when every pixel of `buf` is fully opaque (alpha 255). */
function isFullyOpaque(buf) {
  const d = buf.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 255) return false;
  }
  return true;
}

/**
 * Resolve the mask a layer should be scoped by, applying invert and feather.
 *
 * Derived masks are memoised per render — several layers commonly share one
 * mask with the same modifiers, and feathering at export resolution is not
 * cheap.
 *
 * Invert without feather is a zero-copy view (`invert: true`) so we do not
 * allocate another full Float32 field.
 */
function resolveMask(ctx, layer, derivedCache) {
  if (!layer.mask) return null;
  const base = ctx.masks.get(layer.mask);
  if (!base) return null; // mask layer is disabled or was moved below this one

  const key = `${layer.mask}|${layer.maskInvert}|${layer.maskFeather}`;
  const hit = derivedCache.get(key);
  if (hit) return hit;

  const featherPx = ctx.u(layer.maskFeather);
  let m = base;

  if (featherPx >= 0.5) {
    m = createMask(base.w, base.h);
    if (layer.maskInvert) {
      for (let i = 0; i < base.data.length; i++) m.data[i] = 1 - base.data[i];
    } else {
      m.data.set(base.data);
    }
    blurMask(m, featherPx);
    // The bbox marks where a sparse mask is non-zero, so compositeInto can skip
    // the rest. Once the inversion is baked into the data the field is DENSE
    // outside that box — carrying the bbox over would clip the layer to the one
    // region the inverted mask zeroes out, i.e. apply it nowhere.
    if (base.bbox && !layer.maskInvert) {
      m.bbox = expandBBox(base.bbox, Math.ceil(featherPx) + 1, base.w, base.h);
    }
  } else if (layer.maskInvert) {
    // Zero-copy invert view — compositeInto honors `.invert`.
    m = { w: base.w, h: base.h, data: base.data, invert: true, bbox: base.bbox ?? null };
  }

  derivedCache.set(key, m);
  return m;
}

function expandBBox(bbox, pad, w, h) {
  if (!bbox) return null;
  return {
    x0: Math.max(0, bbox.x0 - pad),
    y0: Math.max(0, bbox.y0 - pad),
    x1: Math.min(w - 1, bbox.x1 + pad),
    y1: Math.min(h - 1, bbox.y1 + pad),
  };
}

/**
 * Run the stack.
 *
 * `cache` (optional) is a mutable array of per-layer snapshots. When present,
 * we resume from the deepest snapshot whose prefix still matches, so nudging
 * the last layer's slider does not recompute the first five. Pass no cache for
 * export — snapshots at high res are far too large to keep around.
 *
 * `opts.endIndex` — exclusive end (paint fast-path stops after the mask layer).
 * `opts.skipCache` — do not write snapshots (interactive paint).
 */
export function* renderSteps(layers, source, ctx, cache = null, opts = {}) {
  const endIndex = Math.min(layers.length, opts.endIndex ?? layers.length);
  const writeCache = cache && !opts.skipCache;
  const keys = layers.map(layerKey);
  let start = 0;
  let acc = null;

  if (cache) {
    // layerKey covers the stack; it cannot see the seed or the render size, and
    // both change what every layer produces. Salt the whole cache with them so
    // its validity does not depend on callers remembering to invalidate.
    const salt = `${ctx.seed}|${ctx.w}x${ctx.h}`;
    if (cache._salt !== salt) {
      cache.length = 0;
      cache._salt = salt;
    }
    let i = 0;
    while (i < cache.length && i < keys.length && cache[i].key === keys[i]) i++;
    cache.length = i;
    if (i > 0 && i <= endIndex) {
      const snap = cache[i - 1];
      acc = cloneBuf(snap.buf);
      // New Map, same buffers as the snapshot. Snapshots already deep-copied
      // masks on store, so entries are not shared across cache slots unless
      // cloneMasks deliberately shared stable identities.
      ctx.masks = new Map(snap.masks);
      start = i;
    }
  }

  if (!acc) {
    acc = cloneBuf(source);
    ctx.masks = new Map();
  }

  // Nothing left to run (endIndex before start, or empty range).
  if (start >= endIndex) {
    return acc;
  }

  const derivedCache = new Map();

  for (let i = start; i < endIndex; i++) {
    const layer = layers[i];

    if (layer.enabled) {
      const proc = PROCESSORS[layer.type];
      if (proc) {
        ctx.forLayer(i, layer);
        if (proc.kind === "mask") {
          ctx.masks.set(layer.id, stampMask(proc.compute(ctx, acc, layer.params)));
        } else {
          const out = proc.apply(ctx, acc, layer.params);
          // Processors like datamosh publish a mask as a side effect of apply().
          stampMask(ctx.masks.get(layer.id));
          if (out) {
            const mask = resolveMask(ctx, layer, derivedCache);
            const opacity = layer.opacity ?? 1;
            const blend = layer.blend ?? "normal";
            // Full replace: skip a whole-frame composite when the layer is a
            // straight opaque overwrite (common for warps / tone / glitch).
            const canReplace =
              !mask &&
              opacity >= 1 &&
              blend === "normal" &&
              out !== acc &&
              out.w === acc.w &&
              out.h === acc.h;
            // Only worth an alpha scan when a full replace is actually on the
            // table; hand the answer to compositeInto so it does not rescan.
            const srcOpaque = canReplace ? isFullyOpaque(out) : null;
            if (canReplace && srcOpaque) {
              acc = out;
            } else if (out !== acc) {
              compositeInto(acc, out, { mode: blend, opacity, mask, srcOpaque });
            }
            // out === acc: processor mutated in place — nothing to do.
          }
        }
      }
    } else {
      // A disabled layer must retract any mask it published, or layers above
      // would keep using a stale field from the previous render.
      ctx.masks.delete(layer.id);
    }

    if (writeCache) {
      const prev = cache.length ? cache[cache.length - 1] : null;
      cache.push({ key: keys[i], buf: cloneBuf(acc), masks: cloneMasks(ctx.masks, prev) });
    }
    yield { done: i + 1, total: endIndex, layer };
  }

  return acc;
}

/** Drain the generator synchronously. Used by the live preview and verify. */
export function render(layers, source, ctx, cache = null, opts = {}) {
  const it = renderSteps(layers, source, ctx, cache, opts);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/**
 * Drain the generator, yielding to the event loop only when a time budget is
 * exceeded — so export at high res can paint a progress overlay without paying
 * a full rAF after every lightweight layer.
 *
 * `opts.yieldMs` — min ms of work before yielding (default 8).
 * `opts.preferTimeout` — use setTimeout(0) instead of rAF (faster export).
 */
export async function renderAsync(
  layers,
  source,
  ctx,
  cache = null,
  onProgress = null,
  shouldAbort = null,
  opts = {}
) {
  const yieldMs = opts.yieldMs ?? 8;
  const preferTimeout = !!opts.preferTimeout;
  const yieldToMain = () =>
    new Promise((r) => {
      if (preferTimeout) setTimeout(r, 0);
      else requestAnimationFrame(r);
    });

  const it = renderSteps(layers, source, ctx, cache, opts);
  let step = it.next();
  let lastYield = performance.now();
  while (!step.done) {
    if (shouldAbort?.()) return null;
    if (onProgress) onProgress(step.value);
    const now = performance.now();
    if (now - lastYield >= yieldMs) {
      await yieldToMain();
      lastYield = performance.now();
      if (shouldAbort?.()) return null;
    }
    step = it.next();
  }
  return step.value;
}

/**
 * Masks a layer is allowed to reference: anything ABOVE it in the stack that
 * publishes one, because nothing below has been computed yet. That includes
 * dedicated mask layers and processors that emit a mask as a side effect —
 * datamosh publishing the regions it disturbed.
 */
export function availableMasks(layers, index) {
  const out = [];
  for (let i = 0; i < index; i++) {
    const l = layers[i];
    if (!l.enabled) continue;
    const proc = PROCESSORS[l.type];
    if (!proc) continue;
    if (proc.kind === "mask" || (proc.emitsMask && proc.emitsMask(l.params))) out.push(l);
  }
  return out;
}
