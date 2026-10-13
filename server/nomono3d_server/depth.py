"""Depth estimation back-ends.

    PanoDepth   — DA360 (Insta360 Research, MIT): monocular depth for equirectangular 360° panoramas.
    PhotoDepth  — Depth Anything V2 (Hugging Face transformers): monocular depth for ordinary photos.

Both return *relative inverse depth* (disparity): larger = nearer. `to_png()` turns it into the
8-bit greyscale map the web app reads (white = near).
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import numpy as np


def resize(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Resize an RGB uint8 image or a float32 map: box filter down, bicubic up (Pillow)."""
    from PIL import Image
    if a.shape[1] == w and a.shape[0] == h:
        return a
    f = Image.BOX if w < a.shape[1] else Image.BICUBIC
    if a.dtype == np.uint8:
        return np.asarray(Image.fromarray(a).resize((w, h), f))
    return np.asarray(Image.fromarray(a.astype(np.float32)).resize((w, h), f))


DA360_REPO = 'https://github.com/Insta360-Research-Team/DA360.git'
DA360_COMMIT = 'a0e9d33d9bcfabd6842b255e4ce0ba728db52853'   # tested revision
DA360_HF = 'hljiang/DA360'                                    # checkpoints on Hugging Face
# Mirror of the checkpoints on Google Drive (file ids), used if Hugging Face is unreachable
DA360_CKPT = {
    'small': '17CEsiWRvGPKVrEOonGLXYcxobLK8idId',
    'base': '1NYF4yJR83HEtxzOURLdmONeUe413auP6',
    'large': '1cWEUZP-uBuk6WlUi0KJF3zdd05ckHKuR',
}
DAV2 = {
    'small': 'depth-anything/Depth-Anything-V2-Small-hf',   # Apache-2.0
    'base': 'depth-anything/Depth-Anything-V2-Base-hf',     # CC-BY-NC-4.0
    'large': 'depth-anything/Depth-Anything-V2-Large-hf',   # CC-BY-NC-4.0
}
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
GPU_LOCK = threading.Lock()          # one inference at a time on the device, whatever the model


def is_oom(e: BaseException) -> bool:
    m = str(e).lower()
    return 'out of memory' in m or 'not enough memory' in m or 'alloc_failed' in m
STD = np.array([0.229, 0.224, 0.225], np.float32)


def _torch():
    import torch
    return torch


def pick_device(pref: str | None = None) -> str:
    torch = _torch()
    if pref and pref != 'auto':
        return pref
    if torch.cuda.is_available():
        return 'cuda'
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def device_label(device: str) -> str:
    torch = _torch()
    if device == 'cuda' and torch.cuda.is_available():
        return 'cuda · ' + torch.cuda.get_device_name(0)
    return device


def layout_of(w: int, h: int) -> str:
    r = w / max(h, 1)
    return 'tb' if abs(r - 1) < 0.15 else ('sbs' if abs(r - 4) < 0.4 else 'mono')


