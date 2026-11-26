import { store } from './state.js';
import { t, applyI18n, setLang, getLang, onLang } from './i18n.js';
import { cycleTheme, getThemePref, onTheme, cssVar } from './theme.js';
import { computeScene } from './sim/scene.js';
import { SimRenderer } from './sim/renderer.js';
import { solveHomography, invertH } from './sim/homography.js';
import { roomLayout, fitCamera } from './sim/room.js';
import { analyze, lumaPlane, downsample2 } from './sim/analysis.js';
import { buildControls } from './ui/controls.js';
import { Overlay } from './ui/overlay.js';
import { renderReadout, renderFindings } from './ui/findings.js';
import { renderSlideList, markCurrent, selectSlide, loadFiles, setSlides } from './ui/slides.js';
import { initProfiles } from './ui/profiles.js';
import { reducedMotion, toast, wireDialog } from './ui/motion.js';
import { sampleSlide } from './loaders/sample.js';
import { initCalibration } from './calib/ui.js';

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

function buildTarget() {
  const slide = store.state.slides[store.state.current];
  const p = store.state.params;
  const sw = slide ? slide.width : 1920, sh = slide ? slide.height : 1080;
  scene = computeScene(p, sw, sh);
  const L = scene.light;
  const room = roomLayout(scene.screenW, scene.screenH);
  const canvas = $('glCanvas');
  const aspect = canvas.width / Math.max(1, canvas.height);
  const cam = store.state.view === 'room'
    ? fitCamera(room.room, aspect, 0.01, scene.cornersM)
    : fitCamera(room.screen, aspect, 0.04, scene.cornersM);
  const proj = p.projector.colorMatrix
    ? p.projector.colorMatrix
    : [L.tint[0], 0, 0, 0, L.tint[1], 0, 0, 0, L.tint[2]];
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
    sigma: scene.blur.sigma, cam, room: store.state.view === 'room' ? 1 : 0,
    curtain: 1 - Math.min(1, Math.max(0, Math.log10(lux + 1) / Math.log10(900))),
    screenW: scene.screenW, screenH: scene.screenH, gain: L.gain,
    wb: room.wb, win: room.win, ceil: room.ceil, trunk: room.trunk,
    slideAspect: scene.aspect,
  };
  if (!current) current = JSON.parse(JSON.stringify(target));
  kick();
}

function lerpInto(cur, tgt, k) {
  let moving = false;
  for (const key of Object.keys(tgt)) {
    const tv = tgt[key];
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
  const H = solveHomography(UNIT, corners);
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
  const sim = renderer.readSlideSpace({ ...lastU, ...target, H, Hinv: invertH(H), warm: 1 }, W, Hh);
  if (!sim) return;
  const ds = downsample2(sim, W, Hh);
  if (!origLuma || origLuma.w !== ds.w) {
    const c = document.createElement('canvas');
    c.width = ds.w; c.height = ds.h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(slideImage, 0, 0, ds.w, ds.h);
    origLuma = { w: ds.w, h: ds.h, data: lumaPlane(g.getImageData(0, 0, ds.w, ds.h).data, ds.w, ds.h) };
  }
  analysis = analyze(origLuma.data, lumaPlane(ds.data, ds.w, ds.h), ds.w, ds.h, scene.visible, 24);
  updatePanels();
  kick();
}
const chunk = (a) => [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]], [a[6], a[7]]];

function updatePanels() {
  const slide = store.state.slides[store.state.current];
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

// ---------- Top bar ----------
for (const b of document.querySelectorAll('.seg [data-view]')) {
  b.addEventListener('click', () => {
    store.state.view = b.dataset.view;
    document.querySelectorAll('.seg [data-view]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    buildTarget();
  });
}
document.querySelectorAll('.seg [data-view]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.view === store.state.view)));

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
  if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.target.closest('.cmp-handle'))) { selectSlide(store.state.current + 1); }
  if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') { selectSlide(store.state.current - 1); }
});

// language & theme
function updateLangBtn() { $('langLabel').textContent = getLang() === 'tr' ? 'EN' : 'TR'; }
$('langBtn').addEventListener('click', () => setLang(getLang() === 'tr' ? 'en' : 'tr'));
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
  $('themeIcon').setAttribute('href', pref === 'dark' ? '#i-moon' : pref === 'light' ? '#i-sun' : '#i-auto');
  $('themeBtn').title = `${t('ui.theme')}: ${t('theme.' + pref)}`;
}
$('themeBtn').addEventListener('click', () => { cycleTheme(); });
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
buildControls($('controls'));
initProfiles();
initCalibration({ getSlideImage: () => slideImage, getScene: () => scene });
updatePanels();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) toast(t('err.generic')); });
