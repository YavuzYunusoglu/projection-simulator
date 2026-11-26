// A built-in lecture-style sample slide that exercises the typical failure modes:
// light colours, thin lines, small formulas and content close to the right edge.
import { makeCanvas, canvasSlide } from './common.js';

export function sampleSlide(lang) {
  const W = 1920, H = 1080;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const tr = lang === 'tr';
  const font = (w, px) => `${w} ${px}px "Plex Sans", Calibri, "Segoe UI", Arial, sans-serif`;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);

  // title
  g.fillStyle = '#1b1b1b';
  g.font = font(600, 64);
  g.fillText(tr ? 'Işın–Küre Kesişimi' : 'Ray–Sphere Intersection', 120, 150);
  g.fillStyle = '#e2b13c';
  g.fillRect(120, 178, 180, 6);

  // body text
  g.font = font(400, 40);
  g.fillStyle = '#262626';
  const body = tr
    ? ['• Küre merkezi ile ışın arasındaki uzaklığı ölçeriz.', '• Uzaklık yarıçaptan küçük veya eşitse ışın küreyi keser.', '• Temel olarak doğru–nokta uzaklığını kullanırız.']
    : ['• Measure the distance between the sphere centre and the ray.', '• If it is less than or equal to the radius, the ray hits.', '• We reuse the line–point distance as the basis.'];
  body.forEach((l, i) => g.fillText(l, 120, 280 + i * 64));

  // light coloured note (fails in bright rooms)
  g.font = font(400, 34);
  g.fillStyle = '#9fc6e8';
  g.fillText(tr ? 'Not: açık mavi yazı aydınlık sınıfta kaybolur.' : 'Note: light blue text disappears in a bright room.', 120, 500);
  g.fillStyle = '#f3d36b';
  g.fillText(tr ? 'Sarı vurgular da öyle.' : 'So do yellow highlights.', 120, 552);

  // diagram with thin lines
  const cx = 560, cy = 800, r = 170;
  g.setLineDash([8, 8]);
  g.strokeStyle = '#555';
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(230, 610); g.lineTo(840, 1060); g.stroke();
  g.fillStyle = '#111';
  g.beginPath(); g.arc(cx, cy, 6, 0, Math.PI * 2); g.fill();
  g.font = font(400, 26);
  g.fillText('C', cx + 12, cy + 28);
  g.fillText('r', cx + 80, cy - 14);
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + r, cy); g.stroke();
  g.fillText('d', cx - 120, cy - 40);
  g.font = font(400, 22);
  g.fillStyle = '#444';
  g.fillText(tr ? 'Şekil 12.10  Doğru–küre kesişimi.' : 'Figure 12.10  Line–sphere intersection.', 230, 1040);

  // small formulas near the right edge
  g.fillStyle = '#222';
  g.font = 'italic 400 30px "Times New Roman", Times, serif';
  const fx = 1180;
  g.fillText('proj', fx, 700);
  g.font = 'italic 400 20px "Times New Roman", Times, serif';
  g.fillText('v', fx + 54, 708);
  g.font = 'italic 400 30px "Times New Roman", Times, serif';
  g.fillText('w  =  (w · v / ‖v‖²) v', fx + 70, 700);
  g.font = '400 22px "Times New Roman", Times, serif';
  g.fillText(tr ? 'Bunu doğru üzerindeki P noktasına ekleyerek izdüşüm noktası Q′ elde edilir:' : 'We add this to the line point P to get our projected point Q′, or', fx - 120, 780);
  g.font = 'italic 400 30px "Times New Roman", Times, serif';
  g.fillText("Q′  =  P + (w · v / ‖v‖²) v", fx + 40, 850);

  // page number at the far right edge
  g.font = font(500, 28);
  g.fillStyle = '#888';
  g.fillText('14 / 14', W - 150, H - 50);
  return canvasSlide(tr ? 'Örnek slayt' : 'Sample slide', c);
}
