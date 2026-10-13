// 3D objects in the panorama: depth-aware placement, effects, animation, scene saving.
import { THREE, renderer, scene, world, objectsRoot, sun, hemi, buildEnvironment, panoUniforms } from './gfx.js';
import { S, $, t, emit, on, clamp, DEG, hint, fmtM } from './state.js';
import { loadModel, extOf, unzipBlob } from './loaders.js';
import { raySurface, surfaceNormal, groundAt, surfaceDistDir, uvToDir, dirToUv } from './depth.js';
import { idbGet, idbPut, idbDel } from './idb.js';
import { files } from './viewer.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { matcap, enhance, heightUniforms, heightMaterial, xrayMaterial, toonGradient, isUntextured, roundPoints } from './styles.js';

export const FX_DEFAULT = Object.freeze({
  style: 'normal', opacity: 1, bright: 1, tint: '#ffffff', tintA: 0, glow: '#7fd8ff', glowA: 0,
  outline: '#ffd24a', outlineW: 0, pointSize: 12, shadow: 'blob', shadowA: 0.55, occlude: true,
  spin: 0, bob: 0, clip: '', clipSpeed: 1, appear: 'fade', label: 'off', labelText: '', enhance: 'auto', edges: false
});
export const LIGHT_DEFAULT = Object.freeze({ env: 1.0, az: 35, el: 50, sun: 1.6, exp: 1.0, haze: 0 });
export const OBJ = {
  list: [], sel: null, light: Object.assign({}, LIGHT_DEFAULT), time: 0, nearRef: null,
  shadowDirty: true, envFor: null, hazeColor: new THREE.Color(0x9aa4ad), draftInfo: null, loading: 0
};
const ORIG = new WeakMap();                 // mesh → original materials (not in userData: clone() serialises it to JSON)
let idSeq = 0;
const V3 = () => new THREE.Vector3();
const arr = m => Array.isArray(m) ? m : [m];

/* ═══════════ creation ═══════════ */
export async function addObject(source, opts = {}) {
  OBJ.loading++; emit('objects-changed');
  try {
    const res = await loadModel(source, s => opts.status && opts.status(s));
    ensureEnv();
    const o = buildObject(res, source, opts);
    OBJ.list.push(o);
    objectsRoot.add(o.root);
    if (opts.restore) restoreInto(o, opts.restore);
    else placeNew(o, opts);
    if (!opts.restore && o.clips.length) o.fx.clip = o.clips[0].name;
    applyFx(o);
    playClip(o);
    startAppear(o);
    if (source.files && !opts.restore) {
      o.src.key = 'm:' + o.id;
      idbPut('blobs', o.src.key, { files: source.files.map(f => ({ name: f.name, blob: f.blob })) });
    }
    OBJ.shadowDirty = true;
    if (!opts.silent) { select(o); markDirty(); }
    return o;
  } finally { OBJ.loading--; emit('objects-changed'); }
}

function buildObject(res, source, opts) {
  const id = (opts.restore && opts.restore.id) || ('o' + Date.now().toString(36) + (idSeq++).toString(36));
  const root = new THREE.Group(); root.name = 'obj:' + id;
  const anim = new THREE.Group(); root.add(anim);
  const pivot = new THREE.Group(); anim.add(pivot);
  const wrap = new THREE.Group(); pivot.add(wrap);           // our pivot offset/rotation; the model itself is left untouched
  const model = res.object; wrap.add(model);
  const o = {
    id, name: (opts.restore && opts.restore.name) || prettyName(res.name), root, anim, pivot, wrap, model,
    isPoints: res.isPoints, zUp: res.zUp, unitK: 1, size0: V3(), phase: Math.random() * 6.28,
    fx: Object.assign({}, FX_DEFAULT, res.isPoints ? { shadow: 'none' } : {}),
    clips: res.animations || [], mixer: null, action: null, helpers: {},
    src: source.url ? { kind: 'url', url: source.url } : { kind: 'local', files: source.files, main: res.name },
    ext: res.ext, appear: null, labelOn: false, hU: heightUniforms()
  };
  model.traverse(m => {
    if (m.isMesh || m.isPoints) {
      if (m.isMesh) { fixNormals(m, res.ext); m.frustumCulled = true; }
      ORIG.set(m, m.material);
    }
  });
  o.untextured = (() => { let any = false, all = true; model.traverse(m => { if (m.isMesh) { any = true; if (!isUntextured(m, m.material)) all = false; } }); return any && all; })();
  if (o.clips.length) o.mixer = new THREE.AnimationMixer(model);
  normalize(o, opts.restore ? opts.restore.up === 'z' : res.zUp, opts.restore ? opts.restore.unitK : null);
  return o;
}
/* Untextured scans and CAD exports often come without usable normals (faceted STL, unindexed
   OBJ/PLY): CAD gets creased normals (hard edges stay sharp), scans get welded smooth normals. */
function fixNormals(m, ext) {
  const g = m.geometry; if (!g || !g.attributes.position) return;
  if (!g.attributes.normal) { g.computeVertexNormals(); return; }
  if (g.index || !isUntextured(m, m.material) || g.attributes.position.count > 1.5e6 || m.isSkinnedMesh) return;
  try {
    if (ext === 'stl' || ext === '3mf') m.geometry = toCreasedNormals(g, 32 * Math.PI / 180);
    else if (ext === 'ply' || ext === 'obj') { const w = mergeVertices(g.deleteAttribute('normal') && g, 1e-5); w.computeVertexNormals(); m.geometry = w; }
  } catch (e) { console.warn('normals', e); }
}
const prettyName = n => { const s = String(n || 'model').replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

/* Centre on X/Z, base at y=0; units: mm/cm → m by heuristic unless set explicitly */
function normalize(o, zUp, unitK) {
  o.zUp = zUp;
  o.wrap.position.set(0, 0, 0);
  o.wrap.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
  o.pivot.scale.setScalar(1);
  const box = new THREE.Box3();
  o.wrap.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(o.pivot.matrixWorld).invert();
  o.model.traverse(m => {
    if ((m.isMesh || m.isPoints) && m.geometry) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      box.union(b);
    }
  });
  if (box.isEmpty()) box.set(V3().setScalar(-0.5), V3().setScalar(0.5));
  const c = box.getCenter(V3());
  o.wrap.position.set(-c.x, -box.min.y, -c.z);
  const size = box.getSize(V3());
  let k = 1;
  if (unitK) k = unitK;
  else {
    const mx = Math.max(size.x, size.y, size.z);
    if ((o.ext === 'stl' || o.ext === '3mf') && mx > 2) k = 0.001;           // 3D print/CAD: millimetres
    else if (mx > 60) k = (mx / 100 >= 0.05 && mx / 100 <= 60) ? 0.01 : 0.001;   // centimetres or millimetres
    else if (mx < 0.02 && mx > 0) k = 1 / mx;                              // tiny model: scale up to 1 m
  }
  o.unitK = k;
  o.pivot.scale.setScalar(k);
  o.size0.copy(size).multiplyScalar(k);
  if (o.size0.y < 1e-4) o.size0.y = Math.max(o.size0.x, o.size0.z) * 0.05 || 0.01;
}
export function setUpAxis(o, zUp) {
  normalize(o, zUp, o.unitK);
  rebuildHelpers(o); markDirty();
  if (OBJ.sel === o) showSelBox(o, true);
}

