// Planar homography utilities. Matrices are row-major arrays of length 9.

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function multiplyH(A, B) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    }
  }
  return r;
}

export function invertH(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return normalizeH(inv);
}

export function normalizeH(H) {
  const s = Math.abs(H[8]) > 1e-12 ? H[8] : 1;
  return H.map((v) => v / s);
}

// Solve a dense linear system with partial pivoting. A is n×n (array of rows), b length n.
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function normalization(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - cx, y - cy);
  d /= pts.length;
  const s = d > 1e-12 ? Math.SQRT2 / d : 1;
  return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], Tinv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}

// Least-squares homography mapping src[i] -> dst[i] (n >= 4), with Hartley normalisation.
export function solveHomography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) return null;
  const ns = normalization(src), nd = normalization(dst);
  const s = src.map(([x, y]) => applyH(ns.T, x, y));
  const d = dst.map(([x, y]) => applyH(nd.T, x, y));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const addRow = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k], [u, v] = d[k];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [...h, 1];
  return normalizeH(multiplyH(nd.Tinv, multiplyH(Hn, ns.T)));
}

// Homography from the unit square (TL, TR, BR, BL) to the quad.
export function squareToQuad(quad) {
  return solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Sutherland–Hodgman clip of a polygon against an axis aligned rectangle.
export function clipToRect(poly, x0, y0, x1, y1) {
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const isect = [
    (a, b) => lerpAt(a, b, (x0 - a[0]) / (b[0] - a[0])),
    (a, b) => lerpAt(a, b, (x1 - a[0]) / (b[0] - a[0])),
    (a, b) => lerpAt(a, b, (y0 - a[1]) / (b[1] - a[1])),
    (a, b) => lerpAt(a, b, (y1 - a[1]) / (b[1] - a[1])),
  ];
  let out = poly;
  for (let e = 0; e < 4; e++) {
    const input = out;
    out = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const ci = edges[e](cur), pi = edges[e](prev);
      if (ci) {
        if (!pi) out.push(isect[e](prev, cur));
        out.push(cur);
      } else if (pi) out.push(isect[e](prev, cur));
    }
  }
  return out;
}

function lerpAt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Largest axis-aligned rectangle inside a polygon given in slide uv coordinates.
 * `aspect` is the slide width/height so that the grid cells are physically square.
 * Returns {x0, y0, x1, y1} in uv or null.
 */
export function largestInscribedRect(poly, aspect, res = 160) {
  if (!poly || poly.length < 3) return null;
  const cols = res, rows = Math.max(4, Math.round(res / aspect));
  const heights = new Array(cols).fill(0);
  let best = { area: 0 };
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) / rows;
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) / cols;
      heights[c] = pointInPolygon(x, y, poly) ? heights[c] + 1 : 0;
    }
    // largest rectangle in histogram
    const stack = [];
    for (let c = 0; c <= cols; c++) {
      const h = c === cols ? 0 : heights[c];
      let start = c;
      while (stack.length && stack[stack.length - 1][1] >= h) {
        const [s, sh] = stack.pop();
        const area = sh * (c - s);
        if (area > best.area) best = { area, c0: s, c1: c, r1: r + 1, h: sh };
        start = s;
      }
      stack.push([start, h]);
    }
  }
  if (!best.area) return null;
  return {
    x0: best.c0 / cols,
    x1: best.c1 / cols,
    y0: (best.r1 - best.h) / rows,
    y1: best.r1 / rows,
  };
}
