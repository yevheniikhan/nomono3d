// three.js renderer, scene, depth-displaced panorama mesh, base sphere and helper passes.
import * as THREE from 'three';
import { S, $, D_FAR } from './state.js';

export let renderer, scene, camera, world, objectsRoot, pmrem;
export let panoMesh, panoPre, sphereL, sphereR, hemi, sun;   // sphereR: second eye of stereo 3DoF in VR
export let panoEdge, panoBG, panoBGE, preEdge, preBG, preBGE, panoBack;
// Panorama mesh: 1024×512 cells on desktop, 512×256 on phones (see initGfx).
// Silhouettes are finer than the mesh: a per-texel test in the front layer cuts them (see FS_PANO).
export const GRID = { w: 1024, h: 512 };

/* ═══════════ GLSL ═══════════ */
export const GLSL_COMMON = `
#define PI_ 3.141592653589793
vec2 enc16(float v){ v=clamp(v,0.0,1.0); float a=floor(v*255.0)/255.0; return vec2(a,(v-a)*255.0); }
float dec16(vec2 e){ return e.x + e.y/255.0; }
vec2 dirToUv(vec3 d){ return vec2(0.5+atan(d.x,-d.z)/(2.0*PI_), acos(clamp(d.y,-1.0,1.0))/PI_); }
vec3 uvToDir(vec2 uv){ float lon=(uv.x-0.5)*2.0*PI_, lat=(0.5-uv.y)*PI_, cl=cos(lat);
  return vec3(sin(lon)*cl, sin(lat), -cos(lon)*cl); }
`;
// Per-eye sampling from the panorama: 0 mono, 1 top-bottom (TB), 2 side-by-side (SBS)
export const GLSL_EYE = `
uniform float uLayout;
vec2 eyeUv(vec2 uv, float eye){
  if(uLayout < 0.5) return uv;
  if(uLayout < 1.5) return vec2(uv.x, uv.y*0.5 + eye*0.5);
  return vec2(uv.x*0.5 + eye*0.5, uv.y);
}
vec2 eyeScale(){ return uLayout < 0.5 ? vec2(1.0) : (uLayout < 1.5 ? vec2(1.0,0.5) : vec2(0.5,1.0)); }
// Seam at u=0/1: take derivatives from the continuous branch, otherwise the seam
// picks the smallest mip level and shows a thin line.
vec3 samplePano(sampler2D tex, vec2 uvRaw, float eye){
  float u = fract(uvRaw.x), v = clamp(uvRaw.y, 0.0015, 0.9985);
  float uB = fract(uvRaw.x + 0.5);
  vec2 dx = vec2(dFdx(uvRaw.x), dFdx(uvRaw.y)), dy = vec2(dFdy(uvRaw.x), dFdy(uvRaw.y));
  float bx = dFdx(uB), by = dFdy(uB);
  if(abs(bx) < abs(dx.x)) dx.x = bx;
  if(abs(by) < abs(dy.x)) dy.x = by;
  vec2 k = eyeScale();
  return textureGrad(tex, eyeUv(vec2(u, v), eye), dx*k, dy*k).rgb;
}
vec3 depthColor(float g){
  vec3 c = mix(vec3(0.05,0.06,0.14), vec3(1.0,0.93,0.72), g);
  return mix(c, vec3(0.78,0.27,0.25), smoothstep(0.55,1.0,g)*0.55);
}
`;

/* Depth views shared by the panorama and photo shaders.
   uShowDepth: 0 image, 1 grey depth, 2 colour map (turbo), 3 distance contours, 4 depth slice,
   5 surface normals, 6 aerial fog. uDepthMix blends with the image; uDepthD / uDepthW are the slice
   (or fog) distance and slice width; uMetric = 1 when distances are metres (panoramas). */
