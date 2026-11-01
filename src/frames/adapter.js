import { visible, text } from "../utils.js";
// Native controls observed in the two SCORM skins supplied by the user.
export function inspectSkin(root) {
  const one = (selector) => [...root.querySelectorAll(selector)].find(visible);
  const start = one("#playVideo");
  const play = one("#toPlay");
  const toggle = one("#toPause");
  const media = [...root.querySelectorAll("video,audio")];
  return {
    supported: !!(
      start ||
      play ||
      toggle ||
      (root.querySelector?.("#firstPanel,#leftPanel,#mediaControlDiv") && media.length)
    ),
    start,
    play,
    toggle,
    mediaElements: media,
    media:
      media.length === 1
        ? media[0]
        : media.filter((item) => item.tagName === "VIDEO").length === 1
          ? media.find((item) => item.tagName === "VIDEO")
          : null,
  };
}
export function accessibleDocuments(root, depth = 0, seen = new Set()) {
  if (!root || seen.has(root) || depth > 4) return [];
  seen.add(root);
  const result = [root];
  for (const frame of root.querySelectorAll("iframe")) {
    try {
      if (frame.contentDocument)
        result.push(...accessibleDocuments(frame.contentDocument, depth + 1, seen));
    } catch {
      /* Use the cross-origin worker instead. */
    }
  }
  return result;
}
export function createSkinAdapter(root) {
  let started = false,
    lastClick = 0,
    lastAttempt = 0,
    lastError = "",
    pending = false;
  const mutedByHelper = new WeakMap();
  function inspect({ enabled = true, muted = false, gesture = false } = {}) {
    const documents = accessibleDocuments(root);
    const candidates = documents.map(inspectSkin);
    const skin =
      candidates.find((item) => item.supported && item.media) ||
      candidates.find((item) => item.supported);
    if (!skin) {
      let inaccessible = false;
      let loading = false;
      for (const doc of documents) {
        if (doc.readyState && doc.readyState !== "complete") loading = true;
        for (const frame of doc.querySelectorAll("iframe")) {
          try {
            const child = frame.contentDocument;
            if (!child || !documents.includes(child)) inaccessible = true;
          } catch {
            inaccessible = true;
          }
        }
      }
      return {
        supported: false,
        state: loading ? "waiting" : inaccessible ? "inaccessible" : "unknown",
      };
    }
    const media = skin.media;
    if (media && media.playbackRate !== 1)
      return { supported: true, state: "unsupported", error: "rate" };
    for (const item of skin.mediaElements) {
      if (muted) {
        if (!mutedByHelper.has(item)) mutedByHelper.set(item, item.muted);
        item.muted = true;
      } else if (mutedByHelper.has(item)) {
        item.muted = mutedByHelper.get(item);
        mutedByHelper.delete(item);
      }
    }
    if (!enabled) {
      if (skin.mediaElements.some((item) => !item.paused)) {
        if (skin.toggle) skin.toggle.click();
        for (const item of skin.mediaElements) item.pause();
      }
      return report("paused");
    }
    if (media?.ended) return report("ended");
    if (media && !media.paused) {
      lastError = "";
      return report("playing");
    }
    const now = Date.now();
    try {
      if (!started && skin.start) {
        started = true;
        lastClick = now;
        skin.start.click();
      } else if (
        (media?.paused || (!started && skin.play)) &&
        (gesture || now - lastClick >= 5000)
      ) {
        const control = skin.play || skin.toggle;
        if (control) {
          started = true;
          lastClick = now;
          control.click();
        }
      }
      // The skin may call play before restoring mute state. A normal play call
      // after the native button handles muted autoplay without touching LMS state.
      if (media?.paused && !pending && (gesture || now - lastAttempt >= 5000)) {
        lastAttempt = now;
        pending = true;
        Promise.resolve(media.play())
          .then(
            () => {
              lastError = "";
            },
            (error) => {
              lastError = String(error?.name || "Error");
            },
          )
          .finally(() => {
            pending = false;
          });
      }
    } catch (error) {
      lastError = String(error?.name || "Error");
    }
    return report(
      lastError === "NotAllowedError"
        ? "blocked"
        : lastError
          ? "error"
          : media && !media.paused
            ? "playing"
            : "starting",
    );
    function report(state) {
      return {
        supported: true,
        state,
        error: lastError || null,
        paused: media ? !!media.paused : null,
        position:
          media && Number.isFinite(media.currentTime) ? Math.round(media.currentTime) : null,
        ended: media ? !!media.ended : false,
        selector: skin.start ? "#playVideo" : skin.play ? "#toPlay" : "#toPause",
        label: skin.start ? text(skin.start).slice(0, 32) : null,
      };
    }
  }
  return { inspect };
}
