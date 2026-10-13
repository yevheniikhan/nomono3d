// Panorama back layer (CPU): the background extended behind foreground objects (depth and colour),
// plus the split of grid cells between layers (1024×512 or 512×256 grid, see GRID in gfx.js).
//
// The idea follows Layered Depth Images / "3D photos": when the viewpoint shifts, a trunk
// reveals a strip of whatever was behind it. Rather than stretching the trunk out to the
// background ("rubber sheet"), the front layer tears at that point and the back layer shows through:
// background at its own depth (pull-push from neighbouring background), with its colour mirrored
// from the edge of the tear (sharp grass, needle or sky texture instead of a blurry smear).
// The fine level (mask, mirror) runs at the resolution of the CPU depth copy, up to 2048×1024.
import { THREE, GRID, panoUniforms, setPanoLayers } from './gfx.js';
import { S } from './state.js';

export const BG_REACH_DEG = 11.25;   // how many degrees past a depth jump the background is extended behind a foreground object

let bgDepthTex = null, bgColorTex = null, bgFarTex = null, bgMirTex = null;
export function disposeLayers() {
  for (const t of [bgDepthTex, bgColorTex, bgFarTex, bgMirTex]) if (t) t.dispose();
  bgDepthTex = bgColorTex = bgFarTex = bgMirTex = null;
  panoUniforms.uBgDepth.value = null; panoUniforms.uBgColor.value = null; panoUniforms.uBgFar.value = null; panoUniforms.uBgMir.value = null;
  setPanoLayers(null);
}

/* Sliding-window minimum / maximum over [x−R, x+R], first along rows (wrapping in longitude),
   then along columns (edge values are clamped at the poles). van Herk / Gil-Werman algorithm:
   three operations per element regardless of R. */
export function filter2D(a, W, H, R, isMax, Ry = R, wrapX = true) {
  const tmp = new Float32Array(a.length), out = new a.constructor(a.length);
  const RM = Math.max(R, Ry), L = Math.max(W, H) + 2 * RM, ext = new Float32Array(L), g = new Float32Array(L), h = new Float32Array(L);
  let k = 2 * R + 1;
  const pass = (src, dst, n, stride, off, wrap, R) => {
    const len = n + 2 * R;
    for (let e = 0; e < len; e++) {
      let x = e - R;
      x = wrap ? (x < 0 ? x + n * Math.ceil(-x / n) : x % n) : (x < 0 ? 0 : x >= n ? n - 1 : x);
      ext[e] = src[off + x * stride];
    }
    if (isMax) {
      for (let e = 0; e < len; e++) g[e] = (e % k === 0) ? ext[e] : (ext[e] > g[e - 1] ? ext[e] : g[e - 1]);
      for (let e = len - 1; e >= 0; e--) h[e] = (e === len - 1 || (e + 1) % k === 0) ? ext[e] : (ext[e] > h[e + 1] ? ext[e] : h[e + 1]);
      for (let x = 0; x < n; x++) { const a1 = h[x], a2 = g[x + 2 * R]; dst[off + x * stride] = a1 > a2 ? a1 : a2; }
    } else {
      for (let e = 0; e < len; e++) g[e] = (e % k === 0) ? ext[e] : (ext[e] < g[e - 1] ? ext[e] : g[e - 1]);
      for (let e = len - 1; e >= 0; e--) h[e] = (e === len - 1 || (e + 1) % k === 0) ? ext[e] : (ext[e] < h[e + 1] ? ext[e] : h[e + 1]);
      for (let x = 0; x < n; x++) { const a1 = h[x], a2 = g[x + 2 * R]; dst[off + x * stride] = a1 < a2 ? a1 : a2; }
    }
  };
  for (let j = 0; j < H; j++) pass(a, tmp, W, 1, j * W, wrapX, R);
  k = 2 * Ry + 1;
  for (let i = 0; i < W; i++) pass(tmp, out, H, W, i, false, Ry);
  return out;
}

/* Pull-push (Gortler et al.): fills zero-weight pixels with a smooth continuation of the
   neighbouring weight-1 pixels. chans: arrays that are modified in place. */
