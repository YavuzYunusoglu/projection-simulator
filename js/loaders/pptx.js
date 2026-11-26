// A small, best-effort PowerPoint (.pptx) renderer.
// Supports backgrounds, pictures, preset & custom shapes, text boxes with inherited
// placeholder styles, bullets, groups and basic tables. Charts, SmartArt and media are
// reported as warnings so the user knows to export a PDF for exact results.
import { RENDER_W, makeCanvas, makeSlide } from './common.js';

const EMU_PER_PT = 12700;

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/jszip/jszip.min.js', import.meta.url).href;
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error('jszip'));
      document.head.append(s);
    });
  }
  return jszipPromise;
}

// ---------- XML helpers ----------
const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? Array.from(el.children).find((c) => c.localName === name) || null : null);
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
function desc(el, name) {
  if (!el) return null;
  const all = el.getElementsByTagName('*');
  for (const e of all) if (e.localName === name) return e;
  return null;
}
const num = (v, d = 0) => (v == null || v === '' ? d : Number(v));
const attr = (el, name) => (el ? el.getAttribute(name) : null);
// Relationship ids live in the r: namespace (e.g. <p:sldId id="256" r:id="rId2">), so the
// namespaced attribute wins over a plain one with the same local name.
const rId = (el, name = 'embed') => {
  if (!el) return null;
  let plain = null;
  for (const a of el.attributes) {
    if (a.localName !== name) continue;
    if (a.namespaceURI) return a.value;
    plain = a.value;
  }
  return plain;
};

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ---------- Colours ----------
function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
const PRESET_COLORS = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500' };

class Deck {
  constructor(zip) {
    this.zip = zip;
    this.xmlCache = new Map();
    this.relCache = new Map();
    this.imgCache = new Map();
  }
  async xml(p) {
    if (!this.xmlCache.has(p)) {
      const f = this.zip.file(p);
      this.xmlCache.set(p, f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null);
    }
    return this.xmlCache.get(p);
  }
  async rels(part) {
    const relPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
    if (!this.relCache.has(relPath)) {
      const doc = await this.xml(relPath);
      const map = {};
      if (doc) {
        for (const r of doc.documentElement.children) {
          map[r.getAttribute('Id')] = {
            target: r.getAttribute('TargetMode') === 'External' ? null : resolvePath(part, r.getAttribute('Target')),
            type: r.getAttribute('Type') || '',
          };
        }
      }
      this.relCache.set(relPath, map);
    }
    return this.relCache.get(relPath);
  }
  async image(p) {
    if (!p) return null;
    if (!this.imgCache.has(p)) {
      this.imgCache.set(p, (async () => {
        const f = this.zip.file(p);
        if (!f) return null;
        const ext = p.split('.').pop().toLowerCase();
        const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
        if (!type) return { unsupported: ext };
        const blob = new Blob([await f.async('arraybuffer')], { type });
        try {
          if (ext === 'svg') {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.src = url;
            await img.decode();
            return img;
          }
          return await createImageBitmap(blob);
        } catch {
          return { unsupported: ext };
        }
      })());
    }
    return this.imgCache.get(p);
  }
}

