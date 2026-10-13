"""nomono3d server: the web app, the library and GPU depth estimation behind one origin.

    GET  /                  the web app (web/)
    GET  /api/health        server capabilities (the app checks it on start)
    POST /api/depth         image → depth map PNG (kind = pano | photo)
    GET  /api/list          library listing: panoramas, photos, models
    GET  /api/thumb?src=    library thumbnail
    POST /api/library       save an image (and its depth map) into the library
    POST /api/share         store a scene (and a missing depth map) beside a library image
    POST /api/model         store an uploaded 3D model under models/shared/
    POST /api/inpaint       image + mask → image with the masked part filled (MI-GAN)
"""
from __future__ import annotations

import os
import traceback
from urllib.parse import quote

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .library import LIBS, Library

MAX_UPLOAD = 300 * 1024 * 1024


def decode_image(data: bytes) -> np.ndarray:
    """Bytes → RGB uint8 (EXIF orientation applied, alpha dropped)."""
    from PIL import Image, ImageOps
    import io
    Image.MAX_IMAGE_PIXELS = None
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        return np.asarray(im.convert('RGB'))


class Engines:
    """Depth back-ends, created lazily so the server starts instantly."""

    def __init__(self, pano='large', photo='large', device='auto', cache_dir='.cache', photo_res=1022, inpaint='migan'):
        from .depth import pick_device, device_label
        self.device = pick_device(device)
        self.label = device_label(self.device)
        self.cache_dir = cache_dir
        self.pano = self.photo = None
        if pano and pano != 'none':
            from .depth import PanoDepth
            self.pano = PanoDepth(pano, self.device, cache_dir)
        if photo and photo != 'none':
            from .depth import PhotoDepth
            self.photo = PhotoDepth(photo, self.device, cache_dir, photo_res)
        self.inpaint = None
        if inpaint and inpaint != 'none':
            from .inpaint import MiganInpaint
            self.inpaint = MiganInpaint(self.device, cache_dir)

    def get(self, kind):
        return self.pano if kind == 'pano' else self.photo if kind == 'photo' else None

    def _all(self):
        return (('pano', self.pano), ('photo', self.photo), ('inpaint', self.inpaint))

    def info(self):
        return {k: (e.name if e else None) for k, e in self._all()}

    def loaded(self):
        return {k: bool(e and e.model is not None) for k, e in self._all()}

    def errors(self):
        return {k: e.error for k, e in self._all() if e and e.error}

    def preload(self, log=print):
        for e in (self.photo, self.inpaint, self.pano):   # smaller models first: ready sooner
            if e:
                log(f'loading {e.name} on {self.label} …')
                try:
                    e.ensure()
                    log(f'  {e.name} ready in {e.load_s} s')
                except Exception as err:
                    log(f'  ! {e.name} failed to load: {type(err).__name__}: {err}')


