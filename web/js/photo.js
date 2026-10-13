// Flat-photo parallax ("3D photo").
//
// A photo and its depth map are rebuilt as a depth-displaced mesh seen through a window:
// the frame of the photo sits on the focus plane, the camera moves behind it (drag, device
// tilt, head tracking or an automatic orbit) and an off-axis projection keeps the window
// fixed on screen. Objects nearer than the focus plane drift against the motion, objects
// behind it drift with it, exactly as through a real window.
//
// Two layers, as in the panorama renderer (Layered Depth Image idea):
//   • front layer: the photo on its sharpened depth. Cells that straddle a depth jump are
//     dropped (no "rubber sheet" between a trunk and the sky), and texels lying behind the
//     cell's surface are discarded, so silhouettes follow the depth map texel by texel;
//   • back layer: the background continued behind foreground objects, visible only in the gaps
//     that open when the viewpoint moves. Its colour is the nearby background reflected across
//     the nearest edge (in 2D, so textures keep their direction), blended in by pull-push.
// Before meshing, speckles are removed (3×3 median) and small depth islands (gaps between leaves,
// single leaves) join their surroundings, so foliage does not shatter into hundreds of holes.
// A frame mask keeps the photo's border straight while near content at the edge moves.
import { THREE, scene, camera, renderer, uploadChecked, GLSL_COMMON, GLSL_DEPTHVIEW, panoUniforms } from './gfx.js';
import { S, DEG, clamp, on } from './state.js';
import { filter2D, pullPush } from './layers.js';
import { useAIBackground, inpaintImage } from './ai.js';

export const PH = {
  group: null, fg: null, bg: null,
  photoTex: null, depthTex: null, bgTex: null,
  ready: false, hasDepth: false,
  w: 0, h: 0, aspect: 1, DW: 0, DH: 0, dn: null,
  hfov: 60 * DEG, tanX: 0.577, tanY: 0.433,
  range: 3.6,          // far / near distance ratio of the scene
  focus: 0.45,         // zero-parallax plane, 0 = far … 1 = near (in inverse depth)
  fill: false, orbit: 0, orbitAmp: 0,
  stats: null
};

const DN_TAU = 0.045;
const AI_BG = new Map();   // AI background results of recent photos (key: photo, depth, size)  // depth jump (in normalised inverse depth) that separates objects

/* ═══════════ shaders ═══════════ */
const VS = `
attribute float aDn;
uniform float uZF, uTanX, uTanY, uPush;
varying vec2 vUv;
varying float vDn, vZ;
varying vec3 vP;
float toZ(float dn){ return 1.0/(dn*(1.0 - 1.0/uZF) + 1.0/uZF); }
void main(){
  vec2 uv = position.xy;
  float z = toZ(aDn)*uPush;
  vec3 p = vec3((uv.x*2.0 - 1.0)*uTanX*z, (1.0 - uv.y*2.0)*uTanY*z, -z);
  vUv = uv; vDn = aDn; vZ = z; vP = p;
  gl_Position = projectionMatrix*modelViewMatrix*vec4(p, 1.0);
}`;
const FS = `
uniform sampler2D uPhoto, uDepthT, uBgCol;
uniform float uTau;
uniform vec2 uDSize;
varying vec2 vUv;
varying float vDn, vZ;
varying vec3 vP;
` + GLSL_COMMON + GLSL_DEPTHVIEW + `
// Colour without bleeding across a depth edge: near a jump, a plain bilinear/mip lookup mixes
// the object's colour into the background next to it, which leaves a faint outline behind once
// the viewpoint moves. Here only the depth texels on this fragment's side of the edge contribute.
vec3 sampleSide(vec2 uv, float myDn, vec3 cDef){
  vec2 p = uv*uDSize - 0.5, i0 = floor(p), f = p - i0;
  vec3 acc = vec3(0.0); float ws = 0.0, lo = 1.0, hi = 0.0;
  for(int b=0;b<2;b++){
    for(int a=0;a<2;a++){
      vec2 t = clamp((i0 + vec2(float(a), float(b)) + 0.5)/uDSize, vec2(0.0), vec2(1.0));
      float d = dec16(texture2D(uDepthT, t).rg);
      lo = min(lo, d); hi = max(hi, d);
      float w = (a == 1 ? f.x : 1.0 - f.x)*(b == 1 ? f.y : 1.0 - f.y)*step(abs(d - myDn), uTau*0.5);
      if(w > 0.0){ acc += w*textureLod(uPhoto, t, 0.0).rgb; ws += w; }
    }
  }
  return (hi - lo > uTau && ws > 0.001) ? acc/ws : cDef;
}
void main(){
  vec2 uv = clamp(vUv, vec2(0.0), vec2(1.0));
  vec3 c = texture2D(uPhoto, uv).rgb;          // before discard: the whole quad computes mip derivatives
  float dnT = dec16(texture2D(uDepthT, uv).rg);
#ifdef FRONT
  if(dnT < vDn - uTau) discard;               // texel lies behind this surface: the back layer draws it
  c = sampleSide(uv, dnT, c);
#else
  vec4 b = texture2D(uBgCol, uv);
  if(b.a < 0.01) c = sampleSide(uv, dnT, c);
  c = mix(c, b.rgb, b.a);
  dnT = vDn;
#endif
  if(uShowDepth > 0.5) c = depthView(c, dnT, vZ, vP);
  gl_FragColor = vec4(c, 1.0);
}`;

