// Calibration dialog: test-pattern workflow and "any photo" workflow.
import { store } from '../state.js';
import { t, num, onLang, getLang } from '../i18n.js';
import { toast, wireDialog } from '../ui/motion.js';
import { saveProfile } from '../ui/profiles.js';
import { solveHomography, squareToQuad, applyH, pointInPolygon, polygonArea } from '../sim/homography.js';
import { computeScene } from '../sim/scene.js';
import { srgbToLinear, linearToSrgb, simulateColor, projectorMatrix } from '../sim/photometry.js';
import { drawPattern, patternLayout, GRAYS, COLORS } from './pattern.js';
import { grayPlane, detectMarkers, fitPatternAspect, estimateScreenInPattern, sampleWallColor, brightRegionQuad } from './detect.js';
import { buildPhotoRoom, whiteMask } from './photoroom.js';
import { useBuiltRoom, canvasToBlob } from '../photoview.js';
import { luminance } from '../sim/photometry.js';
import { fitAffine, fitGamma, deriveModel, validateModel } from './colorfit.js';
import { rectifyGray, matchScore, grayOfSource } from './match.js';
import { QuadEditor } from './editor.js';

const $ = (id) => document.getElementById(id);
const WORK_MAX = 2000;
const DETECT_MAX = 1100;
const ASPECT_KEY = 'projsim.patternAspect';

const st = {
  tab: 'pattern',
  photo: null,        // canvas
  photoData: null,    // ImageData of photo
  photoBlob: null,
  refCanvas: null,
  detected: null,     // { markers, aspect, quad: pattern corners in photo px (from the markers) }
  surface: 'screen',  // projection surface seen in the photo
  wallColor: null,
  applied: null,
  dlSize: 'screen',
  useCamColor: false, // apply the camera's colour cast (off: tone and contrast only)
  picks: {},          // patch index -> { p: [x, y], rgb } picked by hand
  picking: null,      // index into PICK_ORDER while picking
  matches: [],        // [{ key, name, src, score }] candidates for "which slide is in the photo"
  refKey: null,       // chosen candidate key, or 'none'
  step: 1,
};

let editor;
let deps;

async function readPhoto(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return c;
}

