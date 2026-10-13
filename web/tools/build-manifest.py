#!/usr/bin/env python3
"""
nomono3d: build manifest.json files and thumbnails for hosting WITHOUT PHP
(GitHub Pages, Netlify, Cloudflare Pages, S3, any static server).

Run from the site root (next to index.html):
    python tools/build-manifest.py
Options:
    --root PATH        site root (default: the parent folder of tools/)
    --no-thumbs        do not create thumbnails
    --force-thumbs     re-create all thumbnails
Output:
    panoramas/manifest.json  360° panoramas with their depth maps and scenes, sizes, albums
    photos/manifest.json     flat photos with their depth maps
    <folder>/thumbs/...      512-px thumbnails (left eye of a stereo panorama); needs Pillow
    models/manifest.json     3D models for the editor
Hand edits in an existing manifest.json (title, description, order, yaw, layout, swapEyes,
depthInvert, hidden) are kept: the script refreshes only the technical fields.
Pillow: pip install pillow  (without it you still get manifests, but no thumbnails).

The nomono3d server imports scan_folder() and scan_models() from this file, so static hosting
and the server always pair files the same way.
"""
import argparse, json, os, re, struct, sys
from urllib.parse import quote, unquote

IMG = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
MODEL = ('.glb', '.gltf', '.obj', '.fbx', '.ply', '.stl', '.3mf', '.usdz', '.las', '.xyz', '.pcd', '.zip')
DEPTH = re.compile(r'^(.*?)[._\- ](depth|disp|disparity|depthmap|dmap)$', re.I)
SKIP_DIRS = {'thumbs', '.thumbs'}
FOLDERS = (('panoramas', 'pano'), ('photos', 'photo'))

try:
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
except Exception:
    Image = None


def image_size(path):
    """Image size from the header (JPEG/PNG/WebP) without decoding, otherwise via Pillow."""
    try:
        with open(path, 'rb') as f:
            head = f.read(64)
            if head[:8] == b'\x89PNG\r\n\x1a\n':
                w, h = struct.unpack('>II', head[16:24]); return w, h
            if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
                chunk = head[12:16]
                if chunk == b'VP8X':
                    w = 1 + int.from_bytes(head[24:27], 'little'); h = 1 + int.from_bytes(head[27:30], 'little'); return w, h
                if chunk == b'VP8 ':
                    w, h = struct.unpack('<HH', head[26:30]); return w & 0x3fff, h & 0x3fff
                if chunk == b'VP8L':
                    b = head[21:25]; bits = int.from_bytes(b, 'little')
                    return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
            if head[:2] == b'\xff\xd8':
                f.seek(2)
                while True:
                    m = f.read(2)
                    if len(m) < 2 or m[0] != 0xFF: break
                    while m[1] == 0xFF: m = m[:1] + f.read(1)
                    if m[1] in (0xD8, 0x01) or 0xD0 <= m[1] <= 0xD7: continue
                    ln = struct.unpack('>H', f.read(2))[0]
                    if 0xC0 <= m[1] <= 0xCF and m[1] not in (0xC4, 0xC8, 0xCC):
                        data = f.read(5); h, w = struct.unpack('>HH', data[1:5]); return w, h
                    f.seek(ln - 2, 1)
    except Exception:
        pass
    if Image:
        try:
            with Image.open(path) as im: return im.size
        except Exception:
            pass
    return 0, 0


def layout_of(w, h):
    """'tb' (1:1 top-bottom stereo), 'sbs' (4:1 side-by-side stereo) or 'mono'."""
    if not w or not h: return 'mono'
    r = w / h
    return 'tb' if abs(r - 1) < 0.15 else ('sbs' if abs(r - 4) < 0.4 else 'mono')


def url(rel):
    return '/'.join(quote(p) for p in rel.replace('\\', '/').split('/'))


def pretty(name):
    s = re.sub(r'[_\-]+', ' ', name).strip()
    return s[:1].upper() + s[1:]


def walk(base, max_depth=2):
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        rel = os.path.relpath(dirpath, base)
        depth = 0 if rel == '.' else rel.count(os.sep) + 1
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.') and depth < max_depth]
        for fn in filenames:
            if not fn.startswith('.'):
                out.append(os.path.normpath(os.path.join(rel, fn)) if rel != '.' else fn)
    return sorted(out, key=lambda s: s.lower())