/* ═══════════ placement ═══════════ */
// Point where the object's base will stand: on the ground, as is; on a wall/trunk, the ground in front of it.
export function placementPoint(hit) {
  const p = hit.point.clone();
  if (!S.depthCPU) return p;
  const n = surfaceNormal(p);
  if (n.y > 0.55) return p;
  const h = Math.hypot(p.x, p.z);
  const k = h > 1e-3 ? Math.max(0.3, 1 - Math.min(0.6, 0.45 / h)) : 1;
  p.x *= k; p.z *= k;
  p.y = groundAt(p.x, p.z);
  return p;
}
export function faceViewer(o) {
  const p = o.root.position;
  const yaw = Math.atan2(-p.x, -p.z);
  o.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  OBJ.shadowDirty = true;
}
function placeNew(o, opts) {
  // Default size: real size if the model is metric, otherwise fitted to the distance
  let p = opts.point ? opts.point.clone() : null;
  if (!p) {
    const dir = opts.dir ? opts.dir.clone() : new THREE.Vector3(0, -0.25, -1).normalize();
    const hit = raySurface(opts.origin || new THREE.Vector3(), dir);
    p = placementPoint(hit);
  }
  o.root.position.copy(p);
  const d = p.length();
  let s = 1;
  const h = o.size0.y;
  // Keep the real size; adjust only absurd cases (flagged in the UI)
  if (h * s > d * 3) s = d * 0.8 / h;
  if (h * s < d * 0.01) s = d * 0.06 / h;
  o.root.scale.setScalar(s);
  o.autoScaled = s !== 1;
  faceViewer(o);
}
export function setDistance(o, d, keepApparent) {
  const p = o.root.position, L = p.length();
  d = Math.max(0.15, d);
  if (L < 1e-6) p.set(0, 0, -d); else p.multiplyScalar(d / L);
  if (keepApparent && L > 1e-6) o.root.scale.multiplyScalar(d / L);
  OBJ.shadowDirty = true;
}
export function surfaceInfo(o) {
  const p = o.root.position, L = p.length();
  if (L < 1e-6 || !S.depthCPU) return { dist: L, surf: null, behind: false };
  const dir = p.clone().divideScalar(L);
  const surf = surfaceDistDir(dir);
  const top = o.root.localToWorld(new THREE.Vector3(0, o.size0.y, 0));
  objectsRoot.worldToLocal(top);
  const tL = top.length(), surfTop = surfaceDistDir(top.clone().divideScalar(tL || 1));
  return { dist: L, surf, behind: L > surf * 1.03 + 0.05 && tL > surfTop * 1.03 + 0.05 };
}
/* Gravity: the object falls from where it was released and settles with a small bounce */
export function startFall(o) {
  if (!S.depthCPU) return;
  const p = o.root.position;
  o.fall = { v: 0, target: groundAt(p.x, p.z), bounces: 0 };
  if (p.y < o.fall.target) { p.y = o.fall.target; o.fall = null; }
}
export function dropToGround(o) {
  const p = o.root.position;
  if (S.depthCPU) p.y = groundAt(p.x, p.z);
  OBJ.shadowDirty = true; markDirty();
}
export function toSurface(o) {
  const p = o.root.position, L = p.length(); if (L < 1e-6) return;
  const hit = raySurface(new THREE.Vector3(), p.clone().divideScalar(L));
  o.root.position.copy(placementPoint(hit));
  OBJ.shadowDirty = true; markDirty();
}
export function alignToNormal(o) {
  const n = surfaceNormal(o.root.position);
  const yaw = new THREE.Euler().setFromQuaternion(o.root.quaternion, 'YXZ').y;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  o.root.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  OBJ.shadowDirty = true; markDirty();
}
export function setHeight(o, h) {
  if (!(h > 0)) return;
  o.root.scale.setScalar(h / o.size0.y);
  OBJ.shadowDirty = true; rebuildHelpers(o);
}
export function setYaw(o, deg) {
  const e = new THREE.Euler().setFromQuaternion(o.root.quaternion, 'YXZ');
  e.y = deg * DEG;
  o.root.quaternion.setFromEuler(e);
  OBJ.shadowDirty = true;
}

