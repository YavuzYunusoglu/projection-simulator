// Legibility analysis: compares the original slide with the simulated result tile by tile.
import { srgbToLinear } from './photometry.js';
import { pointInPolygon } from './homography.js';

const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = srgbToLinear(i / 255);

/** Relative luminance plane from RGBA bytes. */
export function lumaPlane(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = 0.2126 * LUT[rgba[j]] + 0.7152 * LUT[rgba[j + 1]] + 0.0722 * LUT[rgba[j + 2]];
  }
  return out;
}

/** 2× box downsample of an RGBA byte image. */
export function downsample2(rgba, w, h) {
  const W = w >> 1, H = h >> 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const a = ((2 * y) * w + 2 * x) * 4, b = a + 4, c = a + w * 4, d = c + 4;
      for (let k = 0; k < 4; k++) out[o + k] = (rgba[a + k] + rgba[b + k] + rgba[c + k] + rgba[d + k]) >> 2;
    }
  }
  return { data: out, w: W, h: H };
}

function percentiles(values, lo, hi) {
  const s = Float32Array.from(values).sort();
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  return [at(lo), at(hi)];
}

/**
 * @param orig  Float32 luminance of the original slide (w×h)
 * @param sim   Float32 luminance of the simulation (w×h)
 * @param visible polygon (slide uv) of the part that lands on the screen
 * @returns {tiles, cols, rows, summary}
 */
export function analyze(orig, sim, w, h, visible, tile = 20) {
  const cols = Math.floor(w / tile), rows = Math.floor(h / tile);
  const tiles = [];
  const summary = { cut: 0, contrastWarn: 0, contrastBad: 0, blurWarn: 0, blurBad: 0, content: 0 };
  const vo = [], vs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      vo.length = 0; vs.length = 0;
      let go = 0, gs = 0;
      for (let y = r * tile; y < (r + 1) * tile; y++) {
        for (let x = c * tile; x < (c + 1) * tile; x++) {
          const i = y * w + x;
          vo.push(orig[i]);
          vs.push(sim[i]);
          if (x + 1 < w && y + 1 < h) {
            go += Math.abs(orig[i + 1] - orig[i]) + Math.abs(orig[i + w] - orig[i]);
            gs += Math.abs(sim[i + 1] - sim[i]) + Math.abs(sim[i + w] - sim[i]);
          }
        }
      }
      const [o5, o95] = percentiles(vo, 0.04, 0.96);
      const oRange = o95 - o5;
      // ignore flat tiles and very low contrast decorations
      if (oRange < 0.05) continue;
      const oCR = (o95 + 0.05) / (o5 + 0.05);
      if (oCR < 1.25) continue;
      summary.content++;
      const [s5, s95] = percentiles(vs, 0.04, 0.96);
      const sRange = Math.max(s95 - s5, 1e-4);
      const sCR = (s95 + 0.05) / (s5 + 0.05);
      const sharp = (gs / sRange) / Math.max(go / oRange, 1e-4);
      const u = (c + 0.5) / cols, v = (r + 0.5) / rows;
      const t = { c, r, sev: 0, issues: [] };
      if (visible && visible.length >= 3 && !pointInPolygon(u, v, visible)) {
        t.sev = 2; t.issues.push('cut'); summary.cut++;
      } else {
        if (sCR < 1.5) { t.sev = 2; t.issues.push('contrast'); summary.contrastBad++; }
        else if (sCR < 2.0) { t.sev = Math.max(t.sev, 1); t.issues.push('contrast'); summary.contrastWarn++; }
        if (sharp < 0.33) { t.sev = 2; t.issues.push('blur'); summary.blurBad++; }
        else if (sharp < 0.55) { t.sev = Math.max(t.sev, 1); t.issues.push('blur'); summary.blurWarn++; }
      }
      t.cr = sCR;
      t.sharp = sharp;
      if (t.sev) tiles.push(t);
    }
  }
  return { tiles, cols, rows, summary };
}
