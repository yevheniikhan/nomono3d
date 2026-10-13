// "View in VR headset": a link and a QR code that open what is set up here on a headset.
//
// The link carries the library item (p=…), the VR settings (vr=1, vm, vs, vq, obj) and asks the
// headset to prefer the scene stored on the server (sc=1). On a nomono3d server with uploads
// enabled, everything that so far lives only in this browser goes to the library first: a
// local image (and its depth map), models added from disk, and the scene with the 3D objects.
import qrcode from '../lib/qrcode/qrcode.js';
import { S, $, t, hint, loadPref, savePref } from './state.js';
import { files } from './viewer.js';
import { AI, detectServer, saveToLibrary } from './ai.js';
import { OBJ, serialize, flushDraft } from './objects.js';
import { xrState, enterXR } from './xr.js';

const SH = Object.assign({ vm: '6dof', vs: 1, vq: 'sharp', obj: true, auto: true }, loadPref('share', {}));
const saveSH = () => savePref('share', SH);

/* Library-relative path of a URL on this origin ('panoramas/Demo/atrium.jpg'), or null */
function libRel(u) {
  try {
    const a = new URL(u, document.baseURI), b = new URL('.', document.baseURI);
    if (a.origin !== b.origin || !a.pathname.startsWith(b.pathname)) return null;
    return decodeURIComponent(a.pathname.slice(b.pathname.length));
  } catch (e) { return null; }
}
const canUpload = () => !!(AI.server && AI.server.upload);

/* What a headset needs to open this origin: { text, warn } (warn = it will not open as it is) */
export const isColab = () => /googleusercontent\.com$|colab\.(research\.)?google/.test(location.hostname);
function hostNote() {
  const h = location.hostname;
  if (location.protocol !== 'https:' && !/^(localhost|127\.|\[::1\])/.test(h))
    return { warn: true, text: t('Сторінка відкрита без HTTPS: шолом не ввімкне VR. Відкрийте nomono3d за посиланням Colab.', 'This page is not on HTTPS: a headset will not enter VR. Open nomono3d from its Colab link.') };
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(h) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h))
    return { warn: true, text: t('Це локальна адреса: шолом не відкриє її. Відкрийте nomono3d за посиланням Colab і поділіться звідти.', 'This is a local address that a headset cannot open. Open nomono3d from its Colab link and share from there.') };
  if (isColab())
    return { warn: false, text: t('Посилання Colab: відкривається на будь-якому пристрої, де виконано вхід у той самий акаунт Google. У браузері Quest один раз увійдіть на google.com, потім відкрийте посилання або відскануйте код.',
      'Colab link: it opens on any device signed in to the same Google account. In the Quest Browser sign in to google.com once, then open the link or scan the code.') };
  return null;
}

