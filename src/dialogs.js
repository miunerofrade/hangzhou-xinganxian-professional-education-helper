import { isMediaErrorDialog } from "./media-errors.js";
import { visible } from "./utils.js";
// Element Plus commonly wraps one MessageBox in a separate role=dialog node.
// Count logical dialogs, not both the wrapper and its child.
function innermost(nodes) {
  return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains?.(other)));
}
export function collectDialogs(root = document) {
  const boxes = innermost([...root.querySelectorAll(".el-message-box")].filter(visible));
  const semantics = [...root.querySelectorAll('[role="dialog"],dialog[open]')].filter(
    (node) => visible(node) && !isMediaErrorDialog(node),
  );
  const unknown = innermost(
    semantics.filter(
      (node) => !boxes.some((box) => node === box || node.contains?.(box) || box.contains?.(node)),
    ),
  );
  return { boxes, unknown, count: boxes.length + unknown.length };
}

export function dialogStackLevel(box) {
  let level = 0,
    node = box;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) level = Math.max(level, z);
  }
  return level;
}
