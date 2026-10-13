"""Library on disk: panoramas/, photos/ and models/ under the data folder.

Pairing rules (image + _depth map + .scene.json, albums, manifest overrides) come from
web/tools/build-manifest.py, so a static host and the server list files the same way.
"""
from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import shutil
import unicodedata
from urllib.parse import quote

LIBS = {'panoramas': 'pano', 'photos': 'photo'}
KIND_DIR = {v: k for k, v in LIBS.items()}
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.avif')
MODEL_EXT = ('.glb', '.gltf', '.bin', '.obj', '.mtl', '.stl', '.ply', '.fbx', '.3mf', '.dae', '.usdz', '.drc',
             '.splat', '.ksplat', '.spz', '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.basis')
MAX_SCENE = 2 * 1024 * 1024


def _load_manifest_tool(web_dir: str):
    path = os.path.join(web_dir, 'tools', 'build-manifest.py')
    spec = importlib.util.spec_from_file_location('nomono3d_build_manifest', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def safe_name(name: str, default='image') -> str:
    """A file name that is safe on any file system but keeps non-Latin letters."""
    name = unicodedata.normalize('NFC', os.path.basename(name or '')).strip()
    name = re.sub(r'[\\/:*?"<>|#%\x00-\x1f]+', '_', name)
    name = re.sub(r'\s+', '_', name).strip('._') or default
    return name[:120]


class Library:
    def __init__(self, web_dir: str, data_dir: str):
        self.web_dir = os.path.abspath(web_dir)
        self.data_dir = os.path.abspath(data_dir)
        self.tool = _load_manifest_tool(self.web_dir)
        for d in list(LIBS) + ['models']:
            os.makedirs(os.path.join(self.data_dir, d), exist_ok=True)

    def seed_demo(self):
        """Copy the demo panoramas, photos and model into an empty data folder."""
        if self.data_dir == self.web_dir:
            return
        for d in list(LIBS) + ['models']:
            src, dst = os.path.join(self.web_dir, d), os.path.join(self.data_dir, d)
            if not os.path.isdir(src) or any(not n.startswith('.') for n in os.listdir(dst)):
                continue
            for n in os.listdir(src):
                s = os.path.join(src, n)
                if n in ('thumbs', '.thumbs'):
                    continue
                if os.path.isdir(s):
                    shutil.copytree(s, os.path.join(dst, n), dirs_exist_ok=True)
                else:
                    shutil.copy2(s, os.path.join(dst, n))

    # ── listing ──
    def list(self) -> dict:
        out = {'version': 2, 'source': 'server', 'title': None}
        for d, kind in LIBS.items():
            fdir = os.path.join(self.data_dir, d)
            old, title = self.tool.read_manifest(os.path.join(fdir, 'manifest.json'))
            out['title'] = out['title'] or title
            items, _ = self.tool.scan_folder(fdir, kind, old, thumbs=False,
                                             thumb_url=lambda rel, d=d: 'api/thumb?src=' + quote(d + '/' + rel), log=None)
            for it in items:
                for k in ('src', 'depth', 'scene'):
                    if k in it and not re.match(r'^(https?:)?//', it[k]):
                        it[k] = quote(d) + '/' + it[k]
                it['id'] = (it.get('album') + '/' if it.get('album') else '') + os.path.splitext(os.path.basename(it['src']))[0]
            out[d] = items
        mdir = os.path.join(self.data_dir, 'models')
        models = self.tool.scan_models(mdir) if os.path.isdir(mdir) else []
        for m in models:
            m['src'] = 'models/' + m['src']
            if 'thumb' in m:
                m['thumb'] = 'models/' + m['thumb']
        out['models'] = models
        return out

    # ── paths ──
    def resolve(self, rel: str) -> tuple[str, str] | None:
        """Library-relative path ('panoramas/Album/x.jpg') → (absolute path, library folder) or None."""
        rel = (rel or '').replace('\\', '/').lstrip('/')
        top = rel.split('/', 1)[0]
        if top not in LIBS or '..' in rel.split('/') or '\x00' in rel:
            return None
        base = os.path.realpath(os.path.join(self.data_dir, top))
        p = os.path.realpath(os.path.join(self.data_dir, rel))
        if not p.startswith(base + os.sep) or not os.path.isfile(p):
            return None
        return p, top

    def thumbnail(self, rel: str) -> bytes | None:
        hit = self.resolve(rel)
        if not hit:
            return None
        path, top = hit
        if os.path.splitext(path)[1].lower() not in IMG_EXT:
            return None
        key = hashlib.md5(f'{rel}|{os.path.getmtime(path)}|v4'.encode()).hexdigest()
        cache = os.path.join(self.data_dir, top, '.thumbs', key + '.jpg')
        if not os.path.exists(cache):
            w, h = self.tool.image_size(path)
            kind = LIBS[top]
            lay = self.tool.layout_of(w, h) if kind == 'pano' else 'mono'
            if not self.tool.make_thumb(path, cache, lay, True, kind):
                return None
        with open(cache, 'rb') as f:
            return f.read()

    # ── writing ──
    def save_upload(self, kind: str, filename: str, data: bytes, depth: bytes | None = None, album: str = '') -> str:
        top = KIND_DIR.get(kind)
        if not top:
            raise ValueError('kind must be "pano" or "photo"')
        sub = '/'.join(safe_name(p, 'album') for p in (album or '').split('/') if p.strip())[:120]
        folder = os.path.join(self.data_dir, top, sub)
        os.makedirs(folder, exist_ok=True)
        name = safe_name(filename)
        base, ext = os.path.splitext(name)
        if ext.lower() not in IMG_EXT:
            ext = '.jpg'
        n, cand = 1, base + ext
        while os.path.exists(os.path.join(folder, cand)):
            n += 1
            cand = f'{base}-{n}{ext}'
        with open(os.path.join(folder, cand), 'wb') as f:
            f.write(data)
        if depth:
            with open(os.path.join(folder, os.path.splitext(cand)[0] + '_depth.png'), 'wb') as f:
                f.write(depth)
        return '/'.join(x for x in (top, sub, cand) if x)

    def save_depth_next_to(self, rel: str, png: bytes) -> str | None:
        """Store a generated depth map as <image>_depth.png beside a library image."""
        hit = self.resolve(rel)
        if not hit:
            return None
        path, _ = hit
        out = os.path.splitext(path)[0] + '_depth.png'
        with open(out, 'wb') as f:
            f.write(png)
        return os.path.relpath(out, self.data_dir).replace(os.sep, '/')

    def save_scene_next_to(self, rel: str, text: str) -> str | None:
        """Store a scene (3D objects) as <image>.scene.json beside a library image."""
        hit = self.resolve(rel)
        if not hit or len(text) > MAX_SCENE:
            return None
        import json
        data = json.loads(text)                         # must be valid JSON
        if not isinstance(data, dict) or data.get('format') != 'nomono3d-scene':
            raise ValueError('not a nomono3d scene')
        path, _ = hit
        out = os.path.splitext(path)[0] + '.scene.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        return os.path.relpath(out, self.data_dir).replace(os.sep, '/')

    def has_depth(self, rel: str) -> bool:
        hit = self.resolve(rel)
        return bool(hit) and os.path.isfile(os.path.splitext(hit[0])[0] + '_depth.png')

    def save_model(self, name: str, parts: list[tuple[str, bytes]], main: str) -> str:
        """Store an uploaded model (one file, or glTF/OBJ with its textures) under models/shared/."""
        root = os.path.join(self.data_dir, 'models', 'shared')
        base = safe_name(os.path.splitext(name or main or 'model')[0], 'model')[:60]
        n, folder = 1, os.path.join(root, base)
        while os.path.exists(folder):
            n += 1
            folder = os.path.join(root, f'{base}-{n}')
        written = []
        for rel, data in parts:
            segs = [safe_name(x, 'file') for x in (rel or '').replace('\\', '/').split('/') if x and x not in ('.', '..')]
            if not segs or os.path.splitext(segs[-1])[1].lower() not in MODEL_EXT:
                continue
            p = os.path.join(folder, *segs)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.write(data)
            written.append('/'.join(segs))
        if not written:
            raise ValueError('no model files')
        msegs = [safe_name(x, 'file') for x in (main or '').replace('\\', '/').split('/') if x and x not in ('.', '..')]
        m = '/'.join(msegs) if '/'.join(msegs) in written else written[0]
        return os.path.relpath(os.path.join(folder, *m.split('/')), self.data_dir).replace(os.sep, '/')
