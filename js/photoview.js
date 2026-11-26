// Keeps the re-lightable photo of the current room (from a fresh calibration, a reload or a
// saved profile). Layers are stored as images so nothing has to be recomputed later.
import { store } from './state.js';
import { getProfile, putProfile } from './store.js';
import { squareToQuad } from './sim/homography.js';
import { roomUsable } from './calib/photoroom.js';

const WORKING_ID = 'working:photo';

async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return c;
}

export function canvasToBlob(canvas, max = 1600, type = 'image/jpeg', q = 0.88) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, type, q));
}

function install(amb, proj, calib, layers, thumb) {
  store.state.photo = {
    amb, proj, w: amb.width, h: amb.height,
    H: squareToQuad(calib.quad), Yamb: calib.Yamb, Yproj: calib.Yproj,
    calib, layers, thumb,
  };
}

/** Use freshly built layers (from buildPhotoRoom) and remember them as the working copy. */
export async function useBuiltRoom(room, calib, thumb) {
  const layers = { amb: await canvasToBlob(room.amb, 4000, 'image/jpeg', 0.9), proj: await canvasToBlob(room.proj, 4000, 'image/jpeg', 0.9) };
  install(room.amb, room.proj, calib, layers, thumb);
  putProfile({ id: WORKING_ID, name: WORKING_ID, layers, photo: thumb, params: null }).catch(() => {});
  store.emit('photo');
}

/** Restore layers saved in a profile (or the working copy). */
export async function setRoomPhoto(layers, calib, thumb = null, { persist = true } = {}) {
  if (!layers || !layers.amb || !layers.proj || !calib || !calib.quad || !roomUsable({ Yamb: calib.Yamb, Yproj: calib.Yproj })) {
    clearRoomPhoto(persist);
    return;
  }
  try {
    const [amb, proj] = await Promise.all([blobToCanvas(layers.amb), blobToCanvas(layers.proj)]);
    install(amb, proj, calib, layers, thumb);
    if (persist) putProfile({ id: WORKING_ID, name: WORKING_ID, layers, photo: thumb, params: null }).catch(() => {});
  } catch (e) {
    console.error(e);
    store.state.photo = null;
  }
  store.emit('photo');
}

export function clearRoomPhoto(persist = true) {
  const had = !!store.state.photo;
  store.state.photo = null;
  if (store.state.view === 'photo') { store.state.view = 'room'; store.emit('view'); }
  if (persist) putProfile({ id: WORKING_ID, name: WORKING_ID, layers: null, photo: null, params: null }).catch(() => {});
  if (had) store.emit('photo');
}

/** Restore the working photo after a reload. */
export async function restoreRoomPhoto() {
  const calib = store.state.params.calib;
  if (!calib) return;
  const rec = await getProfile(WORKING_ID).catch(() => null);
  if (rec && rec.layers) await setRoomPhoto(rec.layers, calib, rec.photo, { persist: false });
}
