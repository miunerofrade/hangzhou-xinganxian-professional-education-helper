// One opt-in surface contract for static sections and dynamically rendered cards.
export function decorateSurfaceCard(
  element,
  { tone = "surface", compact = false, importance = tone === "accent" ? "high" : "normal" } = {},
) {
  element.classList.add("surface-card");
  element.dataset.cardTone = tone;
  element.dataset.cardImportance = importance;
  if (compact) element.dataset.cardSize = "compact";
  else delete element.dataset.cardSize;
  return element;
}
export function bindSurfaceCards({ host, root, lifecycle }) {
  const body = root.querySelector(".body");
  for (const element of body.children) decorateSurfaceCard(element);
  let pressed = null,
    pointerId = null,
    x = 0,
    y = 0,
    timer = null;
  const clear = () => {
    clearTimeout(timer);
    pressed?.classList.remove("is-surface-pressed");
    pressed = null;
    pointerId = null;
  };
  const down = (event) => {
    if (host.getAttribute("data-neumorphic") !== "true" || !event.isPrimary || event.button !== 0)
      return;
    if (
      event.target.closest(
        'button,input,select,textarea,a,label,summary,[role="button"],#event-log,.help',
      )
    )
      return;
    const card = event.target.closest(".surface-card");
    // Only the explicitly decorated course card responds inside a scrolling list.
    const list = event.target.closest(".course-list");
    if (!card || !body.contains(card) || (list && !list.contains(card))) return;
    clear();
    pressed = card;
    pointerId = event.pointerId;
    x = event.clientX;
    y = event.clientY;
    card.classList.add("is-surface-pressed");
  };
  const move = (event) => {
    if (
      pressed &&
      event.pointerId === pointerId &&
      Math.hypot(event.clientX - x, event.clientY - y) > 8
    )
      clear();
  };
  const up = (event) => {
    if (!pressed || event.pointerId !== pointerId) return;
    clearTimeout(timer);
    timer = setTimeout(clear, 40);
  };
  lifecycle.on(body, "pointerdown", down);
  lifecycle.on(body, "scroll", clear, true);
  lifecycle.on(window, "pointermove", move);
  lifecycle.on(window, "pointerup", up);
  lifecycle.on(window, "pointercancel", clear);
  lifecycle.on(window, "blur", clear);
  lifecycle.defer(clear);
}
