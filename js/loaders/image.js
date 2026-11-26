import { MAX_W, makeCanvas, canvasSlide } from './common.js';

export async function loadImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_W / bmp.width, (MAX_W * 0.75) / bmp.height);
  const c = makeCanvas(bmp.width * scale, bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return [canvasSlide(file.name.replace(/\.[^.]+$/, ''), c)];
}
