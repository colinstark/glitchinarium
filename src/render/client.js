/**
 * Main-thread client for the render worker.
 *
 * Boot strategies (first that works wins):
 *  1. Direct module Worker from a validated JS URL
 *  2. Blob Worker from a fully-bundled self-contained worker script
 *  3. Main-thread pipeline (always available)
 *
 * Preview/export never hard-fail solely because the worker is unavailable.
 */

import {
  MSG,
  layersToDTO,
  paintLayerPatch,
  layerLivePatch,
  workerSupported,
} from "./protocol.js";
import { bufFromDrawable, bufToTransfer, createBuf } from "../buffer.js";
import { createContext } from "../context.js";
import { renderAsync } from "../pipeline.js";
import { boxDownsample } from "../buffer.js";

let singleton = null;
/** Optional URL installed from the app entry for bundler rewrite. */
let entryWorkerUrl = null;

/**
 * Call from main entry with `new URL("./render/worker.js", import.meta.url)`
 * so HTML-entry bundlers (Bun) rewrite a real worker chunk.
 */
export function installRenderWorker(url) {
  entryWorkerUrl = url;
}

/** Default URL next to this module (src/render/worker.js → dist/worker.js after bundle). */
const MODULE_WORKER_URL = new URL("./worker.js", import.meta.url);

/** fetch() is only safe for http(s)/blob — never for file:// (CORS noise in console). */
function isFetchableUrl(url) {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "blob:";
  } catch {
    return false;
  }
}

function pageIsHttp() {
  return typeof location !== "undefined" && /^https?:$/.test(location.protocol);
}

function candidateWorkerUrls() {
  const urls = [];
  // Prefer same-origin HTTP paths when the app is served (not file://).
  if (pageIsHttp()) {
    try {
      urls.push(new URL("worker.js", location.href));
      urls.push(new URL("/worker.js", location.origin));
    } catch {
      /* ignore */
    }
  }
  if (entryWorkerUrl) urls.push(entryWorkerUrl);
  urls.push(MODULE_WORKER_URL);
  // De-dupe; drop file: URLs entirely when the page is http (they only cause CORS errors).
  const seen = new Set();
  return urls.filter((u) => {
    const h = String(u);
    if (seen.has(h)) return false;
    seen.add(h);
    if (pageIsHttp() && h.startsWith("file:")) return false;
    return true;
  });
}

/**
 * Pull the woff2 bytes behind our Google Fonts <link>s so the worker can
 * register the same faces (workers cannot inherit the document's font set).
 *
 * A css2 sheet emits one @font-face per family AND per unicode subset, so this
 * is routinely dozens of files. They are fetched in parallel, and the caller
 * must not put this on the worker's boot path — see makeWorkerClient.
 */
async function collectGoogleFontBuffers() {
  if (typeof document === "undefined") return [];
  const sheets = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((l) => l.href)
    .filter((h) => /fonts\.googleapis\.com/i.test(h));

  const wanted = new Map(); // url → family
  for (const href of sheets) {
    try {
      const css = await fetch(href).then((r) => r.text());
      const faceRe =
        /font-family:\s*['"]?([^;'"]+)['"]?[^}]*?src:\s*url\(([^)]+\.woff2[^)]*)\)/gi;
      let m;
      while ((m = faceRe.exec(css))) {
        const family = m[1].trim();
        let url = m[2].trim().replace(/^['"]|['"]$/g, "");
        if (url.startsWith("//")) url = `https:${url}`;
        if (!wanted.has(url)) wanted.set(url, family);
      }
    } catch {
      /* optional */
    }
  }

  const fonts = await Promise.all(
    [...wanted].map(async ([url, family]) => {
      try {
        return { family, buffer: await fetch(url).then((r) => r.arrayBuffer()) };
      } catch {
        return null;
      }
    })
  );
  return fonts.filter(Boolean);
}

/**
 * Fired once the worker has registered its webfonts. Glyph layers measure text,
 * so anything rendered before this used fallback metrics and must be redrawn.
 */
const fontListeners = new Set();
export function onRenderFontsLoaded(fn) {
  fontListeners.add(fn);
  return () => fontListeners.delete(fn);
}
function notifyFontsLoaded() {
  for (const fn of fontListeners) {
    try {
      fn();
    } catch {
      /* a listener must not take down the render client */
    }
  }
}

/** @returns {Promise<{url: URL | string, text: string} | null>} */
async function fetchWorkerJs(url) {
  // Never fetch file:// — browsers log CORS errors even when the promise rejects.
  if (!isFetchableUrl(url)) return null;
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("html")) return null;
    const text = await res.text();
    const head = text.trimStart().slice(0, 64);
    if (head.startsWith("<!") || /^<html/i.test(head)) return null;
    // Bundled worker is pure JS; reject empty shells
    if (text.length < 32) return null;
    return { url, text };
  } catch {
    return null;
  }
}

