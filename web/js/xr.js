// VR headset mode (WebXR; built for Meta Quest 3, works with other WebXR headsets).
//   • panoramas: 6DoF on the depth mesh (lean, crouch, step), original-stereo 3DoF, flat sphere;
//   • photos: a large 3D window in front of the user, seen in true stereo depth;
//   • Touch / Touch Plus controllers and hand tracking: laser pointer, pinch, grabbing 3D objects;
//   • one compact floating menu (Y/B, or the ☰ on the left wrist with hands).
// Entry points: initXR(), xrState, enterXR(mode, opts), xrFrame(now, dt, frame).
// Events (state.js bus): 'xr-support' {vr, ar}, 'xr-start' mode, 'xr-end'.
import { THREE, renderer, camera, scene, world, objectsRoot, panoUniforms, panoPre, sphereL, setPanoMode, setPanoOpacity } from './gfx.js';
import { S, $, t, emit, on, clamp, DEG, loadPref, savePref, hint } from './state.js';
import { openViewer, ensureLoop, files } from './viewer.js';
import { OBJ, pickObject, select, markDirty, applyLight, ensureEnv, toggleLabel } from './objects.js';
import { PH } from './photo.js';
import { LIB, neighbour, switchItem } from './library.js';
import { VRPanel, VRToast, makeWristButton, COL } from './vrui.js';

/* Support flags, filled in by initXR() */
export const xrState = { vr: false, ar: false };

/* Quality presets: framebuffer scale (sharpness), fixed foveation, refresh rate */
export const QUALITY = {
  std: { label: ['Стандарт', 'Standard'], scale: 1.0, foveation: 0.5, fps: 72 },
  sharp: { label: ['Чітко', 'Sharp'], scale: 1.25, foveation: 0.25, fps: 90 },
  max: { label: ['Максимум', 'Max'], scale: 1.5, foveation: 0, fps: 120 }
};
const Q_ORDER = ['std', 'sharp', 'max'];
const VIEW_MODES = ['6dof', 'stereo', 'flat'];
const PHOTO_NEAR = 1.5;              // m from the eyes to the nearest surface of a photo at scale 1
const MR_OPACITY = 0.72;             // panorama opacity over passthrough

/* Saved settings (per browser) */
const XRS = Object.assign({ quality: 'sharp', floor: true, snap: 30, smooth: false, move: true }, loadPref('xr', {}));
if (!QUALITY[XRS.quality]) XRS.quality = 'sharp';
const saveXRS = () => savePref('xr', XRS);

/* URL parameters (e.g. from the "View in VR headset" share link). They are defaults for this
   page load and are not saved:
     vr=1                 show a large "Enter VR" button once the item has loaded
     vm=6dof|stereo|flat  preferred view mode (falls back when the item does not support it)
     vs=<number>          scale factor on top of Ground = floor (1 = natural size)
     vq=std|sharp|max     quality preset
     obj=0                start with 3D objects hidden */
function readURL() {
  const q = new URLSearchParams(location.search);
  const vs = parseFloat(q.get('vs'));
  return {
    vr: q.get('vr') === '1',
    vm: VIEW_MODES.includes(q.get('vm')) ? q.get('vm') : null,
    vs: isFinite(vs) && vs > 0 ? clamp(vs, 0.1, 10) : null,
    vq: QUALITY[q.get('vq')] ? q.get('vq') : null,
    obj: q.get('obj') !== '0'
  };
}
export const xrURL = readURL();

const XR = {
  session: null, mode: null, requesting: false, inited: false,
  needsAlign: false, havePose: false, floor: true, from2D: false, loading: false, fadeHinted: false,
  head: new THREE.Vector3(), headQ: new THREE.Quaternion(),
  pointers: [], panel: null, toast: null, wrist: null, wristFor: null, panelGrab: null,
  viewMode: null, prefMode: xrURL.vm, userScale: xrURL.vs || 1, quality: xrURL.vq || XRS.quality,
  objects: xrURL.obj, switchTo: null, overlayShown: false
};
if (/[?&]debug\b/.test(location.search)) window.__xr = { XR, XRS, xrState, enterXR, exitXR };
const Y = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();

/* ═══════════ support and entry ═══════════ */
function supported(mode) {
  // isSessionSupported can hang on some browsers: give up after 2.5 s
  return Promise.race([
    navigator.xr.isSessionSupported(mode).catch(() => false),
    new Promise(r => setTimeout(() => r(false), 2500))
  ]);
}
export async function initXR() {
  on('busy', b => { if (S.xr && XR.toast) { if (b.on) XR.toast.show((b.title ? b.title + ': ' : '') + (b.step || ''), 0); else XR.toast.hide(); } });
  on('pano-ready', () => {
    // a new item in VR keeps the scene's orientation (unless the first alignment is still pending)
    if (S.xr) { XR.needsAlign = XR.needsAlign === true ? true : 'keep'; XR.loading = false; setViewMode(XR.prefMode); applyObjects(); if (XR.panel) XR.panel.rebuild(); }
    else if (xrURL.vr && xrState.vr && !XR.overlayShown) { XR.overlayShown = true; showEnterOverlay('immersive-vr'); }
  });
  on('objects-changed', () => { applyObjects(); if (S.xr && XR.panel) XR.panel.rebuild(); });
  on('library-ready', () => { if (S.xr && XR.panel) XR.panel.rebuild(); });
  on('viewer-closing', () => hideEnterOverlay());
  const btn = $('vrBtn');
  if (btn) btn.addEventListener('click', e => { e.stopPropagation(); enterXR('immersive-vr'); });
  if (!navigator.xr) { emit('xr-support', xrState); return xrState; }
  [xrState.vr, xrState.ar] = await Promise.all([supported('immersive-vr'), supported('immersive-ar')]);
  // Keep both eyes of a stereo panorama even with a depth map, so stereo 3DoF is available
  S.xrKeepEyes = xrState.vr;
  if (btn) btn.hidden = !xrState.vr;
  emit('xr-support', xrState);
  return xrState;
}

