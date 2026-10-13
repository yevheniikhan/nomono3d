// 2D viewer: orientation, gestures, head tracking, HUD, panorama loading.
import {
  THREE, renderer, camera, panoUniforms, sphereL, setPanoMode, setEyeLayout, makePanoTexture,
  makeDataTexture, uploadChecked, resize2D, clearEnvironment
} from './gfx.js';
import { S, $, DEG, TAU, D_FAR, clamp, emit, on, hint, t, fmtBytes } from './state.js';
import { buildDepth, disposeDepth, depthToCanvas, depthBitmapCap } from './depth.js';
import { PH, loadPhoto, freePhoto, showPhoto, photoCamera, setPhotoDepthView, setRange, setFocus, photoDepthCanvas } from './photo.js';
import { AI, engineFor, generateDepth, detectServer, BG, inpaintAvailable, setBgFill } from './ai.js';

/* ═══════════ quaternions ═══════════ */
function qAxis(x, y, z, a) { const h = a / 2, s = Math.sin(h); return [x * s, y * s, z * s, Math.cos(h)]; }
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function qEulerYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
}
function qDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
function qSlerp(a, b, t) {
  let d = qDot(a, b), c = b;
  if (d < 0) { c = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const r = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t, a[3] + (c[3] - a[3]) * t];
    const n = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const t0 = Math.acos(Math.min(1, d)), th = t0 * t, s0 = Math.sin(t0);
  return [a[0] * Math.sin(t0 - th) / s0 + c[0] * Math.sin(th) / s0, a[1] * Math.sin(t0 - th) / s0 + c[1] * Math.sin(th) / s0,
  a[2] * Math.sin(t0 - th) / s0 + c[2] * Math.sin(th) / s0, a[3] * Math.sin(t0 - th) / s0 + c[3] * Math.sin(th) / s0];
}
function qToMat3(q, out) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy;
  out[3] = xy - wz; out[4] = 1 - (xx + zz); out[5] = yz + wx;
  out[6] = xz + wy; out[7] = yz - wx; out[8] = 1 - (xx + yy);
  return out;
}
let qR = [0, 0, 0, 1];

/* ═══════════ orientation ═══════════ */
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return window.orientation || 0;
}
function onOrient(e, absolute) {
  if (e.alpha === null && e.beta === null && e.gamma === null) return;
  if (absolute) S.absolute = true; else if (S.absolute) return;
  S.gyro = true;
  const a = (e.alpha || 0) * DEG, b = (e.beta || 0) * DEG, g = (e.gamma || 0) * DEG, o = screenAngle() * DEG;
  S.qTarget = qMul(qMul(qEulerYXZ(b, a, -g), qAxis(1, 0, 0, -Math.PI / 2)), qAxis(0, 0, 1, -o));
  if (!S.camSet) { S.qCam = S.qTarget.slice(); S.camSet = true; }
  const ang = screenAngle(); let tx, ty;
  if (ang === 90) { tx = -(e.beta || 0); ty = (e.gamma || 0); }
  else if (ang === 270 || ang === -90) { tx = (e.beta || 0); ty = -(e.gamma || 0); }
  else if (ang === 180) { tx = -(e.gamma || 0); ty = -(e.beta || 0); }
  else { tx = (e.gamma || 0); ty = (e.beta || 0); }
  S.raw.x = tx; S.raw.y = ty;
  if (!S.baseSet) { S.base.x = tx; S.base.y = ty; S.baseSet = true; }
}
let motionBound = false;
export async function requestMotion() {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') {
    try { if ((await D.requestPermission()) !== 'granted') return false; } catch (e) { return false; }
  }
  if (!motionBound) {
    window.addEventListener('deviceorientationabsolute', e => onOrient(e, true), true);
    window.addEventListener('deviceorientation', e => onOrient(e, false), true);
    motionBound = true;
  }
  return true;
}

