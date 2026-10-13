// Loading of digitised models: GLB/GLTF, OBJ+MTL, FBX, PLY, STL, 3MF, USDZ, LAS, XYZ, PCD, ZIP packages.
import { THREE, renderer } from './gfx.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

const LIBDIR = new URL('../lib/three/examples/jsm/libs/', import.meta.url).href;
export const MAIN_EXT = ['glb', 'gltf', 'fbx', 'obj', 'usdz', 'usda', 'usdc', 'usd', '3mf', 'ply', 'stl', 'las', 'xyz', 'pcd', 'splat', 'spz', 'ksplat'];
const Z_UP = new Set(['stl', 'las', 'xyz', 'pcd', '3mf']);
export const extOf = n => (String(n).split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
const baseName = n => decodeURIComponent(String(n).split('?')[0].split('#')[0].split('/').pop() || '');

let draco = null, ktx2 = null;
function gltfLoader(manager) {
  const l = new GLTFLoader(manager);
  if (!draco) { draco = new DRACOLoader(); draco.setDecoderPath(LIBDIR + 'draco/gltf/'); }
  if (!ktx2) { ktx2 = new KTX2Loader(); ktx2.setTranscoderPath(LIBDIR + 'basis/'); try { ktx2.detectSupport(renderer); } catch (e) { } }
  l.setDRACOLoader(draco); l.setKTX2Loader(ktx2);
  return l;
}

/* Unpack a ZIP into a list of files */
export async function unzipBlob(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const ent = unzipSync(u8);
  const out = [];
  for (const [path, data] of Object.entries(ent)) {
    if (!data.length || path.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(path)) continue;
    out.push({ name: path, blob: new Blob([data]) });
  }
  return out;
}

/* Pick the main file among several */
export function pickMain(files) {
  for (const e of MAIN_EXT) {
    const f = files.find(x => extOf(x.name) === e);
    if (f) return f;
  }
  return null;
}

/* Loading manager that maps relative paths (textures, .bin, .mtl) to blob URLs from the file set */
function managerFor(files) {
  const m = new THREE.LoadingManager();
  if (!files) return { manager: m, urls: [] };
  const map = new Map(), urls = [];
  for (const f of files) {
    const u = URL.createObjectURL(f.blob); urls.push(u);
    const full = f.name.replace(/\\/g, '/').toLowerCase();
    map.set(full, u);
    map.set(baseName(full), u);
  }
  m.setURLModifier(url => {
    if (url.startsWith('data:')) return url;
    const clean = decodeURIComponent(url.split('?')[0]).replace(/\\/g, '/').toLowerCase();
    if (map.has(clean)) return map.get(clean);
    // blob:...uuid/relative/path → match by longest common suffix, then by file name
    const tail = clean.replace(/^blob:[^/]*\/\/[^/]*\//, '').replace(/^blob:/, '');
    for (const [k, v] of map) if (tail.endsWith(k)) return v;
    const b = baseName(clean);
    return map.get(b) || url;
  });
  return { manager: m, urls, map };
}

/* Main entry point: source = {url} or {files:[{name,blob}]} */
export async function loadModel(source, onStatus) {
  let files = source.files || null, url = source.url || null, name;
  if (files && files.length === 1 && extOf(files[0].name) === 'zip') files = await unzipBlob(files[0].blob);
  if (url && extOf(url) === 'zip') { const b = await (await fetch(url)).blob(); files = await unzipBlob(b); url = null; }
  let mainUrl, ext, mgr;
  if (files) {
    const main = pickMain(files);
    if (!main) throw new Error('No 3D model found among the files (GLB, GLTF, OBJ, FBX, PLY, STL, 3MF, USDZ, LAS, XYZ, PCD).');
    mgr = managerFor(files);
    mainUrl = mgr.map.get(main.name.replace(/\\/g, '/').toLowerCase());
    ext = extOf(main.name); name = baseName(main.name);
  } else {
    mgr = managerFor(null); mainUrl = url; ext = extOf(url); name = baseName(url);
  }
  onStatus && onStatus('parsing ' + name);
  let object = null, animations = [], isPoints = false, zUp = Z_UP.has(ext);
  try {
    switch (ext) {
      case 'glb': case 'gltf': {
        const g = await gltfLoader(mgr.manager).loadAsync(mainUrl);
        object = g.scene || g.scenes[0]; animations = g.animations || [];
        break;
      }
      case 'fbx': {
        const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
        object = await new FBXLoader(mgr.manager).loadAsync(mainUrl);
        animations = object.animations || [];
        break;
      }
      case 'obj': {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        const txt = await (await fetch(mgr.manager.resolveURL(mainUrl))).text();
        const loader = new OBJLoader(mgr.manager);
        const m = txt.match(/^\s*mtllib\s+(.+?)\s*$/m);
        if (m) {
          try {
            const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
            const ml = new MTLLoader(mgr.manager);
            const base = files ? '' : mainUrl.slice(0, mainUrl.lastIndexOf('/') + 1);
            ml.setResourcePath(base);
            const mats = await ml.loadAsync(base + m[1]);
            mats.preload(); loader.setMaterials(mats);
          } catch (e) { console.warn('MTL', e); }
        }
        object = loader.parse(txt);
        break;
      }
      case 'ply': {
        const buf = await (await fetch(mgr.manager.resolveURL(mainUrl))).arrayBuffer();
        const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)));
        if (/property\s+\w+\s+f_dc_0/.test(head)) throw new Error('This PLY is a Gaussian splat. Splats are not supported yet: export a mesh or point cloud (GLB, OBJ, PLY) from your scanning app.');
        const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
        const geo = new PLYLoader(mgr.manager).parse(buf);
        object = meshOrPoints(geo); isPoints = object.isPoints;
        if (isPoints) zUp = true;               // scanner point clouds are usually Z-up
        break;
      }
      case 'stl': {
        const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
        const geo = await new STLLoader(mgr.manager).loadAsync(mainUrl);
        object = meshOrPoints(geo, true);
        break;
      }
      case '3mf': {
        const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
        object = await new ThreeMFLoader(mgr.manager).loadAsync(mainUrl);
        break;
      }
      case 'usdz': case 'usda': case 'usdc': case 'usd': {
        const { USDLoader } = await import('three/addons/loaders/USDLoader.js');
        object = await new USDLoader(mgr.manager).loadAsync(mainUrl);
        break;
      }
      case 'xyz': {
        const { XYZLoader } = await import('three/addons/loaders/XYZLoader.js');
        const geo = await new XYZLoader(mgr.manager).loadAsync(mainUrl);
        object = meshOrPoints(geo); isPoints = true;
        break;
      }
      case 'pcd': {
        const { PCDLoader } = await import('three/addons/loaders/PCDLoader.js');
        object = await new PCDLoader(mgr.manager).loadAsync(mainUrl);
        if (object.isPoints) object.material = pointsMaterial(object.geometry);
        isPoints = true;
        break;
      }
      case 'las': {
        const buf = await (await fetch(mgr.manager.resolveURL(mainUrl))).arrayBuffer();
        object = parseLAS(buf); isPoints = true;
        break;
      }
      case 'splat': case 'spz': case 'ksplat':
        throw new Error('Gaussian splats (.' + ext + ') are not supported yet: export a mesh or point cloud from your scanning app.');
      default:
        throw new Error('Unsupported format: .' + ext);
    }
  } finally {
    setTimeout(() => mgr.urls.forEach(u => URL.revokeObjectURL(u)), 30000);
  }
  if (!object) throw new Error('The file contains no geometry.');
  prepareObject(object);
  return { object, animations, isPoints, zUp, name, ext };
}

