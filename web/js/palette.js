// Command palette (⌘K / Ctrl+K): every action and every library item, one search away.
// Single-key shortcuts in the viewer are listed next to their commands.
import { S, $, t } from './state.js';
import { LIB, openItem } from './library.js';
import { DEPTH_MODES, setDepthMode, closeViewer, reprocessPhoto, syncBgFill } from './viewer.js';
import { BG, inpaintAvailable, setBgFill } from './ai.js';
import { exportImage, exportStereo, exportPano360, recordVideo, toggleExportPanel, stereoAvailable, pano360Available } from './export.js';
import { openShare } from './share.js';
import { setMeasure, measuring, clearMeasures } from './measure.js';
import { openHelp } from './help.js';

const P = { open: false, items: [], shown: [], sel: 0 };
const click = id => () => { const b = $(id); if (b && !b.hidden && !b.disabled) b.click(); };
const viewer = () => S.running;
const busyBox = async fn => {
  const b = $('busy'); b.classList.add('on'); $('busyTitle').textContent = t('Рендер 360°', 'Rendering 360°'); $('busyStep').textContent = '';
  try { await fn(p => { $('busyStep').textContent = Math.round(p * 100) + ' %'; }); } finally { b.classList.remove('on'); }
};

/* name, group, run, optional: keys (shortcut shown), when() */
function commands() {
  const C = [
    { name: 'Open an image file…', group: 'Start', when: () => !viewer(), run: () => $('filePano').click() },
    { name: 'Switch to 360° panoramas', group: 'Start', when: () => !viewer() && S.kind !== 'pano', run: click('kindPano') },
    { name: 'Switch to photos', group: 'Start', when: () => !viewer() && S.kind !== 'photo', run: click('kindPhoto') },
    { name: '3D objects editor', group: 'View', keys: 'O', when: viewer, run: click('edBtn') },
    { name: 'Measure distance', group: 'View', keys: 'M', when: () => viewer() && S.depthReady, run: () => setMeasure(!measuring()) },
    { name: 'Clear measurements', group: 'View', when: viewer, run: clearMeasures },
    { name: S.kind === 'photo' ? 'Orbit on / off' : 'Auto-rotate on / off', group: 'View', keys: 'A', when: viewer, run: click('rotBtn') },
    { name: 'Full screen', group: 'View', keys: 'F', when: viewer, run: click('fsbtn') },
    { name: 'Head tracking (camera)', group: 'View', when: viewer, run: click('headBtn') },
    ...DEPTH_MODES.map(([m, label, title], i) => ({ name: 'Depth view: ' + label, hint: title, group: 'Depth', keys: i ? String(i) : '0', when: () => viewer() && S.depthReady, run: () => setDepthMode(m) })),
    { name: 'Photo background: AI (MI-GAN)', group: 'Depth', when: () => viewer() && S.kind === 'photo' && inpaintAvailable() && BG.pref !== 'ai', run: () => { setBgFill('ai'); syncBgFill(); reprocessPhoto(); } },
    { name: 'Photo background: built-in', group: 'Depth', when: () => viewer() && S.kind === 'photo' && inpaintAvailable() && BG.pref === 'ai', run: () => { setBgFill('basic'); syncBgFill(); reprocessPhoto(); } },
    { name: 'Export panel…', group: 'Export', keys: 'E', when: viewer, run: () => toggleExportPanel(true) },
    { name: 'Save image (screen size)', group: 'Export', when: viewer, run: () => exportImage('screen') },
    { name: 'Save image (4K)', group: 'Export', when: viewer, run: () => exportImage('4k') },
    { name: 'Save stereo pair, side by side', group: 'Export', when: () => viewer() && stereoAvailable(), run: () => exportStereo('sbs') },
    { name: 'Save anaglyph (red/cyan)', group: 'Export', when: () => viewer() && stereoAvailable(), run: () => exportStereo('anaglyph') },
    { name: 'Render 360° image (mono)', group: 'Export', when: () => viewer() && pano360Available(), run: () => busyBox(p => exportPano360('mono', undefined, p)) },
    { name: 'Render 360° stereo image (ODS)', group: 'Export', when: () => viewer() && pano360Available() && S.panoMode === 'mesh', run: () => busyBox(p => exportPano360('stereo', undefined, p)) },
    { name: 'Record a video loop', group: 'Export', when: viewer, run: () => recordVideo() },
    { name: 'View in VR headset (link and QR code)…', group: 'Share', keys: 'V', when: viewer, run: openShare },
    { name: 'Help', group: 'Help', keys: '?', run: () => openHelp() },
    { name: 'Keyboard shortcuts', group: 'Help', run: () => openHelp('keys') },
    { name: 'Close the viewer', group: 'View', when: viewer, run: closeViewer }
  ];
  for (const it of LIB.items) C.push({ name: it.title, hint: (it.album ? it.album + ' · ' : '') + (it.kind === 'photo' ? 'photo' : '360°'), group: 'Library', run: () => openItem(it) });
  return C.filter(c => !c.when || c.when());
}