function sessionInit(mode) {
  return { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] };
}

/* Enter VR ('immersive-vr') or VR with passthrough ('immersive-ar'). Call it straight from a
   click handler: requestSession is the first await (WebXR needs a user gesture).
   opts: { viewMode, scale, quality, objects } override the defaults for this entry;
   opts.prepare(status) loads an item first when the 2D viewer is not open. */
export async function enterXR(mode = 'immersive-vr', opts = {}) {
  if (XR.session || XR.requesting) return false;
  if (!navigator.xr) {
    hint(t('WebXR недоступний: потрібен HTTPS і браузер із WebXR (Meta Quest Browser).', 'WebXR is unavailable: HTTPS and a WebXR browser (Meta Quest Browser) are required.'), 6000);
    return false;
  }
  XR.requesting = true;
  let session = null;
  try { session = await navigator.xr.requestSession(mode, sessionInit(mode)); }
  catch (e) {
    XR.requesting = false;
    hint(t('Не вдалося увійти у VR: ', 'Could not enter VR: ') + (e.message || e), 6000);
    return false;
  }
  XR.requesting = false;
  if (opts.viewMode && VIEW_MODES.includes(opts.viewMode)) XR.prefMode = opts.viewMode;
  if (opts.scale > 0) XR.userScale = clamp(+opts.scale, 0.1, 10);
  if (QUALITY[opts.quality]) XR.quality = opts.quality;
  if (opts.objects != null) XR.objects = !!opts.objects;
  await startSession(session, mode, opts);
  return true;
}
export function exitXR() { if (XR.session) XR.session.end(); }
export function xrPresenting() { return !!XR.session; }

async function startSession(session, mode, opts = {}) {
  initInputs();
  hideEnterOverlay();
  // The 2D objects editor (and its transform gizmo, which lives in the scene) is closed in VR
  if ($('editor') && !$('editor').hidden && $('edClose')) $('edClose').click();
  XR.session = session; XR.mode = mode; S.xr = true; S.xrMode = mode;
  XR.from2D = $('stage').classList.contains('on') && !!S.texKey && !opts.prepare;
  const ef = session.enabledFeatures;
  XR.floor = !ef || ef.includes('local-floor');
  renderer.xr.setReferenceSpaceType(XR.floor ? 'local-floor' : 'local');
  const q = QUALITY[XR.quality];
  renderer.xr.setFramebufferScaleFactor(q.scale);
  renderer.xr.setFoveation(q.foveation);
  session.addEventListener('end', onSessionEnd);
  ensureLoop();
  try { await renderer.xr.setSession(session); }
  catch (e) {
    console.error(e);
    if (XR.floor) {                                  // local-floor refused: try local
      XR.floor = false; renderer.xr.setReferenceSpaceType('local');
      try { await renderer.xr.setSession(session); } catch (e2) { session.end(); return; }
    } else { session.end(); return; }
  }
  setFrameRate(q.fps);
  document.body.classList.add('xr');
  XR.needsAlign = true; XR.havePose = false; XR.fadeHinted = false;
  XR.panel.mesh.visible = false;
  setPanoOpacity(mode === 'immersive-ar' ? MR_OPACITY : 1);
  emit('xr-start', mode);
  if (opts.prepare || !S.texKey || !$('stage').classList.contains('on')) {
    XR.loading = true;
    XR.toast.show(t('Завантаження…', 'Loading…'), 0);
    const ok = await openViewer({ prepare: opts.prepare || null });
    XR.loading = false;
    if (!ok) { XR.toast.show(t('Не вдалося відкрити зображення', 'Could not open the image'), 5000); return; }
  } else setViewMode(XR.prefMode);
  applyObjects();
  if (!opts.resume) XR.toast.show(t('Меню: кнопка Y/B або ☰ на зап\'ясті', 'Menu: Y/B button or ☰ on your wrist'), 4500);
  if (S.kind !== 'photo' && OBJ.list.length) ensureEnv();
}

function setFrameRate(fps) {
  const s = XR.session;
  if (!s || !s.supportedFrameRates || !s.updateTargetFrameRate) return;
  const list = Array.from(s.supportedFrameRates).sort((a, b) => a - b);
  let best = list[0];
  for (const r of list) if (r <= fps + 0.5) best = r;
  s.updateTargetFrameRate(best).catch(() => { });
}

