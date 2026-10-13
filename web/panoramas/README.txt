PANORAMAS (nomono3d)

Put 360° panoramas here: they appear in the site gallery after a page refresh.

  name.jpg               equirectangular panorama: 2:1 mono, 1:1 top-bottom or 4:1 side-by-side stereo
  name_depth.png         its depth map, white = near (also -depth, .depth, _disp)
  name.scene.json        3D objects saved by the editor (a .zip package unzips into the site root)
  Album/name.jpg         a subfolder is an album (up to two levels)
  manifest.json          optional: titles, descriptions, order, initial direction, stereo settings

No depth map? Open the site through the nomono3d server (see colab/ in the repository):
DA360 generates one and saves it next to the panorama.
Formats: JPEG, PNG, WebP, AVIF; up to 8192 px wide.
Hosting without PHP: after changes run  python tools/build-manifest.py  and upload the
updated manifest.json and thumbs/. The thumbs/ and .thumbs/ folders are generated and can be deleted.
Full guide: the "?" button on the site.
