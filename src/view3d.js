/* Catenary 3D view.
   Built with `npm run build:3d`, which bundles this file and the parts of
   three.js it uses into index.html (between the CAT3D markers), so the app
   stays a single offline file.

   World axes: x runs along the lay, positive = inboard toward the bow,
   with the chute exit at x = 0 and touchdown at x = -layback.
   y is up with the sea surface at y = 0. z is athwartships.

   The app owns all physics. This file only draws what it is given:
     Cat3D.mount(el)            -> true if WebGL is available
     Cat3D.update(data)         -> redraw for a new depth / inputs / selection
     Cat3D.view(name)           -> 'side' | 'quarter' | 'stern' | 'top' | 'fit'
     Cat3D.onPick = key => {}   -> called when a cable is clicked
*/
import {
  Scene, PerspectiveCamera, WebGLRenderer, Color, Fog, HemisphereLight, DirectionalLight,
  Mesh, Group, MeshStandardMaterial, MeshBasicMaterial, PlaneGeometry, BoxGeometry, CylinderGeometry,
  ExtrudeGeometry, Shape, TubeGeometry, CatmullRomCurve3, Vector3, Vector2, Raycaster,
  BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, LineDashedMaterial, LineSegments,
  DoubleSide, SRGBColorSpace,
} from 'three';

const S = {
  el: null, renderer: null, scene: null, camera: null, root: null, labels: null, tip: null,
  cam: { target: new Vector3(), radius: 150, theta: -0.9, phi: 1.2 },  // theta: azimuth, phi: polar from +y
  touched: false, data: null, pickables: [], raf: 0, span: 100,
};
const Cat3D = { onPick: null, mount, update, view, resize, active: () => !!S.renderer, screenOf };
// Screen position of a point partway down a cable (used by tests and keyboard help).
function screenOf(key, frac = 0.6) {
  const m = S.pickables.find(o => o.userData.key === key && o.material.visible !== false);
  if (!m) return null;
  const p = m.geometry.parameters.path.getPoint(frac).clone().project(S.camera);
  const r = S.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}

/* ------------------------------------------------------------------ */
function mount(el) {
  if (S.renderer) { if (S.el !== el) el.appendChild(S.renderer.domElement); S.el = el; resize(); return true; }
  let renderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  } catch (e) { return false; }
  if (!renderer.getContext()) return false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  S.renderer = renderer; S.el = el;
  const cv = renderer.domElement;
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none';
  cv.tabIndex = 0;
  el.appendChild(cv);

  S.labels = document.createElement('div');
  S.labels.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  el.appendChild(S.labels);
  S.tip = document.createElement('div');
  S.tip.className = 'tip3d';
  el.appendChild(S.tip);

  S.scene = new Scene();
  S.camera = new PerspectiveCamera(40, 1, 0.5, 20000);
  S.scene.add(new HemisphereLight(0xdfefff, 0x3a3226, 1.15));
  const sun = new DirectionalLight(0xffffff, 1.6); sun.position.set(-60, 120, 80); S.scene.add(sun);
  const fill = new DirectionalLight(0x9fc4ff, 0.45); fill.position.set(80, 40, -100); S.scene.add(fill);
  S.root = new Group(); S.scene.add(S.root);

  bindControls(cv);
  new ResizeObserver(resize).observe(el);
  resize();
  return true;
}

function resize() {
  if (!S.renderer || !S.el) return;
  const w = Math.max(10, S.el.clientWidth), h = Math.max(10, S.el.clientHeight);
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  render();
}

/* ------------------------------------------------------------------ */
function clearRoot() {
  S.root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
  S.root.clear();
  S.pickables = [];
}

const mat = (color, o = {}) => new MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, ...o });

