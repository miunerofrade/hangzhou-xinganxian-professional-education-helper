import { build } from "esbuild";
import { format, resolveConfig } from "prettier";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL(".", import.meta.url));
export async function bundle({ testing = false } = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/main.js"],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
    charset: "utf8",
    minify: false,
    minifySyntax: false,
    legalComments: "inline",
    loader: { ".css": "text" },
    alias: {
      "#debug-hooks": path.join(root, testing ? "src/debug-hooks.js" : "src/no-debug-hooks.js"),
    },
  });
  const metadata = await readFile(path.join(root, "src/metadata.txt"), "utf8");
  const formatting = await resolveConfig(path.join(root, ".prettierrc.json"));
  const javascript = await format(result.outputFiles[0].text, { ...formatting, parser: "babel" });
  // The userscript can be distributed by itself, so its legal notices travel with it.
  const licenseFiles = [
    ["本项目（MIT）", "LICENSE"],
    ["Material Color Utilities（Apache-2.0）", "licenses/Material-Color-Utilities-Apache-2.0.txt"],
    ["Lucide 与 Feather 图标（ISC / MIT）", "licenses/Lucide-ISC-and-Feather-MIT.txt"],
  ];
  const materialPackage = JSON.parse(
    await readFile(
      path.join(root, "node_modules/@material/material-color-utilities/package.json"),
      "utf8",
    ),
  );
  const sourceNotice = [
    `// 内嵌库：Material Color Utilities ${materialPackage.version}`,
    "// 来源：https://github.com/material-foundation/material-color-utilities/tree/main/typescript",
    "// 上游为含相对依赖的 ES 模块，不能直接通过传统用户脚本的外部加载指令执行；构建时以非压缩形式打包。",
    "// 图标来源：https://github.com/lucide-icons/lucide（部分图标源自 Feather）",
  ].join("\n");
  const notices = await Promise.all(
    licenseFiles.map(async ([label, file]) => {
      const text = await readFile(path.join(root, file), "utf8");
      return [
        `// ${label}`,
        ...text
          .trimEnd()
          .split("\n")
          .map((line) => (line.trimEnd() ? `// ${line.trimEnd()}` : "//")),
      ].join("\n");
    }),
  );
  return `${metadata}\n${javascript}\n${sourceNotice}\n\n${notices.join("\n\n")}\n`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await bundle();
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/hz-learning-helper.user.js"), output);
  await writeFile(path.join(root, "hz-learning-helper.user.js"), output);
  console.log("Built dist/hz-learning-helper.user.js (root copy updated)");
}