/* ═══════════ selection and picking ═══════════ */
export function select(o) {
  if (OBJ.sel === o) return;
  const prev = OBJ.sel;
  OBJ.sel = o || null;
  if (prev) { showSelBox(prev, false); updateLabelVis(prev); }
  if (o) { showSelBox(o, true); updateLabelVis(o); }
  emit('selection', OBJ.sel);
}
const _inv = new THREE.Matrix4(), _ray = new THREE.Ray(), _box = new THREE.Box3();
// Ray in world (panorama) coordinates. Returns the nearest object by OBB.
export function pickObject(origin, dir, maxT = Infinity) {
  let best = null;
  for (const o of OBJ.list) {
    if (!o.root.visible) continue;
    o.root.updateMatrix();
    _inv.copy(o.root.matrix).invert();
    _ray.origin.copy(origin).applyMatrix4(_inv);
    _ray.direction.copy(dir).transformDirection(_inv);
    const s = o.size0, by = o.anim.position.y;
    _box.min.set(-s.x / 2, by, -s.z / 2); _box.max.set(s.x / 2, by + s.y, s.z / 2);
    const hp = _ray.intersectBox(_box, V3());
    if (!hp) continue;
    hp.applyMatrix4(o.root.matrix);
    const t = hp.distanceTo(origin);
    if (t < maxT && (!best || t < best.t)) best = { obj: o, t, point: hp };
  }
  return best;
}
function showSelBox(o, on) {
  if (o.helpers.sel) { o.root.remove(o.helpers.sel); o.helpers.sel.geometry.dispose(); o.helpers.sel = null; }
  if (!on) return;
  const s = o.size0;
  const g = new THREE.BufferGeometry().setFromPoints(boxEdges(s));
  const m = new THREE.LineBasicMaterial({ color: 0x8fd18a, transparent: true, opacity: 0.7, depthTest: false, toneMapped: false });
  const l = new THREE.LineSegments(g, m); l.renderOrder = 50; l.userData.fxHelper = true; l.userData.noExport = true;
  o.root.add(l); o.helpers.sel = l;
}
function boxEdges(s) {
  const x = s.x / 2, z = s.z / 2, y = s.y, P = (a, b, c) => new THREE.Vector3(a, b, c);
  const c = [P(-x, 0, -z), P(x, 0, -z), P(x, 0, z), P(-x, 0, z), P(-x, y, -z), P(x, y, -z), P(x, y, z), P(-x, y, z)];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return e.map(i => c[i]);
}

