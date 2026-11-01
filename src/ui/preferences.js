import { log } from "../utils.js";

// Preference persistence and browser wake locks are independent of panel layout.
export function bindPreferences({ $, icon, lifecycle }) {
  const muteKey = "hz-helper-mute-video-v1";
  $("#mute-video").checked = localStorage.getItem(muteKey) === "1";
  function renderMuteIcon() {
    $("#mute-icon").innerHTML = icon($("#mute-video").checked ? "volume-x" : "volume", 16);
  }
  renderMuteIcon();
  let onMuteChanged = () => {};
  $("#mute-video").onchange = () => {
    localStorage.setItem(muteKey, $("#mute-video").checked ? "1" : "0");
    renderMuteIcon();
    onMuteChanged();
  };
  lifecycle.on(window, "storage", (event) => {
    if (event.key === muteKey) {
      $("#mute-video").checked = event.newValue === "1";
      renderMuteIcon();
      onMuteChanged();
    }
  });
  const wakeKey = "hz-helper-keep-awake-v1";
  let wakeSentinel = null,
    wakeRequestId = 0;
  $("#keep-awake").checked = localStorage.getItem(wakeKey) === "1";
  async function updateWakeLock() {
    const id = ++wakeRequestId,
      enabled = $("#keep-awake").checked;
    if (!enabled || document.visibilityState !== "visible") {
      if (wakeSentinel) {
        const old = wakeSentinel;
        wakeSentinel = null;
        await old.release().catch(() => {});
      }
      return;
    }
    if (!navigator.wakeLock?.request) {
      return;
    }
    if (wakeSentinel && !wakeSentinel.released) {
      return;
    }
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (
        id !== wakeRequestId ||
        !$("#keep-awake").checked ||
        document.visibilityState !== "visible"
      ) {
        await lock.release();
        return;
      }
      wakeSentinel = lock;
      lock.addEventListener("release", () => {
        if (wakeSentinel === lock) {
          wakeSentinel = null;
        }
      });
    } catch (error) {
      if (id === wakeRequestId) {
        log("防息屏请求失败", error.message);
      }
    }
  }
  $("#keep-awake").onchange = () => {
    localStorage.setItem(wakeKey, $("#keep-awake").checked ? "1" : "0");
    void updateWakeLock();
  };
  lifecycle.on(window, "storage", (event) => {
    if (event.key === wakeKey) {
      $("#keep-awake").checked = event.newValue === "1";
      void updateWakeLock();
    }
  });
  lifecycle.on(document, "visibilitychange", () => void updateWakeLock());
  lifecycle.on(window, "pagehide", () => {
    wakeRequestId++;
    if (wakeSentinel) {
      void wakeSentinel.release();
      wakeSentinel = null;
    }
  });
  if ($("#keep-awake").checked) void updateWakeLock();

  return {
    set onMuteChanged(fn) {
      onMuteChanged = fn;
    },
  };
}
