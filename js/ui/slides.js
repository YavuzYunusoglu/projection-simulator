// Slide strip and file loading.
import { store } from '../state.js';
import { t } from '../i18n.js';
import { toast, busy } from './motion.js';

export function renderSlideList(list) {
  const { slides, current } = store.state;
  list.innerHTML = '';
  slides.forEach((s, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
    b.setAttribute('aria-label', `${t('slides.slide')} ${i + 1}: ${s.name}`);
    b.setAttribute('aria-current', String(i === current));
    const thumb = s.thumb;
    const img = document.createElement('canvas');
    img.width = thumb.width;
    img.height = thumb.height;
    img.getContext('2d').drawImage(thumb, 0, 0);
    b.append(img);
    if (s.warnings && s.warnings.length) {
      b.insertAdjacentHTML('beforeend', '<svg class="ic warn-mark"><use href="#i-warn"/></svg>');
    }
    b.addEventListener('click', () => selectSlide(i));
    li.append(b);
    list.append(li);
  });
}

export function markCurrent(list) {
  list.querySelectorAll('button').forEach((b, i) => {
    const on = i === store.state.current;
    b.setAttribute('aria-current', String(on));
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

export function selectSlide(i) {
  const n = store.state.slides.length;
  if (!n) return;
  store.state.current = Math.max(0, Math.min(n - 1, i));
  store.emit('slide');
}

const kind = (f) => {
  const n = f.name.toLowerCase();
  if (n.endsWith('.pdf') || f.type === 'application/pdf') return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.ppt')) return 'ppt';
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(n) || f.type.startsWith('image/')) return 'image';
  return null;
};

export async function loadFiles(files) {
  const list = Array.from(files);
  if (!list.length) return;
  const slides = [];
  for (const f of list) {
    const k = kind(f);
    try {
      if (k === 'pdf') {
        busy(t('file.reading', { name: f.name }));
        const { loadPdf } = await import('../loaders/pdf.js');
        slides.push(...await loadPdf(f, (i, n) => busy(t('file.page', { i, n }))));
      } else if (k === 'pptx') {
        busy(t('file.reading', { name: f.name }));
        const { loadPptx } = await import('../loaders/pptx.js');
        slides.push(...await loadPptx(f, (i, n) => busy(t('file.slide', { i, n }))));
      } else if (k === 'image') {
        const { loadImage } = await import('../loaders/image.js');
        slides.push(...await loadImage(f));
      } else if (k === 'ppt') {
        toast(t('file.pptOld'), 5000);
      } else {
        toast(t('file.unsupported', { name: f.name }));
      }
    } catch (err) {
      console.error(err);
      toast(t('file.failed', { name: f.name }), 4000);
    }
  }
  busy(null);
  if (!slides.length) {
    if (list.some((f) => ['pdf', 'pptx', 'image'].includes(kind(f)))) toast(t('file.empty'));
    return;
  }
  if (slides.some((s) => s.warnings && s.warnings.length)) toast(t('pptx.notice'), 5200);
  store.state.slides = slides;
  store.state.current = 0;
  store.emit('slides');
  store.emit('slide');
}

export function setSlides(slides) {
  store.state.slides = slides;
  store.state.current = 0;
  store.emit('slides');
  store.emit('slide');
}
