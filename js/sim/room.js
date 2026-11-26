// Layout of the virtual classroom wall (metres, origin at the screen centre, y down).
export function roomLayout(sw, sh) {
  const hw = sw / 2, hh = sh / 2;
  const wbX0 = hw + 0.14;
  const wb = [wbX0, -0.05, wbX0 + Math.max(1.6, sw * 1.05), 1.15];
  const winX1 = -hw - 0.55;
  const win = [winX1 - 1.1, -hh - 0.05, winX1, hh + 0.4];
  const ceil = -hh - 0.32;
  const trunk = Math.max(hh + 0.5, wb[3] + 0.2);
  return {
    wb, win, ceil, trunk,
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
