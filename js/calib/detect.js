// Marker detection and region estimation on photos. Pure functions over grey planes,
// so they also run under Node for tests.
import { solveHomography, squareToQuad, applyH, polygonArea } from '../sim/homography.js';
import { MARKER_CODES, MARKER_GRID, bitAt, rotateCode, patternLayout, markerCorners } from './pattern.js';

/** Grey plane (0..1) from RGBA bytes. */
export function grayPlane(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
  return g;
}

export function sampleBilinear(g, w, h, x, y) {
  x = Math.min(w - 1.001, Math.max(0, x));
  y = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

function integral(g, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

/** Dark mask by adaptive (local mean) thresholding. */
export function adaptiveDark(g, w, h, radius, k = 0.8) {
  const I = integral(g, w, h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      const mean = s / ((x1 - x0) * (y1 - y0));
      out[y * w + x] = g[y * w + x] < mean * k ? 1 : 0;
    }
  }
  return out;
}

/** Connected components with bounding boxes and extreme points. */
export function components(mask, w, h, minArea = 30) {
  const label = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = next;
    const c = { area: 0, x0: w, y0: h, x1: 0, y1: 0, sMin: Infinity, sMax: -Infinity, dMin: Infinity, dMax: -Infinity, pts: {} };
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      const s = x + y, d = x - y;
      if (s < c.sMin) { c.sMin = s; c.pts.tl = [x, y]; }
      if (s > c.sMax) { c.sMax = s; c.pts.br = [x + 1, y + 1]; }
      if (d > c.dMax) { c.dMax = d; c.pts.tr = [x + 1, y]; }
      if (d < c.dMin) { c.dMin = d; c.pts.bl = [x, y + 1]; }
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
    }
    if (c.area >= minArea) comps.push(c);
    next++;
  }
  return comps;
}

const ham = (a, b) => { let x = (a ^ b) & 0xffff, n = 0; while (x) { n += x & 1; x >>= 1; } return n; };

function decodeQuad(g, w, h, quad) {
  const H = squareToQuad(quad);
  if (!H) return null;
  const at = (u, v) => { const [x, y] = applyH(H, u, v); return sampleBilinear(g, w, h, x, y); };
  const N = MARKER_GRID;
  const cell = (r, c) => {
    // average a few points around the cell centre for robustness
    let s = 0;
    for (const [du, dv] of [[0, 0], [-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) s += at((c + 0.5 + du) / N, (r + 0.5 + dv) / N);
    return s / 5;
  };
  const border = [];
  for (let i = 0; i < N; i++) { border.push(cell(0, i), cell(N - 1, i)); if (i > 0 && i < N - 1) border.push(cell(i, 0), cell(i, N - 1)); }
  const quiet = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N, o = -0.45 / N;
    quiet.push(at(t, o), at(t, 1 - o), at(o, t), at(1 - o, t));
  }
  const black = border.reduce((a, b) => a + b, 0) / border.length;
  const white = quiet.reduce((a, b) => a + b, 0) / quiet.length;
  if (white - black < 0.08) return null;
  const thr = (black + white) / 2;
  if (border.filter((v) => v < thr).length < border.length - 2) return null;
  let code = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (cell(r + 1, c + 1) > thr) code |= 1 << (r * 4 + c);
  // match against the known ids in all rotations
  let best = null;
  MARKER_CODES.forEach((id, k) => {
    let rc = id;
    for (let rot = 0; rot < 4; rot++) {
      const d = ham(code, rc);
      if (!best || d < best.d) best = { id: k, rot, d };
      rc = rotateCode(rc);
    }
  });
  if (!best || best.d > 2) return null;
  // The image shows the design rotated `rot` times clockwise; the design's TL corner
  // therefore sits at image corner index `rot` (TL→TR→BR→BL order).
  const corners = [0, 1, 2, 3].map((i) => quad[(i + best.rot) % 4]);
  return { id: best.id, corners, errors: best.d, contrast: white - black };
}

/**
 * Find the calibration markers in a grey image.
 * @returns array of {id, corners: [TL,TR,BR,BL] in image px (design orientation)}
 */
export function detectMarkers(g, w, h) {
  const s = Math.min(w, h);
  const mask = adaptiveDark(g, w, h, Math.max(6, Math.round(s / 14)), 0.78);
  const comps = components(mask, w, h, Math.max(40, (s * 0.025) ** 2));
  const found = new Map();
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    if (bw / bh > 3.5 || bh / bw > 3.5) continue;
    if (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= w - 1 || c.y1 >= h - 1) continue;
    const quad = [c.pts.tl, c.pts.tr, c.pts.br, c.pts.bl];
    const area = polygonArea(quad);
    if (area < 50 || c.area / area < 0.3 || c.area / area > 1.05) continue;
    const m = decodeQuad(g, w, h, quad);
    if (!m) continue;
    const prev = found.get(m.id);
    if (!prev || m.errors < prev.errors || (m.errors === prev.errors && area > prev.area)) found.set(m.id, { ...m, area });
  }
  return [...found.values()];
}

