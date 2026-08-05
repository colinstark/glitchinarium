/**
 * Headless verification harness — `bun run verify`.
 *
 * The invariant this exists to protect is the SCALE CONTRACT: a stack rendered
 * at preview size and the same stack rendered at export size must describe the
 * same artwork. A processor that indexes raw pixels instead of artwork units
 * breaks it silently, and you only find out when an export looks nothing like
 * what you designed. So: render every processor at 1x and at 4x, downsample the
 * 4x result, and diff.
 *
 * Also checks determinism (same seed twice ⇒ identical bytes), seed
 * sensitivity, and that the layer cache returns exactly what an uncached render
 * would have.
 */

import { createCanvas, ImageData as NapiImageData } from "@napi-rs/canvas";

// --- minimal DOM shim, installed before any app module loads ---------------
globalThis.ImageData = NapiImageData;
globalThis.document = {
  createElement(tag) {
    if (tag !== "canvas") throw new Error(`no shim for <${tag}>`);
    return createCanvas(1, 1);
  },
  fonts: { ready: Promise.resolve(), add() {} },
};

const { createBuf, boxDownsample, cloneBuf, bufToCanvas } = await import("./src/buffer.js");
const { createContext, planExport, MAX_WORKING_BYTES } = await import("./src/context.js");
const { render, createLayer } = await import("./src/pipeline.js");
const { PROCESSORS } = await import("./src/processors/index.js");
const { fbm } = await import("./src/rng.js");

// --- a synthetic source with structure at several scales -------------------
function makeSource(w, h) {
  const buf = createBuf(w, h);
  const d = buf.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const i = (y * w + x) * 4;

      // broad gradient + two discs + a hard rectangle + fine ripples
      let r = 40 + 180 * u;
      let g = 60 + 150 * v;
      let b = 200 - 140 * u;

      const d1 = Math.hypot(u - 0.32, v - 0.4);
      const d2 = Math.hypot(u - 0.7, v - 0.62);
      if (d1 < 0.18) { r = 235; g = 90; b = 60; }
      if (d2 < 0.13) { r = 30; g = 170; b = 150; }
      if (u > 0.45 && u < 0.58 && v > 0.15 && v < 0.85) { r = 250; g = 240; b = 210; }

      // Multi-scale texture so detail/edge masks have something real to find —
      // a photo has grain at every scale, flat gradients do not.
      const tex =
        (fbm(u * 8, v * 8, 99, 5) - 0.5) * 46 +
        (fbm(u * 34, v * 34, 7, 3) - 0.5) * 26;
      d[i] = Math.max(0, Math.min(255, r + tex));
      d[i + 1] = Math.max(0, Math.min(255, g + tex * 0.8));
      d[i + 2] = Math.max(0, Math.min(255, b - tex * 0.6));
      d[i + 3] = 255;
    }
  }
  return buf;
}

function meanAbsDiff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
    n += 3;
  }
  return sum / n;
}

function identical(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

const SEED = 1234;
const BASE_W = 320;
const BASE_H = 240;
const FACTOR = 4;
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  return condition;
};

const hiSource = makeSource(BASE_W * FACTOR, BASE_H * FACTOR);
const loSource = boxDownsample(hiSource, FACTOR); // same content, less detail

function runStack(layers, source, ssaa) {
  const ctx = createContext({
    renderW: source.w,
    renderH: source.h,
    ssaa,
    seed: SEED,
    mode: ssaa > 1 ? "export" : "preview",
  });
  return render(layers, source, ctx, null);
}

// --------------------------------------------------------------- scale test

console.log("\n\x1b[1mScale contract\x1b[0m  — 1x vs 4x-downsampled, mean abs channel diff (0-255)\n");

/**
 * Periodic processors get their feature size raised so it is comfortably
 * resolvable at 1x before the comparison.
 *
 * A halftone dot with a 1.9px pitch cannot be drawn correctly at preview
 * resolution no matter how the code is written — the 4x render genuinely
 * carries information the 1x one cannot. Testing at the default pitch measures
 * Nyquist, not scale-contract compliance, and would mask a real bug behind a
 * number that is "expected to be large". Raising the feature isolates the thing
 * we actually care about: does the geometry land in the same place.
 */
const RESOLVABLE_PX = 10;