function thumbBlob(canvas) {
  const s = Math.min(1, 480 / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

function grayOf(canvas) {
  const s = Math.min(1, DETECT_MAX / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * s), h = Math.round(canvas.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  return { g: grayPlane(rgba, w, h), rgba, w, h, s };
}

function setStatus(text) { $('calibStatus').textContent = text || ''; }

// ---------- Pattern display ----------
function showPattern() {
  const view = $('patternView');
  const canvas = $('patternCanvas');
  view.hidden = false;
  const dpr = window.devicePixelRatio || 1;
  const paint = () => {
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    drawPattern(canvas, getLang());
    try { localStorage.setItem(ASPECT_KEY, String(canvas.width / canvas.height)); } catch { /* ignore */ }
  };
  paint();
  const close = () => {
    view.hidden = true;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', paint);
    document.removeEventListener('fullscreenchange', onFs);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('calibDlg').showModal();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const onFs = () => { if (!document.fullscreenElement) close(); };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', paint);
  view.onclick = close;
  $('calibDlg').close();
  if (view.requestFullscreen) {
    view.requestFullscreen().then(() => {
      document.addEventListener('fullscreenchange', onFs);
      setTimeout(paint, 50);
    }).catch(() => {});
  }
}

// ---------- Pattern download ----------
const DL_SIZES = [['screen'], ['1920x1080', 1920, 1080], ['1920x1200', 1920, 1200], ['1280x800', 1280, 800], ['1024x768', 1024, 768], ['2048x1536', 2048, 1536], ['2732x2048', 2732, 2048], ['custom']];
const DL_NOTE = { '2048x1536': 'iPad', '2732x2048': 'iPad Pro 12.9″' };
function screenPx() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(Math.max(screen.width, screen.height) * dpr), h = Math.round(Math.min(screen.width, screen.height) * dpr);
  return [w, h];
}
function downloadPattern() {
  let w, h;
  if (st.dlSize === 'screen') [w, h] = screenPx();
  else if (st.dlSize === 'custom') {
    w = Math.round(Number($('dlW').value)); h = Math.round(Number($('dlH').value));
    st.dlW = w; st.dlH = h;
  } else [, w, h] = DL_SIZES.find((x) => x[0] === st.dlSize);
  if (!(w >= 320 && h >= 240 && w <= 8192 && h <= 8192)) { toast(t('calib.dlBad')); return; }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawPattern(c, getLang());
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t('calib.dlName')}-${w}x${h}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// ---------- Detection ----------
function runPatternDetection() {
  const { g, rgba, w, h, s } = grayOf(st.photo);
  const found = detectMarkers(g, w, h);
  let hint = null;
  try { hint = Number(localStorage.getItem(ASPECT_KEY)) || null; } catch { /* ignore */ }
  const best = fitPatternAspect(g, w, h, found, hint);
  if (!best) {
    const q = brightRegionQuad(g, w, h);
    const proj = q ? q.map(([x, y]) => [x / s, y / s]) : defaultQuad(st.photo, 0.12);
    st.detected = null;
    st.surface = 'screen';
    editor.setQuads({ proj, screen: shrink(proj, 0.03) });
    setStatus(t('calib.notFound', { n: found.length }));
    toast(t('calib.notFound', { n: found.length }), 4200);
    return;
  }
  const proj = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyH(best.H, u, v).map((c) => c / s));
  const scr = estimateScreenInPattern(g, w, h, best.H, best.aspect);
  st.surface = scr.surface;
  st.wallColor = sampleWallColor(rgba, w, h, best.H);
  const screen = scr.corners.map(([u, v]) => applyH(best.H, u, v).map((c) => c / s));
  st.detected = { markers: best.markers.length, aspect: best.aspect, quad: proj.map((c) => [...c]) };
  editor.setQuads({ proj, screen: st.surface === 'wall' ? null : screen });
  setStatus(`${t('calib.found', { n: best.markers.length })} · ${t('calib.aspectFound', { a: num(best.aspect, 2) })}`);
}

function runPhotoGuess() {
  const { g, w, h, s } = grayOf(st.photo);
  let q = brightRegionQuad(g, w, h);
  // in a white room the brightest region can be half the photo: not a believable guess
  if (q && polygonArea(q) > 0.5 * w * h) q = null;
  const proj = q ? q.map(([x, y]) => [x / s, y / s]) : centreQuad(st.photo);
  st.detected = null;
  editor.setQuads({ proj, screen: st.surface === 'wall' ? null : shrink(proj, 0.04) });
  updateMatches(true);
  setStatus(t('calib.guessed'));
}

function centreQuad(c) {
  const a = 16 / 9;
  let qw = c.width * 0.7, qh = qw / a;
  if (qh > c.height * 0.5) { qh = c.height * 0.5; qw = qh * a; }
  const x0 = (c.width - qw) / 2, y0 = (c.height - qh) / 2;
  return [[x0, y0], [x0 + qw, y0], [x0 + qw, y0 + qh], [x0, y0 + qh]];
}

function defaultQuad(c, m) {
  return [[c.width * m, c.height * m], [c.width * (1 - m), c.height * m], [c.width * (1 - m), c.height * (1 - m)], [c.width * m, c.height * (1 - m)]];
}
function shrink(q, f) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(([x, y]) => [x + (cx - x) * f, y + (cy - y) * f]);
}

// ---------- Sampling ----------
function sampleRect(H, rect, inset = 0.25) {
  const { photoData: d, photo } = st;
  const acc = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const u = rect.x + rect.w * (inset + (1 - 2 * inset) * (i / 6));
      const v = rect.y + rect.h * (inset + (1 - 2 * inset) * (j / 6));
      const [x, y] = applyH(H, u, v);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= photo.width || yi >= photo.height) continue;
      const k = (yi * photo.width + xi) * 4;
      acc[0] += srgbToLinear(d.data[k] / 255);
      acc[1] += srgbToLinear(d.data[k + 1] / 255);
      acc[2] += srgbToLinear(d.data[k + 2] / 255);
      n++;
    }
  }
  return n ? acc.map((v) => v / n) : null;
}

// Colours are read where the markers put the pattern, not from the orange frame: the user may
// widen the frame to the projector's full picture (e.g. past a tablet's grey side bands).
function patternQuad(projQuad) {
  return st.detected && st.detected.quad ? st.detected.quad : projQuad;
}