function onSessionEnd() {
  const s = XR.session;
  if (s) s.removeEventListener('end', onSessionEnd);
  XR.session = null; XR.mode = null; S.xr = false; S.xrMode = null;
  for (const P of XR.pointers) { release(P); P.pending = null; P.src = null; P.reticle.visible = false; P.line.visible = false; }
  XR.panelGrab = null;
  // back to the 2D state
  world.position.set(0, 0, 0); world.rotation.set(0, 0, 0); world.scale.setScalar(1); world.updateMatrixWorld(true);
  if (PH.group) { PH.group.position.set(0, 0, 0); PH.group.quaternion.identity(); PH.group.scale.setScalar(1); PH.group.updateMatrixWorld(true); }
  objectsRoot.visible = true;
  panoUniforms.uFade.value = 0; panoUniforms.uEyeA.value = 0;
  setPanoOpacity(1);
  setPanoMode(S.kind === 'photo' ? 'none' : S.depthReady ? 'mesh' : 'sphere');
  panoPre.visible = false;
  XR.panel.mesh.visible = false; XR.toast.hide();
  if (XR.wrist) XR.wrist.visible = false;
  document.body.classList.remove('xr');
  applyLight();
  emit('xr-end');
  const sw = XR.switchTo; XR.switchTo = null;
  if (sw) {
    // Passthrough toggle: straight into the other session type. The menu press is the user
    // gesture; if the browser does not accept it, the 2D overlay offers a button instead.
    navigator.xr.requestSession(sw.mode, sessionInit(sw.mode))
      .then(sess => startSession(sess, sw.mode, { resume: true }))
      .catch(() => showEnterOverlay(sw.mode));
    return;
  }
  // Meta Quest Browser can offer its own "Enter VR" button
  if (navigator.xr && navigator.xr.offerSession && xrState.vr) {
    navigator.xr.offerSession('immersive-vr', sessionInit('immersive-vr'))
      .then(sess => startSession(sess, 'immersive-vr', {})).catch(() => { });
  }
}

/* ═══════════ "Enter VR" overlay (2D side) ═══════════ */
let overlay = null;
function showEnterOverlay(mode) {
  const stage = $('stage'); if (!stage) return;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'vrEnter';
    overlay.innerHTML = '<div class="box" role="dialog" aria-modal="false" aria-labelledby="vrEnterGo">' +
      '<div class="ttl"></div><button class="go" id="vrEnterGo" type="button"></button>' +
      '<div class="sub"></div><button class="skip" type="button"></button></div>';
    overlay.querySelector('.skip').addEventListener('click', e => { e.stopPropagation(); hideEnterOverlay(); });
    overlay.addEventListener('pointerdown', e => e.stopPropagation());
    stage.appendChild(overlay);
  }
  const ar = mode === 'immersive-ar';
  overlay.querySelector('.ttl').textContent = S.item ? S.item.title : (files.pano ? files.pano.name : '');
  const go = overlay.querySelector('.go');
  go.textContent = ar ? t('Увійти з passthrough', 'Enter with passthrough') : t('Увійти у VR', 'Enter VR');
  go.onclick = e => { e.stopPropagation(); enterXR(mode); };
  overlay.querySelector('.sub').textContent = t('Надягніть шолом і натисніть кнопку', 'Put on the headset and press the button');
  overlay.querySelector('.skip').textContent = t('Лишитися у 2D', 'Stay in 2D');
  overlay.hidden = false;
  try { go.focus({ preventScroll: true }); } catch (e) { }
}
function hideEnterOverlay() { if (overlay) overlay.hidden = true; }

/* ═══════════ view modes ═══════════ */
function availableModes() {
  if (S.kind === 'photo') return { '6dof': !!PH.hasDepth, stereo: false, flat: !PH.hasDepth };
  return { '6dof': !!S.depthReady, stereo: (S.layoutEff || 'mono') !== 'mono', flat: true };
}
function defaultMode() {
  const a = availableModes();
  if (S.kind === 'photo') return a['6dof'] ? '6dof' : 'flat';
  if (S.hasDepthFile && a['6dof']) return '6dof';
  if (a.stereo) return 'stereo';
  return a['6dof'] ? '6dof' : 'flat';
}
function setViewMode(m) {
  const a = availableModes();
  if (!m || !a[m]) m = defaultMode();
  XR.viewMode = m;
  panoUniforms.uEyeA.value = 0;
  sphereL.material.uniforms.uEyeMix.value = 0;
  if (S.kind === 'photo') {
    setPanoMode('none'); panoPre.visible = false;
  } else {
    setPanoMode(m === '6dof' ? 'mesh' : m === 'stereo' ? 'stereo' : 'sphere');
    // In 3DoF modes the depth mesh stays in the depth buffer only: objects still hide behind
    // nearer parts of the scene. In 6DoF it is needed as a pre-pass when the panorama is translucent.
    panoPre.visible = S.depthReady && (m !== '6dof' || panoUniforms.uOpacity.value < 0.999);
  }
  if (S.xr && XR.havePose && !XR.needsAlign) applyScale();
  if (XR.panel) XR.panel.rebuild();
}
function pickMode(m) { XR.prefMode = m; setViewMode(m); }

/* ═══════════ aligning the scene with the head ═══════════ */
function headYaw() {
  const f = tmpV.set(0, 0, -1).applyQuaternion(XR.headQ);
  return Math.atan2(-f.x, -f.z);
}
// Direction the 2D viewer was looking at (S.rot: camera rotation, rows 6..8 = −forward)
function viewYaw2D() { const R = S.rot; return Math.atan2(R[6], R[8]); }
function floorScale() {
  if (!XRS.floor || !XR.floor || !S.depthReady || XR.viewMode !== '6dof' || S.kind === 'photo') return 1;
  const h = world.position.y;                       // eye height at the moment of alignment
  if (!(h > 0.3)) return 1;
  return clamp(h / (S.camH || 2.0), 0.15, 6);
}
function applyScale() {
  if (S.kind === 'photo') { if (PH.group) { PH.group.scale.setScalar(PHOTO_NEAR * XR.userScale); PH.group.updateMatrixWorld(true); } }
  else { world.scale.setScalar(floorScale() * XR.userScale); world.updateMatrixWorld(true); }
  OBJ.shadowDirty = true;
  if (XR.panel) XR.panel.rebuild();
}
/* A photo becomes a window in front of the head: the projection apex at the eyes, the nearest
   surface PHOTO_NEAR m away, centred at eye height. PH.group is in camera space (z < 0). */
