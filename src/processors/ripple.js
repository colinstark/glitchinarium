import { createBuf, sampleBilinear, EDGE_MODES } from "../buffer.js";
import { curl } from "../rng.js";
import { catenary, hypar } from "../geometry.js";

/**
 * Distortion driven by natural curves rather than a plain sine.
 *
 *   concentric  expanding rings — the familiar water-drop ripple
 *   catenary    repeating hanging-chain arches. Gaudí found his arch profiles
 *               by hanging weighted strings and inverting the result; the curve
 *               has cusps where a sine has smooth turns, which reads as built
 *               rather than wobbled
 *   hypar       hyperbolic-paraboloid saddle, the doubly-ruled surface of the
 *               Sagrada Família roofs
 *   curl        displacement along a divergence-free noise field — smoke, water
 */
export default {
  id: "ripple",
  name: "Ripple",
  category: "warp",
  params: [
    {
      key: "mode",
      type: "select",
      label: "Mode",
      options: ["catenary", "concentric", "hypar", "curl"],
      default: "catenary",
    },
    { key: "amplitude", type: "range", label: "Amplitude", min: 0, max: 200, step: 0.5, default: 22, unit: "u", mod: true },
    { key: "wavelength", type: "range", label: "Wavelength", min: 4, max: 500, step: 1, default: 120, unit: "u", mod: true },
    { key: "phase", type: "range", label: "Phase", min: 0, max: 6.283, step: 0.01, default: 0 },
    { key: "sag", type: "range", label: "Chain sag", min: 0.15, max: 2, step: 0.01, default: 0.55, showIf: (p) => p.mode === "catenary" },
    { key: "angle", type: "range", label: "Angle", min: 0, max: 6.283, step: 0.01, default: 0, showIf: (p) => p.mode === "catenary" },
    { key: "twist", type: "range", label: "Twist", min: -3, max: 3, step: 0.01, default: 1, showIf: (p) => p.mode === "hypar" },
    { key: "center", type: "xy", label: "Centre", default: { x: 0.5, y: 0.5 } },
    { key: "falloff", type: "range", label: "Falloff", min: 0, max: 2, step: 0.01, default: 0 },
    { key: "edge", type: "select", label: "Edges", options: EDGE_MODES, default: "mirror" },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const d = out.data;
    const ampMod = ctx.modPx("amplitude", p.amplitude);
    const waveMod = ctx.modPx("wavelength", p.wavelength);
    const cx = p.center.x * src.w;
    const cy = p.center.y * src.h;
    const maxR = Math.hypot(src.w, src.h) / 2;
    const px = new Float32Array(4);
    const flow = { x: 0, y: 0 };
    const ca = Math.cos(p.angle);
    const sa = Math.sin(p.angle);

    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const ex = x - cx;
        const ey = y - cy;
        const amp = ampMod.at(x, y);
        const wave = Math.max(1, waveMod.at(x, y));
        let sx = x;
        let sy = y;

        switch (p.mode) {
          case "concentric": {
            const r = Math.hypot(ex, ey) || 1e-6;
            const disp = amp * Math.sin((r / wave) * Math.PI * 2 + p.phase);
            sx = x + (ex / r) * disp;
            sy = y + (ey / r) * disp;
            break;
          }
          case "catenary": {
            // Project onto the arch axis, fold into one span, evaluate the chain.
            const u = (ex * ca + ey * sa) / wave + p.phase / (Math.PI * 2);
            let f = u - Math.floor(u); // 0..1 across one arch
            const t = f * 2 - 1; // -1..1
            const disp = amp * (catenary(t, p.sag) - 0.5);
            sx = x - sa * disp;
            sy = y + ca * disp;
            break;
          }
          case "hypar": {
            const nx = ex / (src.w / 2);
            const ny = ey / (src.h / 2);
            const hz = hypar(nx, ny, p.twist);
            sx = x + amp * hz * Math.cos(p.phase);
            sy = y + amp * hz * Math.sin(p.phase + Math.PI / 2);
            break;
          }
          default: {
            curl(x, y, ctx.noiseSeed, wave, flow);
            sx = x + flow.x * amp;
            sy = y + flow.y * amp;
          }
        }

        if (p.falloff > 0) {
          const t = Math.min(1, Math.hypot(ex, ey) / maxR);
          const k = Math.pow(1 - t, p.falloff);
          sx = x + (sx - x) * k;
          sy = y + (sy - y) * k;
        }

        sampleBilinear(src, sx, sy, px, p.edge);
        const i = (y * src.w + x) * 4;
        d[i] = px[0];
        d[i + 1] = px[1];
        d[i + 2] = px[2];
        d[i + 3] = px[3];
      }
    }
    return out;
  },
};