def left_eye(rgb: np.ndarray) -> np.ndarray:
    """Left eye of a top-bottom (1:1) or side-by-side (4:1) stereo panorama; mono unchanged."""
    h, w = rgb.shape[:2]
    lay = layout_of(w, h)
    if lay == 'tb':
        return rgb[: h // 2]
    if lay == 'sbs':
        return rgb[:, : w // 2]
    return rgb


def normalise(disp: np.ndarray, lo_pct=1.0, hi_pct=99.5) -> np.ndarray:
    """Robust 0..1 normalisation of a disparity map (1 = nearest)."""
    d = disp.astype(np.float32)
    d[~np.isfinite(d)] = np.nanmin(d[np.isfinite(d)]) if np.isfinite(d).any() else 0
    lo, hi = np.percentile(d, [lo_pct, hi_pct])
    if hi - lo < 1e-8:
        hi = lo + 1e-8
    return np.clip((d - lo) / (hi - lo), 0, 1)


def to_png(dn: np.ndarray, width: int, height: int) -> bytes:
    """0..1 map → 8-bit greyscale PNG of the requested size (white = near)."""
    import io
    from PIL import Image
    dn = np.clip(resize(dn, width, height), 0, 1)
    buf = io.BytesIO()
    Image.fromarray(np.round(dn * 255).astype(np.uint8)).save(buf, format='PNG', compress_level=6)
    return buf.getvalue()


class _Backend:
    """Lazy model holder: loads on first use; inference is serialised across all back-ends."""
    name = 'depth'

    def __init__(self, device: str, cache_dir: str):
        self.device = device
        self.cache_dir = cache_dir
        self.model = None
        self.lock = threading.Lock()         # guards loading
        self.loading = False
        self.error = None
        self.load_s = None

    def ensure(self):
        if self.model is None:
            with self.lock:
                if self.model is None:
                    self.loading = True
                    t0 = time.time()
                    try:
                        self.model = self._load()
                        self.error = None
                    except Exception as e:
                        self.error = f'{type(e).__name__}: {e}'
                        raise
                    finally:
                        self.loading = False
                    self.load_s = round(time.time() - t0, 1)
        return self.model

    def load_async(self):
        """Start loading in the background (no-op if loaded or already loading)."""
        if self.model is None and not self.loading:
            self.loading = True              # set before the thread starts, so callers see it at once

            def run():
                try:
                    self.ensure()
                except Exception:
                    pass
            threading.Thread(target=run, daemon=True).start()

    def _load(self):  # pragma: no cover - abstract
        raise NotImplementedError

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        self.ensure()
        with GPU_LOCK:
            return self._infer(rgb)


class PanoDepth(_Backend):
    """DA360: equirectangular depth with automatic resolution step-down on GPU out-of-memory."""

    INFER_WIDTHS = [2072, 1540, 1036, 728]          # multiples of 28; 2:1 inputs

    def __init__(self, size='large', device='cuda', cache_dir='.cache'):
        super().__init__(device, cache_dir)
        self.size = size
        self.name = f'DA360 {size}'
        self._ok = 0 if device == 'cuda' else 2          # CPU / MPS: start at 1036 px

    def _repo(self) -> str:
        root = os.path.join(self.cache_dir, 'DA360')
        if not os.path.isdir(os.path.join(root, 'networks')):
            os.makedirs(root, exist_ok=True)
            git = ['git', '-C', root]
            subprocess.check_call(git + ['init', '-q'])
            subprocess.run(git + ['remote', 'add', 'origin', DA360_REPO], check=False)
            if subprocess.run(git + ['fetch', '-q', '--depth', '1', 'origin', DA360_COMMIT]).returncode:
                subprocess.check_call(git + ['fetch', '-q', '--depth', '1', 'origin'])   # pinned revision gone: latest
            subprocess.check_call(git + ['checkout', '-q', 'FETCH_HEAD'])
        return root

    def _checkpoint(self, root: str) -> str:
        ckpt = os.path.join(root, 'checkpoints', f'DA360_{self.size}.pth')
        if os.path.exists(ckpt) and os.path.getsize(ckpt) > 1_000_000:
            return ckpt
        try:
            from huggingface_hub import hf_hub_download
            return hf_hub_download(DA360_HF, f'DA360_{self.size}.pth', cache_dir=os.path.join(self.cache_dir, 'hf'))
        except Exception as e:
            print(f'Hugging Face download failed ({e}); trying the Google Drive mirror', flush=True)
        import gdown
        os.makedirs(os.path.dirname(ckpt), exist_ok=True)
        gdown.download(id=DA360_CKPT[self.size], output=ckpt, quiet=False)
        return ckpt

    @staticmethod
    def _patch_attention():
        """DINOv2 in DA360 falls back to plain attention without xformers: the full N×N matrix
        does not fit a 16 GB GPU at 2072 px. PyTorch's fused attention is the same maths."""
        import torch.nn.functional as F
        from depth_anything_v2.dinov2_layers import attention as A

        def forward(self, x):
            B, N, C = x.shape
            qkv = self.qkv(x).reshape(B, N, 3, self.num_heads, C // self.num_heads).permute(2, 0, 3, 1, 4)
            x = F.scaled_dot_product_attention(qkv[0], qkv[1], qkv[2])
            return self.proj_drop(self.proj(x.transpose(1, 2).reshape(B, N, C)))
        A.Attention.forward = forward

    def _load(self):
        torch = _torch()
        root = self._repo()
        if root not in sys.path:
            sys.path.insert(0, root)
        import networks  # noqa: E402  (from the DA360 repository)
        self._patch_attention()
        ckpt = self._checkpoint(root)
        try:
            c = torch.load(ckpt, map_location='cpu', weights_only=False)
        except TypeError:
            c = torch.load(ckpt, map_location='cpu')
        c.setdefault('dinov2_encoder', 'vits')
        w = self.INFER_WIDTHS[0]
        net = networks.DA360(w // 2, w, dinov2_encoder=c['dinov2_encoder']).to(self.device)
        sd = net.state_dict()
        net.load_state_dict({k: v for k, v in c.items() if k in sd}, strict=False)
        net.eval()
        return net

    def _infer(self, rgb: np.ndarray) -> np.ndarray:
        torch = _torch()
        last = None
        for i in range(self._ok, len(self.INFER_WIDTHS)):
            w = self.INFER_WIDTHS[i]
            h = w // 2
            oom = False
            try:
                x = resize(rgb, w, h)
                x = (x.astype(np.float32) / 255 - MEAN) / STD
                t = torch.from_numpy(x).permute(2, 0, 1).unsqueeze(0).to(self.device)
                with torch.no_grad():
                    disp = self.model(t)['pred_disp'].float().cpu().numpy()[0, 0]
                del t
                self._ok = i                       # remember the resolution that fits this device
                return disp
            except (RuntimeError, MemoryError) as e:
                if not is_oom(e) and not isinstance(e, MemoryError):
                    raise
                last, oom = str(e)[:300], True     # keep only the text: the exception pins the tensors
            finally:
                if self.device == 'cuda':
                    torch.cuda.empty_cache()
            if oom and self.device == 'cuda':
                torch.cuda.empty_cache()           # now that the failed frame is released
        raise RuntimeError(f'out of memory even at {self.INFER_WIDTHS[-1]} px: {last}')

    def estimate(self, rgb: np.ndarray, max_width=4096) -> tuple[bytes, dict]:
        eye = left_eye(rgb)
        disp = self(eye)
        dn = normalise(disp, 2.0, 99.5)
        ow = int(min(max_width, max(1024, eye.shape[1])))
        ow -= ow % 2
        return to_png(dn, ow, ow // 2), {'model': self.name, 'size': f'{ow}x{ow // 2}', 'infer': f'{disp.shape[1]}x{disp.shape[0]}'}


class PhotoDepth(_Backend):
    """Depth Anything V2 for flat photos, with horizontal-flip test-time augmentation."""

    def __init__(self, size='large', device='cuda', cache_dir='.cache', resolution=1022):
        super().__init__(device, cache_dir)
        self.model_id = DAV2.get(size.lower(), size)          # a size or any Hugging Face model id
        self.name = 'Depth Anything V2 ' + size.capitalize() if size.lower() in DAV2 else size
        self.resolution = int(resolution) if device == 'cuda' else min(int(resolution), 770)

    def _load(self):
        torch = _torch()
        from transformers import AutoModelForDepthEstimation
        dtype = torch.float16 if self.device == 'cuda' else torch.float32
        # dtype is set after loading: the keyword changed between transformers versions
        m = AutoModelForDepthEstimation.from_pretrained(self.model_id, cache_dir=os.path.join(self.cache_dir, 'hf'))
        return m.to(device=self.device, dtype=dtype).eval()

    def _infer(self, rgb: np.ndarray, resolution: int) -> np.ndarray:
        torch = _torch()
        h, w = rgb.shape[:2]
        k = resolution / max(h, w)
        nh, nw = max(14, int(round(h * k / 14)) * 14), max(14, int(round(w * k / 14)) * 14)
        x = resize(rgb, nw, nh)
        x = (x.astype(np.float32) / 255 - MEAN) / STD
        t = torch.from_numpy(x).permute(2, 0, 1).unsqueeze(0)
        t = torch.cat([t, torch.flip(t, dims=[3])], 0).to(self.device, dtype=next(self.model.parameters()).dtype)
        with torch.no_grad():
            d = self.model(pixel_values=t).predicted_depth.float()
        d = 0.5 * (d[0] + torch.flip(d[1], dims=[1]))
        return d.cpu().numpy()

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        self.ensure()
        with GPU_LOCK:
            res = self.resolution
            while True:
                try:
                    return self._infer(rgb, res)
                except (RuntimeError, MemoryError) as e:
                    if not (is_oom(e) or isinstance(e, MemoryError)) or res <= 518:
                        raise
                    msg = str(e)[:200]
                finally:
                    if self.device == 'cuda':
                        _torch().cuda.empty_cache()
                print(f'photo depth: out of memory at {res} px, retrying smaller ({msg})', flush=True)
                res = max(518, int(res * 0.75) // 14 * 14)

    def estimate(self, rgb: np.ndarray, max_side=2048) -> tuple[bytes, dict]:
        disp = self(rgb)
        dn = normalise(disp, 0.5, 99.5)
        h, w = rgb.shape[:2]
        k = min(1.0, max_side / max(h, w))
        ow, oh = max(2, int(round(w * k))), max(2, int(round(h * k)))
        return to_png(dn, ow, oh), {'model': self.name, 'size': f'{ow}x{oh}', 'infer': f'{disp.shape[1]}x{disp.shape[0]}'}
