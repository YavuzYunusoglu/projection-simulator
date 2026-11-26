// Profile selector, save dialog and management dialog.
import { store, BUILTIN_PROFILES, sanitizeParams } from '../state.js';
import { t, onLang, getLang } from '../i18n.js';
import { listProfiles, getProfile, putProfile, deleteProfile, newId, blobToDataURL, dataURLToBlob, isPersistent } from '../store.js';
import { toast, wireDialog } from './motion.js';

const $ = (id) => document.getElementById(id);
let userProfiles = [];
const thumbUrls = new Map();

function profileName(p) { return p.nameKey ? t(p.nameKey) : p.name; }

async function refresh() {
  userProfiles = await listProfiles();
  const sel = $('profileSelect');
  sel.innerHTML = '';
  const g1 = document.createElement('optgroup');
  g1.label = t('profiles.builtin');
  for (const p of BUILTIN_PROFILES) g1.append(new Option(profileName(p), p.id));
  sel.append(g1);
  if (userProfiles.length) {
    const g2 = document.createElement('optgroup');
    g2.label = t('profiles.mine');
    for (const p of userProfiles) g2.append(new Option(p.name, p.id));
    sel.append(g2);
  }
  sel.value = store.state.profileId;
  if (sel.value !== store.state.profileId) sel.value = 'builtin:reference';
  updateDirty();
}

function updateDirty() {
  $('dirtyDot').hidden = !store.state.dirty;
}

export async function applyProfile(id) {
  const b = BUILTIN_PROFILES.find((p) => p.id === id);
  if (b) { store.setParams(JSON.parse(JSON.stringify(b.params)), id); return; }
  const p = await getProfile(id);
  if (p) store.setParams(p.params, id);
}

/** Save the current parameters, optionally with a calibration photo (Blob). */
export async function saveProfile(name, { overwrite = false, photo = null } = {}) {
  const cur = userProfiles.find((p) => p.id === store.state.profileId);
  const rec = overwrite && cur
    ? { ...cur, name, params: store.state.params, photo: photo || cur.photo || null }
    : { id: newId(), name, params: store.state.params, photo };
  const saved = await putProfile({ ...rec, params: JSON.parse(JSON.stringify(rec.params)) });
  store.state.profileId = saved.id;
  store.state.dirty = false;
  store.emit('profile');
  await refresh();
  if (!(await isPersistent())) toast(t('profiles.memoryOnly'), 4000);
  else toast(t('profiles.saved', { name }));
  return saved;
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function serialize(p) {
  return {
    format: 'projection-simulator-profile',
    version: 1,
    name: p.name,
    params: p.params,
    createdAt: p.createdAt,
    photo: p.photo ? await blobToDataURL(p.photo) : null,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').replace(/^-|-$/g, '') || 'profile';

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data.profiles) ? data.profiles : [data];
    let n = 0;
    for (const it of items) {
      if (!it || it.format !== 'projection-simulator-profile' || !it.params) continue;
      await putProfile({
        id: newId(),
        name: String(it.name || 'Imported').slice(0, 60),
        params: sanitizeParams(it.params),
        photo: it.photo && /^data:image\//.test(it.photo) ? await dataURLToBlob(it.photo) : null,
        createdAt: it.createdAt || Date.now(),
      });
      n++;
    }
    if (!n) throw new Error('empty');
    toast(t('profiles.imported', { n }));
    await refresh();
    renderManage();
  } catch {
    toast(t('profiles.importFailed'), 4000);
  }
}