/**
 * With at least two markers found, predict where the missing ones should be and try to
 * decode them there (with a small local search). Markers that touch the dark screen border
 * merge with it in the threshold image and are only found this way.
 */
export function recoverMarkers(g, w, h, markers, aspect) {
  if (markers.length < 2) return markers;
  const L = patternLayout(aspect);
  const out = [...markers];
  for (let pass = 0; pass < 2; pass++) {
    const H = patternHomography(out, aspect);
    if (!H) break;
    for (const mk of L.markers) {
      if (out.some((m) => m.id === mk.id)) continue;
      const base = markerCorners(mk).map((p) => applyH(H, ...p));
      const size = Math.hypot(base[1][0] - base[0][0], base[1][1] - base[0][1]);
      if (!(size > 8)) continue;
      let best = null;
      const step = size * 0.03;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const q = base.map(([x, y]) => [x + dx * step, y + dy * step]);
          if (q.some(([x, y]) => x < 1 || y < 1 || x > w - 2 || y > h - 2)) continue;
          const m = decodeQuad(g, w, h, q);
          if (!m || m.id !== mk.id) continue;
          const score = m.errors * 10 - m.contrast - (dx * dx + dy * dy) * 0.002;
          if (!best || score < best.score) best = { ...m, score };
        }
      }
      if (best) out.push({ ...best, recovered: true });
    }
  }
  return out;
}

/** Homography from pattern uv to image pixels using all detected marker corners. */
export function patternHomography(markers, aspect) {
  if (markers.length < 2) return null;
  const L = patternLayout(aspect);
  const src = [], dst = [];
  for (const m of markers) {
    const mk = L.markers[m.id];
    markerCorners(mk).forEach((p, i) => { src.push(p); dst.push(m.corners[i]); });
  }
  return solveHomography(src, dst);
}

/**
 * Find the pattern's aspect ratio (unknown when the pattern is shown on another device or as
 * a downloaded image) by minimising the marker reprojection error over a continuous range.
 * More markers explained beats a slightly lower residual. `hint` (e.g. the window aspect
 * when the pattern was shown in this browser) is preferred when the fit cannot tell.
 * @returns {aspect, H, markers, err} or null
 */
export function fitPatternAspect(g, w, h, found, hint = null) {
  if (found.length < 2) return null;
  const evalAt = (a) => {
    const ms = recoverMarkers(g, w, h, found, a);
    const H = patternHomography(ms, a);
    if (!H) return null;
    const L = patternLayout(a);
    let err = 0, n = 0;
    for (const m of ms) {
      markerCorners(L.markers[m.id]).forEach((p, i) => {
        const q = applyH(H, ...p);
        err += Math.hypot(q[0] - m.corners[i][0], q[1] - m.corners[i][1]);
        n++;
      });
    }
    return { aspect: a, H, markers: ms, err: err / n };
  };
  const better = (a, b) => !b || a.markers.length > b.markers.length || (a.markers.length === b.markers.length && a.err < b.err);
  let best = null;
  for (let a = 1.0; a <= 2.4001; a += 0.02) {
    const r = evalAt(a);
    if (r && better(r, best)) best = r;
  }
  if (!best) return null;
  const c = best.aspect;
  for (let a = c - 0.02; a <= c + 0.02001; a += 0.002) {
    const r = evalAt(a);
    if (r && better(r, best)) best = r;
  }
  // With few markers the residual is flat; fall back to the hint when it fits about as well.
  if (hint) {
    const r = evalAt(hint);
    if (r && r.markers.length >= best.markers.length && r.err <= best.err + 0.6) best = r;
  }
  return best;
}

/**
 * Look for the projection surface's edges along white bands of the pattern, extended past the
 * pattern on both sides. A screen edge is either a clear drop inside the projected image (the
 * picture spills onto a darker wall) or a narrow dark dip (a screen's black border) anywhere.
 * A gradual fall-off outside the picture (projector black bars, unlit wall) is not an edge.
 * @returns { corners: screen corners in pattern uv, found: {left,right,top,bottom}, surface }
 */
