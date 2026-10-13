// Render styles for 3D objects, with emphasis on models that have no textures
// (photogrammetry meshes, CAD exports, scans): procedural matcaps, an "enhance" shader chunk
// (rim light, sky/ground tint, cavity from screen-space curvature, height occlusion), toon,
// X-ray, technical edges and analysis views. Everything is generated in code: no downloads,
// cheap enough for phones and headsets.
import { THREE } from './gfx.js';

/* Styles offered in the editor. `look` groups them in the UI. */
export const STYLES = [
  ['natural', 'Natural', 'Original materials, lit by the image; untextured models get gentle shading cues'],
  ['clay', 'Clay', 'Matte warm grey with strong cavity shading: shows the form'],
  ['studio', 'Studio', 'Neutral studio matcap: clean inspection light, independent of the scene'],
  ['porcelain', 'Porcelain', 'Glossy white matcap'],
  ['bronze', 'Bronze', 'Polished metal reflecting the panorama'],
  ['jade', 'Jade', 'Soft translucent-looking green stone'],
  ['technical', 'Technical', 'Light grey with feature edges, like a CAD drawing'],
  ['toon', 'Toon', 'Three-step cartoon shading'],
  ['xray', 'X-ray', 'Glassy silhouette that shows through what hides it'],
  ['hologram', 'Hologram', 'Animated scan lines and glow'],
  ['wire', 'Wireframe', 'Triangle edges only'],
  ['normals', 'Normals', 'Surface orientation in colour: reveals flipped faces'],
  ['height', 'Height', 'Colour ramp from base to top (trees, LiDAR)'],
  ['ghost', 'Ghost', 'Faint and see-through']
];

/* ═══════════ procedural matcaps ═══════════ */
const MATCAP_PRESETS = {
  studio: { base: [0.74, 0.75, 0.76], wrap: 0.25, spec: 0.35, shin: 30, rim: 0.30, rimCol: [0.9, 0.95, 1.0], amb: 0.30 },
  clay: { base: [0.80, 0.72, 0.64], wrap: 0.30, spec: 0.04, shin: 8, rim: 0.10, rimCol: [1.0, 0.9, 0.8], amb: 0.28 },
  porcelain: { base: [0.95, 0.95, 0.93], wrap: 0.15, spec: 0.9, shin: 120, rim: 0.25, rimCol: [0.8, 0.88, 1.0], amb: 0.45 },
  jade: { base: [0.30, 0.62, 0.45], wrap: 0.8, spec: 0.6, shin: 80, rim: 0.35, rimCol: [0.7, 1.0, 0.8], amb: 0.25 },
  bronze: { base: [0.72, 0.45, 0.20], metal: true, spec: 0.8, shin: 40, rim: 0.15, rimCol: [1.0, 0.8, 0.6], amb: 0.12 },
  graphite: { base: [0.22, 0.23, 0.25], metal: true, spec: 0.35, shin: 20, rim: 0.25, rimCol: [0.7, 0.8, 1.0], amb: 0.2 }
};
const matcapCache = new Map();
export function matcap(name) {
  if (matcapCache.has(name)) return matcapCache.get(name);
  const P = MATCAP_PRESETS[name] || MATCAP_PRESETS.studio, N = 256;
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), im = g.createImageData(N, N), d = im.data;
  const L = norm([-0.45, 0.6, 0.66]), H = norm([L[0], L[1], L[2] + 1]);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let x = (i + 0.5) / N * 2 - 1, y = 1 - (j + 0.5) / N * 2;
    const r = Math.hypot(x, y); if (r > 0.999) { x /= r * 1.001; y /= r * 1.001; }   // clamp to the disc
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    const ndl = x * L[0] + y * L[1] + z * L[2];
    let col;
    if (P.metal) {
      const ry = 2 * z * y;                                    // reflected vector, y component
      const env = ry > 0.05 ? 0.55 + 0.6 * ry : ry > -0.08 ? 1.35 : 0.12 + 0.15 * (1 + ry);   // sky, bright horizon, dark ground
      const sp = Math.pow(Math.max(0, x * H[0] + y * H[1] + z * H[2]), P.shin) * P.spec;
      col = P.base.map(b => b * (env + P.amb) + sp * b * 1.4);
    } else {
      const w = P.wrap || 0;
      const dif = Math.max(0, (ndl + w) / (1 + w));
      const sky = 0.5 + 0.5 * y;
      const sp = Math.pow(Math.max(0, x * H[0] + y * H[1] + z * H[2]), P.shin) * P.spec;
      col = P.base.map(b => b * (dif * 0.85 + P.amb * (0.6 + 0.4 * sky)) + sp);
    }
    const rim = Math.pow(1 - z, 3) * P.rim;
    for (let k = 0; k < 3; k++) {
      let v = col[k] + rim * P.rimCol[k];
      v = v / (1 + v) * 1.6;                                 // soft roll-off
      d[(j * N + i) * 4 + k] = Math.round(255 * Math.min(1, Math.pow(Math.max(0, v), 1 / 2.2)));
    }
    d[(j * N + i) * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  matcapCache.set(name, t);
  return t;
}
function norm(v) { const l = Math.hypot(...v); return v.map(x => x / l); }