/* ═══════════ full screen ═══════════ */
export const Full = {
  pseudo: false,
  supported: (() => {
    const e = document.documentElement;
    return !!(e.requestFullscreen || e.webkitRequestFullscreen || e.mozRequestFullScreen || e.msRequestFullscreen);
  })(),
  standalone: (window.navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
};
function fsCurrent() {
  return document.fullscreenElement || document.webkitFullscreenElement ||
    document.mozFullScreenElement || document.msFullscreenElement || null;
}
function fsRequest(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (!fn) return Promise.reject(new Error('unsupported'));
  try { return Promise.resolve(fn.call(el, { navigationUI: 'hide' })); }
  catch (e) { try { return Promise.resolve(fn.call(el)); } catch (e2) { return Promise.reject(e2); } }
}
export function fsExit() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (fn && fsCurrent()) { try { return Promise.resolve(fn.call(document)); } catch (e) { } }
  return Promise.resolve();
}
function setVH() {
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
}
function pseudoOn() {
  Full.pseudo = true; document.body.style.overflow = 'hidden';
  document.body.style.minHeight = (window.innerHeight + 2) + 'px'; window.scrollTo(0, 1);
  setTimeout(() => { window.scrollTo(0, 1); setVH(); }, 140);
}
export function pseudoOff() { Full.pseudo = false; document.body.style.minHeight = ''; document.body.style.overflow = ''; setVH(); }
export function syncFS() { $('fsbtn').classList.toggle('is-fs', !!fsCurrent() || Full.pseudo || Full.standalone); setVH(); }
function goFullscreen() {
  if (Full.standalone) { syncFS(); return Promise.resolve('standalone'); }
  if (Full.supported) return fsRequest($('stage')).then(() => { syncFS(); return 'native'; })
    .catch(() => { pseudoOn(); syncFS(); return 'pseudo'; });
  pseudoOn(); syncFS(); return Promise.resolve('pseudo');
}
function toggleFullscreen() {
  if (fsCurrent()) { fsExit().then(syncFS); return; }
  if (Full.pseudo && !Full.supported) { pseudoOff(); syncFS(); return; }
  goFullscreen();
}
['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
  .forEach(ev => document.addEventListener(ev, syncFS));
window.addEventListener('resize', setVH);
window.addEventListener('orientationchange', () => setTimeout(setVH, 260));
if (window.visualViewport) window.visualViewport.addEventListener('resize', setVH);
setVH();

/* ═══════════ head tracking (MediaPipe Face Landmarker) ═══════════ */
// The front camera provides both signals at once:
//   face offset in the frame  -> lateral parallax
//   apparent face size        -> moving closer/further (dolly)
// Same approach as the Amazon Fire Phone, but with one selfie camera
// and an on-device neural network instead of four infrared cameras.
const MP_VER = '0.10.35';
const MP_ESM = [`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`,
  `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`];
const MP_WASM = [`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`,
  `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}/wasm`];
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/' +
  'face_landmarker/float16/1/face_landmarker.task';

export const Head = {
  on: false, busy: false, lm: null, stream: null, last: 0, seen: 0,
  base: { x: 0, y: 0, s: 0 }, set: false, raw: { x: 0, y: 0, s: 0 },
  out: { x: 0, y: 0, r: 1 }
};
async function headStart() {
  if (Head.busy || Head.on) return;
  Head.busy = true; setHeadUI('Loading…');
  try {
    Head.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24 } },
      audio: false
    });
    const v = $('cam'); v.srcObject = Head.stream; await v.play();
    let mod = null, err = null;
    for (const u of MP_ESM) { try { mod = await import(u); break; } catch (e) { err = e; } }
    if (!mod) throw err || new Error('MediaPipe unavailable');
    const V = mod.FilesetResolver ? mod : (mod.default || mod);
    let fileset = null;
    for (const w of MP_WASM) { try { fileset = await V.FilesetResolver.forVisionTasks(w); break; } catch (e) { } }
    if (!fileset) throw new Error('WASM fileset unavailable');
    Head.lm = await V.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO', numFaces: 1,
      outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false
    });
    Head.on = true; Head.set = false; Head.busy = false;
    setHeadUI('Head'); updateInfo(); showHUD();
  } catch (e) {
    headStop();
    Head.busy = false; setHeadUI('Head');
    hint(t('Стеження за головою недоступне: ', 'Head tracking unavailable: ') + String(e.message || e).slice(0, 90), 5000);
  }
}
export function headStop() {
  Head.on = false;
  if (Head.lm) { try { Head.lm.close(); } catch (e) { } Head.lm = null; }
  if (Head.stream) { Head.stream.getTracks().forEach(t => t.stop()); Head.stream = null; }
  $('cam').srcObject = null;
  Head.out.x = Head.out.y = 0; Head.out.r = 1; Head.set = false;
  setHeadUI('Head'); updateInfo();
}
function setHeadUI(txt) {
  const b = $('headBtn');
  b.textContent = txt;
  b.classList.toggle('on', Head.on);
  b.classList.toggle('busy', Head.busy);
  $('rowDist').classList.toggle('dim', !Head.on);
  $('revBtn').classList.toggle('dim', !Head.on);
}
function headTick(dt) {
  if (!Head.on || !Head.lm) return;
  const v = $('cam'), now = performance.now();
  // ~22 Hz: detection in VIDEO mode is synchronous and blocks the frame
  if (v.readyState >= 2 && now - Head.last > 45) {
    Head.last = now;
    let r = null;
    try { r = Head.lm.detectForVideo(v, now); } catch (e) { }
    const f = r && r.faceLandmarks && r.faceLandmarks[0];
    if (f && f.length > 264) {
      const asp = (v.videoWidth || 4) / (v.videoHeight || 3);
      const L = f[33], R = f[263], N = f[168] || f[1];
      const cx = (L.x + R.x) * 0.5, cy = (L.y + R.y) * 0.5;
      const s = Math.hypot((L.x - R.x) * asp, (L.y - R.y));
      Head.raw.x = N ? (N.x * 0.5 + cx * 0.5) : cx;
      Head.raw.y = N ? (N.y * 0.5 + cy * 0.5) : cy;
      Head.raw.s = s;
      if (!Head.set) { Head.base.x = Head.raw.x; Head.base.y = Head.raw.y; Head.base.s = s; Head.set = true; }
      Head.seen = now;
    }
  }
  if (!Head.set) return;
  if (performance.now() - Head.seen > 900) {          // face lost: ease back to neutral
    const k = 1 - Math.exp(-dt / 0.5);
    Head.out.x -= Head.out.x * k; Head.out.y -= Head.out.y * k;
    Head.out.r += (1 - Head.out.r) * k;
    return;
  }
  // The baseline slowly follows the head: a steady pose reads as neutral,
  // while quick movement produces parallax. Same principle as the gyroscope.
  const kb = 1 - Math.exp(-dt / 2.2);
  Head.base.x += (Head.raw.x - Head.base.x) * kb;
  Head.base.y += (Head.raw.y - Head.base.y) * kb;
  Head.base.s += (Head.raw.s - Head.base.s) * (1 - Math.exp(-dt / 5.0));   // zoom is held longer
  // The selfie stream is NOT mirrored: moving the head right shifts the face left in the frame
  const RX = 0.115, RY = 0.105;
  const tx = clamp(-(Head.raw.x - Head.base.x) / RX, -1.5, 1.5);
  const ty = clamp(-(Head.raw.y - Head.base.y) / RY, -1.5, 1.5);
  // r is the face size relative to neutral. r>1 = phone is closer.
  // GAIN comes from the Dist slider: 0 disables the distance response,
  // 1.0 (mark 40) stays the physically accurate multiplier on tan(FOV/2).
  const GAIN = S.zGain, DEAD = 0.022;
  let e = Head.raw.s / Math.max(Head.base.s, 1e-4) - 1;
  e = Math.abs(e) < DEAD ? 0 : e - Math.sign(e) * DEAD;   // dead zone against jitter
  const tr = clamp(1 + e * GAIN, 0.66, 1.50);
  const kxy = 1 - Math.exp(-dt / 0.16);                    // lateral motion
  const kz = 1 - Math.exp(-dt / 0.34);                    // zoom: noticeably slower
  Head.out.x += (Math.tanh(tx * 0.9) - Head.out.x) * kxy;
  Head.out.y += (Math.tanh(ty * 0.9) - Head.out.y) * kxy;
  Head.out.r += (tr - Head.out.r) * kz;
}

/* ═══════════ modes ═══════════ */
export function dragRotates() { return S.kind !== 'photo' && (S.mode === 'lock' || !S.gyro); }
function setMode(m) {
  if (m === S.mode) return;
  if (m === 'lock') {
    const f = [-S.rot[6], -S.rot[7], -S.rot[8]];
    // S.rot already includes autoYaw, so subtract it to avoid doubling the rotation
    S.pitch = Math.asin(clamp(f[1], -1, 1)); S.yaw = Math.atan2(-f[0], -f[2]) - S.autoYaw;
    S.baseSet = false; S.tTilt.x = S.tTilt.y = 0;
  } else { S.catchup = 0.55; S.gTilt.x = S.gTilt.y = 0; }
  S.mode = m;
  const b = $('modeBtn'); b.textContent = m === 'lock' ? 'Lock' : 'Live';
  b.classList.toggle('locked', m === 'lock'); updateInfo(); showHUD();
}
export function travelA() {
  return Math.min(S.move * 0.15 * S.near * (S.hasDepthFile ? 1.0 : 0.5), S.near * 0.17);
}
export function updateInfo() {
  if (S.kind === 'photo') {
    const how = Head.on ? 'Move your head' : S.gyro ? 'Tilt or drag' : 'Drag to move the viewpoint';
    $('info').textContent = !PH.hasDepth ? 'No depth map: the photo is flat'
      : (S.depthAI ? 'AI depth' + (PH.bgEngine === 'MI-GAN' ? ' and background. ' : '. ') : PH.bgEngine === 'MI-GAN' ? 'AI background. ' : '') + how + '. Depth ' + PH.range.toFixed(1) + '×, focus ' + Math.round(PH.focus * 100) + ' %';
    return;
  }
  const src = S.depthReady ? (S.depthAI ? 'AI depth' : S.hasDepthFile ? 'Depth map' : 'Approximate stereo depth') : 'No depth: rotation only';
  const how = Head.on ? (S.mode === 'lock' ? 'drag to look, move your head for parallax' : 'tilt to look, move your head for parallax')
    : !S.gyro ? 'drag to look'
      : S.mode === 'lock' ? 'drag to look, tilt for parallax' : 'tilt to look, drag for parallax';
  let num = '';
  if (S.depthReady) {
    num = '. Field of view ' + Math.round(S.fovEff / DEG) + '°, scale ' + S.near.toFixed(2) + ' m' + (S.calibrated ? ' (auto)' : '')
      + ', travel ' + travelA().toFixed(2) + ' m';
  }
  $('info').textContent = src + ', ' + how + num;
}
let hudTimer = 0;
export function showHUD() {
  $('readout').classList.add('show');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => $('readout').classList.remove('show'), 3200);
}