/* Upload whatever exists only in this browser; resolves to the library path of the item */
async function prepare(status) {
  let rel = S.item ? libRel(S.item.src) : (files.pano && files.pano.sharedSrc) || null;
  const server = canUpload();
  if (!rel) {
    if (!server || !files.pano) throw new Error(t('Це зображення є лише в цьому браузері. Відкрийте nomono3d із сервера (Colab), щоб ним поділитися.',
      'This image exists only in this browser. Open nomono3d from a server (Colab) to share it.'));
    status(t('завантаження зображення…', 'uploading the image…'));
    const r = await saveToLibrary(files.pano.file, files.depth && files.depth.file, S.kind, 'Shared');
    rel = r.src; files.pano.sharedSrc = rel;
  }
  if (!server) return { rel, objectsShared: !OBJ.draftInfo };
  await flushDraft();
  const sc = serialize();
  sc.panorama = rel;
  // models added from disk → models/shared/ on the server
  for (let i = 0; i < OBJ.list.length; i++) {
    const o = OBJ.list[i], r = sc.objects[i];
    if (o.src.kind !== 'local') continue;
    if (!o.src.sharedUrl) {
      status(t('завантаження моделі ', 'uploading model ') + (o.name || '') + '…');
      const fd = new FormData();
      for (const f of o.src.files || []) fd.append('files', f.blob, (f.name || 'model.glb').replace(/\\/g, '/'));
      fd.append('name', o.name || 'model'); fd.append('main', o.src.main || '');
      const res = await fetch('api/model', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(t('Не вдалося завантажити модель: ', 'Could not upload a model: ') + res.status);
      o.src.sharedUrl = (await res.json()).src;
    }
    r.src = o.src.sharedUrl; delete r.local;
  }
  status(t('збереження сцени…', 'saving the scene…'));
  const fd = new FormData();
  fd.append('src', rel);
  fd.append('scene', JSON.stringify(sc));
  if (files.depth && files.depth.file && !(S.item && S.item.depth)) fd.append('depth', files.depth.file, 'depth.png');
  const res = await fetch('api/share', { method: 'POST', body: fd });
  if (!res.ok) {
    let m = res.status + ''; try { m = (await res.json()).detail || m; } catch (e) { }
    throw new Error(t('Не вдалося зберегти сцену: ', 'Could not save the scene: ') + m);
  }
  return { rel, objectsShared: true };
}

export function shareURL(rel) {
  const u = new URL(location.pathname, location.origin);
  const cur = new URLSearchParams(location.search);
  for (const k of ['lib', 'models', 'grid']) if (cur.has(k)) u.searchParams.set(k, cur.get(k));
  u.searchParams.set('p', rel);
  if (S.kind === 'photo') u.searchParams.set('mode', 'photo');
  if (SH.auto) u.searchParams.set('vr', '1');
  if (S.kind !== 'photo' && SH.vm !== '6dof') u.searchParams.set('vm', SH.vm);
  if (Math.abs(SH.vs - 1) > 0.01) u.searchParams.set('vs', String(+SH.vs.toFixed(2)));
  if (SH.vq !== 'sharp') u.searchParams.set('vq', SH.vq);
  if (!SH.obj) u.searchParams.set('obj', '0');
  u.searchParams.set('sc', '1');
  return u.href;
}

function drawQR(text) {
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte'); q.make();
  const n = q.getModuleCount(), quiet = 3, px = Math.max(3, Math.floor(232 / (n + 2 * quiet)));
  const c = $('shareQR'); c.width = c.height = (n + 2 * quiet) * px;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#0b0d0c';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
}

let lastRel = null;
async function build() {
  const st = $('shareStatus'), out = $('shareOut');
  out.hidden = true; st.textContent = ''; st.classList.remove('err');
  $('shareMake').disabled = true;
  try {
    await detectServer();
    const r = await prepare(s => { st.textContent = s; });
    lastRel = r.rel;
    const url = shareURL(r.rel);
    $('shareLink').value = url;
    drawQR(url);
    out.hidden = false;
    const notes = [];
    const hn = hostNote(); if (hn) notes.push(hn.text);
    let warn = !!(hn && hn.warn);
    if (!r.objectsShared && OBJ.list.length) notes.push(t('3D-об’єкти, додані в цьому браузері, не потраплять у посилання: цей сайт статичний. Експортуйте сцену (Objects → Export) і додайте її до бібліотеки.',
      '3D objects added in this browser are not in the link: this site is static. Export the scene (Objects → Export) and add it to the library.')) && (warn = true);
    st.textContent = notes.join(' ');
    st.classList.toggle('warn', warn);
  } catch (e) {
    st.textContent = e.message || String(e); st.classList.add('err');
  } finally { $('shareMake').disabled = false; }
}
function refreshLink() { if (lastRel && !$('shareOut').hidden) { const u = shareURL(lastRel); $('shareLink').value = u; drawQR(u); } }

export function openShare() {
  const d = $('shareDlg');
  $('shareVM').hidden = S.kind === 'photo';
  $('shareHere').hidden = !xrState.vr;
  $('shareOut').hidden = true; $('shareStatus').textContent = ''; lastRel = null;
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  build();
}
function seg(id, key, conv = v => v) {
  const box = $(id);
  const sync = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(SH[key]) === b.dataset.v));
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { SH[key] = conv(b.dataset.v); saveSH(); sync(); refreshLink(); }));
  sync();
}
export function initShare() {
  seg('shareVMSeg', 'vm'); seg('shareVQ', 'vq');
  const vs = $('shareVS');
  vs.value = Math.round(Math.log2(SH.vs) * 50 + 100); $('oShareVS').textContent = SH.vs.toFixed(2) + '×';
  vs.addEventListener('input', () => { SH.vs = Math.pow(2, (vs.value - 100) / 50); $('oShareVS').textContent = SH.vs.toFixed(2) + '×'; saveSH(); refreshLink(); });
  $('shareObj').checked = SH.obj; $('shareObj').addEventListener('change', e => { SH.obj = e.target.checked; saveSH(); refreshLink(); });
  $('shareAuto').checked = SH.auto; $('shareAuto').addEventListener('change', e => { SH.auto = e.target.checked; saveSH(); refreshLink(); });
  $('shareMake').addEventListener('click', build);
  $('shareCopy').addEventListener('click', async () => {
    const v = $('shareLink').value;
    try { await navigator.clipboard.writeText(v); hint(t('Посилання скопійовано', 'Link copied'), 1400); }
    catch (e) { $('shareLink').select(); document.execCommand && document.execCommand('copy'); }
  });
  $('shareOpen').addEventListener('click', () => { const v = $('shareLink').value; if (v) window.open(v, '_blank', 'noopener'); });
  $('shareHere').addEventListener('click', () => {
    $('shareDlg').close && $('shareDlg').close();
    enterXR('immersive-vr', { viewMode: S.kind === 'photo' ? null : SH.vm, scale: SH.vs, quality: SH.vq, objects: SH.obj });
  });
  $('shareClose').addEventListener('click', () => { const d = $('shareDlg'); d.close ? d.close() : d.removeAttribute('open'); });
  $('shareDlg').addEventListener('click', e => { if (e.target === $('shareDlg')) $('shareDlg').close(); });
  $('vrShareBtn').addEventListener('click', e => { e.stopPropagation(); openShare(); });
}
