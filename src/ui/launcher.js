import { createMenuMotion } from "./motion.js";

// Dragging, edge snapping and menu motion share one launcher lifecycle.
export function bindLauncher({ host, panel, launcher, reducedMotion, lifecycle, onToggle }) {
  const menuMotion = createMenuMotion({ panel, launcher, reducedMotion });
  const positionKey = "hz-helper-launcher-position-v1";
  const margin = 12,
    ball = 48;
  let drag = null,
    suppressClick = false;
  function placeLauncher(side, fraction) {
    const width = window.innerWidth,
      height = window.innerHeight;
    if (!(width > 0 && height > 0)) return;
    const maxY = Math.max(margin, height - ball - margin),
      y = margin + Math.max(0, Math.min(1, fraction)) * (maxY - margin);
    host.style.left = `${side === "left" ? margin : Math.max(margin, width - ball - margin)}px`;
    host.style.top = `${y}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
    panel.style.left = side === "left" ? "12px" : "auto";
    panel.style.right = side === "left" ? "auto" : "12px";
  }

  function savePosition(side, y) {
    const maxY = Math.max(margin, window.innerHeight - ball - margin),
      fraction = maxY === margin ? 0 : Math.max(0, Math.min(1, (y - margin) / (maxY - margin)));
    localStorage.setItem(positionKey, JSON.stringify({ side, fraction }));
    placeLauncher(side, fraction);
  }
  function restorePosition() {
    try {
      const p = JSON.parse(localStorage.getItem(positionKey) || "null");
      if (p && ["left", "right"].includes(p.side) && Number.isFinite(p.fraction))
        placeLauncher(p.side, p.fraction);
    } catch {}
  }
  launcher.onpointerdown = (event) => {
    if (event.button !== 0 || !host.getBoundingClientRect) return;
    const rect = host.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    launcher.setPointerCapture?.(event.pointerId);
  };
  launcher.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    const x = Math.max(margin, Math.min(window.innerWidth - ball - margin, drag.left + dx));
    const y = Math.max(margin, Math.min(window.innerHeight - ball - margin, drag.top + dy));
    host.style.left = `${x}px`;
    host.style.top = `${y}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  };
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) {
      const x = drag.left + event.clientX - drag.x,
        y = drag.top + event.clientY - drag.y;
      savePosition(x + ball / 2 < window.innerWidth / 2 ? "left" : "right", y);
      suppressClick = true;
      lifecycle.timeout(() => {
        suppressClick = false;
      }, 0);
    }
    drag = null;
  }
  launcher.onpointerup = endDrag;
  launcher.onpointercancel = endDrag;
  lifecycle.on(window, "resize", restorePosition);
  restorePosition();
  launcher.onclick = () => {
    if (!suppressClick) onToggle();
  };
  return menuMotion;
}
