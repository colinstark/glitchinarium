/**
 * Portaled popover — a panel anchored to a trigger button.
 *
 * The panel is appended to document.body and position:fixed so no ancestor's
 * overflow can clip it. Keeping it inside the sidebar (even absolutely
 * positioned) gets clipped by the panel's overflow, which is what produced the
 * tiny "Spot colour" pill in the add-layer menu.
 *
 * Callers own the panel's contents and its role/aria-haspopup semantics; this
 * only handles placement, open/close and aria-expanded.
 */

const GAP = 6;
const MAX_H = 22 * 16;
const EDGE = 12;

export function attachPopover({
  trigger,
  menu,
  // Outside-click test uses this subtree, not the trigger — the add-layer
  // wrapper holds a sibling "+ Mask" button that must not close the menu.
  anchor = trigger,
  placement = "bottom",
  align = "left",
  matchWidth = false,
}) {
  menu.hidden = true;
  menu.classList.add("popover");
  document.body.append(menu);

  trigger.setAttribute("aria-expanded", "false");

  const isOpen = () => !menu.hidden;

  function position() {
    const br = trigger.getBoundingClientRect();
    menu.style.top = "auto";
    menu.style.bottom = "auto";
    menu.style.left = "auto";
    menu.style.right = "auto";

    if (placement === "top") {
      menu.style.bottom = `${Math.round(window.innerHeight - br.top + GAP)}px`;
      menu.style.maxHeight = `${Math.round(Math.min(MAX_H, Math.max(120, br.top - EDGE)))}px`;
    } else {
      menu.style.top = `${Math.round(br.bottom + GAP)}px`;
      const room = window.innerHeight - br.bottom - EDGE;
      menu.style.maxHeight = `${Math.round(Math.min(MAX_H, Math.max(120, room)))}px`;
    }

    if (align === "right") {
      menu.style.right = `${Math.round(Math.max(8, window.innerWidth - br.right))}px`;
    } else {
      menu.style.left = `${Math.round(br.left)}px`;
    }

    if (matchWidth) menu.style.width = `${Math.round(br.width)}px`;
  }

  function open() {
    position();
    menu.hidden = false;
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
  }

  function close() {
    menu.hidden = true;
    trigger.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  document.addEventListener("click", (e) => {
    if (!isOpen()) return;
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });
  window.addEventListener("resize", () => {
    if (isOpen()) position();
  });
  // The trigger can sit inside a scrolling panel — follow it instead of drifting.
  document.addEventListener(
    "scroll",
    () => {
      if (isOpen()) position();
    },
    true,
  );

  return { open, close, toggle, isOpen };
}