const results = [];
for (const [id, proc] of Object.entries(PROCESSORS)) {
  if (proc.kind === "mask") continue; // masks produce no image; covered below

  const layer = createLayer(id);
  let note = "";
  if (proc.feature?.length) {
    const scale = Math.max(loSource.w, loSource.h) / 1000;
    for (const key of proc.feature) {
      const def = proc.params.find((d) => d.key === key);
      const want = RESOLVABLE_PX / scale;
      if (def && layer.params[key] < want) {
        layer.params[key] = Math.min(def.max ?? want, want);
        note = " (at resolvable pitch)";
      }
    }
  }

  const layers = [layer];
  const lo = runStack(layers, loSource, 1);
  const hi = boxDownsample(runStack(layers, hiSource, FACTOR), FACTOR);
  results.push({ id, diff: meanAbsDiff(lo, hi), note });
}

results.sort((a, b) => a.diff - b.diff);
for (const { id, diff, note } of results) {
  const verdict =
    diff < 6 ? "\x1b[32mtight\x1b[0m" : diff < 16 ? "\x1b[33macceptable\x1b[0m" : "\x1b[31mDRIFT\x1b[0m";
  console.log(`  ${id.padEnd(16)} ${diff.toFixed(2).padStart(7)}   ${verdict}${note ? `\x1b[2m${note}\x1b[0m` : ""}`);
  check(diff < 16, `scale contract drift: ${id} (${diff.toFixed(2)})`);
}

// Full stack, mixing categories.
const fullStack = [
  createLayer("levels", {}),
  createLayer("ripple", {}),
  createLayer("pixel-sort", {}),
  createLayer("rgb-split", {}),
  createLayer("gradient-map", {}),
];
{
  const lo = runStack(fullStack, loSource, 1);
  const hi = boxDownsample(runStack(fullStack, hiSource, FACTOR), FACTOR);
  const diff = meanAbsDiff(lo, hi);
  console.log(`\n  ${"FULL STACK".padEnd(14)} ${diff.toFixed(2).padStart(7)}`);
  check(diff < 16, `scale contract drift: full stack (${diff.toFixed(2)})`);
}

// ------------------------------------------------------------- determinism

console.log("\n\x1b[1mDeterminism\x1b[0m\n");
{
  const stack = [createLayer("datamosh"), createLayer("pixel-sort"), createLayer("kaleido")];
  stack[2].params.mode = "trencadis";
  const a = runStack(stack, loSource, 1);
  const b = runStack(stack, loSource, 1);
  const same = identical(a, b);
  console.log(`  same seed twice        ${same ? "\x1b[32midentical\x1b[0m" : "\x1b[31mDIFFERS\x1b[0m"}`);
  check(same, "determinism: same seed differs");

  const ctx = createContext({ renderW: loSource.w, renderH: loSource.h, ssaa: 1, seed: SEED + 1 });
  const c = render(stack, loSource, ctx, null);
  const d = meanAbsDiff(a, c);
  console.log(`  different seed         ${d > 1 ? `\x1b[32mchanges (${d.toFixed(1)})\x1b[0m` : `\x1b[31mNO EFFECT\x1b[0m`}`);
  check(d > 1, "determinism: different seed has no effect");
}

// ------------------------------------------------------------------- cache

console.log("\n\x1b[1mLayer cache\x1b[0m\n");
{
  const stack = [
    createLayer("levels"),
    createLayer("ripple"),
    createLayer("gradient-map"),
    createLayer("rgb-split"),
    createLayer("dither"),
  ];
  const cache = [];
  const ctxOf = () => createContext({ renderW: loSource.w, renderH: loSource.h, ssaa: 1, seed: SEED });

  const t0 = performance.now();
  render(stack, loSource, ctxOf(), cache);
  const cold = performance.now() - t0;

  stack[4].params.blockSize = 9; // touch only the last layer
  const t1 = performance.now();
  const warm = render(stack, loSource, ctxOf(), cache);
  const warmMs = performance.now() - t1;

  const fresh = render(stack, loSource, ctxOf(), null);
  console.log(`  cold full render       ${cold.toFixed(0)} ms`);
  console.log(`  edit last layer        ${warmMs.toFixed(0)} ms  (${(cold / warmMs).toFixed(1)}x faster)`);
  const cacheMatches = identical(warm, fresh);
  console.log(`  cached === uncached    ${cacheMatches ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  check(cacheMatches, "cache: cached output differs from uncached output");

  // Editing layer 0 must invalidate everything below it.
  stack[0].params.contrast = 0.5;
  const after = render(stack, loSource, ctxOf(), cache);
  const freshAfter = render(stack, loSource, ctxOf(), null);
  const invalidates = identical(after, freshAfter);
  console.log(`  invalidates downstream ${invalidates ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  check(invalidates, "cache: upstream edit did not invalidate downstream");
}

// --------------------------------------------------------- masks & emission

console.log("\n\x1b[1mMasking\x1b[0m\n");
{
  const maskLayer = createLayer("mask");
  maskLayer.params.source = "radial";
  maskLayer.params.threshold = 0.5;
  maskLayer.params.softness = 0.1;

  const tinted = createLayer("gradient-map");
  tinted.params.palette = "ember";
  tinted.mask = maskLayer.id;

  const ctx = createContext({ renderW: loSource.w, renderH: loSource.h, ssaa: 1, seed: SEED });
  const out = render([maskLayer, tinted], loSource, ctx, null);

  // Centre should be recoloured, corner should be untouched.
  const at = (b, x, y) => {
    const i = (y * b.w + x) * 4;
    return [b.data[i], b.data[i + 1], b.data[i + 2]];
  };
  const cDiff = at(out, loSource.w >> 1, loSource.h >> 1).reduce(
    (s, v, i) => s + Math.abs(v - at(loSource, loSource.w >> 1, loSource.h >> 1)[i]), 0);
  const eDiff = at(out, 2, 2).reduce((s, v, i) => s + Math.abs(v - at(loSource, 2, 2)[i]), 0);
  console.log(`  inside mask changed    ${cDiff > 20 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"} (${cDiff})`);
  console.log(`  outside mask untouched ${eDiff < 3 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"} (${eDiff})`);
  check(cDiff > 20, "masking: inside mask did not change");
  check(eDiff < 3, "masking: outside mask changed");

  // datamosh publishing its own disturbance field
  const mosh = createLayer("datamosh");
  mosh.params.emitMask = true;
  const ascii = createLayer("ascii");
  ascii.mask = mosh.id;
  const ctx2 = createContext({ renderW: loSource.w, renderH: loSource.h, ssaa: 1, seed: SEED });
  render([mosh, ascii], loSource, ctx2, null);
  console.log(`  datamosh emits mask    ${ctx2.masks.has(mosh.id) ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  check(ctx2.masks.has(mosh.id), "masking: datamosh did not emit a mask");

  // Brush strokes are stored normalised with radii in artwork units, so the
  // same stroke must cover the same part of the picture at any render size.
  const brush = createLayer("mask");
  brush.params.source = "paint";
  brush.params.threshold = 0.01;
  brush.params.softness = 0.02;
  brush.params.feather = 0;
  brush.params.strokes = [{ pts: [0.2, 0.5, 0.8, 0.5], r: 40, hardness: 0.8, flow: 1, erase: false }];

  const coverage = (buf, ssaa) => {
    const c = createContext({ renderW: buf.w, renderH: buf.h, ssaa, seed: SEED });
    c.forLayer(0, brush);
    const m = PROCESSORS.mask.compute(c, buf, brush.params);
    let on = 0;
    for (let i = 0; i < m.data.length; i++) if (m.data[i] > 0.5) on++;
    return { frac: on / m.data.length, mask: m };
  };
  const lo = coverage(loSource, 1);
  const hi = coverage(hiSource, FACTOR);
  const mid = (m, fx, fy) => m.data[Math.round(fy * (m.h - 1)) * m.w + Math.round(fx * (m.w - 1))];
  console.log(`  brush paints           ${mid(lo.mask, 0.5, 0.5) > 0.5 && mid(lo.mask, 0.5, 0.1) < 0.5 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  console.log(
    `  brush scale-invariant  ${Math.abs(lo.frac - hi.frac) < 0.01 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}` +
    ` (${(lo.frac * 100).toFixed(1)}% vs ${(hi.frac * 100).toFixed(1)}%)`
  );
  check(mid(lo.mask, 0.5, 0.5) > 0.5 && mid(lo.mask, 0.5, 0.1) < 0.5, "masking: brush field is incorrect");
  check(Math.abs(lo.frac - hi.frac) < 0.01, "masking: brush is not scale invariant");

  // Appending points should update the cached preview field incrementally, but
  // must remain byte-for-byte equivalent to a cold export rasterisation.
  const incremental = createLayer("mask");
  incremental.params.source = "paint";
  incremental.params.feather = 3;
  incremental.params.strokes = [{
    pts: [0.1, 0.2, 0.1, 0.2],
    r: 30,
    hardness: 0.4,
    flow: 0.6,
    erase: false,
  }];
  const incrementalCtx = createContext({
    renderW: loSource.w,
    renderH: loSource.h,
    ssaa: 1,
    seed: SEED,
    mode: "preview",
  });
  let incrementalMask = null;
  for (let i = 1; i < 40; i++) {
    incremental.params.strokes[0].pts.push(0.1 + (0.7 * i) / 39, 0.2 + (0.5 * i) / 39);
    incremental.params.strokes._v = (incremental.params.strokes._v | 0) + 1;
    incrementalMask = PROCESSORS.mask.compute(incrementalCtx, loSource, incremental.params);
  }
  const coldCtx = createContext({
    renderW: loSource.w,
    renderH: loSource.h,
    ssaa: 1,
    seed: SEED,
    mode: "export",
  });
  const coldMask = PROCESSORS.mask.compute(coldCtx, loSource, incremental.params);
  const masksEqual = (a, b) => {
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
    return true;
  };
  let exact = masksEqual(incrementalMask, coldMask);

  // A newly appended eraser can be incremental too; removing it must force a
  // correct cold rebuild because subtraction cannot be reversed in place.
  incremental.params.strokes.push({
    pts: [0.35, 0.45, 0.65, 0.45],
    r: 18,
    hardness: 0.7,
    flow: 0.8,
    erase: true,
  });
  incremental.params.strokes._v++;
  incrementalMask = PROCESSORS.mask.compute(incrementalCtx, loSource, incremental.params);
  let reference = PROCESSORS.mask.compute(coldCtx, loSource, incremental.params);
  exact &&= masksEqual(incrementalMask, reference);
  incremental.params.strokes.pop();
  incremental.params.strokes._v++;
  incrementalMask = PROCESSORS.mask.compute(incrementalCtx, loSource, incremental.params);
  reference = PROCESSORS.mask.compute(coldCtx, loSource, incremental.params);
  exact &&= masksEqual(incrementalMask, reference);
  console.log(`  incremental brush      ${exact ? "\x1b[32mexact\x1b[0m" : "\x1b[31mDIFFERS\x1b[0m"}`);
  check(exact, "masking: incremental brush differs from cold rasterisation");
}

// ------------------------------------------------------- param modulation

console.log("\n\x1b[1mParameter modulation\x1b[0m\n");
{
  const mk = () => {
    const m = createLayer("mask");
    m.params.source = "linear";
    m.params.threshold = 0.5;
    m.params.softness = 1;
    m.params.feather = 0;
    return m;
  };

  // A left-to-right ramp driving ripple amplitude: the left edge must stay put
  // while the right edge distorts.
  const maskL = mk();
  const rip = createLayer("ripple");
  rip.params.amplitude = 0;
  rip.mods = { amplitude: { mask: maskL.id, min: 0, max: 60, invert: false } };

  const ctx = createContext({ renderW: loSource.w, renderH: loSource.h, ssaa: 1, seed: SEED });
  const out = render([maskL, rip], loSource, ctx, null);

  const colDiff = (x) => {
    let s = 0;
    for (let y = 0; y < loSource.h; y++) {
      const i = (y * loSource.w + x) * 4;
      s += Math.abs(out.data[i] - loSource.data[i]);
    }
    return s / loSource.h;
  };
  // The claim is that the RAMP drives amplitude, so the right assertion is
  // monotonic growth across the ramp — not an absolute displacement at one
  // column, which depends on how textured that column happens to be.
  const probes = [0.1, 0.35, 0.6, 0.9].map((f) => colDiff(Math.round(f * (loSource.w - 1))));
  const rising = probes.every((v, i) => i === 0 || v >= probes[i - 1] - 0.2);
  const spread = probes[3] - probes[0];
  console.log(
    `  ramp drives amplitude  ${rising && probes[0] < 1 && spread > 2 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}` +
    ` [${probes.map((v) => v.toFixed(1)).join(" → ")}]`
  );
  check(rising && probes[0] < 1 && spread > 2, "modulation: ramp does not drive amplitude");

  // Quadtree subdivision: binding a mask to `subdivide` must change the glyph
  // grid, and must do so identically at 1x and 4x.
  const maskA = mk();
  const asc = createLayer("ascii");
  asc.params.columns = 40;
  asc.params.subdivide = 2;
  asc.params.bgAlpha = 1;
  const plain = render([maskA, createLayer("ascii")], loSource, ctxOfSize(loSource), null);
  asc.mods = { subdivide: { mask: maskA.id, min: 0, max: 1, invert: false } };
  const split = render([maskA, asc], loSource, ctxOfSize(loSource), null);
  console.log(`  subdivide changes grid ${meanAbsDiff(plain, split) > 5 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  check(meanAbsDiff(plain, split) > 5, "modulation: subdivide does not change grid");

  const maskB = mk();
  const asc4 = createLayer("ascii", { id: asc.id });
  asc4.params.columns = 40;
  asc4.params.subdivide = 2;
  asc4.params.bgAlpha = 1;
  asc4.mods = { subdivide: { mask: maskB.id, min: 0, max: 1, invert: false } };
  maskB.id = maskA.id;
  const hiOut = boxDownsample(
    render([maskB, asc4], hiSource, createContext({ renderW: hiSource.w, renderH: hiSource.h, ssaa: FACTOR, seed: SEED }), null),
    FACTOR
  );
  const d = meanAbsDiff(split, hiOut);
  console.log(`  scale-safe at 4x       ${d < 16 ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"} (${d.toFixed(2)})`);
  check(d < 16, `modulation: scale drift (${d.toFixed(2)})`);
}

// ------------------------------------------------ regression checks

console.log("\n\x1b[1mRegression checks\x1b[0m\n");
{
  const { compositeInto } = await import("./src/buffer.js");
  const dst = createBuf(1, 1);
  const src = createBuf(1, 1);
  src.data.set([255, 0, 0, 128]);
  compositeInto(dst, src);
  const alphaOk = dst.data[0] === 255 && Math.abs(dst.data[3] - 128) <= 1;
  console.log(`  straight alpha         ${alphaOk ? "\x1b[32myes\x1b[0m" : "\x1b[31mNO\x1b[0m"}`);
  check(alphaOk, `compositing: expected [255,0,0,128], got [${[...dst.data]}]`);

  const { serialise, instantiate } = await import("./src/ui/presets.js");
  const disabled = createLayer("levels");
  disabled.enabled = false;
  const roundTrip = instantiate(serialise("round trip", SEED, [disabled]));
  const enabledOk = roundTrip[0].enabled === false;
  console.log(`  disabled preset layer  ${enabledOk ? "\x1b[32mpreserved\x1b[0m" : "\x1b[31mLOST\x1b[0m"}`);
  check(enabledOk, "presets: disabled layer was re-enabled");

  const mask = createLayer("mask");
  const glow = createLayer("glow");
  const imported = instantiate({
    layers: [
      { type: "mask", ref: "m" },
      { type: "glow", mods: { radius: { maskRef: "m", min: -1e12, max: 1e12 } } },
    ],
  });
  const mod = imported[1].mods.radius;
  const boundsOk = mod.min === 1 && mod.max === 200;
  console.log(`  modulation bounds      ${boundsOk ? "\x1b[32mclamped\x1b[0m" : "\x1b[31mUNBOUNDED\x1b[0m"}`);
  check(boundsOk, `presets: modulation bounds escaped schema (${mod.min}, ${mod.max})`);

  const plan = planExport(8192, 8192, 4, [mask, glow]);
  const memoryOk = plan.estimatedWorkingBytes <= MAX_WORKING_BYTES;
  console.log(`  export memory budget   ${memoryOk ? "\x1b[32mfits\x1b[0m" : "\x1b[31mEXCEEDED\x1b[0m"} (${Math.round(plan.estimatedWorkingBytes / 1024 / 1024)} MiB)`);
  check(memoryOk, "export plan exceeds working memory budget");
}

function ctxOfSize(buf) {
  return createContext({ renderW: buf.w, renderH: buf.h, ssaa: 1, seed: SEED });
}

// ------------------------------------------------------------ sample output

console.log("\n\x1b[1mSample renders\x1b[0m\n");
{
  const { BUILTIN, instantiate } = await import("./src/ui/presets.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("./out", { recursive: true });

  for (const [key, preset] of Object.entries(BUILTIN)) {
    const layers = instantiate(preset);
    const ctx = createContext({
      renderW: hiSource.w,
      renderH: hiSource.h,
      ssaa: FACTOR,
      seed: preset.seed ?? SEED,
      mode: "export",
    });
    const t = performance.now();
    const out = boxDownsample(render(layers, cloneBuf(hiSource), ctx, null), FACTOR);
    const canvas = bufToCanvas(out);
    writeFileSync(`./out/${key}.png`, canvas.toBuffer("image/png"));
    console.log(`  ${key.padEnd(18)} ${out.w}×${out.h}  ${(performance.now() - t).toFixed(0)} ms  → out/${key}.png`);
  }
}

console.log("");
if (failures.length) {
  console.error(`\n\x1b[31m${failures.length} verification failure(s):\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
