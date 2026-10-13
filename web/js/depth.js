// Depth reconstruction from a stereo pair, depth-map import, automatic scale calibration,
// CPU-side depth sampling and ray intersection with the panorama surface.
import { THREE, renderer, makeRT, runPass, PASS_VS, GLSL_COMMON, GLSL_EYE, panoUniforms, GRID } from './gfx.js';
import { S, D_FAR, IPD_HALF, TAU, clamp, $ } from './state.js';
import { buildLayers, disposeLayers } from './layers.js';
import { PH, photoDistDir, photoNormal } from './photo.js';

const D_NEAR_STEREO = 1.2;             // near plane used to encode stereo depth
const D_MAX_NORM = 0.024;              // full disparity at ~0.42 m: upper bound of the search

/* ═══════════ pass shaders ═══════════ */
const FS_MATCH = `
varying vec2 vUv;
uniform sampler2D uPano, uPrev;
uniform float uHasPrev, uDMax, uRange, uInvW, uInvH, uEyeL, uLod;
` + GLSL_COMMON + GLSL_EYE + `
float lum(vec2 uv, float eye){
  vec3 c = textureLod(uPano, eyeUv(vec2(fract(uv.x), clamp(uv.y,0.003,0.997)), eye), uLod).rgb;
  return dot(c, vec3(0.299,0.587,0.114));
}
float cost(vec2 uv, float d){
  float s = 0.0;
  for(int i=-TAPX;i<=TAPX;i++){
    for(int j=-TAPY;j<=TAPY;j++){
      vec2 o = vec2(float(i)*uInvW, float(j)*uInvH);
      s += abs(lum(uv+o, uEyeL) - lum(uv+o-vec2(d,0.0), 1.0-uEyeL));
    }
  }
  return s;
}
void main(){
  float d0 = uHasPrev>0.5 ? dec16(texture2D(uPrev,vUv).rg)*uDMax : 0.0;
  float best=1000000.0, bestD=0.0, second=1000000.0, cm=0.0, cp=0.0, sstep=0.0;
  for(int k=0;k<STEPS;k++){
    float t = float(k)/float(STEPS-1);
    float d = uHasPrev>0.5 ? d0 + (t*2.0-1.0)*uRange : t*uDMax;
    d = clamp(d, 0.0, uDMax);
    float c = cost(vUv, d);
    if(c < best){ second=best; best=c; bestD=d; }
    else if(c < second) second = c;
  }
  sstep = (uHasPrev>0.5 ? uRange*2.0 : uDMax) / float(STEPS-1);
  cm = cost(vUv, max(bestD-sstep,0.0));
  cp = cost(vUv, min(bestD+sstep,uDMax));
  float den = cm - 2.0*best + cp;                       // parabolic sub-pixel refinement
  if(abs(den) > 0.000001) bestD += clamp(0.5*(cm-cp)/den, -1.0, 1.0)*sstep;
  bestD = clamp(bestD, 0.0, uDMax);
  float conf = clamp((second-best)/max(second,0.0001), 0.0, 1.0);
  gl_FragColor = vec4(enc16(bestD/uDMax), conf, 1.0);
}`;

/* disparity -> normalised depth, plus cross-bilateral clean-up */
const FS_REFINE = `
varying vec2 vUv;
uniform sampler2D uSrc, uPano;
uniform float uDMax, uInvW, uInvH, uNearM, uFarM, uSigma, uEyeL, uLod;
` + GLSL_COMMON + GLSL_EYE + `
float lumL(vec2 uv){
  vec3 c = textureLod(uPano, eyeUv(vec2(fract(uv.x), clamp(uv.y,0.003,0.997)), uEyeL), uLod).rgb;
  return dot(c, vec3(0.299,0.587,0.114));
}
float dn_at(vec2 uv){
  vec4 s = texture2D(uSrc, uv);
  float dnorm = dec16(s.rg)*uDMax;                       // full L->R disparity as a fraction of width
  float lat = (0.5-uv.y)*PI_;
  float cp = max(abs(cos(lat)), 0.30);
  float ang = max(dnorm*PI_, 0.000001);                  // angle per eye
  float dm = clamp(${IPD_HALF.toFixed(4)} / (tan(ang)*cp), uNearM, uFarM);
  return clamp((1.0/dm - 1.0/uFarM)/(1.0/uNearM - 1.0/uFarM), 0.0, 1.0);
}
void main(){
  float c0 = lumL(vUv);
  float acc = 0.0, wsum = 0.0;
  for(int i=-3;i<=3;i++){
    for(int j=-3;j<=3;j++){
      vec2 o = vec2(float(i)*uInvW*1.4, float(j)*uInvH*1.4);
      vec4 s = texture2D(uSrc, vUv+o);
      float conf = s.b;
      float wc = exp(-abs(lumL(vUv+o)-c0)/uSigma);       // keeps depth edges aligned with object edges
      float w = (0.05 + conf*conf)*wc;
      acc += dn_at(vUv+o)*w; wsum += w;
    }
  }
  gl_FragColor = vec4(enc16(acc/max(wsum,0.00001)), 1.0, 1.0);
}`;