function update(data) {
  if (!S.renderer) return;
  S.data = data;
  clearRoot();
  const T = data.theme, d = data.depth, r = Math.max(0, data.sR), sH = data.sH;
  const sel = data.cables.find(c => c.selected) || data.cables[0];
  if (!sel) { render(); return; }

  const maxLay = Math.max(...data.cables.map(c => c.layback));
  const span = Math.max(maxLay + 40, d * 1.2, 60);
  S.span = span;
  S.renderer.setClearColor(new Color(T.bg));
  S.scene.fog = new Fog(new Color(T.bg), span * 2.2, span * 7);
  const rr = Math.min(0.55, Math.max(0.14, span * 0.0032));        // drawn cable radius (not to scale)

  // ---- chute geometry from the selected cable's exit angle
  const phi = sel.exitAng;
  const C = new Vector2(r * Math.sin(phi), sH - r * Math.cos(phi));
  const deckY = C.y + r;
  const draft = Math.min(6.5, Math.max(3, d * 0.4));
  const L = 95, B = 24, x0 = C.x;                                    // generic DP cable-lay vessel aft body

  // ---- sea and seabed
  const extent = span * 6;
  const sea = new Mesh(new PlaneGeometry(extent, extent), mat(T.water, { transparent: true, opacity: 0.3, depthWrite: false, side: DoubleSide, roughness: 0.85, metalness: 0 }));
  sea.rotation.x = -Math.PI / 2; sea.position.set(-span * 0.3, 0, 0); sea.renderOrder = 2;
  S.root.add(sea);
  const seaEdge = new LineSegments(gridGeom(extent, Math.max(10, niceStep(span / 6)), 0.02), new LineBasicMaterial({ color: T.surface, transparent: true, opacity: 0.18 }));
  seaEdge.position.set(-span * 0.3, 0, 0); S.root.add(seaEdge);

  const bed = new Mesh(new PlaneGeometry(extent, extent), mat(T.seabed, { roughness: 0.95 }));
  bed.rotation.x = -Math.PI / 2; bed.position.set(-span * 0.3, -d, 0);
  S.root.add(bed);
  const g = niceStep(span / 8);
  const grid = new LineSegments(gridGeom(span * 3, g, 0), new LineBasicMaterial({ color: T.seabedLine, transparent: true, opacity: 0.55 }));
  grid.position.set(-span * 0.4, -d + 0.03, 0); S.root.add(grid);

  // ---- vessel
  const hull = new Shape();
  hull.moveTo(x0, deckY);
  hull.lineTo(x0 + L - 16, deckY);
  hull.quadraticCurveTo(x0 + L - 2, deckY + 0.5, x0 + L + 2, deckY + 2.2);
  hull.quadraticCurveTo(x0 + L - 4, -draft * 0.3, x0 + L - 14, -draft);
  hull.lineTo(x0 + 6, -draft);
  hull.quadraticCurveTo(x0 + 1, -draft + 1, x0, -draft + 3.2);
  hull.lineTo(x0, deckY);
  const hullGeo = new ExtrudeGeometry(hull, { depth: B, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1.2, bevelSegments: 3, steps: 1, curveSegments: 16 });
  hullGeo.translate(0, 0, -B / 2);
  S.root.add(new Mesh(hullGeo, mat(T.hull, { roughness: 0.55 })));
  const deck = new Mesh(new BoxGeometry(L - 6, 0.25, B - 1.5), mat(T.deck));
  deck.position.set(x0 + (L - 6) / 2 + 1, deckY + 0.13, 0); S.root.add(deck);
  // superstructure and bridge
  const house = new Mesh(new BoxGeometry(16, 11, B * 0.82), mat(T.house));
  house.position.set(x0 + L - 26, deckY + 5.5, 0); S.root.add(house);
  const bridge = new Mesh(new BoxGeometry(14, 3.2, B * 0.9), mat(T.house));
  bridge.position.set(x0 + L - 25, deckY + 12.6, 0); S.root.add(bridge);
  const glass = new Mesh(new BoxGeometry(0.3, 1.4, B * 0.86), mat(0x0d1a24, { roughness: 0.2, metalness: 0.4 }));
  glass.position.set(x0 + L - 32.1, deckY + 12.8, 0); S.root.add(glass);
  // carousel and tensioner
  const car = new Mesh(new CylinderGeometry(9, 9, 4.5, 40, 1, true), mat(T.machinery, { side: DoubleSide }));
  car.position.set(x0 + 44, deckY + 2.25, 0); S.root.add(car);
  const core = new Mesh(new CylinderGeometry(3.5, 3.5, 4.6, 24), mat(T.machinery));
  core.position.copy(car.position); S.root.add(core);
  const ten = new Mesh(new BoxGeometry(7, 3, 3.6), mat(T.tensioner));
  ten.position.set(x0 + 16, deckY + 1.5 + 0.1, 0); S.root.add(ten);

  // chute: curved ramp at the stern
  if (r > 0.2) {
    const a0 = Math.PI / 2 - 0.05, a1 = Math.PI / 2 + phi + 0.12;
    S.root.add(new Mesh(arcSurface(C, r - rr, a0, a1, 3.2), mat(T.chute, { side: DoubleSide, metalness: 0.3, roughness: 0.4 })));
    [-1.7, 1.7].forEach(z => {
      const cheek = new Mesh(new TubeGeometry(new CatmullRomCurve3(arcPts(C, r + 0.25, a0, a1, 24).map(p => new Vector3(p.x, p.y, z))), 24, 0.18, 6, false), mat(T.chute, { metalness: 0.3 }));
      S.root.add(cheek);
    });
  }

  // ---- cables
  data.cables.forEach(c => {
    const pts = cablePath(c, r, sH, x0, maxLay, d);
    const curve = new CatmullRomCurve3(pts, false, 'centripetal');
    const isSel = c === sel;
    const radius = isSel ? rr * 1.7 : rr;
    const tube = new Mesh(new TubeGeometry(curve, Math.min(600, pts.length * 3), radius, 10, false),
      mat(c.color, { emissive: new Color(c.color), emissiveIntensity: isSel ? 0.35 : 0.12, transparent: !isSel, opacity: isSel ? 1 : 0.85 }));
    tube.userData.key = c.key; tube.renderOrder = isSel ? 5 : 3;
    S.root.add(tube); S.pickables.push(tube);
    // a fatter invisible tube makes the thin cables easy to click
    const hit = new Mesh(new TubeGeometry(curve, Math.min(300, pts.length * 2), Math.max(radius * 4, span * 0.012), 6, false), new MeshBasicMaterial({ visible: false }));
    hit.userData.key = c.key; S.root.add(hit); S.pickables.push(hit);
    // touchdown ring
    const ring = new Mesh(new CylinderGeometry(radius * 3.2, radius * 3.2, 0.12, 24), mat(c.color, { emissive: new Color(c.color), emissiveIntensity: 0.4 }));
    ring.position.set(-c.layback, -d + 0.08, 0); S.root.add(ring);
  });

  // ---- dimensions for the selected cable
  const dims = [];
  const yb = -d + 0.15;
  dims.push(new Vector3(-sel.layback, yb, 0), new Vector3(0, yb, 0));                // layback along the seabed
  dims.push(new Vector3(0, yb, 0), new Vector3(0, sH, 0));                            // plumb line under the chute exit
  const dimLine = new LineSegments(new BufferGeometry().setFromPoints(dims), new LineDashedMaterial({ color: sel.color, dashSize: span * 0.012, gapSize: span * 0.008 }));
  dimLine.computeLineDistances(); S.root.add(dimLine);
  const depthLine = new Line(new BufferGeometry().setFromPoints([new Vector3(-sel.layback - span * 0.12, 0, 0), new Vector3(-sel.layback - span * 0.12, -d, 0)]), new LineBasicMaterial({ color: T.cursor }));
  S.root.add(depthLine);

  S.labelDefs = [
    { p: new Vector3(-sel.layback / 2, yb, 0), text: `${sel.label} · layback ${sel.layback.toFixed(1)} m`, color: sel.color, cls: 'dim' },
    { p: new Vector3(-(sel.layback - sel.x1), 0, 0), text: `${sel.angle.toFixed(1)}° from vertical`, color: sel.color, cls: 'dim' },
    { p: new Vector3(-sel.layback - span * 0.12, -d / 2, 0), text: `${d.toFixed(1)} m`, color: T.cursor, cls: 'depth' },
    { p: new Vector3(x0 + L - 25, deckY + 15.5, 0), text: 'Vessel', color: T.ink2, cls: 'plain' },
  ];

  S.box = { x0: -maxLay - 12, x1: x0 + 34, y0: -d - 2, y1: deckY + 8, z: B };
  if (!S.touched) fitCamera('quarter', false);
  render();
}