function renderManage() {
  const ul = $('profileList');
  ul.innerHTML = '';
  if (!userProfiles.length) {
    ul.innerHTML = `<li class="muted small">${t('profiles.none')}</li>`;
    return;
  }
  const fmt = new Intl.DateTimeFormat(getLang() === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  for (const p of userProfiles) {
    const li = document.createElement('li');
    let thumb = '<span class="p-thumb"></span>';
    if (p.photo) {
      if (!thumbUrls.has(p.id)) thumbUrls.set(p.id, URL.createObjectURL(p.photo));
      thumb = `<img class="p-thumb" alt="" src="${thumbUrls.get(p.id)}">`;
    }
    li.innerHTML = `${thumb}<span class="p-text"><span class="p-name"></span><span class="p-meta">${fmt.format(p.updatedAt || p.createdAt || Date.now())}${p.params.geometry.corners ? ' · ' + t('calib.calibrated') : ''}</span></span>
      <button class="btn" data-act="use">${t('profiles.use')}</button>
      <button class="btn icon" data-act="rename" title="${t('profiles.rename')}"><svg class="ic"><use href="#i-edit"/></svg></button>
      <button class="btn icon" data-act="export" title="${t('profiles.export')}"><svg class="ic"><use href="#i-down"/></svg></button>
      <button class="btn icon danger" data-act="delete" title="${t('profiles.delete')}"><svg class="ic"><use href="#i-trash"/></svg></button>`;
    li.querySelector('.p-name').textContent = p.name;
    li.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'use') { await applyProfile(p.id); await refresh(); $('profilesDlg').close(); }
      if (act === 'rename') {
        const name = prompt(t('profiles.name'), p.name);
        if (name && name.trim()) { await putProfile({ ...p, name: name.trim().slice(0, 60) }); await refresh(); renderManage(); }
      }
      if (act === 'export') download(`${slug(p.name)}.projsim.json`, await serialize(p));
      if (act === 'delete') {
        const btn = e.target.closest('button');
        if (btn.dataset.confirm !== '1') {
          btn.dataset.confirm = '1';
          btn.title = t('profiles.confirmDelete');
          btn.style.color = 'var(--bad)';
          btn.style.borderColor = 'var(--bad)';
          toast(t('profiles.confirmDelete'));
          setTimeout(() => { btn.dataset.confirm = ''; btn.style.color = ''; btn.style.borderColor = ''; }, 3000);
          return;
        }
        await deleteProfile(p.id);
        if (store.state.profileId === p.id) { store.state.profileId = 'builtin:reference'; store.state.dirty = true; store.emit('profile'); }
        await refresh();
        renderManage();
      }
    });
    ul.append(li);
  }
}

export function initProfiles() {
  const sel = $('profileSelect');
  sel.addEventListener('change', async () => {
    if (store.state.dirty && !confirm(t('profiles.discard'))) { sel.value = store.state.profileId; return; }
    await applyProfile(sel.value);
    updateDirty();
  });
  store.subscribe((what) => { if (what === 'params' || what === 'profile') updateDirty(); });
  onLang(() => { refresh(); renderManage(); });

  const saveDlg = $('saveDlg');
  $('saveProfileBtn').addEventListener('click', () => {
    const cur = userProfiles.find((p) => p.id === store.state.profileId);
    $('saveName').value = cur ? cur.name : t('profiles.defaultName');
    $('overwriteRow').hidden = !cur;
    $('saveOverwrite').checked = !!cur;
    saveDlg.showModal();
    $('saveName').select();
  });
  saveDlg.addEventListener('close', async () => {
    if (saveDlg.returnValue !== 'ok') return;
    const name = $('saveName').value.trim();
    if (name) await saveProfile(name.slice(0, 60), { overwrite: !$('overwriteRow').hidden && $('saveOverwrite').checked });
  });

  const dlg = $('profilesDlg');
  wireDialog(dlg);
  $('manageProfilesBtn').addEventListener('click', async () => { await refresh(); renderManage(); dlg.showModal(); });
  $('importProfileBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  $('exportAllBtn').addEventListener('click', async () => {
    if (!userProfiles.length) { toast(t('profiles.none')); return; }
    download('projection-simulator-profiles.json', { profiles: await Promise.all(userProfiles.map(serialize)) });
  });
  return refresh();
}
