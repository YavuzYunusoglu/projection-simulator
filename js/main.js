import { store } from './state.js';
import { t, num, applyI18n, setLang, getLang, onLang } from './i18n.js';
import { setThemePref, getThemePref, onTheme, cssVar } from './theme.js';
import { computeScene } from './sim/scene.js';
import { projectorMatrix } from './sim/photometry.js';
import { SimRenderer } from './sim/renderer.js';
import { solveHomography, invertH, applyH } from './sim/homography.js';
import { roomLayout, fitCamera, viewerCamera } from './sim/room.js';
import { analyze, lumaPlane, downsample2 } from './sim/analysis.js';
import { buildControls, CHECK_SECTIONS, SETUP_SECTIONS } from './ui/controls.js';
import { Overlay } from './ui/overlay.js';
import { renderReadout, renderFindings } from './ui/findings.js';
import { renderSlideList, markCurrent, selectSlide, loadFiles, setSlides } from './ui/slides.js';
import { initProfiles } from './ui/profiles.js';
import { reducedMotion, toast, wireDialog } from './ui/motion.js';
import { sampleSlide } from './loaders/sample.js';
import { initCalibration } from './calib/ui.js';
import { initStageBar, toggleFullscreen } from './ui/stagebar.js';
import { restoreRoomPhoto } from './photoview.js';

const $ = (id) => document.getElementById(id);
const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];

applyI18n();

// ---------- Renderer ----------
let renderer = null;
try {
  renderer = new SimRenderer($('glCanvas'));
} catch (e) {
  console.error(e);
  $('dropZone').querySelector('p').textContent = t('err.webgl');
}
const overlay = new Overlay($('overlayCanvas'));

let scene = null;
let analysis = null;
let slideImage = null;
let origLuma = null;
let current = null;   // tweened uniforms
let target = null;
let warmStart = 0;
let lastFrame = 0;
let raf = 0;

function srgbOf(cssColor) {
  const m = /#([0-9a-f]{6})/i.exec(cssColor);
  if (!m) return [0.85, 0.84, 0.82];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

// Wall albedo: measured colour (if any) scaled to a typical painted-wall reflectance.
function wallAlbedo(c) {
  if (!c) return [0.8, 0.795, 0.78];
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] || 1;
  // the photo's wall is lit by (usually warm) room light and white-balanced by the camera:
  // keep only part of its tint
  return c.map((v) => Math.min(1, (1 + 0.45 * (v / y - 1)) * 0.78));
}

