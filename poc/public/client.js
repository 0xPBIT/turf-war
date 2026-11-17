// Turf War prototype client: renders the server's world and sends intents. Throwaway.
import * as THREE from 'three';

const $ = id => document.getElementById(id);
const MAP = await (await fetch('/map.json')).json();

// ---------- renderer and scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#8fd8ff');
scene.fog = new THREE.Fog('#bfeaff', 70, 150);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0, 22, -10);
scene.add(camera);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

scene.add(new THREE.HemisphereLight('#d8f3ff', '#c8f7a8', 1.6));
const sunLight = new THREE.DirectionalLight('#fff3c4', 2.2);
sunLight.position.set(-30, 50, -20);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 140 });
sunLight.shadow.bias = -0.0005;
scene.add(sunLight, sunLight.target);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...extra });
const mesh = (geo, material, { cast = true, receive = true } = {}) => { const m = new THREE.Mesh(geo, material); m.castShadow = cast; m.receiveShadow = receive; return m; };

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function textSprite(text, { color = '#3b2a63', bg = 'rgba(255,255,255,0.92)', size = 1, font = 44 } = {}) {
  const tex = canvasTexture(512, 128, (g, w, h) => {
    g.font = `700 ${font}px Fredoka, sans-serif`;
    const tw = Math.min(w - 8, g.measureText(text).width + 44);
    if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect((w - tw) / 2, 18, tw, h - 36, 40); g.fill(); }
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(4 * size, 1 * size, 1); s.renderOrder = 10;
  return s;
}

// The sun: a big cheerful face that rides along in the sky.
const sunTex = canvasTexture(512, 512, (g) => {
  g.translate(256, 256);
  for (let i = 0; i < 16; i++) { g.rotate(Math.PI / 8); g.fillStyle = i % 2 ? '#ffe066' : '#ffb627'; g.beginPath(); g.moveTo(-26, -150); g.lineTo(0, -246); g.lineTo(26, -150); g.fill(); }
  const grd = g.createRadialGradient(-30, -40, 20, 0, 0, 160); grd.addColorStop(0, '#fff7b0'); grd.addColorStop(1, '#ffc93c');
  g.fillStyle = grd; g.beginPath(); g.arc(0, 0, 150, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#3b2a63';
  g.beginPath(); g.ellipse(-50, -25, 14, 20, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(50, -25, 14, 20, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'white'; g.beginPath(); g.arc(-45, -32, 5, 0, 7); g.arc(55, -32, 5, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,110,150,0.55)'; g.beginPath(); g.arc(-85, 25, 24, 0, 7); g.arc(85, 25, 24, 0, 7); g.fill();
  g.strokeStyle = '#3b2a63'; g.lineWidth = 12; g.lineCap = 'round'; g.beginPath(); g.arc(0, 15, 55, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
});
const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, fog: false, depthWrite: false }));
sun.scale.set(40, 40, 1);
const SUN_OFFSET = new THREE.Vector3(-90, 75, 120); // fixed spot in the sky, follows the camera
scene.add(sun);

// ---------- town ----------
const W = MAP.bounds.maxX - MAP.bounds.minX, D = MAP.bounds.maxZ - MAP.bounds.minZ;
const ground = mesh(new THREE.BoxGeometry(W + 80, 1, D + 80), mat('#8ef06b'), { cast: false });
ground.position.y = -0.5; scene.add(ground);

const roadMat = mat('#aab2d8'), lineMat = mat('#ffe14d', { roughness: 0.4 }), stripeMat = mat('#ffffff');
for (const r of MAP.roads) {
  if (r.elevated) {
    const deck = mesh(new THREE.BoxGeometry(r.w, 0.6, r.d), mat('#d9d2ff'));
    deck.position.set(r.x + r.w / 2, 6.3, r.z + r.d / 2); scene.add(deck);
    for (const side of [-1, 1]) {
      const rail = mesh(new THREE.BoxGeometry(r.w, 0.6, 0.3), mat('#ff9fd0'));
      rail.position.set(r.x + r.w / 2, 6.9, r.z + r.d / 2 + side * (r.d / 2 - 0.15)); scene.add(rail);
    }
    continue;
  }
  const road = mesh(new THREE.BoxGeometry(r.w, 0.06, r.d), roadMat, { cast: false });
  road.position.set(r.x + r.w / 2, 0.03, r.z + r.d / 2); scene.add(road);
  const alongX = r.w > r.d, len = alongX ? r.w : r.d;
  for (let s = 1; s < len; s += 4) {
    const dash = mesh(new THREE.BoxGeometry(alongX ? 2 : 0.25, 0.02, alongX ? 0.25 : 2), lineMat, { cast: false });
    dash.position.set(alongX ? r.x + s : r.x + r.w / 2, 0.07, alongX ? r.z + r.d / 2 : r.z + s); scene.add(dash);
  }
}
for (const ix of (MAP.traffic?.intersections || [])) {
  const cover = mesh(new THREE.BoxGeometry(ix.hx * 2, 0.07, ix.hz * 2), roadMat, { cast: false });
  cover.position.set(ix.x, 0.04, ix.z); scene.add(cover);
  for (let k = -3; k <= 3; k++) for (const [dx, dz, rot] of [[0, -ix.hz - 1, 0], [0, ix.hz + 1, 0], [-ix.hx - 1, 0, 1], [ix.hx + 1, 0, 1]]) {
    const st = mesh(new THREE.BoxGeometry(rot ? 1.6 : 0.6, 0.02, rot ? 0.6 : 1.6), stripeMat, { cast: false });
    st.position.set(ix.x + dx + (rot ? 0 : k * 1.3), 0.08, ix.z + dz + (rot ? k * 1.1 : 0)); scene.add(st);
  }
}

// Zone patches show who owns which turf.
const zonePatches = {};
for (const z of MAP.zones) {
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(z.w, z.d), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false }));
  patch.rotation.x = -Math.PI / 2; patch.position.set(z.x + z.w / 2, 0.1, z.z + z.d / 2);
  scene.add(patch); zonePatches[z.id] = patch;
}

