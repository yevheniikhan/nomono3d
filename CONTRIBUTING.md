# Contributing

Thank you for helping. Issues and pull requests are welcome.

- **Run it locally**: `PYTHONPATH=server python -m nomono3d_server --no-models` serves the app at http://localhost:8000 without a GPU. Any static server works too (`python -m http.server -d web`), but the library and AI depth need the nomono3d server or a host with PHP.
- **No build step**: the app is native ES modules. Keep it that way; third-party code goes into `web/lib/` with its licence.
- **Style**: two-space indentation in JavaScript, four in Python, comments in English. User-facing strings go through `t('uk', 'en')`.
- **Before a pull request**: `node --check web/js/*.js`, `python -m pyflakes server web/tools`, and a quick look at a panorama and a photo in a desktop and a mobile browser.
- **Depth models**: new back-ends belong in `server/nomono3d_server/depth.py` and must return relative inverse depth (larger = nearer).
