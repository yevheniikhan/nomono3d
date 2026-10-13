3D MODELS (nomono3d)

Models in this folder are offered by the objects editor (cube button → Library).

  model.glb              recommended (PBR materials, animations, Draco, KTX2)
  model.jpg              optional thumbnail with the same name
  also: .gltf (with its .bin and textures), .obj + .mtl, .fbx, .usdz, .3mf, .stl, .ply, .las, .xyz, .pcd, .zip

Sizes in metres are used as they are; millimetres and centimetres are detected automatically.
For phones keep the whole scene under 1–2 million triangles and textures at 4K or less.
Shrink and compress a model (needs Node.js):
  npx @gltf-transform/cli optimize model.glb model-web.glb --compress draco --texture-compress webp --texture-size 4096
Hosting without PHP: after changes run  python tools/build-manifest.py  (updates models/manifest.json).