export const GLSL_DEPTHVIEW = `
uniform float uShowDepth, uDepthMix, uDepthD, uDepthW, uMetric;
vec3 turbo(float x){
  x = clamp(x, 0.0, 1.0);
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x*x, x*x*x); vec2 v2 = v4.zw*v4.z;
  return clamp(vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), 0.0, 1.0);
}
// c: image colour, dn: normalised inverse depth (1 = near), dist: distance, P: surface position
vec3 depthView(vec3 c, float dn, float dist, vec3 P){
  float m = uShowDepth;
  if(m < 0.5) return c;
  if(m < 1.5) return mix(c, vec3(pow(clamp(dn, 0.0, 1.0), 0.8)), uDepthMix);
  if(m < 2.5) return mix(c, turbo(dn), uDepthMix);
  if(m < 3.5){                                  // contours: metres for panoramas, 20 levels for photos
    float v = uMetric > 0.5 ? dist : dn*20.0;
    float s = uMetric > 0.5 ? (dist < 12.0 ? 1.0 : (dist < 60.0 ? 5.0 : 25.0)) : 1.0;
    float f = abs(fract(v/s + 0.5) - 0.5)*s;
    float w = max(fwidth(v), 0.0001)*1.25;
    vec3 lc = uMetric > 0.5 ? turbo(dn) : vec3(1.0, 0.86, 0.35);
    return mix(c*mix(1.0, 0.75, uDepthMix), lc, (1.0 - smoothstep(w*0.5, w*1.6, f))*0.9);
  }
  if(m < 4.5){                                  // slice: a band at a chosen distance, the rest dimmed
    float b = 1.0 - smoothstep(uDepthW*0.5, uDepthW, abs(dist - uDepthD));
    vec3 dim = mix(c, c*0.25 + 0.03, uDepthMix);
    return mix(dim, mix(c, vec3(0.30, 0.95, 0.75), 0.55), b);
  }
  if(m < 5.5){                                  // normals of the reconstructed surface
    vec3 n = normalize(cross(dFdx(P), dFdy(P)));
    return mix(c, n*0.5 + 0.5, uDepthMix);
  }
  float f = 1.0 - exp(-dist/max(uDepthD, 0.001));  // aerial fog
  return mix(c, vec3(0.84, 0.88, 0.93), f*uDepthMix);
}
`;

/* Panorama with depth, rendered as two layers (as in a Layered Depth Image):
   • front: depth dilated by one mesh cell around discontinuities (uDepth.ba); fragments whose
     texel lies more than uTau behind the layer surface are discarded (EDGE), so a trunk silhouette
     is accurate to a depth-map texel, not a mesh cell, with no "rubber sheet" to the background;
   • back: the background extended behind foreground objects (uBgDepth), visible in the gaps
     that open when the viewpoint moves. Gap colour is the background mirrored from the gap
     edge (uBgMir) or a smooth inpainted fill (uBgColor);
   • a backdrop sphere at infinity, shown where both layers have torn.
   uDepth (up to 4096): rg = sharpened texel depth, ba = front-layer vertex depth.
   uBgDepth, uBgColor (mesh res): background depth and colour. uBgFar (up to 2048): rg = depth
   of the far side of the nearest discontinuity (a texel nearer than this by uTau is foreground).
   uBgMir (up to 2048): mirror axis, background extent, valid flag. See layers.js for details. */
const VS_PANO = `
uniform sampler2D uDepth, uBgDepth;
uniform float uNearM, uFarM, uEyeA, uPush;
varying vec2 vUv;
varying float vDist, vDn;
` + GLSL_COMMON + `
float toDist(float dn){ return 1.0/max(dn*(1.0/uNearM - 1.0/uFarM) + 1.0/uFarM, 0.000001); }
void main(){
  vec2 uv = position.xy;
  vec2 tc = vec2(fract(uv.x), clamp(uv.y, 0.0005, 0.9995));
#ifdef BG
  float dn = dec16(texture2D(uBgDepth, tc).rg);
#else
  float dn = dec16(texture2D(uDepth, tc).ba);
#endif
  float d = max(toDist(dn), uEyeA*1.7);       // nothing closer than the viewpoint travel itself
#ifdef BG
  d *= uPush;                                 // push background slightly back to avoid z-fighting with the front layer
#endif
  vUv = uv; vDist = d; vDn = dn;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uvToDir(uv)*d, 1.0);
}`;

