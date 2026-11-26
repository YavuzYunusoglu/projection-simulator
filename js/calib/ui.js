// Calibration dialog: test-pattern workflow and "any photo" workflow.
import { store } from '../state.js';
import { t, num, onLang, getLang } from '../i18n.js';
import { toast, wireDialog } from '../ui/motion.js';
import { saveProfile } from '../ui/profiles.js';
import { solveHomography, squareToQuad, applyH, pointInPolygon } from '../sim/homography.js';
import { computeScene } from '../sim/scene.js';
import { srgbToLinear, linearToSrgb } from '../sim/photometry.js';
import { drawPattern, patternLayout, GRAYS, COLORS } from './pattern.js';
import { grayPlane, detectMarkers, recoverMarkers, patternHomography, estimateScreenInPattern, brightRegionQuad } from './detect.js';
import { fitAffine, fitGamma, deriveModel } from './colorfit.js';
import { QuadEditor } from './editor.js';

const $ = (id) => document.getElementById(id);
const WORK_MAX = 2000;
const DETECT_MAX = 1100;

const st = {
  tab: 'pattern',
  photo: null,        // canvas
  photoData: null,    // ImageData of photo
  photoBlob: null,
  ref: 'current',     // 'current' | canvas
  refCanvas: null,
  detected: null,     // { markers, aspect }
  applied: null,
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
  return { g: grayPlane(g.getImageData(0, 0, w, h).data, w, h), w, h, s };
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

// ---------- Detection ----------
function runPatternDetection() {
  const { g, w, h, s } = grayOf(st.photo);
  const found = detectMarkers(g, w, h);
  // try common output aspects; the one with the best marker fit wins
  let best = null;
  let markers = found;
  for (const aspect of [16 / 9, 16 / 10, 4 / 3, 3 / 2]) {
    const ms = recoverMarkers(g, w, h, found, aspect);
    const H = ms.length >= 2 ? patternHomography(ms, aspect) : null;
    if (!H) continue;
    const L = patternLayout(aspect);
    let err = 0;
    for (const m of ms) {
      const mk = L.markers[m.id];
      const pc = [[mk.x, mk.y], [mk.x + mk.w, mk.y], [mk.x + mk.w, mk.y + mk.h], [mk.x, mk.y + mk.h]];
      pc.forEach((p, i) => { const q = applyH(H, ...p); err += Math.hypot(q[0] - m.corners[i][0], q[1] - m.corners[i][1]); });
    }
    err /= ms.length;
    // more markers explained is better than a slightly smaller residual
    if (!best || ms.length > best.n || (ms.length === best.n && err < best.err)) best = { H, aspect, err, n: ms.length, ms };
  }
  if (best) markers = best.ms;
  if (!best) {
    const q = brightRegionQuad(g, w, h);
    const proj = q ? q.map(([x, y]) => [x / s, y / s]) : defaultQuad(st.photo, 0.12);
    st.detected = null;
    editor.setQuads({ proj, screen: shrink(proj, 0.03) });
    setStatus(t('calib.notFound', { n: markers.length }));
    toast(t('calib.notFound', { n: markers.length }), 4200);
    return;
  }
  const proj = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyH(best.H, u, v).map((c) => c / s));
  const scrUv = estimateScreenInPattern(g, w, h, best.H, best.aspect);
  const screen = scrUv.map(([u, v]) => applyH(best.H, u, v).map((c) => c / s));
  st.detected = { markers: markers.length, aspect: best.aspect };
  editor.setQuads({ proj, screen });
  setStatus(t('calib.found', { n: markers.length }));
}

function runPhotoGuess() {
  const { g, w, h, s } = grayOf(st.photo);
  const q = brightRegionQuad(g, w, h);
  const proj = q ? q.map(([x, y]) => [x / s, y / s]) : defaultQuad(st.photo, 0.12);
  editor.setQuads({ proj, screen: shrink(proj, 0.04) });
  setStatus(t('calib.guessed'));
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

function patternColorFit(projQuad) {
  const aspect = st.detected ? st.detected.aspect : 16 / 9;
  const L = patternLayout(aspect);
  const H = squareToQuad(projQuad);
  const inputs = [], measured = [];
  const grayLum = [];
  for (const p of L.grays) {
    const m = sampleRect(H, p);
    if (!m) return null;
    inputs.push(p.rgb.map(srgbToLinear));
    measured.push(m);
    grayLum.push(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]);
  }
  const gamma = fitGamma(GRAYS.map(srgbToLinear), grayLum);
  for (const p of L.colors) {
    const m = sampleRect(H, p);
    if (!m) return null;
    inputs.push(p.rgb.map(srgbToLinear));
    measured.push(m);
  }
  const fit = fitAffine(inputs.map((v) => v.map((x) => Math.pow(x, gamma))), measured);
  return { fit, gamma, measured, inputs };
}