export function estimateScreenInPattern(g, w, h, Hpat, aspect) {
  const L = patternLayout(aspect);
  const N = 480, lo = -0.6, hi = 1.6;
  const pos = (i) => lo + ((i + 0.5) / N) * (hi - lo);
  const prof = (fn) => {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0, n = 0;
      for (let k = 0; k < 7; k++) {
        const [u, v] = fn(pos(i), k / 6);
        const [x, y] = applyH(Hpat, u, v);
        if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) continue;
        s += sampleBilinear(g, w, h, x, y); n++;
      }
      out[i] = n ? s / n : NaN;
    }
    return out;
  };
  const horiz = prof((t, k) => [t, L.bandH[0] + (L.bandH[1] - L.bandH[0]) * k]);
  const vert = prof((t, k) => [L.bandV[0] + (L.bandV[1] - L.bandV[0]) * k, t]);
  const idx = (t) => Math.round(((t - lo) / (hi - lo)) * N - 0.5);
  const win = Math.max(3, Math.round(N * 0.03 / (hi - lo)));

  const edge = (p, dir) => {
    const mid = idx(0.5);
    const ref = median(Array.from(p.slice(mid - 30, mid + 30)).filter((v) => !isNaN(v)));
    const inside = (i) => (dir > 0 ? pos(i) <= 1 : pos(i) >= 0);
    if (!ref) return null;
    for (let i = mid; i >= 0 && i < N; i += dir) {
      if (isNaN(p[i])) return null;
      // a screen is rarely much larger than the picture: don't wander off to other objects
      if (pos(i) < -0.3 || pos(i) > 1.3) return null;
      // 1) clear drop while still inside the projected picture
      if (inside(i) && p[i] < ref * 0.62) return { at: pos(i - dir * 0.5), inside: true };
      // 2) narrow dark dip (screen border), inside or outside the picture
      let before = 0, after = 0;
      for (let k = 1; k <= win * 2; k++) {
        const a = p[i - dir * k], b = p[i + dir * k];
        if (!isNaN(a)) before = Math.max(before, a);
        if (!isNaN(b) && k <= win * 4) after = Math.max(after, b);
      }
      if (before && after && p[i] < before * 0.5 && p[i] < after * 0.72) {
        // walk back to where the fall started
        let j = i;
        while (j - dir >= 0 && j - dir < N && p[j - dir] < before * 0.8) j -= dir;
        return { at: pos(j - dir * 0.5), inside: inside(j) };
      }
      if (!inside(i) && p[i] < ref * 0.12) return null; // ran into darkness: nothing more to see
    }
    return null;
  };
  const raw = { left: edge(horiz, -1), right: edge(horiz, 1), top: edge(vert, -1), bottom: edge(vert, 1) };
  // An edge inside the picture is convincing on its own (the picture spills over). An edge
  // outside it only counts when the opposite side shows one too (a frame around the picture);
  // a lone dark line above or beside the picture is usually something else (a rolled-up screen,
  // a cable channel, a door frame).
  const keep = (a, b) => (raw[a] && (raw[a].inside || (raw[b] && !raw[b].inside)) ? raw[a].at : null);
  const e = { left: keep('left', 'right'), right: keep('right', 'left'), top: keep('top', 'bottom'), bottom: keep('bottom', 'top') };
  const found = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v !== null]));
  const x0 = e.left ?? 0, x1 = e.right ?? 1, y0 = e.top ?? 0, y1 = e.bottom ?? 1;
  const any = found.left || found.right || found.top || found.bottom;
  return { corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], found, surface: any ? 'screen' : 'wall' };
}

/** Median colour (linear RGB) of the wall around the projected picture, in pattern uv rings. */
export function sampleWallColor(rgba, w, h, Hpat) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const pts = [];
  for (const u of [-0.55, -0.45, -0.38, 1.38, 1.45, 1.55]) {
    for (let v = 0.15; v <= 0.85; v += 0.1) pts.push([u, v]);
  }
  for (const v of [-0.35, -0.28]) for (let u = 0.1; u <= 0.9; u += 0.1) pts.push([u, v]);
  const rs = [], gs = [], bs = [];
  for (const [u, v] of pts) {
    const [x, y] = applyH(Hpat, u, v);
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
    const k = (yi * w + xi) * 4;
    rs.push(lin(rgba[k])); gs.push(lin(rgba[k + 1])); bs.push(lin(rgba[k + 2]));
  }
  if (rs.length < 6) return null;
  return [median(rs), median(gs), median(bs)];
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Rough quad of the brightest large region (the projected image) for arbitrary photos. */
export function brightRegionQuad(g, w, h) {
  // Otsu threshold
  const hist = new Array(64).fill(0);
  for (const v of g) hist[Math.min(63, Math.floor(v * 64))]++;
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 32;
  for (let i = 0; i < 64; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  const t = (thr + 1) / 64;
  const mask = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) mask[i] = g[i] > t ? 1 : 0;
  const comps = components(mask, w, h, (Math.min(w, h) * 0.1) ** 2);
  if (!comps.length) return null;
  comps.sort((a, b) => b.area - a.area);
  const c = comps[0];
  return [c.pts.tl, c.pts.tr, c.pts.br, c.pts.bl];
}
