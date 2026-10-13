// Library of panoramas (panoramas/) and photos (photos/) on the hosting:
// nomono3d server (api/list) → list.php → manifest.json → server autoindex → GitHub Pages.
import { S, $, t, emit, on, fmtBytes, DEG, hint } from './state.js';
import { pick, files, openViewer, clearDepthSlot, updateLoadNote } from './viewer.js';
import { idbGet, idbPut } from './idb.js';

export const LIB = { items: [], models: [], albums: [], source: null, title: null, album: '', kind: '', ready: false, msg: '' };
const DIRS = [['panoramas', 'pano'], ['photos', 'photo']];
const IMG = /\.(jpe?g|png|webp|avif)$/i;
const DEPTH = /^(.*?)[._\- ](depth|disp|disparity|depthmap|dmap)$/i;
const MODEL = /\.(glb|gltf|obj|fbx|ply|stl|3mf|usdz|las|xyz|pcd|zip|splat|spz|ksplat)$/i;
const ABS = /^(https?:)?\/\//i;

const fileName = u => decodeURIComponent((u.split('?')[0].split('#')[0].split('/').pop()) || 'file');
const stripExt = n => n.replace(/\.[^.]+$/, '');
const pretty = s => { s = s.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const layoutOf = (w, h) => !w || !h ? null : Math.abs(w / h - 1) < 0.15 ? 'tb' : Math.abs(w / h - 4) < 0.4 ? 'sbs' : 'mono';
const href = (u, base) => new URL(u, base).href;

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  const txt = (await r.text()).trim();
  if (txt[0] !== '{' && txt[0] !== '[') throw new Error('not json: ' + url);
  return JSON.parse(txt);
}
export async function fetchBlob(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + fileName(url));
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total || !onProgress) { const b = await r.blob(); return b; }
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length; onProgress(Math.min(got, total), total);
  }
  return new Blob(chunks, { type: r.headers.get('content-type') || '' });
}

