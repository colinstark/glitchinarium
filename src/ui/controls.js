/**
 * Schema-driven control widgets.
 *
 * Processors declare their parameters as data; this file turns that data into
 * DOM. Adding a thirteenth processor costs exactly one file and no UI work.
 *
 * `showIf` predicates are re-evaluated after every change via the returned
 * refresh() rather than by rebuilding the panel — rebuilding would drop the
 * pointer capture of whatever slider you are currently dragging.
 */

import { customFonts } from "../processors/ascii.js";
import { HEX_RE } from "../color.js";
import { getRenderClient } from "../render/client.js";
import { brushState, beginPaint, endPaint, clearStrokes, undoStroke, onBrushChange } from "./brush.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const prettify = (s) => s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Mark the app as scrubbing a range control so preview can drop resolution
 * and coalesce to rAF. Dispatched as a document event (controls stay free of
 * main.js imports).
 */
export function emitScrub(active) {
  if (typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent("glitchinarium:scrub", { detail: { active: !!active } })
  );
}

/** Wire pointer-driven scrub start/end on a range (or similar) input. */
export function attachScrubEvents(input) {
  if (!input) return input;
  const start = () => emitScrub(true);
  const end = () => emitScrub(false);
  input.addEventListener("pointerdown", start);
  input.addEventListener("pointerup", end);
  input.addEventListener("pointercancel", end);
  input.addEventListener("lostpointercapture", end);
  // Keyboard / accessibility: treat focus-driven input as light scrub.
  input.addEventListener("keydown", start);
  input.addEventListener("keyup", end);
  input.addEventListener("blur", end);
  return input;
}

/**
 * Build controls for `schema` bound to `params`.
 *
 * Returns { root, refresh, dispose }:
 *  - refresh() re-applies showIf visibility
 *  - dispose() drops subscriptions this panel took out on module-level state.
 *    The caller MUST call it before discarding the DOM — the layer panel is
 *    rebuilt wholesale on every stack change, so a control that subscribes
 *    without unsubscribing accumulates one dead listener per rebuild, forever.
 */
export function buildControls(schema, params, onChange, ctxHint = {}) {
  const root = el("div", "params");
  const rows = [];
  const disposers = [];
  const { mods = null, masks = [], locks = null, onInsertMask = null, maskLabel = null } = ctxHint;
  const labelMask = (m) => (maskLabel ? maskLabel(m) : `${m.id} · ${m.label}`);

  for (const def of schema) {
    const row = el("div", "param");
    row.dataset.key = def.key;

    const label = el("label", "param-label");
    label.append(el("span", "param-name", def.label ?? prettify(def.key)));
    const readout = el("span", "param-value");
    label.append(readout);

    // Lock: pin this value so randomize leaves it alone. Hidden until hover
    // unless it is actually locked, so the panel stays readable.
    if (locks && def.type !== "paint") {
      const lock = el("button", `param-lock${locks[def.key] ? " is-locked" : ""}`, locks[def.key] ? "🔒" : "🔓");
      lock.type = "button";
      lock.title = "Lock against randomize";
      lock.addEventListener("click", (e) => {
        e.preventDefault();
        if (locks[def.key]) delete locks[def.key];
        else locks[def.key] = true;
        lock.textContent = locks[def.key] ? "🔒" : "🔓";
        lock.classList.toggle("is-locked", !!locks[def.key]);
      });
      label.append(lock);
    }

    // Modulation toggle: binds this parameter to a mask so its value varies
    // across the image instead of being one number.
    if (def.mod && mods) {
      const bound = !!mods[def.key]?.mask;
      const tog = el("button", `param-mod${bound ? " is-bound" : ""}`, "∿");
      tog.type = "button";
      tog.title = bound
        ? "Modulated by a mask — click to unbind"
        : "Drive this param with a mask (per-pixel intensity)";
      tog.addEventListener("click", (e) => {
        e.preventDefault();
        if (mods[def.key]) {
          delete mods[def.key];
        } else if (masks.length) {
          mods[def.key] = { mask: masks[0].id, min: def.min, max: def.max, invert: false };
        } else if (onInsertMask) {
          // No mask exists yet — create one above, then bind on next render.
          // Stash the intended mod so the user doesn't lose the intent.
          mods[def.key] = { mask: null, min: def.min, max: def.max, invert: false, _pending: true };
          onInsertMask();
          return;
        } else {
          return;
        }
        rebuildMod();
        onChange();
      });
      label.append(tog);
    }

    row.append(label);

    const commit = (v) => {
      params[def.key] = v;
      updateReadout(def, v, readout);
      onChange();
      refresh();
    };

    row.append(buildInput(def, params, commit, { ...ctxHint, disposers }));
    updateReadout(def, params[def.key], readout);
    if (def.hint) row.append(el("span", "param-hint", def.hint));

    const modSlot = el("div", "param-mod-slot");
    row.append(modSlot);
    const rebuildMod = () => {
      modSlot.replaceChildren();
      const m = mods?.[def.key];
      if (!m) return;
      modSlot.append(buildModBinding(def, m, masks, onChange, ctxHint));
    };
    rebuildMod();

    root.append(row);
    rows.push({ def, row });
  }

  function refresh() {
    for (const { def, row } of rows) {
      row.hidden = typeof def.showIf === "function" && !def.showIf(params);
    }
  }
  refresh();

  const dispose = () => {
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {
        /* a bad disposer must not block the rest of the teardown */
      }
    }
  };

  return { root, refresh, dispose };
}

