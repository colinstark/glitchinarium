import { createMask, blurMask } from "../buffer.js";
import { buildGuide, geodesicFlood, releaseFlood } from "../geodesic.js";
import { luma, saturationOf, hueOf, parseHex } from "../color.js";
import { fbm, noise2, jitteredPoints, pointRandom, curlAngle } from "../rng.js";
import { SiteGrid } from "../geometry.js";
import { bayerAt, checkerAt } from "../patterns.js";

/**
 * A mask layer computes a grayscale field from the image AS IT IS at this point
 * in the stack, and publishes it under this layer's id. Processor layers above
 * can then scope themselves to it — either as an opacity stencil, or (via
 * parameter modulation) as a dial that drives an effect's strength per pixel.
 *
 * Because it reads the live accumulator rather than the original photo, "edges
 * of whatever the datamosh just broke" is simply a matter of stack order.
 *
 * THE EDGE IS THE SIGNATURE. Across the reference work almost no mask has a
 * clean boundary: they stair-step on a coarse grid, dissolve into a checker or
 * bayer dither, or tear along a noise flow. `edgeStyle` and `edgeJitter` matter
 * more to the final look than the choice of source does.
 */

const SOURCES = [
  "luma", "channel", "hue", "saturation", "band", "chroma",
  "edge", "detail", "saliency",
  "radial", "linear", "shape", "noise", "voronoi", "flow",
  "paint",
];

const CHANNELS = ["red", "green", "blue", "cyan", "magenta", "yellow"];
const EDGE_STYLES = ["smooth", "stairs", "bayer", "checker", "weave"];

/** Bilinear read from a Float32 field. */
function sampleField(field, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = Math.max(0, Math.min(w - 1, x0));
  const xb = Math.max(0, Math.min(w - 1, x0 + 1));
  const ya = Math.max(0, Math.min(h - 1, y0));
  const yb = Math.max(0, Math.min(h - 1, y0 + 1));
  const a = field[ya * w + xa];
  const b = field[ya * w + xb];
  const c = field[yb * w + xa];
  const d = field[yb * w + xb];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

const smoothstep = (e0, e1, x) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Box min (erode) / max (dilate) on a mask, radius in pixels.
 * Sliding-window O(n) deques — the previous nested ±r loops were O(n·r) and
 * dominated mask layers with large grow at export size. Edge samples clamp
 * (same as before) so a grow on a hard matte still fills out to the frame.
 */
function morph(mask, radius, dilate) {
  const r = Math.round(radius);
  if (r < 1) return mask;
  const { w, h, data } = mask;
  const tmp = new Float32Array(w * h);
  const q = new Int32Array(Math.max(w, h) + 2 * r + 4);
  const better = dilate ? (a, b) => a >= b : (a, b) => a <= b;

  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const at = (x) => data[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
    let qh = 0;
    let qt = 0;
    for (let x = -r; x <= r; x++) {
      const v = at(x);
      while (qt > qh && better(v, at(q[qt - 1]))) qt--;
      q[qt++] = x;
    }
    tmp[row] = at(q[qh]);
    for (let x = 1; x < w; x++) {
      const left = x - r;
      while (qh < qt && q[qh] < left) qh++;
      const right = x + r;
      const v = at(right);
      while (qt > qh && better(v, at(q[qt - 1]))) qt--;
      q[qt++] = right;
      tmp[row + x] = at(q[qh]);
    }
  }

  // Vertical
  for (let x = 0; x < w; x++) {
    const at = (y) => tmp[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + x];
    let qh = 0;
    let qt = 0;
    for (let y = -r; y <= r; y++) {
      const v = at(y);
      while (qt > qh && better(v, at(q[qt - 1]))) qt--;
      q[qt++] = y;
    }
    data[x] = at(q[qh]);
    for (let y = 1; y < h; y++) {
      const left = y - r;
      while (qh < qt && q[qh] < left) qh++;
      const right = y + r;
      const v = at(right);
      while (qt > qh && better(v, at(q[qt - 1]))) qt--;
      q[qt++] = right;
      data[y * w + x] = at(q[qh]);
    }
  }
  return mask;
}

/**
 * Histogram-based global-contrast saliency (after Cheng et al.).
 *
 * Colours are quantised to a coarse cube; a bin's saliency is its total colour
 * distance to every other bin weighted by how common that other bin is. Rare
 * colours surrounded by a common background score high, which is a decent
 * stand-in for "the subject" without any model — the silhouette look in the
 * mountain lion and horse references.
 */
function saliencyField(src, field, centerBias) {
  const { w, h, data } = src;
  const Q = 12; // levels per channel
  const bins = Q * Q * Q;
  const count = new Float32Array(bins);
  const idx = new Int32Array(w * h);

  for (let i = 0, p = 0; i < idx.length; i++, p += 4) {
    const r = (data[p] * Q) >> 8;
    const g = (data[p + 1] * Q) >> 8;
    const b = (data[p + 2] * Q) >> 8;
    const bin = (r * Q + g) * Q + b;
    idx[i] = bin;
    count[bin]++;
  }

  // Only non-empty bins participate; typically a few hundred of the 1728.
  const used = [];
  for (let i = 0; i < bins; i++) if (count[i] > 0) used.push(i);

  const sal = new Float32Array(bins);
  let peak = 1e-6;
  for (let a = 0; a < used.length; a++) {
    const ba = used[a];
    const ar = Math.floor(ba / (Q * Q));
    const ag = Math.floor(ba / Q) % Q;
    const ab = ba % Q;
    let s = 0;
    for (let b = 0; b < used.length; b++) {
      const bb = used[b];
      const br = Math.floor(bb / (Q * Q));
      const bg = Math.floor(bb / Q) % Q;
      const bbl = bb % Q;
      s += count[bb] * Math.hypot(ar - br, ag - bg, ab - bbl);
    }
    sal[ba] = s;
    if (s > peak) peak = s;
  }

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let v = sal[idx[i]] / peak;
      if (centerBias > 0) {
        const d = Math.hypot(x - cx, y - cy) / maxR;
        v *= 1 - centerBias * d * d;
      }
      field[i] = v;
    }
  }
}