function placePhoto() {
  const g = PH.group; if (!g) return;
  g.position.copy(XR.head);
  g.quaternion.setFromAxisAngle(Y, headYaw());
  applyScale();
}
function alignWorld(keepRotation) {
  if (S.kind === 'photo') { placePhoto(); return; }
  let rotY;
  if (keepRotation && S.initialYaw == null) rotY = world.rotation.y;
  else {
    const vy = S.initialYaw != null ? S.initialYaw : (XR.from2D ? viewYaw2D() : 0);
    rotY = headYaw() - vy;
  }
  world.rotation.set(0, rotY, 0);
  world.position.copy(XR.head);
  S.initialYaw = null;
  applyScale();
  applyLight();
}
function recentre() {
  alignWorld(true);
  XR.toast.show(t('Центровано', 'Recentred'), 1200);
}
function activeRoot() { return S.kind === 'photo' ? PH.group : world; }
function rotateWorld(a) {
  const r = activeRoot(); if (!r) return;
  const piv = XR.head;
  r.position.sub(piv).applyAxisAngle(Y, a).add(piv);
  if (r === world) r.rotation.y += a;               // world keeps a pure yaw Euler (read back by alignWorld)
  else r.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(Y, a));
  r.updateMatrixWorld(true);
  if (r === world) applyLight();
}
function headLocal() { return world.worldToLocal(XR.head.clone()); }
function bubbleR() { return Math.max(0.6, S.near * 0.5); }
function applyObjects() {
  objectsRoot.visible = !S.xr || (XR.objects && S.kind !== 'photo');
}
function objectsOn() { return objectsRoot.visible && S.kind !== 'photo'; }