/* Cable route: carousel → tensioner → over the chute → catenary → laid on the seabed. */
function cablePath(c, r, sH, x0, maxLay, d) {
  const phi = c.exitAng;
  const C = new Vector2(r * Math.sin(phi), sH - r * Math.cos(phi));
  const top = C.y + r;
  const pts = [];
  pts.push(new Vector3(x0 + 40, top + 0.4, 0), new Vector3(x0 + 26, top + 0.4, 0), new Vector3(x0 + 16, top + 0.4, 0));
  for (let x = x0 + 10; x > C.x + 0.5; x -= 3) pts.push(new Vector3(x, top, 0));
  if (r > 0.2) arcPts(C, r, Math.PI / 2, Math.PI / 2 + phi, 14).forEach(p => pts.push(new Vector3(p.x, p.y, 0)));
  else pts.push(new Vector3(0, sH, 0));
  // catenary from the chute exit down to touchdown (app gives [metres from exit toward TDP, height above surface])
  for (let i = c.pts.length - 2; i >= 0; i--) pts.push(new Vector3(-c.pts[i][0], c.pts[i][1], 0));
  const tdp = -c.layback;
  for (let k = 1; k <= 6; k++) pts.push(new Vector3(tdp - k * (maxLay * 0.12 + 4), -d, 0));
  // drop near-duplicates, the curve dislikes them
  return pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 0.05);
}