/* ═══════════ effects ═══════════ */
const HOLO_VS = `
#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main(){
  #include <beginnormal_vertex>
  #include <morphinstance_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vN = normalize(transformedNormal);
  vV = -mvPosition.xyz;
  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
}`;
const HOLO_FS = `
uniform vec3 uColor; uniform float uTime, uOpacity, uScan;
varying vec3 vN; varying vec3 vV; varying vec3 vW;
void main(){
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float scan = 0.6 + 0.4*sin(vW.y*uScan - uTime*5.0);
  float flick = 0.93 + 0.07*sin(uTime*31.0);
  vec3 c = uColor*(0.22 + 1.7*f)*scan*flick;
  gl_FragColor = vec4(c, clamp((0.16 + 0.85*f)*uOpacity, 0.0, 1.0));
}`;
const holoUniforms = { uTime: { value: 0 } };
function holoMat(o) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(o.fx.glow) }, uTime: holoUniforms.uTime, uOpacity: { value: o.fx.opacity }, uScan: { value: 60 / Math.max(0.2, o.size0.y * o.root.scale.x) * 2.5 } },
    vertexShader: HOLO_VS, fragmentShader: HOLO_FS, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false
  });
}
const LIT = m => m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);
function tinted(o, base) {
  const c = new THREE.Color(base);
  if (o.fx.tintA > 0) c.lerp(new THREE.Color(o.fx.tint), o.fx.tintA);
  return c.multiplyScalar(o.fx.bright);
}
function workMaterial(o, om, isPoints, mesh) {
  const fx = o.fx, op = fx.opacity * (o.appearK ?? 1), side = om.side ?? THREE.FrontSide;
  const scale = Math.max(o.size0.x, o.size0.y, o.size0.z) || 1;
  let m;
  if (isPoints) {
    m = roundPoints(om.clone());
    m.size = fx.pointSize / 1000; m.sizeAttenuation = true;
    if (fx.tintA > 0 && m.color) m.color.lerp(new THREE.Color(fx.tint), fx.tintA);
    if (m.color) m.color.multiplyScalar(fx.bright);
  } else switch (fx.style) {
    case 'hologram': m = holoMat(o); m.uniforms.uOpacity.value = op; break;
    case 'clay':
      m = enhance(new THREE.MeshStandardMaterial({ color: tinted(o, 0xd9d3c7), roughness: 0.92, metalness: 0, side }), { cavity: 0.75, hU: o.hU, curvScale: 1 / scale });
      break;
    case 'studio': case 'porcelain': case 'jade':
      m = new THREE.MeshMatcapMaterial({ matcap: matcap(fx.style), color: tinted(o, 0xffffff), side, flatShading: false });
      break;
    case 'bronze':
      m = enhance(new THREE.MeshStandardMaterial({ color: tinted(o, 0xb8733a), roughness: 0.32, metalness: 1, side }), { cavity: 0.55, hU: o.hU, curvScale: 1 / scale });
      break;
    case 'technical':
      m = enhance(new THREE.MeshStandardMaterial({ color: tinted(o, 0xdde2e6), roughness: 0.8, metalness: 0, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), { cavity: 0.3, curvScale: 1 / scale });
      break;
    case 'toon':
      m = new THREE.MeshToonMaterial({ color: tinted(o, om.color ? om.color.getHex() : 0xcfd4d8), map: om.map || null, gradientMap: toonGradient(), side });
      break;
    case 'xray': m = xrayMaterial(fx.glow, false); break;
    case 'normals': m = new THREE.MeshNormalMaterial({ side }); break;
    case 'height': m = heightMaterial(o.hU, side); break;
    default: {
      m = om.clone();
      if (m.color) {
        if (fx.tintA > 0) m.color.lerp(new THREE.Color(fx.tint), fx.tintA);
        m.color.multiplyScalar(fx.bright);
      }
      if (fx.glowA > 0) {
        if (m.emissive) { m.emissive = new THREE.Color(fx.glow); m.emissiveIntensity = fx.glowA; }
        else if (m.color) m.color.lerp(new THREE.Color(fx.glow), Math.min(1, fx.glowA * 0.5));
      }
      if (fx.style === 'wire') m.wireframe = true;
      if (fx.style === 'ghost') {
        m.transparent = true; m.depthWrite = false;
        if (m.emissive) { m.emissive = new THREE.Color(fx.glow); m.emissiveIntensity = Math.max(0.35, fx.glowA); }
      }
      // shading cues (rim, sky/ground, cavity, ground occlusion) for untextured models, or always when switched on
      const want = fx.enhance === 'on' || (fx.enhance === 'auto' && mesh && isUntextured(mesh, om));
      if (fx.style === 'normal' && want && LIT(m)) enhance(m, { cavity: 0.4, hU: o.hU, curvScale: 1 / scale });
    }
  }
  if (fx.style !== 'hologram' && fx.style !== 'xray') {
    const ghost = fx.style === 'ghost' ? 0.38 : 1;
    const eff = op * ghost * (om.opacity ?? 1);
    m.opacity = eff;
    if (eff < 0.999) { m.transparent = true; }
    else if (!om.transparent && fx.style !== 'ghost') m.transparent = false;
  }
  if (fx.style !== 'xray') {
    m.depthTest = fx.occlude;
    if (!fx.occlude) m.depthWrite = false;
  }
  m.needsUpdate = true;
  return m;
}
export function applyFx(o) {
  const fx = o.fx;
  o.model.traverse(m => {
    if (!(m.isMesh || m.isPoints) || m.userData.fxHelper) return;
    const orig = ORIG.get(m); if (!orig) return;
    const work = arr(orig).map(om => workMaterial(o, om, m.isPoints, m));
    const prev = WORK.get(m);
    if (prev) prev.forEach(x => x && x.dispose && x.dispose());
    m.material = Array.isArray(orig) ? work : work[0];
    WORK.set(m, work);
    m.castShadow = fx.shadow === 'real' && !m.isPoints;
    m.receiveShadow = false;
    m.renderOrder = fx.occlude ? 0 : 6;
  });
  rebuildHelpers(o);
  OBJ.shadowDirty = true;
}
const WORK = new WeakMap();
function setOpacityK(o, k) {
  o.appearK = k;
  const ghost = o.fx.style === 'ghost' ? 0.38 : 1;
  o.model.traverse(m => {
    const w = WORK.get(m); const orig = ORIG.get(m);
    if (!w || !orig) return;
    const oa = arr(orig);
    w.forEach((x, i) => {
      if (x.uniforms && x.uniforms.uOpacity) x.uniforms.uOpacity.value = o.fx.opacity * k;
      else { x.opacity = o.fx.opacity * k * ghost * (oa[i].opacity ?? 1); }
    });
  });
}
export function playClip(o) {
  if (!o.mixer) return;
  if (o.action) { o.action.stop(); o.action = null; }
  const clip = o.clips.find(c => c.name === o.fx.clip) || (o.fx.clip === '' ? null : null);
  if (clip) { o.action = o.mixer.clipAction(clip); o.action.play(); }
}

/* Blob shadow, real shadow receiver, outline, label */
const BLOB_VS = `uniform float uBias; varying vec2 vUv;
void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.0); mv.xyz *= (1.0 - uBias); gl_Position = projectionMatrix*mv; }`;
const BLOB_FS = `uniform float uOpacity; varying vec2 vUv;
void main(){ float r = length(vUv-0.5)*2.0; float a = 1.0 - smoothstep(0.1, 1.0, r); gl_FragColor = vec4(0.0,0.0,0.0, a*a*uOpacity); }`;
function rebuildHelpers(o) {
  const fx = o.fx, s = o.size0;
  for (const k of ['blob', 'catcher']) if (o.helpers[k]) { o.root.remove(o.helpers[k]); o.helpers[k].geometry.dispose(); o.helpers[k].material.dispose(); o.helpers[k] = null; }
  if (fx.shadow === 'blob') {
    const m = new THREE.ShaderMaterial({ uniforms: { uOpacity: { value: fx.shadowA }, uBias: { value: 0.03 } }, vertexShader: BLOB_VS, fragmentShader: BLOB_FS, transparent: true, depthWrite: false, depthTest: fx.occlude });
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    b.rotation.x = -Math.PI / 2; b.position.y = 0.003;
    b.scale.set(Math.max(s.x, 0.05) * 1.7, Math.max(s.z, 0.05) * 1.7, 1);
    b.renderOrder = 1; b.userData.fxHelper = true;
    o.root.add(b); o.helpers.blob = b;
  } else if (fx.shadow === 'real') {
    const m = new THREE.ShadowMaterial({ opacity: fx.shadowA, transparent: true, depthWrite: false, depthTest: fx.occlude });
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        mvPosition.xyz *= 0.97; gl_Position = projectionMatrix * mvPosition;`);
    };
    const c = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    c.rotation.x = -Math.PI / 2; c.position.y = 0.003;
    const r = Math.max(s.x, s.z, s.y * 1.2, 0.2) * 3.2;
    c.scale.set(r, r, 1);
    c.receiveShadow = true; c.renderOrder = 1; c.userData.fxHelper = true;
    o.root.add(c); o.helpers.catcher = c;
  }
  buildOutline(o);
  buildEdges(o);
  buildXrayBehind(o);
  buildLabel(o);
}
/* Feature edges (Technical style, or the Edges switch): lines where faces meet at more than 30° */
function buildEdges(o) {
  (o.helpers.edges || []).forEach(h => { h.parent && h.parent.remove(h); h.geometry.dispose(); h.material.dispose(); });
  o.helpers.edges = [];
  if (!(o.fx.style === 'technical' || o.fx.edges) || o.isPoints) return;
  o.model.traverse(m => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.fxHelper || !m.geometry) return;
    const tris = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    if (tris > 400000) return;                         // too heavy to extract on the fly
    const g = new THREE.EdgesGeometry(m.geometry, 30);
    const mat = new THREE.LineBasicMaterial({ color: o.fx.style === 'technical' ? 0x2a3138 : new THREE.Color(o.fx.outline), transparent: true, opacity: 0.85, depthTest: o.fx.occlude, toneMapped: false });
    const l = new THREE.LineSegments(g, mat); l.userData.fxHelper = true; l.renderOrder = 2;
    m.add(l); o.helpers.edges.push(l);
  });
}
/* X-ray: parts hidden behind the image show as a faint glass silhouette */
function buildXrayBehind(o) {
  (o.helpers.xray || []).forEach(h => { h.parent && h.parent.remove(h); h.material.dispose(); });
  o.helpers.xray = [];
  if (o.fx.style !== 'xray' || o.isPoints) return;
  o.model.traverse(m => {
    if (!m.isMesh || m.userData.fxHelper) return;
    const mat = xrayMaterial(o.fx.glow, true);
    const h = m.isSkinnedMesh ? new THREE.SkinnedMesh(m.geometry, mat) : new THREE.Mesh(m.geometry, mat);
    if (m.isSkinnedMesh) { h.bind(m.skeleton, m.bindMatrix); h.bindMode = m.bindMode; }
    h.userData.fxHelper = true; h.renderOrder = 7; h.frustumCulled = m.frustumCulled;
    m.add(h); o.helpers.xray.push(h);
  });
}
function buildOutline(o) {
  (o.helpers.hulls || []).forEach(h => { h.parent && h.parent.remove(h); h.material.dispose(); });
  o.helpers.hulls = [];
  if (!(o.fx.outlineW > 0) || o.isPoints) return;
  const meshes = [];
  o.model.traverse(m => { if ((m.isMesh || m.isSkinnedMesh) && !m.userData.fxHelper) meshes.push(m); });
  for (const m of meshes) {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(o.fx.outline), side: THREE.BackSide, toneMapped: false, depthTest: o.fx.occlude });
    mat.userData.px = o.fx.outlineW;
    mat.onBeforeCompile = sh => {
      sh.uniforms.uPx = { value: o.fx.outlineW * 0.5 };
      sh.uniforms.uRes = OUT_RES;
      sh.vertexShader = 'uniform float uPx; uniform vec2 uRes;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        vec3 vnO = normalize(normalMatrix * normal);
        vec2 dirO = length(vnO.xy) > 1e-4 ? normalize(vnO.xy) : vec2(0.0);
        gl_Position.xy += dirO * uPx * 2.0 / uRes * gl_Position.w;`);
    };
    const h = m.isSkinnedMesh ? new THREE.SkinnedMesh(m.geometry, mat) : new THREE.Mesh(m.geometry, mat);
    if (m.isSkinnedMesh) { h.bind(m.skeleton, m.bindMatrix); h.bindMode = m.bindMode; }
    h.userData.fxHelper = true; h.renderOrder = -0.5; h.frustumCulled = m.frustumCulled;
    m.add(h); o.helpers.hulls.push(h);
  }
}
const OUT_RES = { value: new THREE.Vector2(1920, 1080) };
function labelCanvas(text) {
  const lines = String(text || '').split('\n').slice(0, 6);
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const F = 44, pad = 26;
  g.font = `500 ${F}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const w = Math.min(1600, Math.max(...lines.map(l => g.measureText(l).width)) + pad * 2);
  c.width = Math.ceil(w); c.height = Math.ceil(lines.length * F * 1.3 + pad * 1.6);
  g.font = `500 ${F}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  g.fillStyle = 'rgba(8,10,12,0.78)';
  const r = 18, W = c.width, H = c.height;
  g.beginPath(); g.moveTo(r, 0); g.arcTo(W, 0, W, H, r); g.arcTo(W, H, 0, H, r); g.arcTo(0, H, 0, 0, r); g.arcTo(0, 0, W, 0, r); g.fill();
  g.fillStyle = '#f2f2f2'; g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, pad, pad * 0.8 + i * F * 1.3));
  return c;
}
function buildLabel(o) {
  if (o.helpers.label) { o.root.remove(o.helpers.label); o.helpers.label.material.map.dispose(); o.helpers.label.material.dispose(); o.helpers.label = null; }
  if (o.fx.label === 'off') return;
  const text = o.fx.labelText || o.name;
  const c = labelCanvas(text);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, toneMapped: false });
  const sp = new THREE.Sprite(m); sp.userData.fxHelper = true; sp.userData.aspect = c.width / c.height;
  sp.center.set(0.5, 0); sp.renderOrder = 8;
  o.root.add(sp); o.helpers.label = sp;
  updateLabelVis(o);
}
function updateLabelVis(o) {
  const sp = o.helpers.label; if (!sp) return;
  sp.visible = o.fx.label === 'always' || (o.fx.label === 'select' && (OBJ.sel === o || o.labelOn));
}
export function toggleLabel(o) { o.labelOn = !o.labelOn; updateLabelVis(o); }
export function setLabelOn(o, v) { o.labelOn = !!v; updateLabelVis(o); }

