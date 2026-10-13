// Measure: tap two points on the rebuilt surface to get the distance between them.
// Panoramas are in metres (the calibrated scale); photos have no absolute scale, so distances
// are given relative to the nearest surface (1 = the nearest point of the photo).
import { THREE, renderer, camera, world } from './gfx.js';
import { S, $, t, on, emit, fmtM, hint } from './state.js';
import { raySurface } from './depth.js';
import { pointerHooks, showHUD } from './viewer.js';
import { roundPoints } from './styles.js';

const M = { on: false, segs: [], pending: null, raf: 0 };
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), inv = new THREE.Matrix4();
const COL = 0xF6D365;

function screenRay(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  world.updateMatrixWorld();
  inv.copy(world.matrixWorld).invert();
  return { o: ray.ray.origin.clone().applyMatrix4(inv), d: ray.ray.direction.clone().transformDirection(inv) };
}
const fmt = d => S.kind === 'photo' ? d.toFixed(2) + ' ×' : fmtM(d);

function dot(p) {
  const g = new THREE.BufferGeometry().setFromPoints([p]);
  const m = roundPoints(new THREE.PointsMaterial({ color: COL, size: 9, sizeAttenuation: false, depthTest: false, toneMapped: false, transparent: true }));
  const x = new THREE.Points(g, m); x.renderOrder = 61; x.frustumCulled = false; x.userData.noExport = true;
  world.add(x); return x;
}
function line(a, b) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const m = new THREE.LineDashedMaterial({ color: COL, dashSize: 0.06, gapSize: 0.04, depthTest: false, toneMapped: false, transparent: true });
  const l = new THREE.Line(g, m); l.computeLineDistances(); l.renderOrder = 60; l.frustumCulled = false; l.userData.noExport = true;
  // dashes scale with the length, so short and long segments look alike
  const len = a.distanceTo(b); m.dashSize = len / 24; m.gapSize = len / 40;
  world.add(l); return l;
}
function label() {
  const el = document.createElement('div'); el.className = 'mlabel';
  $('measureLayer').appendChild(el); return el;
}
function dispose(o) { if (!o) return; world.remove(o); o.geometry.dispose(); o.material.dispose(); }

function tap(e) {
  if (!S.depthCPU) { hint(t('Потрібна карта глибини.', 'A depth map is needed.'), 1800); return; }
  const { o, d } = screenRay(e.clientX, e.clientY);
  const hit = raySurface(o, d);
  if (!hit || hit.miss) return;
  const p = hit.point.clone();
  if (!M.pending) { M.pending = { a: p, dotA: dot(p) }; setStatus(); return; }
  const a = M.pending.a, seg = { a, b: p, dotA: M.pending.dotA, dotB: dot(p), line: line(a, p), el: label() };
  M.pending = null;
  const dist = a.distanceTo(p), dh = p.y - a.y;
  seg.el.innerHTML = '<b>' + fmt(dist) + '</b>' + (S.kind !== 'photo' && Math.abs(dh) > 0.05 ? '<span>↕ ' + fmtM(Math.abs(dh)) + '</span>' : '');
  M.segs.push(seg);
  emit('measure', { dist, dh });
  setStatus();
}
function setStatus() {
  const s = $('measureBar');
  s.querySelector('.mt').textContent = M.pending ? t('Торкніться другої точки', 'Tap the second point')
    : M.segs.length ? t('Торкніться, щоб виміряти ще', 'Tap to measure again') : t('Торкніться першої точки на поверхні', 'Tap a first point on a surface');
}
function place() {
  M.raf = M.on || M.segs.length ? requestAnimationFrame(place) : 0;
  const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector3();
  for (const s of M.segs) {
    v.copy(s.a).add(s.b).multiplyScalar(0.5).applyMatrix4(world.matrixWorld).project(camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    s.el.style.display = vis ? '' : 'none';
    if (vis) s.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * r.width}px, ${(-v.y * 0.5 + 0.5) * r.height}px) translate(-50%, -50%)`;
  }
}
export function clearMeasures() {
  for (const s of M.segs) { dispose(s.dotA); dispose(s.dotB); dispose(s.line); s.el.remove(); }
  M.segs = [];
  if (M.pending) { dispose(M.pending.dotA); M.pending = null; }
  if (M.on) setStatus();
}
export function measuring() { return M.on; }
export function setMeasure(v) {
  M.on = !!v && !S.xr;
  document.body.classList.toggle('measuring', M.on);
  $('measureBar').hidden = !M.on;
  if (M.on) { setStatus(); if (!M.raf) place(); }
  else if (M.pending) { dispose(M.pending.dotA); M.pending = null; }
  showHUD();
}
export function initMeasure() {
  const prevTap = pointerHooks.tap;
  pointerHooks.tap = e => { if (M.on) tap(e); else if (prevTap) prevTap(e); };
  $('measureDone').addEventListener('click', e => { e.stopPropagation(); setMeasure(false); });
  $('measureClear').addEventListener('click', e => { e.stopPropagation(); clearMeasures(); });
  document.addEventListener('keydown', e => { if (M.on && e.key === 'Escape') setMeasure(false); });
  on('viewer-closing', () => { setMeasure(false); clearMeasures(); });
  on('pano-ready', () => clearMeasures());
}
