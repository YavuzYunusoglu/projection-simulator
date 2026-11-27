import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveHomography, applyH, invertH, squareToQuad, largestInscribedRect, clipToRect, polygonArea, pointInPolygon,
} from '../js/sim/homography.js';
import { cctTint, luminance, projectionCorners, srgbToLinear, linearToSrgb } from '../js/sim/photometry.js';
import { blurSigma, minReadablePt, pixelArcmin } from '../js/sim/readability.js';
import { computeScene } from '../js/sim/scene.js';

const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);

test('homography maps the four points exactly', () => {
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const dst = [[10, 20], [310, 5], [330, 240], [-4, 210]];
  const H = solveHomography(src, dst);
  src.forEach((p, i) => { const q = applyH(H, ...p); close(q[0], dst[i][0], 1e-6); close(q[1], dst[i][1], 1e-6); });
  const Hi = invertH(H);
  dst.forEach((p, i) => { const q = applyH(Hi, ...p); close(q[0], src[i][0], 1e-9); close(q[1], src[i][1], 1e-9); });
});

test('least-squares homography recovers a known transform from noisy points', () => {
  const H0 = squareToQuad([[100, 80], [900, 60], [950, 600], [80, 640]]);
  const src = [], dst = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < 40; i++) {
    const u = (i % 8) / 7, v = Math.floor(i / 8) / 4;
    const [x, y] = applyH(H0, u, v);
    src.push([u, v]);
    dst.push([x + rnd() * 0.5, y + rnd() * 0.5]);
  }
  const H = solveHomography(src, dst);
  const [x, y] = applyH(H, 0.5, 0.5), [x0, y0] = applyH(H0, 0.5, 0.5);
  close(x, x0, 0.5); close(y, y0, 0.5);
});

test('largest inscribed rectangle of a square is the square', () => {
  const r = largestInscribedRect([[0, 0], [1, 0], [1, 1], [0, 1]], 1, 50);
  close(r.x0, 0, 1e-9); close(r.y0, 0, 1e-9); close(r.x1, 1, 1e-9); close(r.y1, 1, 1e-9);
});

test('largest inscribed rectangle inside a trapezoid stays inside', () => {
  const poly = [[0.1, 0], [0.9, 0], [1, 1], [0, 1]];
  const r = largestInscribedRect(poly, 16 / 9, 120);
  for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]) {
    assert.ok(pointInPolygon(Math.min(Math.max(x, 0.0001), 0.9999), Math.min(Math.max(y, 0.0001), 0.9999), poly) || y > 0.99 || y < 0.02);
  }
  assert.ok((r.x1 - r.x0) * (r.y1 - r.y0) > 0.75);
});

test('polygon clipping and area', () => {
  const clipped = clipToRect([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]], 0, 0, 1, 1);
  close(polygonArea(clipped), 0.25, 1e-12);
});

test('colour temperature tint: D65 is neutral, high K is blue', () => {
  cctTint(6500).forEach((v) => close(v, 1, 1e-9));
  const blue = cctTint(9000);
  assert.ok(blue[2] > blue[0]);
  close(luminance(blue), 1, 1e-9);
  const warm = cctTint(3000);
  assert.ok(warm[0] > warm[2]);
});

test('sRGB transfer functions round-trip', () => {
  for (const v of [0, 0.01, 0.2, 0.5, 0.9, 1]) close(linearToSrgb(srgbToLinear(v)), v, 1e-9);
});

const baseParams = () => ({
  room: { ambientLux: 0, ambientColor: 'daylight' },
  projector: { lumens: 3000, lampHealth: 100, contrast: 2000, colorTemp: 6500, native: 'fhd', focusMm: 0, gamma: 1, colorMatrix: null },
  screen: { width: 2, aspect: '16:9', gain: 1 },
  geometry: { scale: 1, offsetX: 0, offsetY: 0, keystoneV: 0, keystoneH: 0, rotation: 0, corners: null },
  viewer: { distance: 6, acuity: 1 },
});