function buildTarget() {
  const slide = store.state.slides[store.state.current];
  const p = store.state.params;
  const sw = slide ? slide.width : 1920, sh = slide ? slide.height : 1080;
  scene = computeScene(p, sw, sh);
  const L = scene.light;
  const room = roomLayout(scene.screenW, scene.screenH, p.room.layout);
  const canvas = $('glCanvas');
  const aspect = canvas.width / Math.max(1, canvas.height);
  const photo = store.state.view === 'photo' ? store.state.photo : null;
  const cam = photo
    ? fitCamera([0, 0, photo.w, photo.h], aspect, 0.01)
    : store.state.view === 'room'
      ? viewerCamera(p.viewer.distance, aspect, room.screen, scene.cornersM)
      : fitCamera(room.screen, aspect, 0.04, scene.cornersM);
  const proj = p.projector.colorMatrix
    ? p.projector.colorMatrix
    : projectorMatrix(L.tint, p.projector.saturation ?? 1);
  const lux = p.room.ambientLux;
  // The eye largely adapts to what fills the view: mostly room-lit walls plus the bright
  // screen (von Kries scaling, degree 0.85, room light weighted 3x for its larger area).
  const pw = [0, 1, 2].map((r) => proj[r * 3] + proj[r * 3 + 1] + proj[r * 3 + 2]);
  const wa = 3 * L.Ea;
  const mixW = pw.map((v, i) => (L.Epw * v + wa * L.ambCol[i]) / (L.Epw + wa));
  const mixY = 0.2126 * mixW[0] + 0.7152 * mixW[1] + 0.0722 * mixW[2];
  const adapt = mixW.map((v) => 1 + 0.85 * (v / mixY - 1));
  target = {
    adapt,
    corners: scene.cornersM.flat(),
    Epw: L.Epw, Epb: L.Epb, Ea: L.Ea, ambCol: L.ambCol, proj, gamma: p.projector.gamma || 1,
    // the blur effect is optional on screen (off by default); analysis always uses it
    sigma: p.viewer.blur ? scene.blur.sigma : 0, cam, room: store.state.view === 'room' ? 1 : 0,
    curtain: 1 - Math.min(1, Math.max(0, Math.log10(lux + 1) / Math.log10(900))),
    screenW: scene.screenW, screenH: scene.screenH, gain: L.gain,
    wb: room.wb, win: room.win, ceil: room.ceil, trunk: room.trunk, floor: room.floor, desk: room.desk,
    wallAlb: wallAlbedo(p.room.wallColor), surface: room.wall ? 1 : 0,
    slideAspect: scene.aspect,
    center: [0, 0],
  };
  if (photo) {
    // re-light the photo: scale its ambient and projector layers by today's settings
    const c = photo.calib;
    // clamp: a calibration that is off by a few times must not blow the picture out
    const clampK = (k) => Math.min(20, Math.max(0.05, k));
    const kA = clampK(c.Ea0 > 0.5 ? L.Ea / c.Ea0 : 1);
    const kP = clampK(c.Ep0 > 0 ? (L.Epw - L.Epb) / c.Ep0 : 1);
    const q = photo.H;
    const cornersPx = UNIT.map(([u, v]) => applyH(q, u, v));
    const xs = cornersPx.map((pt) => pt[0]), ys = cornersPx.map((pt) => pt[1]);
    Object.assign(target, {
      photoMode: 1, photoSize: [photo.w, photo.h], kA, kP,
      photoRef: Math.max(1e-4, (photo.Yamb * kA + photo.Yproj * kP) / 0.96),
      origRef: Math.max(1e-4, (photo.Yamb + photo.Yproj) / 0.96),
      photoOpacity: store.state.photoOpacity,
      adapt: [1, 1, 1],
      screenW: Math.max(...xs) - Math.min(...xs), screenH: Math.max(...ys) - Math.min(...ys),
      center: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2],
    });
  } else target.photoMode = 0;
  // the camera jumps between metres and photo pixels: don't tween across that
  if (current && current.photoMode !== target.photoMode) {
    current.cam = [...target.cam];
    current.center = [...target.center];
    current.screenW = target.screenW;
    current.screenH = target.screenH;
    current.photoMode = target.photoMode;
  }
  if (!current) current = JSON.parse(JSON.stringify(target));
  const tag = $('viewTag');
  tag.hidden = store.state.view !== 'room' || !slide;
  tag.textContent = t('view.seat', { d: num(p.viewer.distance, 1) });
  kick();
}

// switches, not quantities: never interpolate these
const DISCRETE = new Set(['photoMode', 'surface', 'room']);

function lerpInto(cur, tgt, k) {
  let moving = false;
  for (const key of Object.keys(tgt)) {
    const tv = tgt[key];
    if (DISCRETE.has(key)) { cur[key] = tv; continue; }
    if (Array.isArray(tv)) {
      if (!Array.isArray(cur[key]) || cur[key].length !== tv.length) { cur[key] = [...tv]; continue; }
      for (let i = 0; i < tv.length; i++) {
        const d = tv[i] - cur[key][i];
        if (Math.abs(d) > 1e-4 * (Math.abs(tv[i]) + 1)) { cur[key][i] += d * k; moving = true; } else cur[key][i] = tv[i];
      }
    } else if (typeof tv === 'number') {
      const d = tv - cur[key];
      if (Math.abs(d) > 1e-4 * (Math.abs(tv) + 1)) { cur[key] += d * k; moving = true; } else cur[key] = tv;
    } else cur[key] = tv;
  }
  return moving;
}