function arcPts(C, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(new Vector2(C.x + r * Math.cos(a), C.y + r * Math.sin(a))); }
  return out;
}
function arcSurface(C, r, a0, a1, width) {
  const n = 28, pos = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n, x = C.x + r * Math.cos(a), y = C.y + r * Math.sin(a);
    pos.push(x, y, -width / 2, x, y, width / 2);
    if (i < n) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  return geo;
}
function gridGeom(size, step, y) {
  const v = [], h = size / 2, n = Math.floor(h / step);
  for (let i = -n; i <= n; i++) { v.push(-h, y, i * step, h, y, i * step, i * step, y, -h, i * step, y, h); }
  const geo = new BufferGeometry(); geo.setAttribute('position', new Float32BufferAttribute(v, 3)); return geo;
}
function niceStep(raw) { const m = 10 ** Math.floor(Math.log10(raw)), f = raw / m; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * m; }

/* ------------------------------------------------------------------ */
function fitCamera(name, animate) {
  const bx = S.box || { x0: -60, x1: 30, y0: -50, y1: 10, z: 24 };
  const presets = {
    side:    { theta: 0,                    phi: Math.PI / 2 - 0.03 },
    quarter: { theta: -0.72,                phi: 1.2 },
    stern:   { theta: -Math.PI / 2 + 0.04,  phi: 1.25 },
    top:     { theta: 0,                    phi: 0.06 },
  };
  const p = presets[name] || presets.quarter;
  const W = bx.x1 - bx.x0, H = bx.y1 - bx.y0;
  // what the camera sees across and up, for this view direction
  const across = name === 'stern' ? Math.max(bx.z * 2, H * 0.6) : name === 'top' ? W : W * Math.abs(Math.cos(p.theta)) + bx.z * Math.abs(Math.sin(p.theta));
  const up = name === 'top' ? bx.z * 2.5 : name === 'stern' ? H : H * Math.sin(p.phi) + W * Math.abs(Math.cos(p.phi)) * 0.5;
  const t = Math.tan((S.camera.fov * Math.PI / 180) / 2), asp = S.camera.aspect || 1.4;
  const radius = Math.max(up / 2 / t, across / 2 / (t * asp)) * 1.12 + (name === 'stern' ? W * 0.5 : 0);
  const center = new Vector3((bx.x0 + bx.x1) / 2, (bx.y0 + bx.y1) / 2, 0);
  const to = { target: center, radius, theta: p.theta, phi: p.phi };
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { Object.assign(S.cam, to); render(); return; }
  const from = { target: S.cam.target.clone(), radius: S.cam.radius, theta: S.cam.theta, phi: S.cam.phi };
  let dt = from.theta - to.theta; while (dt > Math.PI) from.theta -= 2 * Math.PI, dt -= 2 * Math.PI; while (dt < -Math.PI) from.theta += 2 * Math.PI, dt += 2 * Math.PI;
  const t0 = performance.now(), D = 520;
  const step = now => {
    const k = Math.min(1, (now - t0) / D), e = 1 - (1 - k) ** 3;
    S.cam.target.lerpVectors(from.target, to.target, e);
    S.cam.radius = from.radius + (to.radius - from.radius) * e;
    S.cam.theta = from.theta + (to.theta - from.theta) * e;
    S.cam.phi = from.phi + (to.phi - from.phi) * e;
    renderNow();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function view(name) { if (name === 'fit') { S.touched = false; name = 'quarter'; } fitCamera(name, true); }

function placeCamera() {
  const { target, radius, theta, phi } = S.cam;
  // theta = 0 looks at the starboard side (camera on +z); theta = -90° looks from astern of the touchdown
  S.camera.position.set(
    target.x + radius * Math.sin(phi) * Math.sin(theta),
    target.y + radius * Math.cos(phi),
    target.z + radius * Math.sin(phi) * Math.cos(theta),
  );
  S.camera.lookAt(target);
}

function render() { if (!S.renderer || S.raf) return; S.raf = requestAnimationFrame(() => { S.raf = 0; renderNow(); }); }
function renderNow() {
  if (!S.renderer) return;
  placeCamera();
  S.renderer.render(S.scene, S.camera);
  drawLabels();
}

function drawLabels() {
  if (!S.labels || !S.labelDefs) return;
  const w = S.el.clientWidth, h = S.el.clientHeight;
  S.labels.innerHTML = '';
  const boxes = [];
  S.labelDefs.forEach(l => {
    const v = l.p.clone().project(S.camera);
    if (v.z > 1 || v.z < -1) return;
    const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
    if (x < -50 || x > w + 50 || y < -20 || y > h + 20) return;
    const el = document.createElement('div');
    el.className = 'lbl3d ' + l.cls;
    el.textContent = l.text;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.setProperty('--c', l.color);
    S.labels.appendChild(el);
    const r = el.getBoundingClientRect();
    if (boxes.some(b => r.left < b.right + 4 && r.right > b.left - 4 && r.top < b.bottom + 2 && r.bottom > b.top - 2)) { el.remove(); return; }
    boxes.push(r);
  });
}

/* ------------------------------------------------------------------ */
function bindControls(cv) {
  const ray = new Raycaster(), ndc = new Vector2();
  const pointers = new Map();
  let down = null, mode = null, pinch0 = 0, moved = 0;

  const pick = e => {
    const rect = cv.getBoundingClientRect();
    ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, S.camera);
    const hits = ray.intersectObjects(S.pickables, false);
    // a direct hit on a drawn cable wins; the fat invisible tubes only help when you're slightly off
    const direct = hits.find(h => h.object.material.visible !== false);
    const h = direct || hits[0];
    return h ? h.object.userData.key : null;
  };

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down = { x: e.clientX, y: e.clientY }; moved = 0;
    mode = (e.button === 2 || e.shiftKey || pointers.size === 2) ? 'pan' : 'orbit';
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
    hideTip();
  });
  cv.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') hover(e);
      return;
    }
    const prev = pointers.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.abs(dx) + Math.abs(dy);
    S.touched = true;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch0) zoomBy(pinch0 / dist);
      pinch0 = dist; pan(dx / 2, dy / 2);
    } else if (mode === 'pan') pan(dx, dy);
    else {
      S.cam.theta += dx * 0.006;
      S.cam.phi = Math.min(Math.PI - 0.05, Math.max(0.05, S.cam.phi - dy * 0.006));
    }
    render();
  });
  const end = e => {
    const wasDown = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch0 = 0;
    if (wasDown && moved < 6 && e.type === 'pointerup') {
      const key = pick(e);
      if (key != null && Cat3D.onPick) Cat3D.onPick(key);
    }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { hideTip(); cv.style.cursor = 'grab'; });
  cv.addEventListener('wheel', e => { e.preventDefault(); S.touched = true; zoomBy(Math.exp(e.deltaY * 0.0012)); render(); }, { passive: false });
  cv.addEventListener('dblclick', () => view('fit'));
  cv.style.cursor = 'grab';

  function zoomBy(f) { S.cam.radius = Math.min(S.span * 12, Math.max(8, S.cam.radius * f)); }
  function pan(dx, dy) {
    const k = S.cam.radius * 0.0016;
    const right = new Vector3().subVectors(S.camera.position, S.cam.target).cross(S.camera.up).normalize();
    const up = new Vector3().copy(S.camera.up);
    S.cam.target.addScaledVector(right, dx * k).addScaledVector(up, dy * k);
  }
  function hover(e) {
    const key = pick(e);
    cv.style.cursor = key != null ? 'pointer' : 'grab';
    if (key == null || !S.data) return hideTip();
    const c = S.data.cables.find(x => x.key === key); if (!c) return hideTip();
    const rect = cv.getBoundingClientRect();
    S.tip.innerHTML = `<b style="color:${c.color}">${c.label}</b><div>Layback ${c.layback.toFixed(1)} m</div><div>Angle ${c.angle.toFixed(1)}° from vertical</div><small>Click to select</small>`;
    S.tip.style.display = 'block';
    let x = e.clientX - rect.left + 14, y = e.clientY - rect.top + 14;
    if (x + S.tip.offsetWidth > rect.width - 6) x = e.clientX - rect.left - S.tip.offsetWidth - 14;
    if (y + S.tip.offsetHeight > rect.height - 6) y = rect.height - S.tip.offsetHeight - 6;
    S.tip.style.left = x + 'px'; S.tip.style.top = Math.max(6, y) + 'px';
    S.tip.style.borderColor = c.color;
  }
  function hideTip() { if (S.tip) S.tip.style.display = 'none'; }
}

window.Cat3D = Cat3D;
