// Toolbar under the stage: view, overlays and full screen. In full screen it floats over the
// picture, adds slide navigation and seat presets, and fades out when the mouse rests.
import { store, DISTANCE_PRESETS } from '../state.js';
import { t, onLang } from '../i18n.js';
import { selectSlide } from './slides.js';

const $ = (id) => document.getElementById(id);
const native = () => !!document.documentElement.requestFullscreen;
let pseudo = false;
let idleTimer = 0;

export const isFullscreen = () => pseudo || document.fullscreenElement === $('stage');

export function toggleFullscreen() {
  if (isFullscreen()) exit(); else enter();
}

function enter() {
  if (!store.state.slides.length) return;
  if (native()) $('stage').requestFullscreen().catch(() => { pseudo = true; sync(); });
  else { pseudo = true; sync(); }
}

function exit() {
  if (pseudo) { pseudo = false; sync(); return; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function wake() {
  const stage = $('stage');
  stage.classList.remove('fs-idle');
  clearTimeout(idleTimer);
  if (isFullscreen()) {
    idleTimer = setTimeout(() => {
      if (!stage.querySelector('.stage-bar:hover')) stage.classList.add('fs-idle');
    }, 2500);
  }
}

export function updateStageBar() {
  const { slides, current, view, params, photo } = store.state;
  $('fsCount').textContent = slides.length ? `${current + 1} / ${slides.length}` : '–';
  const photoBtn = document.querySelector('#viewSeg [data-view="photo"]');
  photoBtn.hidden = !photo;
  const op = $('opacityCtl');
  op.hidden = view !== 'photo' || !photo;
  const r = $('opacityRange');
  if (document.activeElement !== r) r.value = Math.round(store.state.photoOpacity * 100);
  $('opacityVal').textContent = `${Math.round(store.state.photoOpacity * 100)}%`;
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view)));
  document.querySelectorAll('#fsDist button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Math.abs(params.viewer.distance - Number(b.dataset.m)) < 0.3));
  });
  $('stageBar').classList.toggle('disabled', !slides.length);
}

function sync() {
  const on = isFullscreen();
  $('stage').classList.toggle('is-fs', on);
  document.body.classList.toggle('pseudo-fs', pseudo);
  $('fsBtn').title = t(on ? 'fs.exit' : 'fs.enter');
  $('fsIcon').setAttribute('href', on ? '#i-collapse' : '#i-expand');
  updateStageBar();
  wake();
}

function buildDistance() {
  const box = $('fsDist');
  box.innerHTML = '';
  for (const d of DISTANCE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.m = d.m;
    b.textContent = t(`dist.${d.key}`);
    b.addEventListener('click', () => store.setParam('viewer.distance', d.m));
    box.append(b);
  }
}

export function initStageBar() {
  buildDistance();
  onLang(() => { buildDistance(); sync(); });
  $('fsBtn').addEventListener('click', toggleFullscreen);
  $('glCanvas').addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('fullscreenchange', sync);
  $('stageBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fs]');
    if (!b) return;
    if (b.dataset.fs === 'prev') selectSlide(store.state.current - 1);
    if (b.dataset.fs === 'next') selectSlide(store.state.current + 1);
    updateStageBar();
  });
  $('stage').addEventListener('pointermove', wake);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen()) { e.preventDefault(); exit(); return; }
    if (isFullscreen()) wake();
  });
  store.subscribe((what) => { if (['slide', 'slides', 'params', 'profile', 'chip', 'photo', 'view'].includes(what)) updateStageBar(); });
  updateStageBar();
}
