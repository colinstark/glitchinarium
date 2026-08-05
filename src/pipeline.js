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

/** Deep-copy a mask map so cache snapshots own their Float32 data. */
function cloneMasks(map) {
  const out = new Map();
  for (const [id, m] of map) {
    out.set(id, { w: m.w, h: m.h, data: new Float32Array(m.data) });
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
 * Resolve the mask a layer should be scoped by, applying invert and feather.
 *
 * Derived masks are memoised per render — several layers commonly share one
 * mask with the same modifiers, and feathering at export resolution is not
 * cheap.
 */
function resolveMask(ctx, layer, derivedCache) {
  if (!layer.mask) return null;
  const base = ctx.masks.get(layer.mask);
  if (!base) return null; // mask layer is disabled or was moved below this one

  const key = `${layer.mask}|${layer.maskInvert}|${layer.maskFeather}`;
  const hit = derivedCache.get(key);
  if (hit) return hit;

  let m = base;
  const featherPx = ctx.u(layer.maskFeather);
  if (layer.maskInvert || featherPx >= 0.5) {
    m = createMask(base.w, base.h);
    if (layer.maskInvert) {
      for (let i = 0; i < base.data.length; i++) m.data[i] = 1 - base.data[i];
    } else {
      m.data.set(base.data);
    }
    if (featherPx >= 0.5) blurMask(m, featherPx);
  }

  derivedCache.set(key, m);
  return m;
}

/**
 * Run the stack.
 *
 * `cache` (optional) is a mutable array of per-layer snapshots. When present,
 * we resume from the deepest snapshot whose prefix still matches, so nudging
 * the last layer's slider does not recompute the first five. Pass no cache for
 * export — snapshots at 4x are far too large to keep around.
 */
export function* renderSteps(layers, source, ctx, cache = null) {
  const keys = layers.map(layerKey);
  let start = 0;
  let acc = null;

  if (cache) {
    let i = 0;
    while (i < cache.length && i < keys.length && cache[i].key === keys[i]) i++;
    cache.length = i;
    if (i > 0) {
      const snap = cache[i - 1];
      acc = cloneBuf(snap.buf);
      // New Map, same buffers as the snapshot. Snapshots already deep-copied
      // masks on store, so entries are not shared across cache slots.
      ctx.masks = new Map(snap.masks);
      start = i;
    }
  }

  if (!acc) {
    acc = cloneBuf(source);
    ctx.masks = new Map();
  }

  const derivedCache = new Map();

  for (let i = start; i < layers.length; i++) {
    const layer = layers[i];

    if (layer.enabled) {
      const proc = PROCESSORS[layer.type];
      if (proc) {
        ctx.forLayer(i, layer);
        if (proc.kind === "mask") {
          ctx.masks.set(layer.id, proc.compute(ctx, acc, layer.params));
        } else {
          const out = proc.apply(ctx, acc, layer.params);
          if (out) {
            compositeInto(acc, out, {
              mode: layer.blend,
              opacity: layer.opacity,
              mask: resolveMask(ctx, layer, derivedCache),
            });
          }
        }
      }
    } else {
      // A disabled layer must retract any mask it published, or layers above
      // would keep using a stale field from the previous render.
      ctx.masks.delete(layer.id);
    }

    if (cache) {
      cache.push({ key: keys[i], buf: cloneBuf(acc), masks: cloneMasks(ctx.masks) });
    }
    yield { done: i + 1, total: layers.length, layer };
  }

  return acc;
}

/** Drain the generator synchronously. Used by the live preview and verify. */
export function render(layers, source, ctx, cache = null) {
  const it = renderSteps(layers, source, ctx, cache);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/**
 * Drain the generator yielding a frame between layers, so an export at 4x can
 * paint a progress overlay instead of freezing the tab with no explanation.
 * `shouldAbort` (optional) is checked between layers — returns null if aborted.
 */
export async function renderAsync(
  layers,
  source,
  ctx,
  cache = null,
  onProgress = null,
  shouldAbort = null
) {
  const it = renderSteps(layers, source, ctx, cache);
  let step = it.next();
  while (!step.done) {
    if (shouldAbort?.()) return null;
    if (onProgress) onProgress(step.value);
    await new Promise((r) => requestAnimationFrame(r));
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