/* depth from file: grey -> normalised inverse depth.
   An 8-bit map produces "terraces"; only neighbours within ±2.5 levels are smoothed, so edges survive. */
const FS_IMPORT = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uInvert, uSx, uSy;
uniform vec4 uSub;
` + GLSL_COMMON + `
float g(vec2 uv){
  float v = texture2D(uSrc, uSub.xy + vec2(fract(uv.x), clamp(uv.y,0.0,1.0))*uSub.zw).r;
  return uInvert > 0.5 ? 1.0 - v : v;
}
void main(){
  float c = g(vUv);
  float acc = 0.0, ws = 0.0;
  for(int i=-3;i<=3;i++){
    for(int j=-3;j<=3;j++){
      float s = g(vUv + vec2(float(i)*uSx, float(j)*uSy));
      float w = exp(-float(i*i+j*j)/6.0) * (1.0 - step(2.5/255.0, abs(s-c)));
      acc += s*w; ws += w;
    }
  }
  gl_FragColor = vec4(enc16(acc/max(ws,0.00001)), 1.0, 1.0);
}`;

/* ── Depth edges ──
   Blurred map edges (typical of neural networks and any downscaling) form a "ramp" between
   a trunk and the background, and the mesh stretches the trunk texture along it. Here:
   1) windowed min/max (separable filter): where the range exceeds uTau, there is an edge;
   2) each texel takes either the near-side or far-side depth, turning the ramp into a step at
      the true edge, located by the ramp midpoint and the photo colour (FS_SNAP);
   3) for front-layer vertices, depth is dilated by one mesh cell around steps (max). */
const FS_MINMAX = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uR, uFirst, uInvH;
` + GLSL_COMMON + `
void main(){
  float mx = 0.0, mn = 1.0;
  for(int k=-16;k<=16;k++){
    if(abs(float(k)) > uR) continue;
    vec2 uv = vUv + uStep*float(k);
    uv = vec2(fract(uv.x), clamp(uv.y, 0.5*uInvH, 1.0 - 0.5*uInvH));
    vec4 s = texture2D(uSrc, uv);
    float a = dec16(s.rg);
    mx = max(mx, a); mn = min(mn, uFirst > 0.5 ? a : dec16(s.ba));
  }
  gl_FragColor = vec4(enc16(mx), enc16(mn));
}`;
/* Ramp -> step. The object/background boundary is set by the midpoint of the depth ramp, and
   right next to it (within uCr texels) by the photo colour: the depth map can be offset by a
   pixel or two from the true edge, and the photo's edge pixels are colour mixtures (anti-aliasing,
   JPEG ringing). A texel whose colour resembles the object (object colour fraction > 0.35) stays
   with the object; otherwise, once the viewpoint moves, a dark dotted line remains on the
   background where the outline was (an edge "ghost"). Further from the midpoint, depth decides:
   a similarly coloured distant object must not "stick" to a nearer one. */
