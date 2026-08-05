/**
 * Presets.
 *
 * A preset is a partial spec — only the params that differ from the schema
 * defaults are listed, so presets keep working when a processor gains a new
 * parameter. Mask wiring uses symbolic `ref` / `maskRef` names because layer
 * ids are generated fresh on every instantiation.
 */

import { createLayer } from "../pipeline.js";
import { PROCESSORS } from "../processors/index.js";

const STORE_KEY = "glitchinarium.presets.v1";

/**
 * Coerce a raw preset param value through the processor schema so bad JSON
 * cannot inject unknown keys or NaN coordinates that crash the control panel.
 */
function coerceParam(def, value) {
  switch (def.type) {
    case "range": {
      const n = Number(value);
      if (!Number.isFinite(n)) return structuredClone(def.default);
      const lo = Math.min(def.min, def.max);
      const hi = Math.max(def.min, def.max);
      return Math.max(lo, Math.min(hi, n));
    }
    case "toggle":
      return !!value;
    case "select":
      return def.options?.includes(value) ? value : structuredClone(def.default);
    case "font":
      return typeof value === "string" && value ? value : structuredClone(def.default);
    case "color":
      return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value.trim())
        ? value.trim()
        : structuredClone(def.default);
    case "text":
      return typeof value === "string" ? value : structuredClone(def.default);
    case "xy": {
      if (
        value &&
        typeof value === "object" &&
        Number.isFinite(value.x) &&
        Number.isFinite(value.y)
      ) {
        return {
          x: Math.max(0, Math.min(1, value.x)),
          y: Math.max(0, Math.min(1, value.y)),
        };
      }
      return structuredClone(def.default);
    }
    case "paint":
      return Array.isArray(value) ? value : [];
    default:
      return value === undefined ? structuredClone(def.default) : value;
  }
}

