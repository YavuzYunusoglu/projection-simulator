// Calibration test pattern: six coded markers (corners + top/bottom centre), a grey ramp, colour patches and
// fine text. The layout is pure data (normalised 0..1 coordinates) so it can be shared by
// the renderer and the detector.

// 4×4 payloads (bit index = row*4+col, 1 = white). Minimum Hamming distance 5 across
// all rotations of all codes, so up to two bit errors are corrected.
// Order: top-left, top-right, bottom-right, bottom-left, top-centre, bottom-centre.
export const MARKER_CODES = [28466, 3755, 10523, 26786, 48357, 43428];
export const MARKER_GRID = 6; // 1-cell black border + 4×4 payload

export const bitAt = (code, r, c) => (code >> (r * 4 + c)) & 1;

export function rotateCode(code) {
  // 90° clockwise: new[r][c] = old[3-c][r]
  let o = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o |= bitAt(code, 3 - c, r) << (r * 4 + c);
  return o;
}

export const GRAYS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 7);
export const COLORS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]];

/**
 * Layout for a pattern of pixel aspect `aspect` (width / height).
 * Marker squares are square in pixels, so their uv size depends on the aspect.
 */
export function patternLayout(aspect = 16 / 9) {
  const m = 0.155, margin = 0.075; // fractions of the height
  const mw = m / aspect, mh = m, gx = margin / aspect, gy = margin;
  const markers = [
    { id: 0, x: gx, y: gy },
    { id: 1, x: 1 - gx - mw, y: gy },
    { id: 2, x: 1 - gx - mw, y: 1 - gy - mh },
    { id: 3, x: gx, y: 1 - gy - mh },
    { id: 4, x: 0.5 - mw / 2, y: gy },
    { id: 5, x: 0.5 - mw / 2, y: 1 - gy - mh },
  ].map((k) => ({ ...k, w: mw, h: mh, code: MARKER_CODES[k.id] }));

  const x0 = 0.24, x1 = 0.76;
  const grays = GRAYS.map((v, i) => {
    const w = (x1 - x0) / GRAYS.length;
    return { x: x0 + i * w, y: 0.29, w, h: 0.11, rgb: [v, v, v] };
  });
  const colors = COLORS.map((rgb, i) => {
    const w = (x1 - x0) / COLORS.length;
    return { x: x0 + i * w, y: 0.42, w, h: 0.11, rgb };
  });
  return {
    markers, grays, colors,
    // white bands used to look for the screen edges
    bandH: [0.24, 0.275],
    bandV: [gx + mw + 0.02, x0 - 0.02],
    textY: 0.6,
  };
}

/** Marker corners (TL, TR, BR, BL) in pattern uv. */
export function markerCorners(mk) {
  return [[mk.x, mk.y], [mk.x + mk.w, mk.y], [mk.x + mk.w, mk.y + mk.h], [mk.x, mk.y + mk.h]];
}

export function drawPattern(canvas, lang = 'en') {
  const W = canvas.width, H = canvas.height;
  const g = canvas.getContext('2d');
  const L = patternLayout(W / H);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  // markers
  for (const mk of L.markers) {
    const cs = (mk.w * W) / MARKER_GRID;
    const ox = mk.x * W, oy = mk.y * H;
    g.fillStyle = '#000';
    g.fillRect(ox, oy, cs * MARKER_GRID, cs * MARKER_GRID);
    g.fillStyle = '#fff';
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (bitAt(mk.code, r, c)) g.fillRect(Math.floor(ox + (c + 1) * cs), Math.floor(oy + (r + 1) * cs), Math.ceil(cs), Math.ceil(cs));
      }
    }
  }
  const patch = (p) => {
    g.fillStyle = `rgb(${p.rgb.map((v) => Math.round(v * 255)).join(',')})`;
    g.fillRect(Math.round(p.x * W), Math.round(p.y * H), Math.ceil(p.w * W), Math.ceil(p.h * H));
  };
  L.grays.forEach(patch);
  L.colors.forEach(patch);
  g.strokeStyle = '#000';
  g.lineWidth = Math.max(1, H / 900);
  const gx0 = L.grays[0].x * W, gy0 = L.grays[0].y * H;
  g.strokeRect(gx0, gy0, (L.grays.at(-1).x + L.grays.at(-1).w) * W - gx0, L.grays[0].h * H);

  // fine text for a focus / legibility check
  g.fillStyle = '#000';
  let y = L.textY * H;
  const sizes = [40, 28, 20, 14];
  const gaps = [0.065, 0.044, 0.03];
  const sample = lang === 'tr' ? 'Okunabilirlik testi — Q′ = P + (w·v/‖v‖²) v' : 'Legibility test — Q′ = P + (w·v/‖v‖²) v';
  for (const pt of sizes) {
    const px = (pt / 540) * H;
    g.font = `400 ${px}px "Plex Sans", Calibri, Arial, sans-serif`;
    g.fillText(`${pt} pt  ${sample}`, 0.24 * W, y, 0.52 * W);
    y += (gaps[sizes.indexOf(pt)] || 0) * H;
  }
  return L;
}