const FS_SNAP = `
varying vec2 vUv;
uniform sampler2D uSrc, uMM, uPano;
uniform float uTau, uR, uCr, uInvW, uInvH, uEyeL, uLod;
` + GLSL_COMMON + GLSL_EYE + `
float D(vec2 uv){ return dec16(texture2D(uSrc, vec2(fract(uv.x), clamp(uv.y, 0.5*uInvH, 1.0 - 0.5*uInvH))).rg); }
vec3 C(vec2 uv){ return textureLod(uPano, eyeUv(vec2(fract(uv.x), clamp(uv.y, 0.003, 0.997)), uEyeL), uLod).rgb; }
void main(){
  float dn = D(vUv);
  vec4 m = texture2D(uMM, vUv);
  float mx = dec16(m.rg), mn = dec16(m.ba), rng = mx - mn;
  if(rng > uTau){
    float mid = 0.5*(mx + mn);
    float fg = dn > mid ? 1.0 : 0.0;             // by depth: ramp midpoint
    vec2 px = vec2(uInvW, uInvH);
    // direction towards the object (depth gradient); along it, the distance to the ramp midpoint
    // and the first "clean" object and background texels (one step further in: no mixed pixel)
    vec2 g = vec2(D(vUv + vec2(uR, 0.0)*px) - D(vUv - vec2(uR, 0.0)*px),
                  D(vUv + vec2(0.0, uR)*px) - D(vUv - vec2(0.0, uR)*px));
    float gl = length(g);
    if(gl > 0.25*uTau){
      vec2 n = g/gl*px;
      float hiT = mn + 0.75*rng, loT = mn + 0.25*rng, kc = 99.0;
      vec2 pn = vec2(-9.0), pf = vec2(-9.0);
      for(int k=1;k<=12;k++){
        if(float(k) > 2.0*uR + 2.0) break;
        float fk = float(k);
        vec2 qn = vUv + n*fk, qf = vUv - n*fk;
        float an = D(qn), af = D(qf);
        if(kc > 98.0 && (fg > 0.5 ? af <= mid : an > mid)) kc = fk;
        if(pn.x < -1.0 && an >= hiT) pn = D(qn + n) >= hiT ? qn + n : qn;
        if(pf.x < -1.0 && af <= loT) pf = D(qf - n) <= loT ? qf - n : qf;
      }
      if(kc <= uCr && pn.x > -1.0 && pf.x > -1.0){
        vec3 c0 = C(vUv), cN = C(pn), cF = C(pf), v = cN - cF;
        float L2 = dot(v, v);
        if(L2 > 0.0036){                         // object and background differ in colour
          float al = dot(c0 - cF, v)/L2;         // fraction of object colour in the texel
          // trust the colour if it is explained by an object/background mix (not a third object)
          if(distance(c0, cF + al*v) < 0.6*sqrt(L2)) fg = al > 0.35 ? 1.0 : 0.0;
        }
      }
    }
    dn = fg > 0.5 ? mx : mn;
  }
  gl_FragColor = vec4(enc16(dn), enc16(dn));
}`;
const FS_COMBINE = `
varying vec2 vUv;
uniform sampler2D uS, uM;
uniform float uTau;
` + GLSL_COMMON + `
void main(){
  float s = dec16(texture2D(uS, vUv).rg);
  float m = dec16(texture2D(uM, vUv).rg);
  gl_FragColor = vec4(enc16(s), enc16(m - s > uTau ? m : s));
}`;
/* Mesh cell flag: the cell (plus a one-texel border) contains a depth jump > uTau */
const FS_CELLS = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uRc, uInvW, uInvH, uGW, uGH, uTau;
` + GLSL_COMMON + `
void main(){
  float ci = floor(vUv.x*uGW), cj = floor(vUv.y*uGH);
  float mx = 0.0, mn = 1.0;
  for(int a=0;a<12;a++){
    if(float(a) > uRc + 1.0) break;
    for(int b=0;b<12;b++){
      if(float(b) > uRc + 1.0) break;
      vec2 t = vec2(ci*uRc - 1.0 + float(a), cj*uRc - 1.0 + float(b)) + 0.5;
      vec2 uv = vec2(fract(t.x*uInvW), clamp(t.y*uInvH, 0.5*uInvH, 1.0 - 0.5*uInvH));
      float d = dec16(texture2D(uSrc, uv).rg);
      mx = max(mx, d); mn = min(mn, d);
    }
  }
  gl_FragColor = vec4(mx - mn > uTau ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;
/* Downscaled copy for the CPU: one texel from each f×f block (no blending across edges) */
const FS_DOWN = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uF, uInvW, uInvH, uCW, uCH;
void main(){
  vec2 px = floor(vUv*vec2(uCW, uCH));
  gl_FragColor = vec4(texture2D(uSrc, (px*uF + 0.5)*vec2(uInvW, uInvH)).rg, 0.0, 1.0);
}`;

let P = null;
function programs() {
  if (P) return P;
  const U = () => ({ uLayout: panoUniforms.uLayout });
  const mk = (fs, uniforms, defines) => new THREE.ShaderMaterial({
    vertexShader: PASS_VS, fragmentShader: fs, uniforms: Object.assign(U(), uniforms), defines: defines || {},
    depthTest: false, depthWrite: false
  });
  const mu = () => ({
    uPano: { value: null }, uPrev: { value: null }, uHasPrev: { value: 0 }, uDMax: { value: D_MAX_NORM },
    uRange: { value: 0 }, uInvW: { value: 0 }, uInvH: { value: 0 }, uEyeL: { value: 0 }, uLod: { value: 0 }
  });
  P = {
    match0: mk(FS_MATCH, mu(), { STEPS: 32, TAPX: 2, TAPY: 1 }),
    match1: mk(FS_MATCH, mu(), { STEPS: 12, TAPX: 1, TAPY: 1 }),
    refine: mk(FS_REFINE, {
      uSrc: { value: null }, uPano: { value: null }, uDMax: { value: D_MAX_NORM }, uInvW: { value: 0 }, uInvH: { value: 0 },
      uNearM: { value: D_NEAR_STEREO }, uFarM: { value: D_FAR }, uSigma: { value: 0.13 }, uEyeL: { value: 0 }, uLod: { value: 0 }
    }),
    imp: mk(FS_IMPORT, {
      uSrc: { value: null }, uInvert: { value: 0 }, uSx: { value: 0 }, uSy: { value: 0 },
      uSub: { value: new THREE.Vector4(0, 0, 1, 1) }
    }),
    minmax: mk(FS_MINMAX, { uSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uR: { value: 1 }, uFirst: { value: 1 }, uInvH: { value: 0 } }),
    snap: mk(FS_SNAP, {
      uSrc: { value: null }, uMM: { value: null }, uPano: { value: null }, uTau: { value: 0.04 }, uR: { value: 1 }, uCr: { value: 1 },
      uInvW: { value: 0 }, uInvH: { value: 0 }, uEyeL: { value: 0 }, uLod: { value: 0 }
    }),
    combine: mk(FS_COMBINE, { uS: { value: null }, uM: { value: null }, uTau: { value: 0.04 } }),
    cells: mk(FS_CELLS, { uSrc: { value: null }, uRc: { value: 1 }, uInvW: { value: 0 }, uInvH: { value: 0 }, uGW: { value: 0 }, uGH: { value: 0 }, uTau: { value: 0.04 } }),
    down: mk(FS_DOWN, { uSrc: { value: null }, uF: { value: 1 }, uInvW: { value: 0 }, uInvH: { value: 0 }, uCW: { value: 0 }, uCH: { value: 0 } })
  };
  return P;
}

/* Tasks run inside a render-loop frame */
const loopTasks = [];
export function runInLoop(fn) { return new Promise((res, rej) => loopTasks.push({ fn, res, rej })); }
export function drainLoopTasks() {
  const t = loopTasks.shift();
  if (!t) return;
  try { t.res(t.fn()); } catch (e) { t.rej(e); }
}

let depthRT = null;
export function disposeDepth() {
  if (depthRT) { depthRT.dispose(); depthRT = null; }
  S.depthReady = false; S.depthCPU = null;
  panoUniforms.uDepth.value = null;
  disposeLayers();
}

// Depth-jump threshold in metric inverse depth (1/m). Gentle slopes (ground, walls) change
// far less per cell, so only genuine object boundaries tear.
const TAU_M = 0.025, TAU_M_STEREO = 0.05;
function depthCap() {
  const low = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (S.maxTex || 4096) < 8192;
  return low ? 2048 : 4096;
}
/* Largest side worth decoding a depth-map file to */
export function depthBitmapCap(w, h) {
  const sbs = h > 0 && Math.abs(w / h - 4) < 0.4;
  return Math.min(S.maxTex || 4096, depthCap() * (sbs ? 2 : 1));
}
const pow2Floor = x => Math.pow(2, Math.floor(Math.log2(Math.max(1, x))));

/* Main entry point: builds the depth texture from a file or from the stereo pair.
   status(t) receives the step label for the loading screen. */
export async function buildDepth(panoTex, depthTex, depthInfo, status) {
  const P = programs();
  disposeDepth();
  const eL = S.swapEyes ? 1 : 0;
  // Depth resolution: that of the map (up to 4096 wide), or 1024 for stereo reconstruction
  let DW = 1024;
  if (depthTex) {
    const sub = P.imp.uniforms.uSub.value.set(0, 0, 1, 1);
    const ar = depthInfo.w / depthInfo.h;
    if (S.layoutOrig === 'tb' && Math.abs(ar - 1) < 0.15) sub.set(0, eL * 0.5, 1, 0.5);
    else if (S.layoutOrig === 'sbs' && Math.abs(ar - 4) < 0.4) sub.set(eL * 0.5, 0, 0.5, 1);
    DW = clamp(pow2Floor(depthInfo.w * sub.z * 1.25), 1024, Math.min(depthCap(), S.maxTex || 4096));
  }
  const DH = DW / 2;
  const raw = makeRT(DW, DH); raw.texture.wrapS = THREE.RepeatWrapping;
  const eyeW = S.panoW / (S.layoutEff === 'sbs' ? 2 : 1);
  const lodFor = (w) => panoTex.generateMipmaps ? Math.max(0, Math.log2(eyeW / w)) : 0;

  if (depthTex) {
    status && status('importing map');
    const m = P.imp, sub = m.uniforms.uSub.value;
    m.uniforms.uSrc.value = depthTex;
    m.uniforms.uInvert.value = S.depthInvert ? 1 : 0;
    m.uniforms.uSx.value = 1.6 / Math.max(DW, depthInfo.w * sub.z);
    m.uniforms.uSy.value = 1.6 / Math.max(DH, depthInfo.h * sub.w);
    await runInLoop(() => runPass(m, raw));
  } else {
    const rtA = makeRT(DW / 2, DH / 2), rtB = makeRT(DW, DH);
    status && status('coarse pass 1 of 2');
    await runInLoop(() => {
      const m = P.match0, u = m.uniforms;
      u.uPano.value = panoTex; u.uHasPrev.value = 0; u.uRange.value = 0;
      u.uInvW.value = 1 / rtA.width; u.uInvH.value = 1 / rtA.height; u.uEyeL.value = eL; u.uLod.value = lodFor(rtA.width);
      runPass(m, rtA);
    });
    status && status('refining pass 2 of 2');
    await runInLoop(() => {
      const m = P.match1, u = m.uniforms;
      u.uPano.value = panoTex; u.uPrev.value = rtA.texture; u.uHasPrev.value = 1; u.uRange.value = D_MAX_NORM / 16;
      u.uInvW.value = 1 / rtB.width; u.uInvH.value = 1 / rtB.height; u.uEyeL.value = eL; u.uLod.value = lodFor(rtB.width);
      runPass(m, rtB);
    });
    status && status('cleaning edges');
    await runInLoop(() => {
      const m = P.refine, u = m.uniforms;
      u.uSrc.value = rtB.texture; u.uPano.value = panoTex;
      u.uInvW.value = 1 / DW; u.uInvH.value = 1 / DH; u.uEyeL.value = eL; u.uLod.value = lodFor(DW);
      runPass(m, raw);
    });
    rtA.dispose(); rtB.dispose();
  }
  // Scale (near) comes from raw depth: the ground is smooth and edges do not affect it
  await runInLoop(() => readDepthCPU(raw, DW, DH));
  if (!depthTex) S.near = D_NEAR_STEREO;      // metric scale from stereo, in case calibration fails
  calibrate();
  const tau = clamp((depthTex ? TAU_M : TAU_M_STEREO) / (1 / S.near - 1 / D_FAR), 0.008, 0.25);

  status && status('sharpening edges');
  const a = makeRT(DW, DH), b = makeRT(DW, DH), sh = makeRT(DW, DH);
  for (const r of [a, b, sh]) r.texture.wrapS = THREE.RepeatWrapping;
  // The sharpening window is small (≈0.35°): wider ramps are more likely a slope than a blurred
  // edge, and a slope must not be turned into steps.
  const rs = Math.max(1, DW / 1024), rc = Math.max(1, Math.round(DW / GRID.w));
  await runInLoop(() => {
    const m = P.minmax, u = m.uniforms;
    u.uInvH.value = 1 / DH;
    // 1–2: min/max over window rs; 3: ramp -> step
    u.uSrc.value = raw.texture; u.uStep.value.set(1 / DW, 0); u.uR.value = rs; u.uFirst.value = 1; runPass(m, a);
    u.uSrc.value = a.texture; u.uStep.value.set(0, 1 / DH); u.uFirst.value = 0; runPass(m, b);
    const n = P.snap.uniforms; n.uSrc.value = raw.texture; n.uMM.value = b.texture; n.uTau.value = tau;
    n.uPano.value = panoTex; n.uEyeL.value = eL; n.uLod.value = lodFor(DW); n.uR.value = rs;
    n.uCr.value = Math.max(1, rs / 2);                    // ≈0.18° either side of the ramp midpoint
    n.uInvW.value = 1 / DW; n.uInvH.value = 1 / DH;
    runPass(P.snap, sh);
    // 4–5: max over a mesh cell; 6: rg = sharpened depth, ba = front-layer vertex depth
    u.uSrc.value = sh.texture; u.uStep.value.set(1 / DW, 0); u.uR.value = rc; u.uFirst.value = 1; runPass(m, a);
    u.uSrc.value = a.texture; u.uStep.value.set(0, 1 / DH); u.uFirst.value = 0; runPass(m, b);
    const c = P.combine.uniforms; c.uS.value = sh.texture; c.uM.value = b.texture; c.uTau.value = tau; runPass(P.combine, raw);
  });
  a.dispose(); b.dispose(); sh.dispose();
  depthRT = raw;
  panoUniforms.uDepth.value = raw.texture;
  await runInLoop(() => readDepthCPU(raw, DW, DH));
  let flags = null;
  await runInLoop(() => { flags = readCells(raw, DW, DH, rc, tau); });
  S.depthTexW = DW; S.depthTau = tau;
  panoUniforms.uTau.value = tau;
  status && status('background layer');
  await new Promise(r => setTimeout(r, 40));            // let a frame display the step before the CPU work
  try { buildLayers(flags, tau); } catch (e) { console.error(e); disposeLayers(); }
  S.depthReady = true;
  return raw.texture;
}

/* ═══════════ CPU copy of depth (at most 2048 wide) ═══════════ */
function readDepthCPU(rt, DW, DH) {
  const f = DW > 2048 ? DW / 2048 : 1, w = DW / f, h = DH / f;
  let src = rt, tmp = null;
  if (f > 1) {
    tmp = makeRT(w, h);
    const m = programs().down, u = m.uniforms;
    u.uSrc.value = rt.texture; u.uF.value = f; u.uInvW.value = 1 / DW; u.uInvH.value = 1 / DH; u.uCW.value = w; u.uCH.value = h;
    runPass(m, tmp); src = tmp;
  }
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(src, 0, 0, w, h, buf);
  if (tmp) tmp.dispose();
  const dn = new Float32Array(w * h);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) dn[i] = buf[o] / 255 + buf[o + 1] / 65025;   // unpack 16 bits
  S.depthCPU = { w, h, dn };
  S.depthW = w; S.depthH = h;
}
/* Flags for mesh cells containing a depth jump (used for layer assignment) */
function readCells(rt, DW, DH, rc, tau) {
  const GW = GRID.w, GH = GRID.h, out = makeRT(GW, GH);
  const m = programs().cells, u = m.uniforms;
  u.uSrc.value = rt.texture; u.uRc.value = rc; u.uInvW.value = 1 / DW; u.uInvH.value = 1 / DH;
  u.uGW.value = GW; u.uGH.value = GH; u.uTau.value = tau;
  runPass(m, out);
  const buf = new Uint8Array(GW * GH * 4);
  renderer.readRenderTargetPixels(out, 0, 0, GW, GH, buf);
  out.dispose();
  const flags = new Uint8Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) flags[i] = buf[i * 4] > 127 ? 1 : 0;
  return flags;
}

/* ═══════════ automatic scale calibration ═══════════ */
// The ground is the only surface with known geometry: d = h/sin|φ|.
// Hence for it dn = (near/h)·sin|φ|, a line through the origin whose slope gives near.
function fitScale(readDn, W, H) {
  const xs = [], ys = [], row = new Float32Array(W);
  const j0 = Math.floor(H * 0.56), j1 = Math.floor(H * 0.94);
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < W; i++) row[i] = readDn(i, j);
    const s = Array.from(row).sort((a, b) => a - b);
    const phi = (0.5 - (j + 0.5) / H) * Math.PI;
    xs.push(Math.sin(-phi)); ys.push(s[s.length >> 1]);
  }
  const n = xs.length;
  if (n < 8) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx < 1e-9 || syy < 1e-12) return null;
  const a = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy);
  // Camera height does not affect the view (it scales scene and motion equally),
  // so 2.0 m is used as a fixed unit.
  return { near: clamp(a * 2.0, 0.25, 14.0), r2 };
}
export function calibrate() {
  const D = S.depthCPU;
  S.calibrated = false;
  if (!D) return;
  const SW = 256, SH = 128, kx = D.w / SW, ky = D.h / SH;
  const fit = fitScale((i, j) => {
    const x = Math.min(D.w - 1, (i * kx) | 0), y = Math.min(D.h - 1, (j * ky) | 0);
    return D.dn[y * D.w + x];
  }, SW, SH);
  if (fit && fit.r2 > 0.80) {
    S.near = fit.near; S.fitR2 = fit.r2; S.calibrated = true; S.camH = 2.0;
  } else {
    S.fitR2 = fit ? fit.r2 : 0;
    S.camH = estimateCamHeight();
  }
  const sl = $('sNear'); if (sl) sl.value = Math.round(100 * Math.log(S.near / 0.35) / Math.log(8.6));
  panoUniforms.uNearM.value = S.near;
}
// Without calibration: median −y of points below the camera (latitudes −36…−68°, skipping the
// nadir, where the tripod is, and the horizon, dominated by walls/trunks)
export function estimateCamHeight() {
  const D = S.depthCPU; if (!D) return 1.6;
  const ys = [], v3 = new THREE.Vector3();
  for (let j = Math.floor(D.h * 0.70); j < Math.floor(D.h * 0.88); j += 2)
    for (let i = 0; i < D.w; i += 8) {
      const u = (i + 0.5) / D.w, v = (j + 0.5) / D.h;
      uvToDir(u, v, v3); const d = distAt(u, v);
      ys.push(-v3.y * d);
    }
  ys.sort((a, b) => a - b);
  return ys.length ? clamp(ys[ys.length >> 1], 0.3, 50) : 1.6;
}

/* ═══════════ CPU sampling ═══════════ */
export function uvToDir(u, v, out) {
  const lon = (u - 0.5) * TAU, lat = (0.5 - v) * Math.PI, cl = Math.cos(lat);
  return out.set(Math.sin(lon) * cl, Math.sin(lat), -Math.cos(lon) * cl);
}
export function dirToUv(x, y, z) {
  return [0.5 + Math.atan2(x, -z) / TAU, Math.acos(clamp(y, -1, 1)) / Math.PI];
}
export function dnAt(u, v) {
  const D = S.depthCPU; if (!D) return 0;
  const w = D.w, h = D.h;
  let x = u * w - 0.5, y = clamp(v * h - 0.5, 0, h - 1);
  x = ((x % w) + w) % w;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % w, y1 = Math.min(y0 + 1, h - 1);
  const a = D.dn[y0 * w + x0], b = D.dn[y0 * w + x1], c = D.dn[y1 * w + x0], d = D.dn[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
const NO_DEPTH_R = 4.0;               // without depth the surface is a 4 m sphere
export function distAt(u, v) {
  if (!S.depthCPU) return NO_DEPTH_R;
  const dn = dnAt(u, v);
  return 1 / Math.max(dn * (1 / S.near - 1 / D_FAR) + 1 / D_FAR, 1e-6);
}
export function surfaceDistDir(d) {
  if (S.kind === 'photo') return photoDistDir(d);           // d: unit direction in panorama coordinates
  const [u, v] = dirToUv(d.x, d.y, d.z);
  return distAt(u, v);
}

/* Intersects ray (o, d) with the depth surface; o and d are in world-local coordinates.
   f(t) = |p| − D(dir p); march until f changes sign, then bisect. */
const _p = new THREE.Vector3();
function fAt(o, d, t) {
  _p.copy(d).multiplyScalar(t).add(o);
  const r = _p.length();
  if (r < 1e-6) return -1;
  _p.divideScalar(r);
  return r - surfaceDistDir(_p);
}
export function raySurface(o, d, maxT = D_FAR * 1.5) {
  let t0 = 0, f0 = fAt(o, d, 0);
  if (f0 > 0) {                                  // origin outside the shell: no search back for the entry point
    return { t: 0, point: o.clone(), dist: o.length(), inside: false };
  }
  let t = 0, f = f0, it = 0;
  while (it++ < 600 && t < maxT) {
    const step = Math.max(Math.abs(f) * 0.5, 0.004 * (1 + t * 0.15));
    const tn = t + step, fn = fAt(o, d, tn);
    if (fn >= 0) {
      let a = t, b = tn;
      for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (fAt(o, d, m) >= 0) b = m; else a = m; }
      const point = d.clone().multiplyScalar(b).add(o);
      return { t: b, point, dist: point.length(), inside: true };
    }
    t = tn; f = fn;
  }
  const point = d.clone().multiplyScalar(Math.min(t, maxT)).add(o);
  return { t, point, dist: point.length(), inside: true, miss: true };
}

/* Surface normal at a point (from the depth gradient), facing the panorama centre */
export function surfaceNormal(point) {
  if (S.kind === 'photo') return photoNormal(point);
  const r = point.length() || 1;
  const [u, v] = dirToUv(point.x / r, point.y / r, point.z / r);
  const du = 1.5 / (S.depthW || 1024), dv = 1.5 / (S.depthH || 512);
  const P = (uu, vv) => { const q = uvToDir(uu, vv, new THREE.Vector3()); return q.multiplyScalar(distAt(uu, vv)); };
  const a = P(u - du, v), b = P(u + du, v), c = P(u, clamp(v - dv, 0, 1)), d = P(u, clamp(v + dv, 0, 1));
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, c)).normalize();
  if (n.dot(point) > 0) n.negate();
  if (!isFinite(n.x)) n.set(0, 1, 0);
  return n;
}

/* Ground height under point (x, z): iteratively finds the surface in direction (x, y, z) */
export function groundAt(x, z) {
  // For flat ground at height −g any downward ray yields a point with y = −g,
  // so the iteration y ← P.y converges in one step, or a few on a slope.
  let y = S.kind === 'photo' ? -0.5 : -(S.camH || 2.0);
  const dir = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    dir.set(x, y, z).normalize();
    if (dir.y > -0.02) break;                  // no ground above the horizon
    const yn = dir.y * surfaceDistDir(dir);
    if (Math.abs(yn - y) < 0.002) { y = yn; break; }
    y = yn;
  }
  return y;
}

/* Exports the depth map as a PNG (8-bit, white = near) */
export function depthToCanvas() {
  const D = S.depthCPU; if (!D) return null;
  const c = document.createElement('canvas'); c.width = D.w; c.height = D.h;
  const g = c.getContext('2d'), img = g.createImageData(D.w, D.h);
  for (let i = 0; i < D.w * D.h; i++) {
    const v = Math.round(clamp(D.dn[i], 0, 1) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
