// Readout bar under the stage and the "What to fix" card.
import { t, num } from '../i18n.js';
import { cssVar } from '../theme.js';

export function renderReadout(el, scene, params) {
  if (!scene) { el.innerHTML = ''; return; }
  const L = scene.light;
  const c = L.effContrast;
  const items = [
    [t('ro.contrast'), `${num(c, c < 10 ? 1 : 0)}:1`, c < 2.5 ? 'hot' : c < 5 ? 'mid' : ''],
    [t('ro.screen'), `${num(L.Epw)} lx`],
    [t('ro.ambient'), `${num(L.Ea)} lx`],
    [t('ro.visible'), `${num(scene.visibleFrac * 100, 0)}%`, scene.visibleFrac < 0.97 ? 'mid' : ''],
    [t('ro.minFont', { d: num(params.viewer.distance, 1) }), `${num(Math.ceil(scene.minPt))} pt`],
    [t('ro.pixel'), `${num(scene.blur.pxArcmin, 2)}′`],
  ];
  el.innerHTML = items.map(([k, v, cls]) => `<span class="ro ${cls || ''}">${k} <b>${v}</b></span>`).join('');
}

export function renderFindings(el, scene, params, analysis, slide) {
  if (!scene || !slide) {
    el.innerHTML = `<p class="muted small">${t('find.empty')}</p>`;
    el._built = false;
    return;
  }
  const out = [];
  const c = scene.light.effContrast;
  if (c < 2.5) out.push(['contrast', 'bad', t('find.contrastBad', { c: num(c, 1) })]);
  else if (c < 5) out.push(['contrast', 'warn', t('find.contrastWarn', { c: num(c, 1) })]);
  else out.push(['contrast', 'ok', t('find.contrastOk', { c: num(c, c < 10 ? 1 : 0) })]);

  const cuts = scene.cuts;
  const sides = ['left', 'right', 'top', 'bottom'].filter((s) => cuts[s] > 0.005);
  if (sides.length) {
    const parts = sides.map((s) => `${t('side.' + s)} ${num(cuts[s] * 100, 1)}%`).join(', ');
    out.push(['cut', 'bad', t('find.cut', { parts })]);
  } else out.push(['cut', 'ok', t('find.noCut')]);

  out.push(['font', scene.minPt > 32 ? 'warn' : 'ok', t('find.font', { pt: num(Math.ceil(scene.minPt)), d: num(params.viewer.distance, 1) })]);

  if (analysis) {
    const s = analysis.summary;
    if (s.contrastBad + s.contrastWarn) out.push(['aContrast', s.contrastBad ? 'bad' : 'warn', t('find.areasContrast', { n: s.contrastBad + s.contrastWarn })]);
    if (s.blurBad + s.blurWarn) out.push(['aBlur', s.blurBad ? 'bad' : 'warn', t('find.areasBlur', { n: s.blurBad + s.blurWarn })]);
    if (s.cut) out.push(['aCut', 'bad', t('find.areasCut', { n: s.cut })]);
    if (!s.contrastBad && !s.contrastWarn && !s.blurBad && !s.blurWarn && !s.cut && s.content) out.push(['aOk', 'ok', t('find.areasOk')]);
  }
  for (const w of slide.warnings || []) out.push(['pptx-' + w, 'warn', t('pptx.' + w)]);

  // Build the skeleton once; afterwards update items in place so nothing re-animates.
  if (!el._built) {
    el.innerHTML = `<ul class="find-list"></ul><div class="safe-map"><canvas></canvas></div><p class="muted small"></p>`;
    el._built = true;
  }
  const ul = el.querySelector('.find-list');
  const existing = new Map([...ul.children].map((li) => [li.dataset.key, li]));
  let newIdx = 0;
  out.forEach(([key, cls, txt], i) => {
    let li = existing.get(key);
    if (li) existing.delete(key);
    else {
      li = document.createElement('li');
      li.dataset.key = key;
      li.innerHTML = '<span></span>';
      li.classList.add('enter');
      li.style.animationDelay = `${newIdx++ * 40}ms`;
      // drop the class once played, so moving the item later can't replay it
      li.addEventListener('animationend', () => li.classList.remove('enter'), { once: true });
    }
    li.className = `${cls}${li.classList.contains('enter') ? ' enter' : ''}`;
    const span = li.firstElementChild;
    if (span.innerHTML !== txt) span.innerHTML = txt;
    if (ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null);
  });
  for (const li of existing.values()) li.remove();
  el.querySelector('p').textContent = t('find.safeMapHint');
  drawSafeMap(el.querySelector('.safe-map canvas'), scene, slide);
}

function drawSafeMap(canvas, scene, slide) {
  const w = 292, h = Math.round(w / scene.aspect);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.drawImage(slide.thumb, 0, 0, w, h);
  // dim the part that falls off the screen
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  if (scene.visible.length >= 3) {
    scene.visible.forEach(([u, v], i) => (i ? g.lineTo(u * w, v * h) : g.moveTo(u * w, v * h)));
    g.closePath();
  }
  g.fillStyle = 'rgba(184,67,47,.45)';
  g.fill('evenodd');
  g.restore();
  if (scene.safe) {
    const s = scene.safe;
    g.strokeStyle = cssVar('--accent-fill');
    g.lineWidth = 2;
    g.setLineDash([5, 3]);
    g.strokeRect(s.x0 * w + 1, s.y0 * h + 1, (s.x1 - s.x0) * w - 2, (s.y1 - s.y0) * h - 2);
  }
}