/**
 * The mask → parameter binding panel.
 *
 * Mask black gives `min`, white gives `max`. This is the displacement-map
 * idea: grey level drives how strong the effect is, not how much of it is
 * visible. Paint a gradient and the ASCII gets coarser across it.
 */
function buildModBinding(def, m, masks, onChange, ctxHint = {}) {
  const wrap = el("div", "mod-binding");
  const labelMask = (mk) =>
    ctxHint.maskLabel ? ctxHint.maskLabel(mk) : `${mk.id} · ${mk.label}`;

  if (!masks.length) {
    const empty = el("div", "ctl-row mask-empty-mod");
    empty.append(el("span", "mask-none", "none above"));
    if (ctxHint.onInsertMask) {
      const btn = el("button", "btn btn-sm", "+ Mask");
      btn.type = "button";
      btn.title = "Insert a mask above this layer";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        ctxHint.onInsertMask();
      });
      empty.append(btn);
    }
    wrap.append(empty);
    return wrap;
  }

  // If we just created a mask via ∿, auto-pick the newest available one.
  if ((!m.mask || m._pending) && masks.length) {
    m.mask = masks[masks.length - 1].id;
    delete m._pending;
  }

  const sel = el("select", "ctl-select");
  for (const mk of masks) {
    const o = el("option", null, labelMask(mk));
    o.value = mk.id;
    sel.append(o);
  }
  sel.value = m.mask ?? masks[0].id;
  m.mask = sel.value;
  sel.addEventListener("change", () => {
    m.mask = sel.value || null;
    onChange();
  });

  const range = el("div", "mod-range");
  const mk = (key, labelText) => {
    const box = el("label", "mod-field");
    box.append(el("span", null, labelText));
    const input = el("input", "ctl-hex");
    input.type = "number";
    input.step = def.step ?? 1;
    if (Number.isFinite(def.min)) input.min = def.min;
    if (Number.isFinite(def.max)) input.max = def.max;
    input.value = m[key];
    input.addEventListener("change", () => {
      const raw = Number(input.value);
      const fallback = key === "min" ? def.min : def.max;
      const finite = Number.isFinite(raw) ? raw : fallback;
      m[key] = Math.max(def.min, Math.min(def.max, finite));
      input.value = m[key];
      onChange();
    });
    box.append(input);
    return box;
  };
  range.append(mk("min", "black →"), mk("max", "white →"));

  const inv = el("div", "mod-field mod-flip");
  inv.append(el("span", null, "flip"));
  const tog = el("label", "ctl-toggle ctl-toggle-sm");
  const invInput = el("input");
  invInput.type = "checkbox";
  invInput.checked = !!m.invert;
  invInput.addEventListener("change", () => {
    m.invert = invInput.checked;
    onChange();
  });
  tog.append(invInput, el("span", "ctl-toggle-track"));
  inv.append(tog);

  wrap.append(sel, range, inv);
  return wrap;
}

function updateReadout(def, value, node) {
  switch (def.type) {
    case "range": {
      const n = Number(value);
      node.textContent = Number.isFinite(n)
        ? `${n.toFixed(stepDecimals(def.step))}${def.unit === "u" ? "u" : ""}`
        : "";
      break;
    }
    case "toggle":
    case "select":
    case "font":
      node.textContent = "";
      break;
    case "xy": {
      const x = value?.x;
      const y = value?.y;
      node.textContent =
        Number.isFinite(x) && Number.isFinite(y) ? `${x.toFixed(2)}, ${y.toFixed(2)}` : "0.50, 0.50";
      break;
    }
    default:
      node.textContent = "";
  }
}

const stepDecimals = (step = 1) => {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1].length : 0;
};