/**
 * Rasterise brush strokes into the field.
 *
 * Strokes are stored as normalised 0..1 points with radii in artwork units, so
 * a mask painted while looking at a 900px preview lands in exactly the same
 * place on a 6000px export.
 */
function expandFieldBBox(field, x0, y0, x1, y1, erase) {
  // A union-only box can only grow, so an erase — which can shrink the painted
  // region, or empty it — leaves it a superset. Still correct to composite
  // through, just looser; flag it so fieldBBox pays for an exact rescan.
  if (erase) field._looseBBox = true;
  const b = field._bbox || { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  if (x0 < b.x0) b.x0 = x0;
  if (y0 < b.y0) b.y0 = y0;
  if (x1 > b.x1) b.x1 = x1;
  if (y1 > b.y1) b.y1 = y1;
  field._bbox = b;
}

/**
 * Rasterise one edge-aware stroke: reach, not radius.
 *
 * The falloff is the same ramp the circular brush uses, but the distance it
 * ramps over is geodesic — measured through the picture, where crossing an edge
 * costs extra. So a stroke down a wall fills to the wall's silhouette instead
 * of to a circle.
 *
 * NOTE the max/min accumulation, which differs from the circular brush's
 * additive build-up and is load-bearing. Geodesic distance from a set of seeds
 * is the MINIMUM over those seeds, so max(fall(Da), fall(Db)) === fall(min(Da,
 * Db)): folding a longer version of a stroke over a shorter one lands exactly
 * where a cold rasterisation of the longer one would. That is what lets the
 * incremental brush cache re-flood the live stroke each dab and stay
 * byte-identical to export (verify.js asserts this). It also means a cling
 * stroke behaves like a selection tool rather than an airbrush — passing over
 * the same spot twice does not darken it, which is the right feel here.
 *
 * `start` is deliberately ignored: the whole stroke is re-flooded, and the
 * result dominates whatever the previous partial pass left behind.
 */
function rasterClingStroke(ctx, guide, field, w, h, stroke) {
  const pts = stroke.pts;
  const factor = guide.factor;
  const cling = Math.max(0, Math.min(1, stroke.cling ?? 0));
  const hardness = stroke.hardness ?? 0.5;
  const flow = stroke.flow ?? 1;
  const erase = !!stroke.erase;

  // The flood runs in working-grid cells but the falloff is evaluated in render
  // pixels. Those differ only when a small brush meets a decimated export
  // guide: the flood needs at least one whole cell to travel through, while the
  // ramp still has to cut at the radius the stroke actually asks for.
  const reachPx = Math.max(1, ctx.u(stroke.r ?? 20));
  const reachCells = Math.max(1, reachPx / factor);
  const inner = reachPx * hardness;
  const softRange = reachPx - inner || 1;

  // Render pixels -> working-grid cells. boxDownsample averages a factor x
  // factor block, so cell centres sit half a block in.
  const half = (factor - 1) / 2;
  const toCell = (px) => (px - half) / factor;

  const poly = new Float64Array(pts.length);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    poly[i] = toCell(pts[i] * w);
    poly[i + 1] = toCell(pts[i + 1] * h);
  }

  const flood = geodesicFlood(ctx, guide, poly, reachCells, cling);
  if (!flood) return;

  // Full-resolution extent of the flooded box.
  const ax = Math.max(0, Math.floor(flood.x0 * factor + half));
  const ay = Math.max(0, Math.floor(flood.y0 * factor + half));
  const bx = Math.min(w - 1, Math.ceil((flood.x0 + flood.w - 1) * factor + half));
  const by = Math.min(h - 1, Math.ceil((flood.y0 + flood.h - 1) * factor + half));
  if (bx < ax || by < ay) {
    releaseFlood(ctx, flood);
    return;
  }
  expandFieldBBox(field, ax, ay, bx, by, erase);

  const dist = flood.dist;
  const bw = flood.w;
  const bh = flood.h;

  for (let y = ay; y <= by; y++) {
    const row = y * w;
    // Box-local cell coordinate of this render row.
    const cy = toCell(y) - flood.y0;
    const cy0 = cy < 0 ? 0 : cy > bh - 1 ? bh - 1 : cy;
    const y0 = cy0 | 0;
    const y1 = y0 + 1 < bh ? y0 + 1 : y0;
    const ty = cy0 - y0;
    const r0 = y0 * bw;
    const r1 = y1 * bw;

    for (let x = ax; x <= bx; x++) {
      const cx = toCell(x) - flood.x0;
      const cx0 = cx < 0 ? 0 : cx > bw - 1 ? bw - 1 : cx;
      const x0 = cx0 | 0;
      const x1 = x0 + 1 < bw ? x0 + 1 : x0;
      const tx = cx0 - x0;

      const d00 = dist[r0 + x0];
      const d10 = dist[r0 + x1];
      const d01 = dist[r1 + x0];
      const d11 = dist[r1 + x1];
      const cells =
        (d00 + (d10 - d00) * tx) * (1 - ty) + (d01 + (d11 - d01) * tx) * ty;
      const d = cells * factor;
      if (d >= reachPx) continue;

      const fall = d <= inner ? 1 : 1 - (d - inner) / softRange;
      const add = fall * flow;
      const j = row + x;
      field[j] = erase
        ? Math.min(field[j], 1 - add)
        : Math.max(field[j], add);
    }
  }

  releaseFlood(ctx, flood);
}

