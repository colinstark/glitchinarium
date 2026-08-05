import { createBuf } from "../buffer.js";
import { luma, parseHex, clamp255 } from "../color.js";
import { noise2, fbm } from "../rng.js";

/**
 * Substrate texture — paper, canvas weave, riso grain, film stock, dust.
 *
 * This is the most universal element in the reference work and the easiest to
 * underrate: every one of those images sits on a physical surface, and it is
 * the surface far more than the effects that makes them read as objects rather
 * than as filters applied to a photo. Put this at the top of the stack.
 *
 * The texture modulates the image rather than painting over it, so the layer's
 * own opacity behaves the way you expect and `strength` can be modulated by a
 * mask for uneven, worn-in ageing.
 */
export default {
  id: "grain",
  name: "Grain",
  category: "texture",
  feature: ["scale"],
  params: [
    {
      key: "type",
      type: "select",
      label: "Surface",
      options: ["paper", "canvas", "riso", "film", "dust", "fibre"],
      default: "paper",
    },
    { key: "scale", type: "range", label: "Scale", min: 0.2, max: 40, step: 0.1, default: 1.4, unit: "u" },
    { key: "strength", type: "range", label: "Strength", min: 0, max: 1, step: 0.01, default: 0.35, mod: true },
    { key: "contrast", type: "range", label: "Contrast", min: 0.2, max: 4, step: 0.05, default: 1 },
    { key: "shadowBias", type: "range", label: "Shadow bias", min: -1, max: 1, step: 0.01, default: 0, hint: "push grain into the darks or the lights" },
    { key: "tint", type: "color", label: "Tint", default: "#f4f1e8" },
    { key: "tintAmount", type: "range", label: "Tint amount", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "colorNoise", type: "toggle", label: "Colour noise", default: false },
  ],

  apply(ctx, src, p) {
    const out = createBuf(src.w, src.h);
    const s = src.data;
    const d = out.data;
    const sc = Math.max(0.15, ctx.u(p.scale));
    const strengthMod = ctx.mod("strength", p.strength);
    const seed = ctx.noiseSeed;
    const [tr, tg, tb] = parseHex(p.tint);

    for (let y = 0, i = 0, px = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++, i += 4, px++) {
        const nx = x / sc;
        const ny = y / sc;
        let g;

        switch (p.type) {
          case "canvas": {
            // Woven cloth: two out-of-phase thread sets, each wobbled by noise
            // so the weave never looks machine-perfect.
            const wobbleX = noise2(nx * 0.1, ny * 0.1, seed) * 0.6;
            const wobbleY = noise2(nx * 0.1, ny * 0.1, seed + 41) * 0.6;
            const warp = Math.sin((nx + wobbleX) * Math.PI);
            const weft = Math.sin((ny + wobbleY) * Math.PI);
            g = (warp * weft * 0.5 + 0.5) * 0.7 + noise2(nx * 2, ny * 2, seed + 7) * 0.3;
            break;
          }
          case "riso": {
            // Coarse, blotchy, slightly clumped — screen-print ink on absorbent
            // stock rather than fine photographic grain.
            g = fbm(nx * 0.55, ny * 0.55, seed, 3, 2.4, 0.65);
            g = g * 0.75 + noise2(nx * 3.1, ny * 3.1, seed + 13) * 0.25;
            break;
          }
          case "film":
            g = noise2(nx * 4.2, ny * 4.2, seed) * 0.6 + noise2(nx * 9.7, ny * 9.7, seed + 3) * 0.4;
            break;
          case "dust": {
            // Sparse specks: threshold a high-frequency field so most of the
            // image is untouched and a few points are hard flecks.
            const n = noise2(nx * 6, ny * 6, seed);
            const hair = noise2(nx * 0.4, ny * 12, seed + 91);
            g = n > 0.86 ? 0 : hair > 0.93 ? 0.1 : 0.5;
            break;
          }
          case "fibre": {
            // Long thin fibres suspended in the sheet.
            const a = noise2(nx * 0.25, ny * 0.25, seed) * Math.PI;
            const u = nx * Math.cos(a) + ny * Math.sin(a);
            g = noise2(u * 5, (nx * -Math.sin(a) + ny * Math.cos(a)) * 0.35, seed + 5);
            break;
          }
          default:
            g = fbm(nx, ny, seed, 4) * 0.7 + noise2(nx * 5, ny * 5, seed + 17) * 0.3;
        }

        // Centre on zero and shape the contrast.
        let dev = (g - 0.5) * 2;
        dev = Math.sign(dev) * Math.pow(Math.abs(dev), 1 / p.contrast);

        const l = luma(s[i], s[i + 1], s[i + 2]) / 255;
        // Real grain is not uniform across the tonal range — film shows it in
        // the midtones and shadows, print shows it where the ink is thin.
        let weight = 1;
        if (p.shadowBias > 0) weight = 1 - p.shadowBias * l;
        else if (p.shadowBias < 0) weight = 1 + p.shadowBias * (1 - l);

        const amt = strengthMod.atIndex(px) * weight * 90;

        for (let c = 0; c < 3; c++) {
          const jitter = p.colorNoise
            ? (noise2(nx * 6.3 + c * 37, ny * 6.3 - c * 19, seed + c * 101) - 0.5) * 2
            : 1;
          let v = s[i + c] + dev * amt * jitter;
          if (p.tintAmount > 0) {
            const t = [tr, tg, tb][c];
            v += (t - v) * p.tintAmount * Math.abs(dev) * 0.6;
          }
          d[i + c] = clamp255(v);
        }
        d[i + 3] = s[i + 3];
      }
    }
    return out;
  },
};
