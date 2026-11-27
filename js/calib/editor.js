// Photo editor with two draggable quads (projected image + screen surface) and a loupe.
import { cssVar } from '../theme.js';
import { reducedMotion } from '../ui/motion.js';

export class QuadEditor {
  constructor(canvas, loupe, onChange) {
    this.canvas = canvas;
    this.loupe = loupe;
    this.onChange = onChange;
    this.img = null;
    this.quads = { proj: null, screen: null };
    this.drag = null;
    this.selected = null;
    this.reveal = 0;
    this.picks = [];      // [{ p: [x, y], label }]
    this.pickFn = null;   // when set, a tap away from the handles picks a point
    this.revealStart = 0;
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('keydown', (e) => this.key(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** Enter (fn) or leave (null) point-picking mode. */
  setPickMode(fn) {
    this.pickFn = fn;
    this.canvas.style.cursor = fn ? 'crosshair' : 'default';
    this.draw();
  }

  setPicks(picks) {
    this.picks = picks;
    this.draw();
  }

  setImage(img) {
    this.img = img;
    this.draw();
  }

  setQuads(quads, animate = true) {
    this.quads = { proj: quads.proj && quads.proj.map((p) => [...p]), screen: quads.screen && quads.screen.map((p) => [...p]) };
    if (animate && !reducedMotion()) {
      this.revealStart = performance.now();
      const step = () => { this.draw(); if (performance.now() - this.revealStart < 1200) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    } else this.revealStart = 0;
    this.draw();
  }

  get view() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!this.img) return { W, H, s: 1, ox: 0, oy: 0, dpr };
    const pad = 28 * dpr;
    const s = Math.min((W - pad * 2) / this.img.width, (H - pad * 2) / this.img.height);
    return { W, H, s, ox: (W - this.img.width * s) / 2, oy: (H - this.img.height * s) / 2, dpr };
  }

  toCanvas([x, y]) { const v = this.view; return [v.ox + x * v.s, v.oy + y * v.s]; }
  toImage(px, py) { const v = this.view; return [(px - v.ox) / v.s, (py - v.oy) / v.s]; }

  eventPos(e) {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view;
    return [(e.clientX - r.left) * v.dpr, (e.clientY - r.top) * v.dpr];
  }

  hit(px, py) {
    const v = this.view;
    let best = null;
    for (const key of ['proj', 'screen']) {
      const q = this.quads[key];
      if (!q) continue;
      q.forEach((p, i) => {
        const [cx, cy] = this.toCanvas(p);
        const d = Math.hypot(cx - px, cy - py);
        if (d < 22 * v.dpr && (!best || d < best.d)) best = { key, i, d };
      });
    }
    return best;
  }

  down(e) {
    if (!this.img) return;
    const [px, py] = this.eventPos(e);
    const h = this.pickFn ? null : this.hit(px, py);
    if (!h) {
      if (this.pickFn) {
        const p = this.toImage(px, py);
        if (p[0] >= 0 && p[1] >= 0 && p[0] < this.img.width && p[1] < this.img.height) {
          this.showLoupe(p);
          setTimeout(() => { this.loupe.hidden = true; }, 600);
          this.pickFn(p);
        }
      }
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = h;
    this.selected = h;
    const p = this.quads[h.key][h.i];
    const [cx, cy] = this.toCanvas(p);
    this.grab = [px - cx, py - cy];
    this.showLoupe(p);
    this.draw();
  }

  move(e) {
    if (!this.img) return;
    const [px, py] = this.eventPos(e);
    if (!this.drag) {
      if (!this.pickFn) this.canvas.style.cursor = this.hit(px, py) ? 'grab' : 'default';
      return;
    }
    const p = this.toImage(px - this.grab[0], py - this.grab[1]);
    p[0] = Math.min(this.img.width * 1.5, Math.max(-this.img.width * 0.5, p[0]));
    p[1] = Math.min(this.img.height * 1.5, Math.max(-this.img.height * 0.5, p[1]));
    this.quads[this.drag.key][this.drag.i] = p;
    this.showLoupe(p);
    this.draw();
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.loupe.hidden = true;
    this.onChange && this.onChange(this.quads);
    this.draw();
  }

  key(e) {
    if (!this.selected) return;
    const d = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
    if (!mv) return;
    e.preventDefault();
    const p = this.quads[this.selected.key][this.selected.i];
    p[0] += mv[0]; p[1] += mv[1];
    this.onChange && this.onChange(this.quads);
    this.draw();
  }

  showLoupe(p) {
    const L = this.loupe;
    L.hidden = false;
    const g = L.getContext('2d');
    const z = 3;
    const size = L.width;
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.img, p[0] - size / (2 * z), p[1] - size / (2 * z), size / z, size / z, 0, 0, size, size);
    g.strokeStyle = cssVar('--accent-fill');
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
    g.moveTo(0, size / 2); g.lineTo(size, size / 2);
    g.stroke();
    const [cx, cy] = this.toCanvas(p);
    const v = this.view;
    const r = this.canvas.getBoundingClientRect();
    let lx = cx / v.dpr + 26, ly = cy / v.dpr - 158;
    if (lx + 132 > r.width) lx = cx / v.dpr - 158;
    if (ly < 4) ly = cy / v.dpr + 26;
    L.style.left = `${lx}px`;
    L.style.top = `${ly}px`;
  }

  draw() {
    const c = this.canvas;
    const v = this.view;
    if (c.width !== v.W || c.height !== v.H) { c.width = v.W; c.height = v.H; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    if (!this.img) return;
    g.drawImage(this.img, v.ox, v.oy, this.img.width * v.s, this.img.height * v.s);
    const now = performance.now();
    const colors = { proj: cssVar('--accent-fill') || '#E39A2D', screen: cssVar('--screen-line') || '#2F6F8F' };
    for (const key of ['screen', 'proj']) {
      const q = this.quads[key];
      if (!q) continue;
      const pts = q.map((p) => this.toCanvas(p));
      const offset = key === 'proj' ? 0 : 4;
      const lineK = this.revealStart ? Math.min(1, Math.max(0, (now - this.revealStart - 380 - offset * 90) / 400)) : 1;
      g.lineWidth = 2 * v.dpr;
      g.strokeStyle = colors[key];
      g.setLineDash(key === 'screen' ? [7 * v.dpr, 5 * v.dpr] : []);
      g.globalAlpha = lineK;
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p)));
      g.closePath();
      g.stroke();
      g.setLineDash([]);
      pts.forEach((p, i) => {
        // corners "lock in" one after another
        const k = this.revealStart ? Math.min(1, Math.max(0, (now - this.revealStart - (i + offset) * 90) / 260)) : 1;
        if (k <= 0) return;
        const e = 1 - Math.pow(1 - k, 3);
        const sel = this.selected && this.selected.key === key && this.selected.i === i;
        const r = (sel ? 9 : 7) * v.dpr * (1 + (1 - e) * 1.4);
        g.globalAlpha = e;
        g.fillStyle = 'rgba(0,0,0,.35)';
        g.beginPath(); g.arc(p[0], p[1], r + 2 * v.dpr, 0, Math.PI * 2); g.fill();
        g.fillStyle = colors[key];
        g.beginPath(); g.arc(p[0], p[1], r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(p[0], p[1], 2 * v.dpr, 0, Math.PI * 2); g.fill();
      });
      g.globalAlpha = 1;
    }
    // picked colour samples
    g.font = `500 ${11 * v.dpr}px "Plex Mono", ui-monospace, monospace`;
    for (const { p, label } of this.picks) {
      const [x, y] = this.toCanvas(p);
      g.lineWidth = 2 * v.dpr;
      g.strokeStyle = '#000';
      g.beginPath(); g.arc(x, y, 7 * v.dpr, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = '#fff';
      g.lineWidth = 1.2 * v.dpr;
      g.beginPath(); g.arc(x, y, 7 * v.dpr, 0, Math.PI * 2); g.stroke();
      const tw = g.measureText(label).width + 8 * v.dpr;
      g.fillStyle = 'rgba(0,0,0,.75)';
      g.fillRect(x + 9 * v.dpr, y - 8 * v.dpr, tw, 16 * v.dpr);
      g.fillStyle = '#fff';
      g.fillText(label, x + 13 * v.dpr, y + 4 * v.dpr);
    }
  }
}
