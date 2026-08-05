import { createMask, blurMask } from "../buffer.js";
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
function rasterStroke(ctx, field, w, h, stroke, start = 0) {
  const pts = stroke?.pts;
  if (!pts || pts.length < 2) return;
  const r = Math.max(1, ctx.u(stroke.r ?? 20));
  const hardness = stroke.hardness ?? 0.5;
  const flow = stroke.flow ?? 1;
  const erase = !!stroke.erase;
  const inner = r * hardness;
  const step = Math.max(1, r * 0.35);

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

      for (let y = ay; y <= by; y++) {
        for (let x = ax; x <= bx; x++) {
          const d = Math.hypot(x - px, y - py);
          if (d > r) continue;
          const fall = d <= inner ? 1 : 1 - (d - inner) / (r - inner || 1);
          const add = fall * flow;
          const j = y * w + x;
          field[j] = erase
            ? Math.max(0, field[j] - add)
            : Math.min(1, field[j] + add);
        }
      }
    }
  }
}

function paintField(ctx, field, w, h, strokes) {
  for (const stroke of strokes ?? []) rasterStroke(ctx, field, w, h, stroke);
  return field;
}

// Two preview-sized raw fields per live stroke list: the normal 900px preview
// and the smaller interactive paint preview. Export deliberately bypasses this
// cache, since retaining a 4x Float32 field after download could cost hundreds
// of megabytes. Weak keys let deleted/replaced layers release both fields.
const paintPreviewCache = new WeakMap();
const strokeSignature = (stroke) =>
  `${stroke?.r ?? 20}|${stroke?.hardness ?? 0.5}|${stroke?.flow ?? 1}|${!!stroke?.erase}`;
const snapshotStrokes = (strokes) =>
  (strokes ?? []).map((stroke) => ({
    stroke,
    length: stroke?.pts?.length ?? 0,
    signature: strokeSignature(stroke),
  }));

function cachedPaintField(ctx, w, h, strokes) {
  if (!Array.isArray(strokes) || ctx.mode !== "preview") {
    return paintField(ctx, new Float32Array(w * h), w, h, strokes);
  }

  let entries = paintPreviewCache.get(strokes);
  if (!entries) {
    entries = new Map();
    paintPreviewCache.set(strokes, entries);
  }
  const sizeKey = `${w}x${h}`;
  let entry = entries.get(sizeKey);
  if (!entry) {
    const field = paintField(ctx, new Float32Array(w * h), w, h, strokes);
    entry = { w, h, field, strokes: snapshotStrokes(strokes), revision: strokes._v };
    entries.set(sizeKey, entry);
    while (entries.size > 2) entries.delete(entries.keys().next().value);
    return field;
  }
  // Refresh recency so an occasional third preview size evicts the oldest one.
  entries.delete(sizeKey);
  entries.set(sizeKey, entry);

  const before = entry.strokes;
  const sameStroke = (index) => {
    const old = before[index];
    const current = strokes[index];
    return old?.stroke === current && old.signature === strokeSignature(current);
  };
  const unchanged = (index) =>
    sameStroke(index) && before[index].length === (strokes[index]?.pts?.length ?? 0);

  let incremental = false;
  if (strokes.length === before.length && strokes.length > 0) {
    const last = strokes.length - 1;
    const prefixOk = before.slice(0, last).every((_, index) => unchanged(index));
    const oldLength = before[last].length;
    const newLength = strokes[last]?.pts?.length ?? 0;
    if (prefixOk && sameStroke(last) && newLength > oldLength) {
      rasterStroke(ctx, entry.field, w, h, strokes[last], Math.max(0, oldLength - 2));
      incremental = true;
    }
  } else if (strokes.length === before.length + 1) {
    const prefixOk = before.every((_, index) => unchanged(index));
    if (prefixOk) {
      rasterStroke(ctx, entry.field, w, h, strokes[strokes.length - 1]);
      incremental = true;
    }
  }

  const noChange =
    strokes.length === before.length &&
    before.every((_, index) => unchanged(index)) &&
    entry.revision === strokes._v;
  if (!incremental && !noChange) {
    entry.field.fill(0);
    paintField(ctx, entry.field, w, h, strokes);
  }
  entry.strokes = snapshotStrokes(strokes);
  entry.revision = strokes._v;
  return entry.field;
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
    // Paint supplies a cached field; all procedural sources allocate a fresh
    // one. Avoiding an unused Float32Array here removes a large allocation from
    // every pointer-driven preview render.
    let field = p.source === "paint" ? null : new Float32Array(w * h);
    const cx = p.center.x * w;
    const cy = p.center.y * h;
    const maxR = Math.hypot(w, h) / 2;

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

      case "paint":
        field = cachedPaintField(ctx, w, h, p.strokes);
        break;

      case "edge": {
        // Sobel at an artwork-unit radius rather than the fixed 1px of a
        // textbook kernel — a 1px kernel finds completely different edges at
        // 4x export than in the preview.
        const r = Math.max(1, Math.round(ctx.u(p.radius)));
        const L = (x, y) => {
          const xx = Math.max(0, Math.min(w - 1, x));
          const yy = Math.max(0, Math.min(h - 1, y));
          const i = (yy * w + xx) * 4;
          return luma(s[i], s[i + 1], s[i + 2]) / 255;
        };
        let peak = 1e-6;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const gx =
              L(x + r, y - r) + 2 * L(x + r, y) + L(x + r, y + r) -
              L(x - r, y - r) - 2 * L(x - r, y) - L(x - r, y + r);
            const gy =
              L(x - r, y + r) + 2 * L(x, y + r) + L(x + r, y + r) -
              L(x - r, y - r) - 2 * L(x, y - r) - L(x + r, y - r);
            const g = Math.hypot(gx, gy) / 4;
            field[y * w + x] = g;
            if (g > peak) peak = g;
          }
        }
        for (let i = 0; i < field.length; i++) field[i] /= peak;
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
    const jitter = ctx.u(p.edgeJitter);
    if (jitter > 0.5) {
      const jscale = Math.max(2, ctx.u(p.jitterScale));
      const displaced = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const jx = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 11) - 0.5) * 2 * jitter;
          const jy = (noise2(x / jscale, y / jscale, ctx.noiseSeed + 29) - 0.5) * 2 * jitter;
          displaced[y * w + x] = sampleField(field, w, h, x + jx, y + jy);
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
            let n = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) { sum += d[y * w + x]; n++; }
            }
            const v = n ? (sum / n >= 0.5 ? 1 : 0) : 0;
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

    return mask;
  },
};