/* ═══════════ controllers and hands ═══════════ */
const LOCAL_PROFILES = ['meta-quest-touch-plus-v2', 'meta-quest-touch-plus', 'meta-quest-touch-pro', 'oculus-touch-v3', 'oculus-touch-v2'];
const CDN_PROFILES = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles';
function initInputs() {
  if (XR.inited) return;
  XR.inited = true;
  const profiles = new URL('../lib/xr-profiles/', import.meta.url).href;
  let cmf = null, hmf = null;
  const attachModels = () => {
    for (const P of XR.pointers) {
      if (cmf && !P.gModel) { P.gModel = cmf.createControllerModel(P.g); P.g.add(P.gModel); }
      if (hmf && !P.hModel) { P.hModel = hmf.createHandModel(P.h, 'mesh'); P.h.add(P.hModel); }
    }
  };
  import('three/addons/webxr/XRControllerModelFactory.js').then(m => { cmf = new m.XRControllerModelFactory(); cmf.setPath(profiles.replace(/\/$/, '')); XR.cmf = cmf; attachModels(); }).catch(e => console.warn(e));
  import('three/addons/webxr/XRHandModelFactory.js').then(m => { hmf = new m.XRHandModelFactory(); hmf.setPath(profiles + 'generic-hand/'); attachModels(); }).catch(e => console.warn(e));
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 0.56, 0.79, 0.71], 3));
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i), g = renderer.xr.getControllerGrip(i), h = renderer.xr.getHand(i);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, toneMapped: false }));
    line.scale.z = 2.5; line.renderOrder = 80; line.visible = false;
    c.add(line);
    const ret = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    ret.renderOrder = 110; ret.visible = false;
    scene.add(c, g, h, ret);
    const P = { i, c, g, h, line, reticle: ret, src: null, hand: false, handed: '', hit: null, sel: false, grab: null, pending: null, prev: [], armed: true, hoverKey: null };
    c.addEventListener('connected', e => {
      P.src = e.data; P.hand = !!e.data.hand; P.handed = e.data.handedness; line.visible = true;
      // Vendored Meta profiles load offline; any other controller falls back to the public CDN.
      // (This listener runs before the model factory's own 'connected' handler.)
      if (XR.cmf && !P.hand) XR.cmf.setPath((e.data.profiles || []).some(p => LOCAL_PROFILES.includes(p)) ? profiles.replace(/\/$/, '') : CDN_PROFILES);
    });
    c.addEventListener('disconnected', () => { release(P); P.pending = null; P.src = null; line.visible = false; ret.visible = false; });
    c.addEventListener('selectstart', () => onSelectStart(P));
    c.addEventListener('selectend', () => onSelectEnd(P));
    c.addEventListener('squeezestart', () => onSqueezeStart(P));
    c.addEventListener('squeezeend', () => onSqueezeEnd(P));
    XR.pointers.push(P);
  }
  XR.panel = new VRPanel(1.1, 0.367, 1800);
  scene.add(XR.panel.mesh);
  XR.panel.set(buildPanel);
  XR.toast = new VRToast();
  scene.add(XR.toast.mesh);
  XR.wrist = makeWristButton(); XR.wrist.visible = false;
}
function haptic(P, v, ms) {
  const gp = P.src && P.src.gamepad; if (!gp) return;
  const h = gp.hapticActuators && gp.hapticActuators[0];
  try {
    if (h && h.pulse) h.pulse(v, ms);
    else if (gp.vibrationActuator) gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: v, weakMagnitude: v });
  } catch (e) { }
}
function rayOf(P) {
  P.c.updateMatrixWorld();
  const o = new THREE.Vector3().setFromMatrixPosition(P.c.matrixWorld);
  const d = new THREE.Vector3(0, 0, -1).transformDirection(P.c.matrixWorld);
  return { o, d };
}
function toLocal(o, d) {
  world.updateMatrixWorld();
  const inv = tmpM.copy(world.matrixWorld).invert();
  return { o: o.clone().applyMatrix4(inv), d: d.clone().transformDirection(inv) };
}
function updatePointer(P, now) {
  if (!P.src) { P.reticle.visible = false; return; }
  const { o, d } = rayOf(P);
  let best = null;
  const ph = XR.panel.raycast(o, d);
  if (ph) best = { type: 'panel', t: ph.distance, point: ph.point, uv: ph.uv };
  if (XR.wrist && XR.wrist.visible && XR.wristFor !== P) {
    XR.wrist.updateMatrixWorld();
    const c = new THREE.Vector3().setFromMatrixPosition(XR.wrist.matrixWorld);
    const tt = tmpV2.copy(c).sub(o).dot(d);
    if (tt > 0 && c.distanceTo(o.clone().addScaledVector(d, tt)) < 0.04 && (!best || tt < best.t)) best = { type: 'wrist', t: tt, point: c };
  }
  if (!best && OBJ.list.length && objectsOn()) {
    const L = toLocal(o, d);
    const ho = pickObject(L.o, L.d);
    if (ho) best = { type: 'object', obj: ho.obj, t: ho.t * world.scale.x, point: world.localToWorld(ho.point.clone()) };
  }
  P.hit = best;
  const len = best ? best.t : (P.grab ? P.grab.dist : 2.5);
  P.line.scale.z = Math.max(0.05, len);
  if (best && best.type !== 'wrist') {
    P.reticle.visible = true;
    P.reticle.position.copy(best.point);
    P.reticle.lookAt(o);
    P.reticle.scale.setScalar(Math.max(0.006, best.t * 0.012));
    P.reticle.material.color.set(best.type === 'object' ? 0x8fd18a : 0xffffff);
  } else P.reticle.visible = false;
  // hovering over the panel
  const key = best ? (best.type === 'panel' ? 'p:' + ((XR.panel.at(best.uv) || {}).id || '') : best.type === 'object' ? 'o:' + best.obj.id : best.type) : null;
  if (best && best.type === 'panel') XR.panel.hover(best.uv);
  else if (P.hoverKey && P.hoverKey.startsWith('p:') && !XR.pointers.some(q => q !== P && q.hit && q.hit.type === 'panel')) XR.panel.hover(null);
  if (key !== P.hoverKey) { if (key && key !== 'p:') haptic(P, 0.12, 8); P.hoverKey = key; }
  // holding the trigger / pinch on an object grabs it
  if (P.pending && P.sel && now - P.pending.t0 > 220 && !S.kiosk) { startGrab(P, P.pending.obj, 'select'); P.pending = null; }
}

/* ═══════════ select / squeeze ═══════════ */
function onSelectStart(P) {
  P.sel = true;
  const h = P.hit;
  if (h && h.type === 'panel') { XR.panel.press(h.uv); haptic(P, 0.35, 20); return; }
  if (h && h.type === 'wrist') { togglePanel(); haptic(P, 0.4, 25); return; }
  if (h && h.type === 'object') { P.pending = { obj: h.obj, t0: performance.now() }; return; }
}
function onSelectEnd(P) {
  P.sel = false;
  const h = P.hit;
  if (h && h.type === 'panel') { XR.panel.release(h.uv); return; }
  XR.panel.pressId = null;
  if (P.grab && P.grab.via === 'select') { release(P); return; }
  if (P.pending) {                                   // a short press on an object: its label
    const o = P.pending.obj; P.pending = null;
    if (o.fx.label === 'select') toggleLabel(o);
    haptic(P, 0.3, 20);
  }
}
function onSqueezeStart(P) {
  const h = P.hit;
  if (h && h.type === 'panel') { startPanelGrab(P); return; }
  if (h && h.type === 'object' && !S.kiosk) startGrab(P, h.obj, 'squeeze');
}
function onSqueezeEnd(P) {
  if (XR.panelGrab && XR.panelGrab.P === P) { XR.panelGrab = null; return; }
  if (P.grab && P.grab.via === 'squeeze') release(P);
}

