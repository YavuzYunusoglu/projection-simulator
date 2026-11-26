// Schema-driven settings panel.
import { store, getPath, setPath, AMBIENT_PRESETS, DISTANCE_PRESETS } from '../state.js';
import { t, num, onLang } from '../i18n.js';
import { reducedMotion } from './motion.js';

const pct = (v) => num(v * 100, 0);

const SECTIONS = [
  {
    id: 'room', icon: 'i-sun',
    sub: (p) => `${num(p.room.ambientLux)} lx`,
    items: [
      { type: 'chips', key: 'room.ambientLux', options: AMBIENT_PRESETS.map((a) => ({ value: a.lux, label: `amb.${a.key}` })), near: 0.2 },
      { type: 'range', key: 'room.ambientLux', label: 'ctl.ambient', min: 0, max: 2000, log: true, unit: 'lx', fmt: (v) => num(v), hint: 'hint.ambient' },
      { type: 'chips', key: 'room.ambientColor', label: 'ctl.ambientColor', options: [{ value: 'warm', label: 'amb.warm' }, { value: 'neutral', label: 'amb.neutral' }, { value: 'daylight', label: 'amb.daylight' }] },
    ],
  },
  {
    id: 'projector', icon: 'i-logo',
    sub: (p) => `${num(p.projector.lumens * p.projector.lampHealth / 100)} lm`,
    items: [
      { type: 'note', show: (p) => !!p.projector.colorMatrix, text: 'calib.colorActive', action: 'calib.reset', run: () => { store.setParam('projector.colorMatrix', null); store.setParam('projector.gamma', 1); } },
      { type: 'range', key: 'projector.lumens', label: 'ctl.lumens', min: 500, max: 8000, step: 100, unit: 'lm', fmt: (v) => num(v) },
      { type: 'range', key: 'projector.lampHealth', label: 'ctl.lamp', min: 25, max: 100, step: 1, unit: '%', fmt: (v) => num(v), hint: 'hint.lamp' },
      { type: 'range', key: 'projector.contrast', label: 'ctl.contrast', min: 200, max: 20000, log: true, unit: ':1', fmt: (v) => num(Math.round(v / 50) * 50) },
      { type: 'range', key: 'projector.colorTemp', label: 'ctl.colorTemp', min: 5000, max: 11000, step: 100, unit: 'K', fmt: (v) => num(v), hint: 'hint.colorTemp', disabled: (p) => !!p.projector.colorMatrix },
      { type: 'chips', key: 'projector.native', label: 'ctl.native', options: [{ value: 'svga', label: 'SVGA' }, { value: 'xga', label: 'XGA' }, { value: 'wxga', label: 'WXGA' }, { value: 'fhd', label: '1080p' }, { value: 'wuxga', label: 'WUXGA' }, { value: 'uhd', label: '4K' }], raw: true },
      { type: 'range', key: 'projector.focusMm', label: 'ctl.focus', min: 0, max: 10, step: 0.5, unit: 'mm', fmt: (v) => num(v, 1), hint: 'hint.focus' },
    ],
  },
  {
    id: 'screen', icon: 'i-screen',
    sub: (p) => `${num(p.screen.width, 2)} m · ${p.screen.aspect}`,
    items: [
      { type: 'range', key: 'screen.width', label: 'ctl.screenWidth', min: 1, max: 6, step: 0.05, unit: 'm', fmt: (v) => num(v, 2) },
      { type: 'chips', key: 'screen.aspect', label: 'ctl.screenAspect', options: ['4:3', '16:10', '16:9', '1:1'].map((v) => ({ value: v, label: v })), raw: true },
      { type: 'range', key: 'screen.gain', label: 'ctl.gain', min: 0.6, max: 2, step: 0.05, unit: '', fmt: (v) => num(v, 2), hint: 'hint.gain' },
    ],
  },
  {
    id: 'geometry', icon: 'i-safe',
    sub: (p) => (p.geometry.corners ? t('calib.calibrated') : `${pct(p.geometry.scale)}%`),
    items: [
      { type: 'note', show: (p) => !!p.geometry.corners, text: 'calib.geomActive', action: 'calib.useSliders', run: () => store.setParam('geometry.corners', null) },
      { type: 'range', key: 'geometry.scale', label: 'ctl.scale', min: 0.6, max: 1.5, step: 0.01, unit: '%', fmt: pct, hint: 'hint.scale', disabled: (p) => !!p.geometry.corners },
      { type: 'range', key: 'geometry.offsetX', label: 'ctl.offsetX', min: -0.3, max: 0.3, step: 0.005, unit: '%', fmt: (v) => (v > 0 ? '+' : '') + num(v * 100, 1), disabled: (p) => !!p.geometry.corners },
      { type: 'range', key: 'geometry.offsetY', label: 'ctl.offsetY', min: -0.3, max: 0.3, step: 0.005, unit: '%', fmt: (v) => (v > 0 ? '+' : '') + num(v * 100, 1), disabled: (p) => !!p.geometry.corners },
      { type: 'range', key: 'geometry.keystoneV', label: 'ctl.keystoneV', min: -0.25, max: 0.25, step: 0.005, unit: '%', fmt: (v) => (v > 0 ? '+' : '') + num(v * 100, 1), hint: 'hint.keystone', disabled: (p) => !!p.geometry.corners },
      { type: 'range', key: 'geometry.keystoneH', label: 'ctl.keystoneH', min: -0.25, max: 0.25, step: 0.005, unit: '%', fmt: (v) => (v > 0 ? '+' : '') + num(v * 100, 1), disabled: (p) => !!p.geometry.corners },
      { type: 'range', key: 'geometry.rotation', label: 'ctl.rotation', min: -5, max: 5, step: 0.1, unit: '°', fmt: (v) => num(v, 1), disabled: (p) => !!p.geometry.corners },
    ],
  },
  {
    id: 'viewer', icon: 'i-room',
    sub: (p) => `${num(p.viewer.distance, 1)} m`,
    items: [
      { type: 'chips', key: 'viewer.distance', options: DISTANCE_PRESETS.map((d) => ({ value: d.m, label: `dist.${d.key}` })), near: 0.12 },
      { type: 'range', key: 'viewer.distance', label: 'ctl.distance', min: 1, max: 20, step: 0.1, unit: 'm', fmt: (v) => num(v, 1), hint: 'hint.distance' },
      { type: 'chips', key: 'viewer.acuity', label: 'ctl.acuity', options: [{ value: 1, label: 'acu.sharp' }, { value: 1.3, label: 'acu.typical' }, { value: 2, label: 'acu.weak' }], near: 0.1 },
    ],
  },
];

