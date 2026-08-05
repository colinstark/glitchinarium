# Glitchinarium

A browser tool for turning a photograph into glitch/ASCII artwork through a stack of
intermingle-able processors, exportable at 1×/2×/4×.

```sh
bun install
bun dev        # http://localhost:3000
bun build      # static site → dist/ (what GitHub Pages deploys)
bun verify     # headless engine checks + sample renders into out/
```

Pushes to `main` build `dist/` and deploy to **GitHub Pages**
(`https://colinstark.github.io/glitchinarium/`). One-time setup: repo
**Settings → Pages → Source: GitHub Actions**.

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

Every non-mask layer also has **blend mode**, **opacity**, and an optional **mask
binding** (stencil or inverted stencil, with feather). Params marked `∿` can be driven
by a published mask instead of a single value. Lock a param with 🔓 to keep Shuffle
from touching it.

## Processors

Grouped the same way they appear in **+ Add layer**. One-line summaries; modes and
quirks that change the look live on the layer card.

### Tone

| Layer | What it does |
| --- | --- |
| **Levels** | Exposure, contrast, gamma, saturation, optional posterize. Cheap first layer. |
| **Gradient map** | Map luma/hue/sat onto a colour ramp. Above ASCII it recolours glyphs; below, it recolours what they sample. |
| **Palette lock** | Snap every colour to a short palette (named, custom, or median-cut `auto`), with optional ordered dither so gradients survive as texture. |
| **Spot colour** | Flat press ink over a luma/hue/sat band. `Preserve tone` keeps form instead of flooding. |

### Halftone

| Layer | What it does |
| --- | --- |
| **Dither** | Block-resolution quantise (Bayer, noise, Atkinson, Floyd). Optional mask-driven **subdivide** varies chunk size across the frame. |
| **Hatch** | Marks (cross, tick, chars…) that can rotate along a curl-noise flow — engraver hatching, not a rigid grid. |
| **Screen** | True AM print screen: fixed lattice, variable **dot size**. Mono / RGB / CMYK (classic rosette angles). |
| **Weave** | Progressive stitch fills (cross, checker, basket, bayer). Dark = solid cloth, mid = open weave; supports subdivide. |

### Glyph

| Layer | What it does |
| --- | --- |
| **ASCII** | Glyph grid from tone. Placement: **grid**, **flow** (curl-aligned), or **phyllotaxis**. **Subdivide** + mask → variable-resolution cells. |
| **Edge trace** | Glyphs along contours only, rotated to the edge tangent — outlines of form, not area fill. |
| **Echo** | Offset colour copies of ink already in the stack (misregistered type/print). Keys on dark marks below it. |
| **Scatter** | Sparse blue-noise symbols (arrows, marks, brackets…), clumped by noise rather than gridded. |
| **Contour** | Topographic isolines of blurred luminance; optional filled bands. |

### Warp

| Layer | What it does |
| --- | --- |
| **Ripple** | Displacement by **concentric**, **catenary**, **hypar**, or **curl** fields (not just a sine). |
| **Spiral** | **Twirl**, **logarithmic** (equiangular), or **phyllotaxis** (golden-angle) rotation. |
| **Kaleido / Tile** | Radial folds, square/hex mirror tiles, or **trencadís** Voronoi shards with grout. |

### Glitch

| Layer | What it does |
| --- | --- |
| **Pixel sort** | Sort runs by luma/etc. Directions: axis, angle, or **flow** (streaks follow curl noise). |
| **RGB split** | Per-channel offset: **linear**, **radial** (lens-like), or **curl**. |
| **Datamosh** | Codec failure: smear, blocks, real 8×8 DCT, or rowshift. Can **emit a mask** of disturbed regions for layers above. |
| **Scanline smear** | Hold-last-sample horizontal stretch — sync loss, not block drag. |
| **Region echo** | Copy-paste rectangles (optional staircase edges + keyline). Count is seed-stable across sizes. |
| **Block corruption** | Macroblocks of flat saturated colour in noise clusters, with sideways colour runs. |
| **Crystal glass** | Irregular glass-brick tessellation, posterised fills, hold streaks, sparks, optional half-frame seam. |
| **Detection** | Fake vision boxes on detail maxima (overlay, not a mask). |

### Texture

| Layer | What it does |
| --- | --- |
| **Grain** | Substrate: paper, canvas, riso, film, dust. Modulates rather than paints over — put high in the stack for “object, not filter.” |
| **Glow** | Thresholded bloom: only highlights blur and add back, so edges stay hard. |
| **CRT** | Scanlines, RGB grille, barrel, phosphor bleed, vignette — all spacings in artwork units. |

### Frame

| Layer | What it does |
| --- | --- |
| **Border** | Ornamental pixel lattice frame (motif from seed + unit size), corner blocks, optional outer matte. |

### Mask

| Layer | What it does |
| --- | --- |
| **Mask** | Publishes a grayscale field named like `L3` for stencils and `∿` modulation. Sources include luma, edges, saliency, noise, flow, voronoi, shapes, chroma key, and the **paint** brush. **Edge style** / **tear** define the boundary more than the source does. |

Stack order is composition: top of the list runs first. Masks must sit **above** the processors that use them. Randomize scopes (Tone / Halftone / …) match these categories.

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
