import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patternLayout, bitAt, MARKER_GRID } from '../js/calib/pattern.js';
import { detectMarkers, patternHomography, estimateScreenInPattern, fitPatternAspect } from '../js/calib/detect.js';
import { squareToQuad, solveHomography, invertH, applyH } from '../js/sim/homography.js';

// Value of the test pattern at pattern uv (0..1).
function patternValue(L, aspect, u, v) {
  for (const mk of L.markers) {
    if (u >= mk.x && u < mk.x + mk.w && v >= mk.y && v < mk.y + mk.h) {
      const c = Math.floor(((u - mk.x) / mk.w) * MARKER_GRID), r = Math.floor(((v - mk.y) / mk.h) * MARKER_GRID);
      if (r === 0 || c === 0 || r === MARKER_GRID - 1 || c === MARKER_GRID - 1) return 0;
      return bitAt(mk.code, r - 1, c - 1) ? 1 : 0;
    }
  }
  for (const p of [...L.grays, ...L.colors]) {
    if (u >= p.x && u < p.x + p.w && v >= p.y && v < p.y + p.h) return 0.299 * p.rgb[0] + 0.587 * p.rgb[1] + 0.114 * p.rgb[2];
  }
  return 1;
}

/** Render a fake camera photo of the pattern projected through `H` (pattern uv -> px). */
function fakePhoto(W, Hh, H, aspect, screenPx, opts = {}) {
  const L = patternLayout(aspect);
  const Hi = invertH(H);
  const frame = opts.frame || 0; // projector picture larger than the content (pillarbox), in uv
  const g = new Float32Array(W * Hh);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      let albedo = 0.6;
      if (screenPx) {
        const onScreen = x >= screenPx[0] && x <= screenPx[2] && y >= screenPx[1] && y <= screenPx[3];
        const border = !onScreen && x >= screenPx[0] - 12 && x <= screenPx[2] + 12 && y >= screenPx[1] - 12 && y <= screenPx[3] + 12;
        albedo = onScreen ? 0.95 : border ? 0.05 : 0.6;
      }
      const [u, v] = applyH(Hi, x + 0.5, y + 0.5);
      let light = 0.18; // ambient
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) light += 0.75 * patternValue(L, aspect, u, v) + 0.01;
      else if (u >= -frame && u <= 1 + frame && v >= 0 && v <= 1) light += 0.1; // projector black bars
      g[y * W + x] = Math.min(1, albedo * light + rnd() * 0.03);
    }
  }
  return g;
}

test('detects the markers and recovers the projection corners, even with overflow', () => {
  const W = 900, Hh = 620, aspect = 16 / 9;
  const quad = [[120, 90], [800, 70], [830, 470], [100, 500]];
  const H = squareToQuad(quad);
  const g = fakePhoto(W, Hh, H, aspect, [110, 80, 760, 520]);
  const markers = detectMarkers(g, W, Hh);
  // the right-hand markers straddle the black screen border and may be lost
  assert.ok(markers.length >= 4, `found ${markers.map((m) => m.id)}`);
  const Hp = patternHomography(markers, aspect);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyH(Hp, u, v));
  corners.forEach((c, i) => {
    assert.ok(Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1]) < 6, `corner ${i}: ${c} vs ${quad[i]}`);
  });
  // the screen's right edge (x=760 px) is inside the projection: it should be found
  const scr = estimateScreenInPattern(g, W, Hh, Hp, aspect);
  assert.equal(scr.surface, 'screen');
  assert.ok(scr.found.right);
  const right = applyH(Hp, scr.corners[1][0], 0.25)[0];
  assert.ok(Math.abs(right - 760) < 25, `screen right edge ${right}`);
});

test('detects markers in an upside-down photo and keeps the corner order', () => {
  const W = 800, Hh = 560, aspect = 16 / 9;
  // pattern TL appears at the bottom-right of the photo
  const quad = [[720, 480], [80, 470], [90, 90], [700, 100]];
  const H = squareToQuad(quad);
  const g = fakePhoto(W, Hh, H, aspect, [0, 0, W, Hh]);
  const markers = detectMarkers(g, W, Hh);
  assert.ok(markers.length >= 3, `found ${markers.length}`);
  const Hp = patternHomography(markers, aspect);
  const c0 = applyH(Hp, 0, 0);
  assert.ok(Math.hypot(c0[0] - 720, c0[1] - 480) < 8, `TL ${c0}`);
});

for (const aspect of [1.44, 1.6]) {
  test(`finds the pattern aspect (${aspect}) and corners from the markers`, () => {
    const W = 1000, Hh = 700;
    const quad = [[230, 150], [790, 140], [800, 540], [220, 555]];
    const H = squareToQuad(quad);
    const g = fakePhoto(W, Hh, H, aspect, null, { frame: 0.12 });
    const found = detectMarkers(g, W, Hh);
    const fit = fitPatternAspect(g, W, Hh, found);
    assert.ok(fit, 'no fit');
    assert.ok(Math.abs(fit.aspect - aspect) < 0.03, `aspect ${fit.aspect}`);
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
      const c = applyH(fit.H, u, v);
      assert.ok(Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1]) < 6, `corner ${i}: ${c} vs ${quad[i]}`);
    });
  });
}

test('projection on a plain wall with black bars is not mistaken for a screen', () => {
  const W = 1000, Hh = 700, aspect = 1.44;
  const quad = [[230, 150], [790, 140], [800, 540], [220, 555]];
  const H = squareToQuad(quad);
  const g = fakePhoto(W, Hh, H, aspect, null, { frame: 0.15 });
  const fit = fitPatternAspect(g, W, Hh, detectMarkers(g, W, Hh));
  const scr = estimateScreenInPattern(g, W, Hh, fit.H, fit.aspect);
  assert.equal(scr.surface, 'wall', JSON.stringify(scr.found));
});

test('a screen larger than the picture is found by its black border', () => {
  const W = 1000, Hh = 700, aspect = 16 / 9;
  const quad = [[300, 220], [700, 215], [705, 445], [295, 450]];
  const H = squareToQuad(quad);
  const g = fakePhoto(W, Hh, H, aspect, [200, 150, 800, 520]);
  const fit = fitPatternAspect(g, W, Hh, detectMarkers(g, W, Hh), 16 / 9);
  const scr = estimateScreenInPattern(g, W, Hh, fit.H, fit.aspect);
  assert.equal(scr.surface, 'screen');
  const left = applyH(fit.H, scr.corners[0][0], 0.25)[0];
  const right = applyH(fit.H, scr.corners[1][0], 0.25)[0];
  assert.ok(Math.abs(left - 200) < 20 && Math.abs(right - 800) < 20, `edges ${left} ${right}`);
});
