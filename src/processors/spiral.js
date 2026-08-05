import { createBuf, sampleBilinear, EDGE_MODES } from "../buffer.js";
import { GOLDEN_ANGLE } from "../geometry.js";

/**
 * Rotational warps built on growth spirals.
 *
 *   twirl        rotation falling off with radius — the familiar whirlpool
 *   logarithmic  rotation proportional to ln(r), which is the equiangular
 *                spiral of a nautilus shell: the same shape at every scale
 *   phyllotaxis  rotation stepping by the golden angle per unit radius, so
 *                the image breaks into the interleaved arms you see in a
 *                sunflower head
 */
export default {
  id: "spiral",
  name: "Spiral",
  category: "warp",
  params: [
    {
      key: "mode",
      type: "select",
      label: "Mode",
      options: ["logarithmic", "twirl", "phyllotaxis"],
      default: "logarithmic",
    },
    { key: "strength", type: "range", label: "Strength", min: -4, max: 4, step: 0.01, default: 0.8, mod: true },
    { key: "pitch", type: "range", label: "Pitch", min: 5, max: 400, step: 1, default: 90, unit: "u", showIf: (p) => p.mode === "phyllotaxis" },
    { key: "core", type: "range", label: "Core radius", min: 0.5, max: 80, step: 0.5, default: 6, unit: "u", showIf: (p) => p.mode === "logarithmic" },
    { key: "radius", type: "range", label: "Radius", min: 0.05, max: 2, step: 0.01, default: 1 },
    { key: "center", type: "xy", label: "Centre", default: { x: 0.5, y: 0.5 } },
    { key: "falloff", type: "range", label: "Falloff", min: 0, max: 4, step: 0.05, default: 2 },
    { key: "zoom", type: "range", label: "Zoom", min: 0.2, max: 3, step: 0.01, default: 1 },
    { key: "edge", type: "select", label: "Edges", options: EDGE_MODES, default: "mirror" },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const cx = p.center.x * src.w;
    const cy = p.center.y * src.h;
    const R = (Math.hypot(src.w, src.h) / 2) * p.radius;
    const pitch = Math.max(1, ctx.u(p.pitch));
    const core = Math.max(0.5, ctx.u(p.core));
    const strengthMod = ctx.mod("strength", p.strength);
    const px = new Float32Array(4);

    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const ex = x - cx;
        const ey = y - cy;
        const r = Math.hypot(ex, ey);
        const i = (y * src.w + x) * 4;

        let a = 0;
        if (r > 1e-6) {
          const strength = strengthMod.at(x, y);
          switch (p.mode) {
            case "twirl":
              a = strength * Math.PI * Math.max(0, 1 - r / R);
              break;
            case "phyllotaxis":
              a = strength * GOLDEN_ANGLE * (r / pitch);
              break;
            default:
              // ln(r) rotation: constant angle between the radius vector and
              // the curve, i.e. self-similar under scaling. `core` MUST be in
              // artwork units — a raw pixel constant here silently rotates the
              // export four times harder than the preview.
              a = strength * Math.log(1 + r / core);
          }
          if (p.falloff > 0) a *= Math.pow(Math.max(0, 1 - Math.min(1, r / R)), p.falloff);
        }

        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const z = 1 / p.zoom;
        const sx = cx + (ex * cos - ey * sin) * z;
        const sy = cy + (ex * sin + ey * cos) * z;

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