function signTexture(text, bg) {
  return canvasTexture(512, 128, (g, w, h) => { g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = 'white'; g.font = '700 64px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 4); });
}
for (const b of MAP.buildings) {
  const body = mesh(new THREE.BoxGeometry(b.w, b.h, b.d), mat(b.color));
  body.position.set(b.x + b.w / 2, b.h / 2, b.z + b.d / 2); scene.add(body);
  if (b.kind === 'pillar') continue;
  const roofColor = new THREE.Color(b.color).offsetHSL(0, 0.1, 0.12);
  if (b.kind === 'house') {
    const roof = mesh(new THREE.ConeGeometry(b.w * 0.78, 3, 4), mat(roofColor));
    roof.rotation.y = Math.PI / 4; roof.position.set(b.x + b.w / 2, b.h + 1.5, b.z + b.d / 2); scene.add(roof);
  } else {
    const roof = mesh(new THREE.BoxGeometry(b.w + 0.6, 0.5, b.d + 0.6), mat(roofColor));
    roof.position.set(b.x + b.w / 2, b.h + 0.25, b.z + b.d / 2); scene.add(roof);
  }
  const winMat = mat('#e9fbff', { emissive: '#bdeeff', emissiveIntensity: 0.25 });
  const faceZ = b.z + b.d + 0.02;
  for (let wx = b.x + 1.8; wx < b.x + b.w - 1; wx += 3) for (let wy = 2; wy < b.h - 1; wy += 2.6) {
    const win = mesh(new THREE.PlaneGeometry(1.4, 1.2), winMat, { cast: false }); win.position.set(wx, wy, faceZ); scene.add(win);
    const win2 = win.clone(); win2.position.z = b.z - 0.02; win2.rotation.y = Math.PI; scene.add(win2);
  }
  if (b.sign) {
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(b.w - 1, 9), 1.6), new THREE.MeshBasicMaterial({ map: signTexture(b.sign, '#ff5fa2') }));
    sign.position.set(b.x + b.w / 2, b.h - 0.9, faceZ + 0.03); scene.add(sign);
  }
}
for (const p of MAP.props) {
  if (p.kind === 'tree') {
    const trunk = mesh(new THREE.CylinderGeometry(0.25, 0.35, 2.4), mat('#c58b5a')); trunk.position.set(p.x, 1.2, p.z);
    const top = mesh(new THREE.SphereGeometry(1.8, 20, 14), mat((p.x + p.z) % 3 > 1 ? '#ff9fd0' : '#4fe36c')); top.position.set(p.x, 3.6, p.z);
    scene.add(trunk, top);
  } else if (p.kind === 'pond') {
    const pond = mesh(new THREE.CylinderGeometry(p.r, p.r, 0.1, 40), mat('#5cc8ff', { roughness: 0.1 }), { cast: false }); pond.position.set(p.x, 0.05, p.z); scene.add(pond);
  } else if (p.kind === 'slide') {
    const s = mesh(new THREE.BoxGeometry(1.2, 0.2, 5), mat('#ffd23f')); s.rotation.x = 0.5; s.position.set(p.x, 1.4, p.z); scene.add(s);
    const tower = mesh(new THREE.BoxGeometry(1.6, 2.6, 1.6), mat('#46c6ff')); tower.position.set(p.x, 1.3, p.z - 2.8); scene.add(tower);
  }
}
const clouds = [];
for (let i = 0; i < 9; i++) {
  const c = new THREE.Group();
  for (let k = 0; k < 4; k++) { const puff = mesh(new THREE.SphereGeometry(2 + Math.random() * 1.5, 14, 10), mat('#ffffff'), { receive: false }); puff.position.set(k * 2.4 - 3.6, Math.random(), Math.random() * 1.5); c.add(puff); }
  c.position.set(-70 + i * 18, 26 + Math.random() * 6, -60 + Math.random() * 120); scene.add(c); clouds.push(c);
}