function toSlider(it, v) {
  if (!it.log) return v;
  return Math.log10(v + 1) / Math.log10(it.max + 1) * 1000;
}
function fromSlider(it, s) {
  if (!it.log) return Number(s);
  const v = Math.pow(10, (s / 1000) * Math.log10(it.max + 1)) - 1;
  const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(v, 1))) - 1));
  return Math.max(it.min, Math.round(v / mag) * mag);
}

function animateNumber(el, from, to, fmt) {
  if (reducedMotion() || from === to || !isFinite(from)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 320;
  cancelAnimationFrame(el._raf);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

const OPEN_KEY = 'projsim.sections';
function loadOpen() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || { room: true, projector: true, viewer: true }; } catch { return { room: true, projector: true, viewer: true }; }
}

export function buildControls(root) {
  const open = loadOpen();
  const bindings = [];
  root.innerHTML = '';
  for (const sec of SECTIONS) {
    const s = document.createElement('section');
    s.className = 'acc';
    s.dataset.open = String(!!open[sec.id]);
    const head = document.createElement('button');
    head.className = 'acc-head';
    head.setAttribute('aria-expanded', String(!!open[sec.id]));
    head.innerHTML = `<svg class="ic"><use href="#i-chev"/></svg><span class="acc-title"></span><span class="acc-sub"></span>`;
    const body = document.createElement('div');
    body.className = 'acc-body';
    body.innerHTML = '<div class="acc-inner"><div class="acc-content"></div></div>';
    const content = body.querySelector('.acc-content');
    head.addEventListener('click', () => {
      const now = s.dataset.open !== 'true';
      s.dataset.open = String(now);
      head.setAttribute('aria-expanded', String(now));
      open[sec.id] = now;
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* ignore */ }
    });
    s.append(head, body);
    root.append(s);
    bindings.push({ update: (p) => {
      head.querySelector('.acc-title').textContent = t(`sec.${sec.id}`);
      head.querySelector('.acc-sub').textContent = sec.sub(p);
    } });

    for (const it of sec.items) bindings.push(buildItem(content, it));
  }
  const sync = (what) => {
    const p = store.state.params;
    for (const b of bindings) b.update(p, what);
  };
  store.subscribe((what) => { if (what === 'params' || what === 'profile' || what === 'chip') sync(what); });
  onLang(() => sync('lang'));
  sync('init');
}