function makeLocalFallback() {
  let cache = [];
  let stickySource = null;
  return {
    supported: false,
    ready: Promise.resolve(),
    invalidateCache(opts = {}) {
      cache = [];
      if (opts.clearSource) stickySource = null;
    },
    abort() {},
    loadFonts() {},
    dispose() {
      cache = [];
      stickySource = null;
    },
    async renderJob(job, { onProgress, shouldAbort } = {}) {
      if (job.sourceBuf && job.sendSource !== false) stickySource = job.sourceBuf;
      const source = stickySource ?? job.sourceBuf;
      if (!source) throw new Error("render: missing source buffer");

      // Local path has no sticky DTO — needs an explicit layer array.
      // Empty stack is valid (identity / cleared stack → source passthrough).
      // `undefined` layers is only for worker sticky patches.
      if (job.layers == null) {
        throw new Error(
          job.layerPatch
            ? "render: layer patch requires worker sticky DTO"
            : "render: missing layer stack"
        );
      }
      const layers = job.layers;
      const ctx = createContext({
        renderW: job.renderW,
        renderH: job.renderH,
        ssaa: job.ssaa ?? 1,
        seed: job.seed ?? 1,
        mode: job.mode === "export" ? "export" : "preview",
        interactivePaint: !!job.interactivePaint,
      });
      const useCache =
        job.mode !== "export" && job.useCache !== false && !job.skipCache;
      if (job.invalidateCache) cache = [];
      const totalSteps =
        job.mode === "export"
          ? Math.max(1, layers.length) + 2
          : Math.max(1, job.endIndex ?? layers.length);

      const rendered = await renderAsync(
        layers,
        source,
        ctx,
        useCache ? cache : null,
        (s) =>
          onProgress?.({
            phase: "render",
            done: s.done,
            total: totalSteps,
            layer: s.layer,
            layerLabel: s.layer?.label,
          }),
        shouldAbort,
        {
          yieldMs: job.yieldMs ?? (job.mode === "export" ? 6 : 8),
          preferTimeout: job.mode === "export",
          endIndex: job.endIndex,
          skipCache: job.skipCache || !useCache,
        }
      );
      if (!rendered) return null;

      let final = rendered;
      if (job.mode === "export") {
        final = boxDownsample(rendered, Math.max(1, Math.round(job.ssaa ?? 1)));
        onProgress?.({
          phase: "resolve",
          done: layers.length + 1,
          total: totalSteps,
        });
      }

      const masks = new Map();
      if (job.returnMasks && ctx.masks) {
        for (const [id, m] of ctx.masks) masks.set(id, m);
      }
      if (job.paintOnly) {
        return {
          buf: null,
          bitmap: null,
          masks,
          unchangedMaskIds: [],
          removedMaskIds: [],
          maskDeltas: false,
          renderW: job.renderW,
          renderH: job.renderH,
          paintOnly: true,
        };
      }
      return {
        buf: final,
        bitmap: null,
        masks,
        unchangedMaskIds: [],
        removedMaskIds: [],
        maskDeltas: false,
        renderW: job.renderW,
        renderH: job.renderH,
      };
    },
  };
}

/**
 * @param {string | URL} workerUrl
 * @param {{ revokeOnDispose?: boolean }} [opts]
 */