// ---------- entity visuals ----------
const ents = new Map();
const lights = {};
function makeFire() {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.35 + i * 0.05, 1.3, 8), new THREE.MeshBasicMaterial({ color: i % 2 ? '#ffb627' : '#ff6a3d', transparent: true, opacity: 0.9 }));
    f.position.set(Math.cos(i * 1.6) * 0.35, 0.6, Math.sin(i * 1.6) * 0.35); g.add(f);
  }
  g.visible = false; return g;
}
function vagrantModel(color) {
  const g = new THREE.Group();
  const body = mesh(new THREE.CapsuleGeometry(0.42, 0.6, 6, 14), mat(color)); body.position.y = -0.05; g.add(body);
  const head = mesh(new THREE.SphereGeometry(0.36, 18, 14), mat('#ffd3b0')); head.position.y = 0.72; g.add(head);
  const hat = mesh(new THREE.SphereGeometry(0.37, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(new THREE.Color(color).offsetHSL(0.5, 0, 0))); hat.position.y = 0.78; g.add(hat);
  const pom = mesh(new THREE.SphereGeometry(0.11, 10, 8), mat('#ffffff')); pom.position.y = 1.15; g.add(pom);
  for (const s of [-1, 1]) { const eye = mesh(new THREE.SphereGeometry(0.05, 8, 6), mat('#3b2a63')); eye.position.set(s * 0.13, 0.75, 0.31); g.add(eye); }
  const bottle = mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.35, 8), mat('#5fd35f', { roughness: 0.2 })); bottle.position.set(0.45, 0.05, 0.15); g.add(bottle);
  return g;
}
function carModel(color) {
  const g = new THREE.Group();
  const base = mesh(new THREE.BoxGeometry(2.0, 0.7, 4.2), mat(color)); base.position.y = -0.1; g.add(base);
  const cab = mesh(new THREE.BoxGeometry(1.7, 0.6, 2.2), mat('#ffffff')); cab.position.set(0, 0.55, -0.2); g.add(cab);
  const glass = mesh(new THREE.BoxGeometry(1.72, 0.42, 2.0), mat('#7fd6ff', { roughness: 0.1 })); glass.position.set(0, 0.58, -0.2); g.add(glass);
  for (const [x, z] of [[-0.95, 1.3], [0.95, 1.3], [-0.95, -1.3], [0.95, -1.3]]) { const w = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.3, 14), mat('#3b2a63')); w.rotation.z = Math.PI / 2; w.position.set(x, -0.45, z); g.add(w); }
  const brake = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.05), new THREE.MeshBasicMaterial({ color: '#7a2030' })); brake.position.set(0, 0.05, -2.12); g.add(brake);
  g.userData.brake = brake; g.userData.glass = glass;
  return g;
}
function makeVisual(e) {
  let obj;
  if (e.kind === 'vagrant' || e.kind === 'sleeper') {
    obj = new THREE.Group();
    const model = vagrantModel(e.color); obj.add(model); obj.userData.model = model;
    const tag = textSprite(e.name, { size: 0.7 }); tag.position.y = 1.9; obj.add(tag); obj.userData.tag = tag;
    if (e.kind === 'sleeper') {
      model.rotation.z = 0; // body quaternion already lays the capsule down
      const zz = textSprite('Zzz', { color: '#7b61ff', bg: null, size: 0.8 }); zz.position.y = 1.4; obj.add(zz); obj.userData.zz = zz;
      const blanket = mesh(new THREE.BoxGeometry(0.95, 1.2, 0.5), mat('#ffd23f')); blanket.position.set(0, -0.15, 0.2); model.add(blanket);
    }
  } else if (e.kind === 'bottle') {
    obj = mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.4, 8), mat('#5fd35f', { roughness: 0.15, transparent: true, opacity: 0.9 }));
  } else if (e.type === 'dumpster') {
    obj = new THREE.Group();
    const box = mesh(new THREE.BoxGeometry(2.2, 1.4, 1.3), mat('#2fbf71')); obj.add(box);
    const lid = mesh(new THREE.BoxGeometry(2.3, 0.15, 1.4), mat('#1e8f53')); lid.position.y = 0.75; obj.add(lid);
  } else if (e.type === 'trash_can') {
    obj = new THREE.Group();
    obj.add(mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.9, 16), mat('#46c6ff')));
    const lid = mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.08, 16), mat('#2a8fd0')); lid.position.y = 0.48; obj.add(lid);
  } else if (e.type === 'car') {
    obj = carModel(e.color || '#ff7b54');
  } else if (e.type === 'window') {
    obj = mesh(new THREE.BoxGeometry(1.8, 1.4, 0.16), mat('#9ff0ff', { roughness: 0.05, emissive: '#7fe0ff', emissiveIntensity: 0.3 }));
  } else if (e.type === 'bus_shelter') {
    obj = new THREE.Group();
    const roof = mesh(new THREE.BoxGeometry(3.8, 0.2, 1.6), mat('#ff5fa2')); roof.position.y = 1.3; obj.add(roof);
    const back = mesh(new THREE.BoxGeometry(3.6, 2.4, 0.1), mat('#bff4ff', { transparent: true, opacity: 0.6 })); back.position.z = -0.7; obj.add(back);
    obj.userData.glass = back;
  } else if (e.type === 'stop_light') {
    obj = new THREE.Group();
    obj.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 4), mat('#6b5aa8')));
    const head = mesh(new THREE.BoxGeometry(0.6, 1.5, 0.5), mat('#ffd23f')); head.position.y = 2.4; obj.add(head);
    const bulbs = ['#ff4d6d', '#ffcf3f', '#4dff88'].map((c, i) => { const b = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), new THREE.MeshBasicMaterial({ color: c })); b.position.set(0, 2.85 - i * 0.45, 0.27); obj.add(b); return b; });
    obj.userData.bulbs = bulbs;
  } else if (e.type === 'stop_sign') {
    obj = new THREE.Group();
    obj.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4), mat('#c9c9e8')));
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 8), new THREE.MeshBasicMaterial({ map: signTexture('STOP', '#ff4d6d') }));
    s.rotation.x = Math.PI / 2; s.position.y = 1.3; obj.add(s);
  } else if (e.type === 'campfire') {
    obj = new THREE.Group();
    for (let i = 0; i < 3; i++) { const log = mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2), mat('#c58b5a')); log.rotation.set(Math.PI / 2, i * 1.05, 0); log.position.y = 0.1; obj.add(log); }
    obj.userData.alwaysFire = true;
  } else obj = mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat('#ffffff'));
  if (e.type === 'dumpster' || e.type === 'trash_can' || e.type === 'campfire') { const f = makeFire(); f.position.y = e.type === 'campfire' ? -0.1 : 0.5; obj.add(f); obj.userData.fire = f; if (obj.userData.alwaysFire) f.visible = true; }
  return obj;
}
function spawn(e) {
  if (ents.has(e.id)) despawn(e.id);
  const obj = makeVisual(e);
  if (e.pos) obj.position.set(e.pos[0], e.pos[1], e.pos[2]);
  scene.add(obj);
  ents.set(e.id, { ...e, obj, target: obj.position.clone(), qTarget: obj.quaternion.clone(), facing: 0, fresh: true });
}
function despawn(id) { const v = ents.get(id); if (v) { scene.remove(v.obj); ents.delete(id); } }

