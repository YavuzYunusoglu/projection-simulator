// Turns a calibration photo into a re-lightable picture of the real room.
//
// Inside the projected test pattern the photo shows  albedo × (ambient + projector white).
// Where the pattern is plain white we keep the photo pixel (wall texture, hot spot, objects);
// elsewhere (markers, patches, text) a smooth fit of the white areas fills in. Using the
// measured ratio r = ambient / projector, the white map is split into an ambient layer and a
// projector layer, so the room can be re-lit and any slide can be "projected" into it.
import { patternLayout } from './pattern.js';
import { squareToQuad, invertH, applyH, solveLinear } from '../sim/homography.js';

const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) { const v = i / 255; LUT[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
const enc = (v) => {
  v = Math.max(0, Math.min(1, v));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
};

export const PHOTO_MAX = 1600;

/** Is pattern uv (u, v) plain white background (away from markers, patches and text)? */
export function whiteMask(aspect) {
  const L = patternLayout(aspect);
  const mx = 0.02 / aspect, my = 0.02;
  const boxes = L.markers.map((m) => [m.x - mx, m.y - my, m.x + m.w + mx, m.y + m.h + my]);
  const g0 = L.grays[0], c5 = L.colors[L.colors.length - 1];
  boxes.push([g0.x - 0.02, g0.y - 0.02, c5.x + c5.w + 0.02, 0.8]); // patches + text block
  return (u, v) => {
    if (u < 0.015 || v < 0.015 || u > 0.985 || v > 0.985) return false;
    for (const b of boxes) if (u >= b[0] && u <= b[2] && v >= b[1] && v <= b[3]) return false;
    return true;
  };
}

const basis = (u, v) => [1, u, v, u * u, u * v, v * v];

/** Least-squares quadratic surface per channel; returns evaluate(u, v) -> [r, g, b]. */
export function fitSmooth(samples) {
  let rows = samples;
  let coef = null;
  for (let pass = 0; pass < 3; pass++) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const B = [new Array(6).fill(0), new Array(6).fill(0), new Array(6).fill(0)];
    for (const s of rows) {
      const f = basis(s.u, s.v);
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j];
        for (let c = 0; c < 3; c++) B[c][i] += f[i] * s.rgb[c];
      }
    }
    for (let i = 0; i < 6; i++) A[i][i] += 1e-6;
    coef = B.map((b) => solveLinear(A, b) || [0, 0, 0, 0, 0, 0]);
    // drop outliers (e.g. a browser's close button over the pattern) and refit
    const res = rows.map((s) => {
      const f = basis(s.u, s.v);
      const pred = f.reduce((a, x, i) => a + x * coef[1][i], 0);
      return Math.abs(s.rgb[1] - pred) / Math.max(pred, 1e-3);
    });
    const sorted = [...res].sort((a, b) => a - b);
    const lim = Math.max(0.06, sorted[Math.floor(sorted.length * 0.9)] * 1.5);
    const next = rows.filter((_, i) => res[i] <= lim);
    if (next.length === rows.length || next.length < 30) break;
    rows = next;
  }
  return (u, v) => {
    const f = basis(u, v);
    return coef.map((c) => Math.max(0, f.reduce((a, x, i) => a + x * c[i], 0)));
  };
}

/**
 * @param photo  canvas of the calibration photo
 * @param quad   pattern corners (TL, TR, BR, BL) in photo pixels
 * @param isWhite (u, v) => true where the projected content was plain white (e.g. whiteMask), or
 *                null to rely on the photo's brightness alone
 * @param ratio  (ambient + black level) / projector white range, from the colour fit
 * @returns { amb, proj: canvases (sRGB-encoded linear light), w, h, quad (scaled), Yamb, Yproj }
 */