export function pullPush(W, H, chans, w0, wrapX = true) {
  const levels = [{ W, H, c: chans, w: w0 }];
  while (levels[levels.length - 1].W > 4 && levels[levels.length - 1].H > 2) {
    const L = levels[levels.length - 1], W2 = L.W >> 1, H2 = L.H >> 1, n2 = W2 * H2;
    const c2 = chans.map(() => new Float32Array(n2)), w2 = new Float32Array(n2), acc = new Float64Array(chans.length);
    for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
      let sw = 0; acc.fill(0);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (2 * y + dy) * L.W + 2 * x + dx, wi = L.w[i];
        if (wi > 0) { sw += wi; for (let k = 0; k < chans.length; k++) acc[k] += wi * L.c[k][i]; }
      }
      const o = y * W2 + x;
      if (sw > 0) for (let k = 0; k < chans.length; k++) c2[k][o] = acc[k] / sw;
      w2[o] = Math.min(1, sw);
    }
    levels.push({ W: W2, H: H2, c: c2, w: w2 });
  }
  // coarsest level: empty pixels take the mean of the filled ones
  const top = levels[levels.length - 1];
  const mean = chans.map(() => 0); let sw = 0;
  for (let i = 0; i < top.W * top.H; i++) if (top.w[i] > 0) { sw += top.w[i]; for (let k = 0; k < chans.length; k++) mean[k] += top.w[i] * top.c[k][i]; }
  for (let i = 0; i < top.W * top.H; i++) if (top.w[i] < 1) {
    for (let k = 0; k < chans.length; k++) top.c[k][i] = top.w[i] * top.c[k][i] + (1 - top.w[i]) * (sw > 0 ? mean[k] / sw : 0);
    top.w[i] = 1;
  }
  // push: top down, bilinear from the coarser level (wrapping in longitude)
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], C = levels[l + 1];
    for (let y = 0; y < L.H; y++) {
      const fy = Math.min(Math.max((y + 0.5) / 2 - 0.5, 0), C.H - 1), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, C.H - 1), ty = fy - y0;
      for (let x = 0; x < L.W; x++) {
        const i = y * L.W + x, wi = L.w[i];
        if (wi >= 1) continue;
        const fx = (x + 0.5) / 2 - 0.5, x0f = Math.floor(fx), tx = fx - x0f;
        const x0 = wrapX ? ((x0f % C.W) + C.W) % C.W : Math.min(Math.max(0, x0f), C.W - 1);
        const x1 = wrapX ? (x0 + 1) % C.W : Math.min(Math.max(0, x0f + 1), C.W - 1);
        const a = y0 * C.W + x0, b = y0 * C.W + x1, c = y1 * C.W + x0, d = y1 * C.W + x1;
        for (let k = 0; k < chans.length; k++) {
          const ch = C.c[k];
          const v = (ch[a] * (1 - tx) + ch[b] * tx) * (1 - ty) + (ch[c] * (1 - tx) + ch[d] * tx) * ty;
          L.c[k][i] = wi * L.c[k][i] + (1 - wi) * v;
        }
        L.w[i] = 1;
      }
    }
  }
}

/* Mirrored continuation of the background into a "hole" (a texel behind a foreground object):
   for each hole texel, an offset to the background texel mirrored about the hole edge.
   The direction (horizontal or vertical) in which the hole is narrower is used: behind a vertical
   trunk the background continues sideways, behind a branch up/down. Mirroring gives sharp texture
   (grass, needles, sky) instead of a blurry smear, without repeating stripes. */
const MIRROR_GAP = 1;       // the first background texel at the edge may contain the object's edge, so skip it
/* For each hole texel: the mirror axis (absolute longitude coordinate, in texels) and the
   largest distance from the axis that still lies on background (to avoid hitting a neighbouring object).
   Mirroring is horizontal only: trunks, poles and building corners are vertical, and this keeps
   the horizon and height above ground intact. The shader computes the reflection at full resolution. */