test('a centred, matching projection fills the screen exactly', () => {
  const p = baseParams();
  const c = projectionCorners(p, 16 / 9);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach((q, i) => { close(c[i][0], q[0], 1e-9); close(c[i][1], q[1], 1e-9); });
  const s = computeScene(p, 1920, 1080);
  close(s.visibleFrac, 1, 1e-9);
  close(s.cuts.right, 0, 0.01);
  // 3000 lm * 0.88 over 2 m × 1.125 m
  close(s.light.Epw, (3000 * 0.88) / 2.25, 1e-6);
  close(s.light.effContrast, 2000, 1e-6);
});

test('ambient light lowers the effective contrast', () => {
  const p = baseParams();
  p.room.ambientLux = 300;
  const s = computeScene(p, 1920, 1080);
  const Epw = (3000 * 0.88) / 2.25;
  close(s.light.effContrast, (Epw + 300) / (Epw / 2000 + 300), 1e-9);
  assert.ok(s.light.effContrast < 5);
});

test('shifting the image right cuts the right side of the slide', () => {
  const p = baseParams();
  p.geometry.offsetX = 0.1;
  const s = computeScene(p, 1920, 1080);
  close(s.cuts.right, 0.1, 0.012);
  close(s.cuts.left, 0, 0.01);
  close(s.visibleFrac, 0.9, 1e-6);
});

test('viewing distance blur and minimum font size grow with distance', () => {
  const near = blurSigma({ projWidthM: 2, slideWidthPx: 1920, distanceM: 3, acuity: 1, nativeWidthPx: 1920, focusMm: 0 });
  const far = blurSigma({ projWidthM: 2, slideWidthPx: 1920, distanceM: 12, acuity: 1, nativeWidthPx: 1920, focusMm: 0 });
  assert.ok(far.sigma > near.sigma * 3.5);
  close(pixelArcmin(2, 1920, 6), (2 * Math.atan(2 / 1920 / 12)) / (Math.PI / 10800), 1e-9);
  const a = minReadablePt({ projHeightM: 1.125, distanceM: 6, acuity: 1, effContrast: 10 });
  const b = minReadablePt({ projHeightM: 1.125, distanceM: 12, acuity: 1, effContrast: 10 });
  close(b / a, 2, 0.01);
  assert.ok(a > 15 && a < 40);
});

test('projected onto a wall nothing is cut off, a desk in front hides the bottom', () => {
  const p = baseParams();
  p.geometry.offsetX = 0.2; // would spill over a screen
  p.room = { ambientLux: 0, ambientColor: 'daylight', layout: { surface: 'wall', board: 'none', window: 'none', desk: 'none' } };
  let s = computeScene(p, 1920, 1080);
  close(s.visibleFrac, 1, 1e-9);
  close(s.cuts.right, 0, 0.01);
  // lower the picture behind a tall desk
  p.geometry.offsetY = 0.6;
  p.room.layout.desk = 'high';
  s = computeScene(p, 1920, 1080);
  assert.ok(s.visibleFrac < 0.95, `visible ${s.visibleFrac}`);
  assert.ok(s.cuts.bottom > 0.05, `bottom cut ${s.cuts.bottom}`);
  assert.equal(s.isVisible(0.5, 0.98), false);
  assert.equal(s.isVisible(0.5, 0.1), true);
});

test('saturation matrix keeps luminance and greys; simulated white is the reference', async () => {
  const { projectorMatrix, simulateColor } = await import('../js/sim/photometry.js');
  const M = projectorMatrix([1, 1, 1], 0.5);
  const apply = (v) => [0, 1, 2].map((r) => M[r * 3] * v[0] + M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2]);
  const red = apply([1, 0, 0]);
  close(luminance(red), 0.2126, 1e-9);
  assert.ok(red[1] > 0 && red[0] < 1);
  apply([0.4, 0.4, 0.4]).forEach((v) => close(v, 0.4, 1e-9));
  const env = { proj: projectorMatrix([1, 1, 1], 1), gamma: 1, Epw: 800, Epb: 0.4, Ea: 200, ambCol: [1, 1, 1] };
  simulateColor([1, 1, 1], env).forEach((v) => close(v, 1, 1e-9));
  simulateColor([0, 0, 0], env).forEach((v) => close(v, 200.4 / 1000, 1e-9));
});
