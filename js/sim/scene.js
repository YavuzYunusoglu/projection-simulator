// Derives everything the renderer and the UI need from the parameter set.
import {
  solveHomography, invertH, applyH, polygonArea, clipToRect, largestInscribedRect,
} from './homography.js';
import { projectionCorners, computeLighting, screenSize, NATIVE_RES } from './photometry.js';
import { blurSigma, minReadablePt } from './readability.js';

const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function computeScene(params, slideW = 1920, slideH = 1080) {
  const aspect = slideW / slideH;
  const { w: sw, h: sh } = screenSize(params);
  const cornersN = projectionCorners(params, aspect);
  // to wall metres, origin at screen centre, y down
  const cornersM = cornersN.map(([u, v]) => [(u - 0.5) * sw, (v - 0.5) * sh]);
  const H = solveHomography(UNIT, cornersM); // slide uv -> wall metres
  const Hinv = invertH(H);
  const area = polygonArea(cornersM);
  const light = computeLighting(params, cornersM, area);

  // Projected width/height (average of opposite edges)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const projW = (dist(cornersM[0], cornersM[1]) + dist(cornersM[3], cornersM[2])) / 2;
  const projH = (dist(cornersM[0], cornersM[3]) + dist(cornersM[1], cornersM[2])) / 2;

  // Visible part of the slide: screen rectangle pulled back into slide uv, clipped to the slide
  const screenM = [[-sw / 2, -sh / 2], [sw / 2, -sh / 2], [sw / 2, sh / 2], [-sw / 2, sh / 2]];
  const screenUv = Hinv ? screenM.map(([x, y]) => applyH(Hinv, x, y)) : [];
  const visible = clipToRect(screenUv, 0, 0, 1, 1);
  const visibleFrac = visible.length >= 3 ? polygonArea(visible) : 0;
  const safe = largestInscribedRect(visible, aspect, 160);
  const cuts = safe
    ? { left: safe.x0, right: 1 - safe.x1, top: safe.y0, bottom: 1 - safe.y1 }
    : { left: 0, right: 0, top: 0, bottom: 0 };

  const native = NATIVE_RES[params.projector.native] || NATIVE_RES.wxga;
  const blur = blurSigma({
    projWidthM: projW,
    slideWidthPx: slideW,
    distanceM: params.viewer.distance,
    acuity: params.viewer.acuity,
    nativeWidthPx: Math.min(native[0], native[1] * aspect),
    focusMm: params.projector.focusMm,
  });
  const minPt = minReadablePt({
    projHeightM: projH,
    distanceM: params.viewer.distance,
    acuity: params.viewer.acuity,
    effContrast: light.effContrast,
  });

  return {
    aspect, slideW, slideH, screenW: sw, screenH: sh,
    cornersN, cornersM, H, Hinv, area, projW, projH,
    light, visible, visibleFrac, safe, cuts, blur, minPt,
  };
}