function buildInput(def, params, commit, ctxHint) {
  switch (def.type) {
    case "range": {
      const input = el("input", "ctl-range");
      input.type = "range";
      input.min = def.min;
      input.max = def.max;
      input.step = def.step ?? 1;
      input.value = params[def.key];
      input.addEventListener("input", () => commit(Number(input.value)));
      return attachScrubEvents(input);
    }

    case "toggle": {
      const wrap = el("label", "ctl-toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !!params[def.key];
      input.addEventListener("change", () => commit(input.checked));
      wrap.append(input, el("span", "ctl-toggle-track"));
      return wrap;
    }

    case "select": {
      const sel = el("select", "ctl-select");
      for (const opt of def.options) {
        const o = el("option", null, prettify(String(opt)));
        o.value = opt;
        sel.append(o);
      }
      sel.value = params[def.key];
      sel.addEventListener("change", () => commit(sel.value));
      return sel;
    }

    case "font": {
      const wrap = el("div", "ctl-row");
      const sel = el("select", "ctl-select");
      const fill = () => {
        sel.replaceChildren();
        for (const opt of [...def.options, ...customFonts]) {
          const o = el("option", null, opt);
          o.value = opt;
          sel.append(o);
        }
        sel.value = params[def.key];
      };
      fill();
      sel.addEventListener("change", () => commit(sel.value));

      const btn = el("button", "btn btn-ghost btn-sm", "Load…");
      btn.type = "button";
      btn.title = "Load a .ttf / .otf / .woff2 from disk";
      btn.addEventListener("click", async () => {
        const file = await pickFile(".ttf,.otf,.woff,.woff2");
        if (!file) return;
        const name = file.name.replace(/\.[^.]+$/, "") || "Custom Font";
        try {
          const buffer = await file.arrayBuffer();
          // Separate copies: FontFace may detach its buffer; worker needs its own.
          const face = new FontFace(name, buffer.slice(0));
          await face.load();
          document.fonts.add(face);
          customFonts.add(name);
          getRenderClient().loadFonts([{ family: name, buffer: buffer.slice(0) }]);
          params[def.key] = name;
          fill();
          commit(name);
        } catch (err) {
          console.error(err);
          window.alert(`Could not load font: ${err?.message || err}`);
        }
      });

      wrap.append(sel, btn);
      return wrap;
    }

    case "color": {
      const wrap = el("div", "ctl-row");
      const input = el("input", "ctl-color");
      input.type = "color";
      input.value = params[def.key];
      const hex = el("input", "ctl-hex");
      hex.type = "text";
      hex.value = params[def.key];
      hex.spellcheck = false;

      input.addEventListener("input", () => {
        hex.value = input.value;
        commit(input.value);
      });
      hex.addEventListener("change", () => {
        if (!HEX_RE.test(hex.value.trim())) {
          hex.value = params[def.key];
          return;
        }
        input.value = hex.value.trim();
        commit(hex.value.trim());
      });
      wrap.append(input, hex);
      return wrap;
    }

    case "text": {
      const input = el("input", "ctl-text");
      input.type = "text";
      input.value = params[def.key];
      input.spellcheck = false;
      input.addEventListener("input", () => commit(input.value));
      return input;
    }

    case "xy": {
      // Draggable pad — far easier than two sliders for placing a warp centre.
      if (!params[def.key] || typeof params[def.key] !== "object") {
        params[def.key] = structuredClone(def.default ?? { x: 0.5, y: 0.5 });
      }
      const pad = el("div", "ctl-pad");
      const dot = el("div", "ctl-pad-dot");
      pad.append(dot);
      const place = () => {
        const pt = params[def.key] ?? { x: 0.5, y: 0.5 };
        dot.style.left = `${(Number.isFinite(pt.x) ? pt.x : 0.5) * 100}%`;
        dot.style.top = `${(Number.isFinite(pt.y) ? pt.y : 0.5) * 100}%`;
      };
      place();

      const move = (e) => {
        const r = pad.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        commit({ x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) });
        place();
      };
      pad.addEventListener("pointerdown", (e) => {
        pad.setPointerCapture(e.pointerId);
        move(e);
      });
      pad.addEventListener("pointermove", (e) => {
        if (pad.hasPointerCapture(e.pointerId)) move(e);
      });
      return pad;
    }

    case "gradient": {
      const wrap = el("div", "ctl-gradient");
      const bar = el("div", "ctl-gradient-bar");
      const list = el("div", "ctl-stops");

      const paint = () => {
        const stops = [...params[def.key]].sort((a, b) => a.pos - b.pos);
        bar.style.background = `linear-gradient(90deg, ${stops
          .map((s) => `${s.color} ${(s.pos * 100).toFixed(1)}%`)
          .join(", ")})`;
      };

      const rebuild = () => {
        list.replaceChildren();
        params[def.key].forEach((stop, i) => {
          const row = el("div", "ctl-stop");
          const col = el("input");
          col.type = "color";
          col.value = stop.color;
          col.addEventListener("input", () => {
            stop.color = col.value;
            paint();
            commit(params[def.key]);
          });

          const pos = el("input");
          pos.type = "range";
          pos.min = 0;
          pos.max = 1;
          pos.step = 0.01;
          pos.value = stop.pos;
          pos.addEventListener("input", () => {
            stop.pos = Number(pos.value);
            paint();
            commit(params[def.key]);
          });

          const del = el("button", "btn btn-ghost btn-sm", "×");
          del.type = "button";
          del.disabled = params[def.key].length <= 2;
          del.addEventListener("click", () => {
            params[def.key].splice(i, 1);
            rebuild();
            paint();
            commit(params[def.key]);
          });

          row.append(col, pos, del);
          list.append(row);
        });
      };

      const add = el("button", "btn btn-ghost btn-sm", "+ stop");
      add.type = "button";
      add.addEventListener("click", () => {
        params[def.key].push({ pos: 0.5, color: "#888888" });
        rebuild();
        paint();
        commit(params[def.key]);
      });

      rebuild();
      paint();
      wrap.append(bar, list, add);
      return wrap;
    }

    case "paint": {
      const wrap = el("div", "ctl-paint");
      const strokes = params[def.key];
      const layer = ctxHint.layer;

      const toggle = el("button", "btn btn-sm", "Paint");
      toggle.type = "button";
      const count = el("span", "param-value");

      const sync = () => {
        const on = brushState.layer?.id === layer?.id;
        toggle.textContent = on ? "Painting — done" : "Paint";
        toggle.classList.toggle("btn-primary", on);
        count.textContent = `${strokes.length} stroke${strokes.length === 1 ? "" : "s"}`;
        sliders.hidden = !on;
      };

      toggle.addEventListener("click", () => {
        if (brushState.layer?.id === layer?.id) endPaint();
        else beginPaint(layer, strokes, () => commit(strokes));
        sync();
      });

      const sliders = el("div", "ctl-paint-body");
      const slider = (key, labelText, min, max, step) => {
        const row = el("div", "param");
        const lab = el("label", "param-label");
        lab.append(el("span", "param-name", labelText));
        const out = el("span", "param-value", String(brushState[key]));
        lab.append(out);
        const input = el("input", "ctl-range");
        input.type = "range";
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = brushState[key];
        input.addEventListener("input", () => {
          brushState[key] = Number(input.value);
          out.textContent = input.value;
        });
        row.append(lab, input);
        return row;
      };
      sliders.append(
        slider("radius", "Size (u)", 2, 300, 1),
        slider("hardness", "Hardness", 0, 1, 0.01),
        slider("flow", "Flow", 0.02, 1, 0.01)
      );

      const row = el("div", "ctl-row");
      const eraseBtn = el("button", "btn btn-ghost btn-sm", "Erase");
      eraseBtn.type = "button";
      eraseBtn.addEventListener("click", () => {
        brushState.erase = !brushState.erase;
        eraseBtn.classList.toggle("is-active", brushState.erase);
      });
      eraseBtn.classList.toggle("is-active", brushState.erase);

      const undoBtn = el("button", "btn btn-ghost btn-sm", "Undo");
      undoBtn.type = "button";
      undoBtn.addEventListener("click", () => { undoStroke(); sync(); });

      const clearBtn = el("button", "btn btn-ghost btn-sm", "Clear");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", () => { clearStrokes(); sync(); });

      row.append(eraseBtn, undoBtn, clearBtn);
      sliders.append(row, el("span", "param-hint", "[ ] resize · e erase · ⌘Z undo · esc done"));

      wrap.append(el("div", "ctl-row", null), toggle, count, sliders);
      wrap.firstChild.remove();
      sync();
      // Unsubscribe when the panel is rebuilt — see buildControls' dispose().
      ctxHint.disposers?.push(onBrushChange(sync));
      return wrap;
    }

    default:
      return el("div", "param-unknown", `?${def.type}`);
  }
}

/**
 * Open a file picker and resolve with the chosen File (or null if cancelled).
 * The input is attached to the document — required for reliable behaviour in
 * Safari and some Chromium builds when the picker is opened from a click handler.
 */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.hidden = true;
    document.body.appendChild(input);

    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
      resolve(file);
    };

    input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });

    // Cancel does not fire `change`. When the dialog closes, focus returns to
    // the window — give change a tick to win the race if a file was chosen.
    const onWindowFocus = () => {
      setTimeout(() => finish(null), 400);
    };
    // Defer so we don't catch the focus transition of opening the dialog itself.
    setTimeout(() => window.addEventListener("focus", onWindowFocus, { once: true }), 0);

    input.click();
  });
}