/** White-background test in the orange frame's uv, via the detected pattern position. */
function patternWhiteIn(projQuad) {
  const L = whiteMask(st.detected ? st.detected.aspect : 16 / 9);
  const Hframe = squareToQuad(projQuad);
  const HpatInv = solveHomography(patternQuad(projQuad), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  if (!Hframe || !HpatInv) return L;
  return (u, v) => {
    const [x, y] = applyH(Hframe, u, v);
    const [pu, pv] = applyH(HpatInv, x, y);
    return L(pu, pv);
  };
}

// Fit from hand-picked patches only (black and white required).
function pickedColorFit(L) {
  const all = [...L.grays, ...L.colors];
  const idx = Object.keys(st.picks).map(Number).sort((a, b) => a - b);
  if (!st.picks[0] || !st.picks[L.grays.length - 1]) return null;
  const inputs = idx.map((i) => all[i].rgb.map(srgbToLinear));
  const measured = idx.map((i) => st.picks[i].rgb);
  const grayIdx = idx.filter((i) => i < L.grays.length);
  const gamma = grayIdx.length >= 3
    ? fitGamma(grayIdx.map((i) => srgbToLinear(GRAYS[i])), grayIdx.map((i) => luminance(st.picks[i].rgb)))
    : 1;
  const fit = fitAffine(inputs.map((v) => v.map((x) => Math.pow(x, gamma))), measured);
  // full-length arrays (by patch index) for the comparison strip
  const fullIn = all.map((p) => p.rgb.map(srgbToLinear));
  const fullMeas = all.map((_, i) => (st.picks[i] ? st.picks[i].rgb : null));
  return { fit, gamma, measured: fullMeas, inputs: fullIn, manual: true };
}

function patternColorFit(projQuad) {
  projQuad = patternQuad(projQuad);
  const aspect = st.detected ? st.detected.aspect : 16 / 9;
  const L = patternLayout(aspect);
  if (Object.keys(st.picks).length) return pickedColorFit(L);
  const H = squareToQuad(projQuad);
  const inputs = [], measured = [];
  const grayLum = [];
  L.grays.forEach((p, gi) => {
    const m = st.picks[gi] ? st.picks[gi].rgb : sampleRect(H, p);
    if (!m) return;
    inputs.push(p.rgb.map(srgbToLinear));
    measured.push(m);
    grayLum.push(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]);
  });
  if (inputs.length < L.grays.length) return null;
  const gamma = fitGamma(GRAYS.map(srgbToLinear), grayLum);
  for (const [ci, p] of L.colors.entries()) {
    const k = L.grays.length + ci;
    const m = st.picks[k] ? st.picks[k].rgb : sampleRect(H, p);
    if (!m) return null;
    inputs.push(p.rgb.map(srgbToLinear));
    measured.push(m);
  }
  const fit = fitAffine(inputs.map((v) => v.map((x) => Math.pow(x, gamma))), measured);
  return { fit, gamma, measured, inputs };
}

const MATCH_MIN = 0.35;

/** Score every loaded slide (and an uploaded screenshot) against the photo's picture. */
function updateMatches(autoPick = true) {
  const proj = editor && editor.quads.proj;
  if (!st.photo || !proj) { st.matches = []; return; }
  const photoGray = rectifyGray(st.photoData.data, st.photo.width, st.photo.height, proj);
  const cands = store.state.slides.map((s, i) => ({ key: 's' + s.id, name: `${t('slides.slide')} ${i + 1}`, src: s.thumb }));
  if (st.refCanvas) cands.push({ key: 'file', name: t('calib.refFile'), src: st.refCanvas });
  for (const c of cands) c.score = matchScore(photoGray, grayOfSource(c.src));
  cands.sort((a, b) => b.score - a.score);
  st.matches = cands;
  if (autoPick || !cands.some((c) => c.key === st.refKey)) {
    st.refKey = cands.length && cands[0].score >= MATCH_MIN ? cands[0].key : 'none';
  }
}

function currentRef() {
  const c = st.matches.find((m) => m.key === st.refKey);
  return c ? c.src : null;
}

function photoColorFit(projQuad, screenQuad) {
  const ref = currentRef();
  if (!ref) return null;
  const rw = 160, rh = Math.round((rw * ref.height) / ref.width);
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(ref, 0, 0, rw, rh);
  const rd = g.getImageData(0, 0, rw, rh).data;
  const H = squareToQuad(projQuad);
  const inputs = [], measured = [];
  for (let j = 1; j < 24; j++) {
    for (let i = 1; i < 32; i++) {
      const u = i / 32, v = j / 24;
      const [x, y] = applyH(H, u, v);
      if (!pointInPolygon(x, y, screenQuad)) continue;
      const m = sampleRect(H, { x: u - 0.004, y: v - 0.004, w: 0.008, h: 0.008 }, 0);
      if (!m) continue;
      const k = (Math.min(rh - 1, Math.floor(v * rh)) * rw + Math.min(rw - 1, Math.floor(u * rw))) * 4;
      inputs.push([rd[k], rd[k + 1], rd[k + 2]].map((x2) => srgbToLinear(x2 / 255)));
      measured.push(m);
    }
  }
  if (inputs.length < 30) return null;
  // need some spread in the reference to say anything about contrast
  const ys = inputs.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
  if (Math.max(...ys) - Math.min(...ys) < 0.3) return null;
  return { fit: fitAffine(inputs, measured), gamma: 1 };
}

