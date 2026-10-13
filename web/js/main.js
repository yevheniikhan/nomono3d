// Entry point: module initialisation and the render loop.
import { S, $, t } from './state.js';
import { initGfx, renderer, scene, camera } from './gfx.js';
import { drainLoopTasks } from './depth.js';
import {
  frame2D, bindViewerUI, setLoop, openViewer, pick, clearDepthSlot, files, updateLoadNote, setKind, makeDepth
} from './viewer.js';
import { initLibrary } from './library.js';
import { initObjects, objectsUpdate } from './objects.js';
import { initEditor, editorUpdate } from './editor.js';
import { initHelp, openHelp } from './help.js';
import { initPhoto } from './photo.js';
import { AI, detectServer, canUpload, saveToLibrary } from './ai.js';
import { initXR, xrFrame } from './xr.js';                  // VR headset mode
import { initExport } from './export.js';
import { initShare } from './share.js';
import { initMeasure, setMeasure } from './measure.js';
import { initPalette } from './palette.js';

const params = new URLSearchParams(location.search);
S.kiosk = params.has('kiosk');

let last = performance.now();
function loop(time, frame) {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000 || 0.016, 0.1); last = now;
  drainLoopTasks();
  // ── VR headset mode: xr.js drives the scene, three renders both eyes (no 2D camera code) ──
  if (renderer.xr.isPresenting) {
    xrFrame(now, dt, frame);
    objectsUpdate(dt, now);
    renderer.render(scene, camera);
    return;
  }
  if (!frame2D(now, dt)) return;
  objectsUpdate(dt, now); editorUpdate(dt);
  renderer.render(scene, camera);
}

async function boot() {
  try {
    if (!initGfx($('gl'))) throw new Error('WebGL2 is unavailable on this device.');
  } catch (err) {
    $('note').textContent = 'WebGL2 is unavailable on this device. ' + (err.message || '');
    return;
  }
  S.ready = true;
  setLoop(loop);
  bindViewerUI();
  initHelp();
  initPhoto();
  initObjects();
  initEditor();
  await initXR();                       // VR support flags (before the library opens ?p=…)
  initExport();
  initShare();
  initMeasure();
  initPalette();
  $('measureBtn').addEventListener('click', e => { e.stopPropagation(); $('depthPanel').hidden = true; setMeasure(true); });
  setKind(params.get('mode') === 'photo' ? 'photo' : 'pano', true);
  const refreshUpload = () => { $('libSave').hidden = !(canUpload() && files.pano); };
  document.addEventListener('nomono3d:file', refreshUpload);

  $('filePano').addEventListener('change', e => { pick('pano', e.target.files[0]); e.target.value = ''; });
  $('fileDepth').addEventListener('change', e => { pick('depth', e.target.files[0]); e.target.value = ''; });
  $('depthClear').addEventListener('click', e => { e.preventDefault(); clearDepthSlot(); $('depthClear').hidden = true; updateLoadNote(); });
  $('kindPano').addEventListener('click', () => setKind('pano'));
  $('kindPhoto').addEventListener('click', () => setKind('photo'));
  $('view').addEventListener('click', () => openViewer({}));
  $('depthGen').addEventListener('click', async e => {
    e.preventDefault();
    $('depthGen').hidden = true; $('view').disabled = true;
    try { await makeDepth(s => { $('note').textContent = s; }); }
    catch (err) { $('note').textContent = t('Не вдалося оцінити глибину: ', 'Depth estimation failed: ') + (err.message || err); }
    updateLoadNote(); refreshUpload();
  });
  $('depthSave').addEventListener('click', e => {
    e.preventDefault();
    if (!files.depth) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(files.depth.file); a.download = files.depth.name || 'depth.png';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('libSave').addEventListener('click', async e => {
    e.preventDefault();
    if (!files.pano) return;
    $('libSave').disabled = true;
    try {
      const r = await saveToLibrary(files.pano.file, files.depth && files.depth.file, S.kind, '');
      $('note').textContent = t('Збережено в бібліотеку: ', 'Saved to the library: ') + (r.src || '');
      const { reloadLibrary } = await import('./library.js'); await reloadLibrary();
    } catch (err) { $('note').textContent = t('Не вдалося зберегти: ', 'Could not save: ') + (err.message || err); }
    $('libSave').disabled = false;
  });
  $('helpOpen').addEventListener('click', () => openHelp());
  $('hlpBtn').addEventListener('click', e => { e.stopPropagation(); openHelp(); });

  // Paste or drop an image onto the start screen
  const take = f => { if (f && /^image\//.test(f.type)) pick('pano', f); };
  window.addEventListener('paste', e => { if (!S.running && e.clipboardData) take([...e.clipboardData.files][0]); });
  $('load').addEventListener('dragover', e => e.preventDefault());
  $('load').addEventListener('drop', e => { e.preventDefault(); if (!S.running && e.dataTransfer) take([...e.dataTransfer.files][0]); });

  detectServer().then(() => {
    const s = AI.server;
    $('engine').textContent = s ? (s.depth && (s.depth.pano || s.depth.photo) ? 'GPU depth server' + (s.device ? ': ' + s.device.replace(/^cuda · /, '') : '') : 'nomono3d server, no depth models')
      : 'In-browser depth for photos';
    $('engine').classList.toggle('on', !!s);
    updateLoadNote(); refreshUpload();
  });

  initLibrary(params);
  if (params.has('debug')) {
    const [gfx, viewer, depth, photo, xr, exp, objects] = await Promise.all([import('./gfx.js'), import('./viewer.js'), import('./depth.js'), import('./photo.js'), import('./xr.js'), import('./export.js'), import('./objects.js')]);
    window.__n3d = { S, gfx, viewer, depth, photo, xr, exp, objects, files, AI };
  }
}
boot();
