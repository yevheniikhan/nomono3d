// 3D object editor: panel, gizmo, dragging along the surface, depth probe.
import { THREE, renderer, scene, camera, world, panoUniforms, setEyeLayout } from './gfx.js';
import { S, $, t, on, emit, clamp, DEG, hint, fmtM, LANG, fmtBytes, loadPref, savePref } from './state.js';
import {
  OBJ, addObject, select, pickObject, placementPoint, setDistance, surfaceInfo, dropToGround, toSurface, alignToNormal,
  faceViewer, setHeight, setYaw, applyFx, playClip, startAppear, removeObject, duplicateObject, markDirty, applyLight, startFall,
  autoSun, exportJson, exportZip, importSceneFile, discardDraft, clearObjects, ensureEnv, setUpAxis
} from './objects.js';
import { raySurface } from './depth.js';
import { pointerHooks, rebuildDepth, downloadDepthPNG, setDepthMode, showHUD } from './viewer.js';
import { LIB } from './library.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const E = { open: false, tc: null, mode: 'translate', drag: null, probeOn: false, refreshT: 0, place: loadPref('place', 'surface') };
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const _inv = new THREE.Matrix4();

export function applyLang(root = document) {
  const en = LANG.cur === 'en';
  root.querySelectorAll('[data-uk]').forEach(el => { el.textContent = en ? el.dataset.en : el.dataset.uk; });
}

/* Ray from a screen point in panorama (world) coordinates */
function screenRay(cx, cy, cam = camera) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  cam.updateMatrixWorld();
  ray.setFromCamera(ndc, cam);
  world.updateMatrixWorld();
  _inv.copy(world.matrixWorld).invert();
  const o = ray.ray.origin.clone().applyMatrix4(_inv);
  const d = ray.ray.direction.clone().transformDirection(_inv);
  return { o, d };
}

/* ═══════════ panel ═══════════ */
function setOpen(v) {
  E.open = v && !S.kiosk;
  $('editor').hidden = !E.open;
  $('edBtn').classList.toggle('on', E.open);
  document.body.classList.toggle('editing', E.open);
  if (!E.open) { select(null); setSlice(false); $('probe').classList.remove('on'); }
  else { renderList(); renderLib(); refreshScene(); refreshPano(); refreshSave(); if (OBJ.list.length) ensureEnv(); }
  attachGizmo();
  updateInset();
}
/* How much of the frame the editor panel covers: the viewer shifts the projection centre into the visible part */
function updateInset() {
  const ed = $('editor');
  if (!E.open || ed.hidden) { S.inset = null; return; }
  const r = renderer.domElement.getBoundingClientRect(), e = ed.getBoundingClientRect();
  if (!r.width || !r.height) { S.inset = null; return; }
  S.inset = e.width >= r.width * 0.9
    ? { x: 0, y: clamp(r.bottom - e.top, 0, r.height * 0.7) }
    : { x: clamp(r.right - e.left, 0, r.width * 0.7), y: 0 };
}
export function editorOpen() { return E.open; }

