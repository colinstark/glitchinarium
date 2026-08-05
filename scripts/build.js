/**
 * Production static build for GitHub Pages.
 *
 * Bundles the ES module graph (including p5) into dist/main.js, copies CSS,
 * and rewrites index.html to load the bundle instead of ./src/main.js.
 */
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

await $`rm -rf ${dist}`;
await mkdir(dist, { recursive: true });

await $`bun build ${join(root, "src/main.js")} --outdir=${dist} --target=browser --minify`;

await cp(join(root, "styles.css"), join(dist, "styles.css"));

const html = await readFile(join(root, "index.html"), "utf8");
const built = html.replace(
  `src="./src/main.js"`,
  `src="./main.js"`,
);
await writeFile(join(dist, "index.html"), built);

// Prevent GitHub Pages from running Jekyll over the artifact.
await writeFile(join(dist, ".nojekyll"), "");

console.log("Built dist/ for GitHub Pages");
