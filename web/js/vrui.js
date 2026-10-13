// In-headset UI for VR: a 2D canvas drawn onto a plane, buttons with hover and press states,
// a small toast in front of the eyes and the wrist menu button.
import { THREE } from './gfx.js';

const FONT = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
// High-contrast palette derived from the viewer's glass HUD (index.html: --g-ink, --glass)
export const COL = {
  bg: 'rgba(14,19,17,0.95)', rule: 'rgba(241,244,242,0.22)', ink: '#F1F4F2', dim: 'rgba(241,244,242,0.66)',
  faint: 'rgba(241,244,242,0.32)', fill: 'rgba(255,255,255,0.06)', hover: 'rgba(255,255,255,0.18)',
  press: 'rgba(255,255,255,0.32)', on: '#F1F4F2', onInk: '#121815', acc: '#8FC9B4', warn: '#F2A796'
};

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function fit(g, s, max) {
  s = String(s);
  if (g.measureText(s).width <= max) return s;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/* A floating panel: wm × hm metres, px canvas pixels wide. Content comes from a builder
   function that calls button() and text() (canvas pixel coordinates). */
export class VRPanel {
  constructor(wm, hm, px = 1800) {
    this.wm = wm; this.hm = hm;
    this.cw = px; this.ch = Math.round(px * hm / wm);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cw; this.canvas.height = this.ch;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, depthWrite: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(wm, hm), mat);
    this.mesh.renderOrder = 90;
    this.mesh.visible = false;
    this.mesh.userData.panel = this;
    this.buttons = []; this.texts = [];
    this.hoverId = null; this.pressId = null;
    this.dirty = true;
    this.builder = null;
    // The web font may arrive after the first draw
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { this.dirty = true; });
  }
  set(builder) { this.builder = builder; this.rebuild(); }
  rebuild() { this.buttons = []; this.texts = []; if (this.builder) this.builder(this); this.dirty = true; }
  button(id, x, y, w, h, label, onClick, o = {}) { this.buttons.push(Object.assign({ id, x, y, w, h, label, onClick }, o)); }
  text(x, y, s, o = {}) { this.texts.push(Object.assign({ x, y, s }, o)); }
  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const g = this.g, W = this.cw, H = this.ch;
    g.clearRect(0, 0, W, H);
    rr(g, 2, 2, W - 4, H - 4, 36); g.fillStyle = COL.bg; g.fill();
    g.strokeStyle = COL.rule; g.lineWidth = 3; g.stroke();
    for (const tx of this.texts) {
      g.font = `${tx.weight || 400} ${tx.size || 40}px ${FONT}`;
      g.fillStyle = tx.color || COL.ink; g.textAlign = tx.align || 'left'; g.textBaseline = tx.baseline || 'top';
      g.fillText(fit(g, tx.s, tx.max || W), tx.x, tx.y);
    }
    for (const b of this.buttons) {
      const hov = this.hoverId === b.id && !b.disabled, prs = this.pressId === b.id && !b.disabled;
      rr(g, b.x, b.y, b.w, b.h, 20);
      g.fillStyle = prs ? COL.press : b.active ? COL.on : hov ? COL.hover : COL.fill;
      g.fill();
      g.lineWidth = hov ? 5 : 3;
      g.strokeStyle = b.active ? COL.on : hov ? COL.ink : b.warn ? COL.warn : COL.rule;
      g.stroke();
      g.font = `${b.weight || 500} ${b.size || 44}px ${FONT}`;
      g.fillStyle = b.disabled ? COL.faint : (b.active && !prs) ? COL.onInk : b.warn ? COL.warn : COL.ink;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(fit(g, b.label, b.w - 24), b.x + b.w / 2, b.y + b.h / 2 + 2);
    }
    this.tex.needsUpdate = true;
  }
  /* Ray (world coordinates) against the panel → {distance, point, uv} */
  raycast(origin, dir) {
    if (!this.mesh.visible) return null;
    const rc = VRPanel._rc || (VRPanel._rc = new THREE.Raycaster());
    rc.set(origin, dir);
    const h = rc.intersectObject(this.mesh, false)[0];
    return h ? { distance: h.distance, point: h.point, uv: h.uv } : null;
  }
  at(uv) {
    const x = uv.x * this.cw, y = (1 - uv.y) * this.ch;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }
  hover(uv) {
    const b = uv ? this.at(uv) : null;
    const id = b && !b.disabled ? b.id : null;
    if (id !== this.hoverId) { this.hoverId = id; this.dirty = true; return true; }
    return false;
  }
  press(uv) { const b = this.at(uv); this.pressId = b && !b.disabled ? b.id : null; this.dirty = true; return b; }
  release(uv) {
    const b = uv ? this.at(uv) : null;
    const fire = b && !b.disabled && b.id === this.pressId;
    this.pressId = null; this.dirty = true;
    if (fire && b.onClick) { b.onClick(b); return b; }
    return null;
  }
}

/* A short message in front of the eyes (loading, hints) */
export class VRToast {
  constructor() {
    this.c = document.createElement('canvas'); this.c.width = 1024; this.c.height = 160;
    this.g = this.c.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.c); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.1), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.mesh.renderOrder = 120; this.mesh.visible = false;
    this.until = 0; this.text = '';
  }
  show(text, ms = 2500) {
    this.until = ms > 0 ? performance.now() + ms : Infinity;
    if (text === this.text && this.mesh.visible) return;
    this.text = text;
    const g = this.g, W = 1024, H = 160;
    g.clearRect(0, 0, W, H);
    rr(g, 4, 4, W - 8, H - 8, 40); g.fillStyle = 'rgba(14,19,17,0.92)'; g.fill();
    g.font = `500 46px ${FONT}`; g.fillStyle = COL.ink; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(fit(g, text, W - 60), W / 2, H / 2);
    this.tex.needsUpdate = true;
    if (!this.mesh.visible) this.snap = true;
    this.mesh.visible = true;
  }
  hide() { this.until = 0; this.mesh.visible = false; this.text = ''; }
  update(camPos, camQuat, now) {
    if (!this.mesh.visible) return;
    if (now > this.until) { this.hide(); return; }
    const fwd = new THREE.Vector3(0, -0.28, -1).applyQuaternion(camQuat).normalize();
    const target = camPos.clone().addScaledVector(fwd, 1.1);
    if (this.snap) { this.mesh.position.copy(target); this.snap = false; }
    else this.mesh.position.lerp(target, 0.12);
    this.mesh.lookAt(camPos);
  }
}

/* Menu button on the left wrist (hand tracking) */
export function makeWristButton() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fillStyle = 'rgba(14,19,17,0.92)'; g.fill();
  g.lineWidth = 10; g.strokeStyle = COL.acc; g.stroke();
  g.fillStyle = COL.ink; for (let i = -1; i <= 1; i++) g.fillRect(78, 121 + i * 38, 100, 14);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
  m.renderOrder = 95;
  return m;
}