function buildItem(content, it) {
  const wrap = document.createElement('div');
  if (it.type === 'note') {
    wrap.className = 'calib-note';
    wrap.innerHTML = `<svg class="ic"><use href="#i-target"/></svg><span></span><button class="btn"></button>`;
    wrap.querySelector('button').addEventListener('click', it.run);
    content.append(wrap);
    return { update: (p) => {
      wrap.hidden = !it.show(p);
      wrap.querySelector('span').textContent = t(it.text);
      wrap.querySelector('button').textContent = t(it.action);
    } };
  }
  wrap.className = 'ctl';
  if (it.type === 'range') {
    const id = 'ctl-' + it.key.replace('.', '-');
    wrap.innerHTML = `<div class="ctl-top"><label for="${id}"></label><span class="ctl-val"><span class="v"></span><small></small></span></div>
      <input type="range" id="${id}">${it.hint ? '<div class="ctl-hint"></div>' : ''}`;
    const input = wrap.querySelector('input');
    const val = wrap.querySelector('.v');
    input.min = it.log ? 0 : it.min;
    input.max = it.log ? 1000 : it.max;
    input.step = it.log ? 1 : it.step;
    let shown = NaN;
    const paint = () => {
      const k = (input.value - input.min) / (input.max - input.min);
      input.style.setProperty('--p', `${k * 100}%`);
    };
    input.addEventListener('input', () => {
      const v = fromSlider(it, Number(input.value));
      shown = v;
      val.textContent = it.fmt(v);
      paint();
      store.setParam(it.key, v);
    });
    content.append(wrap);
    return { update: (p, what) => {
      wrap.querySelector('label').textContent = t(it.label);
      wrap.querySelector('small').textContent = it.unit;
      if (it.hint) wrap.querySelector('.ctl-hint').textContent = t(it.hint);
      const v = getPath(p, it.key);
      input.disabled = it.disabled ? it.disabled(p) : false;
      wrap.style.opacity = input.disabled ? 0.45 : 1;
      if (document.activeElement !== input || what !== 'params') {
        input.value = toSlider(it, v);
        paint();
        if (v !== shown) {
          if (what === 'profile' || what === 'chip') animateNumber(val, shown, v, it.fmt);
          else val.textContent = it.fmt(v);
          shown = v;
        }
      }
    } };
  }
  if (it.type === 'chips') {
    wrap.innerHTML = `${it.label ? '<div class="ctl-top"><label></label></div>' : ''}<div class="chips" role="group"></div>`;
    const box = wrap.querySelector('.chips');
    const buttons = it.options.map((o) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.addEventListener('click', () => {
        setPath(store.state.params, it.key, o.value);
        store.state.dirty = true;
        store.emit('chip');
        store.emit('params');
      });
      box.append(b);
      return [b, o];
    });
    content.append(wrap);
    return { update: (p) => {
      if (it.label) wrap.querySelector('label').textContent = t(it.label);
      const v = getPath(p, it.key);
      for (const [b, o] of buttons) {
        b.textContent = it.raw ? o.label : t(o.label);
        const on = it.near ? Math.abs(v - o.value) <= Math.max(o.value * it.near, 0.5) : v === o.value;
        b.setAttribute('aria-pressed', String(on));
      }
    } };
  }
  return { update() {} };
}