/* ─── entry normalisation ─── */
function normItem(it, base) {
  const o = Object.assign({}, it);
  o.src = href(it.src, base);
  for (const k of ['depth', 'scene', 'thumb']) if (it[k]) o[k] = href(it[k], base);
  o.title = it.title || pretty(stripExt(fileName(it.src)));
  o.id = it.id || stripExt(fileName(it.src));
  o.kind = it.kind === 'photo' ? 'photo' : 'pano';
  o.layout = o.kind === 'photo' ? 'mono' : (it.layout || layoutOf(it.w, it.h) || null);
  o.album = it.album || '';
  return o;
}
function normModel(it, base) {
  const o = Object.assign({}, it);
  o.src = href(it.src, base);
  if (it.thumb) o.thumb = href(it.thumb, base);
  o.title = it.title || pretty(stripExt(fileName(it.src)));
  o.id = it.id || stripExt(fileName(it.src));
  o.ext = (it.ext || fileName(it.src).split('.').pop() || '').toLowerCase();
  return o;
}
/* "Panorama + depth + scene" sets from a plain list of URLs (autoindex, GitHub) */
function fromUrlList(urls, rootUrl) {
  // thumbnails from tools/build-manifest.py: panoramas/thumbs/<album>/<name>.jpg
  const thumbs = new Map(), rest = [];
  for (const u of urls) {
    const rel = decodeURIComponent(u.slice(rootUrl.length));
    if (/^thumbs\//i.test(rel)) thumbs.set(rel.slice(7).replace(/\.[^.]+$/, '').toLowerCase(), u);
    else if (!/(^|\/)\./.test(rel)) rest.push(u);
  }
  const byDir = new Map();
  for (const u of rest) {
    const d = u.slice(0, u.lastIndexOf('/') + 1);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(u);
  }
  const items = [];
  for (const [dir, list] of byDir) {
    const names = new Map(list.map(u => [fileName(u), u]));
    const depthFor = new Map();
    for (const [n, u] of names) {
      if (!IMG.test(n)) continue;
      const m = stripExt(n).match(DEPTH);
      if (m) { const k = m[1].toLowerCase(); if (!depthFor.has(k) || /\.png$/i.test(n)) depthFor.set(k, u); }
    }
    for (const [n, u] of names) {
      if (!IMG.test(n)) continue;
      const b = stripExt(n);
      if (DEPTH.test(b) || /[._-](thumb|preview)$/i.test(b)) continue;
      const album = decodeURIComponent(dir.slice(rootUrl.length)).replace(/\/$/, '');
      const it = { src: u, title: pretty(b), id: (album ? album + '/' : '') + b, album };
      if (depthFor.has(b.toLowerCase())) it.depth = depthFor.get(b.toLowerCase());
      if (names.has(b + '.scene.json')) it.scene = names.get(b + '.scene.json');
      for (const te of ['jpg', 'png', 'webp']) if (names.has(b + '.thumb.' + te)) it.thumb = names.get(b + '.thumb.' + te);
      const tk = ((album ? album + '/' : '') + b).toLowerCase();
      if (!it.thumb && thumbs.has(tk)) it.thumb = thumbs.get(tk);
      items.push(it);
    }
  }
  items.sort((a, b) => (a.album || '').localeCompare(b.album || '', undefined, { numeric: true }) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return items;
}
async function crawlIndex(url, depth) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) return [];
  if (!/html/i.test(r.headers.get('content-type') || '')) return [];
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const basePath = new URL(url).pathname, out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const h = a.getAttribute('href');
    if (!h || h[0] === '?' || h[0] === '#') continue;
    let u; try { u = new URL(h, url); } catch (e) { continue; }
    if (u.origin !== location.origin || !u.pathname.startsWith(basePath) || u.pathname === basePath) continue;
    if (u.pathname.endsWith('/')) {
      if (depth > 0 && !/(^|\/)\./.test(u.pathname.slice(basePath.length))) out.push(...await crawlIndex(u.href, depth - 1));
    } else out.push(u.origin + u.pathname);
  }
  return [...new Set(out)];
}
async function githubList(dir) {
  const host = location.hostname;
  if (!/\.github\.io$/i.test(host)) return null;
  const owner = host.split('.')[0];
  const seg = location.pathname.split('/').filter(Boolean)[0];
  const tries = seg && !/\.html?$/i.test(seg) ? [[seg, '/' + seg + '/'], [owner + '.github.io', '/']] : [[owner + '.github.io', '/']];
  for (const [repo, sitePath] of tries) {
    const ck = 'nomono3d.gh.' + repo;
    let tree = null;
    try { tree = JSON.parse(sessionStorage.getItem(ck) || 'null'); } catch (e) { }
    if (!tree) {
      try {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`);
        if (!r.ok) continue;
        tree = (await r.json()).tree.filter(n => n.type === 'blob').map(n => n.path);
        try { sessionStorage.setItem(ck, JSON.stringify(tree)); } catch (e) { }
      } catch (e) { continue; }
    }
    for (const prefix of ['', 'docs/', 'web/']) {
      const want = prefix + dir + '/';
      const hits = tree.filter(p => p.startsWith(want));
      if (hits.length) {
        const site = location.origin + sitePath;
        return { urls: hits.map(p => site + p.slice(prefix.length).split('/').map(encodeURIComponent).join('/')), all: tree.map(p => p.slice(prefix.length)), site };
      }
    }
  }
  return null;
}

/* ─── discovery ─── */
async function fromServerJSON(url, docBase) {
  const j = await fetchJSON(url);
  if (!j || !(Array.isArray(j.panoramas) || Array.isArray(j.photos))) return false;
  LIB.title = j.title || null;
  LIB.items = [
    ...(j.panoramas || []).map(it => normItem(Object.assign({ kind: 'pano' }, it), docBase)),
    ...(j.photos || []).map(it => normItem(Object.assign({ kind: 'photo' }, it), docBase))
  ];
  LIB.models = (j.models || []).map(it => normModel(it, docBase));
  return true;
}
/* One folder (panoramas/ or photos/) on a static host: manifest.json → autoindex → GitHub */
async function discoverDir(dir, kind, docBase) {
  const dirUrl = href(dir + '/', docBase);
  try {
    const j = await fetchJSON(dirUrl + 'manifest.json');
    const arr = Array.isArray(j) ? j : (j.items || j.panoramas || j.photos || []);
    if (arr.length) {
      const items = arr.filter(it => it && it.src && !it.hidden).map(it => normItem(Object.assign({ kind }, it), dirUrl));
      items.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
      return { source: 'manifest', items, title: j.title || null, models: j.models || null, base: dirUrl };
    }
  } catch (e) { }
  try {
    const urls = await crawlIndex(dirUrl, 2);
    const items = fromUrlList(urls, dirUrl);
    if (items.length) return { source: 'autoindex', items: items.map(it => normItem(Object.assign({ kind }, it), dirUrl)) };
  } catch (e) { }
  try {
    const g = await githubList(dir);
    if (g) return { source: 'github', items: fromUrlList(g.urls, href(dir + '/', g.site)).map(it => normItem(Object.assign({ kind }, it), dirUrl)), gh: g };
  } catch (e) { }
  return null;
}
export async function discover(params) {
  const docBase = location.href;
  const mdir = (params.get('models') || 'models').replace(/\/+$/, '');
  const mdirUrl = href(mdir + '/', docBase);
  if (!params.has('lib')) {
    // 1. nomono3d server, 2. PHP hosting
    for (const [url, src] of [['api/list', 'server'], ['list.php', 'php']]) {
      try { if (await fromServerJSON(url, docBase)) { LIB.source = src; return true; } } catch (e) { }
    }
  }
  const dirs = params.has('lib') ? [[params.get('lib').replace(/\/+$/, ''), params.get('mode') === 'photo' ? 'photo' : 'pano']] : DIRS;
  const found = [];
  for (const [dir, kind] of dirs) { const r = await discoverDir(dir, kind, docBase); if (r) found.push(r); }
  if (!found.length) return false;
  LIB.source = [...new Set(found.map(f => f.source))].join('+');
  LIB.title = (found.find(f => f.title) || {}).title || null;
  LIB.items = found.flatMap(f => f.items);
  // models: manifest → autoindex → GitHub tree
  LIB.models = [];
  try {
    const m = await fetchJSON(mdirUrl + 'manifest.json');
    LIB.models = (Array.isArray(m) ? m : (m.items || m.models || [])).map(it => normModel(it, mdirUrl));
  } catch (e) {
    const mf = found.find(f => f.models);
    if (mf) LIB.models = mf.models.map(it => normModel(it, mf.base));
    else if (found.some(f => f.source === 'autoindex')) {
      try { LIB.models = (await crawlIndex(mdirUrl, 2)).filter(u => MODEL.test(u)).map(u => normModel({ src: u }, mdirUrl)); } catch (e2) { }
    } else {
      const gh = found.find(f => f.gh);
      if (gh) LIB.models = gh.gh.all.filter(p => p.startsWith(mdir + '/') && MODEL.test(p))
        .map(p => normModel({ src: gh.gh.site + p.split('/').map(encodeURIComponent).join('/') }, mdirUrl));
    }
  }
  return true;
}

/* ─── gallery ─── */
function tagHtml(it) {
  const tg = [];
  tg.push(`<span>${it.kind === 'photo' ? 'Photo' : '360°'}</span>`);
  if (it.layout === 'tb' || it.layout === 'sbs') tg.push(`<span class="s">${it.layout === 'tb' ? 'Stereo TB' : 'Stereo SBS'}</span>`);
  if (it.depth) tg.push('<span class="d">Depth</span>');
  if (it.scene) tg.push('<span class="o">3D objects</span>');
  if (it.w) tg.push(`<span>${it.w} × ${it.h}</span>`);
  return tg.join('');
}
export function renderGallery() {
  const box = $('libBox'), grid = $('libGrid');
  const has = LIB.items.length > 0;
  box.hidden = !has && !LIB.msg;
  $('load').classList.toggle('wide', has);
  $('libTitle').textContent = LIB.title || t('Бібліотека', 'Library');
  $('libCount').textContent = has ? LIB.items.length + (LIB.items.length === 1 ? ' item' : ' items') : '';
  $('libMsg').textContent = LIB.msg || '';
  const al = $('libAlbums'); al.innerHTML = '';
  const kinds = new Set(LIB.items.map(i => i.kind));
  const albums = [...new Set(LIB.items.filter(i => !LIB.kind || i.kind === LIB.kind).map(i => i.album).filter(Boolean))];
  const chip = (label, on, fn) => { const b = document.createElement('button'); b.textContent = label; b.className = on ? 'on' : ''; b.onclick = fn; al.appendChild(b); };
  if (kinds.size > 1) {
    chip(t('Усе', 'All'), !LIB.kind, () => { LIB.kind = ''; LIB.album = ''; renderGallery(); });
    chip(t('Панорами', 'Panoramas'), LIB.kind === 'pano', () => { LIB.kind = 'pano'; LIB.album = ''; renderGallery(); });
    chip(t('Фото', 'Photos'), LIB.kind === 'photo', () => { LIB.kind = 'photo'; LIB.album = ''; renderGallery(); });
  }
  if (albums.length) {
    if (kinds.size > 1) { const sp = document.createElement('span'); sp.style.width = '10px'; al.appendChild(sp); }
    for (const a of ['', ...albums]) chip(a || t('Усі альбоми', 'All albums'), LIB.album === a, () => { LIB.album = a; renderGallery(); });
  }
  grid.innerHTML = '';
  for (const it of LIB.items) {
    if (LIB.kind && it.kind !== LIB.kind) continue;
    if (LIB.album && it.album !== LIB.album) continue;
    const c = document.createElement('div');
    c.className = 'card'; c.tabIndex = 0; c.setAttribute('role', 'button');
    c.innerHTML = `<div class="th"><span>${t('без прев\'ю', 'No preview')}</span><img alt="" loading="lazy" decoding="async"></div><div class="ti"></div><div class="tg">${tagHtml(it)}</div>`;
    c.querySelector('.ti').textContent = it.title;
    if (it.description) c.title = it.description;
    const th = c.querySelector('.th'), img = th.querySelector('img');
    const show = () => { img.classList.add('ok'); th.querySelector('span').hidden = true; };
    const cached = () => idbGet('thumbs', it.src).then(v => { if (v) { img.onerror = null; img.src = typeof v === 'string' ? v : URL.createObjectURL(v); } });
    img.onload = show;
    img.onerror = cached;
    if (it.thumb) img.src = it.thumb; else cached();
    c.onclick = () => openItem(it);
    c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it); } };
    grid.appendChild(c);
  }
}

/* ─── opening an entry ─── */
async function prepareItem(it, status) {
  try { await (await import('./objects.js')).flushDraft(); } catch (e) { }
  const pct = (a, b) => b ? ' ' + Math.round(100 * a / b) + '% · ' + fmtBytes(b) : '';
  status && status(t('завантаження', 'downloading'));
  const blob = await fetchBlob(it.src, (a, b) => status && status(t('завантаження', 'downloading') + pct(a, b)));
  await pick('pano', blob, { name: fileName(it.src), url: it.src, kind: it.kind, layout: it.layout || null, swapEyes: !!it.swapEyes, keepItem: true, size: blob.size });
  clearDepthSlot(); $('depthClear').hidden = true;
  if (it.depth) {
    status && status(t('карта глибини', 'depth map'));
    const d = await fetchBlob(it.depth);
    await pick('depth', d, { name: fileName(it.depth), url: it.depth });
  }
  S.depthInvert = !!it.depthInvert;
  S.initialYaw = it.yaw != null ? it.yaw * DEG : null;
  S.item = it;
}
export function openItem(it) {
  S.item = it;
  return openViewer({ prepare: status => prepareItem(it, status) });
}
/* Open another item without leaving the viewer (← → keys) */
export async function switchItem(it, status) {
  await prepareItem(it, status);
  const v = await import('./viewer.js');
  if (!files.depth) { try { await v.makeDepth(status); } catch (e) { console.warn(e); } }
  await v.loadPanorama({});
  v.applyKindUI(); v.updateInfo();
  emit('pano-ready', { first: false });
}
export function neighbour(step) {
  if (!LIB.items.length) return null;
  const list = LIB.items.filter(i => (!LIB.kind || i.kind === LIB.kind) && (!LIB.album || i.album === LIB.album));
  const i = Math.max(0, list.findIndex(x => S.item && x.src === S.item.src));
  return list[(i + step + list.length) % list.length];
}

/* Cache the thumbnail after the first view (if the server does not provide one) */
function cacheThumb() {
  const it = S.item; if (!it || !S.small) return;
  idbGet('thumbs', it.src).then(v => {
    if (v && it.thumb) return;
    const c = document.createElement('canvas'); c.width = 384; c.height = 192;
    // panoramas: the forward view (central half), photos: the whole frame
    if (it.kind === 'photo') c.getContext('2d').drawImage(S.small, 0, 0, 384, 192);
    else c.getContext('2d').drawImage(S.small, 256, 128, 512, 256, 0, 0, 384, 192);
    try { idbPut('thumbs', it.src, c.toDataURL('image/jpeg', 0.78)); } catch (e) { }
  });
}

let lastParams = new URLSearchParams(location.search);
export async function reloadLibrary(params = lastParams) {
  lastParams = params;
  $('libMsg').textContent = '';
  let ok = false;
  try { ok = await discover(params); } catch (e) { ok = false; }
  LIB.ready = true; LIB.msg = '';
  if (!ok) {
    LIB.msg = location.protocol === 'file:'
      ? t('Бібліотека працює лише через веб-сервер (див. Довідку).', 'The library works only via a web server (see Help).') : '';
  } else if (!LIB.items.length) {
    LIB.msg = t('Бібліотека порожня: додайте файли в panoramas/ або photos/.', 'The library is empty: add files to panoramas/ or photos/.');
  }
  renderGallery();
  emit('library-ready', LIB);
}

export async function initLibrary(params) {
  on('pano-ready', cacheThumb);
  await reloadLibrary(params);
  // Direct link: ?p=name
  const p = params.get('p');
  if (p && LIB.items.length) {
    const q = p.toLowerCase();
    const rel = u => { try { const a = new URL(u, document.baseURI), b = new URL('.', document.baseURI); return decodeURIComponent(a.pathname.slice(b.pathname.length)).toLowerCase(); } catch (e) { return ''; } };
    const it = LIB.items.find(i => rel(i.src) === q) || LIB.items.find(i => i.id.toLowerCase() === q)
      || LIB.items.find(i => fileName(i.src).toLowerCase().startsWith(q)) || LIB.items.find(i => i.title.toLowerCase() === q);
    if (it) { if (params.get('sc') === '1') S.shareScene = it.src; openItem(it); }
  }
  // ← → for the previous/next panorama in 2D
  document.addEventListener('keydown', e => {
    if (!S.running || !S.item || /input|textarea|select/i.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { const n = neighbour(1); if (n) switchItem(n, s => hint(s, 1200)); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { const n = neighbour(-1); if (n) switchItem(n, s => hint(s, 1200)); }
  });
}
