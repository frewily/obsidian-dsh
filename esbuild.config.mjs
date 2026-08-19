import esbuild from "esbuild";
import process from "node:process";
import { copyFileSync, mkdirSync } from "node:fs";

const prod = process.argv[2] === "production";
const outdir = "dist";

mkdirSync(outdir, { recursive: true });
copyFileSync("manifest.json", `${outdir}/manifest.json`);
copyFileSync("styles.css", `${outdir}/styles.css`);

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "codemirror", "@codemirror/*", "node:*"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: `${outdir}/main.js`,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}