// Soft lamp warm-up, played only when a new file or sample is opened.
function warmFactor(now) {
  if (reducedMotion() || !warmStart) return 1;
  const e = (now - warmStart) / 450;
  if (e >= 1) return 1;
  return 0.55 + 0.45 * (1 - Math.pow(1 - e, 3));
}

function frame(now) {
  raf = 0;
  if (!renderer || !slideImage || !target) return;
  const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
  lastFrame = now;
  const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / 110);
  const moving = lerpInto(current, target, k);
  const corners = [];
  for (let i = 0; i < 4; i++) corners.push([current.corners[2 * i], current.corners[2 * i + 1]]);
  const H = current.photoMode && store.state.photo ? store.state.photo.H : solveHomography(UNIT, corners);
  const Hinv = H && invertH(H);
  if (!Hinv) return;
  const warm = warmFactor(now);
  const U = {
    ...current, H, Hinv, warm, time: now / 1000,
    split: store.state.compare ? compareSplit : -1,
    stage: srgbOf(cssVar('--stage')),
  };
  renderer.render(U);
  overlay.draw(U, scene, store.state, store.state.overlays.heat ? analysis : null);
  lastU = U;
  if (moving || warm < 1 || overlay.animating) kick();
}
let lastU = null;

function kick() { if (!raf) raf = requestAnimationFrame(frame); }

// ---------- Canvas sizing ----------
function resize() {
  const frameEl = $('stageFrame');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(frameEl.clientWidth * dpr));
  const h = Math.max(1, Math.round(frameEl.clientHeight * dpr));
  for (const c of [$('glCanvas'), $('overlayCanvas')]) {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  buildTarget();
  if (current && target) current.cam = [...target.cam];
  kick();
}
new ResizeObserver(resize).observe($('stageFrame'));

// ---------- Analysis ----------
let analysisTimer = 0;
function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, 420);
}

function runAnalysis() {
  if (!renderer || !slideImage || !target || !lastU) return;
  const W = 1920, Hh = Math.round(W / scene.aspect);
  const H = solveHomography(UNIT, chunk(target.corners));
  const base = { ...lastU, ...target, photoMode: 0, H, Hinv: invertH(H), warm: 1, sigma: scene.blur.sigma };
  const sim = renderer.readSlideSpace(base, W, Hh);
  // contrast is judged without the viewer's blur (that is measured separately)
  const sharpPx = renderer.readSlideSpace({ ...base, sigma: 0 }, W, Hh);
  if (!sim || !sharpPx) return;
  const ds = downsample2(sim, W, Hh);
  const dsSharp = downsample2(sharpPx, W, Hh);
  if (!origLuma || origLuma.w !== ds.w) {
    const c = document.createElement('canvas');
    c.width = ds.w; c.height = ds.h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(slideImage, 0, 0, ds.w, ds.h);
    origLuma = { w: ds.w, h: ds.h, data: lumaPlane(g.getImageData(0, 0, ds.w, ds.h).data, ds.w, ds.h) };
  }
  analysis = analyze(origLuma.data, lumaPlane(ds.data, ds.w, ds.h), ds.w, ds.h, scene.isVisible, 24, lumaPlane(dsSharp.data, ds.w, ds.h));
  updatePanels();
  kick();
}
const chunk = (a) => [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]], [a[6], a[7]]];

function roomSummary(p) {
  const parts = [];
  parts.push(t(p.room.layout && p.room.layout.surface === 'wall' ? 'layout.wall' : 'layout.screen'));
  parts.push(`${num(p.projector.lumens * p.projector.lampHealth / 100)} lm`);
  parts.push(`${num(p.room.ambientLux)} lx`);
  if (p.calib) parts.push(t('calib.calibrated'));
  return parts.join(' · ');
}

