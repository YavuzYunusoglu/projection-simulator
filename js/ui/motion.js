const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => mq.matches;

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function busy(text) {
  const el = document.getElementById('busy');
  if (text == null) { el.hidden = true; return; }
  el.hidden = false;
  document.getElementById('busyText').textContent = text;
}

export function wireDialog(dlg) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
    if (e.target.closest('[data-close]')) dlg.close();
  });
}