// ---------- first-person viewmodel ----------
const view = new THREE.Group();
camera.add(view);
const skin = mat('#ffd3b0');
const handR = mesh(new THREE.SphereGeometry(0.09, 14, 10), skin, { cast: false }); handR.scale.set(1, 0.8, 1.3);
const handL = handR.clone();
const heldBottle = mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.26, 10), mat('#5fd35f', { roughness: 0.15 }), { cast: false });
const neck = mesh(new THREE.CylinderGeometry(0.018, 0.03, 0.09, 8), mat('#5fd35f'), { cast: false }); neck.position.y = 0.17; heldBottle.add(neck);
const sleeve = color => mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.45, 10), mat(color), { cast: false });
let sleeveR = sleeve('#ff5fa2'), sleeveL = sleeve('#ff5fa2');
const armR = new THREE.Group(), armL = new THREE.Group();
function buildArm(arm, hand, sl) { arm.clear(); sl.rotation.x = Math.PI / 2; sl.position.z = 0.25; arm.add(sl, hand); }
buildArm(armR, handR, sleeveR); buildArm(armL, handL, sleeveL);
heldBottle.position.set(0, 0.1, -0.02); heldBottle.rotation.x = -0.3; handR.add(heldBottle);
view.add(armR, armL);
const VIEW_REST_R = new THREE.Vector3(0.3, -0.34, -0.75), VIEW_REST_L = new THREE.Vector3(-0.45, -0.55, -0.6);
armR.position.copy(VIEW_REST_R); armL.position.copy(VIEW_REST_L);
let throwAnim = 0, grabbing = false;
function setViewColor(c) { sleeveR.material.color.set(c); sleeveL.material.color.set(c); }