/* ═══════════ entrance effect and animation ═══════════ */
export function startAppear(o, force) {
  const type = o.fx.appear;
  if (type === 'none' && !force) { o.appear = null; return; }
  o.appear = { t: 0, dur: type === 'grow' ? 0.85 : 1.0, type: type === 'none' ? 'fade' : type };
  if (o.appear.type === 'fade') { setFadeMode(o, true); setOpacityK(o, 0); }
}
function setFadeMode(o, on) {
  o.model.traverse(m => { const w = WORK.get(m); if (w) w.forEach(x => { if (on) { x.transparent = true; x.needsUpdate = true; } }); });
  if (!on) applyFx(o);
}
const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
export function objectsUpdate(dt, now) {
  OBJ.time += dt;
  holoUniforms.uTime.value = OBJ.time;
  let animating = false, realShadow = false;
  renderer.getDrawingBufferSize(OUT_RES.value);
  const G = S.kind === 'photo' ? 6 : 12;          // world units per s²: panorama units are ~1.25 m
  for (const o of OBJ.list) {
    const fx = o.fx;
    if (fx.shadow === 'real') realShadow = true;
    if (o.fall && !o.held) {
      const f = o.fall, p = o.root.position;
      f.v += G * dt; p.y -= f.v * dt; animating = true; OBJ.shadowDirty = true;
      if (p.y <= f.target) {
        p.y = f.target;
        if (f.v > 1.2 && f.bounces < 2) { f.v = -f.v * 0.28; f.bounces++; }
        else { o.fall = null; markDirty(); emit('object-landed', o); }
      }
    }
    if (fx.spin) { o.anim.rotation.y += fx.spin * DEG * dt; animating = true; }
    const s = o.root.scale.x || 1;
    let by = 0;
    if (fx.bob) { by = (fx.bob / 100) * (0.5 + 0.5 * Math.sin(OBJ.time * 2.1 + o.phase)) / s; animating = true; }
    let sc = 1;
    if (o.appear) {
      o.appear.t += dt; animating = true;
      const x = clamp(o.appear.t / o.appear.dur, 0, 1);
      if (o.appear.type === 'fade') setOpacityK(o, x * x * (3 - 2 * x));
      else if (o.appear.type === 'grow') sc = Math.max(0.001, easeOutBack(x));
      else if (o.appear.type === 'rise') by += -o.size0.y * 1.05 * Math.pow(1 - x, 3);
      if (x >= 1) { const fade = o.appear.type === 'fade'; o.appear = null; o.appearK = 1; if (fade) setFadeMode(o, false); }
    }
    o.anim.position.y = by;
    o.anim.scale.setScalar(sc);
    o.hU.uHMin.value = o.root.position.y + by * o.root.scale.y;            // base and top in world space
    o.hU.uHMax.value = o.hU.uHMin.value + o.size0.y * o.root.scale.y * sc;
    if (o.mixer) { o.mixer.update(dt * fx.clipSpeed); if (o.action) animating = true; }
    if (o.helpers.blob && fx.bob) {
      const k = 1 - Math.min(0.7, by * s / Math.max(o.size0.y * s, 0.05));
      o.helpers.blob.material.uniforms.uOpacity.value = fx.shadowA * k * (o.appearK ?? 1);
    } else if (o.helpers.blob) o.helpers.blob.material.uniforms.uOpacity.value = fx.shadowA * (o.appearK ?? 1);
    const lb = o.helpers.label;
    if (lb && lb.visible) {
      const H = clamp(0.05 + 0.05 * o.size0.y * s, 0.06, 0.6);
      lb.scale.set(H * lb.userData.aspect / s, H / s, 1);
      lb.position.set(0, o.size0.y * o.anim.scale.y + by + 0.04 / s, 0);
    }
  }
  // The shadow map must exist before the first draw with sampler2DShadow: enable castShadow
  // and request a redraw in the same frame (the shadow pass renders before the scene).
  if (sun.castShadow !== realShadow) { sun.castShadow = realShadow; OBJ.shadowDirty = true; }
  if (realShadow && (animating || OBJ.shadowDirty)) { updateShadowCamera(); renderer.shadowMap.needsUpdate = true; }
  OBJ.shadowDirty = false;
}
function updateShadowCamera() {
  const box = new THREE.Box3();
  for (const o of OBJ.list) if (o.fx.shadow === 'real') box.expandByObject(o.root);
  if (box.isEmpty()) return;
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const L = OBJ.light, az = L.az * DEG, el = L.el * DEG;
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const r = Math.max(sph.radius * 1.25, 0.5);
  sun.target.position.copy(sph.center);
  sun.position.copy(sph.center).addScaledVector(dir, r * 3);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -r; cam.right = cam.top = r; cam.near = 0.01; cam.far = r * 6;
  cam.updateProjectionMatrix();
  sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
}

