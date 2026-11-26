// Shared helpers for slide loaders.
export const MAX_W = 2400;
export const RENDER_W = 1920;

let nextId = 1;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function thumbnailOf(src, width = 240) {
  const h = Math.round((width * src.height) / src.width);
  const c = makeCanvas(width, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, h);
  return c;
}

/**
 * A slide with a lazily produced full-resolution image.
 * `produce` returns a canvas; results are cached in a small LRU shared by all slides.
 */
const lru = [];
const LRU_SIZE = 6;

export function makeSlide({ name, width, height, produce, thumb, warnings = [] }) {
  const slide = {
    id: nextId++,
    name,
    width,
    height,
    aspect: width / height,
    thumb,
    warnings,
    _img: null,
    async image() {
      if (slide._img) {
        const i = lru.indexOf(slide);
        if (i >= 0) { lru.splice(i, 1); lru.push(slide); }
        return slide._img;
      }
      slide._img = await produce();
      lru.push(slide);
      while (lru.length > LRU_SIZE) {
        const old = lru.shift();
        if (old.keep) continue;
        old._img = null;
      }
      return slide._img;
    },
  };
  return slide;
}

export function canvasSlide(name, canvas, warnings = []) {
  const s = makeSlide({
    name, width: canvas.width, height: canvas.height, produce: async () => canvas,
    thumb: thumbnailOf(canvas), warnings,
  });
  s._img = canvas;
  s.keep = true;
  return s;
}
