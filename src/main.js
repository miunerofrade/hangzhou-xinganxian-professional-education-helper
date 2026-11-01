import { installDebugHooks } from "#debug-hooks";
import { createLifecycle } from "./lifecycle.js";
import { bindCourseLinkResponder } from "./course-links.js";
import { startFrameWorker } from "./frames/bridge.js";
import { recordEvent } from "./event-log.js";
import { CHANNEL, ORIGIN, FRAME_ORIGINS, route } from "./constants.js";
import { createRuntime } from "./runtime.js";
import { createPlatform } from "./platform.js";
import { createPanel } from "./ui/panel.js";
import { createDiagnostics } from "./diagnostics.js";
import { createAnnualService } from "./annual.js";
import { startPlayer } from "./player.js";
import { startController } from "./controller.js";

if (window.top !== window.self && FRAME_ORIGINS.includes(location.origin)) startFrameWorker();
else if (location.pathname === "/" && window.top === window.self && location.origin === ORIGIN) {
  const lifecycle = createLifecycle();
  const runtime = createRuntime({ lifecycle });
  recordEvent("page", "页面载入", route() === "#/class" ? "课程播放页" : "调度主页面");
  const platform = createPlatform();
  platform.callbacks.observeAuthResponse = runtime.observeAuthResponse;
  const channel = new BroadcastChannel(CHANNEL);
  function mount() {
    const panel = createPanel({ lifecycle });
    platform.callbacks.onNetworkRetry = panel.status;
    const diagnostics = createDiagnostics({ $: panel.$, lifecycle });
    const annual = createAnnualService({
      $: panel.$,
      status: panel.status,
      ...platform,
      channel,
      panel,
    });
    const env = {
      panel,
      runtime,
      annual,
      diagnostics,
      channel,
      lifecycle,
      ...platform,
    };
    installDebugHooks(env, platform.readAPI);
    lifecycle.on(channel, "message", (event) => {
      if (event.data?.type === "probe" && route() === "#/class")
        channel.postMessage({
          type: "presence",
          probe: event.data.probe,
          run: runtime.run,
          job: runtime.job,
        });
    });
    lifecycle.on(channel, "message", (event) => {
      const m = event.data;
      if (m?.type === "recovery-close" && route() === "#/class") {
        runtime.exitBridge.arm();
        for (const video of document.querySelectorAll(".video_wrap video")) video.pause();
        recordEvent("recovery", "收到课程页重试关闭指令", "仅退出当前课程页，不记录为完成");
        window.close();
      }
    });
    bindCourseLinkResponder({ channel, runtime, lifecycle });
    if (runtime.run && runtime.job && route() === "#/class") startPlayer(env);
    else startController(env);
    // Register last: snapshot/worker leaving handlers run before channel teardown.
    lifecycle.defer(() => channel.close?.());
    window.addEventListener("pagehide", () => lifecycle.dispose(), {
      once: true,
    });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