/* ═══════════ pointer ═══════════ */
// Object editor hooks: returning true means the editor consumed the event.
export const pointerHooks = { down: null, move: null, up: null, tap: null };
function bindPointer() {
  const el = $('stage'), pts = new Map();
  let downAt = null;
  el.addEventListener('pointerdown', e => {
    if (S.xr) return;                                     // VR: the headset owns input (xr.js)
    if (e.target.closest && e.target.closest('input,button,select,textarea,label,#editor,#help,.panel,.pop,#measureBar,dialog')) return;
    if (pointerHooks.down && pointerHooks.down(e)) { downAt = null; return; }
    try { el.setPointerCapture(e.pointerId); } catch (_) { }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    downAt = { x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now(), id: e.pointerId };
    if (pts.size === 1) S.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: S.yaw, pitch: S.pitch };
    if (pts.size === 2) {
      const v = [...pts.values()];
      S.pinch = { d: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), fov: S.fov }; S.drag = null; downAt = null;
    }
    S.lastTouch = performance.now(); showHUD();
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' && !e.buttons && !pts.size) showHUD();   // the controls appear when the mouse moves
    if (pointerHooks.move && pointerHooks.move(e)) return;
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    S.lastTouch = performance.now();
    if (S.pinch && pts.size === 2) {
      const v = [...pts.values()];
      S.fov = clamp(S.pinch.fov * (S.pinch.d / Math.max(Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), 1)), 32 * DEG, 105 * DEG);
      return;
    }
    if (!S.drag || S.drag.id !== e.pointerId) return;
    const dx = e.clientX - S.drag.x, dy = e.clientY - S.drag.y;
    const reach = Math.min(window.innerWidth, window.innerHeight) * 0.28;
    if (dragRotates()) {
      const k = S.fov / window.innerHeight;
      S.yaw = S.drag.yaw + dx * k; S.pitch = clamp(S.drag.pitch + dy * k, -85 * DEG, 85 * DEG);
    } else {
      S.tTilt.x = clamp(dx / reach, -1.4, 1.4); S.tTilt.y = clamp(-dy / reach, -1.4, 1.4);
    }
    showHUD();
  });
  const up = e => {
    if (pointerHooks.up && pointerHooks.up(e)) { pts.delete(e.pointerId); return; }
    const wasTap = downAt && downAt.id === e.pointerId && pts.size === 1 &&
      // use event time, not handling time, so a slow frame cannot turn a tap into a long press
      Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 7 && (e.timeStamp || performance.now()) - downAt.t < 500;
    pts.delete(e.pointerId); if (pts.size < 2) S.pinch = null;
    if (S.drag && S.drag.id === e.pointerId) S.drag = null; S.lastTouch = performance.now();
    if (wasTap && e.type === 'pointerup' && pointerHooks.tap) pointerHooks.tap(e);
    downAt = null;
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', e => {
    if (S.xr) return;                                     // VR
    if (e.target.closest && e.target.closest('#editor,#help,button,input,.panel')) return;
    S.baseSet = false; S.fov = 78 * DEG; S.yaw = S.pitch = 0; S.autoYaw = 0;
  });
  // Mouse wheel changes the field of view (desktop)
  el.addEventListener('wheel', e => {
    if (S.xr) return;                                     // VR
    if (e.target.closest && e.target.closest('#editor,#help,.panel')) return;
    S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.0012), 32 * DEG, 105 * DEG); e.preventDefault();
  }, { passive: false });
}

