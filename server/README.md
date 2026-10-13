# nomono3d server

FastAPI app that serves the web app from `../web`, the library and GPU depth estimation.

```bash
pip install torch                      # build for your GPU, see pytorch.org
pip install -r requirements.txt
PYTHONPATH=. python -m nomono3d_server --preload
```

| Option | Default | Meaning |
|---|---|---|
| `--port` | 8000 | HTTP port |
| `--data` | the web folder | library folder holding `panoramas/`, `photos/`, `models/` |
| `--pano-model` | `large` | DA360 size: `small`, `base`, `large` or `none` |
| `--photo-model` | `large` | Depth Anything V2 size, `none`, or a Hugging Face model id |
| `--inpaint` | `migan` | AI background behind objects in photo mode (MI-GAN, MIT, ~27 MB download), or `none` |
| `--photo-res` | 1022 | long side for photo inference (multiple of 14) |
| `--device` | `auto` | `cuda`, `mps` or `cpu` |
| `--no-models` | | viewer and library only |
| `--no-upload` | | read-only library |
| `--preload` | | load the models in the background at start |

Models download on first use into `--cache` (default `~/.cache/nomono3d`). The API is described in the main README and at `/api/docs`.
