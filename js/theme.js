// Light / dark / system theme handling.
const KEY = 'projsim.theme';
const ORDER = ['system', 'light', 'dark'];
const listeners = new Set();
const mq = window.matchMedia('(prefers-color-scheme: dark)');

let pref = document.documentElement.dataset.themePref || 'system';

function resolved() {
  return pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
}

function apply() {
  const root = document.documentElement;
  root.dataset.themePref = pref;
  root.dataset.theme = resolved();
  for (const fn of listeners) fn(resolved(), pref);
}

mq.addEventListener('change', () => { if (pref === 'system') apply(); });

export const getThemePref = () => pref;
export const getTheme = resolved;
export const onTheme = (fn) => listeners.add(fn);

export function cycleTheme() {
  pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  apply();
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function setThemePref(p) {
  if (!ORDER.includes(p)) return;
  pref = p;
  try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  apply();
}