/* Subsequence match with a bonus for word starts; −1 = no match */
function score(q, s) {
  if (!q) return 0;
  s = s.toLowerCase();
  let i = 0, sc = 0, prev = -2;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return -1;
    sc += (j === prev + 1 ? 3 : 1) + (j === 0 || /[\s:(·-]/.test(s[j - 1]) ? 4 : 0);
    prev = j; i = j + 1;
  }
  return sc - s.length * 0.02;
}
function render() {
  const q = $('palInput').value.trim().toLowerCase();
  P.shown = P.items.map(c => ({ c, s: score(q, c.name + ' ' + (c.hint || '') + ' ' + c.group) }))
    .filter(x => x.s >= 0).sort((a, b) => q ? b.s - a.s : 0).slice(0, 60).map(x => x.c);
  P.sel = Math.min(P.sel, Math.max(0, P.shown.length - 1));
  const box = $('palList'); box.innerHTML = '';
  let lastG = null;
  P.shown.forEach((c, i) => {
    if (!q && c.group !== lastG) { const h = document.createElement('div'); h.className = 'palg'; h.textContent = c.group; box.appendChild(h); lastG = c.group; }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pali' + (i === P.sel ? ' on' : '');
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', i === P.sel);
    const n = document.createElement('span'); n.className = 'pn'; n.textContent = c.name; b.appendChild(n);
    if (c.hint) { const h = document.createElement('span'); h.className = 'ph'; h.textContent = c.hint; b.appendChild(h); }
    if (c.keys) { const k = document.createElement('kbd'); k.textContent = c.keys; b.appendChild(k); }
    b.onmouseenter = () => { P.sel = i; mark(); };
    b.onclick = () => run(c);
    box.appendChild(b);
  });
  if (!P.shown.length) { const e = document.createElement('div'); e.className = 'pale'; e.textContent = t('Нічого не знайдено', 'No matches'); box.appendChild(e); }
}
function mark() {
  $('palList').querySelectorAll('.pali').forEach((b, i) => { b.classList.toggle('on', i === P.sel); b.setAttribute('aria-selected', i === P.sel); if (i === P.sel) b.scrollIntoView({ block: 'nearest' }); });
}
function run(c) { closePalette(); setTimeout(() => c.run(), 0); }
export function openPalette() {
  if (S.xr) return;
  P.items = commands(); P.sel = 0; P.open = true;
  const d = $('palette'); $('palInput').value = '';
  if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  render(); $('palInput').focus();
}
export function closePalette() { P.open = false; const d = $('palette'); if (d.open) d.close ? d.close() : d.removeAttribute('open'); }

const typing = e => /input|textarea|select/i.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
export function initPalette() {
  if (!/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) document.querySelectorAll('[data-palette] kbd').forEach(k => { k.textContent = 'Ctrl K'; });
  $('palInput').addEventListener('input', () => { P.sel = 0; render(); });
  $('palInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); P.sel = Math.min(P.sel + 1, P.shown.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); P.sel = Math.max(P.sel - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = P.shown[P.sel]; if (c) run(c); }
  });
  $('palette').addEventListener('click', e => { if (e.target === $('palette')) closePalette(); });
  $('palette').addEventListener('close', () => { P.open = false; });
  document.querySelectorAll('[data-palette]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openPalette(); }));
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); P.open ? closePalette() : openPalette(); return; }
    if (P.open || typing(e) || e.metaKey || e.ctrlKey || e.altKey || !S.running || S.xr) return;
    if (document.querySelector('dialog[open]') || $('help').classList.contains('on')) return;
    const k = e.key;
    // object editor keys (W/E/R/G, Delete) win while an object is selected in the open editor
    if (document.body.classList.contains('editing') && /^[werg]$/i.test(k)) return;
    const map = {
      m: () => S.depthReady && setMeasure(!measuring()), o: click('edBtn'), f: click('fsbtn'), a: click('rotBtn'),
      e: () => toggleExportPanel(), v: openShare, '?': () => openHelp()
    };
    if (/^[0-6]$/.test(k) && S.depthReady) { setDepthMode(+k); return; }
    const f = map[k.toLowerCase()] || map[k];
    if (f) { e.preventDefault(); f(); }
  });
}
