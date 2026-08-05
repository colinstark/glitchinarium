/**
 * The corrosion brush.
 *
 * This is deliberately NOT a paint layer that sits on top of the image. It is a
 * mask source: you paint grey, and any processor above can bind to it — as a
 * stencil (where the effect applies) or, through parameter modulation, as an
 * intensity dial (how hard the effect bites). Painting a soft gradient over a
 * datamosh layer's `amount` scratches digital rust into exactly the places you
 * brushed, at exactly the strength you brushed it.
 *
 * Strokes are stored in NORMALISED image coordinates with radii in artwork
 * units, so a mask painted against a 900px preview lands identically on a
 * 6000px export.
 */

import { touchLayerKey } from "../pipeline.js";

export const brushState = {
  /** The layer currently being painted, or null. */
  layer: null,
  strokes: null,
  onChange: null,
  radius: 40,
  hardness: 0.5,
  flow: 0.7,
  erase: false,
  active: false, // pointer is down
};

const listeners = new Set();
export function onBrushChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((f) => f());

export function isPainting(layerId) {
  return brushState.layer?.id === layerId;
}

export function beginPaint(layer, strokes, onChange) {
  brushState.layer = layer;
  brushState.strokes = strokes;
  brushState.onChange = onChange;
  notify();
}

export function endPaint() {
  const wasActive = brushState.active;
  const onChange = brushState.onChange;
  brushState.layer = null;
  brushState.strokes = null;
  brushState.onChange = null;
  brushState.active = false;
  if (wasActive) onChange?.();
  notify();
}

/** Bump the revision the pipeline cache keys off — see pipeline.layerKey. */
function bumpStrokes(strokes) {
  if (!strokes) return;
  strokes._v = (strokes._v | 0) + 1;
  if (brushState.layer) touchLayerKey(brushState.layer);
}

export function clearStrokes() {
  if (!brushState.strokes) return;
  brushState.strokes.length = 0;
  bumpStrokes(brushState.strokes);
  brushState.onChange?.();
  notify();
}

export function undoStroke() {
  if (!brushState.strokes?.length) return;
  brushState.strokes.pop();
  bumpStrokes(brushState.strokes);
  brushState.onChange?.();
  notify();
}

/**
 * Wire pointer events on the stage.
 *
 * `toImage(clientX, clientY)` must return normalised 0..1 image coordinates, or
 * null when the pointer is outside the letterboxed preview.
 */
export function attachBrush(stage, toImage) {
  let current = null;

  const push = (e) => {
    const pt = toImage(e.clientX, e.clientY);
    if (!pt || !current) return;
    const n = current.pts.length;
    // Skip points that land on top of the last one; they only bloat the preset.
    if (n >= 2 && Math.abs(current.pts[n - 2] - pt.x) < 1e-4 && Math.abs(current.pts[n - 1] - pt.y) < 1e-4) {
      return;
    }
    current.pts.push(pt.x, pt.y);
    bumpStrokes(brushState.strokes);
    brushState.onChange?.();
  };

  stage.addEventListener("pointerdown", (e) => {
    if (!brushState.layer) return;
    const pt = toImage(e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    brushState.active = true;
    current = {
      pts: [pt.x, pt.y],
      r: brushState.radius,
      hardness: brushState.hardness,
      flow: brushState.flow,
      erase: brushState.erase,
    };
    // A dab needs two points to have a segment to stamp along.
    current.pts.push(pt.x, pt.y);
    brushState.strokes.push(current);
    bumpStrokes(brushState.strokes);
    brushState.onChange?.();
  });

  stage.addEventListener("pointermove", (e) => {
    if (!brushState.active) return;
    push(e);
  });

  const finish = (e) => {
    if (!brushState.active) return;
    brushState.active = false;
    current = null;
    if (e?.pointerId != null && stage.hasPointerCapture?.(e.pointerId)) {
      stage.releasePointerCapture(e.pointerId);
    }
    // Painting renders at a smaller interactive resolution; resolve the final
    // stroke at the normal preview size as soon as the gesture finishes.
    brushState.onChange?.();
    notify();
  };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
  stage.addEventListener("lostpointercapture", finish);

  // Controls that swallow characters: typing into one of these must not also
  // drive the brush. Ranges, colour wells and checkboxes are deliberately absent
  // — they ignore "e" and "[", so the shortcuts stay live while you tweak them.
  const TYPING_INPUTS = new Set([
    "text", "search", "url", "tel", "email", "password", "number",
    "date", "month", "week", "time", "datetime-local",
  ]);
  const isTyping = () => {
    const node = document.activeElement;
    if (!node) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true; // select does typeahead
    if (tag === "INPUT") return TYPING_INPUTS.has((node.type || "text").toLowerCase());
    return false;
  };

  window.addEventListener("keydown", (e) => {
    if (!brushState.layer) return;
    // Paint mode stays armed while you click into another layer's controls, so
    // without this, typing "e" in the ASCII charset field silently toggled erase
    // and "[" resized the brush.
    if (isTyping()) return;
    if (e.key === "Escape") endPaint();
    else if (e.key === "[") { brushState.radius = Math.max(2, brushState.radius / 1.25); notify(); }
    else if (e.key === "]") { brushState.radius = Math.min(400, brushState.radius * 1.25); notify(); }
    else if (e.key === "e") { brushState.erase = !brushState.erase; notify(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undoStroke(); }
  });
}