function renderList() {
  const box = $('olist'); box.innerHTML = '';
  $('edCount').textContent = OBJ.list.length ? String(OBJ.list.length) : '';
  for (const o of OBJ.list) {
    const r = document.createElement('div');
    r.className = 'orow' + (OBJ.sel === o ? ' sel' : '');
    r.innerHTML = `<span class="nm"></span><button title="Show/hide">${o.root.visible ? '◉' : '○'}</button><button title="Delete">✕</button>`;
    r.querySelector('.nm').textContent = o.name;
    r.onclick = () => select(o);
    const [bv, bd] = r.querySelectorAll('button');
    bv.onclick = e => { e.stopPropagation(); o.root.visible = !o.root.visible; OBJ.shadowDirty = true; renderList(); };
    bd.onclick = e => { e.stopPropagation(); removeObject(o); };
    box.appendChild(r);
  }
  $('edHint').textContent = OBJ.loading ? t('Завантаження моделі…', 'Loading model…')
    : !OBJ.list.length ? t('Додайте модель: файл, бібліотеку або перетягніть файли на панораму. Об\'єкт стане на поверхню в центрі кадру.',
      'Add a model: file, library, or drop files onto the panorama. It lands on the surface at the centre of the view.')
      : t('Тап — вибір. Тягніть об\'єкт — він ковзає поверхнею. W/E/R — гізмо, Del — видалити.', 'Tap to select. Drag an object to slide it over the surface. W/E/R gizmo, Del removes.');
}
function renderLib() {
  const has = LIB.models && LIB.models.length;
  $('edLibBtn').hidden = !has;
  const box = $('edLib'); box.innerHTML = '';
  if (!has) return;
  for (const m of LIB.models) {
    const b = document.createElement('button'); b.className = 'mitem';
    b.innerHTML = `<div class="mt"></div><div class="mn"></div><div class="small">${m.ext.toUpperCase()}${m.size ? ' · ' + fmtBytes(m.size) : ''}</div>`;
    b.querySelector('.mn').textContent = m.title;
    if (m.thumb) b.querySelector('.mt').style.backgroundImage = `url("${m.thumb}")`; else b.querySelector('.mt').remove();
    b.onclick = () => addAtCentre({ url: m.src });
    box.appendChild(b);
  }
}
/* Centre of the visible part of the frame, excluding the editor side panel (desktop) or bottom sheet (phone) */
function viewCentre() {
  const r = renderer.domElement.getBoundingClientRect();
  let x1 = r.right, y1 = r.bottom;
  const ed = $('editor');
  if (E.open && !ed.hidden) {
    const e = ed.getBoundingClientRect();
    if (e.width >= r.width * 0.9) y1 = Math.max(r.top + 80, Math.min(y1, e.top));
    else x1 = Math.max(r.left + 80, Math.min(x1, e.left));
  }
  return [(r.left + x1) / 2, r.top + (y1 - r.top) * 0.58];
}
async function addAtCentre(source) {
  // cast the ray for the settled frame offset (it eases into place after the panel opens)
  const [cx, cy] = viewCentre();
  const r = renderer.domElement.getBoundingClientRect(), ins = S.inset, photo = S.kind === 'photo';
  const cam = photo ? camera : camera.clone();          // the photo camera has its own off-axis projection
  if (!photo) {
    if (ins && r.width && r.height) cam.setViewOffset(r.width, r.height, ins.x / 2, ins.y / 2, r.width, r.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }
  const { o, d } = screenRay(cx, cy, cam);
  try {
    hint(t('Завантаження моделі…', 'Loading model…'), 1500);
    const obj = await addObject(source, { origin: o, dir: d, status: s => { $('edHint').textContent = s; } });
    if (obj && obj.autoScaled) hint(t('Розмір підігнано під відстань. Точну висоту задайте в полі «Висота».', 'Size fitted to the distance. Set the exact height in the Height field.'), 4000);
  } catch (e) { console.error(e); hint(t('Не вдалося завантажити модель: ', 'Could not load the model: ') + e.message, 7000); }
  renderList();
}

/* ═══════════ inspector ═══════════ */
const FX_BIND = [
  // id, key, element → value, value → element, display, rebuild
  ['fStyle', 'style', v => v, v => v, null, true],
  ['fEnhance', 'enhance', v => v, v => v, null, true],
  ['fEdges', 'edges', v => v, v => v, null, true],
  ['fOpacity', 'opacity', v => v / 100, v => Math.round(v * 100), v => Math.round(v * 100) + '%', true],
  ['fBright', 'bright', v => v / 100, v => Math.round(v * 100), v => Math.round(v * 100) + '%', true],
  ['fTint', 'tint', v => v, v => v, null, true],
  ['fTintA', 'tintA', v => v / 100, v => Math.round(v * 100), v => Math.round(v * 100) + '%', true],
  ['fGlow', 'glow', v => v, v => v, null, true],
  ['fGlowA', 'glowA', v => v / 100, v => Math.round(v * 100), v => (v).toFixed(2), true],
  ['fOut', 'outline', v => v, v => v, null, true],
  ['fOutW', 'outlineW', v => +v, v => v, v => v + ' px', true],
  ['fPoint', 'pointSize', v => +v, v => v, v => v + ' mm', true],
  ['fShadow', 'shadow', v => v, v => v, null, true],
  ['fShadowA', 'shadowA', v => v / 100, v => Math.round(v * 100), v => Math.round(v * 100) + '%', true],
  ['fOcclude', 'occlude', v => v, v => v, null, true],
  ['fSpin', 'spin', v => +v, v => v, v => v + '°/s', false],
  ['fBob', 'bob', v => +v, v => v, v => v + ' cm', false],
  ['fClip', 'clip', v => v, v => v, null, false],
  ['fClipS', 'clipSpeed', v => v / 100, v => Math.round(v * 100), v => v.toFixed(2) + '×', false],
  ['fAppear', 'appear', v => v, v => v, null, false],
  ['fLabel', 'label', v => v, v => v, null, true],
  ['fLabelT', 'labelText', v => v, v => v, null, true]
];
const distToSlider = d => Math.round(1000 * Math.log(clamp(d, 0.2, 300) / 0.2) / Math.log(1500));
const sliderToDist = v => 0.2 * Math.pow(1500, v / 1000);

function refreshInspector() {
  const o = OBJ.sel;
  $('insp').hidden = !o;
  if (!o) return;
  $('iName').value = o.name;
  for (const [id, key, , toEl, out] of FX_BIND) {
    const el = $(id); if (!el) continue;
    const v = o.fx[key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = toEl(v);
    if (out && $(id + 'O')) $(id + 'O').textContent = out(v);
  }
  $('rowPoint').hidden = !o.isPoints;
  const hasClips = o.clips && o.clips.length;
  $('rowClip').hidden = $('rowClipS').hidden = !hasClips;
  if (hasClips) {
    const sel = $('fClip'); sel.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = t('— зупинено —', '— stopped —'); sel.appendChild(none);
    for (const c of o.clips) { const op = document.createElement('option'); op.value = c.name; op.textContent = c.name || 'clip'; sel.appendChild(op); }
    sel.value = o.fx.clip;
  }
  refreshPlacement();
  $('iGizmo').querySelectorAll('.eb').forEach(b => b.classList.toggle('on', b.dataset.g === E.mode));
}
function refreshPlacement() {
  const o = OBJ.sel; if (!o) return;
  const info = surfaceInfo(o);
  if (document.activeElement !== $('iDistN')) $('iDistN').value = info.dist.toFixed(2);
  $('iDist').value = distToSlider(info.dist);
  if (document.activeElement !== $('iHeight')) $('iHeight').value = (o.size0.y * o.root.scale.x).toFixed(3);
  const yaw = Math.round(new THREE.Euler().setFromQuaternion(o.root.quaternion, 'YXZ').y / DEG);
  $('iYaw').value = yaw; $('iYawO').textContent = yaw + '°';
  $('iSurf').innerHTML = info.surf == null ? t('Без карти глибини: об\'єкт на умовній сфері 4 м.', 'No depth map: the object sits on a nominal 4 m sphere.')
    : t('Поверхня панорами в цьому напрямку: ', 'Panorama surface in this direction: ') + '<b>' + fmtM(info.surf) + '</b>' +
    (info.behind ? '<br><span class="warnline">' + t('Об\'єкт за поверхнею — його не видно. Натисніть «→ на поверхню» або вимкніть перекриття.', 'The object is behind the surface and hidden. Press “→ to surface” or turn occlusion off.') + '</span>' : '');
  $('iWarn').textContent = info.behind ? t('приховано', 'hidden') : '';
  if (S.slice.on) setSlice(true);
}
function setSlice(on) {
  S.slice.on = on && !!OBJ.sel;
  panoUniforms.uSliceOn.value = S.slice.on ? 1 : 0;
  if (S.slice.on) {
    const d = OBJ.sel.root.position.length();
    panoUniforms.uSliceDist.value = d;
    panoUniforms.uSliceW.value = Math.max(0.05, d * 0.04);
  }
}
function bindInspector() {
  $('iName').addEventListener('input', e => { if (OBJ.sel) { OBJ.sel.name = e.target.value; renderList(); markDirty(); } });
  for (const [id, key, fromEl, , out, rebuild] of FX_BIND) {
    const el = $(id); if (!el) continue;
    const ev = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') ? 'change' : 'input';
    el.addEventListener(ev, () => {
      const o = OBJ.sel; if (!o) return;
      const v = fromEl(el.type === 'checkbox' ? el.checked : el.value);
      o.fx[key] = v;
      if (out && $(id + 'O')) $(id + 'O').textContent = out(v);
      if (key === 'clip') playClip(o);
      if (key === 'bob' && !v) o.anim.position.y = 0;
      if (key === 'spin' && !v) o.anim.rotation.y = 0;
      if (rebuild) applyFx(o);
      markDirty();
    });
  }
  $('fReplay').onclick = () => OBJ.sel && startAppear(OBJ.sel, true);
  $('iGizmo').querySelectorAll('.eb').forEach(b => b.onclick = () => { E.mode = b.dataset.g; attachGizmo(); refreshInspector(); });
  const applyDist = d => { const o = OBJ.sel; if (!o) return; setDistance(o, d, $('iKeep').checked); refreshPlacement(); markDirty(); };
  $('iDist').addEventListener('input', e => applyDist(sliderToDist(+e.target.value)));
  $('iDistN').addEventListener('change', e => applyDist(+e.target.value));
  $('iHeight').addEventListener('change', e => { if (OBJ.sel) { setHeight(OBJ.sel, +e.target.value); OBJ.sel.autoScaled = false; refreshPlacement(); markDirty(); } });
  $('iYaw').addEventListener('input', e => { if (OBJ.sel) { setYaw(OBJ.sel, +e.target.value); $('iYawO').textContent = e.target.value + '°'; markDirty(); } });
  $('iToSurf').onclick = () => { if (OBJ.sel) { toSurface(OBJ.sel); refreshPlacement(); } };
  $('iDrop').onclick = () => { if (OBJ.sel) { if (E.place === 'gravity') startFall(OBJ.sel); else dropToGround(OBJ.sel); refreshPlacement(); } };
  $('iPlace').querySelectorAll('.eb').forEach(b => b.onclick = () => setPlace(b.dataset.p));
  setPlace(E.place);
  $('iFace').onclick = () => { if (OBJ.sel) { faceViewer(OBJ.sel); OBJ.sel.tilted = false; refreshPlacement(); markDirty(); } };
  $('iAlign').onclick = () => { if (OBJ.sel) { alignToNormal(OBJ.sel); OBJ.sel.tilted = true; refreshPlacement(); } };
  $('iUp').onclick = () => { if (OBJ.sel) { setUpAxis(OBJ.sel, !OBJ.sel.zUp); refreshPlacement(); } };
  $('iSlice').addEventListener('change', e => setSlice(e.target.checked));
  $('iDup').onclick = () => { if (OBJ.sel) { duplicateObject(OBJ.sel); renderList(); } };
  $('iDel').onclick = () => { if (OBJ.sel) removeObject(OBJ.sel); };
}

/* ═══════════ lighting, saving, panorama ═══════════ */
const LIGHT_BIND = [
  ['sEnv', 'env', v => v / 100, v => Math.round(v * 100), v => v.toFixed(2)],
  ['sAz', 'az', v => +v, v => v, v => v + '°'],
  ['sEl', 'el', v => +v, v => v, v => v + '°'],
  ['sSun', 'sun', v => v / 100, v => Math.round(v * 100), v => v.toFixed(2)],
  ['sExp', 'exp', v => v / 100, v => Math.round(v * 100), v => v.toFixed(2)],
  ['sHaze', 'haze', v => +v, v => v, v => String(v)]
];
function refreshScene() {
  for (const [id, key, , toEl, out] of LIGHT_BIND) { $(id).value = toEl(OBJ.light[key]); $(id + 'O').textContent = out(OBJ.light[key]); }
}
function refreshSave() {
  const el = $('saveState');
  const d = OBJ.draftInfo;
  const tm = d ? new Date(d.saved).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = (d ? '<span class="okline">' + t('Чернетку збережено в цьому браузері о ', 'Draft saved in this browser at ') + tm + '</span><br>' : '')
    + t('Щоб сцену бачили всі: завантажте пакет .zip і розпакуйте його в корінь сайту (або покладіть .scene.json поруч із панорамою, а моделі в models/).',
      'To make the scene visible to everyone: download the .zip package and unzip it into the site root (or put the .scene.json next to the panorama and models into models/).');
  $('scRevert').hidden = !(d && S.item && S.item.scene);
}
function refreshPano() {
  $('pInvert').checked = !!S.depthInvert;
  $('pSwap').checked = !!S.swapEyes;
  $('pInvert').disabled = !S.hasDepthFile;
  $('pSwap').disabled = S.layoutOrig === 'mono';
  $('pDepthPng').disabled = !S.depthReady;
  const src = S.hasDepthFile ? t('карта глибини з файлу', 'depth map from file') : S.depthReady ? t('глибина зі стереопари', 'depth from the stereo pair') : t('без глибини', 'no depth');
  $('pInfo').innerHTML = [
    S.panoW ? `${S.panoW}×${S.panoH} · ${S.layoutEff || S.layout}` : '',
    src,
    S.depthReady ? t('масштаб (near) ', 'scale (near) ') + S.near.toFixed(2) + ' m' + (S.calibrated ? ' · auto, R² ' + S.fitR2.toFixed(2) : '') : '',
    S.depthReady ? t('висота камери ≈ ', 'camera height ≈ ') + (S.camH || 0).toFixed(2) + ' m' : ''
  ].filter(Boolean).join('<br>');
}
function bindScenePanels() {
  for (const [id, key, fromEl, , out] of LIGHT_BIND) {
    $(id).addEventListener('input', e => { OBJ.light[key] = fromEl(e.target.value); $(id + 'O').textContent = out(OBJ.light[key]); ensureEnv(); applyLight(); markDirty(); });
  }
  $('sAuto').onclick = () => {
    const r = autoSun(); refreshScene();
    if (r) hint(t('Сонце: азимут ', 'Sun: azimuth ') + r.az + '°, ' + t('висота ', 'elevation ') + r.el + '°', 2500);
  };
  $('scJson').onclick = () => exportJson();
  $('scZip').onclick = () => exportZip().catch(e => hint(e.message, 5000));
  $('scImport').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { await importSceneFile(f); hint(t('Сцену імпортовано', 'Scene imported'), 2000); }
    catch (err) { hint(t('Імпорт не вдався: ', 'Import failed: ') + err.message, 6000); }
    renderList();
  });
  $('scRevert').onclick = async () => {
    if (!confirm(t('Відкинути локальні зміни й завантажити сцену з сервера?', 'Discard local changes and load the scene from the server?'))) return;
    await discardDraft(); renderList(); refreshSave();
  };
  $('scClear').onclick = () => {
    if (!OBJ.list.length || !confirm(t('Видалити всі об\'єкти з цієї панорами?', 'Remove all objects from this panorama?'))) return;
    clearObjects(); markDirty(); renderList();
  };
  $('pInvert').addEventListener('change', async e => { S.depthInvert = e.target.checked; S.texKey = null; await rebuildDepth(); refreshPano(); });
  $('pSwap').addEventListener('change', async e => {
    S.swapEyes = e.target.checked; S.texKey = null; setEyeLayout();
    if (!S.hasDepthFile) await rebuildDepth();
    refreshPano();
  });
  $('pDepthPng').onclick = () => downloadDepthPNG();
  $('pContours').onclick = () => setDepthMode(3);
}