/* ═══════════ grabbing 3D objects ═══════════ */
const posOf = P => new THREE.Vector3().setFromMatrixPosition(P.c.matrixWorld);
function handReach(P) { const p = posOf(P); return Math.hypot(p.x - XR.head.x, p.z - XR.head.z) + 0.05; }
function startGrab(P, o, via) {
  select(o);
  const other = XR.pointers.find(q => q !== P && q.grab && q.grab.o === o);
  P.c.updateMatrixWorld(); o.root.updateMatrixWorld();
  const rel = new THREE.Matrix4().copy(P.c.matrixWorld).invert().multiply(o.root.matrixWorld);
  P.grab = { o, via, rel, dist: P.hit ? P.hit.t : 1, hand0: P.hand ? handReach(P) : 0, relLen0: new THREE.Vector3().setFromMatrixPosition(rel).length() };
  if (other) {                                       // second hand on the same object: scale
    P.grab.two = true;
    P.grab.d0 = posOf(P).distanceTo(posOf(other));
    P.grab.s0 = o.root.scale.x;
  }
  haptic(P, 0.6, 35);
}
function release(P) {
  if (!P.grab) return null;
  const o = P.grab.o;
  P.grab = null;
  if (!XR.pointers.some(q => q.grab && q.grab.o === o)) select(null);
  OBJ.shadowDirty = true; markDirty();
  haptic(P, 0.25, 15);
  return o;
}
function updateGrabs() {
  for (const P of XR.pointers) {
    const G = P.grab; if (!G || !P.src) continue;
    const o = G.o;
    if (G.two) {
      const other = XR.pointers.find(q => q !== P && q.grab && q.grab.o === o && !q.grab.two);
      if (!other) { G.two = false; continue; }
      const k = posOf(P).distanceTo(posOf(other)) / Math.max(0.02, G.d0);
      o.root.scale.setScalar(clamp(G.s0 * k, 0.001, 1e4));
      OBJ.shadowDirty = true;
      continue;
    }
    // hands: "go-go" technique, a stretched arm pushes the object further away
    if (P.hand) {
      const f = Math.pow(handReach(P) / Math.max(0.1, G.hand0), 2.5);
      const tr = new THREE.Vector3().setFromMatrixPosition(G.rel);
      if (tr.lengthSq() > 1e-8) { tr.setLength(clamp(G.relLen0 * f, 0.05, 400)); G.rel.setPosition(tr); }
    }
    P.c.updateMatrixWorld();
    const m = tmpM.multiplyMatrices(P.c.matrixWorld, G.rel);
    o.root.parent.updateMatrixWorld();
    const local = new THREE.Matrix4().copy(o.root.parent.matrixWorld).invert().multiply(m);
    const s = o.root.scale.clone();
    local.decompose(o.root.position, o.root.quaternion, tmpV);
    o.root.scale.copy(s);
    // keep it upright (rotation about Y only)
    const e = new THREE.Euler().setFromQuaternion(o.root.quaternion, 'YXZ');
    if (!o.tilted) o.root.quaternion.setFromAxisAngle(Y, e.y);
    G.dist = o.root.getWorldPosition(tmpV).distanceTo(posOf(P));
    OBJ.shadowDirty = true;
  }
}
function grabStick(P, x, y, dt) {
  const G = P.grab; if (!G) return;
  if (Math.abs(y) > 0.15) {                          // push away / pull closer
    const tr = new THREE.Vector3().setFromMatrixPosition(G.rel);
    const L = tr.length();
    if (L > 1e-6) { tr.setLength(clamp(L * Math.exp(-y * dt * 1.6), 0.08, 400)); G.rel.setPosition(tr); G.relLen0 = tr.length(); }
  }
  if (Math.abs(x) > 0.15) G.rel.multiply(new THREE.Matrix4().makeRotationY(-x * dt * 2.2));
}

/* ═══════════ the menu panel: showing, moving, wrist button ═══════════ */
function startPanelGrab(P) {
  P.c.updateMatrixWorld();
  XR.panelGrab = { P, rel: new THREE.Matrix4().copy(P.c.matrixWorld).invert().multiply(XR.panel.mesh.matrixWorld) };
}
function updatePanelGrab() {
  const G = XR.panelGrab; if (!G) return;
  const P = G.P;
  if (!P.src) { XR.panelGrab = null; return; }
  P.c.updateMatrixWorld();
  tmpM.multiplyMatrices(P.c.matrixWorld, G.rel);
  tmpM.decompose(XR.panel.mesh.position, XR.panel.mesh.quaternion, tmpV);
}
function showPanel(on) {
  const m = XR.panel.mesh;
  if (on && !m.visible) {
    const yaw = headYaw();
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    m.position.copy(XR.head).addScaledVector(fwd, 0.75); m.position.y -= 0.2;
    m.lookAt(XR.head.x, XR.head.y - 0.05, XR.head.z);
    XR.panel.rebuild();
  }
  m.visible = on;
}
function togglePanel() { showPanel(!XR.panel.mesh.visible); }
function updateWrist() {
  const w = XR.wrist; if (!w) return;
  const P = XR.pointers.find(p => p.src && p.hand && p.handed === 'left');
  const j = P && P.h.joints && P.h.joints['wrist'];
  if (!j || j.visible === false) { w.visible = false; return; }
  if (w.parent !== j) { j.add(w); w.position.set(0, 0.035, 0.035); w.rotation.set(-Math.PI / 2, 0, 0); }
  XR.wristFor = P;
  w.visible = true;
}