/* ═══════════ scene lighting ═══════════ */
export function applyLight() {
  const L = OBJ.light;
  scene.environmentIntensity = L.env;
  hemi.intensity = scene.environment ? 0.12 : 0.6;
  sun.intensity = L.sun;
  renderer.toneMappingExposure = L.exp;
  const az = L.az * DEG, el = L.el * DEG;
  if (!OBJ.list.some(o => o.fx.shadow === 'real')) {
    sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(10);
    sun.target.position.set(0, 0, 0);
  }
  scene.environmentRotation.set(0, world.rotation.y, 0);
  scene.fog = L.haze > 0 ? new THREE.FogExp2(OBJ.hazeColor, L.haze * 0.0011 / Math.max(0.3, S.near)) : null;
  OBJ.shadowDirty = true;
}
export function ensureEnv() {
  if (!S.small || OBJ.envFor === S.small) return;
  const small = S.small;
  OBJ.envFor = small;
  buildEnvironment(small);
  // haze colour: average colour of the horizon
  try {
    const g = S.small.getContext('2d'), d = g.getImageData(0, 236, 1024, 40).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    OBJ.hazeColor.setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch (e) { }
  applyLight();
}
/* Brightest spot in the upper hemisphere → sun azimuth and elevation */
export function autoSun() {
  if (!S.small) return null;
  const W = 128, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.filter = 'blur(1.5px)'; g.drawImage(S.small, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H / 2).data;
  let best = -1, bi = 0, sum = 0;
  for (let i = 0; i < W * H / 2; i++) {
    const l = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    sum += l; if (l > best) { best = l; bi = i; }
  }
  const mean = sum / (W * H / 2);
  const u = ((bi % W) + 0.5) / W, v = (Math.floor(bi / W) + 0.5) / H;
  const dir = uvToDir(u, v, new THREE.Vector3());
  const L = OBJ.light;
  L.az = Math.round(Math.atan2(dir.x, -dir.z) / DEG);
  L.el = Math.round(clamp(Math.asin(dir.y) / DEG, 3, 85));
  const contrast = best / Math.max(mean, 1);
  L.sun = +(clamp((contrast - 1.1) * 1.4, 0.3, 3.2)).toFixed(2);
  applyLight(); markDirty();
  return { az: L.az, el: L.el, contrast };
}

/* ═══════════ deletion, duplication ═══════════ */
export function removeObject(o) {
  const i = OBJ.list.indexOf(o); if (i < 0) return;
  if (OBJ.sel === o) select(null);
  OBJ.list.splice(i, 1);
  objectsRoot.remove(o.root);
  disposeObject(o);
  if (o.src.key && !OBJ.list.some(x => x.src.key === o.src.key)) idbDel('blobs', o.src.key);
  OBJ.shadowDirty = true; markDirty(); emit('objects-changed');
}
function disposeObject(o) {
  o.root.traverse(m => {
    if (m.geometry && !m.userData.shared) m.geometry.dispose();
    const w = WORK.get(m); if (w) w.forEach(x => x.dispose && x.dispose());
  });
}
export function clearObjects() {
  select(null);
  for (const o of OBJ.list.slice()) { objectsRoot.remove(o.root); disposeObject(o); }
  OBJ.list.length = 0;
  emit('objects-changed');
}
export function duplicateObject(o) {
  const helpers = [];
  o.model.traverse(m => { if (m.userData.fxHelper) helpers.push(m); });
  helpers.forEach(h => h.parent.remove(h));
  const clone = SkeletonUtils.clone(o.model);
  buildOutline(o); buildEdges(o); buildXrayBehind(o);
  // carry over the original materials in traversal order
  const a = [], b = [];
  o.model.traverse(m => { if ((m.isMesh || m.isPoints) && !m.userData.fxHelper) a.push(m); });
  clone.traverse(m => { if ((m.isMesh || m.isPoints) && !m.userData.fxHelper) b.push(m); });
  b.forEach((m, i) => { if (a[i]) ORIG.set(m, ORIG.get(a[i])); });
  const res = { object: clone, animations: o.clips, isPoints: o.isPoints, zUp: o.zUp, name: o.name, ext: o.ext };
  const src = o.src.kind === 'url' ? { url: o.src.url } : { files: o.src.files };
  const d = buildObject(res, src, { restore: { up: o.zUp ? 'z' : 'y', unitK: o.unitK, name: o.name + ' 2' } });
  d.src = Object.assign({}, o.src);
  d.fx = Object.assign({}, o.fx);
  d.root.position.copy(o.root.position);
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(o.root.quaternion).multiplyScalar(Math.max(o.size0.x * o.root.scale.x * 1.2, 0.3));
  d.root.position.add(side);
  if (S.depthCPU) d.root.position.y = groundAt(d.root.position.x, d.root.position.z);
  d.root.quaternion.copy(o.root.quaternion); d.root.scale.copy(o.root.scale);
  OBJ.list.push(d); objectsRoot.add(d.root);
  applyFx(d); playClip(d); startAppear(d);
  select(d); markDirty(); emit('objects-changed');
  return d;
}

/* ═══════════ serialisation ═══════════ */
const r4 = v => Math.round(v * 1e4) / 1e4, r6 = v => Math.round(v * 1e6) / 1e6;
function relUrl(u) {
  try {
    const a = new URL(u, document.baseURI), b = new URL('.', document.baseURI);
    if (a.origin === b.origin && a.pathname.startsWith(b.pathname)) return decodeURI(a.pathname.slice(b.pathname.length)) + a.search;
    return a.href;
  } catch (e) { return u; }
}
const safeName = s => String(s).replace(/[\\/:*?"<>|#%]+/g, '_').replace(/\s+/g, '_').slice(0, 60);
function localPaths(o) {
  const fl = o.src.files || [];
  const main = o.src.main || (fl[0] && fl[0].name) || 'model.glb';
  if (fl.length <= 1) return { src: 'models/' + safeName(main.split('/').pop()), files: fl.map(f => ({ path: 'models/' + safeName(f.name.split('/').pop()), blob: f.blob })) };
  const dir = 'models/' + safeName(o.name || main.replace(/\.[^.]+$/, '')) + '/';
  return { src: dir + main.replace(/\\/g, '/'), files: fl.map(f => ({ path: dir + f.name.replace(/\\/g, '/'), blob: f.blob })) };
}
export function serialize() {
  const fxDiff = fx => { const d = {}; for (const k in fx) if (fx[k] !== FX_DEFAULT[k]) d[k] = fx[k]; return d; };
  return {
    format: 'nomono3d-scene', version: 1,
    panorama: S.item ? relUrl(S.item.src) : (files.pano ? files.pano.name : null),
    saved: new Date().toISOString(),
    near: r6(OBJ.nearRef || S.near),
    light: Object.assign({}, OBJ.light),
    objects: OBJ.list.map(o => ({
      id: o.id, name: o.name,
      src: o.src.kind === 'url' ? relUrl(o.src.url) : localPaths(o).src,
      local: o.src.kind === 'local' ? true : undefined,
      up: o.zUp ? 'z' : 'y', unitK: r6(o.unitK),
      position: o.root.position.toArray().map(r4),
      quaternion: o.root.quaternion.toArray().map(r6),
      scale: r6(o.root.scale.x),
      fx: fxDiff(o.fx)
    }))
  };
}
function restoreInto(o, r) {
  const k = (OBJ.nearRef && r._near) ? OBJ.nearRef / r._near : 1;
  if (r.position) o.root.position.fromArray(r.position).multiplyScalar(k);
  if (r.quaternion) o.root.quaternion.fromArray(r.quaternion);
  o.root.scale.setScalar((r.scale || 1) * k);
  o.fx = Object.assign({}, FX_DEFAULT, o.isPoints ? { shadow: 'none' } : {}, r.fx || {});
  if (r.name) o.name = r.name;
}
/* json: scene object; resolve(src, entry) → source {url}|{files} */
export async function loadScene(json, resolve, opts = {}) {
  if (!json || !Array.isArray(json.objects)) throw new Error('Not a scene file');
  if (json.light) { Object.assign(OBJ.light, LIGHT_DEFAULT, json.light); }
  OBJ.nearRef = OBJ.nearRef || S.near;
  const errs = [];
  for (const r of json.objects) {
    try {
      const source = await resolve(r.src, r);
      if (!source) { errs.push(r.name || r.src); continue; }
      await addObject(source, { restore: Object.assign({}, r, { _near: json.near || OBJ.nearRef }), silent: true });
      const o = OBJ.list[OBJ.list.length - 1];
      if (source.key) o.src.key = source.key;
      if (source.files && r.local) o.src = { kind: 'local', files: source.files, main: source.main || (source.files[0] && source.files[0].name), key: source.key };
    } catch (e) { console.warn(e); errs.push((r.name || r.src) + ': ' + e.message); }
  }
  applyLight();
  emit('objects-changed');
  if (errs.length && !opts.quiet) hint(t('Не завантажено: ', 'Not loaded: ') + errs.join('; ').slice(0, 220), 6000);
  return errs;
}

/* ═══════════ in-browser drafts ═══════════ */
let saveTimer = 0;
/* Save the draft immediately if a deferred save is pending (before switching panoramas) */
export async function flushDraft() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = 0;
  await saveDraft();
}
export function panoKey() { return S.item ? 'item:' + S.item.src : (files.pano ? 'file:' + files.pano.id : null); }
export function markDirty() {
  if (S.kiosk) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = 0; saveDraft(); }, 700);
  emit('scene-dirty');
}
export async function saveDraft() {
  const key = panoKey(); if (!key) return;
  const sc = serialize();
  sc.objects.forEach((r, i) => { const o = OBJ.list[i]; if (o && o.src.kind === 'local') r.blobKey = o.src.key; });
  if (!OBJ.list.length) { await idbDel('drafts', key); OBJ.draftInfo = null; emit('draft-saved', null); return; }
  await idbPut('drafts', key, sc);
  OBJ.draftInfo = { saved: sc.saved };
  emit('draft-saved', OBJ.draftInfo);
}
async function resolveDraft(src, r) {
  if (r.local && r.blobKey) {
    const b = await idbGet('blobs', r.blobKey);
    if (b && b.files) return { files: b.files, key: r.blobKey };
    return null;
  }
  return { url: new URL(src, document.baseURI).href };
}
function resolveServer(baseUrl) {
  return async (src) => ({ url: new URL(src, document.baseURI).href });
}
/* After a panorama opens: draft → scene from the server → empty */
export async function loadSceneForPano(preferServer) {
  clearObjects();
  OBJ.nearRef = S.near;
  Object.assign(OBJ.light, LIGHT_DEFAULT);
  OBJ.draftInfo = null;
  const key = panoKey();
  const draft = key && !preferServer ? await idbGet('drafts', key) : null;
  if (draft && draft.objects && draft.objects.length) {
    OBJ.draftInfo = { saved: draft.saved };
    await loadScene(draft, resolveDraft);
    emit('draft-loaded', OBJ.draftInfo);
    return 'draft';
  }
  if (S.item && S.item.scene) {
    try {
      const r = await fetch(S.item.scene, { cache: 'no-cache' });
      if (r.ok) { await loadScene(await r.json(), resolveServer(S.item.scene)); return 'server'; }
    } catch (e) { console.warn('scene', e); }
  }
  applyLight();
  return 'none';
}
export async function discardDraft() {
  const key = panoKey(); if (key) await idbDel('drafts', key);
  return loadSceneForPano(true);
}

