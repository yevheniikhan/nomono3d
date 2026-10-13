// AI depth estimation.
//   1. nomono3d server (Colab / any GPU box): DA360 for 360° panoramas, Depth Anything V2 for photos.
//   2. In-browser fallback for photos: Depth Anything V2 Small via transformers.js (WebGPU or WASM).
import { t, loadPref, savePref } from './state.js';

export const AI = { checked: false, server: null, browser: true, busy: false };

const TJS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
  'https://unpkg.com/@huggingface/transformers@3.8.1/dist/transformers.min.js'
];
const BROWSER_MODEL = 'onnx-community/depth-anything-v2-small';

/* Is a nomono3d server behind this page? (GET api/health) */
export async function detectServer() {
  if (AI.checked) return AI.server;
  AI.checked = true;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('api/health', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(tm);
    if (r.ok) {
      const j = await r.json();
      if (j && j.app === 'nomono3d') AI.server = j;
    }
  } catch (e) { }
  return AI.server;
}

/* Which engine will produce depth for this kind of image ('pano' | 'photo') */
export function engineFor(kind) {
  const s = AI.server;
  if (s && s.depth && s.depth[kind]) return { where: 'server', name: s.depth[kind] };
  if (kind === 'photo' && AI.browser) return { where: 'browser', name: 'Depth Anything V2 Small (in browser)' };
  return null;
}

/* blob: the image; kind: 'pano' | 'photo'; opts.librarySrc: library URL to store the result next to
   (server only). Resolves to a PNG blob: greyscale, white = near. */
export async function generateDepth(blob, kind, opts = {}, status) {
  const eng = engineFor(kind);
  if (!eng) throw new Error(t('Немає рушія для оцінки глибини.', 'No depth engine available.'));
  AI.busy = true;
  try {
    if (eng.where === 'server') return await serverDepth(blob, kind, opts, status);
    return await browserDepth(blob, status);
  } finally { AI.busy = false; }
}

async function serverDepth(blob, kind, opts, status) {
  status && status(t('надсилання на сервер', 'uploading to the server'));
  const fd = new FormData();
  fd.append('file', blob, opts.name || blob.name || 'image.jpg');
  fd.append('kind', kind);
  if (opts.librarySrc) fd.append('library_src', opts.librarySrc);
  let r = null;
  // 503 = the model is still loading on the server (the first use downloads it): wait and retry
  for (let i = 0; i < 160; i++) {
    status && status(t('нейромережа рахує глибину…', 'the network is estimating depth…'));
    r = await fetch('api/depth', { method: 'POST', body: fd });
    if (r.status !== 503) break;
    status && status(t('модель завантажується на сервері… ', 'the model is loading on the server… ') + (i + 1) * 5 + ' s');
    await new Promise(ok => setTimeout(ok, 5000));
  }
  if (!r.ok) {
    let msg = r.status + ' ' + r.statusText;
    try { const j = await r.json(); if (j.detail) msg = j.detail; } catch (e) { }
    throw new Error(msg);
  }
  const out = await r.blob();
  out.savedAs = r.headers.get('X-Depth-Saved') || null;
  return out;
}

let pipe = null;
async function browserDepth(blob, status) {
  if (!pipe) {
    status && status(t('завантаження моделі (~50 МБ, один раз)', 'downloading the model (~50 MB, once)'));
    let mod = null, err = null;
    for (const u of TJS) { try { mod = await import(u); break; } catch (e) { err = e; } }
    if (!mod) throw err || new Error('transformers.js unavailable');
    const device = navigator.gpu ? 'webgpu' : 'wasm';
    try {
      pipe = await mod.pipeline('depth-estimation', BROWSER_MODEL, {
        device,
        progress_callback: p => { if (p && p.status === 'progress' && status) status(t('модель ', 'model ') + Math.round(p.progress || 0) + '%'); }
      });
    } catch (e) {
      if (device === 'wasm') throw e;
      pipe = await mod.pipeline('depth-estimation', BROWSER_MODEL, { device: 'wasm' });
    }
  }
  status && status(t('оцінка глибини в браузері', 'estimating depth in the browser'));
  const url = URL.createObjectURL(blob);
  try {
    const res = await pipe(url);
    const out = Array.isArray(res) ? res[0] : res;
    const d = out.depth;
    if (typeof d.toBlob === 'function') { try { return await d.toBlob('image/png'); } catch (e) { } }
    const canvas = d.toCanvas();
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise((ok, no) => canvas.toBlob(b => b ? ok(b) : no(new Error('PNG encoding failed')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/* ── AI background behind objects (photo mode): MI-GAN on the nomono3d server ──
   Preference 'bgfill': 'ai' (default when the server offers it) or 'basic' (built-in fill). */
export const BG = { pref: loadPref('bgfill', 'ai') };
export function inpaintAvailable() { return !!(AI.server && AI.server.inpaint); }
export function useAIBackground() { return BG.pref === 'ai' && inpaintAvailable(); }
export function setBgFill(v) { BG.pref = v === 'basic' ? 'basic' : 'ai'; savePref('bgfill', BG.pref); }
/* image, mask: Blobs (mask white = fill). Resolves to an ImageBitmap-able Blob (PNG). */
export async function inpaintImage(image, mask, status) {
  const fd = new FormData();
  fd.append('file', image, 'image.jpg');
  fd.append('mask', mask, 'mask.png');
  let r = null;
  for (let i = 0; i < 120; i++) {
    status && status(t('ШІ домальовує фон…', 'AI is filling the background…'));
    r = await fetch('api/inpaint', { method: 'POST', body: fd });
    if (r.status !== 503) break;
    status && status(t('модель фону завантажується на сервері… ', 'the background model is loading on the server… ') + (i + 1) * 5 + ' s');
    await new Promise(ok => setTimeout(ok, 5000));
  }
  if (!r.ok) {
    let msg = r.status + ' ' + r.statusText;
    try { const j = await r.json(); if (j.detail) msg = j.detail; } catch (e) { }
    throw new Error(msg);
  }
  return r.blob();
}

/* Save an image (and optionally its depth map) into the server library */
export async function saveToLibrary(file, depthBlob, kind, album) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'image.jpg');
  if (depthBlob) fd.append('depth', depthBlob, 'depth.png');
  fd.append('kind', kind);
  if (album) fd.append('album', album);
  const r = await fetch('api/library', { method: 'POST', body: fd });
  if (!r.ok) {
    let msg = r.status + ' ' + r.statusText;
    try { const j = await r.json(); if (j.detail) msg = j.detail; } catch (e) { }
    throw new Error(msg);
  }
  return r.json();
}

export function canUpload() { return !!(AI.server && AI.server.upload); }
