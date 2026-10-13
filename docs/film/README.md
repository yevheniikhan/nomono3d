# nomono3d explainer film

`film.html` draws the 82-second explainer frame by frame on a canvas (`render(t)`); English captions; 60 fps.

Render it from the repository root:

```
python3 -m http.server 8790 &
node docs/film/capture.cjs en          # frames into docs/film/frames_en/ (needs Playwright)
ffmpeg -framerate 60 -i docs/film/frames_en/f%05d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p nomono3d_idea.mp4
```
