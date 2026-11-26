// Fitting a projector colour/contrast model from measured patches.
import { solveLinear } from '../sim/homography.js';
import { srgbToLinear, luminance } from '../sim/photometry.js';

/** Least-squares affine fit: measured ≈ M·input + b. Returns { M (row-major 3×3), b, r2 }. */
export function fitAffine(inputs, measured) {
  const n = inputs.length;
  const AtA = Array.from({ length: 4 }, () => new Array(4).fill(0));
  const rows = inputs.map((p) => [p[0], p[1], p[2], 1]);
  for (const r of rows) for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) AtA[i][j] += r[i] * r[j];
  // small ridge term keeps the solve stable for nearly grey-only data
  for (let i = 0; i < 3; i++) AtA[i][i] += 1e-6 * n;
  const M = [], b = [];
  let ssRes = 0, ssTot = 0;
  for (let ch = 0; ch < 3; ch++) {
    const Atb = [0, 0, 0, 0];
    rows.forEach((r, k) => { for (let i = 0; i < 4; i++) Atb[i] += r[i] * measured[k][ch]; });
    const x = solveLinear(AtA, Atb) || [1, 0, 0, 0].map((v, i) => (i === ch ? 1 : 0));
    M.push(x[0], x[1], x[2]);
    b.push(x[3]);
    const mean = measured.reduce((a, m) => a + m[ch], 0) / n;
    rows.forEach((r, k) => {
      const pred = r[0] * x[0] + r[1] * x[1] + r[2] * x[2] + x[3];
      ssRes += (measured[k][ch] - pred) ** 2;
      ssTot += (measured[k][ch] - mean) ** 2;
    });
  }
  return { M, b, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0 };
}

/** Exponent g so that normalised grey response ≈ input^g. */
export function fitGamma(inputs, lum) {
  const y0 = lum[0], y1 = lum[lum.length - 1];
  if (!(y1 - y0 > 1e-4)) return 1;
  const ys = lum.map((y) => (y - y0) / (y1 - y0));
  let best = 1, bestErr = Infinity;
  for (let g = 0.5; g <= 2.0001; g += 0.01) {
    let e = 0;
    inputs.forEach((x, i) => { e += (Math.pow(x, g) - ys[i]) ** 2; });
    if (e < bestErr) { bestErr = e; best = g; }
  }
  return Math.round(best * 100) / 100;
}

const mulM = (M, v) => [0, 1, 2].map((r) => M[r * 3] * v[0] + M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2]);

/**
 * Turn a fit into simulation parameters.
 * @param fit { M, b } in linear camera RGB
 * @param gamma projector tone exponent relative to sRGB
 * @param lighting current { Epw, Epb } from the user's lumens/geometry
 */
export function deriveModel(fit, gamma, lighting) {
  const white = mulM(fit.M, [1, 1, 1]);
  const Yw = Math.max(1e-6, luminance(white));
  const colorMatrix = fit.M.map((v) => v / Yw);
  const b = fit.b.map((v) => Math.max(0, v));
  const Yb = Math.max(1e-5, luminance(b));
  const ratio = Yb / Yw; // (black level + ambient) relative to projector white
  const effContrast = (Yw + Yb) / Yb;
  const ambientLux = Math.max(0, ratio * (lighting.Epw - lighting.Epb) - lighting.Epb);
  // ambient colour: compare the red/blue balance of the floor level with the projector white
  const q = (b[0] / Math.max(b[2], 1e-6)) / (white[0] / Math.max(white[2], 1e-6));
  const ambientColor = q > 1.25 ? 'warm' : q > 1.07 ? 'neutral' : 'daylight';
  return { colorMatrix, gamma, ambientLux: Math.round(ambientLux), ambientColor, effContrast, white, black: b };
}

export const linearize = (rgb) => rgb.map(srgbToLinear);
