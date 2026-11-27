// Application state: simulation parameters, presets and a tiny pub/sub store.

export const DEFAULT_PARAMS = {
  room: {
    ambientLux: 200,
    ambientColor: 'daylight',
    layout: { surface: 'screen', board: 'right', window: 'left', desk: 'none' },
    wallColor: null, // linear RGB albedo measured from a calibration photo
  },
  projector: {
    lumens: 3000,
    lampHealth: 60,
    contrast: 2000,
    colorTemp: 8500,
    native: 'wxga',
    focusMm: 2,
    gamma: 1,
    colorMatrix: null,
    saturation: 1,
  },
  screen: { width: 1.8, aspect: '16:10', gain: 1 },
  geometry: {
    scale: 1.12,
    offsetX: 0.075,
    offsetY: -0.02,
    keystoneV: 0.03,
    keystoneH: 0,
    rotation: -0.6,
    corners: null,
  },
  viewer: { distance: 7, acuity: 1.3, blur: false },
  // photo calibration: { quad, aspect, ratio, Ea0, Ep0, w, h } — the photo itself lives in IndexedDB
  calib: null,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Built-in profiles. `id` starting with "builtin:" cannot be deleted.
export const BUILTIN_PROFILES = [
  { id: 'builtin:reference', nameKey: 'profiles.reference', params: clone(DEFAULT_PARAMS) },
  {
    id: 'builtin:dark',
    nameKey: 'profiles.dark',
    params: merge(clone(DEFAULT_PARAMS), {
      room: { ambientLux: 8, ambientColor: 'warm' },
      projector: { lumens: 4000, lampHealth: 90, colorTemp: 6800, native: 'fhd', focusMm: 1 },
      screen: { width: 3.2, aspect: '16:9', gain: 1.1 },
      geometry: { scale: 0.98, offsetX: 0, offsetY: 0, keystoneV: 0, keystoneH: 0, rotation: 0 },
      viewer: { distance: 12, acuity: 1 },
    }),
  },
  {
    id: 'builtin:bright',
    nameKey: 'profiles.bright',
    params: merge(clone(DEFAULT_PARAMS), {
      room: { ambientLux: 600, ambientColor: 'daylight' },
      projector: { lumens: 2500, lampHealth: 70, colorTemp: 7500, native: 'xga' },
      geometry: { scale: 1, offsetX: 0, offsetY: 0, keystoneV: 0.05, keystoneH: 0, rotation: 0 },
    }),
  },
  {
    id: 'builtin:meeting',
    nameKey: 'profiles.meeting',
    params: merge(clone(DEFAULT_PARAMS), {
      room: { ambientLux: 300, ambientColor: 'neutral' },
      projector: { lumens: 3600, lampHealth: 85, contrast: 1500, colorTemp: 7000, native: 'wuxga', focusMm: 1 },
      screen: { width: 2.2, aspect: '16:10', gain: 1 },
      geometry: { scale: 0.96, offsetX: 0, offsetY: 0, keystoneV: 0.02, keystoneH: 0, rotation: 0 },
      viewer: { distance: 4, acuity: 1 },
    }),
  },
];

export const AMBIENT_PRESETS = [
  { key: 'dark', lux: 2 },
  { key: 'closed', lux: 40 },
  { key: 'lights', lux: 200 },
  { key: 'open', lux: 500 },
  { key: 'sunny', lux: 1200 },
];

export const DISTANCE_PRESETS = [
  { key: 'front', m: 2.5 },
  { key: 'middle', m: 5 },
  { key: 'back', m: 9 },
];

export function merge(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      merge(target[k], v);
    } else target[k] = Array.isArray(v) ? clone(v) : v;
  }
  return target;
}

export function sanitizeParams(p) {
  // Fill any missing keys from defaults (e.g. imported or older profiles)
  return merge(clone(DEFAULT_PARAMS), p || {});
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

const WORKING_KEY = 'projsim.working.v1';

function loadWorking() {
  try {
    const raw = localStorage.getItem(WORKING_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return { params: sanitizeParams(data.params), profileId: data.profileId || 'builtin:reference' };
    }
  } catch { /* storage unavailable */ }
  return { params: clone(DEFAULT_PARAMS), profileId: 'builtin:reference' };
}

function createStore() {
  const working = loadWorking();
  const state = {
    params: working.params,
    profileId: working.profileId,
    dirty: false,
    slides: [],
    current: -1,
    view: 'room',
    compare: false,
    overlays: { safe: true, outline: true, heat: false },
    photoOpacity: (() => { try { const v = Number(localStorage.getItem('projsim.photoOpacity')); return localStorage.getItem('projsim.photoOpacity') !== null && v >= 0 && v <= 1 ? v : 0.8; } catch { return 0.8; } })(),
  };
  const subs = new Set();
  let saveTimer = 0;
  return {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(what) {
      for (const fn of subs) fn(what, state);
      if (what === 'params' || what === 'profile') {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            localStorage.setItem(WORKING_KEY, JSON.stringify({ params: state.params, profileId: state.profileId }));
          } catch { /* ignore */ }
        }, 200);
      }
    },
    setParam(path, value) {
      setPath(state.params, path, value);
      state.dirty = true;
      this.emit('params');
    },
    setParams(params, profileId) {
      state.params = sanitizeParams(params);
      if (profileId !== undefined) state.profileId = profileId;
      state.dirty = false;
      this.emit('profile');
      this.emit('params');
    },
  };
}

export const store = createStore();
