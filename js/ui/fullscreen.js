// Full-screen mode for the stage, with a small auto-hiding toolbar.
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
  if (native()) {
    $('stage').requestFullscreen().catch(() => { pseudo = true; sync(); });
  } else {
    pseudo = true;
    sync();
  }
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
      if (!stage.querySelector('.fs-bar:hover')) stage.classList.add('fs-idle');
    }, 2500);
  }
}

function update() {
  const { slides, current, view, params } = store.state;
  $('fsCount').textContent = slides.length ? `${current + 1} / ${slides.length}` : '–';
  document.querySelectorAll('[data-fs-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fsView === view)));
  document.querySelectorAll('[data-fs-toggle]').forEach((b) => b.setAttribute('aria-pressed', $(b.dataset.fsToggle).getAttribute('aria-pressed')));
  document.querySelectorAll('#fsDist button').forEach((b) => {
    b.setAttribute('aria-pressed', String(Math.abs(params.viewer.distance - Number(b.dataset.m)) < 0.3));
  });
  $('fsBtn').hidden = !slides.length;
}

function sync() {
  const on = isFullscreen();
  $('stage').classList.toggle('is-fs', on);
  document.body.classList.toggle('pseudo-fs', pseudo);
  $('fsBtn').title = t(on ? 'fs.exit' : 'fs.enter');
  update();
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

export function initFullscreen() {
  buildDistance();
  onLang(() => { buildDistance(); sync(); });
  $('fsBtn').addEventListener('click', toggleFullscreen);
  $('glCanvas').addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('fullscreenchange', sync);
  const bar = $('fsBar');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.fs === 'prev') selectSlide(store.state.current - 1);
    if (b.dataset.fs === 'next') selectSlide(store.state.current + 1);
    if (b.dataset.fs === 'exit') exit();
    // reuse the top-bar controls so both stay in sync
    if (b.dataset.fsView) document.querySelector(`.bar [data-view="${b.dataset.fsView}"]`).click();
    if (b.dataset.fsToggle) $(b.dataset.fsToggle).click();
    update();
  });
  $('stage').addEventListener('pointermove', wake);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen()) { e.preventDefault(); exit(); return; }
    if (isFullscreen()) wake();
  });
  store.subscribe((what) => { if (['slide', 'slides', 'params', 'profile', 'chip'].includes(what)) update(); });
  update();
}
