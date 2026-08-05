import { bufFromImageData, createMask, blurMask } from "../buffer.js";
import { luma, parseHex } from "../color.js";

/**
 * Object-detection telemetry drawn onto the picture.
 *
 * The castle reference has literal blue bounding boxes with confidence numbers
 * scattered through it; the skater collage has a lone white detection frame.
 * It is an overlay, not a mask — the machine-vision look as decoration.
 *
 * Boxes are placed on genuine local-detail maxima with non-maximum suppression,
 * so they land on things rather than at random. Detail is measured at an
 * artwork-unit radius, which keeps the same regions winning at any render size.
 */
export default {
  id: "detection",
  name: "Detection",
  category: "glitch",
  params: [
    { key: "count", type: "range", label: "Boxes", min: 1, max: 40, step: 1, default: 8 },
    { key: "radius", type: "range", label: "Detail radius", min: 1, max: 60, step: 0.5, default: 12, unit: "u" },
    { key: "minSize", type: "range", label: "Min size", min: 0.03, max: 0.8, step: 0.01, default: 0.1 },
    { key: "maxSize", type: "range", label: "Max size", min: 0.05, max: 1, step: 0.01, default: 0.34 },
    { key: "spacing", type: "range", label: "Spread", min: 0.02, max: 0.6, step: 0.01, default: 0.14, hint: "minimum gap between box centres" },
    { key: "color", type: "color", label: "Colour", default: "#2f6fe0" },
    { key: "lineWidth", type: "range", label: "Line width", min: 0.25, max: 8, step: 0.25, default: 1, unit: "u" },
    { key: "style", type: "select", label: "Style", options: ["box", "corners", "crosshair"], default: "box" },
    { key: "labels", type: "toggle", label: "Numbers", default: true },
    { key: "labelSize", type: "range", label: "Number size", min: 3, max: 60, step: 0.5, default: 11, unit: "u" },
    { key: "scatterDigits", type: "range", label: "Loose digits", min: 0, max: 120, step: 1, default: 0, hint: "extra numerals dropped around the frame" },
    { key: "font", type: "font", label: "Font", options: ["JetBrains Mono", "IBM Plex Mono", "Press Start 2P", "monospace"], default: "JetBrains Mono" },
  ],

  apply(ctx, src, p) {
    const { w, h } = src;
    const s = src.data;

    // --- local detail, O(n) via blurred moments ---
    const m1 = createMask(w, h);
    const m2 = createMask(w, h);
    for (let i = 0, q = 0; i < m1.data.length; i++, q += 4) {
      const v = luma(s[q], s[q + 1], s[q + 2]) / 255;
      m1.data[i] = v;
      m2.data[i] = v * v;
    }
    const r = Math.max(1, ctx.u(p.radius));
    blurMask(m1, r);
    blurMask(m2, r);

    // --- candidate cells on a coarse grid, best first ---
    const gridPx = Math.max(4, r);
    const cols = Math.max(1, Math.floor(w / gridPx));
    const rows = Math.max(1, Math.floor(h / gridPx));
    const cands = [];
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x = Math.min(w - 1, Math.round((cx + 0.5) * gridPx));
        const y = Math.min(h - 1, Math.round((cy + 0.5) * gridPx));
        const i = y * w + x;
        const v = Math.sqrt(Math.max(0, m2.data[i] - m1.data[i] * m1.data[i]));
        cands.push({ x, y, v });
      }
    }
    cands.sort((a, b) => b.v - a.v);

    // Non-maximum suppression so boxes spread over the picture instead of
    // clustering on the single busiest patch.
    const minGap = p.spacing * Math.hypot(w, h);
    const picked = [];
    for (const c of cands) {
      if (picked.length >= p.count) break;
      if (picked.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < minGap)) continue;
      picked.push(c);
    }

    const canvas = ctx.glyphCanvas();
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);

    const [cr, cg, cb] = parseHex(p.color);
    g.strokeStyle = p.color;
    g.fillStyle = p.color;
    g.lineWidth = Math.max(1, ctx.u(p.lineWidth));
    const labelPx = ctx.u(p.labelSize);
    const family = /\s/.test(p.font) ? `"${p.font}", monospace` : `${p.font}, monospace`;
    g.font = `${labelPx}px ${family}`;
    g.textBaseline = "bottom";

    const minS = Math.min(p.minSize, p.maxSize);
    const maxS = Math.max(p.minSize, p.maxSize);

    for (const c of picked) {
      const bw = (minS + ctx.rng() * (maxS - minS)) * w;
      const bh = (minS + ctx.rng() * (maxS - minS)) * h;
      const x = Math.max(0, Math.min(w - bw, c.x - bw / 2));
      const y = Math.max(0, Math.min(h - bh, c.y - bh / 2));

      if (p.style === "corners") {
        const armX = bw * 0.22;
        const armY = bh * 0.22;
        g.beginPath();
        for (const [ox, oy, sx, sy] of [
          [x, y, 1, 1], [x + bw, y, -1, 1], [x, y + bh, 1, -1], [x + bw, y + bh, -1, -1],
        ]) {
          g.moveTo(ox + sx * armX, oy);
          g.lineTo(ox, oy);
          g.lineTo(ox, oy + sy * armY);
        }
        g.stroke();
      } else if (p.style === "crosshair") {
        const mx = x + bw / 2;
        const my = y + bh / 2;
        g.beginPath();
        g.moveTo(mx - bw / 2, my);
        g.lineTo(mx + bw / 2, my);
        g.moveTo(mx, my - bh / 2);
        g.lineTo(mx, my + bh / 2);
        g.stroke();
        g.strokeRect(mx - bw / 6, my - bh / 6, bw / 3, bh / 3);
      } else {
        g.strokeRect(x, y, bw, bh);
      }

      if (p.labels) {
        // Confidence-score shaped: a couple of digits, occasionally a decimal.
        const val = Math.floor(ctx.rng() * 1000);
        const text = ctx.rng() > 0.6 ? `${(val / 1000).toFixed(2)}` : `${val}`;
        g.fillText(text, x + g.lineWidth * 2, y - g.lineWidth);
      }
    }

    if (p.scatterDigits > 0) {
      g.textBaseline = "middle";
      g.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
      for (let i = 0; i < p.scatterDigits; i++) {
        const x = ctx.rng() * w;
        const y = ctx.rng() * h;
        g.fillText(String(Math.floor(ctx.rng() * 1000)), x, y);
      }
    }

    return bufFromImageData(g.getImageData(0, 0, canvas.width, canvas.height));
  },
};
