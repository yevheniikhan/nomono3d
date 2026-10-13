PHOTOS (nomono3d)

Put ordinary photos here (any aspect ratio): they appear in the gallery as Photo items with parallax.

  name.jpg               the photo
  name_depth.png         its depth map, white = near (also -depth, .depth, _disp)
  Album/name.jpg         a subfolder is an album (up to two levels)
  manifest.json          optional: titles, descriptions, order

No depth map? The nomono3d server (Depth Anything V2 on a GPU) or the browser itself
(Depth Anything V2 Small via WebGPU/WASM) estimates one when you open the photo.
Hosting without PHP: after changes run  python tools/build-manifest.py  and upload the
updated manifest.json and thumbs/.