/* Placement: 'surface' slides over the rebuilt surface, 'free' moves in a plane facing the camera,
   'gravity' moves freely and the object falls to the ground when released. */
function setPlace(p) {
  E.place = p; savePref('place', p);
  $('iPlace').querySelectorAll('.eb').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $('iPlaceHint').textContent = p === 'surface' ? t('Тягніть об\'єкт: він ковзає поверхнею.', 'Drag the object: it slides over the surface.')
    : p === 'free' ? t('Тягніть об\'єкт: він рухається вільно на своїй відстані.', 'Drag the object: it moves freely at its distance.')
      : t('Відпустіть об\'єкт: він падає на землю.', 'Let go of the object: it falls to the ground.');
}

/* ═══════════ gizmo and gestures ═══════════ */
function attachGizmo() {
  if (!E.tc) return;
  const o = OBJ.sel;
  if (E.open && o && E.mode !== 'surface') {
    E.tc.attach(o.root);
    E.tc.setMode(E.mode);
    E.tc.setSpace(E.mode === 'translate' ? 'world' : 'local');
    E.tc.getHelper().visible = true;
  } else { E.tc.detach(); E.tc.getHelper().visible = false; }
}
function initGizmo() {
  const tc = new TransformControls(camera, renderer.domElement);
  tc.setSize(matchMedia('(pointer:coarse)').matches ? 1.25 : 0.9);
  const h = tc.getHelper(); h.visible = false; h.userData.noExport = true;
  scene.add(h);
  let scale0 = null;
  tc.addEventListener('dragging-changed', e => {
    const o = OBJ.sel;
    if (e.value && o) { scale0 = o.root.scale.clone(); o.held = true; }
    else scale0 = null;
    if (!e.value) {
      if (o) { o.held = false; if (E.place === 'gravity' && E.mode === 'translate') startFall(o); }
      markDirty(); refreshPlacement();
    }
  });
  tc.addEventListener('objectChange', () => {
    const o = OBJ.sel; if (!o) return;
    if (E.mode === 'scale' && scale0) {          // uniform scale only
      const s = o.root.scale, d = [s.x / scale0.x, s.y / scale0.y, s.z / scale0.z];
      const k = d.reduce((a, b) => Math.abs(b - 1) > Math.abs(a - 1) ? b : a, 1);
      s.copy(scale0).multiplyScalar(Math.max(0.001, k));
    }
    OBJ.shadowDirty = true;
    const now = performance.now();
    if (now - E.refreshT > 120) { E.refreshT = now; refreshPlacement(); }
  });
  E.tc = tc;
}
function bindPointerHooks() {
  pointerHooks.down = e => {
    if (!E.open) return false;
    if (E.tc && (E.tc.dragging || E.tc.axis)) return true;          // the gizmo is already handling it
    if (e.button !== undefined && e.button !== 0) return false;
    const { o, d } = screenRay(e.clientX, e.clientY);
    const hit = pickObject(o, d);
    if (hit && hit.obj === OBJ.sel) {                                // dragging the selection
      const p0 = hit.obj.root.position.clone();
      // free / gravity: move in the plane through the object that faces the camera
      const n = new THREE.Vector3(); camera.getWorldDirection(n);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0);
      const at = new THREE.Ray(o, d).intersectPlane(plane, new THREE.Vector3()) || p0.clone();
      E.drag = { id: e.pointerId, obj: hit.obj, moved: false, x: e.clientX, y: e.clientY, plane, off: p0.sub(at) };
      hit.obj.held = true; hit.obj.fall = null;
      try { $('stage').setPointerCapture(e.pointerId); } catch (_) { }
      return true;
    }
    return false;
  };
  pointerHooks.move = e => {
    if (E.drag && E.drag.id === e.pointerId) {
      if (!E.drag.moved && Math.hypot(e.clientX - E.drag.x, e.clientY - E.drag.y) < 4) return true;
      E.drag.moved = true;
      const { o, d } = screenRay(e.clientX, e.clientY);
      if (E.place === 'surface') E.drag.obj.root.position.copy(placementPoint(raySurface(o, d)));
      else {
        const at = new THREE.Ray(o, d).intersectPlane(E.drag.plane, new THREE.Vector3());
        if (at) E.drag.obj.root.position.copy(at.add(E.drag.off));
      }
      OBJ.shadowDirty = true;
      const now = performance.now();
      if (now - E.refreshT > 100) { E.refreshT = now; refreshPlacement(); }
      return true;
    }
    if (E.open && e.pointerType === 'mouse') showProbe(e);
    return false;
  };
  pointerHooks.up = e => {
    if (E.drag && E.drag.id === e.pointerId) {
      const moved = E.drag.moved, obj = E.drag.obj; E.drag = null;
      obj.held = false;
      if (moved && E.place === 'gravity') startFall(obj);
      if (moved) { markDirty(); refreshPlacement(); }
      return true;
    }
    return false;
  };
  pointerHooks.tap = e => {
    const { o, d } = screenRay(e.clientX, e.clientY);
    const hit = pickObject(o, d);
    if (E.open) { select(hit ? hit.obj : null); return; }
    if (hit && hit.obj.fx.label === 'select') { (async () => (await import('./objects.js')).toggleLabel(hit.obj))(); }
  };
}
function showProbe(e) {
  const p = $('probe');
  if (!S.depthCPU) { p.classList.remove('on'); return; }
  const { o, d } = screenRay(e.clientX, e.clientY);
  const hit = raySurface(o, d);
  const r = $('stage').getBoundingClientRect();
  p.style.left = (e.clientX - r.left) + 'px'; p.style.top = (e.clientY - r.top) + 'px';
  p.textContent = '↦ ' + fmtM(hit.dist);
  p.classList.add('on');
}

