import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitAffine, fitGamma, deriveModel } from '../js/calib/colorfit.js';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('affine colour fit recovers a known matrix and offset', () => {
  const M = [0.8, 0.1, 0.02, 0.05, 0.85, 0.04, 0.03, 0.12, 0.95];
  const b = [0.12, 0.13, 0.16];
  const inputs = [];
  for (let i = 0; i <= 7; i++) inputs.push([i / 7, i / 7, i / 7]);
  inputs.push([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]);
  const measured = inputs.map((p) => [0, 1, 2].map((r) => M[r * 3] * p[0] + M[r * 3 + 1] * p[1] + M[r * 3 + 2] * p[2] + b[r]));
  const fit = fitAffine(inputs, measured);
  fit.M.forEach((v, i) => close(v, M[i], 1e-4));
  fit.b.forEach((v, i) => close(v, b[i], 1e-4));
  assert.ok(fit.r2 > 0.9999);
});

test('gamma fit finds the exponent of a grey ramp', () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 7);
  const ys = xs.map((x) => 0.05 + 0.8 * Math.pow(x, 1.3));
  close(fitGamma(xs, ys), 1.3, 0.011);
});

test('derived model reproduces contrast and solves the ambient light', () => {
  const fit = { M: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5], b: [0.1, 0.1, 0.1] };
  const m = deriveModel(fit, 1, { Epw: 800, Epb: 0.4 });
  close(m.effContrast, 6, 1e-6);
  // (Ea + Epb) / (Epw - Epb) = 0.2
  close(m.ambientLux, Math.round(0.2 * (800 - 0.4) - 0.4), 0.5);
  close(m.colorMatrix[0], 1, 1e-9);
});
