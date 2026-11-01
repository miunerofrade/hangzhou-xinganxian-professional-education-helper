import { icon } from "./icons.js";
const escapeAttribute = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
function attributes({ id, label, className = "icon-button", title = label }) {
  return {
    type: "button",
    id,
    class: className || undefined,
    "aria-label": label,
    title,
  };
}
function glyph({ name, size = 16, wrapped = false }) {
  const svg = icon(name, size);
  return wrapped ? `<span class="action-icon">${svg}</span>` : svg;
}
// Static templates and dynamic course rows share labels, glyphs and button semantics.
export function iconButton(options) {
  const attrs = Object.entries(attributes(options))
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(" ");
  return `<button ${attrs}${options.disabled ? " disabled" : ""}>${glyph(options)}</button>`;
}
export function createIconButton(options) {
  const button = document.createElement("button");
  for (const [name, value] of Object.entries(attributes(options))) {
    if (value !== undefined && value !== null) button.setAttribute(name, value);
  }
  button.disabled = !!options.disabled;
  button.innerHTML = glyph(options);
  return button;
}