/* Dragging and dropping files onto the panorama */
function bindDrop() {
  const st = $('stage'), dz = $('drop');
  let n = 0;
  st.addEventListener('dragenter', e => { if (S.kiosk || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; e.preventDefault(); n++; dz.classList.add('on'); });
  st.addEventListener('dragover', e => { if (dz.classList.contains('on')) e.preventDefault(); });
  st.addEventListener('dragleave', () => { if (--n <= 0) { n = 0; dz.classList.remove('on'); } });
  st.addEventListener('drop', async e => {
    if (!dz.classList.contains('on')) return;
    e.preventDefault(); n = 0; dz.classList.remove('on');
    const fl = [...e.dataTransfer.files];
    if (!fl.length) return;
    if (fl.length === 1 && /\.scene\.json$|\.scene\.zip$/i.test(fl[0].name)) { await importSceneFile(fl[0]); renderList(); return; }
    if (!E.open) setOpen(true);
    const { o, d } = screenRay(e.clientX, e.clientY);
    try { await addObject({ files: fl.map(f => ({ name: f.name, blob: f })) }, { origin: o, dir: d }); }
    catch (err) { hint(t('Не вдалося завантажити модель: ', 'Could not load the model: ') + err.message, 7000); }
    renderList();
  });
}

export function editorUpdate(dt) {
  if (!E.open) return;
  // the object may have been moved outside the inspector (gizmo, "to surface"): refresh the fields
  const o = OBJ.sel;
  if (o) {
    const p = o.root.position, key = p.x.toFixed(3) + ',' + p.y.toFixed(3) + ',' + p.z.toFixed(3) + ',' + o.root.scale.x.toFixed(4);
    const now = performance.now();
    if (key !== E.posKey && now - E.refreshT > 150) { E.posKey = key; E.refreshT = now; refreshPlacement(); }
  }
  if (S.slice.on && OBJ.sel) {
    const d = OBJ.sel.root.position.length();
    panoUniforms.uSliceDist.value = d; panoUniforms.uSliceW.value = Math.max(0.05, d * 0.04);
  }
}

export function initEditor() {
  initGizmo();
  bindInspector();
  bindScenePanels();
  bindPointerHooks();
  bindDrop();
  applyLang();
  if (S.kiosk) $('edBtn').hidden = true;
  $('edBtn').addEventListener('click', e => { e.stopPropagation(); setOpen(!E.open); showHUD(); });
  $('edClose').addEventListener('click', e => { e.stopPropagation(); setOpen(false); });
  window.addEventListener('resize', () => setTimeout(updateInset, 60));
  $('edLibBtn').addEventListener('click', () => { $('edLib').hidden = !$('edLib').hidden; });
  $('modelFile').addEventListener('change', async e => {
    const fl = [...e.target.files]; e.target.value = '';
    if (fl.length) await addAtCentre({ files: fl.map(f => ({ name: f.name, blob: f })) });
  });
  on('objects-changed', () => { if (E.open) renderList(); });
  on('selection', () => { if (E.open) { renderList(); refreshInspector(); attachGizmo(); if (!OBJ.sel) setSlice(false); else if ($('iSlice').checked) setSlice(true); } });
  on('draft-saved', () => E.open && refreshSave());
  on('draft-loaded', () => E.open && refreshSave());
  on('library-ready', () => E.open && renderLib());
  on('depth-ready', () => E.open && refreshPano());
  on('pano-ready', () => { if (E.open) { renderList(); refreshScene(); refreshSave(); refreshPano(); } });
  on('viewer-closing', () => setOpen(false));
  document.addEventListener('keydown', e => {
    if (!E.open || /input|textarea|select/i.test((e.target && e.target.tagName) || '')) return;
    const o = OBJ.sel;
    if (e.key === 'Escape') select(null);
    else if (!o) return;
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeObject(o); }
    else if (e.key === 'w' || e.key === 'W') { E.mode = 'translate'; attachGizmo(); refreshInspector(); }
    else if (e.key === 'e' || e.key === 'E') { E.mode = 'rotate'; attachGizmo(); refreshInspector(); }
    else if (e.key === 'r' || e.key === 'R') { E.mode = 'scale'; attachGizmo(); refreshInspector(); }
    else if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateObject(o); renderList(); }
    else if (e.key === 'g' || e.key === 'G') { if (E.place === 'gravity') startFall(o); else dropToGround(o); refreshPlacement(); }
  });
}