function pointsMaterial(geo) {
  return new THREE.PointsMaterial({ size: 0.012, sizeAttenuation: true, vertexColors: !!geo.getAttribute('color'), color: geo.getAttribute('color') ? 0xffffff : 0xb9c4cc });
}
function meshOrPoints(geo, solid) {
  if (!geo.index && !solid) return new THREE.Points(geo, pointsMaterial(geo));   // PLY/XYZ without faces: point cloud
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const col = !!geo.getAttribute('color');
  const m = new THREE.MeshStandardMaterial({ color: col ? 0xffffff : 0xbcbcbc, vertexColors: col, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, m);
}

/* Phong/Lambert → Standard so that the panorama lights the objects (IBL); add normals where missing */
function prepareObject(root) {
  root.traverse(o => {
    if (o.isMesh || o.isSkinnedMesh) {
      if (o.geometry && !o.geometry.getAttribute('normal') && o.geometry.getAttribute('position')) o.geometry.computeVertexNormals();
      const conv = m => {
        if (!m) return m;
        if (m.isMeshPhongMaterial || m.isMeshLambertMaterial) {
          const s = new THREE.MeshStandardMaterial({
            name: m.name, color: m.color, map: m.map, normalMap: m.normalMap, emissive: m.emissive, emissiveMap: m.emissiveMap,
            emissiveIntensity: m.emissiveIntensity, alphaMap: m.alphaMap, aoMap: m.aoMap, transparent: m.transparent,
            opacity: m.opacity, side: m.side, vertexColors: m.vertexColors, alphaTest: m.alphaTest,
            roughness: m.isMeshPhongMaterial ? Math.max(0.25, 1 - (m.shininess || 30) / 120) : 0.9, metalness: 0
          });
          if (m.normalScale) s.normalScale.copy(m.normalScale);
          m.dispose();
          return s;
        }
        return m;
      };
      o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    }
  });
}

/* ═══════════ LAS 1.0–1.4 (no LAZ) ═══════════ */
function parseLAS(buf) {
  const dv = new DataView(buf);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Not a LAS file. LAZ (compressed) is not supported: convert to LAS first.');
  const vMin = dv.getUint8(25);
  const off = dv.getUint32(96, true);
  const fmt = dv.getUint8(104) & 0x3f;
  if (dv.getUint8(104) & 0x80) throw new Error('LAZ-compressed points are not supported: convert to LAS first.');
  const recLen = dv.getUint16(105, true);
  let n = dv.getUint32(107, true);
  if (vMin >= 4 && n === 0) n = Number(dv.getBigUint64(247, true));
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const maxN = 2_500_000, stride = Math.max(1, Math.ceil(n / maxN)), m = Math.floor(n / stride);
  const rgbOff = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
  const pos = new Float32Array(m * 3), col = new Float32Array(m * 3);
  let cx = 0, cy = 0, minZ = Infinity;
  // centre on the first point to avoid losing float32 precision with large coordinates
  const x0 = dv.getInt32(off, true) * sx + ox, y0 = dv.getInt32(off + 4, true) * sy + oy;
  let maxC = 0;
  for (let i = 0, k = 0; i < m; i++, k += 3) {
    const p = off + i * stride * recLen;
    if (p + recLen > buf.byteLength) break;
    const x = dv.getInt32(p, true) * sx + ox - x0, y = dv.getInt32(p + 4, true) * sy + oy - y0, z = dv.getInt32(p + 8, true) * sz + oz;
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    if (z < minZ) minZ = z;
    if (rgbOff) {
      const r = dv.getUint16(p + rgbOff, true), g = dv.getUint16(p + rgbOff + 2, true), b = dv.getUint16(p + rgbOff + 4, true);
      col[k] = r; col[k + 1] = g; col[k + 2] = b; maxC = Math.max(maxC, r, g, b);
    } else {
      const it = dv.getUint16(p + 12, true); col[k] = col[k + 1] = col[k + 2] = it; maxC = Math.max(maxC, it);
    }
  }
  const sc = maxC > 255 ? 1 / 65535 : 1 / 255;
  let zMax = -Infinity; for (let k = 2; k < pos.length; k += 3) { pos[k] -= minZ; zMax = Math.max(zMax, pos[k]); }
  for (let k = 0; k < col.length; k += 3) {
    if (rgbOff || maxC > 0) { col[k] *= sc; col[k + 1] *= sc; col[k + 2] *= sc; }
    if (!rgbOff && maxC === 0) { const h = pos[k + 2] / (zMax || 1); col[k] = 0.3 + 0.5 * h; col[k + 1] = 0.55 + 0.3 * (1 - h); col[k + 2] = 0.3; }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const c = new THREE.BufferAttribute(col, 3); geo.setAttribute('color', c);
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.015, vertexColors: true, sizeAttenuation: true }));
  pts.userData.las = { n, used: m, fmt };
  return pts;
}
