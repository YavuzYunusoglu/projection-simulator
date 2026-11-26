// Layout of the virtual classroom wall (metres, origin at the screen centre, y down).
const FAR = [1e4, 1e4, 1e4 + 1, 1e4 + 1];
export const DEFAULT_LAYOUT = { surface: 'screen', board: 'right', window: 'left', desk: 'none' };

export function roomLayout(sw, sh, layout = DEFAULT_LAYOUT) {
  const L = { ...DEFAULT_LAYOUT, ...(layout || {}) };
  const hw = sw / 2, hh = sh / 2;
  const bw = Math.max(1.6, sw * 1.05);
  let wb = FAR;
  if (L.board === 'right') wb = [hw + 0.14, -0.05, hw + 0.14 + bw, 1.15];
  if (L.board === 'left') wb = [-hw - 0.14 - bw, -0.05, -hw - 0.14, 1.15];
  let win = FAR;
  if (L.window !== 'none') {
    const sameSide = L.window === L.board;
    const gap = sameSide ? 0.14 + bw + 0.4 : 0.55;
    win = L.window === 'left'
      ? [-hw - gap - 1.1, -hh - 0.05, -hw - gap, hh + 0.4]
      : [hw + gap, -hh - 0.05, hw + gap + 1.1, hh + 0.4];
  }
  const ceil = -hh - 0.32;
  const trunk = Math.max(hh + 0.5, (wb === FAR ? 1.15 : wb[3]) + 0.2);
  const floor = Math.max(trunk + 0.7, hh + 1.15);
  // a teacher's desk standing in front of the wall
  let desk = FAR;
  if (L.desk !== 'none') {
    const top = floor - (L.desk === 'high' ? 1.05 : 0.76);
    const dw = Math.max(1.4, sw * 0.7);
    desk = [-dw / 2, top, dw / 2, floor + 0.02];
  }
  return {
    wb, win, ceil, trunk, floor, desk, wall: L.surface === 'wall',
    room: [-hw - 1.5, ceil - 0.12, hw + 1.5, trunk + 0.3],
    screen: [-hw - 0.12, -hh - 0.2, hw + 0.12, hh + 0.1],
  };
}

/** Camera (centre x, centre y, half-width) that fits `box` (plus extra points) into the canvas aspect. */
export function fitCamera(box, aspect, pad = 0.05, points = []) {
  let [x0, y0, x1, y1] = box;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const w = (x1 - x0) * (1 + pad * 2), h = (y1 - y0) * (1 + pad * 2);
  const halfW = Math.max(w / 2, (h / 2) * aspect);
  return [(x0 + x1) / 2, (y0 + y1) / 2, halfW];
}

/**
 * Camera for the room view as seen from a seat `distance` metres away: the visible wall
 * width follows a fixed horizontal field of view, so moving back makes the screen smaller.
 * Never zooms in further than the screen (plus any overflow) fitting in the frame.
 */
export const VIEW_FOV = (45 * Math.PI) / 180;
export function viewerCamera(distance, aspect, screenBox, points = []) {
  const fit = fitCamera(screenBox, aspect, 0.04, points);
  const halfW = Math.max(fit[2], distance * Math.tan(VIEW_FOV / 2));
  // look at the screen centre; when the screen nearly fills the view keep the overflow in frame
  const k = Math.min(1, fit[2] / halfW);
  return [fit[0] * k, fit[1] * k, halfW];
}
