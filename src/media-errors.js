import { visible } from "./utils.js";
// Video.js ErrorDisplay extends ModalDialog, so its role=dialog is not a
// platform confirmation. Scope this exception to that exact player component.
export function isMediaErrorDialog(node) {
  return !!(
    node.matches?.(".vjs-error-display") && node.closest?.(".video-js")?.querySelector?.("video")
  );
}
export function readMediaFailure(video, root = document) {
  const code = Number(video?.error?.code);
  if ([1, 2, 3, 4].includes(code)) return { code, source: "native" };
  for (const node of root.querySelectorAll(".video-js .vjs-error-display")) {
    if (!visible(node) || !isMediaErrorDialog(node)) continue;
    const message = String(node.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (/playback was aborted due to a corruption/i.test(message))
      return { code: 3, source: "videojs" };
    if (/no compatible source|media could not be loaded|source.*not supported/i.test(message))
      return { code: 4, source: "videojs" };
  }
  return null;
}