function updatePanels() {
  const slide = store.state.slides[store.state.current];
  const p = store.state.params;
  $('roomSummary').textContent = roomSummary(p);
  $('calibSummary').textContent = p.calib
    ? t('calib.summaryOn', { surface: t(p.room.layout.surface === 'wall' ? 'layout.wall' : 'layout.screen').toLowerCase(), c: p.calib.contrast ? num(p.calib.contrast, 1) + ':1' : '—' })
    : t('calib.summaryOff');
  renderReadout($('readout'), slide ? scene : null, store.state.params);
  renderFindings($('findingsBody'), scene, store.state.params, analysis, slide);
  // badges: only touch the DOM when the set (or language) changed
  const badges = $('slideBadges');
  const list = (slide && slide.warnings) || [];
  const key = getLang() + '|' + list.join(',');
  if (badges.dataset.key === key) return;
  const prev = new Set((badges.dataset.key || '').split('|')[1]?.split(',').filter(Boolean));
  badges.dataset.key = key;
  badges.innerHTML = '';
  for (const w of list) {
    const cls = prev.has(w) ? 'badge' : 'badge enter';
    badges.insertAdjacentHTML('beforeend', `<span class="${cls}"><svg class="ic"><use href="#i-warn"/></svg>${t('pptx.' + w + 'Short')}</span>`);
  }
}

// ---------- Slides ----------
async function showSlide() {
  const slide = store.state.slides[store.state.current];
  markCurrent($('slideList'));
  if (!slide) return;
  const img = await slide.image();
  if (store.state.slides[store.state.current] !== slide) return;
  slideImage = img;
  origLuma = null;
  analysis = null;
  if (renderer) renderer.setSlide(img);
  document.body.classList.add('has-slide');
  if (freshDeck) {
    // effects only when a new deck is opened, never while flipping through slides
    freshDeck = false;
    warmStart = performance.now();
    overlay.revealSafe();
  }
  buildTarget();
  updatePanels();
  scheduleAnalysis();
}

let freshDeck = false;
store.subscribe((what) => {
  if (what === 'slides') { freshDeck = true; renderSlideList($('slideList')); }
  if (what === 'slide') showSlide();
  if (what === 'params' || what === 'profile') {
    buildTarget();
    updatePanels();
    scheduleAnalysis();
  }
  if (what === 'profile') overlay.revealSafe();
});

// ---------- Stage toolbar ----------
for (const b of document.querySelectorAll('#viewSeg [data-view]')) {
  b.addEventListener('click', () => {
    store.state.view = b.dataset.view;
    store.emit('view');
    buildTarget();
  });
}

store.subscribe((what) => {
  if (what !== 'photo') return;
  if (renderer) renderer.setPhotoRoom(store.state.photo);
  if (store.state.photo && store.state.view !== 'photo' && photoJustSet) { store.state.view = 'photo'; store.emit('view'); }
  photoJustSet = false;
  buildTarget();
  updatePanels();
});
let photoJustSet = false;
export function showPhotoViewNext() { photoJustSet = true; }

$('opacityRange').addEventListener('input', (e) => {
  store.state.photoOpacity = Number(e.target.value) / 100;
  $('opacityVal').textContent = `${e.target.value}%`;
  try { localStorage.setItem('projsim.photoOpacity', String(store.state.photoOpacity)); } catch { /* ignore */ }
  buildTarget();
});