/* ═══════════ 2D frame ═══════════ */
export function frame2D(now, dt) {
  // if frames consistently take over 24 ms, lower the render pixel density
  if (dt > 0.024) { if (++S.slow > 45 && S.dprCap > 1.5) { S.dprCap = 1.5; S.slow = 0; } }
  else if (S.slow > 0) S.slow--;
  const [W, H] = resize2D();
  if (W < 2 || H < 2) return false;                     // canvas not sized yet

  // Auto-rotate: slow spin of the world about the vertical axis (~3.4°/s, a full
  // turn in ~105 s). A touch pauses it; 1.6 s after release it eases
  // back up to speed. Stopping is faster than spinning up.
  const rTgt = (S.autoRot && !S.drag && !S.pinch && now - S.lastTouch > 1600) ? 0.06 : 0;
  S.autoVel += (rTgt - S.autoVel) * (1 - Math.exp(-dt / (rTgt > S.autoVel ? 1.2 : 0.25)));
  S.autoYaw = (S.autoYaw + S.autoVel * dt) % TAU;

  if (S.mode === 'live' && S.gyro) {
    const d = Math.abs(qDot(S.qCam, S.qTarget)), ang = 2 * Math.acos(Math.min(1, d));
    const REF = 2 * DEG; let tau = 0.035 + (0.20 - 0.035) / (1 + (ang / REF) * (ang / REF));
    if (S.catchup > 0) { tau = 0.09; S.catchup -= dt; }
    if (ang > 0.0006) S.qCam = qSlerp(S.qCam, S.qTarget, 1 - Math.exp(-dt / tau));
    qR = qMul(qAxis(0, 1, 0, S.autoYaw), S.qCam);
  } else qR = qMul(qAxis(0, 1, 0, S.yaw + S.autoYaw), qAxis(1, 0, 0, S.pitch));
  qToMat3(qR, S.rot);

  if (S.mode === 'lock' && S.gyro) {
    const k = 1 - Math.exp(-dt / 1.6);
    S.base.x += (S.raw.x - S.base.x) * k; S.base.y += (S.raw.y - S.base.y) * k;
    S.gTilt.x = clamp((S.raw.x - S.base.x) / 9, -1, 1); S.gTilt.y = clamp((S.raw.y - S.base.y) / 9, -1, 1);
  } else { S.gTilt.x = S.gTilt.y = 0; }
  if (!S.drag || dragRotates()) {
    const s = 1 - Math.exp(-dt / 0.30); S.tTilt.x -= S.tTilt.x * s; S.tTilt.y -= S.tTilt.y * s;
  }
  headTick(dt);
  if (S.recMotion) S.recMotion(dt);          // scripted camera motion while a video is recorded (export.js)
  // While the head is tracked it drives parallax; the sensors handle rotation only.
  // Touch input is always added on top as manual control.
  const hx = Head.on ? Head.out.x : 0, hy = Head.on ? Head.out.y : 0;
  const sat = v => Math.tanh(v * 0.9);
  const e = 1 - Math.exp(-dt / 0.07);
  S.tilt.x += (sat((Head.on ? 0 : S.gTilt.x) + S.tTilt.x + hx) - S.tilt.x) * e;
  S.tilt.y += (sat((Head.on ? 0 : S.gTilt.y) + S.tTilt.y + hy) - S.tilt.y) * e;
  // WINDOW MODEL: the phone is a window, the scene lies behind it, the eye is at distance D.
  //   tan(FOV/2) = half screen / D
  // Closer to the face -> smaller D -> WIDER angle -> objects look smaller.
  // With Reverse enabled the angle narrows instead, so moving closer
  // to the screen magnifies, like a conventional zoom.
  const hrRaw = Head.on ? Head.out.r : 1.0;
  const hr = S.zRev ? 1 / hrRaw : hrRaw;
  S.fovEff = 2 * Math.atan(clamp(Math.tan(S.fov / 2) * hr, 0.28, 1.35));
  S.dolly = 1 - 1 / hrRaw;                    // always dolly forward: closer = forward

  if (S.kind === 'photo') {
    // Orbit: an automatic elliptical sweep of the viewpoint, the classic "3D photo" motion
    PH.orbitAmp = S.autoVel / 0.06;
    if (PH.orbitAmp > 0.001) PH.orbit += dt * TAU / 6.5;
    const ox = Math.sin(PH.orbit) * 0.9 * PH.orbitAmp, oy = Math.cos(PH.orbit) * 0.42 * PH.orbitAmp;
    const zoom = clamp(Math.tan(39 * DEG) / Math.tan(S.fov / 2), 0.6, 3.0);
    S.fovEff = S.fov;
    photoCamera(W, H, S.tilt.x + ox, S.tilt.y + oy, S.dolly, zoom);
    if (Head.on && $('readout').classList.contains('show') && Math.floor(now / 250) !== S.infoT) { S.infoT = Math.floor(now / 250); updateInfo(); }
    return true;
  }
  const stereo = S.layoutEff !== 'mono';
  sphereL.material.uniforms.uEyeMix.value = (stereo && !S.depthReady)
    ? clamp((Math.hypot(S.tilt.x, S.tilt.y) - 0.12) / 0.30, 0, 1) : 0;

  camera.quaternion.set(qR[0], qR[1], qR[2], qR[3]);
  if (S.panoMode === 'mesh') {
    // Travel is a fraction of the MEASURED nearest scene distance, capped:
    // beyond the cap the viewpoint starts entering the nearest objects.
    const A = travelA();
    // Eye moves towards the window -> slightly closer to the scene too. The effect is
    // small: the field of view does most of the work, this just keeps geometry consistent.
    const Z = Math.min(A * 1.4, S.near * 0.13) * clamp(S.dolly * 2.4, -1, 1);
    const R = S.rot, fw = [-R[6], -R[7], -R[8]];
    camera.position.set(
      R[0] * S.tilt.x * A + R[3] * S.tilt.y * A + fw[0] * Z,
      R[1] * S.tilt.x * A + R[4] * S.tilt.y * A + fw[1] * Z,
      R[2] * S.tilt.x * A + R[5] * S.tilt.y * A + fw[2] * Z);
    panoUniforms.uEyeA.value = Math.max(A, Math.abs(Z));
  } else {
    camera.position.set(0, 0, 0);
  }
  camera.fov = S.fovEff / DEG;
  camera.near = Math.max(0.04, S.near * 0.12);
  camera.far = D_FAR * 4;
  // An open editor panel covers part of the frame: shift the projection centre
  // (lens shift) into the visible area so the horizon and new objects stay in view.
  const cw = $('gl').clientWidth || W, ch = $('gl').clientHeight || H;
  const ins = S.inset, ks = 1 - Math.exp(-dt / 0.12);
  S.shift.x += ((ins ? ins.x / 2 : 0) - S.shift.x) * ks;
  S.shift.y += ((ins ? ins.y / 2 : 0) - S.shift.y) * ks;
  if (Math.abs(S.shift.x) > 0.5 || Math.abs(S.shift.y) > 0.5) camera.setViewOffset(cw, ch, S.shift.x, S.shift.y, cw, ch);
  else if (camera.view && camera.view.enabled) camera.clearViewOffset();
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  if (Head.on && $('readout').classList.contains('show') && Math.floor(now / 250) !== S.infoT) {
    S.infoT = Math.floor(now / 250); updateInfo();
  }
  return true;
}

/* ═══════════ files ═══════════ */
export const files = { pano: null, depth: null };
let fileSeq = 0;
export async function probeImage(blob, name, url) {
  const src = URL.createObjectURL(blob);
  const im = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i);
    i.onerror = () => rej(new Error(t('Не вдалося прочитати зображення.', 'Cannot read this image.'))); i.src = src;
  });
  return {
    img: im, w: im.naturalWidth, h: im.naturalHeight, src, file: blob, name: name || blob.name || 'image',
    url: url || null, id: url || ((blob.name || 'blob') + ':' + blob.size + ':' + (blob.lastModified || ++fileSeq))
  };
}
export function detectLayout(w, h) {
  const r = w / h;
  if (Math.abs(r - 1) < 0.15) return 'tb';
  if (Math.abs(r - 4) < 0.4) return 'sbs';
  return 'mono';
}
// crop: eye rectangle as image fractions {x,y,w,h}, or null (whole image)
async function toBitmap(rec, maxSide, crop) {
  const sx = crop ? Math.round(crop.x * rec.w) : 0, sy = crop ? Math.round(crop.y * rec.h) : 0;
  const sw = crop ? Math.round(crop.w * rec.w) : rec.w, sh = crop ? Math.round(crop.h * rec.h) : rec.h;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const tw = Math.max(2, Math.round(sw * k)), th = Math.max(2, Math.round(sh * k));
  if (self.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(rec.file, sx, sy, sw, sh,
        { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      if (bmp.width <= tw + 1 && bmp.height <= th + 1) return bmp;
      bmp.close && bmp.close();
    } catch (e) { }
  }
  const cv = document.createElement('canvas');
  cv.width = tw; cv.height = th;
  cv.getContext('2d').drawImage(rec.img, sx, sy, sw, sh, 0, 0, tw, th);
  return cv;
}
function eyeRect(layout, swap) {
  const e = swap ? 1 : 0;
  if (layout === 'tb') return { x: 0, y: e * 0.5, w: 1, h: 0.5 };
  if (layout === 'sbs') return { x: e * 0.5, y: 0, w: 0.5, h: 1 };
  return null;
}
/* Small left-eye copy (1024×512) for object lighting, auto-sun and thumbnails */
function makeSmall(src, layout, swap, cropped) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const W = src.width, H = src.height;
  const r = cropped ? null : eyeRect(layout, swap);
  if (r) g.drawImage(src, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, 1024, 512);
  else g.drawImage(src, 0, 0, W, H, 0, 0, 1024, 512);
  return c;
}