export const BUILTIN = {
  "mac-os-9": {
    name: "Mac OS 9",
    seed: 7,
    layers: [
      { type: "levels", params: { contrast: 0.25, gamma: 1.1 } },
      {
        type: "dither",
        params: { method: "atkinson", blockSize: 5, levels: 2, colorMode: "mono", crisp: true },
      },
    ],
  },

  "still-life": {
    name: "Still life ASCII",
    seed: 21,
    layers: [
      {
        type: "datamosh",
        params: { mode: "blocks", blockSize: 12, amount: 0.35, drift: 18, emitMask: true },
        opacity: 0.9,
      },
      {
        type: "mask",
        ref: "detail",
        params: {
          source: "detail",
          radius: 6,
          threshold: 0.34,
          softness: 0.1,
          edgeJitter: 26,
          jitterScale: 45,
          feather: 3,
          grow: 4,
        },
      },
      {
        type: "ascii",
        maskRef: "detail",
        params: {
          columns: 130,
          charset: "letters",
          colorMode: "mono",
          color: "#141414",
          bg: "#f6e6cd",
          bgAlpha: 1,
          contrast: 0.3,
          cellRatio: 1.6,
        },
      },
    ],
  },

  trencadis: {
    name: "Trencadís",
    seed: 3,
    layers: [
      {
        type: "kaleido",
        params: { mode: "trencadis", shardSize: 30, shardJitter: 0.9, shardRotate: 0.4, grout: 1.8 },
      },
      { type: "gradient-map", params: { palette: "park-guell", mix: 0.45 } },
      { type: "levels", params: { contrast: 0.15, saturation: 1.15 } },
    ],
  },

  "sunset-ornament": {
    name: "Sunset ornament",
    seed: 42,
    layers: [
      { type: "gradient-map", params: { palette: "sunset-sea", mix: 0.7, spread: 1.3 } },
      {
        type: "kaleido",
        params: { mode: "radial", folds: 6, zoom: 1.4, center: { x: 0.5, y: 0.55 } },
        blend: "overlay",
        opacity: 0.55,
      },
      { type: "rgb-split", params: { mode: "radial", amount: 9 }, opacity: 0.7 },
      {
        type: "mask",
        ref: "corners",
        params: { source: "shape", shape: "diamond", extent: 0.9, threshold: 0.45, softness: 0.5, invert: true, feather: 20 },
      },
      {
        type: "ascii",
        maskRef: "corners",
        params: {
          columns: 150,
          charset: "digits",
          colorMode: "source",
          bgAlpha: 0,
          contrast: 0.4,
          cellRatio: 1.4,
        },
        opacity: 0.85,
      },
    ],
  },

  "flow-sort": {
    name: "Flow sort",
    seed: 11,
    layers: [
      { type: "levels", params: { contrast: 0.2, saturation: 1.2 } },
      {
        type: "pixel-sort",
        params: { direction: "flow", flowScale: 200, low: 0.2, high: 0.72, maxRun: 120, key: "luma" },
      },
      { type: "ripple", params: { mode: "curl", amplitude: 10, wavelength: 220 }, opacity: 0.6 },
      { type: "gradient-map", params: { palette: "casa-batllo", mix: 0.35 } },
    ],
  },

  "catenary-glass": {
    name: "Catenary glass",
    seed: 5,
    layers: [
      { type: "ripple", params: { mode: "catenary", amplitude: 30, wavelength: 150, sag: 0.45 } },
      { type: "gradient-map", params: { palette: "sagrada", mix: 0.8 } },
      {
        type: "dither",
        params: { method: "bayer8", blockSize: 3, levels: 4, colorMode: "rgb", crisp: true },
        opacity: 0.75,
      },
    ],
  },

  "gradient-ascii": {
    name: "Gradient ASCII",
    seed: 9,
    layers: [
      {
        type: "mask",
        ref: "ramp",
        params: { source: "linear", angle: 0, threshold: 0.5, softness: 1, feather: 0 },
      },
      {
        type: "ascii",
        params: { columns: 46, subdivide: 3, bgAlpha: 1, bg: "#f6e6cd", colorMode: "mono", color: "#141414", cellRatio: 1.7 },
        mods: { subdivide: { min: 0, max: 1, invert: false, maskRef: "ramp" } },
      },
      { type: "grain", params: { type: "paper", scale: 1.2, strength: 0.25 } },
    ],
  },

  "castle-file": {
    name: "Open file",
    seed: 31,
    layers: [
      { type: "region-echo", params: { count: 9, offset: 45, stroke: true, strokeColor: "#2f6fe0", steps: 10 } },
      { type: "detection", params: { count: 7, color: "#2f6fe0", labels: true, scatterDigits: 24, style: "box" } },
      { type: "grain", params: { type: "canvas", scale: 2.2, strength: 0.3 } },
    ],
  },

  "pixel-poster": {
    name: "Pixel poster",
    seed: 4,
    layers: [
      { type: "levels", params: { contrast: 0.35, saturation: 0.7 } },
      { type: "palette", params: { palette: "oxblood", dither: "bayer8", ditherAmount: 0.8, blockSize: 3 } },
      { type: "border", params: { style: "greek", unit: 3, width: 9, inset: 18, color: "#e0a458", matte: true, matteColor: "#2a1220" } },
    ],
  },

  "neon-outline": {
    name: "Neon outline",
    seed: 12,
    layers: [
      { type: "levels", params: { contrast: 0.2, saturation: 1.4 } },
      { type: "block-palette", params: { set: "vivid", amount: 0.1, blockSize: 11, clusterScale: 5 } },
      { type: "edge-trace", params: { charset: "custom", customChars: "@", cellSize: 7, threshold: 0.13, color: "#b6ff2e", bgAlpha: 0 } },
      { type: "grain", params: { type: "riso", scale: 2, strength: 0.3 } },
    ],
  },

  "press-proof": {
    name: "Press proof",
    seed: 6,
    layers: [
      { type: "screen", params: { mode: "cmyk", pitch: 7, sharpness: 0.45 } },
      { type: "grain", params: { type: "riso", scale: 1.6, strength: 0.28, tintAmount: 0.25 } },
    ],
  },

  "crt-decay": {
    name: "CRT decay",
    seed: 77,
    layers: [
      { type: "levels", params: { contrast: 0.45, saturation: 1.5, gamma: 0.85 } },
      { type: "scanline-smear", params: { mode: "stretch", bandHeight: 2.5, amount: 0.22, length: 200 } },
      { type: "glow", params: { threshold: 0.62, radius: 22, intensity: 1.1 } },
      // A grille costs a lot of light; brightness puts back roughly what the
      // stripe and scanline masks take out rather than blowing the highlights.
      { type: "crt", params: { scanPitch: 5, scanDepth: 0.45, grille: "aperture", grillePitch: 4, grilleDepth: 0.55, curve: 0.14, bleed: 5, brightness: 1.5, vignette: 0.45 } },
    ],
  },

  "engraved-flow": {
    name: "Engraved flow",
    seed: 17,
    layers: [
      { type: "levels", params: { contrast: 0.3, saturation: 0 } },
      {
        type: "hatch",
        params: { mode: "crosshatch", cellSize: 9, weight: 1, rotate: "curl", flowScale: 130, levels: 4 },
      },
    ],
  },

  "halt-signal": {
    name: "Halt signal",
    seed: 1984,
    layers: [
      { type: "levels", params: { contrast: 0.35, gamma: 0.95, saturation: 1.1 } },
      {
        type: "crystal-glass",
        params: {
          cellW: 28,
          cellH: 10,
          sizeJitter: 0.55,
          detailBias: 0.4,
          warp: 0.2,
          posterize: 12,
          tint: "#c01018",
          tintMix: 0.78,
          crush: 0.48,
          streakLength: 240,
          streakHeight: 2.5,
          sparks: 0.4,
          sparkLength: 52,
          sparkColor: "#f2eaff",
        },
      },
      {
        type: "glow",
        params: { threshold: 0.78, radius: 14, intensity: 0.55 },
        opacity: 0.65,
        blend: "screen",
      },
    ],
  },
};