function rasterStroke(ctx, guide, field, w, h, stroke, start = 0) {
  const pts = stroke?.pts;
  if (!pts || pts.length < 2) return;
  if (guide && stroke.cling > 0) {
    rasterClingStroke(ctx, guide, field, w, h, stroke);
    return;
  }
  const r = Math.max(1, ctx.u(stroke.r ?? 20));
  const hardness = stroke.hardness ?? 0.5;
  const flow = stroke.flow ?? 1;
  const erase = !!stroke.erase;
  const inner = r * hardness;
  const step = Math.max(1, r * 0.35);
  const r2 = r * r;
  const inner2 = inner * inner;
  const softRange = r - inner || 1;

  // `start` points at the first segment not already present in the cached raw
  // field. Including both segment endpoints preserves the exact accumulation
  // behaviour of a full rebuild where neighbouring stamps overlap.
  for (let i = start; i + 3 < pts.length; i += 2) {
    const x0 = pts[i] * w;
    const y0 = pts[i + 1] * h;
    const x1 = pts[i + 2] * w;
    const y1 = pts[i + 3] * h;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / step));

    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      const ax = Math.max(0, Math.floor(px - r));
      const bx = Math.min(w - 1, Math.ceil(px + r));
      const ay = Math.max(0, Math.floor(py - r));
      const by = Math.min(h - 1, Math.ceil(py + r));
      expandFieldBBox(field, ax, ay, bx, by, erase);

      for (let y = ay; y <= by; y++) {
        const dy = y - py;
        const dy2 = dy * dy;
        const row = y * w;
        for (let x = ax; x <= bx; x++) {
          const dx = x - px;
          const d2 = dx * dx + dy2;
          if (d2 > r2) continue;
          const fall =
            d2 <= inner2 ? 1 : 1 - (Math.sqrt(d2) - inner) / softRange;
          const add = fall * flow;
          const j = row + x;
          field[j] = erase
            ? Math.max(0, field[j] - add)
            : Math.min(1, field[j] + add);
        }
      }
    }
  }
}

function paintField(ctx, guide, field, w, h, strokes) {
  for (const stroke of strokes ?? []) rasterStroke(ctx, guide, field, w, h, stroke);
  return field;
}

/**
 * Preview-sized raw paint fields, keyed by LAYER ID.
 *
 * Not by the strokes array, and not compared by stroke identity: the render
 * worker receives its stroke list through structuredClone, so the array and
 * every stroke object in it are fresh identities on every patch. An
 * identity-keyed cache missed on literally every dab, which quietly turned the
 * incremental brush into a full re-raster of the whole stroke history off-main —
 * cost per dab growing with everything you had already painted.
 *
 * So the comparison is by CONTENT: a stroke's shape parameters, plus a hash of
 * its first `length` points. That recognises "the live stroke grew by three
 * points" through a clone, which is the case the whole cache exists to serve.
 *
 * Export deliberately bypasses this: retaining a 4x Float32 field after a
 * download could cost hundreds of megabytes.
 */
const paintPreviewCache = new Map();
/** Layers kept warm. Each holds at most MAX_PAINT_SIZES preview sizes. */
const MAX_PAINT_LAYERS = 2;
/** The normal preview edge and the smaller interactive paint edge. */
const MAX_PAINT_SIZES = 2;

const strokeSignature = (stroke) =>
  `${stroke?.r ?? 20}|${stroke?.hardness ?? 0.5}|${stroke?.flow ?? 1}|${!!stroke?.erase}|${stroke?.cling ?? 0}`;

/**
 * FNV-1a over the first `end` coordinates. Points are normalised 0..1 and
 * structuredClone preserves doubles exactly, so this is stable across the wire.
 * Hashing a PREFIX is what lets a growing stroke still match its own snapshot.
 */
function hashPoints(pts, end) {
  const n = Math.min(end, pts?.length ?? 0);
  let hash = 2166136261;
  for (let i = 0; i < n; i++) {
    hash = Math.imul(hash ^ ((pts[i] * 1e6) | 0), 16777619);
  }
  return (hash ^ n) >>> 0;
}