/* File selection in a load-screen slot */
export async function pick(kind, file, opts = {}) {
  if (!file) return;
  if (kind === 'depth') S.hasDepthFile = false;
  $('note').textContent = t('Читання…', 'Reading…');
  try {
    const d = await probeImage(file, opts.name || file.name, opts.url);
    if (files[kind] && files[kind].src) { try { URL.revokeObjectURL(files[kind].src); } catch (e) { } }
    files[kind] = d; S.texKey = null;
    if (kind === 'pano' && !opts.keepItem) { S.item = null; }
    if (kind === 'pano' && files.depth && S.depthAI) clearDepthSlot();   // AI depth belonged to the previous image
    showSlot(kind, d);
    if (kind === 'pano' && !opts.keepKind && !opts.kind) {
      // Anything that is not 2:1, 1:1 or 4:1 cannot be an equirectangular panorama
      const r = d.w / d.h;
      const panoLike = Math.abs(r - 2) < 0.06 || Math.abs(r - 1) < 0.15 || Math.abs(r - 4) < 0.4;
      if (!panoLike && S.kind !== 'photo') setKind('photo', true);
    }
    if (opts.kind) setKind(opts.kind, true);
    if (kind === 'pano' && S.kind === 'photo') {
      S.layout = S.layoutOrig = 'mono'; S.swapEyes = false;
      $('metaPano').innerHTML = `<b>${d.w} × ${d.h}</b>` + (opts.size ? ', ' + fmtBytes(opts.size) : '');
      $('tagPano').textContent = ''; $('tagPano').className = 'tag';
      $('cap').textContent = 'photo';
    } else if (kind === 'pano') {
      S.layout = S.layoutOrig = opts.layout || detectLayout(d.w, d.h);
      S.swapEyes = !!opts.swapEyes;
      $('metaPano').innerHTML = `<b>${d.w} × ${d.h}</b>` + (opts.size ? ', ' + fmtBytes(opts.size) : '');
      const tag = S.layout === 'tb' ? 'Top-bottom stereo' : S.layout === 'sbs' ? 'Side-by-side stereo'
        : (Math.abs(d.w / d.h - 2) < 0.1 ? 'Mono equirectangular' : 'Unusual aspect ratio');
      $('tagPano').textContent = tag;
      $('tagPano').className = 'tag' + (S.layout !== 'mono' ? ' stereo' : '');
      $('cap').textContent = Math.min(S.maxTex || 4096, 8192) >= d.w ? 'full res' : 'scaled';
    } else {
      S.hasDepthFile = true; S.depthAI = !!opts.generated;
      $('metaDepth').innerHTML = `<b>${d.w} × ${d.h}</b>`;
      $('tagDepth').textContent = opts.generated ? 'Generated' : 'Will be used'; $('tagDepth').className = 'tag depth';
      $('depthClear').hidden = false;
      $('depthSave').hidden = !opts.generated;
    }
    updateLoadNote();
    document.dispatchEvent(new Event('nomono3d:file'));
  } catch (err) { $('note').textContent = err.message || t('Не вдалося завантажити файл.', 'Could not load that file.'); }
}
export function clearDepthSlot() {
  if (files.depth && files.depth.src) { try { URL.revokeObjectURL(files.depth.src); } catch (e) { } }
  files.depth = null; S.hasDepthFile = false; S.depthAI = false; S.texKey = null;
  $('depthSave').hidden = true;
  const frame = $('frameDepth');
  frame.classList.remove('filled'); frame.style.backgroundImage = ''; frame.style.aspectRatio = '2/1';
  frame.parentElement.style.width = '';
  $('metaDepth').textContent = depthSlotText();
  $('tagDepth').textContent = ''; $('tagDepth').className = 'tag';
}
function showSlot(kind, d) {
  const frame = $(kind === 'pano' ? 'framePano' : 'frameDepth');
  frame.classList.add('filled'); frame.style.backgroundImage = `url(${d.src})`;
  // The frame takes the file's own aspect ratio, and background-size:contain
  // ensures the WHOLE image is visible.
  const ar = d.w / d.h;
  frame.style.aspectRatio = d.w + ' / ' + d.h;
  frame.parentElement.style.width = (kind === 'pano' ? (ar < 1.4 ? '72%' : '100%') : (ar < 1.4 ? '48%' : '66%'));
}
function depthSlotText() {
  const e = engineFor(S.kind);
  if (e) return e.where === 'server' ? 'Leave empty: AI depth on the GPU server' : 'Leave empty: AI depth in your browser';
  return S.kind === 'photo' ? 'Needed for parallax' : 'Without it, depth is estimated from a stereo pair';
}
export function updateLoadNote() {
  const ok = !!files.pano;
  $('view').disabled = !ok;
  $('depthGen').hidden = !ok || !engineFor(S.kind) || AI.busy;
  if (!files.depth) $('metaDepth').textContent = depthSlotText();
  const eng = engineFor(S.kind);
  $('note').textContent = !files.pano ? t('Оберіть зображення або відкрийте його з бібліотеки.', 'Choose an image or open one from the library.')
    : S.hasDepthFile ? t('Карту глибини додано.', 'Depth map supplied.')
      : eng ? (eng.where === 'server'
        ? t('Карту глибини створить нейромережа на GPU-сервері: ', 'A depth map will be estimated on the GPU server: ') + eng.name
        : t('Карту глибини створить нейромережа у браузері (перший раз завантажить модель ~50 МБ).', 'A depth map will be estimated in your browser (the first run downloads a ~50 MB model).'))
        : S.kind === 'photo' ? t('Фото без карти глибини буде пласким: додайте карту або запустіть сервер nomono3d.', 'Without a depth map the photo stays flat: add one or run the nomono3d server.')
          : S.layout !== 'mono' ? t('Без карти глибини: глибину оцінимо зі стереопари — результат слабший.', 'No depth map: depth will be estimated from the stereo pair, which is less accurate.')
            : t('Моно-панорама: додайте карту глибини, інакше буде лише поворот без паралаксу.', 'Mono panorama: add a depth map, or you get flat sphere motion only.');
}

