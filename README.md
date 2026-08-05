# Glitchinarium

A browser tool for turning a photograph into glitch/ASCII artwork through a stack of
intermingle-able processors, exportable at 1×/2×/4×.

```sh
bun install
bun dev        # http://localhost:3000
bun verify     # headless engine checks + sample renders into out/
```

## How it works

Drop an image, then build a **layer stack**. Order is the whole interface — a gradient
map above an ASCII layer recolours the glyphs, below it recolours what the glyphs
sample.

Layers come in three kinds:

- **Processors** transform the image and composite the result back (blend mode +
  opacity + optional mask).
- **Mask layers** compute a grayscale field from the image *as it is at that point in
  the stack* and publish it under a name (`L3`). Anything above can scope itself to it.
  Because masks read the live accumulator, "edges of whatever the datamosh just broke"
  is just a matter of stack order.
- **Datamosh** additionally publishes a mask of the regions it disturbed, so an ASCII
  layer can be bound to *where the image broke* rather than to a selection you drew.

## Masks do two different jobs

A mask can act as a **stencil** (where an effect applies) or as an **intensity dial**
(how hard it bites). The second is the interesting one.

Any parameter marked `∿` can be bound to a mask: black gives `min`, white gives `max`.
That is the displacement-map idea generalised — a painted gradient can drive ripple
amplitude, dither weight, sort run length, or *how coarse the ASCII is*.

Grid processors can't have a per-pixel cell size, so `subdivide` uses a quadtree
instead: start from the coarsest grid and split each cell into four wherever the mask
asks for detail. Cells still tile exactly, and you get genuinely variable-resolution
ASCII. The `gradient-ascii` preset demonstrates it.

**The brush is a mask source**, not a paint layer. You paint grey, and any processor
above binds to it. Painting intensity over a datamosh layer's `amount` scratches
corrosion in at exactly the strength you brushed. `[` `]` resize, `e` erases, `⌘Z`
undoes, `esc` finishes. Strokes are stored normalised with radii in artwork units, so a
mask painted on the preview lands identically on a 4× export.

**The edge is the signature.** `edgeStyle` breaks a mask boundary into stairs, a bayer
dissolve, a checker or a weave; `tear` displaces it along a noise flow first. Those
change the result far more than the choice of source does.

## The scale contract

This is the one invariant that matters and the one that breaks silently.

The source image defines an **artwork-unit space whose longest edge is 1000 units**.
Every processor parameter is stored in artwork units (or normalised 0..1) and converted
to pixels at use time via `ctx.u(value)`. A ~900px preview and a 6000px export therefore
describe the *same composition*; the export just resolves it with more detail.

A processor that reaches for a raw pixel count instead will produce a different artwork
at export size, and you will not find out until you export. `bun verify` renders every
processor at 1× and at 4×, downsamples the 4× result and diffs them — that is what the
"Scale contract" table is checking.

Periodic processors (`screen`, `weave`, `crt`, `dither`, `hatch`, `palette`, `grain`)
declare a `feature` param, and the harness raises it to something resolvable before
comparing. A halftone dot with a 1.9px pitch *cannot* be drawn correctly at preview
resolution no matter how the code is written — testing at the default pitch measures
Nyquist, not scale compliance, and would hide a real bug behind a number everyone
learns to ignore. At a resolvable pitch every one of them lands under 11, and `dither`
and `weave` hit 0.00.

The app warns you in the layer panel when a feature drops below ~2 preview pixels, so
you know the export will be sharper than what you are looking at.

One entry stays loose by nature: **dither** with `atkinson`/`floyd` at a fine block
size. Error diffusion is chaotic, so a hair of input difference cascades. The block grid
and tonal structure are identical; the exact speckle is not. Ordered methods are
pixel-stable.

Randomness follows from the same rule: per-pixel variation must come from **spatial**
noise sampled in artwork units, never from a sequential `rng()` call per pixel — a call
sequence produces a different pattern when the pixel count changes.

## Rendering

Preview renders at ≤900px with a **per-layer buffer cache**, so editing layer 5 of 6
only recomputes 5→end (~3.5× faster than a cold render in practice). Export re-runs the
stack from the original image at up to 4× the requested output and box-downsamples, so
even a 1× export is supersampled when the browser memory budget permits. Export uses no
cache. Its planner estimates the active stack's peak working set and reduces
supersampling, then output size, to stay within a 512 MiB ceiling.

`Crisp` on the grid processors snaps their cell to a multiple of the resolve factor so
hard edges survive the downsample instead of turning to grey.

## Notes

- p5 runs in instance mode and owns exactly one job: the canvas that displays the
  preview. All image processing is plain typed arrays — p5's per-pixel API is orders of
  magnitude too slow for a 4× export.
- `@napi-rs/canvas` is a **dev** dependency used only by `verify.js` to run the pipeline
  headlessly. It is not part of the app.
