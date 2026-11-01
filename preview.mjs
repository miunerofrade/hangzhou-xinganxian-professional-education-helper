import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["tools/preview-entry.js"],
  bundle: true,
  write: false,
  format: "iife",
  charset: "utf8",
  loader: { ".css": "text" },
});
await mkdir(".preview", { recursive: true });
await writeFile(
  ".preview/index.html",
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>学习助手 · 独立交互预览</title><style>body{margin:0;padding:28px;background:#f1f1f1;font-family:system-ui;color:#555}header{max-width:920px;margin:0 auto 24px;font-size:14px;line-height:1.6}nav{display:flex;gap:20px;margin-top:12px}a{color:#333}.palette-options{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px}.palette-options button{border:1px solid #ccc;border-radius:12px;padding:8px 12px;color:#333;cursor:pointer;font:inherit}.palette-options button[aria-pressed=true]{outline:2px solid #333;outline-offset:2px}#previews{display:flex;align-items:flex-start;justify-content:center;gap:28px;flex-wrap:wrap}@media(max-width:480px){body{padding:12px}}</style><header>学习助手交互预览（示例数据，不连接平台）<nav><a href="?mode=controller">调度面板</a><a href="?mode=player">播放页</a><a href="?mode=both">并排查看</a></nav></header><main id="previews"></main><script>${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`,
);
console.log("Built .preview/index.html");
