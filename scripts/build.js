/**
 * Production static build for GitHub Pages.
 *
 * Bundles the ES module graph into dist/main.js, the render worker into
 * dist/worker.js, copies CSS, and rewrites index.html.
 */
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

await $`rm -rf ${dist}`;
await mkdir(dist, { recursive: true });

await $`bun build ${join(root, "src/main.js")} --outdir=${dist} --target=browser --minify`;

// Self-contained worker bundle next to main.js (import.meta.url resolves here).
await $`bun build ${join(root, "src/render/worker.js")} --outfile=${join(dist, "worker.js")} --target=browser --minify`;

// No root worker.js copy: dev serves /worker.js from scripts/dev.js (rebuilt per
// request), and production loads it from dist/ next to index.html. A stale
// artifact at the repo root would only be a way to run last week's worker.

await cp(join(root, "styles.css"), join(dist, "styles.css"));

const html = await readFile(join(root, "index.html"), "utf8");
const built = html.replace(`src="./src/main.js"`, `src="./main.js"`);
await writeFile(join(dist, "index.html"), built);

// Prevent GitHub Pages from running Jekyll over the artifact.
await writeFile(join(dist, ".nojekyll"), "");

console.log("Built dist/ for GitHub Pages (main + worker)");
