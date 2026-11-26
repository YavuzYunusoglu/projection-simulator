import en from '../locales/en.js';
import tr from '../locales/tr.js';

const DICTS = { en, tr };
const KEY = 'projsim.lang';
const listeners = new Set();

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && DICTS[saved]) return saved;
  } catch { /* ignore */ }
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (const l of langs) {
    const base = String(l).toLowerCase().split('-')[0];
    if (DICTS[base]) return base;
  }
  return 'en';
}

let lang = detect();

function lookup(dict, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

export function t(key, vars) {
  let s = lookup(DICTS[lang], key);
  if (s === undefined) s = lookup(DICTS.en, key);
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
  return s;
}

export const getLang = () => lang;

export function setLang(l) {
  if (!DICTS[l] || l === lang) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  applyI18n();
  for (const fn of listeners) fn(lang);
}

export const onLang = (fn) => listeners.add(fn);

export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  document.title = t('app.name');
}

const nfCache = new Map();
export function num(n, digits = 0) {
  const k = lang + digits;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat(lang === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  return nfCache.get(k).format(n);
}
