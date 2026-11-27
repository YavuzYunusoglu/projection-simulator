// Derives everything the renderer and the UI need from the parameter set.
import {
  solveHomography, invertH, applyH, polygonArea, clipToRect, largestInscribedRect, pointInPolygon,
} from './homography.js';
import { projectionCorners, computeLighting, screenSize, NATIVE_RES } from './photometry.js';
import { blurSigma, minReadablePt } from './readability.js';
import { roomLayout } from './room.js';

const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function computeScene(params, slideW = 1920, slideH = 1080, apl = 0.5) {
  const aspect = slideW / slideH;
  const { w: sw, h: sh } = screenSize(params);
  const cornersN = projectionCorners(params, aspect);
  // to wall metres, origin at screen centre, y down
  const cornersM = cornersN.map(([u, v]) => [(u - 0.5) * sw, (v - 0.5) * sh]);
  const H = solveHomography(UNIT, cornersM); // slide uv -> wall metres
  const Hinv = invertH(H);
  const area = polygonArea(cornersM);
  const light = computeLighting(params, cornersM, area, apl);

  // Projected width/height (average of opposite edges)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const projW = (dist(cornersM[0], cornersM[1]) + dist(cornersM[3], cornersM[2])) / 2;
  const projH = (dist(cornersM[0], cornersM[3]) + dist(cornersM[1], cornersM[2])) / 2;

  // Visible part of the slide: screen rectangle pulled back into slide uv, clipped to the slide.
  // Projected straight onto a wall there is no screen edge: the whole picture lands.
  const layout = (params.room && params.room.layout) || {};
  const room = roomLayout(sw, sh, layout);
  const onWall = layout.surface === 'wall';
  const screenM = [[-sw / 2, -sh / 2], [sw / 2, -sh / 2], [sw / 2, sh / 2], [-sw / 2, sh / 2]];
  const screenUv = Hinv ? screenM.map(([x, y]) => applyH(Hinv, x, y)) : [];
  const visible = onWall ? [[0, 0], [1, 0], [1, 1], [0, 1]] : clipToRect(screenUv, 0, 0, 1, 1);
  // a desk in front hides the part of the picture behind it
  const occluders = [];
  if (Hinv && room.desk[0] < 1e3) {
    const [x0, y0, x1, y1] = room.desk;
    const q = clipToRect([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => applyH(Hinv, x, y)), 0, 0, 1, 1);
    if (q.length >= 3 && polygonArea(q) > 1e-4) occluders.push(q);
  }
  const isVisible = (u, v) => pointInPolygon(u, v, visible) && !occluders.some((q) => pointInPolygon(u, v, q));
  let visibleFrac = 0;
  if (visible.length >= 3) {
    visibleFrac = polygonArea(visible);
    for (const q of occluders) visibleFrac -= polygonArea(clipPoly(q, visible));
  }
  const safe = largestInscribedRect(visible, aspect, 160, occluders);
  const cuts = safe
    ? { left: safe.x0, right: 1 - safe.x1, top: safe.y0, bottom: 1 - safe.y1 }
    : { left: 0, right: 0, top: 0, bottom: 0 };

  const native = NATIVE_RES[params.projector.native] || NATIVE_RES.wxga;
  // the slide is fitted into the projector's panel: this many real pixels show it
  const nativeW = Math.min(native[0], native[1] * aspect);
  const nativePx = [Math.round(nativeW), Math.round(nativeW / aspect)];
  const blur = blurSigma({
    projWidthM: projW,
    slideWidthPx: slideW,
    distanceM: params.viewer.distance,
    acuity: params.viewer.acuity,
    nativeWidthPx: nativeW,
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
    light, visible, visibleFrac: Math.max(0, visibleFrac), safe, cuts, blur, minPt, occluders, isVisible, room, onWall, nativePx,
  };
}

// Intersection of a polygon with a convex polygon (Sutherland–Hodgman, clip must be convex).
function clipPoly(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const sgn = Math.sign(side(clip[(i + 2) % clip.length])) || 1;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length];
      const ci = side(cur) * sgn >= 0, pi = side(prev) * sgn >= 0;
      const isect = () => {
        const d1 = side(prev), d2 = side(cur);
        const t = d1 / (d1 - d2);
        return [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      };
      if (ci) { if (!pi) out.push(isect()); out.push(cur); } else if (pi) out.push(isect());
    }
  }
  return out;
}
