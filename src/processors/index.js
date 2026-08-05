import levels from "./levels.js";
import gradientMap from "./gradient-map.js";
import palette from "./palette.js";
import spotColor from "./spot-color.js";

import dither from "./dither.js";
import hatch from "./hatch.js";
import screen from "./screen.js";
import weave from "./weave.js";

import ascii from "./ascii.js";
import edgeTrace from "./edge-trace.js";
import glyphEcho from "./glyph-echo.js";
import symbolScatter from "./symbol-scatter.js";
import contour from "./contour.js";

import ripple from "./ripple.js";
import spiral from "./spiral.js";
import kaleido from "./kaleido.js";

import pixelSort from "./pixel-sort.js";
import rgbSplit from "./rgb-split.js";
import datamosh from "./datamosh.js";
import scanlineSmear from "./scanline-smear.js";
import regionEcho from "./region-echo.js";
import blockPalette from "./block-palette.js";
import crystalGlass from "./crystal-glass.js";
import detection from "./detection.js";

import grain from "./grain.js";
import glow from "./glow.js";
import crt from "./crt.js";

import border from "./border.js";
import mask from "./mask.js";

const list = [
  levels, gradientMap, palette, spotColor,
  dither, hatch, screen, weave,
  ascii, edgeTrace, glyphEcho, symbolScatter, contour,
  ripple, spiral, kaleido,
  pixelSort, rgbSplit, datamosh, scanlineSmear, regionEcho, blockPalette, crystalGlass, detection,
  grain, glow, crt,
  border,
  mask,
];

export const PROCESSORS = Object.fromEntries(list.map((p) => [p.id, p]));

export const CATEGORIES = [
  { id: "tone", label: "Tone" },
  { id: "halftone", label: "Halftone" },
  { id: "glyph", label: "Glyph" },
  { id: "warp", label: "Warp" },
  { id: "glitch", label: "Glitch" },
  { id: "texture", label: "Texture" },
  { id: "frame", label: "Frame" },
  { id: "mask", label: "Mask" },
];

export function processorsByCategory() {
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((p) => p.category === c.id),
  })).filter((c) => c.items.length);
}
