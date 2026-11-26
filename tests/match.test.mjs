import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, rectifyGray } from '../js/calib/match.js';
import { fitAffine, deriveModel, validateModel } from '../js/calib/colorfit.js';

const W = 64, H = 36;
function slide(seed, dark = false) {
  // light background with a few dark "text" bars at seed-dependent places
  const g = new Float32Array(W * H).fill(dark ? 0.1 : 0.95);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 7; k++) {
    const y = Math.floor(rnd() * (H - 3)), x = Math.floor(rnd() * 30), len = 10 + Math.floor(rnd() * 25);
    for (let i = x; i < Math.min(W, x + len); i++) g[y * W + i] = g[(y + 1) * W + i] = dark ? 0.8 : 0.1;
  }
  return g;
}

test('the projected (washed-out) version of a slide matches it; another slide does not', () => {
  const a = slide(7);
  const projected = a.map((v) => 0.35 + 0.5 * v + (Math.random() - 0.5) * 0.03);
  assert.ok(matchScore(projected, a) > 0.85, 'same slide');
  assert.ok(matchScore(projected, slide(99)) < 0.35, 'other slide');
  assert.ok(matchScore(projected, slide(5, true)) < 0.35, 'dark slide');
});

test('rectifyGray reads a quad out of an RGBA image', () => {
  const w = 200, h = 120, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < 100 ? 0 : 255, k = (y * w + x) * 4;
    rgba[k] = rgba[k + 1] = rgba[k + 2] = v; rgba[k + 3] = 255;
  }
  const g = rectifyGray(rgba, w, h, [[50, 20], [150, 20], [150, 100], [50, 100]]);
  assert.ok(g[10 * W + 5] < 0.1 && g[10 * W + 60] > 0.9);
});

test('a colour fit against the wrong reference is rejected, a real one is accepted', () => {
  const inputs = [], good = [], bad = [];
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 80; i++) {
    const p = [rnd(), rnd(), rnd()];
    inputs.push(p);
    good.push(p.map((v) => 0.12 + 0.7 * v));
    bad.push([0.5 + rnd() * 0.1, 0.5 + rnd() * 0.1, 0.5 + rnd() * 0.1]); // unrelated
  }
  const lighting = { Epw: 800, Epb: 0.4 };
  const fg = fitAffine(inputs, good), fb = fitAffine(inputs, bad);
  assert.equal(validateModel(fg, deriveModel(fg, 1, lighting), lighting).ok, true);
  assert.equal(validateModel(fb, deriveModel(fb, 1, lighting), lighting).ok, false);
});
