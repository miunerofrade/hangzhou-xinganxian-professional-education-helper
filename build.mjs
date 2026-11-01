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
  return `${metadata}\n${javascript}`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await bundle();
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/hz-learning-helper.user.js"), output);
  await writeFile(path.join(root, "hz-learning-helper.user.js"), output);
  console.log("Built dist/hz-learning-helper.user.js (root copy updated)");
}
