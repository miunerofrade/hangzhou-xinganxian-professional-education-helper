import { panelStyles } from "./stylesheet.js";
import { createLifecycle } from "../lifecycle.js";
import { bindInfoDisclosures } from "./info.js";
import { bindSurfaceCards } from "./surface-card.js";
import { bindAppearance } from "./theme.js";
import { bindLauncher } from "./launcher.js";
import { bindPreferences } from "./preferences.js";
import { icon } from "./icons.js";
import { panelTemplate } from "./template.js";
import { log } from "../utils.js";
import { recordEvent } from "../event-log.js";
export function createPanel({ lifecycle: externalLifecycle } = {}) {
  const lifecycle = externalLifecycle || createLifecycle();
  const host = document.createElement("div");
  host.id = "hz-learning-helper";
  document.documentElement.append(host);
  const ui = host.attachShadow({ mode: "open" });
  function info(id, label, description) {
    return `<span class="info-wrap"><button type="button" class="info-trigger" data-info="${id}" aria-label="${label}" aria-expanded="false" aria-controls="${id}">${icon("info", 16)}</button><span class="help" id="${id}" role="note" hidden>${description}</span></span>`;
  }
  ui.innerHTML = `<style>${panelStyles}</style>${panelTemplate(icon, info)}`;
  const $ = (selector) => ui.querySelector(selector);
  bindAppearance({ host, $, lifecycle });
  bindSurfaceCards({ host, root: ui, lifecycle });
  const infoView = bindInfoDisclosures({ ui, $, lifecycle });
  let lastStatus = "",
    expanded = false,
    onPanelOpened = () => {};
  const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  function setExpanded(value) {
    infoView.close();
    expanded = value;
    const panel = $("#panel"),
      launcher = $("#launcher");
    launcher.setAttribute("aria-expanded", String(value));
    launcher.setAttribute("aria-label", value ? "收起学习助手" : "打开学习助手");
    if (value) {
      panel.hidden = false;
      panel.inert = false;
      panel.removeAttribute("aria-hidden");
      panel.focus({ preventScroll: true });
      onPanelOpened();
    } else {
      panel.inert = true;
      launcher.focus({ preventScroll: true });
      panel.setAttribute("aria-hidden", "true");
    }
    launcher.tabIndex = value ? -1 : 0;
    menuMotion.transition(value);
  }
  const menuMotion = bindLauncher({
    host,
    panel: $("#panel"),
    launcher: $("#launcher"),
    reducedMotion,
    lifecycle,
    onToggle: () => setExpanded(!expanded),
  });
  const preferences = bindPreferences({ $, icon, lifecycle });

  $("#close-panel").onclick = () => setExpanded(false);
  // Shadow DOM retargets internal clicks to the host at document level.
  lifecycle.on(
    document,
    "click",
    (event) => {
      if (!expanded) return;
      const path = event.composedPath?.() || [];
      if (event.target === host || path.includes(host)) return;
      setExpanded(false);
    },
    true,
  );
  lifecycle.on(ui, "keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (infoView.opened) {
      const button = infoView.opened.button;
      infoView.close();
      button.focus();
    } else if (expanded) setExpanded(false);
  });
  function status(message, { logged = false } = {}) {
    if (message === lastStatus) return;
    $("#state").textContent = message;
    $("#status-line").hidden = true;
    const level = /失败|错误|过期|拒绝|无法|不支持|不匹配|阻止/.test(message)
      ? "error"
      : /未响应|重试|未读到|未完成|自动暂停/.test(message)
        ? "warning"
        : "info";
    if (!logged && !["等待预览", "正在识别主播放器…"].includes(message))
      recordEvent("state", "运行状态", message, { level });
    log(message);
    lastStatus = message;
  }

  if (!externalLifecycle)
    window.addEventListener("pagehide", () => lifecycle.dispose(), {
      once: true,
    });
  return {
    lifecycle,
    ui,
    $,
    icon,
    info,
    status,
    get onPanelOpened() {
      return onPanelOpened;
    },
    set onPanelOpened(fn) {
      onPanelOpened = fn;
    },
    set onMuteChanged(fn) {
      preferences.onMuteChanged = fn;
    },
  };
}