const snapshotStrokes = (strokes) =>
  (strokes ?? []).map((stroke) => {
    const length = stroke?.pts?.length ?? 0;
    return { length, signature: strokeSignature(stroke), hash: hashPoints(stroke?.pts, length) };
  });

function cachedPaintField(ctx, guide, w, h, strokes) {
  const layerId = ctx.layerId;
  if (!Array.isArray(strokes) || ctx.mode !== "preview" || !layerId) {
    return paintField(ctx, guide, new Float32Array(w * h), w, h, strokes);
  }

  let entries = paintPreviewCache.get(layerId);
  // Re-insert so map order is least-recently-used first.
  if (entries) paintPreviewCache.delete(layerId);
  else entries = new Map();
  paintPreviewCache.set(layerId, entries);
  while (paintPreviewCache.size > MAX_PAINT_LAYERS) {
    paintPreviewCache.delete(paintPreviewCache.keys().next().value);
  }

  const sizeKey = `${w}x${h}`;
  let entry = entries.get(sizeKey);
  if (!entry) {
    const field = paintField(ctx, guide, new Float32Array(w * h), w, h, strokes);
    entry = { w, h, field, strokes: snapshotStrokes(strokes), revision: strokes._v, guide };
    entries.set(sizeKey, entry);
    while (entries.size > MAX_PAINT_SIZES) entries.delete(entries.keys().next().value);
    return field;
  }
  // Refresh recency so an occasional third preview size evicts the oldest one.
  entries.delete(sizeKey);
  entries.set(sizeKey, entry);

  const before = entry.strokes;

  /**
   * A clinging field is a function of the strokes AND the picture beneath them,
   * so the strokes alone cannot decide this cache is still valid. acquireGuide
   * hands back a stable object for as long as its source is unchanged, which
   * makes identity the whole test.
   *
   * Without it, editing any layer below a cling mask left the preview showing a
   * mask flooded against the OLD image while export — which never touches this
   * cache — quietly produced a different one. Wrong in the only direction that
   * matters: the file disagreeing with the picture you approved.
   */
  const guideChanged = entry.guide !== guide;

  // Fast path: the revision counter is bumped on every mutation and, unlike
  // object identity, does survive structuredClone.
  if (
    !guideChanged &&
    entry.revision != null &&
    strokes._v != null &&
    entry.revision === strokes._v &&
    before.length === strokes.length
  ) {
    return entry.field;
  }

  /** Does stroke `index` still begin with the `length` points we already drew? */
  const matchesPrefix = (index, length) => {
    const old = before[index];
    const current = strokes[index];
    if (!old || !current) return false;
    if (old.signature !== strokeSignature(current)) return false;
    if ((current.pts?.length ?? 0) < length) return false;
    return hashPoints(current.pts, length) === old.hash;
  };
  const unchanged = (index) =>
    !!before[index] &&
    (strokes[index]?.pts?.length ?? 0) === before[index].length &&
    matchesPrefix(index, before[index].length);
  const prefixUnchanged = (count) => {
    for (let i = 0; i < count; i++) if (!unchanged(i)) return false;
    return true;
  };

  // Every incremental route below folds new work into the existing field, which
  // a new guide invalidates wholesale — the old strokes flooded against a
  // different picture and there is nothing to fold onto.
  let incremental = false;
  if (guideChanged) {
    // fall through to the rebuild
  } else if (strokes.length === before.length && strokes.length > 0) {
    const last = strokes.length - 1;
    const oldLength = before[last].length;
    const newLength = strokes[last]?.pts?.length ?? 0;
    if (newLength > oldLength && matchesPrefix(last, oldLength) && prefixUnchanged(last)) {
      // A cling stroke re-floods whole (rasterStroke ignores `start` for those);
      // its max/min accumulation makes the second pass dominate the first, so
      // this is still exactly a cold rasterisation.
      rasterStroke(ctx, guide, entry.field, w, h, strokes[last], Math.max(0, oldLength - 2));
      incremental = true;
    }
  } else if (strokes.length === before.length + 1) {
    if (prefixUnchanged(before.length)) {
      rasterStroke(ctx, guide, entry.field, w, h, strokes[strokes.length - 1]);
      incremental = true;
    }
  }

  const noChange =
    !guideChanged &&
    !incremental &&
    strokes.length === before.length &&
    prefixUnchanged(before.length);
  if (!incremental && !noChange) {
    entry.field.fill(0);
    entry.field._bbox = null;
    entry.field._looseBBox = false;
    paintField(ctx, guide, entry.field, w, h, strokes);
  }
  entry.strokes = snapshotStrokes(strokes);
  entry.revision = strokes._v;
  entry.guide = guide;
  return entry.field;
}

/**
 * Travel-cost guides, keyed by layer id and render size.
 *
 * Building one costs three blurs and three Sobel passes over the frame — fine
 * once, ruinous on every dab of a stroke. During interactive paint the stack
 * BELOW the mask layer is cached and does not change, so the accumulator the
 * guide is derived from is stable; a sampled hash of it recognises that through
 * the structuredClone to the worker, which object identity cannot.
 *
 * Export bypasses the cache for the same reason the paint field does: holding a
 * 4x Float32 guide after a download costs tens of megabytes.
 */
