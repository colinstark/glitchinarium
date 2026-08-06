/**
 * Dev server.
 *
 * `bun --hot index.html` serves the HTML module graph and SPA-falls-back
 * everything else to index.html — including `/worker.js`. The render client
 * checks the content-type before it will construct a Worker from a URL, so it
 * correctly refused that HTML, then found only `file:` candidates left and gave
 * up. Net effect: the render worker NEVER booted under `bun dev`, and every dev
 * session silently ran the whole pipeline on the main thread.
 *
 * That is worth a real server rather than a static artifact, because an
 * off-main-only bug is invisible until dev actually goes off-main.
 */
import { join } from "node:path";
import index from "../index.html";

const root = join(import.meta.dir, "..");
const workerEntry = join(root, "src/render/worker.js");

/**
 * Bundle on demand. It costs single-digit milliseconds and, unlike a prebuilt
 * artifact at the repo root, can never be stale relative to the source you are
 * editing — reload the page and you are running your worker changes.
 */
async function buildWorker() {
  const built = await Bun.build({ entrypoints: [workerEntry], target: "browser" });
  if (!built.success) {
    throw new Error(built.logs.map((l) => String(l)).join("\n"));
  }
  return await built.outputs[0].text();
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: { hmr: true, console: true },
  routes: {
    "/worker.js": async () => {
      try {
        return new Response(await buildWorker(), {
          headers: {
            "Content-Type": "text/javascript;charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        console.error(`[dev] worker build failed:\n${err?.message || err}`);
        // Plain text, never HTML: the client's guard keys off the content-type,
        // and a 500 here should demote to the main thread rather than try to
        // execute an error page.
        return new Response(String(err?.message || err), {
          status: 500,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });
      }
    },
    "/*": index,
  },
});

console.log(`Glitchinarium dev  →  ${server.url}`);
console.log("  /worker.js is rebuilt per request from src/render/worker.js");
