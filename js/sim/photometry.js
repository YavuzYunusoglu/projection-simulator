// Photometric model of a front projector in a lit room.
// All illuminance values are in lux; luminance of a lambertian surface is E·ρ/π.

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Approximate RGB of a black body at temperature K (Tanner Helland fit), in linear sRGB.
function blackBody(K) {
  const t = K / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [r, g, b].map((v) => srgbToLinear(Math.min(255, Math.max(0, v)) / 255));
}

const D65 = blackBody(6500);

// Chromaticity of a light source relative to the D65 display white, luminance-normalised to 1.
export function cctTint(K) {
  const c = blackBody(K).map((v, i) => v / D65[i]);
  const y = luminance(c);
  return c.map((v) => v / y);
}

export const AMBIENT_CCT = { warm: 3000, neutral: 4200, daylight: 6500 };

export const NATIVE_RES = {
  svga: [800, 600],
  xga: [1024, 768],
  wxga: [1280, 800],
  fhd: [1920, 1080],
  wuxga: [1920, 1200],
  uhd: [3840, 2160],
};

export const SCREEN_ASPECTS = { '4:3': 4 / 3, '16:10': 16 / 10, '16:9': 16 / 9, '1:1': 1 };

export function screenSize(params) {
  const w = params.screen.width;
  return { w, h: w / SCREEN_ASPECTS[params.screen.aspect] };
}

/**
 * Corners (TL, TR, BR, BL) of the projected image in screen-normalised coordinates,
 * where the white screen surface spans [0,1]×[0,1].
 */
export function projectionCorners(params, slideAspect) {
  const g = params.geometry;
  if (g.corners) return g.corners.map((p) => [...p]);
  const { w: sw, h: sh } = screenSize(params);
  // work in metres, centred on the screen
  const pw = g.scale * sw;
  const ph = pw / slideAspect;
  const cx = g.offsetX * sw, cy = g.offsetY * sh;
  const kv = g.keystoneV, kh = g.keystoneH;
  const raw = [
    [-pw / 2 * (1 + kv), -ph / 2 * (1 + kh)],
    [pw / 2 * (1 + kv), -ph / 2 * (1 - kh)],
    [pw / 2 * (1 - kv), ph / 2 * (1 - kh)],
    [-pw / 2 * (1 - kv), ph / 2 * (1 + kh)],
  ];
  const a = (g.rotation * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  return raw.map(([x, y]) => {
    const rx = x * ca - y * sa + cx, ry = x * sa + y * ca + cy;
    return [rx / sw + 0.5, ry / sh + 0.5];
  });
}

/** Lighting quantities derived from the parameters. */
export function computeLighting(params, cornersMeters, area) {
  const p = params.projector, r = params.room;
  const lumens = p.lumens * (p.lampHealth / 100);
  const uniformity = 0.88; // average over the frame relative to centre-weighted output
  const Epw = (lumens * uniformity) / Math.max(area, 0.05);
  const Epb = Epw / Math.max(p.contrast, 1);
  const Ea = r.ambientLux;
  // Surroundings are partly white-balanced by the eye on their own, so the room light's
  // colour is shown at reduced strength.
  const rawAmb = cctTint(AMBIENT_CCT[r.ambientColor] || 4200).map((v) => Math.pow(v, 0.45));
  const ambY = luminance(rawAmb);
  const ambCol = rawAmb.map((v) => v / ambY);
  const tint = cctTint(p.colorTemp);
  const gain = params.screen.gain;
  // Effective on-screen contrast for a full white vs full black frame
  const effContrast = (Epw + Ea) / (Epb + Ea);
  return { lumens, Epw, Epb, Ea, ambCol, tint, gain, effContrast };
}

const LUMA = [0.2126, 0.7152, 0.0722];

/** Projector colour matrix (row-major): colour-temperature tint × saturation (luminance kept). */
export function projectorMatrix(tint, sat = 1) {
  const M = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) M.push(tint[r] * ((r === c ? sat : 0) + (1 - sat) * LUMA[c]));
  }
  return M;
}

/**
 * How a sent colour (linear RGB) looks on the screen relative to the screen's white, as the
 * shader computes it (without the viewer's chromatic adaptation). Returns linear RGB.
 */
export function simulateColor(rgb, { proj, gamma = 1, Epw, Epb, Ea, ambCol }) {
  const s = rgb.map((v) => Math.pow(Math.max(v, 0), gamma));
  const out = [];
  for (let r = 0; r < 3; r++) {
    const col = Math.max(0, proj[r * 3] * s[0] + proj[r * 3 + 1] * s[1] + proj[r * 3 + 2] * s[2]);
    const black = proj[r * 3] + proj[r * 3 + 1] + proj[r * 3 + 2];
    out.push((Ea * ambCol[r] + Epb * black + (Epw - Epb) * col) / (Epw + Ea));
  }
  return out;
}