/* ═══════════ enhance chunk for lit materials ═══════════ */
// Shared uniforms: one place to tune all enhanced materials.
export const ENH = {
  uRim: { value: 0.12 }, uRimPow: { value: 3.0 }, uRimCol: { value: new THREE.Color(0xdfe9ff) },
  uSky: { value: new THREE.Color(1.04, 1.04, 1.06) }, uGround: { value: new THREE.Color(0.86, 0.84, 0.80) },
  uCavity: { value: 0.45 }
};
/* Per-object height range in world space, kept up to date by objects.js (the object can move) */
export const heightUniforms = () => ({ uHMin: { value: 0 }, uHMax: { value: 1 } });
/* m: a lit Mesh*Material. opts: { cavity, hU: heightUniforms() for ground occlusion, curvScale } */
export function enhance(m, opts = {}) {
  const cavity = opts.cavity ?? ENH.uCavity.value, hU = opts.hU || heightUniforms();
  const curv = opts.curvScale || 1;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, {
      uRim: ENH.uRim, uRimPow: ENH.uRimPow, uRimCol: ENH.uRimCol, uSky: ENH.uSky, uGround: ENH.uGround,
      uCav: { value: cavity }, uCurv: { value: curv }, uHMin: hU.uHMin, uHMax: hU.uHMax, uHAO: { value: opts.hU ? 1 : 0 }
    });
    sh.vertexShader = 'varying vec3 vObjP;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vObjP = (modelMatrix*vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `uniform float uRim, uRimPow, uCav, uCurv, uHMin, uHMax, uHAO; uniform vec3 uRimCol, uSky, uGround; varying vec3 vObjP;\n`
      + sh.fragmentShader.replace('#include <opaque_fragment>', `
  {
    vec3 nV = normalize(normal);
    float NdV = clamp(dot(nV, normalize(vViewPosition)), 0.0, 1.0);
    vec3 wN = normalize((vec4(nV, 0.0) * viewMatrix).xyz);
    outgoingLight *= mix(uGround, uSky, wN.y*0.5 + 0.5);                 // sky above, ground bounce below
    // signed curvature from screen-space derivatives: concave creases get darker, ridges a touch lighter
    vec3 P = -vViewPosition;
    vec3 dpx = dFdx(P), dpy = dFdy(P), dnx = dFdx(nV), dny = dFdy(nV);
    float k = (dot(dnx, dpx) + dot(dny, dpy)) / max(dot(dpx, dpx) + dot(dpy, dpy), 1e-10);
    float ks = clamp(k*uCurv*0.05, -1.0, 1.0);
    outgoingLight *= 1.0 - uCav*max(-ks, 0.0);
    outgoingLight += outgoingLight*0.25*max(ks, 0.0)*uCav;
    if(uHAO > 0.5){ float h = clamp((vObjP.y - uHMin)/max(uHMax - uHMin, 1e-5), 0.0, 1.0); outgoingLight *= mix(0.62, 1.0, sqrt(h)); }
    outgoingLight += uRimCol*uRim*pow(1.0 - NdV, uRimPow);
  }
  #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'n3d-enh';
  return m;
}

/* Height ramp (analysis): colour from the object's base to its top, in world space */
export function heightMaterial(hU, side) {
  return new THREE.ShaderMaterial({
    uniforms: { uMin: hU.uHMin, uMax: hU.uHMax },
    vertexShader: `varying float vH; varying vec3 vN; uniform float uMin, uMax;
      #include <common>
      #include <skinning_pars_vertex>
      void main(){
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vH = clamp(((modelMatrix*vec4(transformed, 1.0)).y - uMin)/max(uMax - uMin, 1e-5), 0.0, 1.0); vN = normalize(normalMatrix*objectNormal);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(transformed, 1.0);
      }`,
    fragmentShader: `varying float vH; varying vec3 vN;
      vec3 ramp(float t){ return t < 0.5 ? mix(vec3(0.20,0.25,0.55), vec3(0.25,0.70,0.45), t*2.0) : mix(vec3(0.25,0.70,0.45), vec3(0.98,0.85,0.35), t*2.0 - 1.0); }
      void main(){ float l = 0.55 + 0.45*max(dot(normalize(vN), normalize(vec3(-0.3,0.6,0.7))), 0.0); gl_FragColor = vec4(ramp(vH)*l, 1.0); }`,
    side: side ?? THREE.FrontSide
  });
}

/* X-ray: fresnel glass; parts hidden behind the image are drawn by a second, fainter pass */
export function xrayMaterial(color, behind) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uK: { value: behind ? 0.45 : 1 } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      #include <common>
      #include <skinning_pars_vertex>
      void main(){
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vec4 mv = modelViewMatrix*vec4(transformed, 1.0); vN = normalize(normalMatrix*objectNormal); vV = -mv.xyz; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uK; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0); gl_FragColor = vec4(uColor*(0.25 + 1.2*f), (0.06 + 0.85*f)*uK); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    depthFunc: behind ? THREE.GreaterDepth : THREE.LessEqualDepth
  });
}

/* Three-step toon ramp */
let toonRamp = null;
export function toonGradient() {
  if (toonRamp) return toonRamp;
  toonRamp = new THREE.DataTexture(new Uint8Array([70, 70, 70, 255, 160, 160, 160, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter; toonRamp.generateMipmaps = false; toonRamp.needsUpdate = true;
  return toonRamp;
}

/* Is this material untextured (no colour map) and without per-vertex colour? */
export function isUntextured(mesh, mat) {
  const ms = Array.isArray(mat) ? mat : [mat];
  const hasMap = ms.some(m => m && (m.map || m.matcap));
  const hasVC = !!(mesh.geometry && mesh.geometry.attributes.color);
  return !hasMap && !hasVC;
}

/* Round, distance-attenuated points with a minimum on-screen size */
export function roundPoints(m) {
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n gl_PointSize = max(gl_PointSize, 1.6);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if(length(gl_PointCoord - 0.5) > 0.5) discard;');
  };
  m.customProgramCacheKey = () => 'n3d-round';
  return m;
}
