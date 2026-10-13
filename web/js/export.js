// Export: what is on screen, as images, stereo pairs, 360° panoramas and short videos.
//
//   • Image:   the current view re-rendered at a chosen size (screen, 2×, 4K), with the 3D objects.
//   • Stereo:  two views from eye positions a baseline apart, as side by side, cross-eyed,
//              top/bottom or a red/cyan anaglyph (Dubois matrices).
//   • 360°:    panoramas only. The scene is rendered into six cube faces from the centre and
//              resampled to an equirectangular image; stereo uses omni-directional stereo (ODS):
//              the panorama is cut into narrow longitude slices, each rendered from eye positions
//              on a circle, so every direction gets a correct left/right pair. Objects are drawn
//              in a separate linear HDR pass and tone-mapped like on screen.
//   • Video:   the canvas recorded with MediaRecorder while the camera follows a seamless loop.
import { THREE, renderer, scene, camera, world, objectsRoot, panoMesh, panoPre, sphereL, panoUniforms, runPass, PASS_VS, GLSL_COMMON } from './gfx.js';
import { S, $, t, clamp, DEG, D_FAR, hint, nextFrame, emit, loadPref, savePref } from './state.js';
import { PH, photoCamera } from './photo.js';
import { files, pauseLoop, resumeLoop, travelA, downloadDepthPNG, showHUD } from './viewer.js';
import { surfaceDistDir } from './depth.js';

const X = Object.assign({ size: 'screen', fmt: 'jpg', stereo: 'sbs', strength: 1, pano: 'mono', panoW: 4096, loops: 1 },
  loadPref('export', {}));
const saveX = () => savePref('export', X);
let busy = false;

/* ═══════════ helpers ═══════════ */
const baseName = () => {
  const n = (S.item && S.item.title) || (files.pano && files.pano.name) || (S.kind === 'photo' ? 'photo' : 'panorama');
  return String(n).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#%\s]+/g, '_').slice(0, 60) || 'nomono3d';
};
export function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
const toBlob = (c, type, q) => new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error('Image encoding failed')), type, q));
const mime = () => X.fmt === 'png' ? 'image/png' : 'image/jpeg';
const ext = () => X.fmt === 'png' ? '.png' : '.jpg';
function canvas2D(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function glLimits() {
  const gl = renderer.getContext();
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS), rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
  return Math.min(vp[0], vp[1], rb, S.maxTex || 4096, 8192);
}
/* Pixel size of an exported view for the chosen preset, keeping the on-screen aspect */
function viewSize(preset) {
  const cv = renderer.domElement, W = cv.width || 1280, H = cv.height || 720;
  let k = preset === '2x' ? 2 : preset === '4k' ? 3840 / Math.max(W, H) : 1;
  const lim = glLimits();
  k = Math.min(k, lim / Math.max(W, H));
  return [Math.max(2, Math.round(W * k)), Math.max(2, Math.round(H * k))];
}

/* Hide editor helpers (gizmo, selection box) and remember everything an export changes */
function begin() {
  const st = {
    pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()),
    pos: camera.position.clone(), quat: camera.quaternion.clone(), fov: camera.fov, aspect: camera.aspect,
    near: camera.near, far: camera.far, view: camera.view ? Object.assign({}, camera.view) : null,
    proj: camera.projectionMatrix.clone(), projI: camera.projectionMatrixInverse.clone(),
    eyeA: panoUniforms.uEyeA.value, clear: renderer.getClearColor(new THREE.Color()), clearA: renderer.getClearAlpha(),
    hidden: []
  };
  scene.traverse(o => { if (o.userData && o.userData.noExport && o.visible) { o.visible = false; st.hidden.push(o); } });
  pauseLoop();
  emit('export-start');
  return st;
}
function end(st) {
  st.hidden.forEach(o => { o.visible = true; });
  renderer.setRenderTarget(null);
  renderer.setPixelRatio(st.pr);
  renderer.setSize(st.size.x, st.size.y, false);
  renderer.setClearColor(st.clear, st.clearA);
  camera.position.copy(st.pos); camera.quaternion.copy(st.quat);
  camera.fov = st.fov; camera.aspect = st.aspect; camera.near = st.near; camera.far = st.far;
  if (st.view) camera.view = st.view; else if (camera.view) camera.view.enabled = false;
  camera.projectionMatrix.copy(st.proj); camera.projectionMatrixInverse.copy(st.projI);
  camera.updateMatrixWorld();
  panoUniforms.uEyeA.value = st.eyeA;
  emit('export-end');
  resumeLoop();
}

