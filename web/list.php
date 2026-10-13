<?php
/*
 * nomono3d — library listing for PHP hosting.
 *
 *   list.php                  → JSON: panoramas (panoramas/), photos (photos/) and 3D models (models/)
 *   list.php?thumb=<path>     → JPEG thumbnail (cached in <folder>/.thumbs/)
 *
 * Upload files through your hosting panel or FTP:
 *   panoramas/name.jpg          equirectangular panorama: 2:1 mono, 1:1 top-bottom or 4:1 side-by-side stereo
 *   photos/name.jpg             ordinary photo, any aspect ratio
 *   <folder>/name_depth.png     its depth map (white = near); also -depth, .depth, _disp
 *   panoramas/name.scene.json   3D objects saved by the editor
 *   <folder>/Album/...          subfolders become albums (up to two levels)
 *   <folder>/manifest.json      optional: titles, descriptions, order, settings
 *   models/*.glb|gltf|obj|fbx|ply|stl|3mf|usdz|las|xyz|pcd|zip   models for the editor
 *
 * Requires PHP 7.2+. GD or Imagick is recommended for thumbnails (without them the gallery shows titles).
 */
error_reporting(0);
ini_set('display_errors', '0');

$ROOT      = __DIR__;
$LIBS      = array('panoramas' => 'pano', 'photos' => 'photo');
$MODEL_DIR = 'models';
$MAX_DEPTH = 2;                       // subfolder levels
$IMG_EXT   = array('jpg', 'jpeg', 'png', 'webp', 'avif');
$MODEL_EXT = array('glb', 'gltf', 'obj', 'fbx', 'ply', 'stl', '3mf', 'usdz', 'las', 'xyz', 'pcd', 'zip');
$DEPTH_RE  = '/^(.*?)[._\- ](depth|disp|disparity|depthmap|dmap)$/iu';

function ext_of($name) { $p = strrpos($name, '.'); return $p === false ? '' : strtolower(substr($name, $p + 1)); }
function base_of($name) { $p = strrpos($name, '.'); return $p === false ? $name : substr($name, 0, $p); }
function url_of($rel) { return implode('/', array_map('rawurlencode', explode('/', $rel))); }
function pretty($s) {
  $s = preg_replace('/[_\-]+/u', ' ', $s);
  $s = trim(preg_replace('/\s+/u', ' ', $s));
  return function_exists('mb_strtoupper') ? mb_strtoupper(mb_substr($s, 0, 1)) . mb_substr($s, 1) : ucfirst($s);
}
function safe_rel($root, $rel, $prefixes) {
  $rel = str_replace('\\', '/', (string)$rel);
  if ($rel === '' || strpos($rel, "\0") !== false || strpos($rel, '..') !== false || $rel[0] === '/') return null;
  foreach ($prefixes as $pre) {
    if (strpos($rel, $pre . '/') !== 0) continue;
    $abs = realpath($root . '/' . $rel);
    $base = realpath($root . '/' . $pre);
    if ($abs !== false && $base !== false && strpos($abs, $base . DIRECTORY_SEPARATOR) === 0) return array($abs, $pre);
  }
  return null;
}
function scan_dir($root, $rel, $depth, $maxDepth, &$out) {
  $h = @opendir($root . '/' . $rel);
  if (!$h) return;
  while (($f = readdir($h)) !== false) {
    if ($f === '.' || $f === '..' || $f[0] === '.' || $f === 'thumbs') continue;
    $p = $rel . '/' . $f;
    if (is_dir($root . '/' . $p)) { if ($depth < $maxDepth) scan_dir($root, $p, $depth + 1, $maxDepth, $out); }
    else $out[] = $p;
  }
  closedir($h);
}
function mem_limit_bytes() {
  $v = trim((string)ini_get('memory_limit'));
  if ($v === '' || $v === '-1') return PHP_INT_MAX;
  $n = (int)$v; $u = strtolower(substr($v, -1));
  if ($u === 'g') $n *= 1073741824; elseif ($u === 'm') $n *= 1048576; elseif ($u === 'k') $n *= 1024;
  return $n;
}

