"""AI inpainting of the background revealed behind foreground objects (photo mode).

    MiganInpaint — MI-GAN (Sargsyan et al., "MI-GAN: A Simple Baseline for Image Inpainting
    on Mobile Devices", ICCV 2023; Picsart AI Research, MIT licence). A TorchScript export of
    the Places2 512 model is downloaded once (~27 MB) into the cache folder.

The web app sends the photo at its working resolution and a mask (white = to fill); the
server answers with the filled image as PNG. Only the masked texels are used by the app.
MI-GAN works on 512 × 512 tiles, so the photo is processed in overlapping tiles at its own
resolution (the masked band along object outlines is narrow, a tile is plenty of context) and
the tiles are blended with feathered weights.
"""
from __future__ import annotations

import hashlib
import io
import os
import urllib.request

import numpy as np

from .depth import GPU_LOCK, _Backend, _torch, is_oom, resize

# TorchScript export of the official Places2 512 checkpoint, as used by IOPaint
MIGAN_URLS = [
    'https://github.com/Sanster/models/releases/download/migan/migan_traced.pt',
]
MIGAN_MD5 = '76eb3b1a71c400ee3290524f7a11b89c'
TILE = 512
STEP = 384
MAX_R = 48          # widest hole, in texels from its edge, that is filled at full resolution


def _download(urls: list[str], dst: str, md5: str | None = None) -> str:
    if os.path.exists(dst) and os.path.getsize(dst) > 1_000_000:
        return dst
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    last = None
    for url in urls:
        try:
            tmp = dst + '.part'
            h = hashlib.md5()
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'nomono3d'}), timeout=60) as r, open(tmp, 'wb') as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b); h.update(b)
            if md5 and h.hexdigest() != md5:
                print(f'inpaint: checksum differs for {url} ({h.hexdigest()}), using it anyway', flush=True)
            os.replace(tmp, dst)
            return dst
        except Exception as e:          # try the next mirror
            last = e
    raise RuntimeError(f'could not download the MI-GAN model: {last}')


def _starts(n: int) -> list[int]:
    """Tile origins along one axis: every STEP texels, the last tile flush with the edge."""
    if n <= TILE:
        return [0]
    s = list(range(0, n - TILE, STEP))
    return s + [n - TILE]


class MiganInpaint(_Backend):
    """MI-GAN: a small, fast GAN for large-mask inpainting; one forward pass per 512 tile."""
    name = 'MI-GAN'

    def __init__(self, device='cuda', cache_dir='.cache', max_side=2048):
        super().__init__(device, cache_dir)
        self.max_side = int(max_side)

    def _load(self):
        torch = _torch()
        path = _download(MIGAN_URLS, os.path.join(self.cache_dir, 'migan', 'migan_traced.pt'), MIGAN_MD5)
        return torch.jit.load(path, map_location='cpu').to(self.device).eval()

    def _tile(self, rgb: np.ndarray, m: np.ndarray) -> np.ndarray:
        """One 512 × 512 tile: rgb uint8 (512, 512, 3), m float32 (512, 512) with 1 = fill."""
        torch = _torch()
        img = torch.from_numpy(rgb).permute(2, 0, 1)[None].float().div(127.5).sub(1).to(self.device)
        msk = torch.from_numpy(m)[None, None].to(self.device)
        x = torch.cat([0.5 - msk, img * (1 - msk)], 1)
        with torch.inference_mode():
            out = self.model(x)
        return (out[0].permute(1, 2, 0) * 127.5 + 127.5).round().clamp(0, 255).byte().cpu().numpy()

    def _infer(self, rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """Thin holes (the band along object outlines) are filled at full resolution. A thick hole
        would leave a tile with little to see, so the image is scaled down until the widest part of
        the hole is at most MAX_R texels from its edge, filled, and scaled back up."""
        from scipy.ndimage import distance_transform_edt
        sel = mask > 127
        if not sel.any():
            return rgb
        r = float(distance_transform_edt(sel).max())
        k = min(1.0, MAX_R / max(r, 1.0))
        h, w = rgb.shape[:2]
        if k < 0.95 and min(h, w) * k >= 64:
            sz = (max(1, round(w * k)), max(1, round(h * k)))
            from PIL import Image
            msk = np.asarray(Image.fromarray(sel.astype(np.uint8) * 255).resize(sz, Image.NEAREST)) > 127
            small = self._tiles(resize(rgb, *sz), msk)
            big = resize(small, w, h)
            return np.where(sel[..., None], big, rgb)
        return self._tiles(rgb, sel)

    def _tiles(self, rgb: np.ndarray, sel: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        # pad small sides up to a tile by reflection
        ph, pw = max(0, TILE - h), max(0, TILE - w)
        img = np.pad(rgb, ((0, ph), (0, pw), (0, 0)), mode='symmetric') if ph or pw else rgb
        msk = np.pad(sel, ((0, ph), (0, pw)), mode='symmetric') if ph or pw else sel
        H, W = msk.shape
        acc = np.zeros((H, W, 3), np.float32)
        wsum = np.zeros((H, W), np.float32)
        # feather: weight grows from the tile border inwards, so seams between tiles blend
        r = np.minimum(np.arange(TILE), np.arange(TILE)[::-1]).astype(np.float32) + 1
        feather = np.minimum.outer(r, r)
        mf = msk.astype(np.float32)
        for y in _starts(H):
            for x in _starts(W):
                mt = mf[y:y + TILE, x:x + TILE]
                if not mt.any():
                    continue
                out = self._tile(np.ascontiguousarray(img[y:y + TILE, x:x + TILE]), np.ascontiguousarray(mt))
                wt = feather * mt
                acc[y:y + TILE, x:x + TILE] += out * wt[..., None]
                wsum[y:y + TILE, x:x + TILE] += wt
        fill = (acc / np.maximum(wsum, 1e-6)[..., None]).round().clip(0, 255).astype(np.uint8)[:h, :w]
        return np.where(sel[..., None], fill, rgb)          # unmasked texels stay exactly as sent

    def inpaint(self, rgb: np.ndarray, mask: np.ndarray) -> tuple[bytes, dict]:
        from PIL import Image
        if mask.shape[:2] != rgb.shape[:2]:
            mask = np.asarray(Image.fromarray(mask).resize((rgb.shape[1], rgb.shape[0]), Image.NEAREST))
        h, w = rgb.shape[:2]
        k = min(1.0, self.max_side / max(h, w))
        if k < 1:                               # the app sends its working resolution; this is a guard
            sz = (max(8, int(w * k)), max(8, int(h * k)))
            rgb = np.asarray(Image.fromarray(rgb).resize(sz, Image.LANCZOS))
            mask = np.asarray(Image.fromarray(mask).resize(sz, Image.NEAREST))
        self.ensure()
        with GPU_LOCK:
            try:
                out = self._infer(rgb, mask)
            except (RuntimeError, MemoryError) as e:
                if not (is_oom(e) or isinstance(e, MemoryError)) or self.device != 'cuda':
                    raise
                _torch().cuda.empty_cache()
                print('inpaint: out of GPU memory, running on the CPU', flush=True)
                self.model = self.model.to('cpu'); dev, self.device = self.device, 'cpu'
                try:
                    out = self._infer(rgb, mask)
                finally:
                    self.model = self.model.to(dev); self.device = dev
            finally:
                if self.device == 'cuda':
                    _torch().cuda.empty_cache()
        buf = io.BytesIO()
        Image.fromarray(out).save(buf, format='PNG', compress_level=3)
        return buf.getvalue(), {'model': self.name, 'size': f'{out.shape[1]}x{out.shape[0]}'}