/** Turn a preset spec into real layers, resolving symbolic mask references. */
export function instantiate(preset) {
  if (!preset || typeof preset !== "object") {
    throw new Error("Invalid preset (expected an object)");
  }
  if (!Array.isArray(preset.layers)) {
    throw new Error("Invalid preset (missing layers array)");
  }

  const refToId = new Map();
  const layers = preset.layers.map((spec, index) => {
    if (!spec || typeof spec !== "object") {
      throw new Error(`Layer ${index + 1}: invalid entry`);
    }
    if (!PROCESSORS[spec.type]) {
      throw new Error(`Layer ${index + 1}: unknown processor “${spec.type}”`);
    }

    const opacity = Number(spec.opacity);
    const feather = Number(spec.maskFeather);
    const layer = createLayer(spec.type, {
      blend: typeof spec.blend === "string" ? spec.blend : "normal",
      opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1,
      enabled: spec.enabled !== false,
      maskInvert: !!spec.maskInvert,
      maskFeather: Number.isFinite(feather) ? Math.max(0, feather) : 0,
    });

    // Only known schema keys — ignore junk from hand-edited JSON.
    const raw = spec.params && typeof spec.params === "object" ? spec.params : {};
    for (const def of PROCESSORS[spec.type].params) {
      if (Object.prototype.hasOwnProperty.call(raw, def.key)) {
        layer.params[def.key] = coerceParam(def, raw[def.key]);
      }
    }

    layer.locks = {};
    if (spec.locks && typeof spec.locks === "object") {
      for (const [k, v] of Object.entries(spec.locks)) {
        if (v) layer.locks[k] = true;
      }
    }

    if (typeof spec.ref === "string" && spec.ref) refToId.set(spec.ref, layer.id);
    layer._maskRef = typeof spec.maskRef === "string" ? spec.maskRef : null;
    layer._modRefs = spec.mods && typeof spec.mods === "object" ? spec.mods : null;
    return layer;
  });

  for (const layer of layers) {
    if (layer._maskRef) layer.mask = refToId.get(layer._maskRef) ?? null;
    // Parameter modulation targets are stored by symbolic ref too.
    if (layer._modRefs) {
      layer.mods = {};
      for (const [key, m] of Object.entries(layer._modRefs)) {
        if (!m || typeof m !== "object") continue;
        const def = PROCESSORS[layer.type].params.find((p) => p.key === key && p.mod);
        if (!def || !Number.isFinite(def.min) || !Number.isFinite(def.max)) continue;
        const min = Number(m.min);
        const max = Number(m.max);
        layer.mods[key] = {
          min: Number.isFinite(min) ? Math.max(def.min, Math.min(def.max, min)) : def.min,
          max: Number.isFinite(max) ? Math.max(def.min, Math.min(def.max, max)) : def.max,
          invert: !!m.invert,
          mask: typeof m.maskRef === "string" ? refToId.get(m.maskRef) ?? null : null,
        };
      }
    }
    delete layer._maskRef;
    delete layer._modRefs;
  }
  return layers;
}

/** Serialise the live stack back into a portable spec. */
export function serialise(name, seed, layers) {
  const idToRef = new Map();
  layers.forEach((l, i) => idToRef.set(l.id, `r${i}`));
  return {
    name,
    seed,
    layers: layers.map((l) => {
      const mods = {};
      for (const [key, m] of Object.entries(l.mods ?? {})) {
        mods[key] = { min: m.min, max: m.max, invert: !!m.invert, maskRef: m.mask ? idToRef.get(m.mask) : null };
      }
      return {
        type: l.type,
        ref: idToRef.get(l.id),
        enabled: l.enabled,
        params: structuredClone(l.params),
        blend: l.blend,
        opacity: l.opacity,
        maskRef: l.mask ? idToRef.get(l.mask) : null,
        maskInvert: l.maskInvert,
        maskFeather: l.maskFeather,
        mods: Object.keys(mods).length ? mods : undefined,
        locks: Object.keys(l.locks ?? {}).length ? { ...l.locks } : undefined,
      };
    }),
  };
}

export function loadUserPresets() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveUserPreset(key, preset) {
  const all = loadUserPresets();
  all[key] = preset;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch (err) {
    // Paint strokes in particular can blow past the ~5MB quota.
    const name = err?.name || "";
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
      throw new Error(
        "Not enough browser storage for this preset (paint strokes are large). Export as JSON instead, or clear some saved presets."
      );
    }
    throw err;
  }
  return all;
}

export function deleteUserPreset(key) {
  const all = loadUserPresets();
  delete all[key];
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
  return all;
}
