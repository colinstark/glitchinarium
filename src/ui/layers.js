/**
 * The layer stack UI.
 *
 * Order is the whole interface: a gradient map above an ASCII layer recolours
 * the glyphs, below it recolours what the glyphs sample.
 *
 * Masks publish a field as they run. A processor can only bind to masks that
 * appear ABOVE it in this list (lower index — they have already been
 * computed). "Add mask above" inserts a Mask layer immediately before the
 * effect so the binding works without the user reordering by hand.
 */

import { PROCESSORS, processorsByCategory } from "../processors/index.js";
import { createLayer, availableMasks, touchLayerKey } from "../pipeline.js";
import { BLEND_MODES } from "../buffer.js";
import { buildControls } from "./controls.js";
import { randomizeLayer } from "./randomize.js";
import { beginPaint, endPaint, brushState } from "./brush.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** Human label for a mask layer in binding dropdowns. */
function maskOptionLabel(layer) {
  const src = layer.params?.source;
  return src ? `${layer.id} · ${src}` : `${layer.id} · ${layer.label}`;
}

export function createLayerStack({
  root,
  addButton,
  getLayers,
  setLayers,
  onChange,
  getPreviewScale,
  getIntensity = () => 1,
  getPreviewMaskId = () => null,
  setPreviewMaskId = () => {},
}) {
  let dragIndex = null;

  /**
   * Insert a Mask layer just before `index` and (optionally) wire the layer
   * that ends up below it to use that mask as a stencil.
   */
  function insertMaskAbove(index, { bind = true } = {}) {
    const mask = createLayer("mask");
    // Readable starter so the pink overlay shows something immediately.
    Object.assign(mask.params, {
      source: "luma",
      threshold: 0.45,
      softness: 0.25,
      feather: 6,
    });

    const next = [...getLayers()];
    const at = Math.max(0, Math.min(index, next.length));
    next.splice(at, 0, mask);

    const target = next[at + 1];
    if (target && PROCESSORS[target.type]?.kind !== "mask") {
      if (bind) target.mask = mask.id;
      // Auto-wire any ∿ mod bindings that were waiting for a mask to exist.
      for (const mod of Object.values(target.mods ?? {})) {
        if (mod && (mod._pending || !mod.mask)) {
          mod.mask = mask.id;
          delete mod._pending;
        }
      }
    }

    setLayers(next);
    setPreviewMaskId(mask.id);
    render();
    onChange();
    return mask;
  }

  /**
   * Warn when a periodic processor's feature is finer than the preview can
   * resolve. Below roughly two pixels the preview is showing aliasing rather
   * than the pattern, and the export — which renders it properly — will not
   * match what you dialled in. The geometry is correct either way; the preview
   * simply cannot draw it.
   */
  function resolutionWarning(proc, layer) {
    if (!proc.feature?.length || !getPreviewScale) return null;
    const scale = getPreviewScale();
    if (!scale) return null;
    for (const key of proc.feature) {
      const px = (layer.params[key] ?? 0) * scale;
      if (px > 0 && px < 2) {
        return `${key} ${px.toFixed(1)}px in preview — export will be sharper`;
      }
    }
    return null;
  }

  function render() {
    const layers = getLayers();
    root.replaceChildren();

    if (!layers.length) {
      const empty = el("div", "empty");
      empty.append(el("p", "empty-title", "Stack is empty"));
      empty.append(
        el("p", "empty-hint", "Add a layer, load a preset, or hit New")
      );
      root.append(empty);
      return;
    }

    layers.forEach((layer, index) => {
      const proc = PROCESSORS[layer.type];
      if (!proc) return;

      const card = el("div", `layer${layer.enabled ? "" : " layer-off"}${proc.kind === "mask" ? " layer-mask" : ""}`);

      // Reorder is grip-only. Making the whole card draggable fights range
      // sliders, pads, and other pointer controls inside the body.
      card.addEventListener("dragover", (e) => {
        if (dragIndex == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        card.classList.add("drop-target");
      });
      card.addEventListener("dragleave", (e) => {
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        card.classList.remove("drop-target");
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove("drop-target");
        if (dragIndex == null || dragIndex === index) return;
        const next = [...layers];
        // After removing the source, indices above it shift left — adjust the
        // drop slot so dragging downward lands on the card you aimed at.
        let to = index;
        if (dragIndex < to) to--;
        const [moved] = next.splice(dragIndex, 1);
        next.splice(to, 0, moved);
        dragIndex = null;
        setLayers(next);
        render();
        onChange();
      });

      // --- header ---
      const head = el("div", "layer-head");

      const grip = el("span", "layer-grip", "⠿");
      grip.title = "Drag to reorder";
      grip.setAttribute("aria-label", "Drag to reorder");
      grip.setAttribute("role", "button");
      grip.draggable = true;
      grip.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        dragIndex = index;
        card.classList.add("dragging");
        // Firefox requires setData or the drag is aborted.
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        // Ghost the whole card so reorder still feels like moving a layer.
        try {
          e.dataTransfer.setDragImage(card, 16, 16);
        } catch {
          /* some browsers reject setDragImage mid-layout */
        }
      });
      grip.addEventListener("dragend", () => {
        dragIndex = null;
        card.classList.remove("dragging");
        root.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
      });

      const power = el("button", "layer-power");
      power.type = "button";
      power.textContent = layer.enabled ? "●" : "○";
      power.title = layer.enabled ? "Disable layer" : "Enable layer";
      power.setAttribute("aria-label", layer.enabled ? "Disable layer" : "Enable layer");
      power.setAttribute("aria-pressed", layer.enabled ? "true" : "false");
      power.addEventListener("click", () => {
        layer.enabled = !layer.enabled;
        touchLayerKey(layer);
        render();
        onChange();
      });

      const title = el("button", "layer-title");
      title.type = "button";
      title.setAttribute("aria-expanded", layer.collapsed ? "false" : "true");
      title.title = layer.collapsed ? "Expand layer" : "Collapse layer";
      title.append(el("span", "layer-chevron"));
      title.append(el("span", "layer-name", layer.label));
      if (proc.kind === "mask") title.append(el("span", "layer-badge", layer.id));
      title.addEventListener("click", () => {
        layer.collapsed = !layer.collapsed;
        render();
      });

      const shuffle = el("button", "layer-shuffle", "⟳");
      shuffle.type = "button";
      shuffle.title = "Randomize this layer (uses Intensity; respects 🔒 locks)";
      shuffle.setAttribute("aria-label", "Randomize layer");
      shuffle.addEventListener("click", (e) => {
        e.stopPropagation();
        randomizeLayer(layer, getIntensity());
        touchLayerKey(layer);
        render();
        onChange();
      });

      const del = el("button", "layer-del", "×");
      del.type = "button";
      del.title = "Delete layer";
      del.setAttribute("aria-label", "Delete layer");
      del.addEventListener("click", () => {
        const next = layers.filter((l) => l !== layer);
        // Any layer pointing at this mask loses its binding.
        for (const l of next) {
          if (l.mask === layer.id) l.mask = null;
          for (const mod of Object.values(l.mods ?? {})) {
            if (mod?.mask === layer.id) mod.mask = null;
          }
        }
        if (getPreviewMaskId() === layer.id) setPreviewMaskId(null);
        if (brushState.layer?.id === layer.id) endPaint();
        setLayers(next);
        render();
        onChange();
      });

      head.append(grip, power, title, shuffle, del);
      card.append(head);

      if (!layer.collapsed) {
        const body = el("div", "layer-body");
        const masks = availableMasks(layers, index);

        if (proc.kind === "mask") {
          // --- mask tools (no tutorial chrome; badge on title is the id) ---
          const actions = el("div", "ctl-row mask-actions");
          const viewing = getPreviewMaskId() === layer.id;
          const viewBtn = el("button", `btn btn-sm${viewing ? " btn-primary" : ""}`, "View");
          viewBtn.type = "button";
          viewBtn.title = viewing
            ? "Hide mask overlay (pink = selected)"
            : "Overlay this mask on the canvas (pink = selected)";
          viewBtn.setAttribute("aria-pressed", viewing ? "true" : "false");
          viewBtn.addEventListener("click", () => {
            setPreviewMaskId(viewing ? null : layer.id);
            render();
            document.dispatchEvent(new CustomEvent("glitchinarium:mask-preview"));
          });

          const painting = brushState.layer?.id === layer.id;
          const paintBtn = el("button", `btn btn-sm${painting ? " btn-primary" : ""}`, painting ? "Done" : "Paint");
          paintBtn.type = "button";
          paintBtn.title = painting ? "Stop painting this mask" : "Paint this mask on the canvas";
          paintBtn.setAttribute("aria-pressed", painting ? "true" : "false");
          paintBtn.addEventListener("click", () => {
            if (brushState.layer?.id === layer.id) {
              endPaint();
            } else {
              // Switching source to paint replaces the procedural field — confirm
              // so a tuned luma/edge mask is not wiped by one misclick.
              if (layer.params.source !== "paint") {
                const prev = layer.params.source || "luma";
                const ok = window.confirm(
                  `Switch this mask from “${prev}” to paint?\n\nThe procedural field will be replaced. Existing brush strokes (if any) are kept.`
                );
                if (!ok) return;
                layer.params.source = "paint";
              }
              layer.params.strokes = layer.params.strokes ?? [];
              beginPaint(layer, layer.params.strokes, () => onChange());
              setPreviewMaskId(layer.id);
            }
            render();
            onChange();
            document.dispatchEvent(new CustomEvent("glitchinarium:mask-preview"));
          });
          actions.append(viewBtn, paintBtn);
          body.append(actions);
        } else {
          // --- compositing + stencil binding -----------------------------
          const comp = el("div", "layer-comp");

          const blend = el("select", "ctl-select");
          for (const m of BLEND_MODES) {
            const o = el("option", null, m);
            o.value = m;
            blend.append(o);
          }
          blend.value = layer.blend;
          blend.addEventListener("change", () => {
            layer.blend = blend.value;
            touchLayerKey(layer);
            onChange();
          });
          comp.append(labelled("Blend", blend));

          const op = el("input", "ctl-range");
          op.type = "range";
          op.min = 0;
          op.max = 1;
          op.step = 0.01;
          op.value = layer.opacity;
          const opOut = el("span", "param-value", layer.opacity.toFixed(2));
          op.addEventListener("input", () => {
            layer.opacity = Number(op.value);
            opOut.textContent = layer.opacity.toFixed(2);
            touchLayerKey(layer);
            onChange();
          });
          comp.append(labelled("Opacity", op, opOut));

          // Compact mask row: select (or empty placeholder) + insert-above.
          const maskField = el("div", "param param-mask");
          const maskLab = el("label", "param-label");
          maskLab.append(el("span", "param-name", "Mask"));
          const addMask = el("button", "btn btn-ghost btn-sm btn-mask-add", "+");
          addMask.type = "button";
          addMask.title =
            masks.length === 0
              ? "Insert a mask above this effect and bind it"
              : "Insert another mask above this layer";
          addMask.addEventListener("click", () =>
            insertMaskAbove(index, { bind: masks.length === 0 })
          );
          maskLab.append(addMask);
          maskField.append(maskLab);

          if (masks.length === 0) {
            const placeholder = el("div", "mask-none", "none above");
            placeholder.title = "Masks sit above the effects that use them";
            maskField.append(placeholder);
          } else {
            const msel = el("select", "ctl-select");
            const none = el("option", null, "none");
            none.value = "";
            msel.append(none);
            for (const m of masks) {
              const o = el("option", null, maskOptionLabel(m));
              o.value = m.id;
              msel.append(o);
            }
            msel.value = layer.mask ?? "";
            const maskMissing =
              layer.mask && !masks.some((m) => m.id === layer.mask);
            if (maskMissing) {
              const o = el("option", null, `${layer.mask} · n/a`);
              o.value = layer.mask;
              msel.append(o);
              msel.value = layer.mask;
              msel.classList.add("stale");
            }
            msel.addEventListener("change", () => {
              layer.mask = msel.value || null;
              touchLayerKey(layer);
              render();
              onChange();
            });
            maskField.append(msel);
            if (maskMissing) {
              maskField.append(
                el("span", "param-hint", `${layer.mask} unavailable — applies to whole image`)
              );
            }
          }
          comp.append(maskField);

          if (layer.mask) {
            const invWrap = el("label", "ctl-toggle");
            const inv = el("input");
            inv.type = "checkbox";
            inv.checked = layer.maskInvert;
            inv.addEventListener("change", () => {
              layer.maskInvert = inv.checked;
              touchLayerKey(layer);
              onChange();
            });
            invWrap.append(inv, el("span", "ctl-toggle-track"));
            comp.append(labelled("Invert", invWrap));

            const feather = el("input", "ctl-range");
            feather.type = "range";
            feather.min = 0;
            feather.max = 80;
            feather.step = 0.5;
            feather.value = layer.maskFeather;
            const fOut = el("span", "param-value", `${layer.maskFeather}u`);
            feather.addEventListener("input", () => {
              layer.maskFeather = Number(feather.value);
              fOut.textContent = `${layer.maskFeather}u`;
              touchLayerKey(layer);
              onChange();
            });
            comp.append(labelled("Feather", feather, fOut));
          }

          body.append(comp);
        }

        // Mods can only reference masks defined above this layer, same rule as
        // the stencil binding.
        const onParams = () => {
          touchLayerKey(layer);
          onChange();
        };
        const { root: paramsRoot } = buildControls(proc.params, layer.params, onParams, {
          mods: (layer.mods ??= {}),
          masks,
          locks: (layer.locks ??= {}),
          layer,
          onInsertMask: () => insertMaskAbove(index, { bind: false }),
          maskLabel: maskOptionLabel,
        });
        body.append(paramsRoot);

        const warn = resolutionWarning(proc, layer);
        if (warn) body.append(el("div", "layer-warn", warn));

        card.append(body);
      }

      root.append(card);
    });
  }

  function labelled(text, input, readout) {
    const row = el("div", "param");
    const lab = el("label", "param-label");
    lab.append(el("span", "param-name", text));
    if (readout) lab.append(readout);
    row.append(lab, input);
    return row;
  }

  // --- add-layer menu ---
  // The menu is portaled to document.body and position:fixed. Keeping it
  // inside the layers block (even with position:absolute) still gets clipped
  // by the panel's overflow, which is what produced the tiny "Spot colour"
  // pill the user saw.
  const wrap = el("div", "add-wrap");
  addButton.replaceWith(wrap);
  wrap.append(addButton);

  const menu = el("div", "add-menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  // Mask first — the rest of the workflow depends on knowing it exists.
  const cats = processorsByCategory().slice().sort((a, b) => {
    if (a.id === "mask") return -1;
    if (b.id === "mask") return 1;
    return 0;
  });
  for (const cat of cats) {
    menu.append(el("div", "add-cat", cat.label));
    for (const proc of cat.items) {
      const b = el("button", "add-item", proc.name);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const layer = createLayer(proc.id);
        setLayers([...getLayers(), layer]);
        if (proc.kind === "mask") setPreviewMaskId(layer.id);
        closeMenu();
        render();
        onChange();
      });
      menu.append(b);
    }
  }
  document.body.append(menu);

  // Quick-add mask at the end of the stack (user then adds effects below, or
  // uses "+ Mask above" on an existing effect).
  const addMaskBtn = el("button", "btn btn-ghost btn-add-mask", "+ Mask");
  addMaskBtn.type = "button";
  addMaskBtn.title = "Add a mask at the bottom of the stack";
  addMaskBtn.addEventListener("click", () => {
    insertMaskAbove(getLayers().length, { bind: false });
  });
  wrap.append(addMaskBtn);

  function positionMenu() {
    const br = addButton.getBoundingClientRect();
    const gap = 6;
    const maxH = Math.min(22 * 16, Math.max(120, br.top - 12));
    menu.style.left = `${Math.round(br.left)}px`;
    menu.style.width = `${Math.round(br.width)}px`;
    menu.style.bottom = `${Math.round(window.innerHeight - br.top + gap)}px`;
    menu.style.top = "auto";
    menu.style.right = "auto";
    menu.style.maxHeight = `${Math.round(maxH)}px`;
  }

  function openMenu() {
    positionMenu();
    menu.hidden = false;
    addButton.classList.add("is-open");
    addButton.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    menu.hidden = true;
    addButton.classList.remove("is-open");
    addButton.setAttribute("aria-expanded", "false");
  }

  addButton.setAttribute("aria-haspopup", "menu");
  addButton.setAttribute("aria-expanded", "false");

  addButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || wrap.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) closeMenu();
  });
  window.addEventListener("resize", () => {
    if (!menu.hidden) positionMenu();
  });

  return { render };
}
