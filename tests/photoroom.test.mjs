import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSmooth, whiteMask } from '../js/calib/photoroom.js';

test('white map fit follows a smooth fall-off and ignores an outlier blob', () => {
  const truth = (u, v) => 0.8 - 0.15 * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 4;
  const samples = [];
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 25; j++) {
      const u = i / 40, v = j / 25;
      let y = truth(u, v);
      if (u < 0.12 && v < 0.12) y = 0.2; // e.g. a browser's close button over the pattern
      samples.push({ u, v, rgb: [y, y, y] });
    }
  }
  const f = fitSmooth(samples);
  for (const [u, v] of [[0.5, 0.5], [0.2, 0.8], [0.9, 0.1], [0.05, 0.05]]) {
    assert.ok(Math.abs(f(u, v)[1] - truth(u, v)) < 0.03, `${u},${v}: ${f(u, v)[1]} vs ${truth(u, v)}`);
  }
});

test('white mask excludes markers, patches and the text block', () => {
  const m = whiteMask(16 / 9);
  assert.equal(m(0.5, 0.25), true);    // white band under the top-centre marker
  assert.equal(m(0.5, 0.35), false);   // grey ramp
  assert.equal(m(0.07, 0.15), false);  // top-left marker
  assert.equal(m(0.17, 0.5), true);    // left white column
});
