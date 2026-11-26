// Viewing-distance model: how much detail survives on the way from slide to a seated viewer.

const ARCMIN = Math.PI / (180 * 60);

/** Visual angle (arcmin) subtended by one slide pixel. */
export function pixelArcmin(projWidthM, slideWidthPx, distanceM) {
  const px = projWidthM / slideWidthPx;
  return (2 * Math.atan(px / (2 * Math.max(distanceM, 0.1)))) / ARCMIN;
}

/**
 * Gaussian blur (sigma, in slide pixels) combining:
 *  - eye resolution at the given distance (acuity in arcmin, 1 = 20/20)
 *  - resampling to the projector's native resolution
 *  - lens focus blur (mm on the wall)
 */
export function blurSigma({ projWidthM, slideWidthPx, distanceM, acuity, nativeWidthPx, focusMm }) {
  const pxArc = pixelArcmin(projWidthM, slideWidthPx, distanceM);
  const eye = (0.45 * acuity) / pxArc;
  const nat = nativeWidthPx && slideWidthPx > nativeWidthPx ? 0.42 * (slideWidthPx / nativeWidthPx) : 0;
  const focus = (focusMm / 1000) / (projWidthM / slideWidthPx) * 0.5;
  return { sigma: Math.sqrt(eye * eye + nat * nat + focus * focus), pxArcmin: pxArc, eye, nat, focus };
}

/**
 * Smallest comfortable font size in PowerPoint points (slides are 7.5 in = 540 pt tall
 * for both 4:3 and 16:9 decks). Based on a cap height of ~20 arcmin for comfortable reading,
 * scaled for reduced acuity and low contrast.
 */
export function minReadablePt({ projHeightM, distanceM, acuity, effContrast }) {
  let angle = 20 * acuity;
  if (effContrast < 2) angle *= 1.5;
  else if (effContrast < 3.5) angle *= 1.25;
  const capH = 2 * distanceM * Math.tan((angle * ARCMIN) / 2);
  const em = capH / 0.7;
  return (em / projHeightM) * 540;
}
