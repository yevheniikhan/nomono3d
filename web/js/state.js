// Shared state, constants and small utilities. Imported by every module.
export const DEG = Math.PI / 180, TAU = Math.PI * 2;
export const $ = s => document.getElementById(s);
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;

/* Metric range that depth is encoded into (shared by all sources) */
export const D_FAR = 300.0;
export const IPD_HALF = 0.0315;     // half the interpupillary distance, m (stereo reconstruction)

export const S = {
  ready: false, maxTex: 4096, errs: [],
  // panorama layout: 'mono' | 'tb' (left eye on top) | 'sbs' (left eye on the left)
  layout: 'mono', layoutOrig: 'mono', swapEyes: false, cropEye: false,
  hasDepthFile: false, depthReady: false, depthInvert: false,
  depthCPU: null,                     // {w,h,dn:Float32Array}: normalised inverse depth
  depthW: 0, depthH: 0, fitR2: 0, camH: 2.0, calibrated: false,
  // 2D camera
  yaw: 0, pitch: 0, fov: 78 * Math.PI / 180, fovEff: 78 * Math.PI / 180,
  inset: null, shift: { x: 0, y: 0 },  // frame area covered by the editor panel and projection-centre shift, CSS px
  rot: new Float32Array(9), qTarget: [0, 0, 0, 1], qCam: [0, 0, 0, 1], camSet: false,
  mode: 'live', catchup: 0, showDepth: 0,     // 0 photo, 1 depth map, 2 photo + contours
  gyro: false, absolute: false, raw: { x: 0, y: 0 }, base: { x: 0, y: 0 }, baseSet: false,
  gTilt: { x: 0, y: 0 }, tTilt: { x: 0, y: 0 }, tilt: { x: 0, y: 0 }, dolly: 0, infoT: -1,
  drag: null, pinch: null, move: 0.55, near: 2.10,
  zGain: 1.0, zRev: false, autoRot: false, autoYaw: 0, autoVel: 0, lastTouch: 0,
  running: false, bound: false, wake: null, last: 0, dprCap: 2.5, slow: 0,
  texKey: null, panoW: 0, panoH: 0,
  // current panorama
  pano: null,          // {name, url?, blob, w, h, title, item}
  depthSrc: null,      // {name, url?, blob, w, h}
  panoKey: null,       // key for scene drafts
  item: null,          // library item (if opened from the library)
  // depth slice (aids object placement)
  slice: { on: false, dist: 3, width: 0.25 },
  kiosk: false,
  kind: 'pano',                       // 'pano': 360° panorama, 'photo': flat photo
  depthAI: false                      // depth map was estimated by the neural network
};

/* Small event bus between modules */
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, e => fn(e.detail));

/* Local preferences (try/catch: storage may throw in private mode) */
export function loadPref(key, def) {
  try { const v = localStorage.getItem('nomono3d.' + key); return v == null ? def : JSON.parse(v); }
  catch (e) { return def; }
}
export function savePref(key, val) {
  try { localStorage.setItem('nomono3d.' + key, JSON.stringify(val)); } catch (e) { }
}

/* UI message language: 'en' by default */
export const LANG = { cur: loadPref('lang', 'en') };
export function t(uk, en) { return LANG.cur === 'en' ? en : uk; }

export function fmtM(v) {
  if (!isFinite(v)) return '∞';
  return v < 10 ? v.toFixed(2) + ' m' : v < 100 ? v.toFixed(1) + ' m' : Math.round(v) + ' m';
}
export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  return n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

/* Show a brief message over the scene (2D) */
let hintTimer = 0;
export function hint(text, ms = 3200) {
  const h = $('fshint'); if (!h) return;
  h.style.whiteSpace = 'normal'; h.style.maxWidth = '80vw';
  h.textContent = text; h.classList.add('show');
  clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.remove('show'), ms);
  emit('hint', text);
}