/* Panorama (360°) or flat photo */
export function setKind(kind, quiet) {
  kind = kind === 'photo' ? 'photo' : 'pano';
  const changed = S.kind !== kind;
  S.kind = kind; S.texKey = null;
  document.body.dataset.kind = kind;
  $('kindPano').classList.toggle('on', kind === 'pano');
  $('kindPhoto').classList.toggle('on', kind === 'photo');
  $('kindPano').setAttribute('aria-pressed', kind === 'pano');
  $('kindPhoto').setAttribute('aria-pressed', kind === 'photo');
  $('slotHint').textContent = kind === 'photo' ? 'Choose a photo' : 'Choose a 360° panorama';
  if (!files.pano) $('metaPano').textContent = kind === 'photo' ? 'Any aspect ratio, JPEG, PNG, WebP or AVIF' : '2:1 mono, 1:1 or 4:1 stereo';
  if (changed && files.pano && !quiet) {
    const d = files.pano;
    if (kind === 'pano') S.layout = S.layoutOrig = detectLayout(d.w, d.h); else S.layout = S.layoutOrig = 'mono';
    $('tagPano').textContent = kind === 'photo' ? '' : (S.layout === 'tb' ? 'Top-bottom stereo' : S.layout === 'sbs' ? 'Side-by-side stereo' : 'Mono equirectangular');
  }
  updateLoadNote();
}

/* ═══════════ panorama upload to the GPU ═══════════ */
let panoTex = null, depthSrcTex = null;
export function currentPanoTexture() { return panoTex; }
export function freePano() {
  if (panoTex) { panoTex.dispose(); panoTex = null; }
  if (depthSrcTex) { depthSrcTex.dispose(); depthSrcTex = null; }
  disposeDepth();
  freePhoto();
  clearEnvironment();
  panoUniforms.uPano.value = null;
  S.texKey = null; S.small = null;
}
export function busy(on, step, title) {
  const b = $('busy');
  emit('busy', { on, step, title });
  if (b.classList.contains('err')) return;
  b.classList.toggle('on', on);
  if (on) $('busyTitle').textContent = title || 'Reconstructing depth';
  if (step != null) $('busyStep').textContent = step;
}
/* Returns true if the panorama is ready to display */
export async function loadPanorama(opts = {}) {
  if (!files.pano) return false;
  let cap = Math.min(S.maxTex || 4096, 8192);
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) cap = Math.min(cap, 4096);
  S.layout = S.layoutOrig;
  // With a depth map the second eye of a stereo panorama is not needed: crop it away, doubling
  // the left eye's resolution for the same memory.
  // VR: when a headset is available (S.xrKeepEyes, set by xr.js) both eyes are kept for stereo 3DoF.
  S.cropEye = S.layout !== 'mono' && S.hasDepthFile && !S.xrKeepEyes;
  const key = [S.kind, files.pano.id, files.depth ? files.depth.id : '-', S.cropEye, cap, S.depthInvert, S.swapEyes].join('|');
  if (S.texKey === key && (panoTex || PH.ready)) return true;
  if (S.kind === 'photo') return loadPhotoView(key);

  freePano();
  busy(true, t('декодування', 'decoding'), 'Loading');
  let bmp = null, dbmp = null;
  const crop = S.cropEye ? eyeRect(S.layout, S.swapEyes) : null;
  try {
    bmp = await toBitmap(files.pano, cap, crop);
    if (files.depth) dbmp = await toBitmap(files.depth, depthBitmapCap(files.depth.w, files.depth.h), null);
  } catch (err) { busy(false); throw new Error(t('Не вдалося декодувати зображення.\n\n', 'Could not decode the image.\n\n') + err.message); }
  const effLayout = crop ? 'mono' : S.layout;
  S.small = makeSmall(bmp, effLayout, S.swapEyes, !!crop);
  S.panoW = bmp.width; S.panoH = bmp.height;
  const mip = bmp.width * bmp.height <= 8192 * 4096;
  panoTex = makePanoTexture(bmp, mip);
  if (!uploadChecked(panoTex) && cap > 4096) {           // does not fit: retry at half size
    panoTex.dispose();
    if (bmp.close) bmp.close();
    cap = 4096;
    bmp = await toBitmap(files.pano, cap, crop);
    S.panoW = bmp.width; S.panoH = bmp.height;
    panoTex = makePanoTexture(bmp, true);
    if (!uploadChecked(panoTex)) { busy(false); if (bmp.close) bmp.close(); panoTex = null; throw new Error(t('Забракло пам\'яті GPU для панорами.', 'Out of GPU memory while uploading the panorama.')); }
  }
  if (bmp && bmp.close) bmp.close();                       // ← plugs the main memory leak
  panoTex.image = { width: S.panoW, height: S.panoH };    // three no longer needs the closed bitmap
  panoUniforms.uPano.value = panoTex;
  panoUniforms.uPanoSize.value.set(S.panoW, S.panoH);
  S.layoutEff = effLayout;                                 // only one eye remains after cropping
  setEyeLayout();

  if (dbmp) {
    depthSrcTex = makeDataTexture(dbmp);
    uploadChecked(depthSrcTex);
    S.depthSrcInfo = { w: dbmp.width, h: dbmp.height };
    if (dbmp.close) dbmp.close();
    depthSrcTex.image = { width: S.depthSrcInfo.w, height: S.depthSrcInfo.h };
  }
  await rebuildDepth();
  S.texKey = key;
  return true;
}
/* Flat photo: the panorama meshes are hidden and the photo layers take over */
async function loadPhotoView(key) {
  freePano();
  setPanoMode('none');
  busy(true, t('декодування', 'decoding'), 'Loading photo');
  try {
    await loadPhoto(files.pano, files.depth, {}, step => busy(true, step, 'Loading photo'));
  } catch (err) { busy(false); throw err; }
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512;   // thumbnail source
  try { c.getContext('2d').drawImage(files.pano.img, 0, 0, 1024, 512); } catch (e) { }
  S.small = c;
  showPhoto(true);
  S.depthReady = PH.hasDepth;
  S.depthCPU = PH.hasDepth ? { photo: true, w: PH.DW, h: PH.DH, dn: PH.dn } : null;   // lets 3D objects find the surface
  busy(false);
  $('dbtn').style.display = S.depthReady ? 'flex' : 'none';
  updateInfo();
  S.texKey = key;
  emit('depth-ready');
  return true;
}

