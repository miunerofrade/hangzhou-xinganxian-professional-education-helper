import { collectDialogs, dialogStackLevel } from "./dialogs.js";
import { classify } from "./planner.js";
import { visible, text, log } from "./utils.js";
import { ACTION_DELAY_MS } from "./constants.js";
export function createPlayerDialogs({
  state,
  config,
  run,
  job,
  direct,
  doneKey,
  exitBridge,
  annual,
  pause,
  status,
  requestRecovery,
  send,
  rememberDirect,
  lifecycle,
}) {
  const dialogMessages = new WeakMap(),
    cycleBoxes = new Set();
  const handled = new WeakSet(),
    firstSeen = new WeakMap(),
    clickedAt = new WeakMap(),
    incompleteSince = new WeakMap();
  let dialogWasOpen = false;
  async function handle({ dialogBudget, tick }) {
    // Element Plus MessageBox 已由当前前端及参考脚本核实。
    // dialog/open 与 role=dialog 是标准语义兜底：只阻止操作，不猜测按钮。
    const { boxes, unknown: unknownDialogs } = collectDialogs();
    const choices = boxes
      .map((box, index) => ({
        box,
        index,
        message: text(box.querySelector(".el-message-box__message")),
      }))
      .map((item) => ({
        ...item,
        kind: classify(item.message),
        level: dialogStackLevel(item.box),
      }));
    const known = choices
      .filter((item) => item.kind.type !== "unknown")
      .sort((a, b) => b.level - a.level || b.index - a.index);
    const selected =
      known.find(
        (item) => !handled.has(item.box) || dialogMessages.get(item.box) !== item.message,
      ) ||
      known[0] ||
      choices[0];
    if (unknownDialogs.length && !known.length) {
      pause("遇到未识别弹窗，保留完成监控；90秒未恢复将重开当前课程", true);
      return true;
    }
    if (selected) {
      const { box, message, kind } = selected;
      cycleBoxes.add(box);
      dialogWasOpen = true;
      if (!message) {
        if (!incompleteSince.has(box)) incompleteSince.set(box, Date.now());
        if (Date.now() - incompleteSince.get(box) < 30000) {
          status("弹窗尚未加载完整，等待内容出现…");
          return true;
        }
        pause("弹窗内容30秒内仍未加载，请检查后继续");
        return true;
      }
      if (dialogMessages.get(box) !== message) {
        dialogMessages.set(box, message);
        handled.delete(box);
        firstSeen.delete(box);
        clickedAt.delete(box);
        log("弹窗等待诊断", {
          event: "识别弹窗",
          message: message.slice(0, 160),
          visibility: document.visibilityState,
          focused: document.hasFocus?.(),
        });
      }
      if (kind.type === "unknown") {
        pause(`未识别弹窗：${message.slice(0, 100)}；90秒未恢复将重开当前课程`, true);
        return true;
      }
      if (handled.has(box)) {
        if (Date.now() - clickedAt.get(box) > 90000) {
          log("弹窗等待诊断", {
            event: "点击后90秒仍检测到弹窗",
            message: message.slice(0, 160),
            visibility: document.visibilityState,
            focused: document.hasFocus?.(),
            waitedSeconds: Math.round((Date.now() - clickedAt.get(box)) / 1000),
          });
          pause("原生按钮点击90秒后弹窗仍未消失，正在重新打开当前课程", true);
          requestRecovery("原生弹窗点击90秒后仍未消失");
        } else status("原生确认已点击，等待平台响应；不会重复提交");
        return true;
      }
      if (!firstSeen.has(box))
        firstSeen.set(box, {
          at: Date.now(),
          delay: document.visibilityState === "hidden" ? 0 : 500,
        });
      const first = firstSeen.get(box);
      if (Date.now() - first.at < first.delay) {
        status(`已识别${kind.type === "complete" ? "平台完成" : "继续学习"}提示，稍后处理…`);
        return true;
      }
      if (["resume", "presence"].includes(kind.type) && !config.autoContinue) {
        pause("继续学习提示待你处理（自动继续未勾选）");
        return true;
      }
      const buttons = [...box.querySelectorAll(".el-message-box__btns button")].filter(visible);
      const label =
        kind.type === "complete" || (kind.type === "quota" && /是否继续学习/.test(message))
          ? "取消"
          : "确定";
      const candidates = buttons.filter((button) => text(button) === label && !button.disabled);
      if (candidates.length !== 1) {
        if (
          buttons.filter((button) => text(button) === label).length <= 1 &&
          Date.now() - first.at < 45000
        ) {
          status("原生按钮尚未就绪，最多等待45秒…");
          return true;
        }
        pause("原生按钮45秒后仍不可用或不唯一，请检查后继续");
        return true;
      }
      if (kind.type === "conflict") {
        handled.add(box);
        clickedAt.set(box, Date.now());
        exitBridge.arm();
        requestRecovery("平台提示同时只能播放一个视频");
        if (!direct) candidates[0].click();
        return true;
      }
      if (kind.type === "quota") {
        state.completed = true;
        exitBridge.arm();
        sessionStorage.setItem(doneKey, "1");
        if (direct) {
          await rememberDirect("complete");
          void annual.refreshLearnedInBackground();
        } else send("complete-notice", { notice: "course-hours-met" });
        handled.add(box);
        clickedAt.set(box, Date.now());
        candidates[0].click();
        if (!direct) lifecycle.timeout(() => window.close(), ACTION_DELAY_MS);
        status("平台提示课程学时已达标，正在同步已学列表");
        return true;
      }
      if (kind.type === "complete") {
        state.completed = true;
        exitBridge.arm();
        sessionStorage.setItem(doneKey, "1");
        if (!direct)
          localStorage.setItem(
            `hz-helper-completion:${run}:${job}`,
            JSON.stringify({ id: config.course.id, credits: kind.credits }),
          );
        send("complete", { credits: kind.credits });
        if (direct) {
          state.video?.pause();
          await rememberDirect("complete");
          status("平台提示完成，可返回课程列表；已学列表正在后台查询");
          void annual.refreshLearnedInBackground();
          return true;
        }
        status(`平台明确完成，获得 ${kind.credits} 学分，关闭此播放页…`);
      } else log(`点击已核实原生按钮：${kind.type}`);
      handled.add(box);
      clickedAt.set(box, Date.now());
      candidates[0].click(); // 原生回调负责继续/关闭及平台请求；不调用验证接口。
      if (state.completed)
        lifecycle.timeout(() => {
          if (!window.closed) {
            window.close();
            status("已请求关闭完成页；若仍有浏览器提示，请手动关闭并确认已重开新版课页");
          }
        }, ACTION_DELAY_MS);
      if (
        !state.completed &&
        document.visibilityState === "hidden" &&
        choices.length > 1 &&
        dialogBudget > 1
      )
        await tick(dialogBudget - 1);
      return true;
    }
    if (dialogWasOpen) {
      for (const box of cycleBoxes) {
        handled.delete(box);
        firstSeen.delete(box);
        clickedAt.delete(box);
        incompleteSince.delete(box);
        dialogMessages.delete(box);
      }
      cycleBoxes.clear();
      state.lastAdvance = Date.now();
      dialogWasOpen = false;
    }
    return false;
  }
  return { handle };
}