// ---------- Apply ----------
async function apply() {
  const { proj, screen } = editor.quads;
  if (!proj) return;
  const onWall = st.surface === 'wall' || !screen;
  const p = JSON.parse(JSON.stringify(store.state.params));
  p.room.layout = { ...(p.room.layout || {}), surface: onWall ? 'wall' : 'screen' };
  if (onWall) {
    // no screen edge to measure against: the picture itself is the reference
    Object.assign(p.geometry, { corners: null, scale: 1, offsetX: 0, offsetY: 0, keystoneV: 0, keystoneH: 0, rotation: 0 });
  } else {
    const G = solveHomography(screen, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    if (!G) { toast(t('calib.badQuad')); return; }
    p.geometry.corners = proj.map(([x, y]) => applyH(G, x, y));
  }
  if (st.wallColor) p.room.wallColor = st.wallColor;
  const slide = store.state.slides[store.state.current];
  const sw = slide ? slide.width : 1920, sh = slide ? slide.height : 1080;
  const sc = computeScene(p, sw, sh);
  const color = st.tab === 'pattern' ? patternColorFit(proj) : photoColorFit(proj, screen || proj);
  let model = null, colorRejected = false;
  if (color) {
    model = deriveModel(color.fit, color.gamma, sc.light);
    if (!validateModel(color.fit, model, sc.light).ok) { model = null; colorRejected = true; }
  }
  if (model) {
    // phone cameras white-balance on their own: their colour cast is only used on request
    p.projector.colorMatrix = st.useCamColor ? model.colorMatrix : null;
    p.projector.gamma = model.gamma;
    p.room.ambientLux = Math.min(5000, model.ambientLux);
    p.room.ambientColor = model.ambientColor;
  }
  // re-lightable photo of the real room
  const L2 = computeScene(p, sw, sh).light;
  const clampR = (r) => Math.min(2, Math.max(0.005, r));
  const ratio = clampR(model ? luminance(model.black) / Math.max(1e-6, luminance(model.white))
    : (L2.Ea + L2.Epb) / Math.max(1, L2.Epw - L2.Epb));
  const isWhite = st.tab === 'pattern' ? patternWhiteIn(proj) : refWhiteMask();
  let room = null;
  try { room = buildPhotoRoom(st.photo, proj, isWhite, ratio); } catch (e) { console.error(e); }
  const photoRejected = !room || !room.ok;
  if (photoRejected) room = null;
  p.calib = room ? {
    quad: room.quad, Yamb: room.Yamb, Yproj: room.Yproj,
    Ea0: L2.Ea, Ep0: L2.Epw - L2.Epb, contrast: model ? model.effContrast : null,
    aspect: st.detected ? st.detected.aspect : null, date: Date.now(),
  } : null;
  store.state.params = p;
  store.state.dirty = true;
  store.emit('profile');
  store.emit('params');
  if (room) {
    deps.showPhotoViewNext && deps.showPhotoViewNext();
    await useBuiltRoom(room, p.calib, await canvasToBlob(st.photo, 480, 'image/jpeg', 0.8));
  }
  const after = computeScene(p, sw, sh);
  st.applied = { model, color, cuts: after.cuts, visible: after.visibleFrac, onWall, photo: !!room, colorRejected, photoRejected, ambient: p.room.ambientLux };
  st.step = 5;
  renderSteps();
  toast(t('calib.applied'));
}

// For "any photo": where the reference slide is near white, the photo shows projector white.
function refWhiteMask() {
  const ref = currentRef();
  if (!ref) return null; // rely on the photo's brightness alone
  const rw = 240, rh = Math.round((rw * ref.height) / ref.width);
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(ref, 0, 0, rw, rh);
  const d = g.getImageData(0, 0, rw, rh).data;
  return (u, v) => {
    if (u < 0.01 || v < 0.01 || u > 0.99 || v > 0.99) return false;
    const x = Math.min(rw - 1, Math.floor(u * rw)), y = Math.min(rh - 1, Math.floor(v * rh));
    // require a small white neighbourhood so anti-aliased text edges are skipped
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = ((Math.min(rh - 1, Math.max(0, y + dy))) * rw + Math.min(rw - 1, Math.max(0, x + dx))) * 4;
      if (d[k] < 235 || d[k + 1] < 235 || d[k + 2] < 235) return false;
    }
    return true;
  };
}