const FS_PANO = `
uniform sampler2D uPano, uDepth, uBgDepth, uBgColor, uBgFar, uBgMir;
uniform float uEyeL, uSliceOn, uSliceDist, uSliceW, uFade, uOpacity, uTau, uNearM, uFarM;
uniform vec2 uFineSize, uGrid, uPanoSize;
varying vec2 vUv;
varying float vDist, vDn;
` + GLSL_COMMON + GLSL_EYE + GLSL_DEPTHVIEW + `
// Same sampling, but with externally supplied derivatives (for shifted mirror coordinates)
vec3 samplePanoG(sampler2D tex, vec2 uvRaw, float eye, vec2 dx, vec2 dy){
  float u = fract(uvRaw.x), v = clamp(uvRaw.y, 0.0015, 0.9985);
  vec2 k = eyeScale();
  return textureGrad(tex, eyeUv(vec2(u, v), eye), dx*k, dy*k).rgb;
}
// Colour without bleeding across the layer boundary: bilinear sampling only from photo texels
// whose depth lies in [lo, hi), i.e. on this side of the edge. Plain sampling next to a trunk
// mixes its dark texel into the adjacent background, and once the viewpoint moves a dotted
// "ghost" outline remains on the ground. When a photo texel is smaller than a screen pixel
// (lod > 0.75) the halo is invisible, so plain sampling is kept.
vec3 sampleSide(vec2 uv, float lo, float hi, vec3 cDef, float lod){
  if(lod > 0.75) return cDef;
  vec2 es = uPanoSize*eyeScale();
  vec2 p = vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0))*es - 0.5;
  vec2 i0 = floor(p), f = p - i0;
  vec3 acc = vec3(0.0); float ws = 0.0;
  for(int b=0;b<2;b++){
    for(int a=0;a<2;a++){
      vec2 t = (i0 + vec2(float(a), float(b)) + 0.5)/es;
      t = vec2(fract(t.x), clamp(t.y, 0.0005, 0.9995));
      float d = dec16(texture2D(uDepth, t).rg);
      float w = (a == 1 ? f.x : 1.0 - f.x)*(b == 1 ? f.y : 1.0 - f.y)*step(lo, d)*(1.0 - step(hi, d));
      if(w > 0.0){ acc += w*textureLod(uPano, eyeUv(t, uEyeL), 0.0).rgb; ws += w; }
    }
  }
  return ws > 0.001 ? acc/ws : cDef;
}
void main(){
  vec2 tc = vec2(fract(vUv.x), clamp(vUv.y, 0.0005, 0.9995));
#ifndef PRE
  vec3 c = samplePano(uPano, vUv, uEyeL);     // before discard: mip derivatives need the whole quad
#endif
#if (defined(EDGE) || defined(BG)) && !defined(PRE)
  vec2 es = uPanoSize*eyeScale();
  float lodC = log2(max(max(length(dFdx(vUv)*es), length(dFdy(vUv)*es)), 0.000001));
#endif
#if defined(EDGE) || defined(BG)
  float dnT = dec16(texture2D(uDepth, tc).rg);
#endif
#if defined(EDGE) || defined(BG)
  float dnFar = dec16(texture2D(uBgFar, tc).rg);  // far side of the nearest discontinuity in this row
#endif
#ifdef BG
  // A "hole" is a foreground texel with unknown background behind it. Only if the front layer
  // draws this texel itself (same threshold as in EDGE): otherwise its colour is genuine,
  // and at rest the panorama matches the photo exactly.
  // Front-layer surface here as the mesh interpolates it (bilinear from the cell's vertices)
  vec2 gq = vec2(vUv.x, clamp(vUv.y, 0.0, 1.0))*uGrid, g0 = floor(gq), gf = gq - g0;
  vec2 c0 = g0/uGrid, c1 = (g0 + 1.0)/uGrid;
  float s00 = dec16(texture2D(uDepth, vec2(fract(c0.x), clamp(c0.y, 0.0005, 0.9995))).ba);
  float s10 = dec16(texture2D(uDepth, vec2(fract(c1.x), clamp(c0.y, 0.0005, 0.9995))).ba);
  float s01 = dec16(texture2D(uDepth, vec2(fract(c0.x), clamp(c1.y, 0.0005, 0.9995))).ba);
  float s11 = dec16(texture2D(uDepth, vec2(fract(c1.x), clamp(c1.y, 0.0005, 0.9995))).ba);
  float fgSurf = mix(mix(s00, s10, gf.x), mix(s01, s11, gf.x), gf.y);
  float stB = fgSurf - dnFar, cutB = stB > 2.0*uTau ? dnFar + 0.5*stB : fgSurf - uTau;
  float hole = step(uTau, dnT - dnFar) * step(cutB + 0.1*uTau, dnT);
#endif
#ifdef EDGE
  // A texel nearer the far side than the layer surface is background: the back layer draws it.
  // Cut at mid-step, so a trunk's edge texels (boundary half-tones) stay with the trunk.
  float stF = vDn - dnFar;
  float cutF = stF > 2.0*uTau ? dnFar + 0.5*stF : vDn - uTau;
  if(dnT < cutF) discard;
#endif
#ifdef BGEDGE
  // The background also tears at its own discontinuities (canopy edge against sky): a texel lying
  // far behind the background-layer surface is left to the backdrop sphere at infinity.
  float lowB = vDn - uTau;
  if(mix(dnT, dec16(texture2D(uBgDepth, tc).rg), hole) < lowB) discard;
#else
  float lowB = -1.0;
#endif
#ifdef PRE
  gl_FragColor = vec4(0.0);
#else
#ifdef EDGE
  if(stF > 2.0*uTau) c = sampleSide(vUv, cutF, 2.0, c, lodC);
#endif
#ifdef BG
  // background next to a hole: background texels only, no foreground bleed
  if(hole < 0.5 && stB > 2.0*uTau) c = sampleSide(vUv, lowB, max(cutB + 0.1*uTau, dnFar + uTau), c, lodC);
#endif
#ifdef BG
  // Behind a foreground object (hole): background mirrored from the hole edge (sharp texture
  // at full resolution); without a mirror, the smooth inpainted colour.
  float bx = dFdx(fract(vUv.x + 0.5)), by = dFdy(fract(vUv.x + 0.5));
  vec2 gx = vec2(dFdx(vUv.x), dFdx(vUv.y)), gy = vec2(dFdy(vUv.x), dFdy(vUv.y));
  if(abs(bx) < abs(gx.x)) gx.x = bx;
  if(abs(by) < abs(gy.x)) gy.x = by;
  vec4 mr = texture2D(uBgMir, tc);                      // mirror axis, background extent, valid flag
  vec3 cm = texture2D(uBgColor, tc).rgb;
  if(mr.a > 0.5){
    // Mirror within the background actually available beside the hole (lim texels). Past that,
    // clamping repeated one column per row (horizontal streaks, "barcode" between dense trunks):
    // instead the mirror fades into the smooth inpainted colour.
    float a = dec16(mr.rg)*uFineSize.x, x = fract(vUv.x)*uFineSize.x, lim = mr.b*255.0;
    float dx = x - a; dx -= uFineSize.x*floor(dx/uFineSize.x + 0.5);
    float sx = a - sign(dx)*min(abs(dx), lim);
    vec3 cr = samplePanoG(uPano, vec2(sx/uFineSize.x, vUv.y), uEyeL, gx, gy);
    float keep = (1.0 - smoothstep(lim*0.6, lim + 1.0, abs(dx)))*smoothstep(2.0, 5.0, lim);
    cm = mix(cm, cr, keep);
  }
  c = mix(c, cm, hole);
#endif
  if(uShowDepth > 0.5){
#ifdef BG
    float dnV = vDn;
#else
    float dnV = dec16(texture2D(uDepth, tc).rg);
#endif
    c = depthView(c, dnV, vDist, uvToDir(vUv)*vDist);
  }
  if(uSliceOn > 0.5){                         // slice at the selected object's depth
    float b = 1.0 - smoothstep(uSliceW*0.5, uSliceW, abs(vDist - uSliceDist));
    c = mix(c, vec3(0.25, 0.85, 1.0), b*0.6);
  }
  c = mix(c, vec3(0.035), uFade);
  gl_FragColor = vec4(c, uOpacity);
#endif
}`;