/* ═══════════ export / import ═══════════ */
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function scenePaths() {
  // scene path next to the panorama: panoramas/<album>/<name>.scene.json
  let base = 'panorama', dir = 'panoramas/';
  if (S.item) {
    const rel = relUrl(S.item.src);
    const i = rel.lastIndexOf('/');
    dir = i >= 0 ? rel.slice(0, i + 1) : 'panoramas/';
    base = rel.slice(i + 1).replace(/\.[^.]+$/, '');
  } else if (files.pano) base = files.pano.name.replace(/\.[^.]+$/, '');
  return { dir, base };
}
export function exportJson() {
  const { base } = scenePaths();
  download(new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' }), base + '.scene.json');
}
export async function exportZip() {
  const { dir, base } = scenePaths();
  const out = {};
  const sc = serialize();
  out[dir + base + '.scene.json'] = strToU8(JSON.stringify(sc, null, 1));
  for (const o of OBJ.list) {
    if (o.src.kind !== 'local') continue;
    for (const f of localPaths(o).files) out[f.path] = new Uint8Array(await f.blob.arrayBuffer());
  }
  // Local panorama (not from the library): include it too so the package is complete
  if (!S.item && files.pano) {
    out['panoramas/' + files.pano.name] = new Uint8Array(await files.pano.file.arrayBuffer());
    if (files.depth) out['panoramas/' + base + '_depth.' + (files.depth.name.split('.').pop() || 'png')] = new Uint8Array(await files.depth.file.arrayBuffer());
  }
  out['README.txt'] = strToU8(t(
    'Розпакуйте цей архів у корінь сайту (поруч з index.html): файли стануть у папки panoramas/ і models/.\nСцена відкриється разом із панорамою.\n',
    'Unzip this archive into the site root (next to index.html): files land in panoramas/ and models/.\nThe scene opens together with the panorama.\n'));
  const zip = zipSync(out, { level: 0 });
  download(new Blob([zip], { type: 'application/zip' }), base + '.scene.zip');
}
export async function importSceneFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'json') {
    const json = JSON.parse(await file.text());
    await loadScene(json, async (src, r) => ({ url: new URL(src, document.baseURI).href }));
    markDirty(); return;
  }
  if (ext === 'zip') {
    const fl = await unzipBlob(file);
    const scf = fl.find(f => /\.scene\.json$/i.test(f.name));
    if (!scf) {        // just a model in a ZIP
      await addObject({ files: fl });
      return;
    }
    const json = JSON.parse(await scf.blob.text());
    await loadScene(json, async (src, r) => {
      const s = src.replace(/^\.?\//, '').toLowerCase();
      const hit = fl.find(f => f.name.toLowerCase() === s || f.name.toLowerCase().endsWith('/' + s));
      if (!hit) return { url: new URL(src, document.baseURI).href };
      const dir = s.lastIndexOf('/') >= 0 ? s.slice(0, s.lastIndexOf('/') + 1) : '';
      const group = fl.filter(f => dir && f.name.toLowerCase().includes(dir)).map(f => ({ name: f.name.toLowerCase().split(dir).pop(), blob: f.blob }));
      const filesSet = group.length > 1 ? group : [{ name: hit.name.split('/').pop(), blob: hit.blob }];
      const key = 'm:' + (r.id || Math.random().toString(36).slice(2));
      await idbPut('blobs', key, { files: filesSet });
      return { files: filesSet, key, main: hit.name.split('/').pop() };
    });
    markDirty();
  }
}

/* ═══════════ initialisation ═══════════ */
export function initObjects() {
  on('pano-ready', async () => {
    OBJ.envFor = null;
    // A share link (sc=1) shows the scene stored with the item, not a draft left in this browser
    const fromLink = !!(S.shareScene && S.item && S.shareScene === S.item.src);
    if (fromLink) S.shareScene = null;
    await loadSceneForPano(fromLink);
    if (OBJ.list.length) ensureEnv();
  });
  on('scale-changed', () => {
    // The panorama scale changed: rescale the composition along with it
    if (!OBJ.nearRef) { OBJ.nearRef = S.near; return; }
    const k = S.near / OBJ.nearRef;
    if (Math.abs(k - 1) < 1e-6) return;
    for (const o of OBJ.list) { o.root.position.multiplyScalar(k); o.root.scale.multiplyScalar(k); }
    OBJ.nearRef = S.near; OBJ.shadowDirty = true; applyLight(); markDirty();
  });
  on('viewer-closed', () => { const pending = !!saveTimer; clearTimeout(saveTimer); saveTimer = 0; if (pending || OBJ.list.length) saveDraft(); });
  applyLight();
}