class NoCacheCode:
    """Code and lists are revalidated on every load, so an update is seen at once."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope.get('path', '')

        async def send2(msg):
            if msg['type'] == 'http.response.start' and (path.endswith(('.html', '.js', '.json', '.webmanifest', '/')) or path.startswith('/api/list')):
                hdrs = [(k, v) for k, v in msg.get('headers', []) if k.lower() != b'cache-control']
                hdrs.append((b'cache-control', b'no-cache'))
                msg['headers'] = hdrs
            await send(msg)
        return await self.app(scope, receive, send2)


def create_app(web_dir: str, data_dir: str | None = None, engines: Engines | None = None, upload=True) -> FastAPI:
    web_dir = os.path.abspath(web_dir)
    data_dir = os.path.abspath(data_dir or web_dir)
    lib = Library(web_dir, data_dir)
    lib.seed_demo()
    app = FastAPI(title='nomono3d', version=__version__, docs_url='/api/docs', redoc_url=None, openapi_url='/api/openapi.json')

    @app.get('/api/health')
    def health():
        return {
            'app': 'nomono3d', 'version': __version__,
            'device': engines.label if engines else None,
            'depth': {k: v for k, v in engines.info().items() if k != 'inpaint'} if engines else {'pano': None, 'photo': None},
            'inpaint': engines.info().get('inpaint') if engines else None,
            'loaded': engines.loaded() if engines and hasattr(engines, 'loaded') else {},
            'errors': engines.errors() if engines and hasattr(engines, 'errors') else {},
            'upload': bool(upload),
        }

    @app.post('/api/depth')
    async def depth(file: UploadFile = File(...), kind: str = Form('photo'), library_src: str | None = Form(None)):
        eng = engines.get(kind) if engines else None
        if not eng:
            raise HTTPException(400, f'No depth model for "{kind}" on this server.')
        if getattr(eng, 'model', True) is None:
            # Loading can take minutes (download + GPU); answer at once so proxies do not time out
            if getattr(eng, 'error', None) and not eng.loading:
                raise HTTPException(500, f'{eng.name} failed to load: {eng.error}')
            eng.load_async()
            return JSONResponse({'detail': f'{eng.name} is loading, try again shortly.', 'loading': True},
                                status_code=503, headers={'Retry-After': '5'})
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, 'Image too large.')
        try:
            rgb = decode_image(data)
        except Exception:
            raise HTTPException(415, 'Unsupported or broken image file.')
        try:
            png, meta = await run_in_threadpool(eng.estimate, rgb)
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(500, f'Depth estimation failed: {type(e).__name__}: {e}')
        headers = {'X-Depth-Model': meta['model'], 'X-Depth-Size': meta['size'], 'Cache-Control': 'no-store'}
        if library_src and upload:
            saved = lib.save_depth_next_to(library_src, png)
            if saved:
                headers['X-Depth-Saved'] = quote(saved)          # headers are Latin-1; the app decodes
        return Response(png, media_type='image/png', headers=headers)

    @app.post('/api/inpaint')
    async def inpaint(file: UploadFile = File(...), mask: UploadFile = File(...)):
        eng = getattr(engines, 'inpaint', None) if engines else None
        if not eng:
            raise HTTPException(400, 'No inpainting model on this server.')
        if eng.model is None:
            if eng.error and not eng.loading:
                raise HTTPException(500, f'{eng.name} failed to load: {eng.error}')
            eng.load_async()
            return JSONResponse({'detail': f'{eng.name} is loading, try again shortly.', 'loading': True},
                                status_code=503, headers={'Retry-After': '5'})
        data, mdata = await file.read(), await mask.read()
        if len(data) > MAX_UPLOAD or len(mdata) > MAX_UPLOAD:
            raise HTTPException(413, 'Image too large.')
        try:
            rgb = decode_image(data)
            from PIL import Image
            import io
            with Image.open(io.BytesIO(mdata)) as im:
                m = np.asarray(im.convert('L'))
        except Exception:
            raise HTTPException(415, 'Unsupported or broken image file.')
        try:
            png, meta = await run_in_threadpool(eng.inpaint, rgb, m)
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(500, f'Inpainting failed: {type(e).__name__}: {e}')
        return Response(png, media_type='image/png', headers={'X-Inpaint-Model': meta['model'], 'Cache-Control': 'no-store'})

    @app.get('/api/list')
    def listing():
        return JSONResponse(lib.list())

    @app.get('/api/thumb')
    def thumb(src: str):
        b = lib.thumbnail(src)
        if b is None:
            raise HTTPException(404)
        return Response(b, media_type='image/jpeg', headers={'Cache-Control': 'public, max-age=86400'})

    @app.post('/api/library')
    async def save(file: UploadFile = File(...), depth: UploadFile | None = File(None), kind: str = Form('photo'), album: str = Form('')):
        if not upload:
            raise HTTPException(403, 'Uploads are disabled on this server.')
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, 'Image too large.')
        try:
            decode_image(data)                      # reject non-images
        except Exception:
            raise HTTPException(415, 'Unsupported or broken image file.')
        dep = await depth.read() if depth is not None else None
        try:
            rel = lib.save_upload(kind, file.filename or 'image.jpg', data, dep, album)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {'ok': True, 'src': rel}

    @app.post('/api/share')
    async def share(src: str = Form(...), scene: str | None = Form(None), depth: UploadFile | None = File(None)):
        if not upload:
            raise HTTPException(403, 'Uploads are disabled on this server.')
        from urllib.parse import unquote
        rel = unquote(src)
        if not lib.resolve(rel):
            raise HTTPException(404, 'Not a library image: ' + rel)
        out = {'ok': True, 'src': rel}
        if depth is not None and not lib.has_depth(rel):
            out['depth'] = lib.save_depth_next_to(rel, await depth.read())
        if scene:
            try:
                out['scene'] = lib.save_scene_next_to(rel, scene)
            except ValueError as e:
                raise HTTPException(400, str(e))
        return out

    @app.post('/api/model')
    async def model(files: list[UploadFile] = File(...), name: str = Form('model'), main: str = Form('')):
        if not upload:
            raise HTTPException(403, 'Uploads are disabled on this server.')
        parts, total = [], 0
        for f in files[:64]:
            data = await f.read()
            total += len(data)
            if total > MAX_UPLOAD:
                raise HTTPException(413, 'Model too large.')
            parts.append((f.filename or 'model.glb', data))
        try:
            return {'ok': True, 'src': lib.save_model(name, parts, main)}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.exception_handler(404)
    async def not_found(request: Request, exc):
        return JSONResponse({'detail': 'Not found'}, status_code=404)

    # library folders from the data folder (they may live outside web/, e.g. on Google Drive)
    if data_dir != web_dir:
        for d in list(LIBS) + ['models']:
            app.mount('/' + d, StaticFiles(directory=os.path.join(data_dir, d)), name='lib-' + d)
    app.mount('/', StaticFiles(directory=web_dir, html=True), name='web')
    app.add_middleware(NoCacheCode)
    return app
