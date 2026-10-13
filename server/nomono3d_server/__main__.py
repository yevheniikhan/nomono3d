"""Run the nomono3d server.

    python -m nomono3d_server                       # web app + library from ../web, models on demand
    python -m nomono3d_server --data /path/library  # keep the library elsewhere (e.g. Google Drive)
    python -m nomono3d_server --no-models           # no GPU: library and viewer only
"""
import argparse
import os
import sys

from . import __version__

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEB = os.path.normpath(os.path.join(HERE, '..', '..', 'web'))


def main(argv=None):
    ap = argparse.ArgumentParser(prog='nomono3d_server', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--web', default=DEFAULT_WEB, help='web app folder (default: %(default)s)')
    ap.add_argument('--data', default=None, help='library folder with panoramas/, photos/, models/ (default: the web folder)')
    ap.add_argument('--pano-model', default='large', choices=['small', 'base', 'large', 'none'], help='DA360 size for 360° panoramas')
    ap.add_argument('--photo-model', default='large', help='Depth Anything V2 size for photos: small | base | large | none | a Hugging Face model id')
    ap.add_argument('--inpaint', default='migan', choices=['migan', 'none'], help='AI background behind objects in photo mode (MI-GAN)')
    ap.add_argument('--photo-res', type=int, default=1022, help='long side used for photo depth inference (multiple of 14)')
    ap.add_argument('--device', default='auto', help='auto | cuda | mps | cpu')
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/nomono3d'), help='model and repository cache')
    ap.add_argument('--no-models', action='store_true', help='serve the viewer and the library only')
    ap.add_argument('--no-upload', action='store_true', help='do not let visitors save files into the library')
    ap.add_argument('--preload', action='store_true', help='load the models before accepting requests')
    a = ap.parse_args(argv)

    import uvicorn
    from .app import Engines, create_app

    engines = None
    if not a.no_models:
        try:
            engines = Engines(a.pano_model, a.photo_model, a.device, a.cache, a.photo_res, a.inpaint)
            print(f'nomono3d {__version__} · device {engines.label} · panoramas: {engines.info()["pano"]} · photos: {engines.info()["photo"]} · background: {engines.info()["inpaint"]}', flush=True)
            if a.preload:          # in the background: the app is usable while the weights download
                import threading

                def _preload():
                    try:
                        engines.preload(lambda m: print(m, flush=True))
                    except Exception as e:
                        print(f'! model preload failed: {type(e).__name__}: {e}', file=sys.stderr, flush=True)
                threading.Thread(target=_preload, daemon=True).start()
        except ImportError as e:
            print(f'! depth models unavailable ({e}); serving the viewer only', file=sys.stderr, flush=True)
            engines = None
    app = create_app(a.web, a.data, engines, upload=not a.no_upload)
    print(f'serving {a.web}' + (f' with the library in {a.data}' if a.data else '') + f' on http://{a.host}:{a.port}', flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level='warning', proxy_headers=True, forwarded_allow_ips='*')


if __name__ == '__main__':
    main()
