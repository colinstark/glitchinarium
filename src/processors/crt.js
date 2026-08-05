import { createBuf, cloneBuf, sampleBilinear, boxBlurBuf } from "../buffer.js";
import { clamp255 } from "../color.js";

/**
 * Cathode-ray tube.
 *
 * Scanlines, an aperture-grille RGB stripe, barrel distortion from the curved
 * glass, horizontal phosphor bleed and a corner vignette. Every spacing is in
 * artwork units, so the grille stays the same physical pitch at export instead
 * of collapsing into invisible one-pixel stripes.
 */
export default {
  id: "crt",
  name: "CRT",
  category: "texture",
  feature: ["scanPitch", "grillePitch"],
  params: [
    { key: "scanPitch", type: "range", label: "Scanline pitch", min: 0.5, max: 30, step: 0.1, default: 3, unit: "u" },
    { key: "scanDepth", type: "range", label: "Scanline depth", min: 0, max: 1, step: 0.01, default: 0.35, mod: true },
    {
      key: "grille",
      type: "select",
      label: "Grille",
      options: ["none", "aperture", "shadow-mask"],
      default: "aperture",
    },
    { key: "grillePitch", type: "range", label: "Grille pitch", min: 0.5, max: 20, step: 0.1, default: 2.4, unit: "u", showIf: (p) => p.grille !== "none" },
    { key: "grilleDepth", type: "range", label: "Grille depth", min: 0, max: 1, step: 0.01, default: 0.4, showIf: (p) => p.grille !== "none" },
    { key: "curve", type: "range", label: "Barrel", min: 0, max: 0.6, step: 0.01, default: 0.12 },
    { key: "bleed", type: "range", label: "Phosphor bleed", min: 0, max: 30, step: 0.5, default: 4, unit: "u" },
    { key: "vignette", type: "range", label: "Vignette", min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: "brightness", type: "range", label: "Brightness", min: 0.5, max: 2.5, step: 0.01, default: 1.25, hint: "grille and scanlines cost light — put it back" },
  ],

  apply(ctx, src, p) {
    const { w, h } = src;

    // --- barrel distortion --------------------------------------------------
    let base = src;
    if (p.curve > 0.001) {
      base = createBuf(w, h);
      const d = base.data;
      const cx = w / 2;
      const cy = h / 2;
      const norm = Math.hypot(cx, cy);
      const px = new Float32Array(4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ex = (x - cx) / norm;
          const ey = (y - cy) / norm;
          const r2 = ex * ex + ey * ey;
          const k = 1 + p.curve * r2;
          sampleBilinear(src, cx + ex * k * norm, cy + ey * k * norm, px, "clamp");
          const i = (y * w + x) * 4;
          d[i] = px[0];
          d[i + 1] = px[1];
          d[i + 2] = px[2];
          d[i + 3] = px[3];
        }
      }
    }

    // --- horizontal phosphor bleed -----------------------------------------
    const bleedPx = ctx.u(p.bleed);
    if (bleedPx >= 1) {
      base = base === src ? cloneBuf(src) : base;
      boxBlurBuf(base, bleedPx, 0, ctx);
    }

    // --- scanlines, grille, vignette ---------------------------------------
    const out = createBuf(w, h);
    const d = out.data;
    const b = base.data;
    const scan = Math.max(1, ctx.u(p.scanPitch));
    const grille = Math.max(1, ctx.u(p.grillePitch));
    const scanMod = ctx.mod("scanDepth", p.scanDepth);
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(cx, cy);

    for (let y = 0; y < h; y++) {
      // Raised-cosine rather than a hard stripe: a real beam has a soft profile
      // and a hard one aliases badly once it is downsampled at export.
      const scanPhase = (Math.cos((y / scan) * Math.PI * 2) + 1) / 2;

      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const px = x;
        const depth = scanMod.at(x, y);
        const lineK = 1 - depth * scanPhase;

        let kr = 1;
        let kg = 1;
        let kb = 1;
        if (p.grille === "aperture") {
          const phase = ((px / grille) % 1) * 3;
          const band = Math.floor(phase);
          const dim = 1 - p.grilleDepth;
          kr = band === 0 ? 1 : dim;
          kg = band === 1 ? 1 : dim;
          kb = band === 2 ? 1 : dim;
        } else if (p.grille === "shadow-mask") {
          // Staggered triads: every other row offsets by half a cell.
          const rowOffset = Math.floor(y / grille) % 2 ? 1.5 : 0;
          const band = Math.floor(((px / grille + rowOffset) % 3 + 3) % 3);
          const dim = 1 - p.grilleDepth;
          kr = band === 0 ? 1 : dim;
          kg = band === 1 ? 1 : dim;
          kb = band === 2 ? 1 : dim;
        }

        let vig = 1;
        if (p.vignette > 0) {
          const t = Math.hypot(x - cx, y - cy) / maxR;
          vig = 1 - p.vignette * t * t;
        }

        const gain = p.brightness * lineK * vig;
        d[i] = clamp255(b[i] * kr * gain);
        d[i + 1] = clamp255(b[i + 1] * kg * gain);
        d[i + 2] = clamp255(b[i + 2] * kb * gain);
        d[i + 3] = b[i + 3];
      }
    }
    return out;
  },
};