// ---------- effects ----------
const floaters = [];
function floatText(text, at, color = '#ff5fa2', life = 1.6) {
  const s = textSprite(text, { color, size: 0.9 }); s.position.set(at[0], at[1] + 2, at[2]); scene.add(s);
  floaters.push({ s, t: 0, life });
}
function feed(html) {
  const el = document.createElement('div'); el.className = 'card'; el.innerHTML = html; $('feed').prepend(el);
  setTimeout(() => el.remove(), 5000);
  while ($('feed').children.length > 5) $('feed').lastChild.remove();
}
let audio;
function honk(long, at) {
  if (!me) return;
  const m = ents.get(me); if (!m) return;
  const d = Math.hypot(m.obj.position.x - at[0], m.obj.position.z - at[2]);
  if (d > 35) return;
  audio ||= new AudioContext();
  const o = audio.createOscillator(), o2 = audio.createOscillator(), g = audio.createGain();
  o.type = o2.type = 'square'; o.frequency.value = 392; o2.frequency.value = 494;
  g.gain.value = 0.07 * (1 - d / 35);
  o.connect(g); o2.connect(g); g.connect(audio.destination);
  const dur = long ? 0.9 : 0.28; o.start(); o2.start(); o.stop(audio.currentTime + dur); o2.stop(audio.currentTime + dur);
}
const money = n => '$' + Math.round(n).toLocaleString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- network ----------
let ws, me = null, myPid = null, meta = null;
function connect(name) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: localStorage.getItem('tw_token'), name }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      localStorage.setItem('tw_token', m.token);
      me = m.you; myPid = m.you.slice(2);
      yaw = Math.PI; pitch = 0;
      for (const id of [...ents.keys()]) despawn(id);
      m.entities.forEach(spawn);
      $('status').style.display = 'none';
      feed(`Good morning, <b>${esc(m.name)}</b>. You stretch and get up.`);
    } else if (m.t === 'spawn') spawn(m.e);
    else if (m.t === 'despawn') despawn(m.id);
    else if (m.t === 's') {
      for (const r of m.b) {
        const v = ents.get(r[0]); if (!v) continue;
        v.target.set(r[1], r[2], r[3]);
        if (v.kind === 'vagrant') v.facing = r[8];
        else v.qTarget.set(r[4], r[5], r[6], r[7]);
        if (v.fresh) { v.obj.position.copy(v.target); v.obj.quaternion.copy(v.qTarget); v.fresh = false; }
      }
    } else if (m.t === 'm') { meta = m; updateHud(); }
    else if (m.t === 'fx') onFx(m);
  };
  ws.onclose = ev => {
    $('status').textContent = ev.code === 4000 ? 'You logged in somewhere else.' : 'The town is napping, reconnecting...';
    $('status').style.display = 'block';
    if (ev.code !== 4000) setTimeout(() => connect(name), 1500);
  };
}
function onFx(m) {
  if (m.kind === 'damage') { floatText('+' + money(m.cost), m.at); feed(`<b>${esc(m.by)}</b>: ${esc(m.label)} <b style="color:#ff5fa2">+${money(m.cost)}</b>`); }
  else if (m.kind === 'smash') floatText('*smash*', m.at, '#2fbf71', 0.8);
  else if (m.kind === 'say') { const v = ents.get(m.id); if (v) floatText(m.text, [v.obj.position.x, v.obj.position.y + 0.4, v.obj.position.z], '#3b2a63', 2); }
  else if (m.kind === 'honk') { floatText(m.long ? 'HOOONK!!' : 'HONK!', m.at, '#ff4d6d', 1); honk(m.long, m.at); if (m.target === me) feed('A car is honking at you. Get out of the street!'); }
  else if (m.kind === 'grab' && m.id === me) grabbing = !!m.target;
  else if (m.kind === 'turf') feed(`<b>${esc(m.by)}</b> now owns <b>${esc(m.zone)}</b>`);
}
function updateHud() {
  $('town').textContent = money(meta.town);
  const mine = meta.players.find(p => p.id === myPid);
  if (mine) { $('mine').textContent = money(mine.damage); $('cash').textContent = money(mine.cash); }
  $('rows').innerHTML = meta.players.map(p => `<div class="row ${p.asleep ? 'zz' : ''}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.asleep ? ' (asleep)' : ''} <span style="margin-left:auto">${money(p.damage)}</span></div>`).join('');
  for (const z of MAP.zones) {
    const o = meta.owners[z.id], patch = zonePatches[z.id];
    patch.material.opacity = o ? 0.28 : 0; if (o) patch.material.color.set(o.color);
  }
  for (const [id, v] of ents) {
    const st = meta.objects[id] || {};
    if (v.obj.userData.fire && !v.obj.userData.alwaysFire) v.obj.userData.fire.visible = !!st.fire;
    if (v.obj.userData.glass) v.obj.userData.glass.material.color.set(st.broken ? '#5a6b8c' : (v.type === 'car' ? '#7fd6ff' : '#bff4ff'));
    if (v.type === 'window') v.obj.material.color.set(st.broken ? '#4a5878' : '#9ff0ff');
    if (v.obj.userData.brake) v.obj.userData.brake.material.color.set(st.brake ? '#ff2244' : '#7a2030');
  }
  const light = meta.lights?.main_light;
  if (light) for (const [id, v] of ents) if (v.type === 'stop_light') {
    const phase = id.endsWith('ne') ? light.x : light.z;
    v.obj.userData.bulbs.forEach((b, i) => b.material.color.set(['red', 'yellow', 'green'][i] === phase ? ['#ff2244', '#ffcf3f', '#33ff77'][i] : '#4b3f6b'));
  }
}