function photoColorFit(projQuad, screenQuad) {
  const ref = st.ref === 'current' ? deps.getSlideImage() : st.refCanvas;
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
function apply() {
  const { proj, screen } = editor.quads;
  if (!proj || !screen) return;
  const G = solveHomography(screen, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  if (!G) { toast(t('calib.badQuad')); return; }
  const cornersN = proj.map(([x, y]) => applyH(G, x, y));
  const p = JSON.parse(JSON.stringify(store.state.params));
  p.geometry.corners = cornersN;
  const slide = store.state.slides[store.state.current];
  const sc = computeScene(p, slide ? slide.width : 1920, slide ? slide.height : 1080);
  const color = st.tab === 'pattern' ? patternColorFit(proj) : photoColorFit(proj, screen);
  let model = null;
  if (color) {
    model = deriveModel(color.fit, color.gamma, sc.light);
    p.projector.colorMatrix = model.colorMatrix;
    p.projector.gamma = model.gamma;
    p.room.ambientLux = Math.min(5000, model.ambientLux);
    p.room.ambientColor = model.ambientColor;
  }
  store.state.params = p;
  store.state.dirty = true;
  store.emit('profile');
  store.emit('params');
  const after = computeScene(p, slide ? slide.width : 1920, slide ? slide.height : 1080);
  st.applied = { model, color, cuts: after.cuts, visible: after.visibleFrac };
  st.step = 5;
  renderSteps();
  toast(t('calib.applied'));
}

// ---------- Steps UI ----------
function step(n, title, body, state) {
  return `<div class="step ${state}"><span class="step-n">${state === 'done' ? '✓' : n}</span><div><h3>${title}</h3>${body}</div></div>`;
}

function resultsHtml() {
  const a = st.applied;
  if (!a) return '';
  const rows = [];
  const cuts = ['left', 'right', 'top', 'bottom'].filter((s) => a.cuts[s] > 0.005).map((s) => `${t('side.' + s)} ${num(a.cuts[s] * 100, 1)}%`);
  rows.push([t('calib.rVisible'), `${num(a.visible * 100, 0)}%`]);
  rows.push([t('calib.rCut'), cuts.length ? cuts.join(', ') : '—']);
  let sw = '';
  if (a.model) {
    rows.push([t('calib.rContrast'), `${num(a.model.effContrast, 1)}:1`]);
    rows.push([t('calib.rAmbient'), `≈ ${num(a.model.ambientLux)} lx`]);
    rows.push([t('calib.rGamma'), num(a.model.gamma, 2)]);
    if (a.color && a.color.measured) {
      const W = a.model.white;
      const Yw = 0.2126 * W[0] + 0.7152 * W[1] + 0.0722 * W[2];
      const cells = [];
      const ids = [0, 3, 7, 8, 9, 10, 13];
      for (const i of ids) {
        const exp = a.color.inputs[i].map((v) => Math.round(linearToSrgb(v) * 255));
        const got = a.color.measured[i].map((v) => Math.round(linearToSrgb(Math.min(1, v / Yw)) * 255));
        cells.push(`<div style="background:rgb(${exp})"><i style="background:rgb(${got})"></i></div>`);
      }
      sw = `<div class="swatches" title="${t('calib.swatchHint')}">${cells.join('')}</div><p class="muted small">${t('calib.swatchHint')}</p>`;
    }
  } else rows.push([t('calib.rColor'), t('calib.noColor')]);
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${sw}
    <label class="field"><span>${t('profiles.name')}</span><input type="text" id="calibName" maxlength="60" value="${escapeHtml(t('profiles.defaultName'))}"></label>
    <div class="btn-row" style="margin-top:8px"><button class="btn primary" id="calibSave"><svg class="ic"><use href="#i-save"/></svg>${t('calib.saveProfile')}</button>
    <button class="btn" data-close>${t('ui.done')}</button></div>`;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderSteps() {
  const box = $('calibSteps');
  const hasPhoto = !!st.photo;
  const s = (n) => (st.step > n ? 'done' : st.step === n ? 'active' : '');
  let html = '';
  if (st.tab === 'pattern') {
    html += step(1, t('calib.p1t'), `<p>${t('calib.p1b')}</p><div class="btn-row"><button class="btn" id="showPattern"><svg class="ic"><use href="#i-screen"/></svg>${t('calib.showPattern')}</button></div>`, s(1));
    html += step(2, t('calib.p2t'), `<ul>${t('calib.p2b')}</ul>`, s(2));
    html += step(3, t('calib.p3t'), `<p>${t('calib.p3b')}</p><div class="btn-row"><button class="btn primary" id="choosePhoto"><svg class="ic"><use href="#i-image"/></svg>${t('calib.choosePhoto')}</button></div>`, hasPhoto ? 'done' : s(3));
  } else {
    html += step(1, t('calib.q1t'), `<p>${t('calib.q1b')}</p><div class="btn-row"><button class="btn primary" id="choosePhoto"><svg class="ic"><use href="#i-image"/></svg>${t('calib.choosePhoto')}</button></div>`, hasPhoto ? 'done' : 'active');
    const cur = deps.getSlideImage();
    html += step(2, t('calib.q2t'), `<p>${t('calib.q2b')}</p>
      <label class="check"><input type="radio" name="refsrc" value="current" ${st.ref === 'current' ? 'checked' : ''} ${cur ? '' : 'disabled'}><span>${t('calib.refCurrent')}</span></label>
      <label class="check"><input type="radio" name="refsrc" value="file" ${st.ref !== 'current' ? 'checked' : ''}><span>${t('calib.refFile')}${st.refCanvas ? ' ✓' : ''}</span></label>
      <div class="btn-row" style="margin-top:6px"><button class="btn" id="chooseRef">${t('calib.chooseRef')}</button></div>`, hasPhoto ? (st.step > 4 ? 'done' : 'active') : '');
  }
  html += step(4, t('calib.s4t'), `<p>${t('calib.s4b')}</p><div class="btn-row"><button class="btn primary" id="applyCalib" ${hasPhoto ? '' : 'disabled'}>${t('calib.apply')}</button>
    <button class="btn" id="redetect" ${hasPhoto ? '' : 'disabled'}><svg class="ic"><use href="#i-reset"/></svg>${t('calib.redetect')}</button></div>`, hasPhoto ? (st.step > 4 ? 'done' : 'active') : '');
  if (st.applied) html += step(5, t('calib.s5t'), resultsHtml(), 'active');
  box.innerHTML = html;

  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  on('showPattern', () => { st.step = Math.max(st.step, 2); showPattern(); renderSteps(); });
  on('choosePhoto', () => pickFile('image/*', loadPhoto));
  on('chooseRef', () => pickFile('image/*', async (f) => { st.refCanvas = await readPhoto(f); st.ref = 'file'; renderSteps(); }));
  on('applyCalib', apply);
  on('redetect', () => (st.tab === 'pattern' ? runPatternDetection() : runPhotoGuess()));
  on('calibSave', async () => {
    const name = ($('calibName').value || '').trim() || t('profiles.defaultName');
    const blob = st.photo ? await thumbBlob(st.photo) : null;
    await saveProfile(name.slice(0, 60), { photo: blob });
    $('calibDlg').close();
  });
  box.querySelectorAll('input[name="refsrc"]').forEach((r) => r.addEventListener('change', () => {
    st.ref = r.value === 'current' ? 'current' : 'file';
    if (st.ref === 'file' && !st.refCanvas) pickFile('image/*', async (f) => { st.refCanvas = await readPhoto(f); renderSteps(); });
  }));
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
  editor = new QuadEditor($('calibCanvas'), $('loupe'), () => { st.applied = null; if (st.step > 4) st.step = 4; renderSteps(); });
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
