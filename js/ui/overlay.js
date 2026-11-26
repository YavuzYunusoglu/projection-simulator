// 2D overlay: projected frame outline, safe zone and problem heat map.
import { applyH } from '../sim/homography.js';
import { t, num } from '../i18n.js';
import { cssVar } from '../theme.js';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.safeAnim = 1;
    this.safeStart = 0;
    this.hatch = null;
  }

  revealSafe() { this.safeStart = performance.now(); }

  get animating() { return performance.now() - this.safeStart < 700; }

  draw(U, scene, state, analysis) {
    const { canvas, ctx } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!scene || !U) return;
    const dpr = W / canvas.clientWidth || 1;
    const aspect = W / H;
    const [cx, cy, hw] = U.cam;
    const hh = hw / aspect;
    const toPx = ([x, y]) => [((x - cx) / (2 * hw) + 0.5) * W, ((y - cy) / (2 * hh) + 0.5) * H];
    const uvToPx = (u, v) => toPx(applyH(U.H, u, v));
    const accent = cssVar('--accent-fill') || '#E39A2D';

    ctx.save();
    if (state.compare) {
      ctx.beginPath();
      ctx.rect(U.split * W, 0, W, H);
      ctx.clip();
    }

    // heat map
    if (state.overlays.heat && analysis) {
      if (!this.hatch) this.hatch = makeHatch(ctx, dpr);
      const { cols, rows } = analysis;
      for (const tile of analysis.tiles) {
        const u0 = tile.c / cols, u1 = (tile.c + 1) / cols, v0 = tile.r / rows, v1 = (tile.r + 1) / rows;
        const pts = [uvToPx(u0, v0), uvToPx(u1, v0), uvToPx(u1, v1), uvToPx(u0, v1)];
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.closePath();
        if (tile.issues.includes('cut')) {
          ctx.fillStyle = this.hatch;
        } else {
          ctx.fillStyle = tile.sev === 2 ? 'rgba(214,72,48,.42)' : 'rgba(236,166,40,.38)';
        }
        ctx.fill();
      }
    }

    // projected frame outline
    if (state.overlays.safe) {
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(40,40,40,.55)';
      ctx.beginPath();
      [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => (i ? ctx.lineTo(...uvToPx(u, v)) : ctx.moveTo(...uvToPx(u, v))));
      ctx.closePath();
      ctx.stroke();
    }

    // safe zone with draw-in animation
    if (state.overlays.safe && scene.safe) {
      const s = scene.safe;
      const pts = [uvToPx(s.x0, s.y0), uvToPx(s.x1, s.y0), uvToPx(s.x1, s.y1), uvToPx(s.x0, s.y1)];
      const per = pts.reduce((a, p, i) => a + Math.hypot(p[0] - pts[(i + 1) % 4][0], p[1] - pts[(i + 1) % 4][1]), 0);
      const k = Math.min(1, (performance.now() - this.safeStart) / 650);
      const e = 1 - Math.pow(1 - k, 3);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = accent;
      ctx.setLineDash([per * e, per]);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // labels only when the frame is big enough to carry them
      if (Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 260 * dpr) { ctx.restore(); return; }
      // label
      const fs = 11 * dpr;
      ctx.font = `500 ${fs}px "Plex Mono", ui-monospace, monospace`;
      const label = t('overlay.safe');
      const tw = ctx.measureText(label).width;
      ctx.globalAlpha = e;
      ctx.fillStyle = accent;
      const lh = fs + 8 * dpr;
      const ly = pts[0][1] - lh >= 0 ? pts[0][1] - lh : pts[0][1];
      ctx.fillRect(pts[0][0] - dpr, ly, tw + 10 * dpr, lh);
      ctx.fillStyle = '#17140F';
      ctx.fillText(label, pts[0][0] + 4 * dpr, ly + fs + 2 * dpr);
      // cut amounts on each side
      const cuts = scene.cuts;
      const tag = (txt, x, y, align) => {
        const w = ctx.measureText(txt).width + 10 * dpr;
        const bx = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
        ctx.fillStyle = 'rgba(23,20,15,.82)';
        ctx.fillRect(bx, y, w, fs + 8 * dpr);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx + 5 * dpr, y + fs + 2 * dpr);
      };
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (cuts.right > 0.005) { const m = mid(pts[1], pts[2]); tag(`−${num(cuts.right * 100, 1)}%`, m[0] - 6 * dpr, m[1], 'r'); }
      if (cuts.left > 0.005) { const m = mid(pts[0], pts[3]); tag(`−${num(cuts.left * 100, 1)}%`, m[0] + 6 * dpr, m[1], 'l'); }
      if (cuts.top > 0.005) { const m = mid(pts[0], pts[1]); tag(`−${num(cuts.top * 100, 1)}%`, m[0], m[1] - fs - 14 * dpr, 'c'); }
      if (cuts.bottom > 0.005) { const m = mid(pts[3], pts[2]); tag(`−${num(cuts.bottom * 100, 1)}%`, m[0], m[1] + 6 * dpr, 'c'); }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

function makeHatch(ctx, dpr) {
  const c = document.createElement('canvas');
  const s = Math.round(8 * dpr);
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(214,72,48,.22)';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(214,72,48,.85)';
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  g.moveTo(0, s); g.lineTo(s, 0);
  g.moveTo(-s / 2, s / 2); g.lineTo(s / 2, -s / 2);
  g.moveTo(s / 2, s * 1.5); g.lineTo(s * 1.5, s / 2);
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}