/* Rebuild depth (e.g. after inverting the map) */
export async function rebuildDepth() {
  if (S.kind === 'photo') { S.texKey = null; return loadPanorama({}); }
  const canDepth = S.vtf && (depthSrcTex || S.layoutEff !== 'mono');
  if (canDepth) {
    const ttl = depthSrcTex ? 'Importing depth' : 'Reconstructing depth';
    busy(true, '', ttl);
    try {
      await buildDepth(panoTex, depthSrcTex, S.depthSrcInfo, step => busy(true, step, ttl));
    } catch (err) {
      console.error(err);
      S.depthReady = false; busy(true, 'Depth failed: showing the image flat');
      await new Promise(r => setTimeout(r, 900));
    }
  } else disposeDepth();
  busy(false);
  sphereL.material.uniforms.uHasDepth.value = S.depthReady ? 1 : 0;
  panoUniforms.uNearM.value = S.near;
  showPhoto(false);
  setPanoMode(S.depthReady ? 'mesh' : 'sphere');
  $('dbtn').style.display = S.depthReady ? 'flex' : 'none';
  if (!S.depthReady && S.showDepth) setDepthMode(0);
  updateInfo();
  emit('depth-ready');
}

/* ═══════════ viewer UI ═══════════ */
let loopFn = null;
export function setLoop(fn) { loopFn = fn; }
export function pauseLoop() { renderer.setAnimationLoop(null); }
export function resumeLoop() { if (S.running) renderer.setAnimationLoop(loopFn); }
export function ensureLoop() { if (!S.running) { S.running = true; renderer.setAnimationLoop(loopFn); } }

/* ═══════════ depth views ═══════════ */
export const DEPTH_MODES = [
  [0, 'Image', 'The photograph as it is'],
  [1, 'Depth', 'Depth map in grey: near is white'],
  [2, 'Colour', 'Depth as a colour scale: near is red, far is blue'],
  [3, 'Contours', 'Lines of equal distance'],
  [4, 'Slice', 'Highlights one distance band, dims the rest'],
  [5, 'Normals', 'Orientation of the rebuilt surfaces'],
  [6, 'Fog', 'Aerial haze that grows with distance']
];
const depthRange = () => S.kind === 'photo' ? [1, Math.max(2, PH.range * 1.15)] : [0.3, 300];
function depthDistFromSlider(v) { const [lo, hi] = depthRange(); return lo * Math.pow(hi / lo, v / 1000); }
function applyDepthDist() {
  const d = depthDistFromSlider(+$('sDepthD').value);
  panoUniforms.uDepthD.value = d;
  panoUniforms.uDepthW.value = Math.max(0.05, d * (S.kind === 'photo' ? 0.08 : 0.1));
  $('oDepthD').textContent = S.kind === 'photo' ? d.toFixed(2) + '×' : fmtDist(d);
}
const fmtDist = d => d < 10 ? d.toFixed(1) + ' m' : Math.round(d) + ' m';
export function setDepthMode(m) {
  if (!S.depthReady) m = 0;
  S.showDepth = m;
  panoUniforms.uShowDepth.value = m;                   // the photo shader shares this uniform
  $('dbtn').classList.toggle('on', m > 0);
  $('depthModes').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.m === m));
  $('rowDepthD').hidden = !(m === 4 || m === 6);
  $('rowDepthMix').hidden = m === 0;
  $('lblDepthD').textContent = m === 6 ? 'Fog distance' : 'Distance';
  applyDepthDist();
  showHUD();
}
/* Background option (photos on a server with MI-GAN) */
export function syncBgFill() {
  const show = S.kind === 'photo' && inpaintAvailable() && PH.hasDepth;
  $('rowBgFill').hidden = !show;
  if (!show) return;
  $('bgFillSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === BG.pref));
  $('bgFillNote').textContent = PH.bgError && BG.pref === 'ai' ? 'AI background failed, built-in fill shown: ' + PH.bgError.slice(0, 120)
    : 'What appears behind objects when the viewpoint moves.';
  $('bgFillNote').classList.toggle('err', !!(PH.bgError && BG.pref === 'ai'));
}
/* Rebuild the current photo (e.g. after switching the background fill); objects stay */
export async function reprocessPhoto() {
  if (S.kind !== 'photo' || !files.pano || !S.running) return;
  const dm = S.showDepth;
  try { await loadPhotoView(S.texKey); } catch (err) { fatal(err.message || String(err)); return; }
  setDepthMode(dm); syncBgFill();
}
export function cycleDepthView() { setDepthMode((S.showDepth + 1) % DEPTH_MODES.length); hint(DEPTH_MODES[S.showDepth][1], 1200); }
function toggleDepthPanel(force) {
  const p = $('depthPanel'), open = force != null ? force : p.hidden;
  p.hidden = !open;
  $('dbtn').setAttribute('aria-expanded', open);
  if (open) syncBgFill();
}
function bindDepthPanel() {
  const box = $('depthModes');
  for (const [m, label, title] of DEPTH_MODES) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.m = m; b.textContent = label; b.title = title;
    b.onclick = e => { e.stopPropagation(); setDepthMode(m); };
    box.appendChild(b);
  }
  $('sDepthMix').addEventListener('input', e => { panoUniforms.uDepthMix.value = e.target.value / 100; $('oDepthMix').textContent = e.target.value + ' %'; });
  $('sDepthD').addEventListener('input', applyDepthDist);
  $('depthDl').addEventListener('click', e => { e.stopPropagation(); downloadDepthPNG(); });
  $('bgFillSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (BG.pref === b.dataset.v) return;
    setBgFill(b.dataset.v); syncBgFill(); reprocessPhoto();
  }));
  $('dbtn').addEventListener('click', e => { e.stopPropagation(); toggleDepthPanel(); });
  document.addEventListener('pointerdown', e => {
    if (!$('depthPanel').hidden && !e.target.closest('#depthPanel,#dbtn')) toggleDepthPanel(false);
  });
  setDepthMode(0);
}

export function bindViewerUI() {
  $('sMove').addEventListener('input', e => { S.move = e.target.value / 100; updateInfo(); showHUD(); });
  // 0.35 = depth exaggerated 2x, 0.70 = true metric scale, 3.0 = compressed
  $('sNear').addEventListener('input', e => {
    if (S.kind === 'photo') { setRange(1.25 * Math.pow(16, e.target.value / 100)); updateInfo(); showHUD(); return; }
    S.near = 0.35 * Math.pow(8.6, e.target.value / 100); panoUniforms.uNearM.value = S.near;
    S.calibrated = false; updateInfo(); showHUD(); emit('scale-changed');
  });
  // 0 = camera does not affect distance, 40 = physically accurate response, 100 = 2.5x gain
  $('sDist').addEventListener('input', e => { S.zGain = e.target.value * 0.025; updateInfo(); showHUD(); });
  $('sFocus').addEventListener('input', e => { setFocus(e.target.value / 100); updateInfo(); showHUD(); });
  $('fitBtn').addEventListener('click', e => {
    e.stopPropagation();
    PH.fill = !PH.fill; $('fitBtn').textContent = PH.fill ? 'Fill' : 'Fit';
    $('fitBtn').classList.toggle('on', PH.fill); updateInfo(); showHUD();
  });
  $('rotBtn').addEventListener('click', e => {
    e.stopPropagation();
    S.autoRot = !S.autoRot; $('rotBtn').classList.toggle('on', S.autoRot);
    $('rotBtn').setAttribute('aria-pressed', S.autoRot); showHUD();
  });
  $('revBtn').addEventListener('click', e => {
    e.stopPropagation();
    S.zRev = !S.zRev; $('revBtn').classList.toggle('on', S.zRev);
    $('revBtn').setAttribute('aria-pressed', S.zRev); showHUD();
  });
  bindDepthPanel();
  $('fsbtn').addEventListener('click', e => { e.stopPropagation(); toggleFullscreen(); showHUD(); });
  $('modeBtn').addEventListener('click', e => { e.stopPropagation(); setMode(S.mode === 'live' ? 'lock' : 'live'); });
  $('headBtn').addEventListener('click', e => {
    e.stopPropagation();
    if (Head.on) headStop(); else headStart();
    showHUD();
  });
  $('close').addEventListener('click', () => closeViewer());
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && S.running && !S.wake) {
      try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
    }
  });
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); fatal(t('Втрачено контекст WebGL — перезавантажте сторінку.', 'The WebGL context was lost. Reload the page.')); });
  document.addEventListener('gesturestart', e => e.preventDefault());
  window.addEventListener('orientationchange', () => { S.baseSet = false; });
  if (!('DeviceOrientationEvent' in window)) $('note').textContent = t('Сенсорів руху немає — тягніть, щоб роззирнутися.', 'No motion sensors on this device: drag to look around.');
}