// ---------- input ----------
const keys = {};
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (!ws || ws.readyState !== 1) return;
  if (e.code === 'KeyE') ws.send('{"t":"act"}');
  if (e.code === 'KeyF') ws.send('{"t":"grab"}');
});
addEventListener('keyup', e => { keys[e.code] = false; });
// First person: click to capture the mouse, then click throws along your look direction.
let yaw = Math.PI, pitch = 0, overview = false;
addEventListener('keydown', e => { if (e.code === 'Tab') { e.preventDefault(); overview = !overview; } });
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0025; pitch = Math.max(-1.4, Math.min(1.4, pitch - e.movementY * 0.0025));
});
renderer.domElement.addEventListener('pointerdown', () => {
  if (document.pointerLockElement !== renderer.domElement) { renderer.domElement.requestPointerLock?.(); return; }
  if (!ws || ws.readyState !== 1 || !me) return;
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  ws.send(JSON.stringify({ t: 'throw', dir: { x: dir.x, y: dir.y, z: dir.z } }));
  throwAnim = 1;
});
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  // camera looks down -z at yaw 0: forward = (-sin, -cos), right = (cos, -sin)
  const x = -Math.sin(yaw) * f + Math.cos(yaw) * r, z = -Math.cos(yaw) * f - Math.sin(yaw) * r;
  ws.send(JSON.stringify({ t: 'in', x, z, yaw: Math.atan2(-Math.sin(yaw), -Math.cos(yaw)), jump: !!keys.Space, run: !!(keys.ShiftLeft || keys.ShiftRight) }));
}, 50);