// Context for one slide: theme, colour map, inheritance chain.
class SlideCtx {
  constructor(deck, theme, clrMap, scale, warnings) {
    this.deck = deck;
    this.theme = theme;
    this.clrMap = clrMap;
    this.scale = scale;
    this.warnings = warnings;
  }
  color(holder, phClr) {
    if (!holder) return null;
    let base = null, el = null;
    for (const c of holder.children) {
      const n = c.localName;
      if (n === 'srgbClr') { base = hexToRgb(attr(c, 'val')); el = c; break; }
      if (n === 'sysClr') { base = hexToRgb(attr(c, 'lastClr') || '000000'); el = c; break; }
      if (n === 'prstClr') { base = hexToRgb(PRESET_COLORS[attr(c, 'val')] || '000000'); el = c; break; }
      if (n === 'scrgbClr') { base = ['r', 'g', 'b'].map((k) => num(attr(c, k)) / 100000); el = c; break; }
      if (n === 'schemeClr') {
        let v = attr(c, 'val');
        if (v === 'phClr') { base = phClr ? [...phClr.slice(0, 3)] : [0, 0, 0]; el = c; break; }
        v = this.clrMap[v] || v;
        base = this.theme.colors[v] ? [...this.theme.colors[v]] : [0, 0, 0];
        el = c;
        break;
      }
    }
    if (!base) return null;
    let a = 1;
    let rgb = base;
    for (const m of el.children) {
      const v = num(attr(m, 'val')) / 100000;
      switch (m.localName) {
        case 'lumMod': { const hsl = rgbToHsl(rgb); hsl[2] = Math.min(1, hsl[2] * v); rgb = hslToRgb(hsl); break; }
        case 'lumOff': { const hsl = rgbToHsl(rgb); hsl[2] = Math.min(1, Math.max(0, hsl[2] + v)); rgb = hslToRgb(hsl); break; }
        case 'tint': rgb = rgb.map((x) => x * v + (1 - v)); break;
        case 'shade': rgb = rgb.map((x) => x * v); break;
        case 'satMod': { const hsl = rgbToHsl(rgb); hsl[1] = Math.min(1, hsl[1] * v); rgb = hslToRgb(hsl); break; }
        case 'alpha': a = v; break;
        default: break;
      }
    }
    return [...rgb, a];
  }
  css(c) {
    if (!c) return null;
    return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] ?? 1})`;
  }
  font(name, major) {
    if (!name) return major ? this.theme.major : this.theme.minor;
    if (name === '+mj-lt') return this.theme.major;
    if (name === '+mn-lt') return this.theme.minor;
    return name;
  }
}

async function readTheme(deck, masterPath) {
  const rels = await deck.rels(masterPath);
  const t = Object.values(rels).find((r) => r.type.endsWith('/theme'));
  const doc = t ? await deck.xml(t.target) : null;
  const colors = {};
  let major = 'Calibri Light', minor = 'Calibri';
  if (doc) {
    const scheme = desc(doc, 'clrScheme');
    if (scheme) {
      for (const c of scheme.children) {
        const s = kid(c, 'srgbClr'), sys = kid(c, 'sysClr');
        colors[c.localName] = hexToRgb(s ? attr(s, 'val') : attr(sys, 'lastClr') || '000000');
      }
    }
    const fs = desc(doc, 'fontScheme');
    if (fs) {
      major = attr(path(fs, 'majorFont', 'latin'), 'typeface') || major;
      minor = attr(path(fs, 'minorFont', 'latin'), 'typeface') || minor;
    }
  }
  return { colors, major, minor };
}

// ---------- Placeholder lookup ----------
function phInfo(sp) {
  const nv = kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || kid(sp, 'nvGraphicFramePr');
  const ph = path(nv, 'nvPr', 'ph');
  if (!ph) return null;
  return { type: attr(ph, 'type') || (attr(ph, 'idx') ? 'body' : 'obj'), idx: attr(ph, 'idx') };
}
const PH_GROUP = (t) => (t === 'title' || t === 'ctrTitle' ? 'title' : ['dt', 'ftr', 'sldNum'].includes(t) ? t : 'body');

function findPh(tree, info) {
  if (!tree || !info) return null;
  const cands = kids(tree, 'sp');
  if (info.idx != null) {
    const m = cands.find((s) => { const p = phInfo(s); return p && p.idx === info.idx; });
    if (m) return m;
  }
  return cands.find((s) => { const p = phInfo(s); return p && p.type === info.type; })
    || cands.find((s) => { const p = phInfo(s); return p && PH_GROUP(p.type) === PH_GROUP(info.type); })
    || null;
}

// ---------- Geometry ----------
function readXfrm(x) {
  if (!x) return null;
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: num(attr(off, 'x')), y: num(attr(off, 'y')),
    w: num(attr(ext, 'cx')), h: num(attr(ext, 'cy')),
    rot: num(attr(x, 'rot')) / 60000,
    flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1',
    chOff: kid(x, 'chOff') ? [num(attr(kid(x, 'chOff'), 'x')), num(attr(kid(x, 'chOff'), 'y'))] : null,
    chExt: kid(x, 'chExt') ? [num(attr(kid(x, 'chExt'), 'cx')), num(attr(kid(x, 'chExt'), 'cy'))] : null,
  };
}

const SUPPORTED_GEOM = new Set(['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'line', 'straightConnector1', 'diamond', 'parallelogram', 'trapezoid', 'hexagon', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'chevron', 'homePlate', 'snip1Rect', 'round1Rect', 'round2SameRect', 'flowChartProcess', 'flowChartAlternateProcess', 'bentConnector2', 'bentConnector3', 'plus', 'pentagon', 'octagon', 'wedgeRectCallout', 'frame', 'donut', 'can', 'cube', 'star5', 'heart']);

function geomPath(ctx, geom, w, h, sp) {
  ctx.beginPath();
  const r = Math.min(w, h);
  switch (geom) {
    case 'ellipse': case 'donut': ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'roundRect': case 'flowChartAlternateProcess': case 'round2SameRect': case 'round1Rect': {
      const rr = r * 0.16667;
      ctx.roundRect ? ctx.roundRect(0, 0, w, h, rr) : ctx.rect(0, 0, w, h);
      break;
    }
    case 'triangle': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'rtTriangle': ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'line': case 'straightConnector1': case 'bentConnector2': case 'bentConnector3': ctx.moveTo(0, 0); ctx.lineTo(w, h); break;
    case 'diamond': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h / 2); ctx.closePath(); break;
    case 'parallelogram': ctx.moveTo(r * 0.25, 0); ctx.lineTo(w, 0); ctx.lineTo(w - r * 0.25, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'trapezoid': ctx.moveTo(r * 0.25, 0); ctx.lineTo(w - r * 0.25, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'hexagon': ctx.moveTo(r * 0.25, 0); ctx.lineTo(w - r * 0.25, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w - r * 0.25, h); ctx.lineTo(r * 0.25, h); ctx.lineTo(0, h / 2); ctx.closePath(); break;
    case 'octagon': { const c = r * 0.29; ctx.moveTo(c, 0); ctx.lineTo(w - c, 0); ctx.lineTo(w, c); ctx.lineTo(w, h - c); ctx.lineTo(w - c, h); ctx.lineTo(c, h); ctx.lineTo(0, h - c); ctx.lineTo(0, c); ctx.closePath(); break; }
    case 'pentagon': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h * 0.38); ctx.lineTo(w * 0.81, h); ctx.lineTo(w * 0.19, h); ctx.lineTo(0, h * 0.38); ctx.closePath(); break;
    case 'rightArrow': ctx.moveTo(0, h * 0.25); ctx.lineTo(w - h / 2, h * 0.25); ctx.lineTo(w - h / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w - h / 2, h); ctx.lineTo(w - h / 2, h * 0.75); ctx.lineTo(0, h * 0.75); ctx.closePath(); break;
    case 'leftArrow': ctx.moveTo(w, h * 0.25); ctx.lineTo(h / 2, h * 0.25); ctx.lineTo(h / 2, 0); ctx.lineTo(0, h / 2); ctx.lineTo(h / 2, h); ctx.lineTo(h / 2, h * 0.75); ctx.lineTo(w, h * 0.75); ctx.closePath(); break;
    case 'upArrow': ctx.moveTo(w * 0.25, h); ctx.lineTo(w * 0.25, w / 2); ctx.lineTo(0, w / 2); ctx.lineTo(w / 2, 0); ctx.lineTo(w, w / 2); ctx.lineTo(w * 0.75, w / 2); ctx.lineTo(w * 0.75, h); ctx.closePath(); break;
    case 'downArrow': ctx.moveTo(w * 0.25, 0); ctx.lineTo(w * 0.75, 0); ctx.lineTo(w * 0.75, h - w / 2); ctx.lineTo(w, h - w / 2); ctx.lineTo(w / 2, h); ctx.lineTo(0, h - w / 2); ctx.lineTo(w * 0.25, h - w / 2); ctx.closePath(); break;
    case 'chevron': ctx.moveTo(0, 0); ctx.lineTo(w - h / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w - h / 2, h); ctx.lineTo(0, h); ctx.lineTo(h / 2, h / 2); ctx.closePath(); break;
    case 'homePlate': ctx.moveTo(0, 0); ctx.lineTo(w - h / 2, 0); ctx.lineTo(w, h / 2); ctx.lineTo(w - h / 2, h); ctx.lineTo(0, h); ctx.closePath(); break;
    case 'plus': { const a = r * 0.25; ctx.moveTo(a, 0); ctx.lineTo(w - a, 0); ctx.lineTo(w - a, a); ctx.lineTo(w, a); ctx.lineTo(w, h - a); ctx.lineTo(w - a, h - a); ctx.lineTo(w - a, h); ctx.lineTo(a, h); ctx.lineTo(a, h - a); ctx.lineTo(0, h - a); ctx.lineTo(0, a); ctx.lineTo(a, a); ctx.closePath(); break; }
    case 'custom': customPath(ctx, sp, w, h); break;
    default: ctx.rect(0, 0, w, h);
  }
}

function customPath(ctx, cust, w, h) {
  for (const p of kids(kid(cust, 'pathLst'), 'path')) {
    const pw = num(attr(p, 'w'), w) || w, ph = num(attr(p, 'h'), h) || h;
    const sx = w / pw, sy = h / ph;
    const pt = (e) => [num(attr(e, 'x')) * sx, num(attr(e, 'y')) * sy];
    for (const c of p.children) {
      const pts = kids(c, 'pt').map(pt);
      if (c.localName === 'moveTo') ctx.moveTo(...pts[0]);
      else if (c.localName === 'lnTo') ctx.lineTo(...pts[0]);
      else if (c.localName === 'cubicBezTo' && pts.length === 3) ctx.bezierCurveTo(...pts[0], ...pts[1], ...pts[2]);
      else if (c.localName === 'quadBezTo' && pts.length === 2) ctx.quadraticCurveTo(...pts[0], ...pts[1]);
      else if (c.localName === 'close') ctx.closePath();
    }
  }
}

// ---------- Text ----------
function lvlProps(chain, lvl) {
  // Merge pPr attributes and defRPr from a chain of lstStyle-like elements (lowest priority first).
  const p = {}, r = {};
  for (const ls of chain) {
    if (!ls) continue;
    const lp = kid(ls, `lvl${lvl + 1}pPr`);
    if (!lp) continue;
    mergePPr(p, lp);
    const d = kid(lp, 'defRPr');
    if (d) mergeRPr(r, d);
  }
  return { p, r };
}

function mergePPr(p, el) {
  for (const a of ['algn', 'marL', 'indent']) if (el.hasAttribute(a)) p[a] = el.getAttribute(a);
  for (const c of el.children) {
    switch (c.localName) {
      case 'buNone': p.bullet = null; break;
      case 'buChar': p.bullet = { char: attr(c, 'char') }; break;
      case 'buAutoNum': p.bullet = { auto: attr(c, 'type') || 'arabicPeriod', start: num(attr(c, 'startAt'), 1) }; break;
      case 'buClr': p.buClr = c; break;
      case 'buSzPct': p.buSz = num(attr(c, 'val')) / 100000; break;
      case 'buFont': p.buFont = attr(c, 'typeface'); break;
      case 'lnSpc': { const pc = kid(c, 'spcPct'), pt = kid(c, 'spcPts'); p.lnSpc = pc ? { pct: num(attr(pc, 'val')) / 100000 } : pt ? { pts: num(attr(pt, 'val')) / 100 } : p.lnSpc; break; }
      case 'spcBef': { const pc = kid(c, 'spcPct'), pt = kid(c, 'spcPts'); p.spcBef = pc ? { pct: num(attr(pc, 'val')) / 100000 } : pt ? { pts: num(attr(pt, 'val')) / 100 } : p.spcBef; break; }
      case 'spcAft': { const pc = kid(c, 'spcPct'), pt = kid(c, 'spcPts'); p.spcAft = pc ? { pct: num(attr(pc, 'val')) / 100000 } : pt ? { pts: num(attr(pt, 'val')) / 100 } : p.spcAft; break; }
      default: break;
    }
  }
}

function mergeRPr(r, el) {
  if (el.hasAttribute('sz')) r.sz = num(el.getAttribute('sz')) / 100;
  if (el.hasAttribute('b')) r.b = el.getAttribute('b') === '1' || el.getAttribute('b') === 'true';
  if (el.hasAttribute('i')) r.i = el.getAttribute('i') === '1' || el.getAttribute('i') === 'true';
  if (el.hasAttribute('u')) r.u = el.getAttribute('u') !== 'none';
  if (el.hasAttribute('baseline')) r.baseline = num(el.getAttribute('baseline')) / 100000;
  if (el.hasAttribute('cap')) r.cap = el.getAttribute('cap');
  for (const c of el.children) {
    if (c.localName === 'solidFill') r.fill = c;
    else if (c.localName === 'noFill') r.fill = null;
    else if (c.localName === 'latin') r.font = attr(c, 'typeface');
  }
}

function autoNum(type, n) {
  const roman = (x) => { const v = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [k, r] of v) while (x >= k) { s += r; x -= k; } return s; };
  let core = String(n);
  if (type.startsWith('alphaLc')) core = String.fromCharCode(96 + ((n - 1) % 26) + 1);
  else if (type.startsWith('alphaUc')) core = String.fromCharCode(64 + ((n - 1) % 26) + 1);
  else if (type.startsWith('romanLc')) core = roman(n);
  else if (type.startsWith('romanUc')) core = roman(n).toUpperCase();
  if (type.endsWith('ParenR')) return core + ')';
  if (type.endsWith('ParenBoth')) return '(' + core + ')';
  if (type.endsWith('Plain')) return core;
  return core + '.';
}

function drawText(ctx, S, txBody, box, chain, defaults) {
  if (!txBody) return;
  const bodyPrs = [...defaults.bodyPr, kid(txBody, 'bodyPr')].filter(Boolean);
  const bp = (a, d) => { let v = d; for (const b of bodyPrs) if (b.hasAttribute(a)) v = b.getAttribute(a); return v; };
  const s = S.scale;
  const lIns = num(bp('lIns', 91440)) * s, rIns = num(bp('rIns', 91440)) * s;
  const tIns = num(bp('tIns', 45720)) * s, bIns = num(bp('bIns', 45720)) * s;
  const anchor = bp('anchor', defaults.anchor || 't');
  const wrap = bp('wrap', 'square') !== 'none';
  let fontScale = 1, lnRed = 0;
  for (const b of bodyPrs) {
    const na = kid(b, 'normAutofit');
    if (na) { fontScale = num(attr(na, 'fontScale'), 100000) / 100000; lnRed = num(attr(na, 'lnSpcReduction'), 0) / 100000; }
  }
  const innerW = Math.max(1, box.w - lIns - rIns);
  const lst = kid(txBody, 'lstStyle');
  const fullChain = [...chain, lst];

  const lines = [];
  const counters = {};
  let totalH = 0;
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = num(attr(pPr, 'lvl'), 0);
    const base = lvlProps(fullChain, lvl);
    const pp = { ...base.p };
    if (pPr) mergePPr(pp, pPr);
    const runs = [];
    for (const c of p.children) {
      if (c.localName === 'r' || c.localName === 'fld') {
        const rp = { ...base.r };
        const rPr = kid(c, 'rPr');
        if (rPr) mergeRPr(rp, rPr);
        let text = (kid(c, 't') || {}).textContent || '';
        if (rp.cap === 'all') text = text.toUpperCase();
        runs.push({ text, rp });
      } else if (c.localName === 'br') {
        const rp = { ...base.r };
        runs.push({ br: true, rp });
      }
    }
    const endRPr = kid(p, 'endParaRPr');
    const emptyRp = { ...base.r };
    if (endRPr) mergeRPr(emptyRp, endRPr);
    const runSize = (rp) => (rp.sz || defaults.sz || 18) * fontScale * EMU_PER_PT * s;
    const fontFor = (rp) => {
      const px = runSize(rp) * (rp.baseline ? 0.7 : 1);
      const fam = S.font(rp.font, defaults.major);
      return `${rp.i ? 'italic ' : ''}${rp.b ? '700 ' : '400 '}${px.toFixed(2)}px "${fam}", Calibri, Carlito, "Segoe UI", Arial, sans-serif`;
    };
    const color = (rp) => S.css(S.color(rp.fill)) || defaults.color;

    const marL = num(pp.marL, 0) * s, indent = num(pp.indent, 0) * s;
    let bullet = null;
    const hasText = runs.some((r) => r.text && r.text.trim());
    if (pp.bullet && hasText) {
      if (pp.bullet.char) bullet = pp.bullet.char;
      else if (pp.bullet.auto) {
        const key = lvl + pp.bullet.auto;
        counters[key] = (counters[key] || pp.bullet.start - 1) + 1;
        bullet = autoNum(pp.bullet.auto, counters[key]);
      }
    }
    // reset deeper numbering when going up a level
    for (const k of Object.keys(counters)) if (Number(k[0]) > lvl) delete counters[k];

    const firstRp = runs.find((r) => r.text)?.rp || emptyRp;
    const maxPx = Math.max(runSize(firstRp), ...runs.filter((r) => r.text).map((r) => runSize(r.rp)));
    const lnSpc = pp.lnSpc?.pct != null ? pp.lnSpc.pct * (1 - lnRed) : 1 - lnRed;
    const lineH = pp.lnSpc?.pts ? pp.lnSpc.pts * EMU_PER_PT * s : maxPx * 1.2 * lnSpc;
    const spc = (v) => (!v ? 0 : v.pts != null ? v.pts * EMU_PER_PT * s : v.pct * maxPx * 1.2);

    // word wrap
    const avail = innerW - marL;
    const pLines = [];
    let cur = { segs: [], w: 0 };
    const push = () => { pLines.push(cur); cur = { segs: [], w: 0 }; };
    for (const run of runs) {
      if (run.br) { push(); continue; }
      ctx.font = fontFor(run.rp);
      const tokens = run.text.split(/(\s+)/).filter((x) => x.length);
      for (const tok of tokens) {
        const tw = ctx.measureText(tok).width;
        if (wrap && cur.w + tw > avail && cur.segs.length && !/^\s+$/.test(tok)) push();
        if (!cur.segs.length && /^\s+$/.test(tok) && pLines.length) continue;
        cur.segs.push({ text: tok, w: tw, font: fontFor(run.rp), color: color(run.rp), u: run.rp.u, base: run.rp.baseline || 0, px: runSize(run.rp) });
        cur.w += tw;
      }
    }
    push();
    const bef = lines.length ? spc(pp.spcBef) : 0;
    totalH += bef;
    pLines.forEach((ln, i) => {
      lines.push({
        ...ln, h: lineH, x: marL, algn: pp.algn || defaults.algn || 'l',
        bullet: i === 0 ? bullet : null, bulletX: marL + indent,
        bulletColor: pp.buClr ? S.css(S.color(pp.buClr)) : (ln.segs[0]?.color || color(firstRp)),
        bulletFont: `${maxPx * (pp.buSz || 1)}px ${pp.buFont ? `"${pp.buFont}", ` : ''}Arial, sans-serif`,
        before: i === 0 ? bef : 0,
        ascent: maxPx * 0.95,
      });
      totalH += lineH;
    });
    totalH += spc(pp.spcAft);
    if (lines.length) lines[lines.length - 1].after = spc(pp.spcAft);
  }

  const innerH = box.h - tIns - bIns;
  let y = tIns;
  if (anchor === 'ctr') y += (innerH - totalH) / 2;
  else if (anchor === 'b') y += innerH - totalH;
  ctx.textBaseline = 'alphabetic';
  for (const ln of lines) {
    y += ln.before;
    const baseY = y + ln.h * 0.8;
    const contentW = ln.segs.reduce((a, sg) => a + sg.w, 0);
    let x = lIns + ln.x;
    const avail = innerW - ln.x;
    if (ln.algn === 'ctr') x += (avail - contentW) / 2;
    else if (ln.algn === 'r') x += avail - contentW;
    if (ln.bullet) {
      ctx.font = ln.bulletFont;
      ctx.fillStyle = ln.bulletColor;
      ctx.fillText(ln.bullet, lIns + ln.bulletX, baseY);
    }
    for (const sg of ln.segs) {
      ctx.font = sg.font;
      ctx.fillStyle = sg.color;
      const by = baseY - sg.base * sg.px;
      ctx.fillText(sg.text, x, by);
      if (sg.u) ctx.fillRect(x, by + sg.px * 0.12, sg.w, Math.max(1, sg.px * 0.06));
      x += sg.w;
    }
    y += ln.h + (ln.after || 0);
  }
}

// ---------- Rendering of shape trees ----------
async function drawTree(ctx, S, tree, inherit, tf) {
  for (const el of tree.children) {
    switch (el.localName) {
      case 'sp': case 'cxnSp': await drawShape(ctx, S, el, inherit, tf); break;
      case 'pic': await drawPic(ctx, S, el, tf); break;
      case 'grpSp': {
        const x = readXfrm(path(el, 'grpSpPr', 'xfrm'));
        let child = tf;
        if (x && x.chExt && x.chExt[0] && x.chExt[1]) {
          const sx = x.w / x.chExt[0], sy = x.h / x.chExt[1];
          child = (b) => tf({ ...b, x: x.x + (b.x - x.chOff[0]) * sx, y: x.y + (b.y - x.chOff[1]) * sy, w: b.w * sx, h: b.h * sy });
        }
        await drawTree(ctx, S, el, inherit, child);
        break;
      }
      case 'graphicFrame': await drawFrame(ctx, S, el, tf); break;
      case 'AlternateContent': {
        const alt = kid(el, 'Fallback') || kid(el, 'Choice');
        if (alt) await drawTree(ctx, S, alt, inherit, tf);
        break;
      }
      default: break;
    }
  }
}

function withBox(ctx, S, x, fn) {
  const s = S.scale;
  const b = { x: x.x * s, y: x.y * s, w: x.w * s, h: x.h * s };
  ctx.save();
  ctx.translate(b.x + b.w / 2, b.y + b.h / 2);
  if (x.rot) ctx.rotate((x.rot * Math.PI) / 180);
  ctx.scale(x.flipH ? -1 : 1, x.flipV ? -1 : 1);
  ctx.translate(-b.w / 2, -b.h / 2);
  fn(b);
  ctx.restore();
}

function fillFrom(S, spPr, style, fallbackRef) {
  if (spPr) {
    if (kid(spPr, 'noFill')) return null;
    const sf = kid(spPr, 'solidFill');
    if (sf) return S.css(S.color(sf));
    const gf = kid(spPr, 'gradFill');
    if (gf) {
      const gs = kids(kid(gf, 'gsLst'), 'gs');
      if (gs.length) return S.css(S.color(gs[Math.floor(gs.length / 2)]));
    }
  }
  const ref = kid(style, fallbackRef);
  if (ref && num(attr(ref, 'idx')) > 0) return S.css(S.color(ref));
  return null;
}

async function drawShape(ctx, S, sp, inherit, tf) {
  const spPr = kid(sp, 'spPr');
  const style = kid(sp, 'style');
  const info = phInfo(sp);
  const layoutPh = info ? findPh(inherit.layoutTree, info) : null;
  const masterPh = info ? findPh(inherit.masterTree, info) : null;
  let x = readXfrm(kid(spPr, 'xfrm'))
    || readXfrm(path(layoutPh, 'spPr', 'xfrm'))
    || readXfrm(path(masterPh, 'spPr', 'xfrm'));
  if (!x) return;
  x = tf(x);
  const prst = kid(spPr, 'prstGeom');
  const cust = kid(spPr, 'custGeom');
  let geom = prst ? attr(prst, 'prst') : cust ? 'custom' : 'rect';
  if (!SUPPORTED_GEOM.has(geom) && geom !== 'custom') { S.warnings.add('shapes'); geom = 'rect'; }
  const fill = fillFrom(S, spPr, style, 'fillRef');
  const ln = kid(spPr, 'ln');
  let stroke = null, lw = 0;
  if (ln && kid(ln, 'noFill')) stroke = null;
  else if (ln && kid(ln, 'solidFill')) stroke = S.css(S.color(kid(ln, 'solidFill')));
  else {
    const ref = kid(style, 'lnRef');
    if (ref && num(attr(ref, 'idx')) > 0) stroke = S.css(S.color(ref));
  }
  if (stroke) lw = Math.max(1, num(attr(ln, 'w'), 12700) * S.scale);
  const isLine = ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3'].includes(geom) || sp.localName === 'cxnSp';

  withBox(ctx, S, x, (b) => {
    if (fill && !isLine) {
      geomPath(ctx, geom, b.w, b.h, cust);
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      geomPath(ctx, isLine && geom === 'rect' ? 'line' : geom, b.w, b.h, cust);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      const dash = attr(kid(ln, 'prstDash'), 'val');
      if (dash && dash !== 'solid') ctx.setLineDash([lw * 3, lw * 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (isLine) {
        const head = (end, fx, fy, tx, ty) => {
          if (!end || attr(end, 'type') === 'none' || !attr(end, 'type')) return;
          const ang = Math.atan2(ty - fy, tx - fx), L = lw * 4.5;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - L * Math.cos(ang - 0.45), ty - L * Math.sin(ang - 0.45));
          ctx.lineTo(tx - L * Math.cos(ang + 0.45), ty - L * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fillStyle = stroke;
          ctx.fill();
        };
        head(kid(ln, 'tailEnd'), 0, 0, b.w, b.h);
        head(kid(ln, 'headEnd'), b.w, b.h, 0, 0);
      }
    }
    // picture fill inside a shape is handled asynchronously below
  });

  const blipFill = kid(spPr, 'blipFill');
  if (blipFill) await drawBlip(ctx, S, blipFill, x, inherit.part, geom, cust);

  const tx = kid(sp, 'txBody');
  if (tx) {
    const grp = info ? PH_GROUP(info.type) : null;
    const txStyle = grp === 'title' ? inherit.titleStyle : info ? inherit.bodyStyle : inherit.otherStyle;
    const chain = [txStyle, kid(path(masterPh, 'txBody'), 'lstStyle'), kid(path(layoutPh, 'txBody'), 'lstStyle')];
    const fontRef = kid(style, 'fontRef');
    const defColor = fontRef ? S.css(S.color(fontRef)) : null;
    withBox(ctx, S, { ...x, flipH: false, flipV: false }, (b) => {
      drawText(ctx, S, tx, b, chain, {
        bodyPr: [path(masterPh, 'txBody', 'bodyPr'), path(layoutPh, 'txBody', 'bodyPr')].filter(Boolean),
        anchor: grp === 'title' ? 'ctr' : 't',
        color: defColor || S.css(S.color({ children: [schemeEl('tx1')] })) || '#000',
        major: grp === 'title',
        sz: 18,
      });
    });
  }
}

async function drawBlip(ctx, S, blipFill, x, part, geom = 'rect', cust = null) {
  const blip = kid(blipFill, 'blip');
  const id = rId(blip, 'embed');
  if (!id) { if (rId(blip, 'link')) S.warnings.add('images'); return; }
  const rels = await S.deck.rels(part);
  const img = await S.deck.image(rels[id]?.target);
  if (!img) return;
  if (img.unsupported) { S.warnings.add('images'); return; }
  const src = kid(blipFill, 'srcRect');
  const iw = img.width, ih = img.height;
  const l = num(attr(src, 'l')) / 100000, t = num(attr(src, 't')) / 100000;
  const r = num(attr(src, 'r')) / 100000, bt = num(attr(src, 'b')) / 100000;
  withBox(ctx, S, x, (b) => {
    ctx.save();
    if (geom !== 'rect') { geomPath(ctx, geom, b.w, b.h, cust); ctx.clip(); }
    try {
      ctx.drawImage(img, iw * l, ih * t, iw * (1 - l - r), ih * (1 - t - bt), 0, 0, b.w, b.h);
    } catch { /* zero-size crop */ }
    ctx.restore();
  });
}

async function drawPic(ctx, S, pic, tf) {
  const x0 = readXfrm(path(pic, 'spPr', 'xfrm'));
  if (!x0) return;
  const x = tf(x0);
  const nvPr = path(pic, 'nvPicPr', 'nvPr');
  if (nvPr && (desc(nvPr, 'videoFile') || desc(nvPr, 'audioFile') || desc(nvPr, 'media'))) S.warnings.add('media');
  const prst = attr(path(pic, 'spPr', 'prstGeom'), 'prst') || 'rect';
  await drawBlip(ctx, S, kid(pic, 'blipFill'), x, S.part, SUPPORTED_GEOM.has(prst) ? prst : 'rect');
}

async function drawFrame(ctx, S, frame, tf) {
  const x0 = readXfrm(kid(frame, 'xfrm'));
  const data = path(frame, 'graphic', 'graphicData');
  const uri = attr(data, 'uri') || '';
  if (!x0) return;
  const x = tf(x0);
  if (uri.endsWith('/table')) { drawTable(ctx, S, kid(data, 'tbl'), x); return; }
  // OLE objects (e.g. legacy equations) usually carry a preview picture
  const pic = desc(data, 'pic');
  if (pic) {
    await drawBlip(ctx, S, kid(pic, 'blipFill'), x, S.part);
    return;
  }
  S.warnings.add(uri.includes('chart') ? 'charts' : uri.includes('diagram') ? 'smartart' : 'objects');
  withBox(ctx, S, x, (b) => {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = 'rgba(120,120,120,.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, b.w - 2, b.h - 2);
    ctx.restore();
  });
}

function drawTable(ctx, S, tbl, x) {
  if (!tbl) return;
  const s = S.scale;
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(attr(c, 'w')) * s);
  let y = x.y * s;
  const firstRow = attr(kid(tbl, 'tblPr'), 'firstRow') === '1';
  kids(tbl, 'tr').forEach((tr, ri) => {
    const h = num(attr(tr, 'h')) * s;
    let cx = x.x * s;
    kids(tr, 'tc').forEach((tc, ci) => {
      const w = cols[ci] || 0;
      const span = num(attr(tc, 'gridSpan'), 1);
      let cw = w;
      for (let k = 1; k < span; k++) cw += cols[ci + k] || 0;
      const tcPr = kid(tc, 'tcPr');
      const fill = fillFrom(S, tcPr, null, 'x') || (firstRow && ri === 0 ? S.css(S.color({ children: [schemeEl('accent1')] })) : null);
      if (fill) { ctx.fillStyle = fill; ctx.fillRect(cx, y, cw, h); }
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx, y, cw, h);
      ctx.save();
      ctx.translate(cx, y);
      drawText(ctx, S, kid(tc, 'txBody'), { w: cw, h }, [S.otherStyle], {
        bodyPr: [], anchor: attr(tcPr, 'anchor') || 't', color: firstRow && ri === 0 ? '#fff' : '#000', sz: 18,
      });
      ctx.restore();
      cx += w;
    });
    y += h;
  });
}

function schemeEl(val) {
  const e = document.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:schemeClr');
  e.setAttribute('val', val);
  return e;
}

async function drawBackground(ctx, S, chain, w, h) {
  for (const { doc, part } of chain) {
    const bg = desc(path(doc.documentElement, 'cSld'), 'bg');
    if (!bg) continue;
    const bgPr = kid(bg, 'bgPr');
    const bgRef = kid(bg, 'bgRef');
    if (bgPr) {
      const blip = kid(bgPr, 'blipFill');
      if (blip) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        await drawBlip(ctx, S, blip, { x: 0, y: 0, w: w / S.scale, h: h / S.scale }, part);
        return;
      }
      const f = fillFrom(S, bgPr, null, 'x');
      if (f) { ctx.fillStyle = f; ctx.fillRect(0, 0, w, h); return; }
    }
    if (bgRef) {
      ctx.fillStyle = S.css(S.color(bgRef)) || '#fff';
      ctx.fillRect(0, 0, w, h);
      return;
    }
  }
  ctx.fillStyle = S.css(S.theme.colors[S.clrMap.bg1 || 'lt1'] ? [...S.theme.colors[S.clrMap.bg1 || 'lt1'], 1] : [1, 1, 1, 1]);
  ctx.fillRect(0, 0, w, h);
}

async function renderSlide(deck, slidePath, size, width) {
  const scale = width / size.cx;
  const W = width, H = Math.round(size.cy * scale);
  const slideDoc = await deck.xml(slidePath);
  const sRels = await deck.rels(slidePath);
  const layoutPath = Object.values(sRels).find((r) => r.type.endsWith('/slideLayout'))?.target;
  const layoutDoc = layoutPath ? await deck.xml(layoutPath) : null;
  const lRels = layoutPath ? await deck.rels(layoutPath) : {};
  const masterPath = Object.values(lRels).find((r) => r.type.endsWith('/slideMaster'))?.target;
  const masterDoc = masterPath ? await deck.xml(masterPath) : null;
  const theme = masterPath ? await readTheme(deck, masterPath) : { colors: {}, major: 'Calibri Light', minor: 'Calibri' };
  const clrMapEl = masterDoc ? kid(masterDoc.documentElement, 'clrMap') : null;
  const clrMap = {};
  if (clrMapEl) for (const a of clrMapEl.attributes) clrMap[a.name] = a.value;
  else Object.assign(clrMap, { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' });

  const warnings = new Set();
  const S = new SlideCtx(deck, theme, clrMap, scale, warnings);
  const txStyles = masterDoc ? kid(masterDoc.documentElement, 'txStyles') : null;
  S.otherStyle = kid(txStyles, 'otherStyle');

  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const chain = [{ doc: slideDoc, part: slidePath }, layoutDoc && { doc: layoutDoc, part: layoutPath }, masterDoc && { doc: masterDoc, part: masterPath }].filter(Boolean);
  S.part = slidePath;
  await drawBackground(ctx, S, chain, W, H);

  const tree = (doc) => (doc ? path(doc.documentElement, 'cSld', 'spTree') : null);
  const inheritBase = {
    layoutTree: tree(layoutDoc), masterTree: tree(masterDoc),
    titleStyle: kid(txStyles, 'titleStyle'), bodyStyle: kid(txStyles, 'bodyStyle'), otherStyle: kid(txStyles, 'otherStyle'),
  };
  const identity = (b) => b;
  // decorative (non-placeholder) shapes from master and layout
  const nonPh = (t) => {
    if (!t) return null;
    const clone = t.cloneNode(true);
    for (const el of Array.from(clone.children)) if (phInfo(el)) el.remove();
    return clone;
  };
  const showMaster = (doc) => !doc || attr(doc.documentElement, 'showMasterSp') !== '0';
  if (masterDoc && showMaster(slideDoc) && showMaster(layoutDoc)) {
    S.part = masterPath;
    await drawTree(ctx, S, nonPh(tree(masterDoc)), { ...inheritBase, part: masterPath }, identity);
  }
  if (layoutDoc && showMaster(slideDoc)) {
    S.part = layoutPath;
    await drawTree(ctx, S, nonPh(tree(layoutDoc)), { ...inheritBase, part: layoutPath }, identity);
  }
  S.part = slidePath;
  await drawTree(ctx, S, tree(slideDoc), { ...inheritBase, part: slidePath }, identity);
  return { canvas: c, warnings: [...warnings] };
}

export async function loadPptx(file, onProgress) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const deck = new Deck(zip);
  const pres = await deck.xml('ppt/presentation.xml');
  if (!pres) throw new Error('pptx');
  const sz = desc(pres, 'sldSz');
  const size = { cx: num(attr(sz, 'cx'), 12192000), cy: num(attr(sz, 'cy'), 6858000) };
  const rels = await deck.rels('ppt/presentation.xml');
  const ids = kids(desc(pres, 'sldIdLst'), 'sldId');
  const base = file.name.replace(/\.[^.]+$/, '');
  const slides = [];
  const H = Math.round((RENDER_W * size.cy) / size.cx);
  let i = 0;
  for (const s of ids) {
    i++;
    const target = rels[rId(s, 'id')]?.target;
    if (!target) continue;
    const first = await renderSlide(deck, target, size, 240);
    const thumb = first.canvas;
    const slide = makeSlide({
      name: `${base} · ${i}`,
      width: RENDER_W,
      height: H,
      thumb,
      warnings: first.warnings,
      produce: async () => (await renderSlide(deck, target, size, RENDER_W)).canvas,
    });
    slides.push(slide);
    onProgress && onProgress(i, ids.length);
  }
  return slides;
}