def make_thumb(src, dst, layout, force=False, kind='pano'):
    if not Image: return False
    if not force and os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src): return True
    try:
        with Image.open(src) as im:
            im.draft('RGB', (2048, 2048))                   # fast reduced-size JPEG decoding
            im = im.convert('RGB')
            w, h = im.size
            if layout == 'tb': im = im.crop((0, 0, w, h // 2))
            elif layout == 'sbs': im = im.crop((0, 0, w // 2, h))
            if kind == 'pano':                              # the forward view: less distortion than the full sphere
                w, h = im.size
                im = im.crop((w // 4, h // 4, w - w // 4, h - h // 4))
            if kind == 'photo':                             # centre crop to the 2:1 card
                w, h = im.size; th = min(h, w // 2); tw = th * 2
                im = im.crop(((w - tw) // 2, (h - th) // 2, (w - tw) // 2 + tw, (h - th) // 2 + th))
            im = im.resize((512, 256), Image.LANCZOS)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            im.save(dst, 'JPEG', quality=80, optimize=True)
        return True
    except Exception as e:
        print('  ! thumbnail failed:', src, e)
        return False


def scan_folder(fdir, kind, old=None, thumbs=True, force_thumbs=False, thumb_url=None, log=print):
    """Pair images with their depth maps and scenes in one library folder.
    fdir — absolute folder path; kind — 'pano' | 'photo'; old — {src: item} from an existing manifest.
    thumb_url(rel) — when given, thumbnails are not written and item['thumb'] = thumb_url(rel)."""
    old = old or {}
    by_dir = {}
    for f in walk(fdir):
        by_dir.setdefault(os.path.dirname(f), []).append(os.path.basename(f))
    items, seen, n_thumb = [], set(), 0
    for d, names in sorted(by_dir.items()):
        nameset = set(names)
        depth_for = {}
        for n in names:
            b, e = os.path.splitext(n)
            if e.lower() not in IMG: continue
            m = DEPTH.match(b)
            if m:
                k = m.group(1).lower()
                if k not in depth_for or e.lower() == '.png': depth_for[k] = n
        for n in names:
            b, e = os.path.splitext(n)
            if e.lower() not in IMG or DEPTH.match(b) or re.search(r'[._-](thumb|preview)$', b, re.I): continue
            rel = os.path.join(d, n) if d else n
            full = os.path.join(fdir, rel)
            w, h = image_size(full)
            lay = layout_of(w, h) if kind == 'pano' else 'mono'
            src = rel.replace(os.sep, '/')
            it = dict(old.get(src, {}))
            if it.get('hidden'): seen.add(src); continue
            it['src'] = url(src)
            it.setdefault('title', pretty(b))
            it.update({'kind': kind, 'w': w, 'h': h, 'size': os.path.getsize(full), 'album': d.replace(os.sep, '/')})
            it.pop('mtime', None)
            if thumb_url: it['mtime'] = int(os.path.getmtime(full))
            if b.lower() in depth_for: it['depth'] = url(os.path.join(d, depth_for[b.lower()]).replace(os.sep, '/'))
            if b + '.scene.json' in nameset: it['scene'] = url(os.path.join(d, b + '.scene.json').replace(os.sep, '/'))
            if thumb_url:
                it['thumb'] = thumb_url(src)
            elif thumbs and Image:
                trel = os.path.join('thumbs', d, b + '.jpg')
                if make_thumb(full, os.path.join(fdir, trel), it.get('layout', lay), force_thumbs, kind):
                    it['thumb'] = url(trel.replace(os.sep, '/')); n_thumb += 1
            items.append(it); seen.add(src)
            if log: log(f'  {src}  {w}x{h} {lay}' + ('  +depth' if 'depth' in it else '') + ('  +scene' if 'scene' in it else ''))
    # entries that exist only in the manifest (external URLs) are kept
    for src, it in old.items():
        if src not in seen and re.match(r'^(https?:)?//', src) and not it.get('hidden'): items.append(it)
    items.sort(key=lambda x: (x.get('order', 1e9), x.get('album', ''), x['src'].lower()))
    return items, n_thumb


def scan_models(mdir):
    models = []
    mf = walk(mdir)
    mset = set(mf)
    for f in mf:
        b, e = os.path.splitext(f)
        if e.lower() not in MODEL: continue
        it = {'src': url(f.replace(os.sep, '/')), 'title': pretty(os.path.basename(b)),
              'ext': e[1:].lower(), 'size': os.path.getsize(os.path.join(mdir, f)), 'album': os.path.dirname(f).replace(os.sep, '/')}
        for te in ('.jpg', '.jpeg', '.png', '.webp'):
            if b + te in mset: it['thumb'] = url((b + te).replace(os.sep, '/')); break
        models.append(it)
    return models


def read_manifest(path):
    old, title = {}, None
    if os.path.exists(path):
        try:
            j = json.load(open(path, encoding='utf-8'))
            title = j.get('title')
            for it in j.get('items', []):
                if isinstance(it, dict) and 'src' in it: old[unquote(it['src']).lstrip('/')] = it
        except Exception as e:
            print('  ! could not read', path, e)
    return old, title


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument('--no-thumbs', action='store_true')
    ap.add_argument('--force-thumbs', action='store_true')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    found = False
    for folder, kind in FOLDERS:
        fdir = os.path.join(root, folder)
        if not os.path.isdir(fdir): continue
        found = True
        mf_path = os.path.join(fdir, 'manifest.json')
        old, title = read_manifest(mf_path)
        print(f'{folder}/')
        items, n_thumb = scan_folder(fdir, kind, old, not a.no_thumbs, a.force_thumbs)
        out = {'generated': 'tools/build-manifest.py', 'items': items}
        if title: out['title'] = title
        json.dump(out, open(mf_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'{folder}/manifest.json: {len(items)} items, {n_thumb} thumbnails' + ('' if Image else ' (install Pillow for thumbnails)'))
    if not found:
        print('No panoramas/ or photos/ folder in', root); sys.exit(1)
    mdir = os.path.join(root, 'models')
    if os.path.isdir(mdir):
        models = scan_models(mdir)
        json.dump({'items': models}, open(os.path.join(mdir, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'models/manifest.json: {len(models)} models')


if __name__ == '__main__':
    main()