const guideCache = new Map();
const MAX_GUIDES = 2;

/**
 * FNV-1a over every pixel of the accumulator, all three colour channels packed
 * into one word so the whole pixel costs a single multiply.
 *
 * This deliberately reads the entire buffer. A strided sample was cheaper but
 * blind to any change that fell between samples — a small object moving, a
 * localised datamosh — and the brush would go on clinging to edges that were no
 * longer in the picture. Guarding a ~10ms guide build with a sub-millisecond
 * pass is the right trade.
 */
function hashBuf(buf) {
  const d = buf.data;
  let hash = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    hash = Math.imul(hash ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619);
  }
  return (hash ^ buf.w ^ (buf.h << 16)) >>> 0;
}

function acquireGuide(ctx, src) {
  if (ctx.mode !== "preview" || !ctx.layerId) return buildGuide(ctx, src);

  const key = `${ctx.layerId}|${src.w}x${src.h}`;
  const hash = hashBuf(src);
  const hit = guideCache.get(key);
  if (hit && hit.hash === hash) {
    // Re-insert so map order stays least-recently-used first.
    guideCache.delete(key);
    guideCache.set(key, hit);
    return hit.guide;
  }

  const guide = buildGuide(ctx, src);
  guideCache.delete(key);
  guideCache.set(key, { hash, guide });
  while (guideCache.size > MAX_GUIDES) {
    guideCache.delete(guideCache.keys().next().value);
  }
  return guide;
}

