const summaryRules = [
  [/播放页.*(?:未响应|无响应)/, "等待播放页响应"],
  [/正在恢复|关闭其他课程页|正在重新打开/, "正在重开课程"],
  [/已恢复当前播放页|正在学习|正常播放/, "课程播放中"],
  [/核对失败/, "课程核对失败"],
  [/继续核对|正在核对/, "正在核对课程"],
  [/达到目标|学习结束/, "学习目标已完成"],
  [/请允许.*弹窗|重开课程被拦截/, "课程窗口被拦截"],
  [/手动暂停|主面板已暂停/, "学习已暂停"],
  [/查找课程|继续查找|补充学习计划/, "正在查找课程"],
];

// Compact headlines are presentation only; original detail/debug data stays intact.
export function logSummary(event, detail = "") {
  if (!["运行状态", "预览操作"].includes(event)) return event || "运行状态";
  const text = String(detail);

  return (
    summaryRules.find(([pattern]) => pattern.test(text))?.[1] ||
    text.split(/[；;\n]/)[0].slice(0, 36) ||
    "运行状态"
  );
}