/* Render the current view at w×h, optionally from an eye offset (stereo), into a 2D canvas */
function renderView(st, w, h, eye = 0, conv = 0) {
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  if (S.kind === 'photo') {
    const c = PH.cam || { tx: 0, ty: 0, dolly: 0, zoom: 1 };
    photoCamera(w, h, c.tx, c.ty, c.dolly, c.zoom, eye);
  } else {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(st.quat);
    camera.position.copy(st.pos).addScaledVector(right, eye);
    camera.quaternion.copy(st.quat);
    camera.fov = st.fov; camera.near = st.near; camera.far = st.far;
    camera.aspect = w / h;
    // Converge on the subject: shift each eye's frustum so a point at distance conv has no disparity
    if (eye && conv > 0) {
      const f = (h / 2) / Math.tan(st.fov * DEG / 2);
      camera.setViewOffset(w, h, f * eye / conv, 0, w, h);      // left eye (eye < 0) shifts its window left
    } else if (camera.view && camera.view.enabled) camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  const c = canvas2D(w, h);
  c.getContext('2d').drawImage(renderer.domElement, 0, 0, w, h);   // same task as the render: the buffer is still valid
  return c;
}

/* ═══════════ image of the current view ═══════════ */
export async function exportImage(preset = X.size) {
  if (busy) return; busy = true;
  const st = begin();
  try {
    const [w, h] = viewSize(preset);
    const c = renderView(st, w, h);
    end(st);
    download(await toBlob(c, mime(), 0.93), baseName() + '_' + w + 'x' + h + ext());
    hint(t('Збережено ', 'Saved ') + w + '×' + h, 1800);
  } catch (e) { end(st); throw e; }
  finally { busy = false; }
}

/* ═══════════ stereo pair of the current view ═══════════ */
// Dubois least-squares red/cyan matrices (applied to linear RGB)
const DUB_L = [0.456, 0.500, 0.176, -0.040, -0.038, -0.016, -0.015, -0.021, -0.005];
const DUB_R = [-0.043, -0.088, -0.002, 0.378, 0.734, -0.018, -0.072, -0.113, 1.226];
const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const ENC = new Uint8ClampedArray(4096).map((_, i) => { const c = i / 4095; return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); });
function anaglyph(L, R) {
  const w = L.width, h = L.height, out = canvas2D(w, h), g = out.getContext('2d');
  const a = L.getContext('2d').getImageData(0, 0, w, h).data, b = R.getContext('2d').getImageData(0, 0, w, h).data;
  const im = g.createImageData(w, h), o = im.data, enc = v => ENC[v <= 0 ? 0 : v >= 1 ? 4095 : (v * 4095) | 0];
  for (let i = 0; i < o.length; i += 4) {
    const lr = LIN[a[i]], lg = LIN[a[i + 1]], lb = LIN[a[i + 2]], rr = LIN[b[i]], rg = LIN[b[i + 1]], rb = LIN[b[i + 2]];
    o[i] = enc(DUB_L[0] * lr + DUB_L[1] * lg + DUB_L[2] * lb + DUB_R[0] * rr + DUB_R[1] * rg + DUB_R[2] * rb);
    o[i + 1] = enc(DUB_L[3] * lr + DUB_L[4] * lg + DUB_L[5] * lb + DUB_R[3] * rr + DUB_R[4] * rg + DUB_R[5] * rb);
    o[i + 2] = enc(DUB_L[6] * lr + DUB_L[7] * lg + DUB_L[8] * lb + DUB_R[6] * rr + DUB_R[7] * rg + DUB_R[8] * rb);
    o[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return out;
}
function composeStereo(L, R, layout) {
  if (layout === 'anaglyph') return anaglyph(L, R);
  const w = L.width, h = L.height, tb = layout === 'tb';
  const out = canvas2D(tb ? w : w * 2, tb ? h * 2 : h), g = out.getContext('2d');
  const [A, B] = layout === 'cross' ? [R, L] : [L, R];
  g.drawImage(A, 0, 0); g.drawImage(B, tb ? 0 : w, tb ? h : 0);
  return out;
}
export function stereoAvailable() { return S.depthReady && (S.kind === 'photo' ? PH.hasDepth : S.panoMode === 'mesh'); }
/* Baseline in world units: a human eye distance for panoramas (scaled to the calibrated
   camera height), a small fraction of the nearest distance for photos (window stereo). */
function baseline() {
  if (S.kind === 'photo') return 0.032 * X.strength;
  return 0.064 * ((S.camH || 2) / 1.6) * X.strength;
}
export async function exportStereo(layout = X.stereo, preset = X.size) {
  if (busy) return;
  if (!stereoAvailable()) { hint(t('Стерео потребує карти глибини.', 'Stereo needs a depth map.'), 2400); return; }
  busy = true;
  const st = begin();
  try {
    let [w, h] = viewSize(preset);
    const b = baseline();
    // Convergence: the surface in the middle of the view (panoramas); photos converge on the focus plane
    let conv = 0;
    if (S.kind !== 'photo') {
      const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(st.quat);
      conv = clamp(surfaceDistDir(fw) || S.near * 2, S.near * 1.2, 40);
    }
    panoUniforms.uEyeA.value = Math.max(st.eyeA, b);
    const L = renderView(st, w, h, -b / 2, conv), R = renderView(st, w, h, b / 2, conv);
    end(st);
    const out = composeStereo(L, R, layout);
    const tag = { sbs: 'SBS', cross: 'cross', tb: 'TB', anaglyph: 'anaglyph' }[layout] || layout;
    download(await toBlob(out, mime(), 0.93), baseName() + '_stereo_' + tag + ext());
    hint(t('Стерео збережено', 'Stereo image saved'), 1800);
  } catch (e) { end(st); throw e; }
  finally { busy = false; }
}

/* ═══════════ 360° panorama (mono or ODS stereo) ═══════════ */
const FACE_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_UPS = [[0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, 1, 0]];
const FACE_FOV = 92;                       // a little over 90°: linear filtering never reaches a face border

const COMBINE_FS = `
uniform sampler2D uA, uB; uniform float uExp;
varying vec2 vUv;
vec3 RRTAndODTFit(vec3 v){ vec3 a = v*(v + 0.0245786) - 0.000090537; vec3 b = v*(0.983729*v + 0.4329510) + 0.238081; return a/b; }
vec3 aces(vec3 c){
  const mat3 I = mat3(vec3(0.59719,0.07600,0.02840), vec3(0.35458,0.90834,0.13383), vec3(0.04823,0.01566,0.83777));
  const mat3 O = mat3(vec3(1.60475,-0.10208,-0.00327), vec3(-0.53108,1.10813,-0.07276), vec3(-0.07367,-0.00605,1.07602));
  c *= uExp/0.6; c = I*c; c = RRTAndODTFit(c); c = O*c; return clamp(c, 0.0, 1.0);
}
vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main(){
  vec3 a = texture2D(uA, vUv).rgb;                 // panorama: already display-encoded
  vec4 b = texture2D(uB, vUv);                     // objects: linear, premultiplied by alpha
  float al = clamp(b.a, 0.0, 1.0);
  vec3 o = al > 0.0001 ? srgb(aces(b.rgb/al)) : vec3(0.0);
  gl_FragColor = vec4(mix(a, o, al), 1.0);
}`;

const EQUI_FS = `
uniform sampler2D uF0, uF1, uF2, uF3, uF4, uF5, uC0, uC1, uC2, uC3, uC4, uC5;
uniform mat4 uVP[6];
uniform float uMono, uLat0, uLat1;
varying vec2 vUv;
` + GLSL_COMMON + `
int faceOf(vec3 d){
  vec3 a = abs(d);
  if(a.x >= a.y && a.x >= a.z) return d.x > 0.0 ? 0 : 1;
  if(a.y >= a.z) return d.y > 0.0 ? 2 : 3;
  return d.z > 0.0 ? 4 : 5;
}
vec2 faceUv(int f, vec3 d){ vec4 c = uVP[f]*vec4(d, 1.0); return c.xy/c.w*0.5 + 0.5; }
vec3 eyeSet(int f, vec2 t){
  if(f == 0) return texture2D(uF0, t).rgb; if(f == 1) return texture2D(uF1, t).rgb;
  if(f == 2) return texture2D(uF2, t).rgb; if(f == 3) return texture2D(uF3, t).rgb;
  if(f == 4) return texture2D(uF4, t).rgb; return texture2D(uF5, t).rgb;
}
vec3 centreSet(int f, vec2 t){
  if(f == 0) return texture2D(uC0, t).rgb; if(f == 1) return texture2D(uC1, t).rgb;
  if(f == 2) return texture2D(uC2, t).rgb; if(f == 3) return texture2D(uC3, t).rgb;
  if(f == 4) return texture2D(uC4, t).rgb; return texture2D(uC5, t).rgb;
}
void main(){
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);              // image convention: v = 0 at the top
  vec3 d = uvToDir(uv);
  int f = faceOf(d); vec2 t = faceUv(f, d);
  vec3 c = centreSet(f, t);
  if(uMono < 0.5){
    // ODS fades to a single viewpoint towards the poles, where left and right are undefined
    float w = smoothstep(uLat0, uLat1, abs(0.5 - uv.y)*3.14159265);
    c = mix(eyeSet(f, t), c, w);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

function faceCams() {
  return FACE_DIRS.map((d, i) => {
    const c = new THREE.PerspectiveCamera(FACE_FOV, 1, 0.02, D_FAR * 4);
    c.up.fromArray(FACE_UPS[i]);
    c.lookAt(new THREE.Vector3().fromArray(d));
    c.updateProjectionMatrix();
    return c;
  });
}
/* projection × rotation, without translation: maps a direction to a face position */
function faceVP(c) {
  const R = new THREE.Matrix4().makeRotationFromQuaternion(c.quaternion).invert();
  return new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, R);
}
function rt(size, opts) {
  const r = new THREE.WebGLRenderTarget(size, size, Object.assign({
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false
  }, opts || {}));
  return r;
}
function halfFloatOK() {
  const gl = renderer.getContext();
  return !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
}
export function pano360Available() { return S.kind !== 'photo' && !!(panoMesh && (panoMesh.visible || S.panoMode === 'sphere')); }

export async function exportPano360(mode = X.pano, width = X.panoW, progress) {
  if (busy) return;
  if (!pano360Available()) { hint(t('360° експорт доступний для панорам.', '360° export is for panoramas.'), 2400); return; }
  const stereo = mode === 'stereo';
  if (stereo && S.panoMode !== 'mesh') { hint(t('Стерео 360° потребує карти глибини.', 'Stereo 360° needs a depth map.'), 2400); return; }
  busy = true;
  const st = begin();
  const W = Math.min(Math.round(width / 8) * 8, glLimits() * 2), H = W / 2;
  const face = Math.min(glLimits(), Math.ceil(W / 4 * Math.tan(FACE_FOV * DEG / 2) / 8) * 8);
  const samples = face <= 1200 ? 4 : 0;
  const fp = halfFloatOK();
  const tA = rt(face, { depthBuffer: true, samples });
  const tB = rt(face, { depthBuffer: true, samples, type: fp ? THREE.HalfFloatType : THREE.UnsignedByteType, colorSpace: THREE.LinearSRGBColorSpace });
  const centre = [0, 1, 2, 3, 4, 5].map(() => rt(face));
  const eyeF = stereo ? [0, 1, 2, 3, 4, 5].map(() => rt(face)) : centre;
  const out = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, colorSpace: THREE.NoColorSpace, depthBuffer: false, generateMipmaps: false });
  const cams = faceCams();
  const rig = new THREE.Group(); cams.forEach(c => rig.add(c)); world.add(rig);
  const combine = new THREE.ShaderMaterial({ uniforms: { uA: { value: null }, uB: { value: null }, uExp: { value: renderer.toneMappingExposure } }, vertexShader: PASS_VS, fragmentShader: COMBINE_FS, depthTest: false, depthWrite: false });
  const U = { uVP: { value: cams.map(faceVP) }, uMono: { value: stereo ? 0 : 1 }, uLat0: { value: 62 * DEG }, uLat1: { value: 84 * DEG } };
  for (let i = 0; i < 6; i++) { U['uF' + i] = { value: eyeF[i].texture }; U['uC' + i] = { value: centre[i].texture }; }
  const equi = new THREE.ShaderMaterial({ uniforms: U, vertexShader: PASS_VS, fragmentShader: EQUI_FS, depthTest: false, depthWrite: false });
  const vis = { pano: panoMesh.visible, pre: panoPre.visible, sph: sphereL.visible, objs: objectsRoot.visible };
  const sm = renderer.shadowMap.autoUpdate;
  const ipd = 0.064 * ((S.camH || 2) / 1.6) * X.strength;
  const canvases = [];
  try {
    renderer.setPixelRatio(1);
    renderer.shadowMap.autoUpdate = false;
    // One face: panorama pass → tA, objects pass → tB (linear HDR over the panorama depth), combine → dst
    const renderFace = (i, dst) => {
      const c = cams[i];
      panoMesh.visible = vis.pano; panoPre.visible = vis.pre; sphereL.visible = vis.sph; objectsRoot.visible = false;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(tA); renderer.clear(); renderer.render(scene, c);
      panoMesh.visible = false; panoPre.visible = vis.pano; sphereL.visible = false; objectsRoot.visible = vis.objs;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(tB); renderer.clear(); renderer.render(scene, c);
      combine.uniforms.uA.value = tA.texture; combine.uniforms.uB.value = tB.texture;
      runPass(combine, dst);
    };
    const place = p => { rig.position.copy(p); rig.updateMatrixWorld(true); };
    // Centre cube (mono, and the poles of stereo)
    panoUniforms.uEyeA.value = 0;
    place(new THREE.Vector3());
    for (let i = 0; i < 6; i++) renderFace(i, centre[i]);
    const eyes = stereo ? [-1, 1] : [0];
    const N = stereo ? clamp(Math.round(W / 64), 24, 128) : 1;
    let done = 0;
    for (const eye of eyes) {
      out.scissorTest = false;
      if (!stereo) { runPass(equi, out); }
      else {
        panoUniforms.uEyeA.value = ipd / 2;
        for (let k = 0; k < N; k++) {
          const lon = ((k + 0.5) / N - 0.5) * 2 * Math.PI;
          const right = new THREE.Vector3(Math.cos(lon), 0, Math.sin(lon));
          place(right.multiplyScalar(eye * ipd / 2));
          // side faces whose ±45° (+margin) longitude span meets this slice, plus top and bottom
          const half = Math.PI / N + 2 * DEG;
          const need = [2, 3];
          [[0, 90], [1, -90], [4, 180], [5, 0]].forEach(([fi, c]) => {
            let dl = Math.abs(((lon - c * DEG) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
            if (dl < Math.PI / 4 + half) need.push(fi);
          });
          for (const i of need) renderFace(i, eyeF[i]);
          const x0 = Math.round(k * W / N), x1 = Math.round((k + 1) * W / N);
          out.scissor.set(x0, 0, x1 - x0, H); out.scissorTest = true;
          runPass(equi, out);
          done++;
          if (k % 4 === 3) { progress && progress(done / (N * eyes.length)); await nextFrame(); }
        }
      }
      canvases.push(readOut(out, W, H));
    }
  } finally {
    panoMesh.visible = vis.pano; panoPre.visible = vis.pre; sphereL.visible = vis.sph; objectsRoot.visible = vis.objs;
    renderer.shadowMap.autoUpdate = sm;
    world.remove(rig);
    [tA, tB, out, ...centre, ...(stereo ? eyeF : [])].forEach(r => r.dispose());
    combine.dispose(); equi.dispose();
    end(st);
    busy = false;
  }
  let img = canvases[0];
  if (stereo) { img = canvas2D(W, H * 2); const g = img.getContext('2d'); g.drawImage(canvases[0], 0, 0); g.drawImage(canvases[1], 0, H); }
  let blob = await toBlob(img, 'image/jpeg', 0.92);
  if (!stereo) blob = await withGPano(blob, W, H);
  download(blob, baseName() + (stereo ? '_360_stereo_TB.jpg' : '_360.jpg'));
  hint(t('360° збережено', '360° image saved'), 2000);
}
/* Read a render target into a canvas, flipping rows (GL rows run bottom-up), in strips */
function readOut(target, W, H) {
  const c = canvas2D(W, H), g = c.getContext('2d');
  const strip = Math.max(1, Math.min(H, Math.floor(16e6 / (W * 4))));
  const buf = new Uint8Array(W * strip * 4);
  for (let y = 0; y < H; y += strip) {
    const h = Math.min(strip, H - y);
    renderer.readRenderTargetPixels(target, 0, y, W, h, buf);
    const im = g.createImageData(W, h), o = im.data, row = W * 4;
    for (let j = 0; j < h; j++) o.set(buf.subarray((h - 1 - j) * row, (h - j) * row), j * row);
    g.putImageData(im, 0, H - y - h);
  }
  return c;
}
/* Insert Google Photo Sphere XMP so viewers (Google Photos, Facebook, Kuula…) show it as 360° */
async function withGPano(blob, W, H) {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" ' +
    'GPano:UsePanoramaViewer="True" GPano:FullPanoWidthPixels="' + W + '" GPano:FullPanoHeightPixels="' + H + '" ' +
    'GPano:CroppedAreaImageWidthPixels="' + W + '" GPano:CroppedAreaImageHeightPixels="' + H + '" ' +
    'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/></rdf:RDF></x:xmpmeta>';
  const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmp);
  const src = new Uint8Array(await blob.arrayBuffer());
  if (src[0] !== 0xFF || src[1] !== 0xD8) return blob;
  const len = head.length + 2, seg = new Uint8Array(4 + head.length);
  seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = len >> 8; seg[3] = len & 255; seg.set(head, 4);
  return new Blob([src.subarray(0, 2), seg, src.subarray(2)], { type: 'image/jpeg' });
}

/* ═══════════ video ═══════════ */
const REC = { rec: null, chunks: [], timer: 0 };
function videoType() {
  const c = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return (window.MediaRecorder && c.find(x => MediaRecorder.isTypeSupported(x))) || '';
}
export function videoAvailable() { return !!(window.MediaRecorder && renderer.domElement.captureStream); }
export function recording() { return !!REC.rec; }
export function stopVideo() { if (REC.rec && REC.rec.state !== 'inactive') REC.rec.stop(); }
export async function recordVideo(loops = X.loops) {
  if (REC.rec || busy) return;
  if (!videoAvailable()) { hint(t('Запис відео не підтримується цим браузером.', 'This browser cannot record video.'), 2600); return; }
  const type = videoType();
  const stream = renderer.domElement.captureStream(30);
  const rec = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 14e6 }, type ? { mimeType: type } : {}));
  REC.rec = rec; REC.chunks = [];
  const hidden = [];
  scene.traverse(o => { if (o.userData && o.userData.noExport && o.visible) { o.visible = false; hidden.push(o); } });
  // One loop = an elliptical sweep of the viewpoint (6.5 s), like the photo Orbit
  const T = 6.5, dur = T * loops;
  let tm = 0;
  const keep = { autoRot: S.autoRot };
  S.autoRot = false;
  S.recMotion = dt => {
    tm += dt;
    const a = 2 * Math.PI * tm / T;
    if (S.kind === 'photo') { S.autoVel = 0.06; }
    else { S.tTilt.x = Math.sin(a) * 0.9; S.tTilt.y = Math.cos(a) * 0.38; }
  };
  if (S.kind === 'photo') PH.orbit = 0;
  document.body.classList.add('recording');
  rec.ondataavailable = e => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  const done = new Promise(ok => { rec.onstop = ok; });
  rec.start(500);
  emit('record-start');
  REC.timer = setTimeout(stopVideo, dur * 1000 + 150);
  await done;
  clearTimeout(REC.timer);
  stream.getTracks().forEach(tr => tr.stop());
  S.recMotion = null; S.autoRot = keep.autoRot; if (S.kind === 'photo') S.autoVel = 0;
  hidden.forEach(o => { o.visible = true; });
  document.body.classList.remove('recording');
  REC.rec = null;
  emit('record-end');
  const blob = new Blob(REC.chunks, { type: (type || 'video/webm').split(';')[0] });
  showHUD();
  if (!blob.size) {             // the encoder could not keep up (software encoding, very large canvas)
    hint(t('Відео не записалося: кодер не встиг. Спробуйте менше вікно.', 'No video was recorded: the encoder could not keep up. Try a smaller window.'), 5000);
    return;
  }
  download(blob, baseName() + (blob.type === 'video/mp4' ? '.mp4' : '.webm'));
}

/* ═══════════ panel ═══════════ */
function seg(id, key, conv = v => v) {
  const box = $(id); if (!box) return;
  const sync = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(X[key]) === b.dataset.v));
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); X[key] = conv(b.dataset.v); saveX(); sync(); syncPanel(); }));
  sync();
}
export function syncPanel() {
  const photo = S.kind === 'photo';
  $('exPano').hidden = photo;
  const sOK = stereoAvailable();
  $('exStereoBtn').disabled = !sOK;
  $('exStereoNote').hidden = sOK;
  const [w, h] = viewSize(X.size);
  $('exSizeOut').textContent = w + ' × ' + h;
  $('exPanoBtn').disabled = !pano360Available() || (X.pano === 'stereo' && S.panoMode !== 'mesh');
  $('exPanoOut').textContent = X.pano === 'stereo' ? X.panoW + ' × ' + X.panoW + ' (TB)' : X.panoW + ' × ' + X.panoW / 2;
  $('exVideoBtn').disabled = !videoAvailable();
  $('exDepthBtn').disabled = !S.depthReady;
  $('oStrength').textContent = X.strength.toFixed(2) + '×';
}
export function toggleExportPanel(force) {
  const p = $('exportPanel'), open = force != null ? force : p.hidden;
  if (open) syncPanel();
  p.hidden = !open;
  $('exBtn').setAttribute('aria-expanded', open);
  if (open) emit('popover-open', 'export');
}
const guard = fn => async e => {
  e && e.stopPropagation();
  toggleExportPanel(false);
  try { await fn(); } catch (err) { console.error(err); hint(t('Помилка експорту: ', 'Export failed: ') + (err.message || err), 5000); }
};
export function initExport() {
  seg('exSize', 'size'); seg('exFmt', 'fmt'); seg('exLayout', 'stereo'); seg('exPanoMode', 'pano'); seg('exPanoW', 'panoW', v => +v); seg('exLoops', 'loops', v => +v);
  const sl = $('sStrength');
  sl.value = Math.round(Math.log2(X.strength) * 50 + 100);
  sl.addEventListener('input', () => { X.strength = Math.pow(2, (sl.value - 100) / 50); saveX(); syncPanel(); });
  $('exImageBtn').addEventListener('click', guard(() => exportImage()));
  $('exStereoBtn').addEventListener('click', guard(() => exportStereo()));
  $('exPanoBtn').addEventListener('click', guard(async () => {
    const b = $('busy'); b.classList.add('on'); $('busyTitle').textContent = t('Рендер 360°', 'Rendering 360°'); $('busyStep').textContent = '';
    try { await exportPano360(X.pano, X.panoW, p => { $('busyStep').textContent = Math.round(p * 100) + ' %'; }); }
    finally { b.classList.remove('on'); }
  }));
  $('exVideoBtn').addEventListener('click', guard(() => recordVideo()));
  $('exDepthBtn').addEventListener('click', guard(() => downloadDepthPNG()));
  $('exBtn').addEventListener('click', e => { e.stopPropagation(); toggleExportPanel(); });
  document.addEventListener('pointerdown', e => {
    if (!$('exportPanel').hidden && !e.target.closest('#exportPanel,#exBtn')) toggleExportPanel(false);
  });
  $('recStop').addEventListener('click', e => { e.stopPropagation(); stopVideo(); });
  window.__n3dExport = { exportImage, exportStereo, exportPano360, recordVideo, X };
}