export function buildPhotoRoom(photo, quad, isWhite, ratio) {
  const s = Math.min(1, PHOTO_MAX / Math.max(photo.width, photo.height));
  const w = Math.round(photo.width * s), h = Math.round(photo.height * s);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.drawImage(photo, 0, 0, w, h);
  const data = sg.getImageData(0, 0, w, h).data;
  const q = quad.map(([x, y]) => [x * s, y * s]);
  const H = squareToQuad(q);
  const Hi = invertH(H);
  const white = isWhite;
  const lin = (k) => [LUT[data[k]], LUT[data[k + 1]], LUT[data[k + 2]]];

  // brightness envelope: per cell of the picture, the level of its brightest pixels. Plain
  // white background sits near it; text, pictures and dark slides fall well below.
  const [x0, y0, x1, y1] = [Math.min(...q.map((p) => p[0])), Math.min(...q.map((p) => p[1])), Math.max(...q.map((p) => p[0])), Math.max(...q.map((p) => p[1]))];
  const step = Math.max(2, Math.round((x1 - x0) / 140));
  const G = 8;
  const cells = Array.from({ length: G * G }, () => []);
  const grid = [];
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, y1); y += step) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x += step) {
      const [u, v] = applyH(Hi, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const rgb = lin((y * w + x) * 4);
      const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      const c = Math.min(G - 1, Math.floor(v * G)) * G + Math.min(G - 1, Math.floor(u * G));
      cells[c].push(Y);
      grid.push({ u, v, rgb, Y, c });
    }
  }
  const cellTop = cells.map((a) => {
    if (!a.length) return Infinity;
    const s = [...a].sort((p, r) => p - r);
    return s[Math.floor(s.length * 0.95)];
  });
  const globalTop = Math.max(...cellTop.filter(Number.isFinite), 1e-4);
  const bright = (Y, c) => Y >= 0.85 * cellTop[c] && Y >= 0.35 * globalTop;
  const samples = grid.filter((s) => bright(s.Y, s.c) && (!white || white(s.u, s.v)));
  if (samples.length < 60) return { ok: false, reason: 'samples', samples: samples.length };
  const smooth = fitSmooth(samples);

  const amb = document.createElement('canvas');
  const proj = document.createElement('canvas');
  amb.width = proj.width = w;
  amb.height = proj.height = h;
  const ai = sg.createImageData(w, h), pi = sg.createImageData(w, h);
  const ka = ratio / (1 + ratio), kp = 1 / (1 + ratio);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      const [u, v] = applyH(Hi, x + 0.5, y + 0.5);
      const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
      let W;
      if (inside) {
        const f = smooth(u, v);
        W = f;
        if (!white || white(u, v)) {
          const p = lin(k);
          // keep real texture unless the pixel is far off the fit (an object or a glitch)
          if (Math.abs(p[1] - f[1]) < 0.35 * Math.max(f[1], 1e-3)) W = p;
        }
        for (let c = 0; c < 3; c++) { ai.data[k + c] = enc(W[c] * ka); pi.data[k + c] = enc(W[c] * kp); }
      } else {
        for (let c = 0; c < 3; c++) { ai.data[k + c] = data[k + c]; pi.data[k + c] = 0; }
      }
      ai.data[k + 3] = pi.data[k + 3] = 255;
    }
  }
  amb.getContext('2d').putImageData(ai, 0, 0);
  proj.getContext('2d').putImageData(pi, 0, 0);
  // reference white: median over the white samples (robust against a bad centre)
  const ys = samples.map((s) => { const f = smooth(s.u, s.v); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; }).sort((a, b) => a - b);
  const Y = ys[Math.floor(ys.length / 2)];
  const room = { amb, proj, w, h, quad: q, Yamb: Y * ka, Yproj: Y * kp, samples: samples.length };
  room.ok = roomUsable(room);
  return room;
}

/** Guard against layers that would render as a blown-out or black picture. */
export function roomUsable(r) {
  return !!r && r.Yproj > 1e-3 && r.Yamb >= 0 && r.Yamb / r.Yproj <= 5 && (r.samples === undefined || r.samples >= 60);
}
