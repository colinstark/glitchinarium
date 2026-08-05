import { createBuf, sampleBilinear, EDGE_MODES } from "../buffer.js";
import { curl } from "../rng.js";

/**
 * Per-channel displacement.
 *
 *   linear  a flat offset per channel — the classic VHS/print-misregistration
 *   radial  offset grows with distance from a centre, which is what a real
 *           lens does: true chromatic aberration, zero at the optical axis
 *   curl    channels drift along a noise flow field and separate organically
 */
export default {
  id: "rgb-split",
  name: "RGB split",
  category: "glitch",
  params: [
    { key: "mode", type: "select", label: "Mode", options: ["radial", "linear", "curl"], default: "radial" },
    { key: "amount", type: "range", label: "Amount", min: 0, max: 80, step: 0.25, default: 6, unit: "u", mod: true },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 6.283, step: 0.01, default: 0, showIf: (p) => p.mode === "linear" },
    { key: "flowScale", type: "range", label: "Flow scale", min: 10, max: 600, step: 5, default: 150, unit: "u", showIf: (p) => p.mode === "curl" },
    { key: "center", type: "xy", label: "Centre", default: { x: 0.5, y: 0.5 }, showIf: (p) => p.mode === "radial" },
    { key: "rShift", type: "range", label: "Red", min: -2, max: 2, step: 0.01, default: 1 },
    { key: "gShift", type: "range", label: "Green", min: -2, max: 2, step: 0.01, default: 0 },
    { key: "bShift", type: "range", label: "Blue", min: -2, max: 2, step: 0.01, default: -1 },
    { key: "edge", type: "select", label: "Edges", options: EDGE_MODES, default: "clamp" },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const amountMod = ctx.modPx("amount", p.amount);
    const cx = p.center.x * src.w;
    const cy = p.center.y * src.h;
    const maxR = Math.hypot(src.w, src.h) / 2;
    const flowPx = Math.max(4, ctx.u(p.flowScale));
    const shifts = [p.rShift, p.gShift, p.bShift];
    const px = new Float32Array(4);
    const flow = { x: 0, y: 0 };

    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;

        const amount = amountMod.at(x, y);
        let dirX = 1;
        let dirY = 0;
        let mag = amount;
        if (p.mode === "linear") {
          dirX = Math.cos(p.angle);
          dirY = Math.sin(p.angle);
        } else if (p.mode === "radial") {
          const ex = x - cx;
          const ey = y - cy;
          const r = Math.hypot(ex, ey) || 1e-6;
          dirX = ex / r;
          dirY = ey / r;
          mag = amount * (r / maxR);
        } else {
          curl(x, y, ctx.noiseSeed, flowPx, flow);
          dirX = flow.x;
          dirY = flow.y;
        }

        for (let c = 0; c < 3; c++) {
          const k = mag * shifts[c];
          sampleBilinear(src, x + dirX * k, y + dirY * k, px, p.edge);
          d[i + c] = px[c];
        }
        d[i + 3] = src.data[i + 3];
      }
    }
    return out;
  },
};