export function fatal(msg) {
  const b = $('busy');
  b.classList.add('on', 'err');
  $('busyTitle').textContent = t('Помилка', 'Error');
  $('busyStep').innerHTML = '<div class="errmsg"></div><button class="chip" id="errBack" type="button">← ' + t('Назад', 'Back') + '</button>';
  b.querySelector('.errmsg').textContent = String(msg).slice(0, 700);
  $('errBack').onclick = () => { b.classList.remove('on', 'err'); closeViewer(); };
  $('stage').classList.add('on');
}

/* Generate a depth map with the available AI engine and put it into the depth slot */
export async function makeDepth(status) {
  if (!files.pano) return false;
  const eng = engineFor(S.kind);
  if (!eng) return false;
  const base = (files.pano.name || 'image').replace(/\.[^.]+$/, '');
  let lib = null;          // library item on the nomono3d server: the result is stored next to it
  if (S.item && S.item.src && AI.server && AI.server.upload) {
    const u = new URL(S.item.src, location.href), basePath = new URL('.', location.href).pathname;
    if (u.origin === location.origin && u.pathname.startsWith(basePath)) lib = decodeURIComponent(u.pathname.slice(basePath.length));
  }
  const blob = await generateDepth(files.pano.file, S.kind, { name: files.pano.name, librarySrc: lib }, status);
  await pick('depth', blob, { name: base + '_depth.png', generated: true });
  if (S.item && blob.savedAs) S.item.depth = new URL(blob.savedAs, location.href).href;   // already URL-encoded
  return true;
}

/* Open the viewer */
export async function openViewer(opts = {}) {
  if (!files.pano && !opts.prepare) return false;
  const stage = $('stage'); stage.classList.add('on'); $('load').style.display = 'none';
  document.body.classList.add('viewing');
  if (!S.running) { S.running = true; renderer.setAnimationLoop(loopFn); }
  // Request full screen and sensors immediately: after a long load the
  // browser would no longer treat it as a response to a user gesture.
  const fsP = goFullscreen();
  const motionP = requestMotion();
  let ok = false;
  try {
    if (opts.prepare) { busy(true, '…', 'Loading'); await opts.prepare(s => busy(true, s, 'Loading')); }
    await detectServer();
    if (!files.depth && engineFor(S.kind)) {
      try { await makeDepth(s => busy(true, s, 'Estimating depth')); }
      catch (err) { console.warn(err); hint(t('Не вдалося оцінити глибину: ', 'Depth estimation failed: ') + String(err.message || err).slice(0, 140), 6000); }
    }
    ok = await loadPanorama(opts);
  }
  catch (err) { busy(false); fatal(err.message || String(err)); return false; }
  const [fsKind, granted] = await Promise.all([fsP, motionP]);
  const photo = S.kind === 'photo';
  S.mode = granted && !photo ? 'live' : 'lock';
  $('modeBtn').textContent = S.mode === 'live' ? 'Live' : 'Lock';
  $('modeBtn').classList.toggle('locked', S.mode === 'lock');
  $('modeBtn').disabled = !granted;
  S.baseSet = false;
  applyKindUI();
  $('dbtn').style.display = S.depthReady ? 'flex' : 'none';
  updateInfo();
  if (S.errs && S.errs.length) hint('Limited mode: ' + S.errs[0], 6000);
  if (fsKind === 'pseudo' && !Full.supported) hint(t('Додайте на головний екран для справжнього повного екрана', 'Add to Home Screen for true full screen'), 4200);
  try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
  if (!S.bound) { bindPointer(); S.bound = true; }
  showHUD();
  emit('pano-ready', { first: true });
  return ok;
}

/* HUD differences between panoramas and photos */
export function applyKindUI() {
  const photo = S.kind === 'photo';
  document.body.dataset.kind = S.kind;
  $('modeBtn').hidden = photo;
  $('edBtn').hidden = !!S.kiosk;
  $('rowFocus').hidden = !photo;
  $('fitBtn').hidden = !photo;
  $('rotBtn').textContent = photo ? 'Orbit' : 'Rotate';
  $('lblNear').textContent = photo ? 'Depth' : 'Scale';
  if (photo) {
    $('sNear').value = Math.round(100 * Math.log(PH.range / 1.25) / Math.log(16));
    $('sFocus').value = Math.round(PH.focus * 100);
    $('fitBtn').textContent = PH.fill ? 'Fill' : 'Fit'; $('fitBtn').classList.toggle('on', PH.fill);
  } else $('sNear').value = Math.round(100 * Math.log(S.near / 0.35) / Math.log(8.6));
  panoUniforms.uMetric.value = photo ? 0 : 1;
  setDepthMode(0); toggleDepthPanel(false); syncBgFill();
}

export function closeViewer() {
  emit('viewer-closing');
  S.running = false; renderer.setAnimationLoop(null);
  fsExit(); if (Full.pseudo) pseudoOff(); syncFS();
  try { if (S.wake && S.wake.release) S.wake.release(); } catch (e) { } S.wake = null;
  if (Head.on) headStop();
  $('stage').classList.remove('on'); $('load').style.display = '';
  document.body.classList.remove('viewing');
  emit('viewer-closed');
}

/* Download the reconstructed/imported depth map as a PNG */
export function downloadDepthPNG() {
  const c = S.kind === 'photo' ? photoDepthCanvas() : depthToCanvas(); if (!c) return;
  const base = (files.pano && files.pano.name ? files.pano.name.replace(/\.[^.]+$/, '') : 'panorama');
  c.toBlob(b => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = base + '_depth.png';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}
