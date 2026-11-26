// Which slide is on the screen in a photo? Compare small grey versions of the photo's
// projected area and each candidate slide with normalised cross-correlation, which ignores
// the washed-out brightness and contrast of a projection.
import { squareToQuad, applyH } from '../sim/homography.js';

export const MW = 64, MH = 36;

const lum = (d, k) => (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) / 255;

/** Sample the photo's quad (TL, TR, BR, BL) into a W×H grey image (box-averaged). */
export function rectifyGray(rgba, w, h, quad, W = MW, H = MH) {
  const Hq = squareToQuad(quad);
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let s = 0, n = 0;
      for (const [du, dv] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [x, y] = applyH(Hq, (i + du) / W, (j + dv) / H);
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        s += lum(rgba, (yi * w + xi) * 4); n++;
      }
      out[j * W + i] = n ? s / n : NaN;
    }
  }
  return out;
}

/** Grey W×H version of an image (RGBA bytes already scaled to W×H). */
export function grayFromRGBA(rgba, W = MW, H = MH) {
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = lum(rgba, i * 4);
  return out;
}

/** Normalised cross-correlation in [0, 1] (negative correlation counts as no match). */
export function matchScore(a, b) {
  let n = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) { ma += a[i]; mb += b[i]; n++; }
  if (n < 20) return 0;
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    if (isNaN(a[i]) || isNaN(b[i])) continue;
    const x = a[i] - ma, y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  if (saa < 1e-6 || sbb < 1e-6) return 0;
  return Math.max(0, sab / Math.sqrt(saa * sbb));
}

/** Browser helper: grey thumbnail of a canvas/image source. */
export function grayOfSource(src, W = MW, H = MH) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, W, H);
  return grayFromRGBA(g.getImageData(0, 0, W, H).data, W, H);
}