/* ═══════════ buttons and sticks ═══════════ */
function handleGamepads(dt) {
  for (const P of XR.pointers) {
    const gp = P.src && P.src.gamepad;
    if (!gp || P.hand) continue;
    const ax = gp.axes || [];
    const x = ax.length >= 4 ? ax[2] : (ax[0] || 0), y = ax.length >= 4 ? ax[3] : (ax[1] || 0);
    const b = gp.buttons.map(v => !!(v && v.pressed));
    const edge = i => b[i] && !P.prev[i];
    if (XR.panelGrab && XR.panelGrab.P === P) { /* the panel follows the controller (updatePanelGrab) */ }
    else if (P.grab) grabStick(P, x, y, dt);
    else if (P.handed === 'right') {
      // stick right turns right: the scene rotates by +a about the head
      if (XRS.smooth) { if (Math.abs(x) > 0.2) rotateWorld(x * 1.6 * dt); }
      else if (P.armed && Math.abs(x) > 0.72) { rotateWorld(Math.sign(x) * XRS.snap * DEG); P.armed = false; haptic(P, 0.2, 12); }
      else if (Math.abs(x) < 0.35) P.armed = true;
      if (edge(3)) recentre();                                  // thumbstick press
    } else if (XRS.move && XR.viewMode === '6dof' && S.kind !== 'photo' && Math.hypot(x, y) > 0.18) {
      // left stick: walk, but never beyond the capture zone
      const v = new THREE.Vector3(x, 0, y).applyAxisAngle(Y, headYaw()).multiplyScalar(dt * 0.9);
      world.position.sub(v);
      world.updateMatrixWorld(true);
      const l = headLocal(), R = bubbleR(), hr = Math.hypot(l.x, l.z);
      if (hr > R) {
        const l2 = new THREE.Vector3(l.x * R / hr, l.y, l.z * R / hr).multiplyScalar(world.scale.x).applyAxisAngle(Y, world.rotation.y);
        world.position.copy(XR.head).sub(l2);
      }
      world.updateMatrixWorld(true);
    }
    if (edge(3) && P.handed === 'left') toggleTurnMode();                    // left stick press: snap ↔ smooth turning
    if (edge(5)) togglePanel();                                              // B / Y: menu
    if (edge(4) && !XR.panel.mesh.visible) nextItem(P.handed === 'left' ? -1 : 1);   // X / A: previous / next
    P.prev = b;
  }
}

/* ═══════════ library navigation ═══════════ */
function libList() { return LIB.items.filter(i => (!LIB.kind || i.kind === LIB.kind) && (!LIB.album || i.album === LIB.album)); }
async function nextItem(step) {
  const it = neighbour(step);
  if (!it || XR.loading || (S.item && it.src === S.item.src)) return;
  XR.loading = true;
  XR.toast.show(it.title, 0);
  try { await switchItem(it, s => XR.toast.show(it.title + ' · ' + s, 0)); XR.toast.show(it.title, 2000); }
  catch (e) { XR.toast.show(t('Помилка: ', 'Error: ') + (e.message || e), 5000); }
  XR.loading = false;
  if (XR.panel) XR.panel.rebuild();
}

/* ═══════════ menu actions ═══════════ */
function changeScale(k) {
  XR.userScale = clamp(XR.userScale * k, 0.1, 10);
  applyScale();
}
function toggleTurnMode() {
  XRS.smooth = !XRS.smooth; saveXRS();
  XR.toast.show(t('Поворот: ', 'Turning: ') + (XRS.smooth ? t('плавний', 'smooth') : XRS.snap + t('° кроками', '° steps')), 1800);
}
function toggleFloor() { XRS.floor = !XRS.floor; saveXRS(); applyScale(); }
function toggleObjects() { XR.objects = !XR.objects; applyObjects(); XR.panel.rebuild(); }
function cycleQuality() {
  const next = Q_ORDER[(Q_ORDER.indexOf(XR.quality) + 1) % Q_ORDER.length];
  XR.quality = next; XRS.quality = next; saveXRS();
  const q = QUALITY[next];
  renderer.xr.setFoveation(q.foveation);
  setFrameRate(q.fps);
  // three.js cannot change the framebuffer scale during a session: sharpness follows on the next entry
  XR.toast.show(t('Якість: ', 'Quality: ') + t(q.label[0], q.label[1]) + ' · ' + q.fps + ' Hz' + t(' (чіткість — з наступного входу)', ' (sharpness from the next entry)'), 3000);
  XR.panel.rebuild();
}
function togglePassthrough() {
  if (!xrState.ar || !XR.session || XR.switchTo) return;
  XR.switchTo = { mode: XR.mode === 'immersive-ar' ? 'immersive-vr' : 'immersive-ar' };
  // keep the direction the user is looking at in the panorama
  if (S.kind !== 'photo') S.initialYaw = headYaw() - world.rotation.y;
  XR.session.end();
}

/* ═══════════ the XR frame ═══════════ */
export function xrFrame(now, dt, frame) {
  if (!frame || !XR.panel) return;
  const ref = renderer.xr.getReferenceSpace();
  const pose = ref && frame.getViewerPose(ref);
  if (pose) {
    const p = pose.transform.position, q = pose.transform.orientation;
    XR.head.set(p.x, p.y, p.z); XR.headQ.set(q.x, q.y, q.z, q.w); XR.havePose = true;
  }
  if (XR.needsAlign && XR.havePose && S.texKey && !XR.loading) {
    alignWorld(XR.needsAlign === 'keep');
    XR.needsAlign = false;
  }
  handleGamepads(dt);
  updatePanelGrab();
  for (const P of XR.pointers) updatePointer(P, now);
  updateGrabs();
  updateBubble();
  updateWrist();
  XR.panel.draw();
  XR.toast.update(XR.head, XR.headQ, now);
  // Clip planes for the headset (three passes them to the session as depthNear / depthFar)
  const s = S.kind === 'photo' ? (PH.group ? PH.group.scale.x : 1) * (PH.range || 4) : world.scale.x * 520;
  camera.near = 0.03; camera.far = Math.max(60, Math.ceil(s * 1.2 / 50) * 50);
}
// The image fades when the head leaves the capture zone (6DoF): the mesh is only valid near it
function updateBubble() {
  if (S.panoMode !== 'mesh' || !XR.havePose) { panoUniforms.uFade.value = 0; return; }
  const l = headLocal();
  const r = Math.hypot(l.x, l.z) + Math.abs(l.y) * 0.4, R = bubbleR();
  const f = clamp((r - R) / (R * 0.8), 0, 1);
  panoUniforms.uFade.value = f * 0.92;
  if (f > 0.5 && !XR.fadeHinted) { XR.fadeHinted = true; XR.toast.show(t('Ви далеко від точки зйомки: поверніться або натисніть правий стік', 'You are far from the capture point: step back or press the right thumbstick'), 3500); }
  if (f < 0.1) XR.fadeHinted = false;
}

