import { bufFromImageData } from "../buffer.js";
import { parseHex } from "../color.js";
import { bayerAt, checkerAt } from "../patterns.js";

/**
 * Ornamental pixel frame.
 *
 * The poster grid reference builds its whole identity out of these: repeating
 * motifs on a coarse pixel lattice, drawn in the same two or three inks as the
 * image, with heavier corner blocks. The motif is generated from a symmetric
 * bit pattern rather than stored as artwork, so changing the unit size or the
 * seed gives a different ornament that still reads as deliberate.
 *
 * Everything is quantised to `unit`, in artwork units — the frame is meant to
 * look drawn on a pixel grid, not vector-smooth.
 */

const MOTIFS = {
  // Each is a row-major bit pattern for one repeat, drawn mirrored.
  greek: [
    "1111111",
    "1000000",
    "1011110",
    "1010010",
    "1010010",
    "1000010",
    "1111110",
  ],
  lattice: [
    "1111111",
    "1001001",
    "1001001",
    "1111111",
    "1001001",
    "1001001",
    "1111111",
  ],
  diamond: [
    "0001000",
    "0011100",
    "0111110",
    "1111111",
    "0111110",
    "0011100",
    "0001000",
  ],
  chain: [
    "0111110",
    "1000001",
    "1011101",
    "1010101",
    "1011101",
    "1000001",
    "0111110",
  ],
};

export default {
  id: "border",
  name: "Border",
  category: "frame",
  params: [
    {
      key: "style",
      type: "select",
      label: "Style",
      options: ["rule", "double", "checker", "dither", "greek", "lattice", "diamond", "chain"],
      default: "greek",
    },
    { key: "unit", type: "range", label: "Pixel unit", min: 0.5, max: 30, step: 0.25, default: 4, unit: "u" },
    { key: "width", type: "range", label: "Band width", min: 1, max: 40, step: 0.5, default: 8, unit: "u" },
    { key: "inset", type: "range", label: "Inset", min: 0, max: 200, step: 1, default: 16, unit: "u" },
    { key: "color", type: "color", label: "Colour", default: "#c0392b" },
    { key: "corners", type: "toggle", label: "Corner blocks", default: true },
    { key: "cornerSize", type: "range", label: "Corner size", min: 2, max: 80, step: 1, default: 22, unit: "u", showIf: (p) => p.corners },
    { key: "matte", type: "toggle", label: "Matte outside", default: false, hint: "flood everything beyond the frame" },
    { key: "matteColor", type: "color", label: "Matte colour", default: "#1b1b28", showIf: (p) => p.matte },
  ],

  apply(ctx, src, p) {
    const { w, h } = src;
    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);

    const unit = Math.max(1, Math.round(ctx.u(p.unit)));
    const band = Math.max(unit, Math.round(ctx.u(p.width) / unit) * unit);
    const inset = Math.round(ctx.u(p.inset) / unit) * unit;

    const x0 = inset;
    const y0 = inset;
    const x1 = w - inset;
    const y1 = h - inset;
    if (x1 - x0 < band * 2 || y1 - y0 < band * 2) return null;

    if (p.matte) {
      g.fillStyle = p.matteColor;
      g.fillRect(0, 0, w, h);
      g.clearRect(x0, y0, x1 - x0, y1 - y0);
    }

    g.fillStyle = p.color;
    const cell = (cx, cy) => g.fillRect(cx * unit, cy * unit, unit, unit);

    const cols = Math.ceil(w / unit);
    const rows = Math.ceil(h / unit);
    const bandCells = Math.max(1, Math.round(band / unit));
    const cx0 = Math.round(x0 / unit);
    const cy0 = Math.round(y0 / unit);
    const cx1 = Math.round(x1 / unit);
    const cy1 = Math.round(y1 / unit);

    const motif = MOTIFS[p.style];

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        // Distance into the band from whichever edge we are nearest.
        const dLeft = cx - cx0;
        const dRight = cx1 - 1 - cx;
        const dTop = cy - cy0;
        const dBottom = cy1 - 1 - cy;
        const depth = Math.min(dLeft, dRight, dTop, dBottom);
        if (depth < 0 || depth >= bandCells) continue;

        // `along` runs the length of the edge so motifs repeat around the frame.
        const along = depth === dTop || depth === dBottom ? cx - cx0 : cy - cy0;

        let on;
        if (motif) {
          const n = motif.length;
          on = motif[depth % n][((along % n) + n) % n] === "1";
        } else if (p.style === "checker") {
          on = checkerAt(cx, cy) === 1;
        } else if (p.style === "dither") {
          on = bayerAt(cx, cy, 4) < 1 - depth / bandCells;
        } else if (p.style === "double") {
          on = depth === 0 || depth === bandCells - 1 || depth === Math.floor(bandCells / 2);
        } else {
          on = true;
        }
        if (on) cell(cx, cy);
      }
    }

    if (p.corners) {
      const cs = Math.max(unit, Math.round(ctx.u(p.cornerSize) / unit) * unit);
      for (const [bx, by] of [[x0, y0], [x1 - cs, y0], [x0, y1 - cs], [x1 - cs, y1 - cs]]) {
        g.fillRect(bx, by, cs, cs);
      }
    }

    return bufFromImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