// ---------- frame loop ----------
const clock = new THREE.Clock();
const camOffset = new THREE.Vector3(0, 17, -15);
function frame() {
  const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
  const k = 1 - Math.exp(-dt * 14);
  for (const v of ents.values()) {
    if (v.pos) continue;
    v.obj.position.lerp(v.target, k);
    if (v.kind === 'vagrant') {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.facing);
      v.obj.userData.model.quaternion.slerp(q, k);
      v.obj.userData.model.position.y = Math.abs(Math.sin(t * 10)) * 0.08 * (v.target.distanceTo(v.obj.position) > 0.02 ? 1 : 0);
    } else if (v.kind === 'sleeper') {
      v.obj.userData.model.quaternion.slerp(v.qTarget, k);
      v.obj.userData.zz.position.y = 1.3 + Math.sin(t * 2) * 0.15;
    } else v.obj.quaternion.slerp(v.qTarget, k);
    if (v.obj.userData.fire?.visible) v.obj.userData.fire.children.forEach((f, i) => { f.scale.y = 0.8 + Math.sin(t * 14 + i * 2) * 0.3; });
  }
  for (const v of ents.values()) if (v.obj.userData.fire?.visible && v.pos) v.obj.userData.fire.children.forEach((f, i) => { f.scale.y = 0.8 + Math.sin(t * 14 + i * 2) * 0.3; });
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]; f.t += dt; f.s.position.y += dt * 1.2; f.s.material.opacity = 1 - f.t / f.life;
    if (f.t > f.life) { scene.remove(f.s); floaters.splice(i, 1); }
  }
  for (const c of clouds) { c.position.x += dt * 0.8; if (c.position.x > 90) c.position.x = -90; }
  const m = me && ents.get(me);
  if (m) {
    camera.rotation.order = 'YXZ';
    if (overview) {
      m.obj.visible = true; view.visible = false;
      const want = m.obj.position.clone().add(camOffset);
      camera.position.lerp(want, 1 - Math.exp(-dt * 5));
      camera.lookAt(m.obj.position.x, m.obj.position.y + 1, m.obj.position.z);
    } else {
      m.obj.visible = false; view.visible = true;
      if (m.color) setViewColor(m.color);
      camera.position.set(m.obj.position.x, m.obj.position.y + 0.72, m.obj.position.z);
      camera.rotation.set(pitch, yaw, 0);
      // walk bob, throw swing, and both hands forward while dragging something
      const moving = m.target.distanceTo(m.obj.position) > 0.03 || keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD;
      const bob = moving ? Math.sin(t * 11) * 0.02 : 0;
      throwAnim = Math.max(0, throwAnim - dt * 3.5);
      const swing = Math.sin(throwAnim * Math.PI);
      armR.position.set(VIEW_REST_R.x - swing * 0.15, VIEW_REST_R.y + bob + swing * 0.25, VIEW_REST_R.z - swing * 0.3);
      armR.rotation.x = swing * 1.2;
      heldBottle.visible = throwAnim < 0.4 && !grabbing;
      const lt = grabbing ? new THREE.Vector3(-0.22, -0.22, -0.65) : VIEW_REST_L;
      const rt = grabbing ? new THREE.Vector3(0.22, -0.22, -0.65) : null;
      armL.position.lerp(new THREE.Vector3(lt.x, lt.y - bob, lt.z), 1 - Math.exp(-dt * 12));
      if (rt) armR.position.copy(rt);
    }
    sunLight.position.set(m.obj.position.x - 30, 50, m.obj.position.z - 20); sunLight.target.position.copy(m.obj.position);
    const p = m.obj.position;
    const zn = MAP.zones.find(z => p.x >= z.x && p.x <= z.x + z.w && p.z >= z.z && p.z <= z.z + z.d);
    $('zoneName').textContent = zn ? zn.name : 'The Streets';
    const owner = zn && meta?.owners[zn.id];
    $('zoneOwner').innerHTML = zn ? (owner ? `turf of <b style="color:${owner.color}">${esc(owner.name)}</b>` : 'nobody owns this turf') : 'no turf here';
    // contextual prompt
    let best = null, bd = 9;
    for (const v of ents.values()) {
      if (!v.type || !MAP.actions[v.type] || v.type === 'window' || v.type === 'car') continue;
      const d = (v.obj.position.x - p.x) ** 2 + (v.obj.position.z - p.z) ** 2; if (d < bd) { bd = d; best = v; }
    }
    $('prompt').style.display = best ? 'block' : 'none';
    if (best) $('prompt').innerHTML = `<b>E</b> ${esc(MAP.actions[best.type].verb)}`;
  } else {
    camera.position.set(Math.sin(t * 0.1) * 50, 40, Math.cos(t * 0.1) * 50); camera.lookAt(0, 0, 0);
  }
  sun.position.copy(camera.position).add(SUN_OFFSET);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// ---------- login ----------
if (localStorage.getItem('tw_token')) connect();
else {
  $('login').style.display = 'grid';
  const go = () => { $('login').style.display = 'none'; connect($('nameInput').value.trim() || 'Vagrant'); };
  $('go').onclick = go; $('nameInput').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('nameInput').focus();
}
