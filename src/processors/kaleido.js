import { createBuf, sampleBilinear, EDGE_MODES } from "../buffer.js";
import { parseHex } from "../color.js";
import { jitteredPoints, pointRandom } from "../rng.js";
import { SiteGrid, hexCell, mirrorFold, kaleidoFold } from "../geometry.js";

/**
 * Symmetry and tiling.
 *
 *   radial     n-fold kaleidoscope with mirrored wedges
 *   square     mirror-tiled rectangles
 *   hex        hexagonal tiling — the Barcelona *panot*, Gaudí's paving slab
 *              that still covers Passeig de Gràcia
 *   trencadis  irregular Voronoi shards, each sampling the image at a slight
 *              rotation with a grout line between them. This is the Park Güell
 *              bench: broken tile reassembled into a surface that follows a
 *              curve no regular grid could
 */
export default {
  id: "kaleido",
  name: "Kaleido / Tile",
  category: "warp",
  params: [
    {
      key: "mode",
      type: "select",
      label: "Mode",
      options: ["radial", "square", "hex", "trencadis"],
      default: "radial",
    },
    { key: "folds", type: "range", label: "Folds", min: 2, max: 24, step: 1, default: 6, showIf: (p) => p.mode === "radial" },
    { key: "rotation", type: "range", label: "Rotation", min: 0, max: 6.283, step: 0.01, default: 0 },
    { key: "zoom", type: "range", label: "Zoom", min: 0.2, max: 4, step: 0.01, default: 1 },
    { key: "center", type: "xy", label: "Centre", default: { x: 0.5, y: 0.5 } },
    { key: "tileSize", type: "range", label: "Tile size", min: 10, max: 600, step: 2, default: 180, unit: "u", showIf: (p) => p.mode === "square" || p.mode === "hex" },
    { key: "shardSize", type: "range", label: "Shard size", min: 4, max: 200, step: 1, default: 34, unit: "u", showIf: (p) => p.mode === "trencadis" },
    { key: "shardJitter", type: "range", label: "Shard irregularity", min: 0, max: 1, step: 0.01, default: 0.85, showIf: (p) => p.mode === "trencadis" },
    { key: "shardRotate", type: "range", label: "Shard rotation", min: 0, max: 1.5, step: 0.01, default: 0.35, showIf: (p) => p.mode === "trencadis" },
    { key: "grout", type: "range", label: "Grout", min: 0, max: 12, step: 0.1, default: 1.6, unit: "u", showIf: (p) => p.mode === "trencadis" },
    { key: "groutColor", type: "color", label: "Grout colour", default: "#f4f1e8", showIf: (p) => p.mode === "trencadis" },
    { key: "edge", type: "select", label: "Edges", options: EDGE_MODES, default: "mirror" },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const cx = p.center.x * src.w;
    const cy = p.center.y * src.h;
    const z = 1 / p.zoom;
    const px = new Float32Array(4);
    const fold = { x: 0, y: 0 };
    const hex = { cx: 0, cy: 0, q: 0, r: 0 };

    // trencadís setup
    let grid = null;
    let groutPx = 0;
    let groutRGB = [0, 0, 0];
    if (p.mode === "trencadis") {
      const spacing = Math.max(2, ctx.u(p.shardSize));
      const pts = jitteredPoints(src.w + spacing, src.h + spacing, spacing, ctx.noiseSeed, p.shardJitter);
      grid = new SiteGrid(pts, src.w + spacing, src.h + spacing, spacing);
      groutPx = ctx.u(p.grout);
      groutRGB = parseHex(p.groutColor);
    }
    const near = { site: null, d1: 0, d2: 0 };

    const cos0 = Math.cos(p.rotation);
    const sin0 = Math.sin(p.rotation);
    const tile = Math.max(2, ctx.u(p.tileSize));

    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        let sx;
        let sy;
        let grouted = false;

        // Global rotate + zoom about the centre, applied before the fold so the
        // symmetry axis follows the rotation control.
        const ex = (x - cx) * z;
        const ey = (y - cy) * z;
        const rx = cx + ex * cos0 - ey * sin0;
        const ry = cy + ex * sin0 + ey * cos0;

        switch (p.mode) {
          case "square": {
            sx = mirrorFold(rx, tile);
            sy = mirrorFold(ry, tile);
            break;
          }
          case "hex": {
            hexCell(rx - cx, ry - cy, tile / 2, hex);
            // Every hex shows the same motif, taken from the image centre.
            sx = cx + (rx - cx - hex.cx);
            sy = cy + (ry - cy - hex.cy);
            break;
          }
          case "trencadis": {
            grid.nearest2(rx, ry, near);
            const site = near.site;
            if (!site) { sx = rx; sy = ry; break; }
            if (groutPx > 0 && near.d2 - near.d1 < groutPx) {
              grouted = true;
              sx = rx;
              sy = ry;
              break;
            }
            // Sample the shard's own patch of image, rotated a little — the
            // hand-broken-tile look comes from these small mismatches.
            const a = (pointRandom(site, ctx.noiseSeed) - 0.5) * p.shardRotate * Math.PI;
            const lx = rx - site.x;
            const ly = ry - site.y;
            sx = site.x + lx * Math.cos(a) - ly * Math.sin(a);
            sy = site.y + lx * Math.sin(a) + ly * Math.cos(a);
            break;
          }
          default: {
            kaleidoFold(rx, ry, cx, cy, p.folds, p.rotation, fold);
            sx = fold.x;
            sy = fold.y;
          }
        }

        if (grouted) {
          d[i] = groutRGB[0];
          d[i + 1] = groutRGB[1];
          d[i + 2] = groutRGB[2];
          d[i + 3] = 255;
          continue;
        }

        sampleBilinear(src, sx, sy, px, p.edge);
        d[i] = px[0];
        d[i + 1] = px[1];
        d[i + 2] = px[2];
        d[i + 3] = px[3];
      }
    }
    return out;
  },
};