function makeWorkerClient(workerUrl, opts = {}) {
  let worker;
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (err) {
    console.warn("[render] Worker construct failed:", err);
    return null;
  }

  let nextId = 1;
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let readySettled = false;
  let dead = false;

  const kill = (reason) => {
    if (dead) return;
    dead = true;
    const err =
      reason instanceof Error ? reason : new Error(String(reason || "render worker error"));
    if (!readySettled) {
      readySettled = true;
      readyReject(err);
    }
    for (const [, slot] of pending) slot.reject(err);
    pending.clear();
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    if (opts.revokeOnDispose && typeof workerUrl === "string" && workerUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(workerUrl);
      } catch {
        /* ignore */
      }
    }
  };

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;

    if (msg.type === MSG.INIT_OK) {
      if (!readySettled) {
        readySettled = true;
        readyResolve();
      }
      return;
    }
    if (msg.type === MSG.INIT_ERR) {
      kill(new Error(msg.message || "worker init failed"));
      return;
    }
    if (msg.type === MSG.FONTS_OK) {
      notifyFontsLoaded();
      return;
    }

    const slot = pending.get(msg.id);
    if (!slot) return;

    if (msg.type === MSG.PROGRESS) {
      slot.onProgress?.({
        phase: msg.phase,
        done: msg.done,
        total: msg.total,
        layerLabel: msg.layerLabel,
        layer: msg.layerLabel ? { label: msg.layerLabel } : null,
      });
      return;
    }

    if (msg.type === MSG.RESULT) {
      pending.delete(msg.id);
      const buf = msg.image
        ? {
            w: msg.image.w,
            h: msg.image.h,
            data: new Uint8ClampedArray(msg.image.buffer),
          }
        : null;
      const masks = new Map();
      const unchangedMaskIds = [];
      for (const m of msg.masks ?? []) {
        if (m.unchanged) {
          unchangedMaskIds.push(m.id);
          continue;
        }
        masks.set(m.id, {
          w: m.w,
          h: m.h,
          data: new Float32Array(m.buffer),
          _rev: m.rev,
          bbox: m.bbox,
        });
      }
      slot.resolve({
        buf,
        bitmap: msg.bitmap ?? null,
        masks,
        unchangedMaskIds,
        removedMaskIds: msg.removedMaskIds ?? [],
        maskDeltas: true,
        renderW: msg.renderW,
        renderH: msg.renderH,
        paintOnly: !!msg.paintOnly,
      });
      return;
    }

    if (msg.type === MSG.ABORTED) {
      pending.delete(msg.id);
      slot.resolve(null);
      return;
    }

    if (msg.type === MSG.ERROR) {
      pending.delete(msg.id);
      slot.reject(new Error(msg.message || "worker render failed"));
    }
  };

  worker.onerror = (err) => {
    kill(new Error(`render worker error: ${err?.message || err?.filename || "load failed"}`));
  };
  worker.onmessageerror = () => kill(new Error("render worker messageerror"));

  // Boot immediately. Fonts used to be fetched BEFORE this, inside the same
  // 4s budget — dozens of serial CDN round-trips racing a hard timeout, and
  // losing that race silently demoted the whole session to the main thread.
  try {
    worker.postMessage({ type: MSG.INIT, fonts: [] });
  } catch (err) {
    kill(err);
    return null;
  }

  setTimeout(() => {
    if (!readySettled) kill(new Error("render worker init timeout"));
  }, 4000);

  // Fonts follow out-of-band; the worker announces FONTS_OK and the app
  // re-renders, so the first frame is at worst laid out on fallback metrics.
  collectGoogleFontBuffers()
    .then((fonts) => {
      if (dead || !fonts.length) return;
      try {
        worker.postMessage(
          { type: MSG.LOAD_FONTS, fonts },
          fonts.map((f) => f.buffer)
        );
      } catch {
        /* fonts are optional — never kill a working worker over them */
      }
    })
    .catch(() => {
      /* fonts are optional */
    });

  return {
    supported: true,
    ready,
    invalidateCache(opts = {}) {
      if (dead) return;
      try {
        worker.postMessage({
          type: MSG.INVALIDATE,
          clearSource: !!opts.clearSource,
          // Stack identity changed — drop sticky layer DTO + mask stamps.
          clearLayers: opts.clearLayers !== false,
        });
      } catch {
        /* dead */
      }
    },
    abort(id) {
      if (dead) return;
      try {
        worker.postMessage({ type: MSG.ABORT, id });
      } catch {
        /* dead */
      }
    },
    loadFonts(fonts) {
      if (dead || !fonts?.length) return;
      try {
        const transfer = fonts.map((f) => f.buffer).filter(Boolean);
        worker.postMessage({ type: MSG.LOAD_FONTS, fonts }, transfer);
      } catch {
        /* dead */
      }
    },
    dispose() {
      kill(new Error("disposed"));
    },
    get dead() {
      return dead;
    },
    async renderJob(job, { onProgress, shouldAbort } = {}) {
      if (dead) throw new Error("render worker is dead");
      await ready;
      if (dead) throw new Error("render worker is dead");

      try {
        worker.postMessage({ type: MSG.ABORT, id: null });
      } catch (err) {
        kill(err);
        throw err;
      }

      const id = nextId++;
      // Paint-fast: only serialise layers that will actually run — or send a
      // stroke patch against the worker's sticky DTO when requested.
      const end = job.endIndex ?? job.layers?.length ?? 0;
      let layers = null;
      let layerPatch = null;
      if (job.layerPatch) {
        layerPatch = job.layerPatch;
      } else if (job.layers) {
        layers = layersToDTO(job.layers, end);
      }
      const transferList = [];
      let sourcePayload = null;
      if (job.sourceBuf && job.sendSource !== false) {
        sourcePayload = bufToTransfer(job.sourceBuf);
        transferList.push(sourcePayload.buffer);
      }

      const payload = {
        type: MSG.RENDER,
        id,
        job: {
          mode: job.mode,
          source: sourcePayload,
          sourceKey: job.sourceKey ?? null,
          layers,
          layerPatch,
          seed: job.seed,
          ssaa: job.ssaa,
          renderW: job.renderW,
          renderH: job.renderH,
          interactivePaint: job.interactivePaint,
          // DTO already truncated — run full DTO length unless patching.
          endIndex: layers ? undefined : job.endIndex,
          skipCache: job.skipCache,
          useCache: job.useCache,
          invalidateCache: job.invalidateCache,
          returnMasks: job.returnMasks,
          paintOnly: job.paintOnly,
          maskDeltas: job.maskDeltas !== false,
          maskIds: job.maskIds ?? null,
          preferBitmap: job.preferBitmap !== false && job.mode !== "export",
          yieldMs: job.yieldMs,
        },
      };

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        try {
          worker.postMessage(payload, transferList);
        } catch (err) {
          pending.delete(id);
          reject(err);
          return;
        }

        if (shouldAbort) {
          const poll = () => {
            if (!pending.has(id)) return;
            if (shouldAbort()) {
              try {
                worker.postMessage({ type: MSG.ABORT, id });
              } catch {
                /* ignore */
              }
              return;
            }
            setTimeout(poll, 50);
          };
          setTimeout(poll, 50);
        }
      });
    },
  };
}

