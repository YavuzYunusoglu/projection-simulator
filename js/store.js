// Local persistence of room/projector profiles in IndexedDB (falls back to memory).
const DB = 'projection-simulator';
const STORE = 'profiles';
let dbp = null;
const memory = new Map();

function open() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const isPersistent = async () => !!(await open());

export async function listProfiles() {
  const all = await tx('readonly', (s) => (s ? req(s.getAll()) : [...memory.values()]));
  return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getProfile(id) {
  return tx('readonly', (s) => (s ? req(s.get(id)) : memory.get(id)));
}

export async function putProfile(p) {
  const rec = { ...p, updatedAt: Date.now(), createdAt: p.createdAt || Date.now() };
  await tx('readwrite', (s) => (s ? req(s.put(rec)) : memory.set(rec.id, rec)));
  return rec;
}

export async function deleteProfile(id) {
  await tx('readwrite', (s) => (s ? req(s.delete(id)) : memory.delete(id)));
}

export function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}