function mirrorAxes(W, H, hole, maxLim) {
  const N = W * H, axis = new Float32Array(N), lim = new Uint8Array(N), has = new Uint8Array(N);
  const G = MIRROR_GAP;
  for (let j = 0; j < H; j++) {
    const row = j * W;
    let start = -1;
    for (let i = 0; i < W; i++) if (!hole[row + i]) { start = i; break; }
    if (start < 0) continue;                                   // the whole row is a hole
    let i = 0;
    while (i < W) {
      if (!hole[row + (start + i) % W]) { i++; continue; }
      let n = 0; while (n < W && hole[row + (start + i + n) % W]) n++;   // hole [i, i+n)
      let lv = 0; while (lv < maxLim && !hole[row + (((start + i - 1 - lv) % W) + W) % W]) lv++;
      let rv = 0; while (rv < maxLim && !hole[row + (start + i + n + rv) % W]) rv++;
      const gl = Math.min(G, lv - 1), gr = Math.min(G, rv - 1);
      const x0 = (start + i) % W, x1 = (start + i + n) % W;          // left and right edges (texel boundaries)
      const aL = ((x0 - gl / 2) % W + W) % W, aR = (x1 + gr / 2) % W;
      const limL = Math.max(0.5, lv - gl / 2), limR = Math.max(0.5, rv - gr / 2);
      for (let k = 0; k < n; k++) {
        const p = row + (start + i + k) % W;
        if (k + 1 <= n - k) { axis[p] = aL; lim[p] = Math.min(255, Math.round(limL)); }
        else { axis[p] = aR; lim[p] = Math.min(255, Math.round(limR)); }
        has[p] = 1;
      }
      i += n;
    }
  }
  // Neighbouring rows share almost the same axis (trunk edges are vertical): a median over ±3 rows
  // removes "steps" in the mirrored texture caused by a ragged mask edge.
  const ax2 = axis.slice(), lim2 = lim.slice(), win = [];
  for (let x = 0; x < W; x++) for (let j = 0; j < H; j++) {
    const p = j * W + x; if (!has[p]) continue;
    win.length = 0;
    let lm = lim[p];
    for (let d = -3; d <= 3; d++) {
      const y = j + d; if (y < 0 || y >= H) continue;
      const q = y * W + x; if (!has[q]) continue;
      let da = axis[q] - axis[p]; da -= W * Math.round(da / W);
      if (Math.abs(da) > 6) continue;                          // a different edge: do not mix
      win.push(axis[p] + da); if (lim[q] < lm) lm = lim[q];
    }
    win.sort((a, b) => a - b);
    ax2[p] = ((win[win.length >> 1] % W) + W) % W; lim2[p] = lm;
  }
  return { axis: ax2, lim: lim2, has };
}