async function tryBootWorker() {
  if (!workerSupported()) return null;

  // Opening the app as file:// cannot load module workers reliably, and any
  // fetch() of file: URLs spams the console with CORS errors. Stay on main.
  if (typeof location !== "undefined" && location.protocol === "file:") {
    console.info("[render] file:// page — main-thread renderer");
    return null;
  }

  // Only construct a Worker from bytes we have already verified are JavaScript.
  // Pointing Worker() at a URL that SPA-falls-back to index.html produces
  // "SyntaxError: Unexpected token '<'" in the console — even if we catch later.
  for (const url of candidateWorkerUrls()) {
    const fetched = await fetchWorkerJs(url);
    if (!fetched) continue;

    try {
      const blob = new Blob([fetched.text], {
        type: "text/javascript;charset=utf-8",
      });
      const blobUrl = URL.createObjectURL(blob);
      const client = makeWorkerClient(blobUrl, { revokeOnDispose: true });
      if (!client) continue;
      await client.ready;
      console.info("[render] Worker ready (blob) from", String(fetched.url));
      return client;
    } catch (err) {
      console.warn("[render] Worker boot failed for", String(url), err?.message || err);
    }
  }

  return null;
}

function makeResilientClient() {
  const local = makeLocalFallback();
  let active = local;
  let mode = "local";

  const boot = (async () => {
    const worker = await tryBootWorker();
    if (!worker) {
      console.info("[render] Using main-thread renderer");
      return;
    }
    active = worker;
    mode = "worker";
  })();

  return {
    get supported() {
      return mode === "worker";
    },
    ready: boot,
    invalidateCache(opts) {
      active.invalidateCache(opts);
      if (mode === "worker") local.invalidateCache(opts);
    },
    abort(id) {
      active.abort(id);
    },
    loadFonts(fonts) {
      active.loadFonts?.(fonts);
    },
    dispose() {
      try {
        active.dispose();
      } catch {
        /* ignore */
      }
      local.dispose();
    },
    async renderJob(job, hooks) {
      await boot;
      const runLocal = () => local.renderJob({ ...job, sendSource: true }, hooks);

      if (mode !== "worker") return runLocal();

      try {
        return await active.renderJob(job, hooks);
      } catch (err) {
        console.warn("[render] Worker job failed, main-thread retry:", err?.message || err);
        try {
          active.dispose?.();
        } catch {
          /* ignore */
        }
        active = local;
        mode = "local";
        // Paint patches need the worker sticky DTO — cannot retry on main
        // alone. An EMPTY stack is still a valid job (identity render), so the
        // test is for a missing array, not a falsy length.
        if (job.layers == null) throw err;
        return runLocal();
      }
    },
  };
}

export function getRenderClient() {
  if (singleton) return singleton;
  singleton = makeResilientClient();
  return singleton;
}

export function decodeSource(drawable, w, h) {
  return bufFromDrawable(drawable, w, h);
}

export { workerSupported, createBuf, paintLayerPatch, layerLivePatch };