// ---------- Modes ----------
const MODE_KEY = 'projsim.mode';
function setMode(mode) {
  document.body.dataset.mode = mode;
  document.querySelectorAll('.mode-tabs [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== mode; });
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}
document.querySelectorAll('.mode-tabs [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.goto)));
setMode((() => { try { return localStorage.getItem(MODE_KEY) || 'check'; } catch { return 'check'; } })());

// ---------- Menu ----------
(() => {
  const btn = $('menuBtn'), menu = $('menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  menu.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  menu.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => setThemePref(b.dataset.themeSet)));
  $('aboutBtn').addEventListener('click', close);
})();

let compareSplit = 0.5;
function setPressed(btn, on) { btn.setAttribute('aria-pressed', String(on)); }
$('compareBtn').addEventListener('click', () => {
  store.state.compare = !store.state.compare;
  setPressed($('compareBtn'), store.state.compare);
  $('compareUi').hidden = !store.state.compare;
  if (store.state.compare) animateSplit(0.08, 0.5);
  kick();
});
$('safeBtn').addEventListener('click', () => {
  store.state.overlays.safe = !store.state.overlays.safe;
  setPressed($('safeBtn'), store.state.overlays.safe);
  if (store.state.overlays.safe) overlay.revealSafe();
  kick();
});
$('heatBtn').addEventListener('click', () => {
  store.state.overlays.heat = !store.state.overlays.heat;
  setPressed($('heatBtn'), store.state.overlays.heat);
  if (store.state.overlays.heat && !analysis) runAnalysis();
  kick();
});

function placeHandle() {
  $('cmpHandle').style.left = `${compareSplit * 100}%`;
  $('cmpHandle').setAttribute('aria-valuenow', String(Math.round(compareSplit * 100)));
}
function animateSplit(from, to) {
  if (reducedMotion()) { compareSplit = to; placeHandle(); kick(); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 520);
    compareSplit = from + (to - from) * (1 - Math.pow(1 - k, 3));
    placeHandle();
    kick();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
(() => {
  const h = $('cmpHandle');
  const move = (e) => {
    const r = $('stageFrame').getBoundingClientRect();
    compareSplit = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width));
    placeHandle();
    kick();
  };
  h.addEventListener('pointerdown', (e) => {
    h.setPointerCapture(e.pointerId);
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', () => h.removeEventListener('pointermove', move), { once: true });
  });
  h.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    compareSplit = Math.min(0.98, Math.max(0.02, compareSplit + d));
    placeHandle();
    kick();
  });
})();

// files
const openPicker = () => $('fileInput').click();
$('openBtn').addEventListener('click', openPicker);
$('dropOpenBtn').addEventListener('click', openPicker);
$('fileInput').addEventListener('change', (e) => { const f = e.target.files; loadFiles(f).finally(() => { e.target.value = ''; }); });
$('sampleBtn').addEventListener('click', () => setSlides([sampleSlide(getLang())]));

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  if (document.querySelector('dialog[open]')) return;
  dragDepth++;
  $('dragVeil').hidden = false;
});
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dragVeil').hidden = true; });
window.addEventListener('dragover', (e) => { if (!document.querySelector('dialog[open]')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  dragDepth = 0;
  $('dragVeil').hidden = true;
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// keyboard slide navigation
window.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleFullscreen(); return; }
  if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.target.closest('.cmp-handle'))) { selectSlide(store.state.current + 1); }
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') { selectSlide(store.state.current - 1); }
});

// language & theme
function updateLangBtn() {
  document.querySelectorAll('#menu [data-lang]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === getLang())));
}
onLang(() => {
  updateLangBtn();
  updatePanels();
  renderAbout();
  const s = store.state.slides;
  if (s.length === 1 && s[0].name && /Sample slide|Örnek slayt/.test(s[0].name)) setSlides([sampleSlide(getLang())]);
  kick();
});
updateLangBtn();

function updateThemeIcon() {
  const pref = getThemePref();
  document.querySelectorAll('#menu [data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === pref)));
}
onTheme(() => { updateThemeIcon(); updatePanels(); kick(); });
onLang(updateThemeIcon);
updateThemeIcon();

// about
function renderAbout() {
  $('aboutBody').innerHTML = t('about.body');
}
renderAbout();
wireDialog($('aboutDlg'));
$('aboutBtn').addEventListener('click', () => $('aboutDlg').showModal());

// ---------- Boot ----------
buildControls($('checkControls'), CHECK_SECTIONS, { flat: true });
buildControls($('setupControls'), SETUP_SECTIONS);
initProfiles();
initCalibration({ getSlideImage: () => slideImage, getScene: () => scene, showPhotoViewNext });
initStageBar();
updatePanels();
restoreRoomPhoto();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) toast(t('err.generic')); });