/* ─────────── thumbnails ─────────── */
if (isset($_GET['thumb'])) {
  $rel = (string)$_GET['thumb'];
  $hit = safe_rel($ROOT, $rel, array_keys($LIBS));
  if ($hit === null || !in_array(ext_of($hit[0]), $IMG_EXT, true)) { http_response_code(404); exit; }
  list($abs, $lib) = $hit;
  $kind = $LIBS[$lib];
  $mt = filemtime($abs);
  $key = md5($rel . '|' . $mt . '|v4');
  $cacheDir = $ROOT . '/' . $lib . '/.thumbs';
  $cache = $cacheDir . '/' . $key . '.jpg';
  header('Cache-Control: public, max-age=604800');
  if (is_file($cache)) { header('Content-Type: image/jpeg'); readfile($cache); exit; }
  $info = @getimagesize($abs);
  if (!$info) { http_response_code(404); exit; }
  $w = $info[0]; $h = $info[1];
  $r = $w / max(1, $h);
  // stereo panorama: left eye (top half of 1:1, left half of 4:1); photo: centre crop to 2:1
  $sx = 0; $sy = 0; $sw = $w; $sh = $h;
  if ($kind === 'pano') {
    if (abs($r - 1) < 0.15) { $sh = (int)($h / 2); }
    elseif (abs($r - 4) < 0.4) { $sw = (int)($w / 2); }
    // the forward view (central half): less distortion than the full sphere
    $sx = (int)($sw / 4); $sy = (int)($sh / 4); $sw = (int)($sw / 2); $sh = (int)($sh / 2);
  } else {
    $sh = min($h, (int)($w / 2)); $sw = $sh * 2;
    $sx = (int)(($w - $sw) / 2); $sy = (int)(($h - $sh) / 2);
  }
  $TW = 512; $TH = 256;
  $jpeg = null;
  if (class_exists('Imagick')) {
    try {
      $im = new Imagick();
      $im->setOption('jpeg:size', ($TW * 2) . 'x' . ($TH * 4));   // decode at reduced size
      $im->readImage($abs);
      $k = $im->getImageWidth() / $w;
      $im->cropImage((int)($sw * $k), (int)($sh * $k), (int)($sx * $k), (int)($sy * $k));
      $im->thumbnailImage($TW, $TH, false);
      $im->setImageFormat('jpeg'); $im->setImageCompressionQuality(80);
      $jpeg = $im->getImageBlob(); $im->clear();
    } catch (Exception $e) { $jpeg = null; }
  }
  if ($jpeg === null && function_exists('imagecreatetruecolor')) {
    $need = $w * $h * 5 + 48 * 1048576;
    if (mem_limit_bytes() - memory_get_usage() < $need) @ini_set('memory_limit', (string)(int)(($need + memory_get_usage()) / 1048576 + 32) . 'M');
    if (mem_limit_bytes() - memory_get_usage() >= $need) {
      $e = ext_of($abs); $src = null;
      if ($e === 'jpg' || $e === 'jpeg') $src = @imagecreatefromjpeg($abs);
      elseif ($e === 'png') $src = @imagecreatefrompng($abs);
      elseif ($e === 'webp' && function_exists('imagecreatefromwebp')) $src = @imagecreatefromwebp($abs);
      elseif ($e === 'avif' && function_exists('imagecreatefromavif')) $src = @imagecreatefromavif($abs);
      if ($src) {
        $dst = imagecreatetruecolor($TW, $TH);
        imagecopyresampled($dst, $src, 0, 0, $sx, $sy, $TW, $TH, $sw, $sh);
        imagedestroy($src);
        ob_start(); imagejpeg($dst, null, 80); $jpeg = ob_get_clean(); imagedestroy($dst);
      }
    }
  }
  if ($jpeg === null && function_exists('exif_thumbnail')) {
    $t = @exif_thumbnail($abs);
    if ($t) $jpeg = $t;
  }
  if ($jpeg === null) { http_response_code(404); exit; }
  if (!is_dir($cacheDir)) @mkdir($cacheDir, 0755, true);
  if (is_dir($cacheDir) && is_writable($cacheDir)) @file_put_contents($cache, $jpeg);
  header('Content-Type: image/jpeg');
  echo $jpeg;
  exit;
}

/* ─────────── listing ─────────── */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');

