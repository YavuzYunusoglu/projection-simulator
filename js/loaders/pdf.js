import { RENDER_W, makeCanvas, makeSlide } from './common.js';

let pdfjs = null;

async function lib() {
  if (!pdfjs) {
    pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

async function renderPage(page, width) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const c = makeCanvas(viewport.width, viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

export async function loadPdf(file, onProgress) {
  const { getDocument } = await lib();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await getDocument({ data, isEvalSupported: false }).promise;
  const slides = [];
  const base = file.name.replace(/\.[^.]+$/, '');
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const thumb = await renderPage(page, 240);
    const h = Math.round((RENDER_W * vp.height) / vp.width);
    slides.push(makeSlide({
      name: `${base} · ${i}`,
      width: RENDER_W,
      height: h,
      thumb,
      produce: () => renderPage(page, RENDER_W),
    }));
    onProgress && onProgress(i, doc.numPages);
  }
  return slides;
}