// ---------- Steps UI ----------
function step(n, title, body, state) {
  return `<div class="step ${state}"><span class="step-n">${state === 'done' ? '✓' : n}</span><div><h3>${title}</h3>${body}</div></div>`;
}

const STRIP = [0, 3, 7, 8, 9, 10, 11, 12, 13];
const PICK_ORDER = [[0, 'black'], [3, 'gray'], [7, 'white'], [8, 'red'], [9, 'green'], [10, 'blue'], [11, 'cyan'], [12, 'magenta'], [13, 'yellow']];
const rgbCss = (lin) => `rgb(${lin.map((v) => Math.round(linearToSrgb(Math.min(1, Math.max(0, v))) * 255)).join(',')})`;

function pickPanelHtml() {
  const [, key] = PICK_ORDER[st.picking];
  return `<div class="pick-panel"><p><b>${t('calib.pickNow', { name: t('calib.patch.' + key), i: st.picking + 1, n: PICK_ORDER.length })}</b></p>
    <p class="muted small">${t('calib.pickHint')}</p>
    <div class="btn-row"><button class="btn" id="pickSkip">${t('calib.pickSkip')}</button>
    <button class="btn primary" id="pickDone">${t('calib.pickDone')}</button>
    <button class="btn" id="pickCancel">${t('ui.cancel')}</button></div></div>`;
}