/** Tight bbox of non-zero samples; null if empty or essentially full-frame. */
function fieldBBox(field, w, h) {
  if (field._bbox && !field._looseBBox && field._bbox.x1 >= field._bbox.x0) {
    const b = field._bbox;
    return {
      x0: Math.max(0, b.x0 | 0),
      y0: Math.max(0, b.y0 | 0),
      x1: Math.min(w - 1, b.x1 | 0),
      y1: Math.min(h - 1, b.y1 | 0),
    };
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (field[row + x] > 1e-4) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  // Nearly full-frame → not worth clipping composites.
  if (x0 <= 1 && y0 <= 1 && x1 >= w - 2 && y1 >= h - 2) return null;
  return { x0, y0, x1, y1 };
}

export default {
  id: "mask",
  name: "Mask",
  category: "mask",
  kind: "mask",
  params: [
    { key: "source", type: "select", label: "Source", options: SOURCES, default: "luma" },

    { key: "channel", type: "select", label: "Channel", options: CHANNELS, default: "red", showIf: (p) => p.source === "channel" },
    { key: "hueTarget", type: "range", label: "Hue", min: 0, max: 360, step: 1, default: 0, showIf: (p) => p.source === "hue" },
    { key: "hueWidth", type: "range", label: "Hue width", min: 5, max: 180, step: 1, default: 40, showIf: (p) => p.source === "hue" },
    { key: "bandLow", type: "range", label: "Band low", min: 0, max: 1, step: 0.01, default: 0.3, showIf: (p) => p.source === "band" },
    { key: "bandHigh", type: "range", label: "Band high", min: 0, max: 1, step: 0.01, default: 0.7, showIf: (p) => p.source === "band" },
    { key: "keyColor", type: "color", label: "Key colour", default: "#3aa0ff", showIf: (p) => p.source === "chroma" },
    { key: "keyTolerance", type: "range", label: "Tolerance", min: 0.02, max: 1, step: 0.01, default: 0.25, showIf: (p) => p.source === "chroma" },
    { key: "centerBias", type: "range", label: "Centre bias", min: 0, max: 1, step: 0.01, default: 0.35, showIf: (p) => p.source === "saliency" },

    { key: "radius", type: "range", label: "Sample radius", min: 0.5, max: 40, step: 0.5, default: 4, unit: "u", showIf: (p) => p.source === "edge" || p.source === "detail" },
    { key: "noiseScale", type: "range", label: "Noise scale", min: 5, max: 600, step: 5, default: 160, unit: "u", showIf: (p) => p.source === "noise" || p.source === "flow" },
    { key: "octaves", type: "range", label: "Octaves", min: 1, max: 7, step: 1, default: 4, showIf: (p) => p.source === "noise" },
    { key: "bands", type: "range", label: "Bands", min: 1, max: 24, step: 0.5, default: 5, showIf: (p) => p.source === "flow" },
    { key: "cellSize", type: "range", label: "Cell size", min: 5, max: 300, step: 1, default: 60, unit: "u", showIf: (p) => p.source === "voronoi" },
    { key: "shape", type: "select", label: "Shape", options: ["circle", "rect", "diamond"], default: "circle", showIf: (p) => p.source === "shape" },
    { key: "center", type: "xy", label: "Centre", default: { x: 0.5, y: 0.5 } },
    { key: "extent", type: "range", label: "Extent", min: 0.02, max: 1.5, step: 0.01, default: 0.45, showIf: (p) => p.source === "radial" || p.source === "shape" },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 6.283, step: 0.01, default: 0, showIf: (p) => p.source === "linear" },

    { key: "strokes", type: "paint", label: "Brush", default: [], showIf: (p) => p.source === "paint" },

    { key: "threshold", type: "range", label: "Threshold", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "softness", type: "range", label: "Softness", min: 0, max: 1, step: 0.01, default: 0.2 },
    { key: "edgeJitter", type: "range", label: "Tear", min: 0, max: 120, step: 0.5, default: 0, unit: "u" },
    { key: "jitterScale", type: "range", label: "Tear scale", min: 5, max: 400, step: 5, default: 60, unit: "u", showIf: (p) => p.edgeJitter > 0 },
    { key: "grow", type: "range", label: "Grow / shrink", min: -30, max: 30, step: 0.5, default: 0, unit: "u" },
    { key: "feather", type: "range", label: "Feather", min: 0, max: 80, step: 0.5, default: 4, unit: "u" },

    {
      key: "edgeStyle",
      type: "select",
      label: "Edge style",
      options: EDGE_STYLES,
      default: "smooth",
      hint: "how the boundary breaks up — stairs, dither dissolve, checker",
    },
    { key: "edgeBlock", type: "range", label: "Edge block", min: 1, max: 60, step: 0.5, default: 6, unit: "u", showIf: (p) => p.edgeStyle !== "smooth" },
    { key: "invert", type: "toggle", label: "Invert", default: false },
  ],

  compute(ctx, src, p) {
    const { w, h } = src;
    const s = src.data;
    const nPix = w * h;
    // Paint supplies a cached field; all procedural sources allocate a fresh
    // one. Avoiding an unused Float32Array here removes a large allocation from
    // every pointer-driven preview render.
    const pooled = p.source !== "paint" && typeof ctx.acquireF32 === "function";
    let field = p.source === "paint" ? null : pooled ? ctx.acquireF32(nPix) : new Float32Array(nPix);
    let releaseField = pooled;
    const cx = p.center.x * w;
    const cy = p.center.y * h;
    const maxR = Math.hypot(w, h) / 2;
    // Interactive paint: skip grow/feather/edge-style so each dab stays cheap.
    const lightPost =
      !!ctx.interactivePaint && p.source === "paint" && ctx.mode === "preview";

    switch (p.source) {
      case "channel": {
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          const r = s[q] / 255;
          const g = s[q + 1] / 255;
          const b = s[q + 2] / 255;
          switch (p.channel) {
            case "green": field[i] = g; break;
            case "blue": field[i] = b; break;
            case "cyan": field[i] = 1 - r; break;
            case "magenta": field[i] = 1 - g; break;
            case "yellow": field[i] = 1 - b; break;
            default: field[i] = r;
          }
        }
        break;
      }

      case "hue": {
        const half = p.hueWidth / 2;
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          let d = Math.abs(hueOf(s[q], s[q + 1], s[q + 2]) - p.hueTarget);
          if (d > 180) d = 360 - d;
          // weight by saturation so grey pixels do not register as "on hue"
          field[i] = Math.max(0, 1 - d / half) * saturationOf(s[q], s[q + 1], s[q + 2]);
        }
        break;
      }

      case "saturation": {
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          field[i] = saturationOf(s[q], s[q + 1], s[q + 2]);
        }
        break;
      }

      case "band": {
        const lo = Math.min(p.bandLow, p.bandHigh);
        const hi = Math.max(p.bandLow, p.bandHigh);
        const edge = 0.06;
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          const l = luma(s[q], s[q + 1], s[q + 2]) / 255;
          field[i] = smoothstep(lo - edge, lo + edge, l) * (1 - smoothstep(hi - edge, hi + edge, l));
        }
        break;
      }

      case "chroma": {
        const [kr, kg, kb] = parseHex(p.keyColor);
        const tol = p.keyTolerance * 441.67; // max RGB distance
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          const d = Math.hypot(s[q] - kr, s[q + 1] - kg, s[q + 2] - kb);
          field[i] = Math.max(0, 1 - d / tol);
        }
        break;
      }

      case "saliency":
        saliencyField(src, field, p.centerBias);
        break;

      case "paint": {
        // Only strokes that actually cling need the picture analysed.
        const needsGuide =
          Array.isArray(p.strokes) && p.strokes.some((s) => s?.cling > 0);
        field = cachedPaintField(ctx, needsGuide ? acquireGuide(ctx, src) : null, w, h, p.strokes);
        break;
      }

      case "edge": {
        // Precompute luma once, then Sobel on the plane. Per-sample luma() was
        // the dominant cost of edge masks at export resolution.
        const r = Math.max(1, Math.round(ctx.u(p.radius)));
        const Lplane = typeof ctx.acquireF32 === "function" ? ctx.acquireF32(nPix) : new Float32Array(nPix);
        for (let i = 0, q = 0; i < nPix; i++, q += 4) {
          Lplane[i] = luma(s[q], s[q + 1], s[q + 2]) * (1 / 255);
        }
        const at = (x, y) => {
          const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
          const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
          return Lplane[yy * w + xx];
        };
        let peak = 1e-6;
        for (let y = 0; y < h; y++) {
          const row = y * w;
          for (let x = 0; x < w; x++) {
            const gx =
              at(x + r, y - r) + 2 * at(x + r, y) + at(x + r, y + r) -
              at(x - r, y - r) - 2 * at(x - r, y) - at(x - r, y + r);
            const gy =
              at(x - r, y + r) + 2 * at(x, y + r) + at(x + r, y + r) -
              at(x - r, y - r) - 2 * at(x, y - r) - at(x + r, y - r);
            const g = Math.hypot(gx, gy) * 0.25;
            field[row + x] = g;
            if (g > peak) peak = g;
          }
        }
        const invPeak = 1 / peak;
        for (let i = 0; i < nPix; i++) field[i] *= invPeak;
        if (typeof ctx.releaseF32 === "function") ctx.releaseF32(Lplane);
        break;
      }

      case "detail": {
        // Local variance via blurred first and second moments — O(n) whatever
        // the radius, which matters at export size.
        const m1 = createMask(w, h);
        const m2 = createMask(w, h);
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          const v = luma(s[q], s[q + 1], s[q + 2]) / 255;
          m1.data[i] = v;
          m2.data[i] = v * v;
        }
        const r = Math.max(1, ctx.u(p.radius));
        blurMask(m1, r);
        blurMask(m2, r);
        let peak = 1e-6;
        for (let i = 0; i < field.length; i++) {
          const v = Math.sqrt(Math.max(0, m2.data[i] - m1.data[i] * m1.data[i]));
          field[i] = v;
          if (v > peak) peak = v;
        }
        for (let i = 0; i < field.length; i++) field[i] /= peak;
        break;
      }

      case "radial": {
        const R = maxR * p.extent;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) field[y * w + x] = 1 - Math.min(1, Math.hypot(x - cx, y - cy) / R);
        }
        break;
      }

      case "linear": {
        const dx = Math.cos(p.angle);
        const dy = Math.sin(p.angle);
        const len = Math.abs(dx) * w + Math.abs(dy) * h;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            field[y * w + x] = ((x - cx) * dx + (y - cy) * dy) / len + 0.5;
          }
        }
        break;
      }

      case "noise": {
        const sc = Math.max(1, ctx.u(p.noiseScale));
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) field[y * w + x] = fbm(x / sc, y / sc, ctx.noiseSeed, p.octaves);
        }
        break;
      }

      case "flow": {
        const sc = Math.max(4, ctx.u(p.noiseScale));
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            field[y * w + x] = (Math.sin(curlAngle(x, y, ctx.noiseSeed, sc) * p.bands) + 1) / 2;
          }
        }
        break;
      }

      case "voronoi": {
        const spacing = Math.max(3, ctx.u(p.cellSize));
        const pts = jitteredPoints(w + spacing, h + spacing, spacing, ctx.noiseSeed, 0.85);
        const grid = new SiteGrid(pts, w + spacing, h + spacing, spacing);
        const near = { site: null, d1: 0, d2: 0 };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            grid.nearest2(x, y, near);
            field[y * w + x] = near.site ? pointRandom(near.site, ctx.noiseSeed + 5) : 0;
          }
        }
        break;
      }

      case "shape": {
        const R = maxR * p.extent;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ex = Math.abs(x - cx);
            const ey = Math.abs(y - cy);
            const dist = p.shape === "rect" ? Math.max(ex, ey) : p.shape === "diamond" ? ex + ey : Math.hypot(ex, ey);
            field[y * w + x] = 1 - Math.min(1, dist / R);
          }
        }
        break;
      }

      default: {
        for (let i = 0, q = 0; i < field.length; i++, q += 4) {
          field[i] = luma(s[q], s[q + 1], s[q + 2]) / 255;
        }
      }
    }

    // --- torn edges -------------------------------------------------------
    let read = field;
    let releaseDisplaced = false;
    const jitter = lightPost ? 0 : ctx.u(p.edgeJitter);
    if (jitter > 0.5) {
      const jscale = Math.max(2, ctx.u(p.jitterScale));
      // Interactive / low-res tear: sample noise on a coarser lattice then
      // bilinear-upsample offsets — same look family, far fewer noise2 calls.
      const step = ctx.mode === "preview" && jitter > 8 ? 2 : 1;
      const displaced =
        typeof ctx.acquireF32 === "function" ? ctx.acquireF32(nPix) : new Float32Array(nPix);
      releaseDisplaced = typeof ctx.releaseF32 === "function";
      if (step > 1) {
        const sw = Math.ceil(w / step);
        const sh = Math.ceil(h / step);
        const ox = typeof ctx.acquireF32 === "function" ? ctx.acquireF32(sw * sh) : new Float32Array(sw * sh);
        const oy = typeof ctx.acquireF32 === "function" ? ctx.acquireF32(sw * sh) : new Float32Array(sw * sh);
        for (let sy = 0; sy < sh; sy++) {
          for (let sx = 0; sx < sw; sx++) {
            const x = sx * step;
            const y = sy * step;
            const i = sy * sw + sx;
            ox[i] = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 11) - 0.5) * 2 * jitter;
            oy[i] = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 29) - 0.5) * 2 * jitter;
          }
        }
        for (let y = 0; y < h; y++) {
          const fy = y / step;
          const sy0 = Math.min(sh - 1, fy | 0);
          const sy1 = Math.min(sh - 1, sy0 + 1);
          const ty = fy - sy0;
          for (let x = 0; x < w; x++) {
            const fx = x / step;
            const sx0 = Math.min(sw - 1, fx | 0);
            const sx1 = Math.min(sw - 1, sx0 + 1);
            const tx = fx - sx0;
            const i00 = sy0 * sw + sx0;
            const i10 = sy0 * sw + sx1;
            const i01 = sy1 * sw + sx0;
            const i11 = sy1 * sw + sx1;
            const jx =
              (ox[i00] + (ox[i10] - ox[i00]) * tx) * (1 - ty) +
              (ox[i01] + (ox[i11] - ox[i01]) * tx) * ty;
            const jy =
              (oy[i00] + (oy[i10] - oy[i00]) * tx) * (1 - ty) +
              (oy[i01] + (oy[i11] - oy[i01]) * tx) * ty;
            displaced[y * w + x] = sampleField(field, w, h, x + jx, y + jy);
          }
        }
        if (typeof ctx.releaseF32 === "function") {
          ctx.releaseF32(ox);
          ctx.releaseF32(oy);
        }
      } else {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const jx = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 11) - 0.5) * 2 * jitter;
            const jy = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 29) - 0.5) * 2 * jitter;
            displaced[y * w + x] = sampleField(field, w, h, x + jx, y + jy);
          }
        }
      }
      read = displaced;
    }

    // --- threshold, morph, feather ---------------------------------------
    const mask = createMask(w, h);
    const half = p.softness / 2;
    const e0 = p.threshold - half;
    const e1 = p.threshold + half;
    for (let i = 0; i < mask.data.length; i++) {
      const v = smoothstep(e0, e1, read[i]);
      mask.data[i] = p.invert ? 1 - v : v;
    }

    if (!lightPost) {
      const grow = ctx.u(Math.abs(p.grow));
      if (grow >= 1) morph(mask, grow, p.grow > 0);

      const feather = ctx.u(p.feather);
      if (feather >= 0.5) blurMask(mask, feather);

      // --- edge style -------------------------------------------------------
      // Applied last, on the soft ramp the feather just produced: a boundary at
      // 0.3 coverage becomes 30% of the cells filled, which is what makes the
      // holly reference dissolve into a checker instead of cutting cleanly.
      if (p.edgeStyle !== "smooth") {
        const block = Math.max(1, ctx.u(p.edgeBlock));
        const d = mask.data;

        if (p.edgeStyle === "stairs") {
          // Average each block, then re-threshold: quantises the boundary onto a
          // coarse grid so it staircases.
          const cols = Math.ceil(w / block);
          const rows = Math.ceil(h / block);
          for (let by = 0; by < rows; by++) {
            for (let bx = 0; bx < cols; bx++) {
              const x0 = Math.floor(bx * block);
              const y0 = Math.floor(by * block);
              const x1 = Math.min(w, Math.floor((bx + 1) * block));
              const y1 = Math.min(h, Math.floor((by + 1) * block));
              let sum = 0;
              let count = 0;
              for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                  sum += d[y * w + x];
                  count++;
                }
              }
              const v = count ? (sum / count >= 0.5 ? 1 : 0) : 0;
              for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) d[y * w + x] = v;
              }
            }
          }
        } else {
          for (let y = 0; y < h; y++) {
            const cyi = Math.floor(y / block);
            for (let x = 0; x < w; x++) {
              const cxi = Math.floor(x / block);
              let t;
              if (p.edgeStyle === "checker") t = checkerAt(cxi, cyi) * 0.5 + 0.25;
              else if (p.edgeStyle === "weave") t = ((cxi + cyi) % 3) / 3 + 0.17;
              else t = bayerAt(cxi, cyi, 8);
              const i = y * w + x;
              d[i] = d[i] > t ? 1 : 0;
            }
          }
        }
      }
    }

    // Paint (and sparse fields) expose a bbox so compositeInto can skip empty
    // regions. Post-process (grow/feather) expands it when present.
    if (p.source === "paint") {
      let bbox = fieldBBox(field, w, h);
      if (bbox && !lightPost) {
        // The bbox is measured on the RAW field, but the published mask is read
        // through the tear displacement — a pixel can pick up paint from up to
        // `jitter` away, so the torn fringe lives outside the painted box. Not
        // padding for it clipped the tear off flat at the untorn boundary.
        const pad =
          Math.ceil(ctx.u(Math.abs(p.grow)) || 0) +
          Math.ceil(ctx.u(p.feather) || 0) +
          Math.ceil(jitter || 0) +
          1;
        bbox = {
          x0: Math.max(0, bbox.x0 - pad),
          y0: Math.max(0, bbox.y0 - pad),
          x1: Math.min(w - 1, bbox.x1 + pad),
          y1: Math.min(h - 1, bbox.y1 + pad),
        };
      }
      mask.bbox = bbox;
    }

    // Return pooled scratch now that mask.data owns the final values.
    // Never release paint-cache fields (releaseField is false for paint).
    if (typeof ctx.releaseF32 === "function") {
      if (releaseDisplaced && read !== field) ctx.releaseF32(read);
      if (releaseField && field) ctx.releaseF32(field);
    }

    return mask;
  },
};