/* ═══════════ menu content: three rows ═══════════ */
// Lays out a row of items with relative widths w; items without onClick are text cells.
function row(p, y, h, items) {
  const X0 = 40, W = p.cw - 80, GAP = 18;
  const sum = items.reduce((a, it) => a + (it.w || 1), 0);
  const unit = (W - GAP * (items.length - 1)) / sum;
  let x = X0;
  for (const it of items) {
    const w = unit * (it.w || 1);
    if (it.text != null) p.text(x + w / 2, y + h / 2, it.text, { size: it.size || 44, align: 'center', baseline: 'middle', color: it.color, weight: it.weight, max: w });
    else { const { w: _rel, ...o } = it; p.button(it.id, x, y, w, h, it.label, it.on, o); }
    x += w + GAP;
  }
}
function buildPanel(p) {
  const H = 150, y1 = 36, y2 = y1 + H + 22, y3 = y2 + H + 22;
  // Row 1: ◀ · title · ▶
  const list = libList(), idx = S.item ? list.findIndex(x => x.src === S.item.src) : -1;
  const title = S.item ? S.item.title : (files.pano ? files.pano.name : t('Зображення', 'Image'));
  const many = list.length > 1;
  const X0 = 40, W = p.cw - 80, bw = 200;
  p.button('prev', X0, y1, bw, H, '◀', () => nextItem(-1), { disabled: !many || XR.loading, size: 56 });
  p.button('next', X0 + W - bw, y1, bw, H, '▶', () => nextItem(1), { disabled: !many || XR.loading, size: 56 });
  const cx = X0 + W / 2, tw = W - 2 * bw - 60;
  p.text(cx, y1 + 52, title, { size: 52, weight: 600, align: 'center', baseline: 'middle', max: tw });
  const kind = S.kind === 'photo' ? t('Фото', 'Photo') : t('Панорама 360°', '360° panorama');
  p.text(cx, y1 + 112, [idx >= 0 ? (idx + 1) + ' / ' + list.length : '', kind, XR.mode === 'immersive-ar' ? 'Passthrough' : ''].filter(Boolean).join('  ·  '),
    { size: 34, color: COL.dim, align: 'center', baseline: 'middle', max: tw });

  // Row 2: view mode · Ground = floor · scale − / + · Recentre
  const a = availableModes();
  const names = { '6dof': '6DoF', stereo: t('Стерео', 'Stereo'), flat: t('Пласко', 'Flat') };
  const r2 = VIEW_MODES.filter(m => a[m]).map(m => ({ id: 'm-' + m, label: names[m], w: 1, active: XR.viewMode === m, on: () => pickMode(m) }));
  const floorOk = S.kind !== 'photo' && XR.viewMode === '6dof' && XR.floor && S.depthReady;
  r2.push({ id: 'floor', label: t('Земля = підлога', 'Ground = floor'), w: 1.75, size: 40, active: XRS.floor && floorOk, disabled: !floorOk, on: toggleFloor });
  r2.push({ id: 's-', label: '−', w: 0.55, size: 60, on: () => changeScale(1 / 1.12) });
  r2.push({ text: '×' + XR.userScale.toFixed(2), w: 0.75, size: 42 });
  r2.push({ id: 's+', label: '+', w: 0.55, size: 60, on: () => changeScale(1.12) });
  r2.push({ id: 'rc', label: t('⟲ Центр', '⟲ Recentre'), w: 1.4, on: recentre });
  row(p, y2, H, r2);

  // Row 3: Objects · Quality · Passthrough · Exit
  const nObj = OBJ.list.length, photo = S.kind === 'photo';
  const r3 = [
    { id: 'obj', label: !nObj || photo ? t('Без об\'єктів', 'No objects') : t('Об\'єкти: ', 'Objects: ') + (XR.objects ? t('так', 'on') : t('ні', 'off')) + ' · ' + nObj, w: 1.4, active: XR.objects && nObj > 0 && !photo, disabled: !nObj || photo, on: toggleObjects },
    { id: 'q', label: t('Якість: ', 'Quality: ') + t(QUALITY[XR.quality].label[0], QUALITY[XR.quality].label[1]), w: 1.5, on: cycleQuality }
  ];
  if (xrState.ar) r3.push({ id: 'pt', label: 'Passthrough: ' + (XR.mode === 'immersive-ar' ? t('так', 'on') : t('ні', 'off')), w: 1.5, active: XR.mode === 'immersive-ar', on: togglePassthrough });
  r3.push({ id: 'exit', label: t('✕ Вийти', '✕ Exit'), w: 1, warn: true, on: exitXR });
  row(p, y3, H, r3);
}