function resultsHtml() {
  const a = st.applied;
  if (!a) return '';
  if (st.picking !== null) return pickPanelHtml();
  const rows = [];
  const cuts = ['left', 'right', 'top', 'bottom'].filter((s) => a.cuts[s] > 0.005).map((s) => `${t('side.' + s)} ${num(a.cuts[s] * 100, 1)}%`);
  rows.push([t('calib.rSurface'), t(a.onWall ? 'layout.wall' : 'layout.screen')]);
  rows.push([t('calib.rVisible'), `${num(a.visible * 100, 0)}%`]);
  rows.push([t('calib.rCut'), cuts.length ? cuts.join(', ') : '—']);
  let extra = '';
  if (a.model) {
    rows.push([t('calib.rContrast'), `${num(a.model.effContrast, 1)}:1`]);
    rows.push([t('calib.rGamma'), num(a.model.gamma, 2)]);
    const p = store.state.params;
    extra = `<h4 class="tune-head">${t('calib.tuneTitle')}</h4>
      <p class="muted small">${t('calib.tuneHint')}</p>
      <div class="strip" id="tuneStrip"></div>
      <div class="strip-legend small muted"><span>${t('calib.rowSent')}</span><span>${t('calib.rowCamera')}</span><span>${t('calib.rowSim')}</span></div>
      <div class="ctl"><div class="ctl-top"><label for="tuneTemp">${t('ctl.colorTemp')}</label><span class="ctl-val" id="tuneTempV"></span></div>
        <input type="range" id="tuneTemp" min="5000" max="11000" step="100" value="${p.projector.colorTemp}"></div>
      <div class="ctl"><div class="ctl-top"><label for="tuneSat">${t('ctl.saturation')}</label><span class="ctl-val" id="tuneSatV"></span></div>
        <input type="range" id="tuneSat" min="0.3" max="1.3" step="0.01" value="${p.projector.saturation ?? 1}"></div>
      <div class="ctl"><div class="ctl-top"><label for="tuneAmb">${t('ctl.ambient')}</label><span class="ctl-val" id="tuneAmbV"></span></div>
        <input type="range" id="tuneAmb" min="0" max="1500" step="5" value="${p.room.ambientLux}"></div>
      <label class="check"><input type="checkbox" id="useCam" ${st.useCamColor ? 'checked' : ''}><span>${t('calib.useCam')}</span></label>
      ${st.tab === 'pattern' ? `<div class="btn-row" style="margin-top:8px"><button class="btn" id="pickStart"><svg class="ic"><use href="#i-target"/></svg>${t('calib.pickStart')}</button>
        ${Object.keys(st.picks).length ? `<button class="btn" id="pickReset">${t('calib.pickReset')}</button>` : ''}</div>` : ''}`;
  } else rows.push([t('calib.rColor'), t('calib.noColor')]);
  const notes = [];
  if (a.colorRejected) notes.push(t('calib.colorRejected'));
  if (a.photoRejected) notes.push(t('calib.photoRejected'));
  extra += notes.map((n) => `<p class="calib-warn">${n}</p>`).join('');
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${extra}
    <label class="field"><span>${t('profiles.name')}</span><input type="text" id="calibName" maxlength="60" value="${escapeHtml(t('profiles.defaultName'))}"></label>
    <div class="btn-row" style="margin-top:8px"><button class="btn primary" id="calibSave"><svg class="ic"><use href="#i-save"/></svg>${t('calib.saveProfile')}</button>
    <button class="btn" data-close>${t('ui.done')}</button></div>`;
}

/** Sent / camera / simulated colour columns, recomputed from the current settings. */
function updateStrip() {
  const el = $('tuneStrip');
  const a = st.applied;
  if (!el || !a || !a.color) return;
  const p = store.state.params;
  const slide = store.state.slides[store.state.current];
  const L = computeScene(p, slide ? slide.width : 1920, slide ? slide.height : 1080).light;
  const proj = p.projector.colorMatrix || projectorMatrix(L.tint, p.projector.saturation ?? 1);
  const env = { proj, gamma: p.projector.gamma || 1, Epw: L.Epw, Epb: L.Epb, Ea: L.Ea, ambCol: L.ambCol };
  const W = a.color.measured[7] || a.color.measured.find(Boolean);
  const wMax = W ? Math.max(...W, 1e-6) : 1;
  el.innerHTML = STRIP.map((i) => {
    const sent = a.color.inputs[i];
    const cam = a.color.measured[i];
    const sim = simulateColor(sent, env);
    return `<div class="strip-col"><i style="background:${rgbCss(sent)}"></i>
      <i class="${cam ? '' : 'none'}" style="${cam ? `background:${rgbCss(cam.map((v) => v / wMax))}` : ''}"></i>
      <i style="background:${rgbCss(sim)}"></i></div>`;
  }).join('');
  const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
  set('tuneTempV', `${num(p.projector.colorTemp)} K`);
  set('tuneSatV', `${num((p.projector.saturation ?? 1) * 100)} %`);
  set('tuneAmbV', `${num(p.room.ambientLux)} lx`);
  ['tuneTemp', 'tuneSat'].forEach((id) => { const e = $(id); if (e) e.disabled = !!p.projector.colorMatrix; });
}

function sampleAt([x, y]) {
  const { photoData: d, photo } = st;
  const acc = [0, 0, 0];
  let n = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xi = Math.round(x) + dx, yi = Math.round(y) + dy;
      if (xi < 0 || yi < 0 || xi >= photo.width || yi >= photo.height) continue;
      const k = (yi * photo.width + xi) * 4;
      for (let c = 0; c < 3; c++) acc[c] += srgbToLinear(d.data[k + c] / 255);
      n++;
    }
  }
  return acc.map((v) => v / Math.max(n, 1));
}

function showPicks() {
  editor.setPicks(Object.values(st.picks).map((pk) => ({ p: pk.p, label: pk.label })));
}

function startPicking() {
  st.picking = 0;
  editor.setPickMode((pt) => {
    const [idx, key] = PICK_ORDER[st.picking];
    st.picks[idx] = { p: pt, rgb: sampleAt(pt), label: t('calib.patch.' + key) };
    showPicks();
    advancePick();
  });
  renderSteps();
}

function advancePick() {
  st.picking++;
  if (st.picking >= PICK_ORDER.length) finishPicking();
  else renderSteps();
}

function finishPicking(cancel = false) {
  if (!cancel && (!st.picks[0] || !st.picks[7])) { toast(t('calib.pickNeed')); return; }
  st.picking = null;
  editor.setPickMode(null);
  if (cancel) { st.picks = {}; showPicks(); renderSteps(); return; }
  apply();
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderSteps() {
  const box = $('calibSteps');
  const hasPhoto = !!st.photo;
  const s = (n) => (st.step > n ? 'done' : st.step === n ? 'active' : '');
  let html = '';
  if (st.tab === 'pattern') {
    const sizes = DL_SIZES.map(([k, w, h]) => `<option value="${k}" ${st.dlSize === k ? 'selected' : ''}>${k === 'screen' ? t('calib.dlScreen', { w: screenPx()[0], h: screenPx()[1] }) : k === 'custom' ? t('calib.dlCustom') : `${w} × ${h}${DL_NOTE[k] ? ' · ' + DL_NOTE[k] : ''}`}</option>`).join('');
    html += step(1, t('calib.p1t'), `<p>${t('calib.p1b')}</p><div class="btn-row"><button class="btn" id="showPattern"><svg class="ic"><use href="#i-screen"/></svg>${t('calib.showPattern')}</button></div>
      <p style="margin-top:10px">${t('calib.dlBody')}</p>
      <div class="dl-row"><div class="select-wrap grow"><select id="dlSize">${sizes}</select><svg class="ic"><use href="#i-chev"/></svg></div>
      <button class="btn" id="dlPattern"><svg class="ic"><use href="#i-down"/></svg>${t('calib.dlBtn')}</button></div>
      <div class="dl-custom" ${st.dlSize === 'custom' ? '' : 'hidden'}><input type="number" id="dlW" min="320" max="8192" value="${st.dlW || 1920}" aria-label="W"> × <input type="number" id="dlH" min="240" max="8192" value="${st.dlH || 1080}" aria-label="H"></div>`, s(1));
    html += step(2, t('calib.p2t'), `<ul>${t('calib.p2b')}</ul>`, s(2));
    html += step(3, t('calib.p3t'), `<p>${t('calib.p3b')}</p><div class="btn-row"><button class="btn primary" id="choosePhoto"><svg class="ic"><use href="#i-image"/></svg>${t('calib.choosePhoto')}</button></div>`, hasPhoto ? 'done' : s(3));
  } else {
    html += step(1, t('calib.q1t'), `<p>${t('calib.q1b')}</p><div class="btn-row"><button class="btn primary" id="choosePhoto"><svg class="ic"><use href="#i-image"/></svg>${t('calib.choosePhoto')}</button></div>`, hasPhoto ? 'done' : 'active');
    const best = st.matches[0];
    const opts = st.matches.map((m) => `<option value="${m.key}" ${m.key === st.refKey ? 'selected' : ''}>${escapeHtml(m.name)} — ${num(m.score * 100, 0)}%</option>`).join('')
      + `<option value="none" ${st.refKey === 'none' ? 'selected' : ''}>${t('calib.refNone')}</option>`;
    const chosen = st.matches.find((m) => m.key === st.refKey);
    const msg = !hasPhoto ? '' : chosen
      ? `<p class="calib-ok">${t('calib.matchFound', { name: escapeHtml(chosen.name), p: num(chosen.score * 100, 0) })}</p>`
      : `<p class="calib-warn">${t(best ? 'calib.matchNone' : 'calib.matchEmpty')}</p>`;
    html += step(2, t('calib.q2t'), `<p>${t('calib.q2b')}</p>
      ${hasPhoto ? `<div class="ref-row"><canvas id="refThumb" width="96" height="54"></canvas><div class="select-wrap grow"><select id="refSelect">${opts}</select><svg class="ic"><use href="#i-chev"/></svg></div></div>` : ''}
      ${msg}
      <div class="btn-row" style="margin-top:6px"><button class="btn" id="chooseRef">${t('calib.chooseRef')}</button></div>`, hasPhoto ? (st.step > 4 ? 'done' : 'active') : '');
  }
  const surf = `<div class="ctl-top"><label>${t('layout.surface')}</label></div><div class="chips" id="surfChips">
      <button class="chip" type="button" data-surf="screen" aria-pressed="${st.surface !== 'wall'}">${t('layout.screen')}</button>
      <button class="chip" type="button" data-surf="wall" aria-pressed="${st.surface === 'wall'}">${t('layout.wall')}</button></div>
      <p class="muted small" style="margin-top:6px">${t(st.surface === 'wall' ? 'calib.surfWallHint' : 'calib.surfScreenHint')}</p>`;
  html += step(4, t('calib.s4t'), `<p>${t(st.surface === 'wall' ? 'calib.s4bWall' : 'calib.s4b')}</p>${hasPhoto ? surf : ''}<div class="btn-row" style="margin-top:10px"><button class="btn primary" id="applyCalib" ${hasPhoto ? '' : 'disabled'}>${t('calib.apply')}</button>
    <button class="btn" id="redetect" ${hasPhoto ? '' : 'disabled'}><svg class="ic"><use href="#i-reset"/></svg>${t('calib.redetect')}</button></div>`, hasPhoto ? (st.step > 4 ? 'done' : 'active') : '');
  if (st.applied) html += step(5, t('calib.s5t'), resultsHtml(), 'active');
  box.innerHTML = html;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('showPattern', () => { st.step = Math.max(st.step, 2); showPattern(); renderSteps(); });
  on('choosePhoto', () => pickFile('image/*', loadPhoto));
  on('chooseRef', () => pickFile('image/*', async (f) => {
    st.refCanvas = await readPhoto(f);
    updateMatches(false);
    st.refKey = 'file';
    st.applied = null;
    renderSteps();
  }));
  const rs = $('refSelect');
  if (rs) rs.addEventListener('change', () => { st.refKey = rs.value; st.applied = null; if (st.step > 4) st.step = 4; renderSteps(); });
  const rt = $('refThumb');
  if (rt) {
    const g = rt.getContext('2d');
    g.fillStyle = '#888'; g.fillRect(0, 0, rt.width, rt.height);
    const src = currentRef();
    if (src) g.drawImage(src, 0, 0, rt.width, rt.height);
  }
  on('applyCalib', apply);
  on('pickStart', startPicking);
  on('pickSkip', advancePick);
  on('pickDone', () => finishPicking(false));
  on('pickCancel', () => finishPicking(true));
  on('pickReset', () => { st.picks = {}; showPicks(); apply(); });
  const tune = (id, path, parse = Number) => {
    const e = $(id);
    if (e) e.addEventListener('input', () => { store.setParam(path, parse(e.value)); updateStrip(); });
  };
  tune('tuneTemp', 'projector.colorTemp');
  tune('tuneSat', 'projector.saturation');
  tune('tuneAmb', 'room.ambientLux');
  const cam = $('useCam');
  if (cam) cam.addEventListener('change', () => {
    st.useCamColor = cam.checked;
    store.setParam('projector.colorMatrix', cam.checked && st.applied.model ? st.applied.model.colorMatrix : null);
    updateStrip();
  });
  updateStrip();
  on('dlPattern', downloadPattern);
  const dl = $('dlSize');
  if (dl) dl.addEventListener('change', () => { st.dlSize = dl.value; renderSteps(); });
  box.querySelectorAll('[data-surf]').forEach((b) => b.addEventListener('click', () => {
    st.surface = b.dataset.surf;
    const q = editor.quads;
    // a screen needs its own corners: start slightly outside the picture
    editor.setQuads({ proj: q.proj, screen: st.surface === 'wall' ? null : (q.screen || shrink(q.proj, -0.04)) }, false);
    st.applied = null;
    if (st.step > 4) st.step = 4;
    renderSteps();
  }));
  on('redetect', () => (st.tab === 'pattern' ? runPatternDetection() : runPhotoGuess()));
  on('calibSave', async () => {
    const name = ($('calibName').value || '').trim() || t('profiles.defaultName');
    await saveProfile(name.slice(0, 60));
    $('calibDlg').close();
  });
}

function pickFile(accept, cb) {
  const i = document.createElement('input');
  i.type = 'file';
  i.accept = accept;
  i.addEventListener('change', () => { if (i.files[0]) cb(i.files[0]); });
  i.click();
}

async function loadPhoto(file) {
  try {
    setStatus(t('calib.analyzing'));
    st.photo = await readPhoto(file);
    st.photoData = st.photo.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, st.photo.width, st.photo.height);
    st.applied = null;
    st.step = 4;
    st.picks = {};
    st.picking = null;
    editor.setPickMode(null);
    editor.setPicks([]);
    $('calibEmpty').hidden = true;
    editor.setImage(st.photo);
    await new Promise((r) => setTimeout(r, 30));
    if (st.tab === 'pattern') runPatternDetection(); else runPhotoGuess();
    renderSteps();
  } catch (e) {
    console.error(e);
    toast(t('file.failed', { name: file.name }));
  }
}

function setTab(tab) {
  st.tab = tab;
  document.querySelectorAll('#calibDlg [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  st.applied = null;
  st.step = st.photo ? 4 : 1;
  if (st.photo) { if (tab === 'pattern') runPatternDetection(); else runPhotoGuess(); }
  renderSteps();
}

export function initCalibration(d) {
  deps = d;
  const dlg = $('calibDlg');
  wireDialog(dlg);
  editor = new QuadEditor($('calibCanvas'), $('loupe'), () => {
    st.applied = null;
    if (st.step > 4) st.step = 4;
    if (st.tab === 'photo') updateMatches(st.refKey === 'none' || (st.matches[0] && st.refKey === st.matches[0].key));
    renderSteps();
  });
  document.querySelectorAll('#calibDlg [role="tab"]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('calibrateBtn').addEventListener('click', () => {
    renderSteps();
    dlg.showModal();
    editor.draw();
  });
  // allow dropping a photo onto the editor
  const ed = $('calibEditor');
  ed.addEventListener('dragover', (e) => e.preventDefault());
  ed.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadPhoto(f); });
  onLang(() => { if (dlg.open) renderSteps(); });
}