function scan_library($ROOT, $LIB_DIR, $kind, $MAX_DEPTH, $IMG_EXT, $DEPTH_RE, &$title) {
  $manifest = array();
  $mf = $ROOT . '/' . $LIB_DIR . '/manifest.json';
  if (is_file($mf)) { $j = json_decode((string)file_get_contents($mf), true); if (is_array($j)) $manifest = $j; }
  if (isset($manifest['title']) && $title === null) $title = $manifest['title'];
  $over = array();
  if (isset($manifest['items']) && is_array($manifest['items'])) foreach ($manifest['items'] as $it) {
    if (is_array($it) && isset($it['src'])) $over[rawurldecode(ltrim((string)$it['src'], '/'))] = $it;
  }
  $all = array();
  if (is_dir($ROOT . '/' . $LIB_DIR)) scan_dir($ROOT, $LIB_DIR, 0, $MAX_DEPTH, $all);
  $byDir = array();
  foreach ($all as $p) { $d = dirname($p); if (!isset($byDir[$d])) $byDir[$d] = array(); $byDir[$d][] = basename($p); }
  $items = array(); $seen = array();
  foreach ($byDir as $dir => $names) {
    $set = array_flip($names);
    $depthFor = array();
    foreach ($names as $n) {
      if (!in_array(ext_of($n), $IMG_EXT, true)) continue;
      if (preg_match($DEPTH_RE, base_of($n), $m)) {
        $k = strtolower($m[1]);
        if (!isset($depthFor[$k]) || ext_of($n) === 'png') $depthFor[$k] = $n;
      }
    }
    foreach ($names as $n) {
      if (!in_array(ext_of($n), $IMG_EXT, true)) continue;
      $b = base_of($n);
      if (preg_match($DEPTH_RE, $b) || preg_match('/[._-](thumb|preview)$/i', $b)) continue;
      $rel = $dir . '/' . $n;
      $info = @getimagesize($ROOT . '/' . $rel);
      $w = $info ? $info[0] : 0; $h = $info ? $info[1] : 0;
      $r = $h ? $w / $h : 2;
      $layout = $kind === 'photo' ? 'mono' : (abs($r - 1) < 0.15 ? 'tb' : (abs($r - 4) < 0.4 ? 'sbs' : 'mono'));
      $album = ltrim((string)substr($dir, strlen($LIB_DIR)), '/');
      $it = array(
        'id' => ltrim(($album !== '' ? $album . '/' : '') . $b, '/'),
        'kind' => $kind,
        'title' => pretty($b),
        'src' => url_of($rel),
        'w' => $w, 'h' => $h, 'layout' => $layout,
        'size' => filesize($ROOT . '/' . $rel),
        'mtime' => filemtime($ROOT . '/' . $rel),
        'album' => $album,
        'thumb' => 'list.php?thumb=' . rawurlencode($rel)
      );
      $dk = strtolower($b);
      if (isset($depthFor[$dk])) $it['depth'] = url_of($dir . '/' . $depthFor[$dk]);
      if (isset($set[$b . '.scene.json'])) $it['scene'] = url_of($dir . '/' . $b . '.scene.json');
      foreach (array('jpg', 'png', 'webp') as $te) if (isset($set[$b . '.thumb.' . $te])) $it['thumb'] = url_of($dir . '/' . $b . '.thumb.' . $te);
      $key = substr($rel, strlen($LIB_DIR) + 1);
      if (isset($over[$key])) {
        foreach ($over[$key] as $k => $v) {
          if ($k === 'src') continue;
          if (in_array($k, array('depth', 'scene', 'thumb'), true) && is_string($v) && !preg_match('#^(https?:)?//#', $v)) $v = url_of($LIB_DIR . '/' . ltrim($v, '/'));
          $it[$k] = $v;
        }
        $seen[$key] = true;
      }
      if (!empty($it['hidden'])) continue;
      $items[] = $it;
    }
  }
  // entries that exist only in manifest.json (for example external URLs)
  foreach ($over as $key => $it) {
    if (isset($seen[$key]) || !empty($it['hidden'])) continue;
    if (!preg_match('#^(https?:)?//#', (string)$it['src'])) continue;
    $it['id'] = isset($it['id']) ? $it['id'] : $key;
    $it['kind'] = $kind;
    if (!isset($it['title'])) $it['title'] = pretty(base_of(basename($key)));
    $items[] = $it;
  }
  usort($items, function ($a, $b) {
    $oa = isset($a['order']) ? (float)$a['order'] : 1e9; $ob = isset($b['order']) ? (float)$b['order'] : 1e9;
    if ($oa != $ob) return $oa < $ob ? -1 : 1;
    $c = strnatcasecmp(isset($a['album']) ? $a['album'] : '', isset($b['album']) ? $b['album'] : '');
    return $c !== 0 ? $c : strnatcasecmp($a['id'], $b['id']);
  });
  return $items;
}

$title = null;
$out = array('version' => 2, 'source' => 'php');
foreach ($LIBS as $dir => $kind) $out[$dir] = scan_library($ROOT, $dir, $kind, $MAX_DEPTH, $IMG_EXT, $DEPTH_RE, $title);

/* models */
$models = array();
$mall = array();
if (is_dir($ROOT . '/' . $MODEL_DIR)) scan_dir($ROOT, $MODEL_DIR, 0, $MAX_DEPTH, $mall);
$mset = array_flip($mall);
foreach ($mall as $p) {
  $e = ext_of($p);
  if (!in_array($e, $MODEL_EXT, true)) continue;
  $b = base_of(basename($p)); $dir = dirname($p);
  $it = array(
    'id' => ltrim(substr(base_of($p), strlen($MODEL_DIR)), '/'),
    'title' => pretty($b), 'src' => url_of($p), 'ext' => $e,
    'size' => filesize($ROOT . '/' . $p),
    'album' => ltrim((string)substr($dir, strlen($MODEL_DIR)), '/')
  );
  foreach (array('jpg', 'jpeg', 'png', 'webp') as $te) {
    if (isset($mset[$dir . '/' . $b . '.' . $te])) { $it['thumb'] = url_of($dir . '/' . $b . '.' . $te); break; }
  }
  $models[] = $it;
}
usort($models, function ($a, $b) { return strnatcasecmp($a['id'], $b['id']); });

$out['title'] = $title;
$out['models'] = $models;
$out['gd'] = function_exists('imagecreatetruecolor');
$out['imagick'] = class_exists('Imagick');
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
