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
    return;
  }
  const out = [];
  const c = scene.light.effContrast;
  if (c < 2.5) out.push(['bad', t('find.contrastBad', { c: num(c, 1) })]);
  else if (c < 5) out.push(['warn', t('find.contrastWarn', { c: num(c, 1) })]);
  else out.push(['ok', t('find.contrastOk', { c: num(c, c < 10 ? 1 : 0) })]);

  const cuts = scene.cuts;
  const sides = ['left', 'right', 'top', 'bottom'].filter((s) => cuts[s] > 0.005);
  if (sides.length) {
    const parts = sides.map((s) => `${t('side.' + s)} ${num(cuts[s] * 100, 1)}%`).join(', ');
    out.push(['bad', t('find.cut', { parts })]);
  } else out.push(['ok', t('find.noCut')]);

  out.push([scene.minPt > 32 ? 'warn' : 'ok', t('find.font', { pt: num(Math.ceil(scene.minPt)), d: num(params.viewer.distance, 1) })]);

  if (analysis) {
    const s = analysis.summary;
    if (s.contrastBad + s.contrastWarn) out.push([s.contrastBad ? 'bad' : 'warn', t('find.areasContrast', { n: s.contrastBad + s.contrastWarn })]);
    if (s.blurBad + s.blurWarn) out.push([s.blurBad ? 'bad' : 'warn', t('find.areasBlur', { n: s.blurBad + s.blurWarn })]);
    if (s.cut) out.push(['bad', t('find.areasCut', { n: s.cut })]);
    if (!s.contrastBad && !s.contrastWarn && !s.blurBad && !s.blurWarn && !s.cut && s.content) out.push(['ok', t('find.areasOk')]);
  }
  for (const w of slide.warnings || []) out.push(['warn', t('pptx.' + w)]);

  el.innerHTML = `<ul class="find-list">${out.map(([cls, txt], i) => `<li class="${cls}" style="animation-delay:${i * 40}ms"><span>${txt}</span></li>`).join('')}</ul>
    <div class="safe-map"><canvas id="safeMap"></canvas></div>
    <p class="muted small">${t('find.safeMapHint')}</p>`;
  drawSafeMap(el.querySelector('#safeMap'), scene, slide);
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