const VS_SPHERE = `
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS_SPHERE = `
uniform sampler2D uPano, uDepth;
uniform float uEye, uEyeMix, uHasDepth, uFade, uOpacity, uNearM, uFarM;
varying vec3 vDir;
` + GLSL_COMMON + GLSL_EYE + GLSL_DEPTHVIEW + `
void main(){
  vec3 d = normalize(vDir);
  vec2 uv = dirToUv(d);
  vec3 c = samplePano(uPano, uv, uEye);
  if(uEyeMix > 0.004) c = mix(c, samplePano(uPano, uv, 1.0-uEye), uEyeMix);
  if(uShowDepth > 0.5 && uHasDepth > 0.5){
    float dnS = dec16(texture2D(uDepth, vec2(fract(uv.x), clamp(uv.y,0.002,0.998))).rg);
    c = depthView(c, dnS, 1.0/max(dnS*(1.0/uNearM - 1.0/uFarM) + 1.0/uFarM, 0.000001), d);
  }
  c = mix(c, vec3(0.035), uFade);
  gl_FragColor = vec4(c, uOpacity);
}`;

/* ═══════════ initialisation ═══════════ */
export const panoUniforms = {
  uPano: { value: null }, uDepth: { value: null }, uBgDepth: { value: null }, uBgColor: { value: null }, uBgFar: { value: null }, uBgMir: { value: null },
  uFineSize: { value: new THREE.Vector2(2048, 1024) }, uGrid: { value: new THREE.Vector2(1024, 512) },
  uPanoSize: { value: new THREE.Vector2(4096, 2048) },
  uLayout: { value: 0 }, uEyeL: { value: 0 },
  uNearM: { value: 2.1 }, uFarM: { value: D_FAR }, uEyeA: { value: 0 },
  uTau: { value: 0.04 }, uPush: { value: 1.012 },
  uShowDepth: { value: 0 }, uDepthMix: { value: 1 }, uDepthD: { value: 5 }, uDepthW: { value: 0.6 }, uMetric: { value: 1 },
  uSliceOn: { value: 0 }, uSliceDist: { value: 3 }, uSliceW: { value: 0.25 },
  uFade: { value: 0 }, uOpacity: { value: 1 }
};

export function initGfx(canvas) {
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, depth: true, stencil: true,
    powerPreference: 'high-performance', preserveDrawingBuffer: false
  });
  renderer.xr.enabled = true;                           // VR headset mode (xr.js); no effect until a session starts
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 3D objects only; the panorama is a ShaderMaterial without tone mapping
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x000000, 1);
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = (gl.getShaderInfoLog(fs) || '') + (gl.getShaderInfoLog(vs) || '') + (gl.getProgramInfoLog(program) || '');
    S.errs.push(log.split('\n')[0]);
    console.error('Shader error', log);
  };
  const gl = renderer.getContext();
  S.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  S.vtf = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0;
  // Phones and software rendering: 512×256 mesh (a quarter of the vertices). Silhouettes
  // stay just as sharp, since the texel test cuts them; only edge cells get wider.
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rend = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
  S.softGL = /SwiftShader|llvmpipe|softpipe|Software/i.test(rend);
  S.lowPower = S.softGL || /Android|iPhone|iPad|Mobile|OculusBrowser|Quest|Pico/i.test(navigator.userAgent) ||
    !!(navigator.deviceMemory && navigator.deviceMemory <= 4);
  const gp = new URLSearchParams(location.search).get('grid');
  const g = gp === '1024' ? 1024 : gp === '512' ? 512 : (S.lowPower ? 512 : 1024);
  GRID.w = g; GRID.h = g / 2;
  panoUniforms.uGrid.value.set(GRID.w, GRID.h);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(78, 1, 0.1, D_FAR * 4);
  world = new THREE.Group(); world.name = 'world';
  scene.add(world);
  objectsRoot = new THREE.Group(); objectsRoot.name = 'objects';
  world.add(objectsRoot);
  pmrem = new THREE.PMREMGenerator(renderer);

  // Lighting for objects: soft sky fill plus a "sun" in panorama coordinates
  hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3328, 0.35);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, 1.6);
  // Shadows are enabled only when some object casts a sun shadow (objectsUpdate).
  // Otherwise three binds an empty texture without a compare mode to
  // sampler2DShadow, and every draw call with lit materials fails with
  // GL_INVALID_OPERATION: the objects simply vanish.
  sun.castShadow = false;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  world.add(sun); world.add(sun.target);

  buildPanoObjects();
  return renderer;
}

let posAttr = null, idxAttr = null, allCells = null;
const NO_CELLS = new Uint32Array(0);
function buildPanoObjects() {
  const W = GRID.w, H = GRID.h;
  const verts = new Float32Array((W + 1) * (H + 1) * 3);
  let k = 0;
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) { verts[k++] = i / W; verts[k++] = j / H; verts[k++] = 0; }
  posAttr = new THREE.BufferAttribute(verts, 3);
  // One index buffer: [plain cells | edge cells | background cells]. Each layer draws its own range.
  idxAttr = new THREE.BufferAttribute(new Uint32Array(W * H * 6 * 2), 1);
  allCells = new Uint32Array(W * H); for (let i = 0; i < W * H; i++) allCells[i] = i;
  const geo = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', posAttr); g.setIndex(idxAttr);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), D_FAR * 2);
    return g;
  };
  const gPlain = geo(), gEdge = geo(), gBg = geo(), gBgE = geo();
  const mat = (defines, extra) => new THREE.ShaderMaterial(Object.assign({
    uniforms: panoUniforms, vertexShader: VS_PANO, fragmentShader: FS_PANO, defines, side: THREE.DoubleSide
  }, extra || {}));
  const mesh = (g, m, order, name) => { const x = new THREE.Mesh(g, m); x.frustumCulled = false; x.renderOrder = order; x.name = name; return x; };
  // Colour: front layer first (plain cells, then edge cells with discard), then background;
  // early depth testing rejects its fragments behind the front layer.
  panoMesh = mesh(gPlain, mat({}), -1, 'panoMesh');
  panoEdge = mesh(gEdge, mat({ EDGE: 1 }), -1, 'panoEdge');
  panoBG = mesh(gBg, mat({ BG: 1 }), -0.95, 'panoBG');
  panoBGE = mesh(gBgE, mat({ BG: 1, BGEDGE: 1 }), -0.94, 'panoBGE');
  panoMesh.add(panoEdge, panoBG, panoBGE);
  panoMesh.visible = false;
  world.add(panoMesh);
  // Depth-only pre-pass (occluder for a semi-transparent panorama)
  const pre = { colorWrite: false, depthWrite: true };
  panoPre = mesh(gPlain, mat({ PRE: 1 }, pre), -3, 'panoPre');
  preEdge = mesh(gEdge, mat({ PRE: 1, EDGE: 1 }, pre), -3, 'preEdge');
  preBG = mesh(gBg, mat({ PRE: 1, BG: 1 }, pre), -2.95, 'preBG');
  preBGE = mesh(gBgE, mat({ PRE: 1, BG: 1, BGEDGE: 1 }, pre), -2.94, 'preBGE');
  panoPre.add(preEdge, preBG, preBGE);
  panoPre.visible = false;
  world.add(panoPre);
  setPanoLayers(null);

  // Base sphere (panorama without depth). In VR stereo 3DoF, sphereL is the left eye (layer 1)
  // and sphereR the right eye (layer 2); three's XR cameras render layer 1 / 2 per eye.
  const sgeo = new THREE.SphereGeometry(500, 96, 48);
  const mkSphere = eye => {
    const s = new THREE.Mesh(sgeo, new THREE.ShaderMaterial({
      uniforms: {
        uPano: panoUniforms.uPano, uDepth: panoUniforms.uDepth, uLayout: panoUniforms.uLayout,
        uEye: { value: eye }, uEyeMix: { value: 0 }, uShowDepth: panoUniforms.uShowDepth,
        uDepthMix: panoUniforms.uDepthMix, uDepthD: panoUniforms.uDepthD, uDepthW: panoUniforms.uDepthW, uMetric: panoUniforms.uMetric,
        uNearM: panoUniforms.uNearM, uFarM: panoUniforms.uFarM,
        uHasDepth: { value: 0 }, uFade: panoUniforms.uFade, uOpacity: panoUniforms.uOpacity
      },
      // The sphere is a backdrop "at infinity": no depth test, drawn first
      vertexShader: VS_SPHERE, fragmentShader: FS_SPHERE, side: THREE.BackSide, depthWrite: false, depthTest: false
    }));
    s.frustumCulled = false; s.renderOrder = -4; s.visible = false;
    return s;
  };
  sphereL = mkSphere(0); sphereL.name = 'sphereL';
  sphereR = mkSphere(1); sphereR.name = 'sphereR';
  sphereR.material.uniforms.uHasDepth = sphereL.material.uniforms.uHasDepth;
  sphereR.layers.set(2);
  world.add(sphereL); world.add(sphereR);
  // Mesh backdrop: a sphere at infinity drawn AFTER the layers, only where they drew nothing
  // (depth test), so tears in both layers show the distant background rather than black.
  const bu = sphereL.material.uniforms;
  panoBack = new THREE.Mesh(sgeo, new THREE.ShaderMaterial({
    uniforms: { uPano: bu.uPano, uDepth: bu.uDepth, uLayout: bu.uLayout, uEye: bu.uEye, uEyeMix: { value: 0 },
      uShowDepth: bu.uShowDepth, uDepthMix: bu.uDepthMix, uDepthD: bu.uDepthD, uDepthW: bu.uDepthW, uMetric: bu.uMetric,
      uNearM: bu.uNearM, uFarM: bu.uFarM, uHasDepth: { value: 0 }, uFade: bu.uFade, uOpacity: bu.uOpacity },
    vertexShader: VS_SPHERE, fragmentShader: FS_SPHERE, side: THREE.BackSide, depthWrite: false, depthTest: true
  }));
  panoBack.frustumCulled = false; panoBack.renderOrder = -0.5; panoBack.name = 'panoBack';
  panoBack.visible = false;
  panoMesh.add(panoBack);
}

/* Panorama display modes:
   'mesh'   : depth mesh (parallax)
   'sphere' : sphere at infinity (no depth)
   'stereo' : two spheres, left eye on layer 1, right eye on layer 2 (VR only)
   'none'   : panorama hidden (e.g. in photo mode) */
export function setPanoMode(mode) {
  panoMesh.visible = mode === 'mesh';
  panoPre.visible = mode === 'mesh' && panoUniforms.uOpacity.value < 0.999;
  sphereL.visible = mode === 'sphere' || mode === 'stereo';
  sphereR.visible = mode === 'stereo';
  sphereL.layers.set(mode === 'stereo' ? 1 : 0);
  S.panoMode = mode;
}

export function setEyeLayout() {
  const L = S.layoutEff || S.layout;
  panoUniforms.uLayout.value = L === 'tb' ? 1 : L === 'sbs' ? 2 : 0;
  const eL = S.swapEyes ? 1 : 0;
  panoUniforms.uEyeL.value = eL;
  sphereL.material.uniforms.uEye.value = eL;
  sphereR.material.uniforms.uEye.value = 1 - eL;
}

/* Panorama transparency (VR passthrough): depth pre-pass, then colour with LessEqual */
export function setPanoOpacity(op) {
  panoUniforms.uOpacity.value = op;
  const tr = op < 0.999;
  for (const m of [panoMesh.material, panoEdge.material, panoBG.material, panoBGE.material, panoBack.material, sphereL.material, sphereR.material]) {
    m.transparent = tr;
    m.needsUpdate = true;
  }
  for (const m of [panoMesh.material, panoEdge.material, panoBG.material, panoBGE.material]) {
    m.depthWrite = !tr;
    m.depthFunc = tr ? THREE.LessEqualDepth : THREE.LessDepth;
  }
  panoPre.visible = tr && panoMesh.visible;
}

/* Assigns mesh cells to layers. L = { plain, edge, bg } holds arrays of cell indices
   (j·W + i), or is null: the whole mesh is plain, with no edge or background cells (no layer map). */
function writeCells(ids, at) {
  const W = GRID.w, I = idxAttr.array;
  let k = at;
  for (let n = 0; n < ids.length; n++) {
    const id = ids[n], j = (id / W) | 0, i = id - j * W;
    const a = j * (W + 1) + i, b = a + 1, c = a + W + 1, d = c + 1;
    I[k++] = a; I[k++] = c; I[k++] = b; I[k++] = b; I[k++] = c; I[k++] = d;
  }
  return k;
}
export function setPanoLayers(L) {
  const plain = L ? L.plain : allCells, edge = L ? L.edge : NO_CELLS;
  const bg = L ? L.bg : NO_CELLS, bgEdge = L && L.bgEdge ? L.bgEdge : NO_CELLS;
  const e0 = writeCells(plain, 0), b0 = writeCells(edge, e0), c0 = writeCells(bg, b0), end = writeCells(bgEdge, c0);
  panoMesh.geometry.setDrawRange(0, e0);
  panoEdge.geometry.setDrawRange(e0, b0 - e0);
  panoBG.geometry.setDrawRange(b0, c0 - b0);
  panoBGE.geometry.setDrawRange(c0, end - c0);
  idxAttr.clearUpdateRanges(); idxAttr.addUpdateRange(0, end);
  idxAttr.needsUpdate = true;
  if (panoBack) panoBack.visible = !!L;
  S.layers = L ? { plain: plain.length, edge: edge.length, bg: bg.length, bgEdge: bgEdge.length } : null;
}

/* ═══════════ textures ═══════════ */
export function makePanoTexture(src, mip) {
  const t = new THREE.Texture(src);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;          // the panorama shader writes sRGB values with no conversion
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = !!mip;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.needsUpdate = true;
  return t;
}
export function makeDataTexture(src) {
  const t = new THREE.Texture(src);
  t.flipY = false; t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
/* Uploads to the GPU immediately and checks for GL_OUT_OF_MEMORY:
   that failure throws no exception, the texture just stays black. */
export function uploadChecked(tex) {
  const gl = renderer.getContext();
  let guard = 0; while (gl.getError() !== gl.NO_ERROR && ++guard < 32) { }
  try { renderer.initTexture(tex); } catch (e) { return false; }
  const err = gl.getError();
  return err === gl.NO_ERROR;
}

export function makeRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: false
  });
}

/* ═══════════ full-screen pass into a render target ═══════════ */
const passScene = new THREE.Scene(), passCam = new THREE.Camera();
let passMesh = null;
export function runPass(material, target) {
  if (!passMesh) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    passMesh = new THREE.Mesh(g, material);
    passMesh.frustumCulled = false;
    passScene.add(passMesh);
  }
  passMesh.material = material;
  const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled;
  const prevSM = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.xr.enabled = false;              // otherwise three substitutes the XR camera while presenting
  renderer.setRenderTarget(target);
  renderer.render(passScene, passCam);
  renderer.setRenderTarget(prevRT);
  renderer.xr.enabled = prevXR;
  renderer.shadowMap.enabled = prevSM;
}
export const PASS_VS = `varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* ═══════════ image-based lighting from the panorama (IBL) ═══════════ */
let envTex = null;
export function buildEnvironment(small) {
  // small: a canvas in our convention (u=0.5 → −Z). For three's equirect: u3 = u − 0.25.
  const W = small.width, H = small.height, sh = Math.round(W * 0.25);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(small, sh, 0, W - sh, H, 0, 0, W - sh, H);
  g.drawImage(small, 0, 0, sh, H, W - sh, 0, sh, H);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled;
  renderer.xr.enabled = false;              // PMREM renders with its own cameras, never the XR one
  const rt = pmrem.fromEquirectangular(tex);
  renderer.setRenderTarget(prevRT);
  renderer.xr.enabled = prevXR;
  tex.dispose();
  if (envTex) envTex.dispose();
  envTex = rt;
  scene.environment = rt.texture;
}
export function clearEnvironment() {
  if (envTex) { envTex.dispose(); envTex = null; }
  scene.environment = null;
}

/* 2D canvas size */
export function resize2D() {
  if (renderer.xr.isPresenting) return [0, 0];   // the headset owns the framebuffer size
  const cv = renderer.domElement;
  const dpr = Math.min(window.devicePixelRatio || 1, S.dprCap);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
  const sz = renderer.getSize(new THREE.Vector2());
  if (sz.x !== w || sz.y !== h) renderer.setSize(w, h, false);
  return [Math.round(w * dpr), Math.round(h * dpr)];
}
export { THREE };