const U = {
  uPhoto: { value: null }, uDepthT: { value: null }, uBgCol: { value: null },
  uZF: { value: 3.6 }, uTanX: { value: 0.577 }, uTanY: { value: 0.433 },
  uTau: { value: DN_TAU }, uDSize: { value: new THREE.Vector2(1024, 768) },
  // depth views: shared with the panorama, except that photo distances are not metres
  uShowDepth: panoUniforms.uShowDepth, uDepthMix: panoUniforms.uDepthMix, uDepthD: panoUniforms.uDepthD,
  uDepthW: panoUniforms.uDepthW, uMetric: { value: 0 }
};

export function initPhoto() {
  PH.group = new THREE.Group(); PH.group.name = 'photo'; PH.group.visible = false;
  const mat = (front, push) => new THREE.ShaderMaterial({
    uniforms: Object.assign({}, U, { uPush: { value: push } }),
    vertexShader: VS, fragmentShader: FS, defines: front ? { FRONT: 1 } : {}, side: THREE.DoubleSide
  });
  PH.fg = new THREE.Mesh(new THREE.BufferGeometry(), mat(true, 1.0));
  PH.bg = new THREE.Mesh(new THREE.BufferGeometry(), mat(false, 1.004));
  for (const m of [PH.fg, PH.bg]) { m.frustumCulled = false; PH.group.add(m); }
  PH.fg.renderOrder = 0; PH.bg.renderOrder = 1;   // back layer fills only what the front left empty
  // Frame mask: near content at the photo's border shifts with the viewpoint and leaves a ragged
  // edge. Everything outside the window, inset by the largest shift, is painted black, so the
  // border stays a straight line. Screen space, 2D only (hidden in VR, where the photo is a window).
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  PH.mask = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: { uRect: { value: new THREE.Vector4(-2, -2, 2, 2) }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'varying vec2 vN; void main(){ vN = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform vec4 uRect; uniform vec2 uRes; varying vec2 vN;
void main(){
  vec2 px = 2.0/uRes;                                   // one pixel in NDC: a soft, antialiased border
  float ix = smoothstep(uRect.x - px.x, uRect.x + px.x, vN.x)*(1.0 - smoothstep(uRect.z - px.x, uRect.z + px.x, vN.x));
  float iy = smoothstep(uRect.y - px.y, uRect.y + px.y, vN.y)*(1.0 - smoothstep(uRect.w - px.y, uRect.w + px.y, vN.y));
  float a = 1.0 - ix*iy;
  if(a < 0.002) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`,
    transparent: true, depthTest: false, depthWrite: false
  }));
  PH.mask.frustumCulled = false; PH.mask.renderOrder = 50; PH.mask.name = 'photoFrameMask';
  PH.group.add(PH.mask);
  on('xr-start', () => { PH.mask.visible = false; });
  scene.add(PH.group);
}

export function showPhoto(on) { if (PH.group) PH.group.visible = !!on; }
export function setPhotoDepthView(mode) { U.uShowDepth.value = +mode || 0; }

export function freePhoto() {
  for (const k of ['photoTex', 'depthTex', 'bgTex']) if (PH[k]) { PH[k].dispose(); PH[k] = null; }
  for (const m of [PH.fg, PH.bg]) if (m) { m.geometry.dispose(); m.geometry = new THREE.BufferGeometry(); }
  U.uPhoto.value = U.uDepthT.value = U.uBgCol.value = null;
  PH.ready = false; PH.hasDepth = false; PH.dn = null;
}

/* ═══════════ helpers ═══════════ */
function enc16(v, out, o) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  const a = Math.floor(v * 255);
  out[o] = a; out[o + 1] = Math.min(255, Math.round((v * 255 - a) * 255));
}
function dataTex(data, W, H, nearest) {
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false; t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = t.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
function pixels(src, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, W, H);
  return g.getImageData(0, 0, W, H).data;
}
/* 8-bit depth maps come in terraces: smooth only between neighbours within ±2.5 levels,
   so that real object edges stay sharp. */
function deTerrace(dn, W, H) {
  const out = new Float32Array(dn.length), lim = 2.5 / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = dn[y * W + x]; let acc = 0, ws = 0;
    for (let j = -2; j <= 2; j++) {
      const yy = y + j < 0 ? 0 : y + j >= H ? H - 1 : y + j;
      for (let i = -2; i <= 2; i++) {
        const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i;
        const s = dn[yy * W + xx];
        if (Math.abs(s - c) > lim) continue;
        const w = Math.exp(-(i * i + j * j) / 4.5);
        acc += s * w; ws += w;
      }
    }
    out[y * W + x] = acc / ws;
  }
  return out;
}

/* Ramp → step with colour guidance (CPU counterpart of FS_SNAP in depth.js). */
function snapEdges(dn, mx, mn, img, W, H, r, tau, mx2, mn2) {
  const out = new Float32Array(dn.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, rg = mx[p] - mn[p];
    if (rg <= tau) { out[p] = dn[p]; continue; }
    // A step is fully inside the small window, so a window twice as wide adds little range;
    // on a slope the range keeps growing with the window. Slopes are not edges: leave them.
    if (mx2 && mx2[p] - mn2[p] > 1.6 * rg) { out[p] = dn[p]; continue; }
    const mid = 0.5 * (mx[p] + mn[p]), hiT = mx[p] - 0.25 * rg, loT = mn[p] + 0.25 * rg;
    let nr = 0, ng = 0, nb = 0, nn = 0, fr = 0, fg = 0, fb = 0, fn = 0, nm = 0;
    for (let j = -r; j <= r; j++) {
      const yy = y + j; if (yy < 0 || yy >= H) continue;
      for (let i = -r; i <= r; i++) {
        const xx = x + i; if (xx < 0 || xx >= W) continue;
        const q = yy * W + xx, d = dn[q], o = 4 * q;
        if (d >= hiT) { nr += img[o]; ng += img[o + 1]; nb += img[o + 2]; nn++; }
        else if (d <= loT) { fr += img[o]; fg += img[o + 1]; fb += img[o + 2]; fn++; }
        else nm++;
      }
    }
    // A blurred edge has its values bunched at the two ends of the window; a steep but continuous
    // surface (the top of a box seen at a grazing angle, a slope) spreads them evenly. Slopes stay.
    if (nm > 0.4 * (nn + fn + nm)) { out[p] = dn[p]; continue; }
    let near = dn[p] > mid;
    if (nn && fn) {
      nr /= nn; ng /= nn; nb /= nn; fr /= fn; fg /= fn; fb /= fn;
      const vr = nr - fr, vg = ng - fg, vb = nb - fb, L2 = vr * vr + vg * vg + vb * vb;
      if (L2 > 600) {                                  // the two sides differ in colour
        const o = 4 * p, cr = img[o] - fr, cg = img[o + 1] - fg, cb = img[o + 2] - fb;
        const al = (cr * vr + cg * vg + cb * vb) / L2;  // share of the near side's colour
        const er = cr - al * vr, eg = cg - al * vg, eb = cb - al * vb;
        if (er * er + eg * eg + eb * eb < 0.36 * L2) near = al > 0.2;    // mixed edge texels stay with the object
      }
    }
    out[p] = near ? mx[p] : mn[p];
  }
  return out;
}

/* 3×3 median: removes isolated speckles of neural depth maps (dark dots inside foliage), each of
   which would otherwise cut a hole into the mesh. */
function median3(a, W, H) {
  const out = new Float32Array(a.length), v = new Float32Array(9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let k = 0;
    for (let j = -1; j <= 1; j++) {
      const yy = y + j < 0 ? 0 : y + j >= H ? H - 1 : y + j;
      for (let i = -1; i <= 1; i++) { const xx = x + i < 0 ? 0 : x + i >= W ? W - 1 : x + i; v[k++] = a[yy * W + xx]; }
    }
    // partial selection sort up to the middle element
    for (let i = 0; i <= 4; i++) { let m = i; for (let q = i + 1; q < 9; q++) if (v[q] < v[m]) m = q; const t = v[i]; v[i] = v[m]; v[m] = t; }
    out[y * W + x] = v[4];
  }
  return out;
}

/* Mask for AI inpainting. The model rebuilds what it cannot see from what it can, so the object
   in front must be hidden from it, otherwise it grows the object back into its own outline (a
   second cabinet edge, a ghost knob). The hole band is therefore grown into the object itself:
   from every hole texel, through texels of continuous depth (the same surface), up to m texels.
   A neighbouring object at another depth (the foliage beside a post) is not crossed, so the model
   keeps it as context instead of painting over it. */
function inpaintMask(dnS, W, H, tau, hole) {
  const N = W * H, m = Math.max(2, Math.round(W * (+(new URLSearchParams(location.search).get('lmmargin') || 0.04))));
  const dist = new Int16Array(N).fill(-1), q = new Int32Array(N);
  let head = 0, tail = 0;
  for (let p = 0; p < N; p++) if (hole[p]) { dist[p] = 0; q[tail++] = p; }
  while (head < tail) {
    const p = q[head++], d = dist[p]; if (d >= m) continue;
    const x = p % W, v = dnS[p];
    const visit = n => { if (dist[n] < 0 && Math.abs(dnS[n] - v) <= tau) { dist[n] = d + 1; q[tail++] = n; } };
    if (x > 0) visit(p - 1); if (x < W - 1) visit(p + 1);
    if (p >= W) visit(p - W); if (p < N - W) visit(p + W);
  }
  const mk = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (dist[p] >= 0) mk[p] = 1;
  return filter2D(mk, W, H, 3, true, 3, false);
}

/* Small depth islands: regions enclosed by a depth jump and smaller than minArea texels, such as
   the gaps between leaves or single leaves against the sky. Each one would cut the mesh and open
   a hole that has to be invented. They take the depth of their surroundings instead (pull-push),
   so foliage moves as one surface. Returns the number of texels changed. */
function removeIslands(dn, W, H, tau, minArea) {
  const N = W * H, label = new Int32Array(N).fill(-1), stack = new Int32Array(N);
  const small = new Float32Array(N).fill(1);
  let changed = 0, id = 0;
  const comp = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (label[s0] >= 0) continue;
    let top = 0; stack[top++] = s0; label[s0] = id; comp.length = 0;
    while (top) {
      const p = stack[--top]; comp.push(p);
      const x = p % W, d = dn[p];
      if (x > 0 && label[p - 1] < 0 && Math.abs(dn[p - 1] - d) <= tau) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < W - 1 && label[p + 1] < 0 && Math.abs(dn[p + 1] - d) <= tau) { label[p + 1] = id; stack[top++] = p + 1; }
      if (p >= W && label[p - W] < 0 && Math.abs(dn[p - W] - d) <= tau) { label[p - W] = id; stack[top++] = p - W; }
      if (p < N - W && label[p + W] < 0 && Math.abs(dn[p + W] - d) <= tau) { label[p + W] = id; stack[top++] = p + W; }
    }
    if (comp.length < minArea) { for (const p of comp) small[p] = 0; changed += comp.length; }
    id++;
  }
  if (changed && changed < N) pullPush(W, H, [dn], small, false);
  return changed;
}

/* Background behind foreground edges, reflected across the nearest edge in 2D. Every hole texel
   finds the nearest texel on the far side of a depth jump (jump flooding) and takes the colour
   found by mirroring itself about that point, so grass, leaves and sky continue across the edge
   in their own direction instead of being smeared along rows. The depth there is the background
   depth at the edge. Texels with no reachable background are left for pull-push (w stays 0). */
function reflectFill(W, H, hole, dn, tau, chans, Z, w, fix) {
  const N = W * H, seed = new Int32Array(N).fill(-1);
  const isSeed = new Uint8Array(N);
  const holes = [];
  for (let p = 0; p < N; p++) {
    if (hole[p]) { holes.push(p); continue; }
    // far side of a jump next to a hole
    const x = p % W, d = dn[p] + tau;
    if ((x > 0 && hole[p - 1] && dn[p - 1] > d) || (x < W - 1 && hole[p + 1] && dn[p + 1] > d) ||
        (p >= W && hole[p - W] && dn[p - W] > d) || (p < N - W && hole[p + W] && dn[p + W] > d)) { isSeed[p] = 1; seed[p] = p; }
  }
  if (!holes.length) return;
  // jump flooding over the hole texels
  let maxD = 1; while (maxD < Math.max(W, H) / 4) maxD *= 2;
  const nxt = new Int32Array(N);
  for (let k = maxD; k >= 1; k >>= 1) {
    for (const p of holes) {
      const x = p % W, y = (p / W) | 0;
      let best = seed[p], bd = Infinity;
      if (best >= 0) { const dx = best % W - x, dy = ((best / W) | 0) - y; bd = dx * dx + dy * dy; }
      for (let j = -1; j <= 1; j++) {
        const yy = y + j * k; if (yy < 0 || yy >= H) continue;
        for (let i = -1; i <= 1; i++) {
          if (!i && !j) continue;
          const xx = x + i * k; if (xx < 0 || xx >= W) continue;
          const s = seed[yy * W + xx]; if (s < 0) continue;
          const dx = s % W - x, dy = ((s / W) | 0) - y, dd = dx * dx + dy * dy;
          if (dd < bd) { bd = dd; best = s; }
        }
      }
      nxt[p] = best;
    }
    for (const p of holes) seed[p] = nxt[p];
  }
  // reflect
  for (const p of holes) {
    const b = seed[p]; if (b < 0) continue;
    const px = p % W, py = (p / W) | 0, bx = b % W, by = (b / W) | 0;
    let vx = bx - px, vy = by - py; const L = Math.hypot(vx, vy) || 1;
    const ux = vx / L, uy = vy / L, db = dn[b];
    // mirror about a point just beyond the edge texel (it can still carry the object's tint);
    // if the mirrored texel is not background any more, come closer to the edge
    let src = -1;
    for (const f of [1, 0.5, 0.25]) {
      const qx = Math.round(bx + ux * (1 + L * f)), qy = Math.round(by + uy * (1 + L * f));
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
      const q = qy * W + qx;
      if (!hole[q] && dn[q] <= dn[p] - tau) { src = q; break; }      // any texel behind this one
    }
    Z[p] = db;
    if (src < 0) continue;              // no clean background to mirror: pull-push blends it in
    for (const c of chans) c[p] = c[src];
    w[p] = 1;
  }
  // The background texel at the edge often holds a tint of the object (anti-aliasing, JPEG
  // chroma); once uncovered it would show as a thin outline. It takes its outer neighbour's colour.
  if (fix) for (let p = 0; p < N; p++) {
    if (!isSeed[p]) continue;
    const x = p % W;
    let ox = 0, oy = 0;
    if (x > 0 && hole[p - 1]) ox++; if (x < W - 1 && hole[p + 1]) ox--;
    if (p >= W && hole[p - W]) oy++; if (p < N - W && hole[p + W]) oy--;
    const qx = x + Math.sign(ox), qy = ((p / W) | 0) + Math.sign(oy);
    if ((ox || oy) && qx >= 0 && qy >= 0 && qx < W && qy < H) {
      const q = qy * W + qx;
      if (!hole[q] && Math.abs(dn[q] - dn[p]) <= tau) { for (let c = 0; c < 3; c++) chans[c][p] = chans[c][q]; fix[p] = 1; }
    }
  }
}

/* ═══════════ loading ═══════════
   rec, depthRec: records from viewer.probeImage ({img, file, w, h}). status(t) shows progress. */
export async function loadPhoto(rec, depthRec, opts = {}, status) {
  freePhoto();
  const cap = Math.min(S.maxTex || 4096, 8192);
  const k = Math.min(1, cap / Math.max(rec.w, rec.h));
  const tw = Math.max(2, Math.round(rec.w * k)), th = Math.max(2, Math.round(rec.h * k));
  status && status('decoding');
  let bmp = null;
  try { bmp = await createImageBitmap(rec.file, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' }); }
  catch (e) { const c = document.createElement('canvas'); c.width = tw; c.height = th; c.getContext('2d').drawImage(rec.img, 0, 0, tw, th); bmp = c; }
  const tex = new THREE.Texture(bmp);
  tex.flipY = false; tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  if (!uploadChecked(tex)) { tex.dispose(); if (bmp.close) bmp.close(); throw new Error('Out of GPU memory while uploading the photo.'); }
  PH.photoTex = tex; U.uPhoto.value = tex;
  PH.w = tw; PH.h = th; PH.aspect = tw / th;
  S.panoW = tw; S.panoH = th;

  // Field of view: a typical phone/standard lens. Wider images (panoramic crops) get a wider view.
  const hf = clamp(opts.hfov || (PH.aspect > 1.9 ? 85 : PH.aspect >= 1 ? 62 : 48), 20, 120) * DEG;
  PH.hfov = hf; PH.tanX = Math.tan(hf / 2); PH.tanY = PH.tanX / PH.aspect;
  U.uTanX.value = PH.tanX; U.uTanY.value = PH.tanY;

  // Working resolution of the depth processing (CPU) and of the mesh
  const longCap = S.lowPower ? 1024 : 1536;
  const DW = Math.round(PH.aspect >= 1 ? Math.min(longCap, tw) : Math.min(longCap, th) * PH.aspect);
  const DH = Math.max(2, Math.round(DW / PH.aspect));
  PH.DW = DW; PH.DH = DH;
  const N = DW * DH;
  const img = pixels(bmp, DW, DH);
  if (bmp.close) bmp.close();
  tex.image = { width: tw, height: th };

  let dn = new Float32Array(N);
  PH.hasDepth = !!depthRec;
  if (depthRec) {
    status && status('importing depth');
    const d = pixels(depthRec.img, DW, DH);
    const inv = !!S.depthInvert;
    for (let p = 0; p < N; p++) { const v = d[4 * p] / 255; dn[p] = inv ? 1 - v : v; }
    // stretch to the full range: maps are often not normalised
    const sorted = Float32Array.from(dn).sort();
    const lo = sorted[Math.floor(N * 0.005)], hi = sorted[Math.min(N - 1, Math.floor(N * 0.995))];
    const span = Math.max(hi - lo, 1e-3);
    for (let p = 0; p < N; p++) dn[p] = clamp((dn[p] - lo) / span, 0, 1);
    await new Promise(r => setTimeout(r, 0));
    dn = deTerrace(median3(dn, DW, DH), DW, DH);
  } else dn.fill(PH.focus);

  status && status('sharpening edges');
  await new Promise(r => setTimeout(r, 0));
  const t0 = performance.now();
  const tau = +(new URLSearchParams(location.search).get('tau') || DN_TAU);
  U.uTau.value = tau;
  // Ramp → step: neural depth maps blur object edges over several texels, and a mesh would
  // stretch the photo along that ramp. Inside a small window every ramp texel is given either
  // the near or the far side of the jump. The decision follows the photo's colour where the
  // two sides differ in colour (the true edge), otherwise the middle of the depth ramp.
  const r = Math.max(2, Math.round(DW / 400));
  const mx = filter2D(dn, DW, DH, r, true, r, false), mn = filter2D(dn, DW, DH, r, false, r, false);
  const mx2 = filter2D(dn, DW, DH, 2 * r, true, 2 * r, false), mn2 = filter2D(dn, DW, DH, 2 * r, false, 2 * r, false);
  const dnS = snapEdges(dn, mx, mn, img, DW, DH, r, tau, mx2, mn2);
  // Small islands enclosed by depth jumps (gaps between leaves, single leaves) join their surroundings
  const islandArea = Math.round(N * (+(new URLSearchParams(location.search).get('island') || 0.0015)));
  const islands = PH.hasDepth && islandArea > 0 ? removeIslands(dnS, DW, DH, tau, islandArea) : 0;
  PH.dn = dnS;
  // depth range along each border (the frame mask insets each side by its own largest shift)
  const edgeRange = (x0, x1, y0, y1) => { let lo = 1, hi = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = dnS[y * DW + x]; if (v < lo) lo = v; if (v > hi) hi = v; } return [lo, hi]; };
  PH.edge = { l: edgeRange(0, 3, 0, DH), r: edgeRange(DW - 3, DW, 0, DH), t: edgeRange(0, DW, 0, 3), b: edgeRange(0, DW, DH - 3, DH) };

  // Mesh grid: cells of c texels
  const c = Math.max(2, Math.round(DW / (S.lowPower ? 320 : 512)));
  const GW = Math.max(2, Math.floor(DW / c)), GH = Math.max(2, Math.floor(DH / c));
  const rc = c;          // a cell's corners lie within c texels (Chebyshev) of every texel in it
  // Front layer vertices: near side of a jump spreads over the neighbouring cell, so every
  // cell that holds a foreground texel sits fully on the foreground depth.
  // Only the near side of a real jump (a step between neighbouring texels) spreads; a steep but
  // continuous surface keeps its own depth, so it is not torn into strips.
  const min1 = filter2D(dnS, DW, DH, 1, false, 1, false);
  const jumpNear = new Float32Array(N), jumpAny = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (dnS[p] - min1[p] > tau) { jumpNear[p] = dnS[p]; jumpAny[p] = 1; }
  const fgMax = filter2D(jumpNear, DW, DH, rc, true, rc, false);
  // Back layer: background continued behind foreground objects. Only real discontinuities
  // count (the far side of a 1-texel jump), so a smooth slope such as the ground is not a hole.
  const near1 = filter2D(dnS, DW, DH, 1, true, 1, false);
  const E = new Float32Array(N);
  for (let p = 0; p < N; p++) E[p] = near1[p] - dnS[p] > tau ? dnS[p] : 2;
  // How far behind an edge the background can be uncovered: the parallax between two depths is
  // proportional to their difference in inverse depth. K = texels uncovered per unit of depth
  // difference at the largest travel (Move at maximum, the deepest Depth setting, a margin).
  // A small step therefore needs a narrow band of background, the full range a wide one.
  const K = DW * 0.11 * 0.95 / (2 * PH.tanX) * 1.2;
  const R = Math.max(4, Math.min(Math.round(DW * 0.1), Math.ceil(K)));
  const radii = [Math.max(2, R >> 3), Math.max(3, R >> 2), Math.max(4, R >> 1), R];
  const fars = radii.map(rr => filter2D(E, DW, DH, rr, false, rr, false));
  const hole = new Uint8Array(N);
  const w0 = new Float32Array(N);
  let holes = 0;
  for (let p = 0; p < N; p++) {
    let h = 0;
    for (let i = 0; i < radii.length && !h; i++) {
      const f = fars[i][p], need = Math.max(tau, (i ? radii[i - 1] : 0) / K);
      if (f < 1.5 && dnS[p] - f > need) h = 1;
    }
    if (h) { hole[p] = 1; holes++; } else w0[p] = 1;
  }
  status && status('background layer');
  await new Promise(r => setTimeout(r, 0));
  const Rr = new Float32Array(N), Gg = new Float32Array(N), Bb = new Float32Array(N), Z = new Float32Array(N);
  for (let p = 0; p < N; p++) { Rr[p] = img[4 * p]; Gg[p] = img[4 * p + 1]; Bb[p] = img[4 * p + 2]; Z[p] = dnS[p]; }
  const fix = new Uint8Array(N);
  PH.bgEngine = 'built-in'; PH.bgError = null;
  if (holes) {
    // Sharp texture first: background reflected across the nearest edge; whatever is left
    // (no clean background within reach) is filled smoothly by pull-push.
    reflectFill(DW, DH, hole, dnS, tau, [Rr, Gg, Bb], Z, w0, fix);
    // Pull-push must not borrow the foreground's own colour: texels next to the band that lie on
    // the foreground's depth (its inner side) do not count as background.
    for (let pass = 0; pass < 2; pass++) {
      const drop = [];
      for (let p = 0; p < N; p++) {
        if (hole[p] || !w0[p]) continue;
        const x = p % DW, lim = dnS[p] + tau;
        for (const q of [p - 1, p + 1, p - DW, p + DW]) {
          if (q < 0 || q >= N || (q === p - 1 && x === 0) || (q === p + 1 && x === DW - 1)) continue;
          if ((hole[q] || !w0[q]) && dnS[q] <= lim && dnS[q] >= dnS[p] - tau && !fix[p]) { drop.push(p); break; }
        }
      }
      for (const p of drop) w0[p] = 0;
    }
    pullPush(DW, DH, [Rr, Gg, Bb, Z], w0, false);
    // AI background (MI-GAN on the server): replaces the colour of the hole texels; the built-in
    // fill above stays as the fallback if the server cannot answer.
    if (PH.hasDepth && useAIBackground()) {
      try {
        const key = (rec.id || rec.name) + '|' + (depthRec && (depthRec.id || depthRec.name)) + '|' + DW + 'x' + DH + '|' + holes;
        let px = AI_BG.get(key);
        if (!px) {
          status && status('AI background (MI-GAN)');
          const mk = inpaintMask(dnS, DW, DH, tau, hole);
          const cI = document.createElement('canvas'); cI.width = DW; cI.height = DH;
          const cM = document.createElement('canvas'); cM.width = DW; cM.height = DH;
          const gI = cI.getContext('2d'), gM = cM.getContext('2d');
          gI.putImageData(new ImageData(new Uint8ClampedArray(img.buffer.slice(0)), DW, DH), 0, 0);
          const md = gM.createImageData(DW, DH);
          for (let p = 0; p < N; p++) { const v = mk[p] ? 255 : 0; md.data[4 * p] = md.data[4 * p + 1] = md.data[4 * p + 2] = v; md.data[4 * p + 3] = 255; }
          gM.putImageData(md, 0, 0);
          const blob = c => new Promise(ok => c.toBlob(ok, c === cI ? 'image/jpeg' : 'image/png', 0.95));
          const out = await inpaintImage(await blob(cI), await blob(cM), status);
          const bmpOut = await createImageBitmap(out);
          px = pixels(bmpOut, DW, DH);
          if (bmpOut.close) bmpOut.close();
          AI_BG.set(key, px);
          if (AI_BG.size > 4) AI_BG.delete(AI_BG.keys().next().value);
        }
        for (let p = 0; p < N; p++) if (hole[p]) { Rr[p] = px[4 * p]; Gg[p] = px[4 * p + 1]; Bb[p] = px[4 * p + 2]; }
        PH.bgEngine = 'MI-GAN';
      } catch (e) {
        console.warn('AI background failed, built-in fill kept', e);
        PH.bgError = String(e.message || e);
      }
    }
  }
  const dnB = new Float32Array(N);
  const depthData = new Uint8Array(N * 4), bgData = new Uint8Array(N * 4);
  for (let p = 0; p < N; p++) {
    const o = 4 * p;
    dnB[p] = hole[p] ? Math.min(Z[p], dnS[p]) : dnS[p];
    enc16(dnS[p], depthData, o); depthData[o + 3] = 255;
    if (hole[p] || fix[p]) { bgData[o] = Rr[p]; bgData[o + 1] = Gg[p]; bgData[o + 2] = Bb[p]; bgData[o + 3] = 255; }
    else { bgData[o] = img[o]; bgData[o + 1] = img[o + 1]; bgData[o + 2] = img[o + 2]; bgData[o + 3] = 0; }
  }
  const bgMin = filter2D(dnB, DW, DH, rc, false, rc, false);

  // vertices
  const nv = (GW + 1) * (GH + 1);
  const pos = new Float32Array(nv * 3), aF = new Float32Array(nv), aB = new Float32Array(nv);
  for (let j = 0, v = 0; j <= GH; j++) {
    const y = Math.min(DH - 1, Math.round(j * DH / GH));
    for (let i = 0; i <= GW; i++, v++) {
      const x = Math.min(DW - 1, Math.round(i * DW / GW)), p = y * DW + x;
      pos[3 * v] = i / GW; pos[3 * v + 1] = j / GH;
      aF[v] = fgMax[p] - dnS[p] > tau ? fgMax[p] : dnS[p];
      aB[v] = bgMin[p];
    }
  }
  // cells: stretched (front corners differ by more than tau) are left to the back layer
  const NC = GW * GH, stretched = new Uint8Array(NC), holeCell = new Uint8Array(NC);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const a = j * (GW + 1) + i, b = a + 1, cc = a + GW + 1, d = cc + 1;
    const lo = Math.min(aF[a], aF[b], aF[cc], aF[d]), hi = Math.max(aF[a], aF[b], aF[cc], aF[d]);
    if (hi - lo > tau) stretched[j * GW + i] = 1;
  }
  // a cell only tears where it holds an actual jump; otherwise the surface stretches as it should
  const cellJump = new Uint8Array(NC);
  for (let y = 0; y < DH; y++) {
    const cj = Math.min(GH - 1, Math.floor(y * GH / DH));
    for (let x = 0; x < DW; x++) if (jumpAny[y * DW + x]) cellJump[cj * GW + Math.min(GW - 1, Math.floor(x * GW / DW))] = 1;
  }
  const cellJumpD = filter2D(cellJump, GW, GH, 1, true, 1, false);
  for (let q = 0; q < NC; q++) if (!cellJumpD[q]) stretched[q] = 0;
  for (let y = 0; y < DH; y++) {
    const cj = Math.min(GH - 1, Math.floor(y * GH / DH));
    for (let x = 0; x < DW; x++) {
      const p = y * DW + x;
      // the back layer is needed where background may open up (hole) and wherever the front layer
      // discards a texel: a far texel inside a cell raised to the near side of an edge would
      // otherwise show the black clear colour (a thin dark staircase along object edges)
      if (hole[p] || fgMax[p] - dnS[p] > tau) holeCell[cj * GW + Math.min(GW - 1, Math.floor(x * GW / DW))] = 1;
    }
  }
  const need = new Uint8Array(NC);
  for (let q = 0; q < NC; q++) need[q] = stretched[q] || holeCell[q] ? 1 : 0;
  const needD = filter2D(need, GW, GH, 1, true, 1, false);
  let nF = 0, nB = 0;
  for (let q = 0; q < NC; q++) { if (!stretched[q]) nF++; if (needD[q]) nB++; }
  const idxF = new Uint32Array(nF * 6), idxB = new Uint32Array(nB * 6);
  let kf = 0, kb = 0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const q = j * GW + i, a = j * (GW + 1) + i, b = a + 1, cc = a + GW + 1, d = cc + 1;
    if (!stretched[q]) { idxF[kf++] = a; idxF[kf++] = cc; idxF[kf++] = b; idxF[kf++] = b; idxF[kf++] = cc; idxF[kf++] = d; }
    if (needD[q]) { idxB[kb++] = a; idxB[kb++] = cc; idxB[kb++] = b; idxB[kb++] = b; idxB[kb++] = cc; idxB[kb++] = d; }
  }
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const geo = (dnArr, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', posAttr);
    g.setAttribute('aDn', new THREE.BufferAttribute(dnArr, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  };
  PH.fg.geometry.dispose(); PH.bg.geometry.dispose();
  PH.fg.geometry = geo(aF, idxF);
  PH.bg.geometry = geo(aB, idxB);
  PH.bg.visible = nB > 0;

  PH.depthTex = dataTex(depthData, DW, DH, true);
  PH.bgTex = dataTex(bgData, DW, DH, false);
  U.uDepthT.value = PH.depthTex; U.uBgCol.value = PH.bgTex;
  U.uDSize.value.set(DW, DH);
  setRange(PH.range);
  PH.stats = { ms: Math.round(performance.now() - t0), grid: GW + 'x' + GH, depth: DW + 'x' + DH, holes, islands, bg: PH.bgEngine, frontCells: nF, backCells: nB };
  PH.ready = true;
  return PH;
}

export function setRange(r) { PH.range = clamp(r, 1.05, 40); U.uZF.value = PH.range; }
export function setFocus(f) { PH.focus = clamp(f, 0, 1); }

/* ═══════════ camera ═══════════
   tx, ty — viewpoint offset in [-1.5, 1.5] (drag, tilt, head); dolly — towards the window. */
export function photoCamera(W, H, tx, ty, dolly, zoom, eye = 0) {
  if (!eye) PH.cam = { tx, ty, dolly, zoom };                     // last view (exports re-render it at other sizes)
  const zF = PH.range;
  const zf = 1 / (1 / zF + PH.focus * (1 - 1 / zF));             // focus plane distance (near = 1)
  const A = PH.hasDepth ? S.move * 0.11 : 0;                       // travel, in units of the nearest distance
  const px = tx * A + eye, py = ty * A, pz = -clamp(dolly * 2.4, -1, 1) * A * 1.4;
  const a = PH.aspect, sA = W / H;
  const Wx = zf * PH.tanX, Wy = zf * PH.tanY;
  let hx, hy;
  if ((sA > a) !== PH.fill) { hy = Wy; hx = Wy * sA; } else { hx = Wx; hy = Wx / sA; }
  // Fill: crop a little more than the largest shift of the image border, so no black edge shows
  if (PH.fill) {
    const g = A * Math.max(zf - 1, 1 - zf / zF) * 1.15;
    const k = Math.max(0.5, 1 - g / Math.min(hx, hy));
    hx *= k; hy *= k;
  }
  hx /= zoom; hy /= zoom;
  // frame mask: the window in NDC, inset by the largest border shift (or the current one, if larger)
  if (PH.mask) {
    const zOfDn = d => 1 / (d * (1 - 1 / zF) + 1 / zF);
    const mOf = e => e ? Math.max(Math.abs(zf / zOfDn(e[1]) - 1), Math.abs(zf / zOfDn(e[0]) - 1)) : Math.max(zf - 1, 1 - zf / zF);
    const E = PH.edge || {}, ax = Math.max(A * 1.15, Math.abs(px)), ay = Math.max(A * 1.15, Math.abs(py));
    const gl = ax * mOf(E.l), gr = ax * mOf(E.r), gt = ay * mOf(E.t), gb = ay * mOf(E.b);
    PH.mask.material.uniforms.uRect.value.set(-(Wx - gl) / hx, -(Wy - gb) / hy, (Wx - gr) / hx, (Wy - gt) / hy);
    PH.mask.material.uniforms.uRes.value.set(W, H);
    PH.mask.visible = PH.hasDepth && !renderer.xr.isPresenting;
  }
  const D = Math.max(zf + pz, 0.05), n = 0.02, f = zF * 4 + 2, s = n / D;
  camera.position.set(px, py, pz);
  camera.quaternion.set(0, 0, 0, 1);
  camera.near = n; camera.far = f;
  camera.projectionMatrix.makePerspective((-hx - px) * s, (hx - px) * s, (hy - py) * s, (-hy - py) * s, n, f);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld();
  return { travel: A, focusDist: zf };
}

/* ═══════════ surface queries (3D objects) ═══════════
   World space = camera space at rest: the camera sits at the origin looking along −Z. */
function dnAtUV(u, v) {
  const W = PH.DW, H = PH.DH, D = PH.dn;
  const x = Math.min(W - 1, Math.max(0, u * W - 0.5)), y = Math.min(H - 1, Math.max(0, v * H - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const a = D[y0 * W + x0], b = D[y0 * W + x1], c = D[y1 * W + x0], d = D[y1 * W + x1];
  // across a depth jump, take the nearer side: objects should not sink into a gap
  if (Math.max(a, b, c, d) - Math.min(a, b, c, d) > DN_TAU) return Math.max(a, b, c, d);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
const zOf = dn => 1 / (dn * (1 - 1 / PH.range) + 1 / PH.range);
/* Distance along the unit direction d to the photo surface (far beyond the frame: the far plane) */
export function photoDistDir(d) {
  if (!PH.dn) return 4;
  if (d.z > -1e-4) return PH.range * 4;
  const tx = d.x / -d.z, ty = d.y / -d.z;
  const u = 0.5 + tx / (2 * PH.tanX), v = 0.5 - ty / (2 * PH.tanY);
  const z = (u < 0 || u > 1 || v < 0 || v > 1) ? PH.range * 1.5 : zOf(dnAtUV(u, v));
  return z / -d.z;
}
/* Surface normal from depth differences, facing the camera */
export function photoNormal(p) {
  const r = p.length() || 1, d = p.clone().divideScalar(r), e = 0.0025;
  const P = (dx, dy) => { const q = d.clone(); q.x += dx; q.y += dy; q.normalize(); return q.multiplyScalar(photoDistDir(q)); };
  const n = new THREE.Vector3().subVectors(P(e, 0), P(-e, 0)).cross(new THREE.Vector3().subVectors(P(0, e), P(0, -e))).normalize();
  if (n.dot(p) > 0) n.negate();
  if (!isFinite(n.x)) n.set(0, 1, 0);
  return n;
}

/* Depth map of the current photo as a canvas (white = near) */
export function photoDepthCanvas() {
  if (!PH.dn) return null;
  const c = document.createElement('canvas'); c.width = PH.DW; c.height = PH.DH;
  const g = c.getContext('2d'), im = g.createImageData(PH.DW, PH.DH);
  for (let i = 0; i < PH.DW * PH.DH; i++) {
    const v = Math.round(clamp(PH.dn[i], 0, 1) * 255);
    im.data[4 * i] = im.data[4 * i + 1] = im.data[4 * i + 2] = v; im.data[4 * i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
