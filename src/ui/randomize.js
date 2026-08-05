/**
 * Controlled randomisation.
 *
 * The point is not "surprise me" — an all-random stack is noise. The point is
 * to shake one axis while holding the rest, so you get combinations you would
 * not have reached by hand but can still recognise as your own piece. Scope
 * checkboxes pick which categories move; per-parameter locks pin anything
 * you have already dialled in; intensity dials how far each shuffle walks
 * from the current values (a gentle nudge vs a full redraw).
 *
 * Locks live on the layer as `layer.locks = { paramKey: true }`, so they
 * survive preset save/load along with everything else.
 */

import { PROCESSORS, CATEGORIES } from "../processors/index.js";
import { createLayer } from "../pipeline.js";

/** Params that would break the piece or the tool if shuffled blindly. */
const NEVER = new Set([
  "strokes",     // hand-painted brush data
  "customChars",
  "chars",
  "font",
  "weight",
  "crisp",
  "edge",
  "emitMask",
  "subdivide",   // meaningless unless bound to a mask
  "count",       // palette colour count — churns the whole image
]);

const isRandomisable = (def) =>
  !NEVER.has(def.key) &&
  (def.type === "range" || def.type === "select" || def.type === "toggle" || def.type === "xy");

const clamp01 = (t) => Math.max(0, Math.min(1, t));

/**
 * Snap a range value to the param's step, staying inside [min, max].
 */
function snapRange(def, v) {
  const step = def.step ?? 1;
  const snapped = Math.round(v / step) * step;
  const lo = Math.min(def.min, def.max);
  const hi = Math.max(def.min, def.max);
  return Number(Math.max(lo, Math.min(hi, snapped)).toFixed(4));
}

/**
 * Pick a fully random target for `def` (ignoring intensity).
 */
function fullRandom(def, rnd) {
  switch (def.type) {
    case "range":
      return snapRange(def, def.min + rnd() * (def.max - def.min));
    case "select":
      return def.options[Math.floor(rnd() * def.options.length)];
    case "toggle":
      return rnd() > 0.5;
    case "xy":
      // Stay off the extreme edges; a warp centred in the corner mostly
      // pushes the subject out of frame.
      return { x: 0.2 + rnd() * 0.6, y: 0.2 + rnd() * 0.6 };
    default:
      return undefined;
  }
}

/**
 * Blend toward a random target by `intensity` (0 = leave alone, 1 = full redraw).
 *
 * Ranges lerp; selects / toggles flip with probability ≈ intensity; xy lerps.
 */
function randomValue(def, current, intensity, rnd) {
  const t = clamp01(intensity);
  if (t <= 0) return current;

  const target = fullRandom(def, rnd);
  if (target === undefined) return current;

  switch (def.type) {
    case "range": {
      const from = Number.isFinite(current) ? current : (def.min + def.max) / 2;
      return snapRange(def, from + (target - from) * t);
    }
    case "select": {
      // Chance of changing grows with intensity. At full strength always
      // re-roll (may land on the same option, which is fine).
      if (t >= 1 || rnd() < t) return target;
      return current;
    }
    case "toggle": {
      if (t >= 1) return target;
      if (rnd() < t) return !current;
      return current;
    }
    case "xy": {
      const from = current && typeof current === "object"
        ? current
        : { x: 0.5, y: 0.5 };
      return {
        x: Number((from.x + (target.x - from.x) * t).toFixed(4)),
        y: Number((from.y + (target.y - from.y) * t).toFixed(4)),
      };
    }
    default:
      return current;
  }
}

/**
 * Randomise one layer's unlocked params in place.
 * Ignores the global category scopes — the user pointed at this card.
 * Still honours per-param locks (🔓/🔒) and the NEVER list.
 *
 * @param {number} [intensity=1] 0..1 how far to walk from current values
 */
export function randomizeLayer(layer, intensity = 1, rnd = Math.random) {
  const proc = PROCESSORS[layer.type];
  if (!proc) return layer;
  const locks = layer.locks ?? {};
  const t = clamp01(intensity);
  if (t <= 0) return layer;

  for (const def of proc.params) {
    if (locks[def.key] || !isRandomisable(def)) continue;
    layer.params[def.key] = randomValue(def, layer.params[def.key], t, rnd);
  }
  return layer;
}

/**
 * Randomise the parameters of existing layers, in place.
 * `scopes` is a Set of category ids.
 */
export function randomizeParams(layers, scopes, intensity = 1, rnd = Math.random) {
  for (const layer of layers) {
    const proc = PROCESSORS[layer.type];
    if (!proc || !scopes.has(proc.category)) continue;
    randomizeLayer(layer, intensity, rnd);
  }
  return layers;
}

/**
 * Build a whole stack from scratch.
 *
 * Structured rather than uniform: a tone base, one or two shaping layers, a
 * glyph or halftone treatment, some glitch, and a texture on top. That ordering
 * is what the reference work does, and a stack assembled in a random order
 * almost never reads as anything.
 *
 * Intensity still applies: params are created at defaults, then walked toward
 * a random draw by `intensity` (so a soft new-stack stays near the processor
 * defaults rather than jumping to extremes).
 */
export function randomizeStack(scopes, intensity = 1, rnd = Math.random) {
  const pick = (cat) => {
    const items = Object.values(PROCESSORS).filter((p) => p.category === cat && p.kind !== "mask");
    return items.length ? items[Math.floor(rnd() * items.length)] : null;
  };

  const recipe = [];
  if (scopes.has("tone")) recipe.push("tone");
  if (scopes.has("warp") && rnd() > 0.35) recipe.push("warp");
  if (scopes.has("halftone") && rnd() > 0.4) recipe.push("halftone");
  if (scopes.has("glyph") && rnd() > 0.35) recipe.push("glyph");
  if (scopes.has("glitch")) recipe.push("glitch");
  if (scopes.has("glitch") && rnd() > 0.6) recipe.push("glitch");
  if (scopes.has("tone") && rnd() > 0.5) recipe.push("tone");
  if (scopes.has("frame") && rnd() > 0.75) recipe.push("frame");
  if (scopes.has("texture")) recipe.push("texture");

  const layers = [];
  for (const cat of recipe) {
    const proc = pick(cat);
    if (!proc) continue;
    layers.push(createLayer(proc.id));
  }

  randomizeParams(layers, scopes, intensity, rnd);

  // Glyph and halftone layers that cover the whole frame bury everything under
  // them, so give them a reason to sit lightly — still intensity-scaled so a
  // soft roll doesn't wreck a careful opacity.
  const t = clamp01(intensity);
  for (const layer of layers) {
    const proc = PROCESSORS[layer.type];
    if (proc.category === "glyph" || proc.category === "halftone") {
      if ("bgAlpha" in layer.params && rnd() > 0.4) {
        const target = Number(rnd().toFixed(2));
        layer.params.bgAlpha = Number((layer.params.bgAlpha + (target - layer.params.bgAlpha) * t).toFixed(2));
      }
      const targetOp = 0.55 + rnd() * 0.45;
      layer.opacity = Number((layer.opacity + (targetOp - layer.opacity) * t).toFixed(2));
    }
    if (proc.category === "texture") {
      const targetOp = 0.3 + rnd() * 0.5;
      layer.opacity = Number((layer.opacity + (targetOp - layer.opacity) * t).toFixed(2));
    }
  }

  return layers;
}

export const SCOPES = CATEGORIES.filter((c) => c.id !== "mask");