function enc16(v, out, o) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  const a = Math.floor(v * 255);
  out[o] = a; out[o + 1] = Math.min(255, Math.round((v * 255 - a) * 255));
}
function dataTex(data, W, H, nearest) {
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false; t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  const fl = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = fl; t.magFilter = fl; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/* flags: per-cell flags from the GPU (1 = the cell contains a depth jump > tau); tau: threshold in dn.
   Fine level (CPU depth copy resolution, up to 2048): hole mask, far-side depth and
   mirror offsets, which determine edge sharpness. Coarse level (1024 grid):
   pull-push of background colour and depth, cell assignment. */
export function buildLayers(flags, tau) {
  const W = GRID.w, H = GRID.h, N = W * H;
  const D = S.depthCPU;
  if (!D || !S.small || !flags) { disposeLayers(); return null; }
  const t0 = performance.now();
  const CW = D.w, CH = D.h, CN = CW * CH, f = Math.max(1, Math.round(CW / W));
  // ── fine level ──
  const dn = D.dn;
  const near3 = filter2D(dn, CW, CH, 1, true);
  const FAR_NONE = 2, E = new Float32Array(CN);
  for (let p = 0; p < CN; p++) E[p] = near3[p] - dn[p] > tau ? dn[p] : FAR_NONE;   // far side of the jump
  // Search for the far side along the row (mirroring is also along the row) and only slightly vertically:
  // otherwise nearby ground would "see" distant ground higher up the frame and count as an object.
  const reach = Math.max(4, Math.round(CW * BG_REACH_DEG / 360));
  const far = filter2D(E, CW, CH, reach, false, Math.max(2, f));
  const hole = new Uint8Array(CN);
  let holes = 0;
  for (let p = 0; p < CN; p++) if (far[p] < 1.5 && dn[p] - far[p] > tau) { hole[p] = 1; holes++; }
  // One-texel ring around holes: the boundary on the CPU copy (up to 2048) is coarser than the
  // map's full resolution, so the mirror must also be defined for edge texels
  const holeR = filter2D(hole, CW, CH, 1, true);
  const M = mirrorAxes(CW, CH, holeR, 160);
  const fine = new Uint8Array(CN * 4), mir = new Uint8Array(CN * 4);
  for (let p = 0; p < CN; p++) {
    const o = 4 * p;
    enc16(far[p] < 1.5 ? far[p] : dn[p], fine, o);
    fine[o + 3] = 255;
    if (M.has[p]) { enc16(M.axis[p] / CW, mir, o); mir[o + 2] = M.lim[p]; mir[o + 3] = 255; }
  }
  // ── coarse level (grid) ──
  const lo = new Float32Array(N), wgt = new Float32Array(N);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let mn = 1, h = 0;
    for (let b = 0; b < f; b++) {
      const row = Math.min(CH - 1, j * f + b) * CW;
      for (let a = 0; a < f; a++) { const q = row + Math.min(CW - 1, i * f + a); if (dn[q] < mn) mn = dn[q]; h |= holeR[q]; }
    }
    lo[j * W + i] = mn; wgt[j * W + i] = h ? 0 : 1;
  }
  let small = S.small;
  if (small.width !== W || small.height !== H) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(small, 0, 0, W, H); small = c; }
  const img = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), Z = new Float32Array(N);
  for (let p = 0; p < N; p++) { R[p] = img[4 * p]; G[p] = img[4 * p + 1]; B[p] = img[4 * p + 2]; Z[p] = lo[p]; }
  pullPush(W, H, [R, G, B, Z], wgt.slice());
  const dep = new Uint8Array(N * 4), col = new Uint8Array(N * 4), dnB = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const o = 4 * p;
    dnB[p] = wgt[p] > 0 ? lo[p] : Math.min(Z[p], lo[p]);              // background is never nearer than its own depth
    enc16(dnB[p], dep, o);
    dep[o + 2] = 0; dep[o + 3] = 255;
    if (wgt[p] > 0) { col[o] = img[o]; col[o + 1] = img[o + 1]; col[o + 2] = img[o + 2]; }
    else { col[o] = R[p]; col[o + 1] = G[p]; col[o + 2] = B[p]; }
    col[o + 3] = 255;
  }
  for (const t of [bgDepthTex, bgColorTex, bgFarTex, bgMirTex]) if (t) t.dispose();
  bgDepthTex = dataTex(dep, W, H); bgColorTex = dataTex(col, W, H); bgFarTex = dataTex(fine, CW, CH);
  bgMirTex = dataTex(mir, CW, CH, true);
  panoUniforms.uBgDepth.value = bgDepthTex; panoUniforms.uBgColor.value = bgColorTex;
  panoUniforms.uBgFar.value = bgFarTex; panoUniforms.uBgMir.value = bgMirTex;
  panoUniforms.uFineSize.value.set(CW, CH);
  // ── cells: edge cells (with discard) within 2 cells of a jump; background cells only where
  //    the background can become visible: edge cells and cells with holes (+1 cell margin) ──
  const edgeM = filter2D(flags, W, H, 2, true);
  const need = new Uint8Array(N);
  for (let p = 0; p < N; p++) need[p] = (edgeM[p] || wgt[p] === 0) ? 1 : 0;
  const bgM = filter2D(need, W, H, 1, true);
  // background cells with their own depth jump (canopy/sky), with per-texel discard
  const bHi = filter2D(dnB, W, H, 1, true), bLo = filter2D(dnB, W, H, 1, false);
  let nE = 0, nB = 0, nBE = 0;
  for (let p = 0; p < N; p++) {
    if (edgeM[p]) nE++;
    if (bgM[p]) { if (bHi[p] - bLo[p] > tau) nBE++; else nB++; }
  }
  const plain = new Uint32Array(N - nE), edge = new Uint32Array(nE), bg = new Uint32Array(nB), bgEdge = new Uint32Array(nBE);
  let a = 0, b = 0, c = 0, d = 0;
  for (let p = 0; p < N; p++) {
    if (edgeM[p]) edge[b++] = p; else plain[a++] = p;
    if (bgM[p]) { if (bHi[p] - bLo[p] > tau) bgEdge[d++] = p; else bg[c++] = p; }
  }
  setPanoLayers({ plain, edge, bg, bgEdge });
  const ms = performance.now() - t0;
  S.layerStats = { ms: Math.round(ms), edgeCells: nE, bgCells: nB, bgEdgeCells: nBE, holes, tau: +tau.toFixed(4), fine: CW + 'x' + CH };
  return S.layerStats;
}
