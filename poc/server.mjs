// Turf War proof of concept: one persistent, server-authoritative physics town.
// Throwaway code to prove the connection model, not the real game.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import RAPIER from '@dimforge/rapier3d-compat';
import { ITEM_TYPES, ITEM_RULES, POCKET_TYPES, itemSpots, pickWeighted, dumpsterFind } from './items.mjs';
import { createCombat } from './combat.mjs';
import { initCopper } from './copper.mjs';
import { TERRAIN } from './terrain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'town-v2.json');
const GRACE_MS = Number(process.env.GRACE_MS || 5000); // design doc says 20 s; shorter for the demo
const HEAT_HALF_LIFE_S = Number(process.env.HEAT_HALF_LIFE_S || 600); // design doc says ~24 h
const PHYSICS_HZ = 60, SNAPSHOT_HZ = 20, META_HZ = 2;
// Same numbers as the client's predicted movement, so prediction rarely needs correcting.
const WALK = 4.6, RUN = 8, JUMP = 6.5, GRAVITY = -18;
const CAP_HALF = 0.55, CAP_R = 0.35; // capsule centre sits 0.9 m above the ground

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.MAP_FILE || 'town.json'), 'utf8'));

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
const events = new RAPIER.EventQueue(true);

// ---------- persistence ----------
function loadSave() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { accounts: {}, players: {}, town: { damage: 0 }, heat: {}, owners: {}, objects: {} }; }
}
const save = loadSave();
// Turf from zones that no longer exist on this map (the town grew, GAME-81) is dropped.
{ const ids = new Set(MAP.zones.map(z => z.id)); for (const k of ['heat', 'owners']) for (const id of Object.keys(save[k] || {})) if (!ids.has(id)) delete save[k][id]; }
let saveDirty = false;
function writeSave() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(save));
  fs.renameSync(tmp, DATA_FILE);
  saveDirty = false;
}

// ---------- static world ----------
const fixed = (x, y, z, hx, hy, hz) => {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
  return world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.8), b);
};
const { minX, maxX, minZ, maxZ } = MAP.bounds;
fixed((minX + maxX) / 2, -0.5, (minZ + maxZ) / 2, (maxX - minX) / 2 + 2, 0.5, (maxZ - minZ) / 2 + 2); // flat ground under everything
// Hills (GAME-96): a 1 m heightfield over the part of the map that isn't flat, from the same
// TERRAIN.h the client builds its ground from. Heights never go below 0, so the slab above still
// catches anything that slips through.
{ const A = TERRAIN.AREA, nc = A.maxX - A.minX, nr = A.maxZ - A.minZ, hs = new Float32Array((nr + 1) * (nc + 1));
  for (let i = 0; i <= nr; i++) for (let j = 0; j <= nc; j++) hs[i + j * (nr + 1)] = TERRAIN.h(A.minX + j, A.minZ + i);   // rows run along z, columns along x
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation((A.minX + A.maxX) / 2, 0, (A.minZ + A.maxZ) / 2));
  world.createCollider(RAPIER.ColliderDesc.heightfield(nr, nc, hs, { x: nc, y: 1, z: nr }).setFriction(0.8), b); }
const groundY = (x, z) => TERRAIN.h(x, z);
{ const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, hx = (maxX - minX) / 2 + 1, hz = (maxZ - minZ) / 2 + 1;
  fixed(minX - 0.5, 5, cz, 0.5, 10, hz); fixed(maxX + 0.5, 5, cz, 0.5, 10, hz);
  fixed(cx, 5, minZ - 0.5, hx, 10, 0.5); fixed(cx, 5, maxZ + 0.5, hx, 10, 0.5); }
// Colliders come from the art look test, in the order the client builds them.
const colliderFor = (c) => {
  const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(c.p[0], c.p[1], c.p[2]);
  if (c.q) desc.setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] });
  const b = world.createRigidBody(desc);
  const shape = c.box ? RAPIER.ColliderDesc.cuboid(c.box[0], c.box[1], c.box[2]) : RAPIER.ColliderDesc.cylinder(c.cyl[1] / 2, c.cyl[0]);
  return world.createCollider(shape.setFriction(0.8), b);
};

// ---------- car shape ----------
// A car is a lower body box (hood and trunk height) plus a cabin box (roof height),
// matching the look-test car model, so you can jump on the hood and then the roof.
// Local frame: nose along +z, y measured from the ground. Shared by parked and AI cars.
const CAR_HOOD_TOP = 0.93, CAR_ROOF = 1.4, CAR_CABIN_Z = -0.25;
function carColliders(body, bodyY, cabinZ = CAR_CABIN_Z) {
  const lower = RAPIER.ColliderDesc.cuboid(0.875, CAR_HOOD_TOP / 2 - 0.08, 2.2).setTranslation(0, CAR_HOOD_TOP / 2 + 0.08 - bodyY, 0).setFriction(0.8);
  const cabin = RAPIER.ColliderDesc.cuboid(0.8, (CAR_ROOF - CAR_HOOD_TOP) / 2, 0.9).setTranslation(0, (CAR_ROOF + CAR_HOOD_TOP) / 2 - bodyY, cabinZ).setFriction(0.8);
  return [world.createCollider(lower, body), world.createCollider(cabin, body)];
}

// ---------- entities ----------
const sessions = new Map(); // playerId -> { ws, entity, input, lastAct, graceTimer }
// Every synced thing is an entity with an id, a kind and (usually) a rigid body.
const entities = new Map();      // id -> entity
const byCollider = new Map();    // collider handle -> entity
let nextItem = 1;
let combat = null;                // GAME-85 fights, set up once the character controller exists

function addEntity(e) {
  entities.set(e.id, e);
  if (e.collider) byCollider.set(e.collider.handle, e);
  for (const c of e.extraColliders || []) byCollider.set(c.handle, e);
  broadcast({ t: 'spawn', e: describe(e) });
  return e;
}
function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
  if (e.joint) { world.removeImpulseJoint(e.joint, true); e.joint = null; }
  for (const other of entities.values()) if (other.grabbing === id) releaseGrab(other);
  if (e.collider) byCollider.delete(e.collider.handle);
  for (const c of e.extraColliders || []) byCollider.delete(c.handle);
  if (e.body) world.removeRigidBody(e.body);
  entities.delete(id);
  broadcast({ t: 'despawn', id });
}
function describe(e) {
  const d = { id: e.id, kind: e.kind, type: e.type };
  if (e.player) Object.assign(d, { name: e.player.name, color: e.player.color, pid: e.player.id, held: e.player.held || null });
  if (e.grabbing) d.grabbing = e.grabbing;
  if (e.fixedPos) d.pos = e.fixedPos;
  if (e.color) d.color = e.color;
  if (e.index !== undefined) d.index = e.index;
  if (e.spec) { d.s = e.spec.s; d.hex = e.spec.hex; if (e.spec.color) d.color = e.spec.color; }
  if (e.cat) { d.half = e.cat.half; d.r = e.cat.r; d.hh = e.cat.hh; d.drag = e.cat.drag; d.label = e.cat.label; }
  if (e.kind === 'npc') Object.assign(d, combat.describeNpc(e));
  if (e.kind === 'vagrant' && combat && combat.isDown(e)) d.down = 1;
  if (e.type === 'car' && e.state && e.state.dmg) d.dmg = e.state.dmg;   // dents and cracked glass (GAME-83)
  if (e.dir !== undefined) d.dir = e.dir;
  return d;
}

// Fixtures: static things you can act on (trash piles, the dumpster, the stop sign,
// windows, parked cars). The client already draws them; the server owns their state.
const fixtureCount = {};
MAP.colliders.forEach((c, i) => {
  if (c.loose) return; // drawn and simulated as a movable prop instead (see props)
  if (c.tag === 'npc') return;          // the street vagrants are server-driven NPCs now (combat.mjs)
  if (c.loose) return; // drawn and simulated as a movable prop instead (see props)
  let collider, extraColliders;
  if (c.tag === 'car') {
    // Parked cars: same hood + cabin shape as traffic, so you can climb onto them.
    // c.ry is the model's yaw from the look test; the car shape's nose points along +z.
    const yaw = c.ry !== undefined ? c.ry - Math.PI / 2 : (c.box[0] > c.box[2] ? Math.PI / 2 : 0);
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.p[0], groundY(c.p[0], c.p[2]), c.p[2]).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }));
    [collider, ...extraColliders] = carColliders(b, 0, c.ry !== undefined ? CAR_CABIN_Z : 0);
    // Not enumerable: MAP is sent to clients as /town.json, and a physics body can't be serialised.
    Object.defineProperty(c, 'carBody', { value: b, enumerable: false, writable: true, configurable: true });
  } else collider = colliderFor(c);
  if (!c.tag || c.tag === 'npc') return;
  const n = fixtureCount[c.tag] = (fixtureCount[c.tag] || 0) + 1;
  const id = c.tag === 'pile' ? 'pile:' + c.pile : `f:${c.tag}${n}`;
  addEntity({ id, kind: 'fixture', type: c.tag, collider, extraColliders, carBody: c.carBody, fixedPos: c.p, index: c.pile, dir: c.dir, state: {} });
});
// Extra fire hydrants (GAME-94): the client builds their models from the same list.
(MAP.hydrants || []).forEach((h, i) => {
  const p = [h.p[0], groundY(h.p[0], h.p[1]) + 0.35, h.p[1]];
  const collider = colliderFor({ p, cyl: [0.17, 0.7] });
  addEntity({ id: 'f:hydrantx' + (i + 1), kind: 'fixture', type: 'hydrant', collider, fixedPos: p, dir: h.dir || 0, state: {} });
});
// Broken windows survive restarts: { brokenUntil, boardAt, glass: { s: seed, h: [[u, v], ...] } }.
save.windows ||= {};
for (const w of MAP.windows) {
  const collider = colliderFor({ p: w.p, q: w.q, box: w.half });
  const st = save.windows[w.id] && save.windows[w.id].brokenUntil > Date.now() ? save.windows[w.id] : {};
  addEntity({ id: w.id, kind: 'fixture', type: 'window', collider, fixedPos: w.p, rot: w.q, half: w.half, index: w.gi, value: w.value, state: st });
}
// Where on the pane a hit landed, as u, v in -1..1 (GAME-84: cracks start there).
function paneUV(win, at) {
  const [qx, qy, qz, qw] = win.rot || [0, 0, 0, 1];
  const vx = at[0] - win.fixedPos[0], vy = at[1] - win.fixedPos[1], vz = at[2] - win.fixedPos[2];
  // rotate by the inverse quaternion
  const ix = -qx, iy = -qy, iz = -qz;
  const tx = 2 * (iy * vz - iz * vy), ty = 2 * (iz * vx - ix * vz), tz = 2 * (ix * vy - iy * vx);
  const lx = vx + qw * tx + (iy * tz - iz * ty), ly = vy + qw * ty + (iz * tx - ix * tz), lz = vz + qw * tz + (ix * ty - iy * tx);
  const cl = (n) => Math.max(-1, Math.min(1, n));
  // Third value: which face it hit (1 = the street side the pane faces, -1 = from inside).
  return [+cl(lx / win.half[0]).toFixed(3), +cl(ly / win.half[1]).toFixed(3), lz >= 0 ? 1 : -1];
}
// ---------- loose props (GAME-87) ----------
// Everything that is not fixed to the world is a dynamic body the server simulates:
// players shove it by walking into it, grab and drag it (G), knock it over with
// bottles or cars. Where it comes to rest is saved, so it stays put for everyone.
// To make a map prop movable, add one line to town.json "props":
//   { "id": "o:cart3", "type": "cart", "p": [x, y, z], "ry": 0.7 }      (y = body centre; "q" for full rotation)
// Unknown types still work if the entry gives "half": [hx, hy, hz] and "mass" (drawn as a plain box).
// Resting bodies sleep: they cost no physics time and are never sent in snapshots.
//   half: box half extents, or r + hh for an upright cylinder.  com: centre of mass offset (low = hard to tip).
//   drag: walk speed multiplier while you drag it.  label: name in the grab prompt.
const PROP_TYPES = {
  crate:    { half: [0.35, 0.35, 0.35], mass: 2,   friction: 0.6,  restitution: 0.25, drag: 1,    label: 'crate' },
  cone:     { r: 0.2, hh: 0.38,         mass: 0.8, friction: 0.6,  restitution: 0.25, drag: 1,    label: 'cone' },
  cart:     { half: [0.33, 0.55, 0.52], mass: 14,  friction: 0.06, restitution: 0.15, drag: 0.95, label: 'shopping cart', com: [0, -0.3, 0], linDamp: 0.35, angDamp: 1.5, handle: [0, 0.5, -0.52] },
  mattress: { half: [0.95, 0.11, 0.7],  mass: 12,  friction: 1.0,  restitution: 0.05, drag: 0.85, label: 'mattress', linDamp: 0.6, angDamp: 1.2 },
  couch:    { half: [1.42, 0.6, 0.54],  mass: 40,  friction: 0.9,  restitution: 0.05, drag: 0.6,  label: 'couch', com: [0, -0.2, 0], linDamp: 0.6, angDamp: 1.5 },
  box:      { half: [0.3, 0.22, 0.24],  mass: 1.2, friction: 0.7,  restitution: 0.1,  drag: 1,    label: 'cardboard box', ccd: true },
  trashcan: { r: 0.32, hh: 0.45,        mass: 5,   friction: 0.6,  restitution: 0.2,  drag: 0.95, label: 'trash can', com: [0, -0.15, 0] },
};
function propType(pr) {
  if (pr.type === 'crate') return { ...PROP_TYPES.crate, half: [pr.s / 2, pr.s / 2, pr.s / 2] };
  return PROP_TYPES[pr.type] || { half: pr.half || [0.3, 0.3, 0.3], mass: pr.mass || 5, friction: 0.7, restitution: 0.1, drag: 0.9, label: pr.label || pr.type };
}
function propRotation(pr) {
  if (pr.q) return { x: pr.q[0], y: pr.q[1], z: pr.q[2], w: pr.q[3] };
  const a = (pr.ry || 0) / 2;
  return { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) };
}
function propCollider(cat) {
  let desc, I;
  if (cat.half) {
    const [x, y, z] = cat.half.map(v => v * 2), m = cat.mass;
    desc = RAPIER.ColliderDesc.cuboid(...cat.half);
    I = { x: m / 12 * (y * y + z * z), y: m / 12 * (x * x + z * z), z: m / 12 * (x * x + y * y) };
  } else {
    const m = cat.mass, h = cat.hh * 2;
    desc = RAPIER.ColliderDesc.cylinder(cat.hh, cat.r);
    I = { x: m / 12 * (3 * cat.r * cat.r + h * h), y: m / 2 * cat.r * cat.r, z: m / 12 * (3 * cat.r * cat.r + h * h) };
  }
  const com = cat.com || [0, 0, 0];
  desc.setMassProperties(cat.mass, { x: com[0], y: com[1], z: com[2] }, I, { x: 0, y: 0, z: 0, w: 1 });
  return desc.setFriction(cat.friction).setRestitution(cat.restitution);
}
const savedKey = pr => 'o:' + pr.id.slice(2);
// Props in town.json sit on flat ground (y from 0); lift them onto the hills, and never restore a
// saved prop below the ground (saves from before the hills existed).
function propStart(pr, saved) {
  if (saved) return [saved.p[0], Math.max(saved.p[1], groundY(saved.p[0], saved.p[2]) + 0.15), saved.p[2]];
  return [pr.p[0], pr.p[1] + groundY(pr.p[0], pr.p[2]), pr.p[2]];
}
function spawnProp(pr, fresh) {
  const cat = propType(pr);
  const saved = !fresh && save.objects[savedKey(pr)];
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(...propStart(pr, saved))
    .setRotation(saved ? { x: saved.q[0], y: saved.q[1], z: saved.q[2], w: saved.q[3] } : propRotation(pr))
    .setLinearDamping(cat.linDamp ?? 0.3).setAngularDamping(cat.angDamp ?? 0.5)
    .setCcdEnabled(!!cat.ccd);
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(propCollider(cat), body);
  body.sleep();
  return addEntity({ id: pr.id, kind: 'prop', type: pr.type, body, collider, mass: cat.mass, cat, spec: pr, unsettled: !saved, state: {} });
}
for (const pr of MAP.props) spawnProp(pr);
// Burnables (GAME-86): trees, bushes and plants you can set on fire with a lighter.
// The client draws them; ids match its build order ("t:0", "t:1", ...).
for (const b of MAP.burnables || []) addEntity({ id: b.id, kind: 'fixture', type: b.type, fixedPos: b.p, s: b.s, state: {} });
// Shops: walk up and buy something (Sunny Mart sells lighters).
for (const sh of MAP.shops || []) addEntity({ id: sh.id, kind: 'fixture', type: sh.type, fixedPos: sh.p, item: sh.item, price: sh.price, state: {} });
// Props placed by hand in town.json may float or overlap a little. Let new ones settle
// once at startup so they are already lying still when the first player arrives.
(function settleNewProps() {
  const fresh = [...entities.values()].filter(e => e.kind === 'prop' && e.unsettled);
  if (!fresh.length) return;
  for (const e of fresh) e.body.wakeUp();
  world.timestep = 1 / 60;
  for (let i = 0; i < 180 && fresh.some(e => !e.body.isSleeping()); i++) world.step();
  for (const e of fresh) { e.unsettled = false; e.body.sleep(); }
})();
// Something knocked out of the world (through a gap, off the map) goes back to its spot.
function rescueLostProps() {
  for (const e of entities.values()) {
    if (e.kind !== 'prop' || e.body.isSleeping()) continue;
    const t = e.body.translation();
    if (t.y > -5 && t.x > minX - 5 && t.x < maxX + 5 && t.z > minZ - 5 && t.z < maxZ + 5) continue;
    const pr = e.spec;
    e.body.setTranslation({ x: pr.p[0], y: pr.p[1] + groundY(pr.p[0], pr.p[2]), z: pr.p[2] }, true);
    e.body.setRotation(propRotation(pr), true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true); e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}

// ---------- players ----------
const controller = world.createCharacterController(0.05);
controller.enableAutostep(0.45, 0.25, true);
controller.enableSnapToGround(0.4);
controller.setMaxSlopeClimbAngle(50 * Math.PI / 180);

combat = createCombat({ RAPIER, world, controller, entities, addEntity, broadcast: (m) => broadcast(m), addDamage: (...a) => addDamage(...a),
  MAP, NPCS: JSON.parse(fs.readFileSync(path.join(__dirname, 'npcs.json'), 'utf8')).npcs, dt: 1 / PHYSICS_HZ, WALK, RUN, GRAVITY, CAP_HALF, CAP_R,
  throwFrom: (e, v) => throwFrom(e, v), releaseGrab: (e) => releaseGrab(e) });

const COLORS = ['#ff5fa2', '#46c6ff', '#ffb627', '#7ae582', '#b388ff', '#ff7b54', '#00d1b2', '#ffd6e0'];

function vagrantId(pid) { return 'p:' + pid; }

function spawnAwake(p) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, Math.max(p.y, groundY(p.x, p.z) + CAP_HALF + CAP_R) + 0.05, p.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF, CAP_R).setFriction(0.5), body);
  return addEntity({ id: vagrantId(p.id), kind: 'vagrant', player: p, body, collider, vy: 0, grabbing: null, state: {} });
}

// A logged-out vagrant lies down where they stood: a dynamic, draggable body.
function spawnSleeper(p) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(p.x, Math.max(p.y, groundY(p.x, p.z) + 0.45), p.z)
    .setRotation(p.q ? { x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] } : { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
    .setLinearDamping(1.5).setAngularDamping(2.0);
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF, CAP_R).setMass(70).setFriction(0.9), body);
  return addEntity({ id: vagrantId(p.id), kind: 'sleeper', player: p, body, collider, mass: 70, state: {} });
}

function lieDown(pid) {
  const s = sessions.get(pid);
  if (!s) return;
  const p = save.players[pid];
  const t = s.entity.body.translation();
  Object.assign(p, { x: t.x, y: t.y, z: t.z, asleep: true, q: null });
  removeEntity(s.entity.id);
  spawnSleeper(p);
  sessions.delete(pid);
  writeSave();
  console.log(`[town] ${p.name} lay down at (${t.x.toFixed(1)}, ${t.z.toFixed(1)})`);
}

function wakeUp(p) {
  const id = vagrantId(p.id);
  const e = entities.get(id);
  if (e && e.kind === 'sleeper') {
    const t = e.body.translation();
    Object.assign(p, { x: t.x, y: CAP_HALF + CAP_R, z: t.z });
    removeEntity(id);
  }
  p.asleep = false;
  return spawnAwake(p);
}

// Load everyone who was ever here. Sleepers appear on the ground right away.
for (const p of Object.values(save.players)) { p.asleep = true; spawnSleeper(p); }

// ---------- actions, damage, heat ----------
const ACTIONS = MAP.actions;
function zoneAt(x, z) {
  return MAP.zones.find(zn => x >= zn.x && x <= zn.x + zn.w && z >= zn.z && z <= zn.z + zn.d) || null;
}
function posOf(e) {
  if (e.body) { const t = e.body.translation(); return [t.x, t.y, t.z]; }
  return e.fixedPos;
}
function addDamage(p, cost, where, label) {
  if (!p || cost <= 0) return;
  p.damage = (p.damage || 0) + cost;
  save.town.damage += cost;
  const zn = zoneAt(where[0], where[2]);
  if (zn) {
    const h = (save.heat[zn.id] ||= {});
    h[p.id] = (h[p.id] || 0) + cost;
  }
  saveDirty = true;
  broadcast({ t: 'fx', kind: 'damage', at: where, cost, label, by: p.name });
}
function decayHeatAndOwners() {
  const k = Math.pow(0.5, 5 / HEAT_HALF_LIFE_S);
  for (const zn of MAP.zones) {
    const h = save.heat[zn.id] || {};
    let best = null, bestV = 0;
    for (const [pid, v] of Object.entries(h)) {
      const nv = v * k;
      if (nv < 1) { delete h[pid]; continue; }
      h[pid] = nv;
      if (nv > bestV) { best = pid; bestV = nv; }
    }
    const cur = save.owners[zn.id];
    const curV = cur ? (h[cur] || 0) : 0;
    // A challenger must beat the owner by 10% so ownership does not flicker.
    if (best && best !== cur && bestV > curV * 1.1) {
      save.owners[zn.id] = best;
      broadcast({ t: 'fx', kind: 'turf', zone: zn.name, by: save.players[best].name });
    } else if (!best && cur) delete save.owners[zn.id];
  }
  saveDirty = true;
}

// Copper wire theft (GAME-91): lampposts and pliers live in copper.mjs.
const copper = initCopper({ MAP, ACTIONS, save, sessions, addEntity, addDamage, broadcast, posOf });

function nearest(e, radius, filter) {
  const [x, , z] = posOf(e);
  let best = null, bd = radius * radius;
  for (const o of entities.values()) {
    if (o === e || !filter(o)) continue;
    const [ox, , oz] = posOf(o);
    const d = (ox - x) ** 2 + (oz - z) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// ---------- lighters and fire (GAME-86) ----------
// You need a lighter to set anything on fire. It lives in your pockets as
// p.items.lighter = { fuel } (shared with the GAME-82 item code), and each fire costs one flick of fuel.
const BURNABLE = new Set(['pile', 'dumpster', 'tree', 'bush', 'plant']);
const PLANTS = new Set(['tree', 'bush', 'plant']);
const LIGHTER_FUEL = 10;
const fuelOf = p => (p.items && p.items.lighter && p.items.lighter.fuel) || 0;
function tell(s, text) { if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'fx', kind: 'say', id: s.entity.id, text })); }
function sendInv(s) { if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'inv', lighter: fuelOf(s.entity.player) })); }
function giveLighter(s) {
  const p = s.entity.player;
  p.items ||= {};
  p.items.lighter = { fuel: LIGHTER_FUEL };
  saveDirty = true;
  sendInv(s);
}
// Shops are fixtures of type 'shop_<item>'; SHOP_ITEMS says how each item lands in your pockets.
const SHOP_ITEMS = {
  lighter: { name: 'a lighter', has: p => fuelOf(p) > 3, give: giveLighter },
  pliers: { name: 'some pliers', has: p => copper.hasTool(p), give: s => { copper.giveTool(s.entity.player); saveDirty = true; } },
};
function buy(s, shop) {
  const p = s.entity.player, it = SHOP_ITEMS[shop.item];
  if (!it) return;
  if (it.has(p)) return tell(s, `You already have ${it.name}.`);
  if ((p.cash || 0) < shop.price) return tell(s, `That's $${shop.price}. You have $${p.cash || 0}. Go panhandle.`);
  p.cash -= shop.price;
  it.give(s);
  tell(s, `Bought ${it.name} for $${shop.price}.`);
}
// Sets a burnable alight. by = the save.players entry who gets the damage and heat.
function ignite(target, by, now, spread) {
  const a = ACTIONS[target.type];
  target.state.busyUntil = now + a.repairSec * 1000;
  target.state.fireUntil = now + (a.burnSec || 30) * 1000;
  target.state.burntUntil = now + a.repairSec * 1000;
  target.state.litAt = now; target.state.spread = false; target.state.by = by.id;
  addDamage(by, a.cost, posOf(target), spread ? 'The fire spread' : a.verb);
}
// Fire spreads from anything burning to plants close by, a few seconds in.
function spreadFires() {
  const now = Date.now();
  for (const src of entities.values()) {
    const st = src.state;
    if (!st || !BURNABLE.has(src.type) || src.type === 'dumpster' || st.spread || (st.fireUntil || 0) < now || now - st.litAt < 7000) continue;
    st.spread = true;
    const by = save.players[st.by]; if (!by) continue;
    const [x, , z] = posOf(src);
    const reach = src.type === 'tree' ? 4.5 : 3.5;
    for (const o of entities.values()) {
      if (o === src || !PLANTS.has(o.type) || now < (o.state.busyUntil || 0)) continue;
      const [ox, , oz] = posOf(o);
      if ((ox - x) ** 2 + (oz - z) ** 2 < reach * reach && Math.random() < 0.6) ignite(o, by, now, true);
    }
  }
}
setInterval(spreadFires, 1000);

const HIT_ONLY = new Set(['window', 'car', 'crate', 'cone']);

// ---------- player animations (GAME-92) ----------
// playAnim(entity, clip, extra) shows a clip from tools/anim.js on that vagrant for everyone.
// The player's own client plays it in first person right away and skips the echo.
function playAnim(e, clip, extra) { broadcast({ t: 'fx', kind: 'anim', id: e.id, clip, ...(extra || {}) }); }
// Which clip each E interaction plays (a map action can override it with "anim"). Digging in
// dumpsters and piles, copper and lighting have their own animations in their modules.
const ACTION_ANIM = { stop_sign: 'panhandle', fire_can: 'warm', couch: 'sit' };
// Where you sit: the seat's centre, facing the way its front faces (local +z).
const SEATS = new Set(['couch']);
function seatOf(o) {
  if (o.body) { const t = o.body.translation(), q = o.body.rotation(); return [t.x, t.z, Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y))]; }
  return [o.fixedPos[0], o.fixedPos[2], 0];
}
// E does the fixture's main thing (dumpsters: dig for junk); F lights anything that burns.
function interact(s, light) {
  const e = s.entity, p = e.player;
  const now = Date.now();
  if (now - (s.lastAct || 0) < 600) return;
  s.lastAct = now;
  // Skip things already burning or burnt, so a charred tree never hides the trash pile beside it. F only looks at burnables.
  // Holding a wrench, a hydrant in reach wins over whatever else is nearer (GAME-94).
  const target = (!light && p.held === 'wrench' && nearest(e, 3, o => o.type === 'hydrant'))
    || nearest(e, 3, o => (o.kind === 'fixture' || o.kind === 'prop') && ACTIONS[o.type] && !HIT_ONLY.has(o.type) && now >= ((o.state && o.state.busyUntil) || 0) && (!light || BURNABLE.has(o.type)));
  if (!target) return;
  if (target.type === 'hydrant') return hydrantAct(s, target, now);
  if (target.type === 'lamppost') return copper.start(s, target);
  if ((target.type === 'dumpster' || target.type === 'pile') && !light) return rummage(s, target, now);
  const a = ACTIONS[target.type];
  if (target.type.startsWith('shop_')) return buy(s, target);
  if (BURNABLE.has(target.type)) {
    const fuel = fuelOf(p);
    if (!fuel) return tell(s, 'You need a lighter. Dig through a dumpster or buy one at Sunny Mart.');
    p.items.lighter.fuel = fuel - 1;
    if (fuel - 1 <= 0) { p.items.lighter = null; tell(s, 'Your lighter is out of fluid.'); }
    sendInv(s);
    broadcast({ t: 'fx', kind: 'flick', id: e.id });
    playAnim(e, 'light', { tpOnly: true });      // others see you crouch and flick it (your own hand: fire-client)
    return ignite(target, p, now);
  }
  target.state.busyUntil = now + a.repairSec * 1000;
  const clip = a.anim || ACTION_ANIM[target.type];
  if (clip) playAnim(e, clip, SEATS.has(target.type) ? { seat: seatOf(target) } : undefined);
  if (a.cash) { p.cash = (p.cash || 0) + a.cash; broadcast({ t: 'fx', kind: 'say', id: e.id, text: `Spare change? (+$${a.cash})` }); }
  if (a.hangout) broadcast({ t: 'fx', kind: 'say', id: e.id, text: target.type === 'couch' ? 'comfy' : 'warming up' });
  addDamage(p, a.cost, posOf(target), a.verb);
}

// ---------- throwable items (GAME-82) ----------
// Junk lies around as dynamic bodies. Pick one up and it lives in your hand (p.held),
// click to throw it. Bottles smash; rocks, cans and bricks land and can be reused.
function spawnItem(type, pos, opts = {}) {
  const T = ITEM_TYPES[type];
  const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(pos[0], pos[1], pos[2])
    .setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(true);
  if (opts.vel) desc.setLinvel(...opts.vel);
  if (opts.spin) desc.setAngvel(opts.spin);
  if (opts.rot) desc.setRotation(opts.rot);
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(T.shape(RAPIER).setMass(T.mass).setFriction(0.7).setRestitution(type === 'can' ? 0.35 : 0.15), body);
  return addEntity({ id: 'i:' + nextItem++, kind: 'item', type, body, collider, mass: T.mass, born: Date.now(), spot: opts.spot ?? null, state: {} });
}
const spots = itemSpots(MAP).map(sp => ({ ...sp, item: null, nextAt: 0 }));
console.log(`[town] ${spots.length} junk spots`);
const randomUpright = () => { const a = Math.random() * Math.PI; return { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) }; };
const lyingDown = () => { const a = Math.random() * Math.PI; return { x: Math.SQRT1_2 * Math.cos(a), y: 0, z: Math.SQRT1_2 * Math.sin(a), w: Math.SQRT1_2 }; };
function stepItems(now) {
  for (const sp of spots) {
    const it = sp.item && entities.get(sp.item);
    if (it) {                                     // knocked or kicked away from its spot: the spot frees up
      const t = it.body.translation();
      if ((t.x - sp.x) ** 2 + (t.z - sp.z) ** 2 > 4) { it.spot = null; sp.item = null; sp.nextAt = now + respawnMs(); }
      continue;
    }
    if (sp.item) { sp.item = null; sp.nextAt = now + respawnMs(); continue; }
    if (now < sp.nextAt) continue;
    const types = sp.types || null;
    const type = types ? types[Math.floor(Math.random() * types.length)] : pickWeighted('ground');
    const e = spawnItem(type, [sp.x, groundY(sp.x, sp.z) + 0.25, sp.z], { rot: type === 'bottle' || type === 'can' ? (Math.random() < 0.6 ? lyingDown() : randomUpright()) : randomUpright(), spot: sp });
    sp.item = e.id;
  }
  // Tidy up: loose junk beyond the cap goes, oldest first. Anything that fell out of town goes too.
  const loose = [...entities.values()].filter(e => e.kind === 'item' && !e.spot && !e.live);
  for (const e of loose) if (e.body.translation().y < -5) removeEntity(e.id);
  if (loose.length > ITEM_RULES.maxLoose) loose.sort((a, b) => a.born - b.born).slice(0, loose.length - ITEM_RULES.maxLoose).forEach(e => removeEntity(e.id));
}
const respawnMs = () => (ITEM_RULES.respawnMinS + Math.random() * (ITEM_RULES.respawnMaxS - ITEM_RULES.respawnMinS)) * 1000;

function setHeld(e, type) {
  e.player.held = type || null;
  saveDirty = true;
  broadcast({ t: 'fx', kind: 'held', id: e.id, item: e.player.held });
}
// Drop what you hold just in front of you (used when swapping or when a dumpster find won't fit).
function dropHeld(e, at) {
  const type = e.player.held; if (!type) return;
  const t = e.body.translation(), f = e.facing || 0;
  spawnItem(type, at || [t.x + Math.sin(f) * 0.5, t.y + 0.2, t.z + Math.cos(f) * 0.5], { rot: randomUpright() });
  setHeld(e, null);
}
function pickup(s, id) {
  const e = s.entity, now = Date.now();
  if (now - (s.lastPick || 0) < 250) return;
  const it = typeof id === 'string' ? entities.get(id) : nearest(e, ITEM_RULES.pickupReach, o => o.kind === 'item');
  if (!it || it.kind !== 'item') return;
  const a = e.body.translation(), b = it.body.translation(), v = it.body.linvel();
  if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > ITEM_RULES.pickupReach + 0.4) return;
  if (it.live && Math.hypot(v.x, v.y, v.z) > 4) return;          // can't snatch it out of the air
  s.lastPick = now;
  const swap = e.player.held, at = [b.x, b.y + 0.05, b.z];
  if (it.spot) { it.spot.item = null; it.spot.nextAt = now + respawnMs(); }
  removeEntity(it.id);
  if (swap) { e.player.held = null; spawnItem(swap, at, { rot: randomUpright() }); }
  setHeld(e, it.type);
}
// Pocket items live on the player (p.items) and persist with them.
// lighter: { fuel } (lighting fires spends fuel, GAME-86); cigarettes: a count.
function pocketItem(e, key) {
  const items = e.player.items ||= {};
  if (key === 'lighter') items.lighter = { fuel: Math.max(LIGHTER_FUEL, fuelOf(e.player)) };
  else if (key === 'pliers') items.pliers = { uses: 3 };
  else items[key] = (items[key] || 0) + 1;
  saveDirty = true;
  broadcast({ t: 'fx', kind: 'pocket', id: e.id, key, name: POCKET_TYPES[key]?.name || key });
  if (key === 'lighter') sendInv(sessions.get(e.player.id));
  if (key === 'pliers') copper.sendInv(e.player);
}
function rummage(s, dump, now) {
  const e = s.entity, st = dump.state;
  if ((st.fireUntil || 0) > now || (st.burntUntil || 0) > now) return broadcast({ t: 'fx', kind: 'say', id: e.id, text: (st.fireUntil || 0) > now ? 'Too hot to dig in there' : 'Nothing left but ash' });
  // stock refills slowly; a picked-clean dumpster needs a while
  if (st.stock === undefined) { st.stock = ITEM_RULES.dumpsterStock; st.refillAt = now; }
  const refill = Math.floor((now - st.refillAt) / (ITEM_RULES.dumpsterRefillS * 1000));
  if (refill > 0) { st.stock = Math.min(ITEM_RULES.dumpsterStock, st.stock + refill); st.refillAt += refill * ITEM_RULES.dumpsterRefillS * 1000; }
  if (st.stock >= ITEM_RULES.dumpsterStock) st.refillAt = now;
  if (st.stock <= 0) return broadcast({ t: 'fx', kind: 'say', id: e.id, text: 'Picked clean. Check back later' });
  st.stock--;
  const find = dumpsterFind(), type = find.key;
  broadcast({ t: 'fx', kind: 'rummage', id: dump.id, by: e.id, item: type, at: dump.fixedPos });
  if (find.pocket) return pocketItem(e, type);
  if (!e.player.held) return setHeld(e, type);
  // Hands full: the find gets tossed out of the dumpster toward you.
  const d = dump.fixedPos, t = e.body.translation(), dx = t.x - d[0], dz = t.z - d[2], n = Math.hypot(dx, dz) || 1;
  spawnItem(type, [d[0] + dx / n * 0.6, 2.0, d[2] + dz / n * 0.6], { vel: [dx / n * 2.5, 2.5, dz / n * 2.5], spin: { x: 4, y: 2, z: 1 } });
}

function throwHeld(s, dir) {
  const now = Date.now(), e = s.entity, type = e.player.held;
  if (!type || now - (s.lastThrow || 0) < 350 || combat.isDown(e)) return;
  s.lastThrow = now;
  const T = ITEM_TYPES[type];
  // First person: throw along the look direction, from eye height.
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len, dy = Math.max(-0.6, Math.min(0.9, dir.y / len)), dz = dir.z / len;
  throwFrom(e, { x: dx * T.speed, y: dy * T.speed + 3, z: dz * T.speed }, type);
  setHeld(e, null);
}
// Any vagrant or NPC can throw: a held item from a player, a bottle from an NPC (GAME-85).
function throwFrom(e, v, type = 'bottle') {
  const t = e.body.translation(), sp = Math.hypot(v.x, v.y, v.z) || 1;
  const it = spawnItem(type, [t.x + v.x / sp * 0.6, t.y + 0.55 + v.y / sp * 0.6, t.z + v.z / sp * 0.6], {
    vel: [v.x, v.y, v.z], spin: type === 'can' ? { x: 14, y: 2, z: 4 } : { x: 8, y: 0, z: 3 } });
  it.live = { thrower: e.player || null, by: e, until: Date.now() + 6000 };
  it.collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  broadcast({ t: 'fx', kind: 'throw', id: e.id });
  return it;
}
function endLive(it) { it.live = null; it.collider.setActiveEvents(RAPIER.ActiveEvents.NONE); }

function onItemHit(it, other) {
  const live = it.live;
  if (!live) return;
  if (other && other === live.by) return;
  if (other && other.kind === 'item') return;                      // junk clacking into junk is free
  const T = ITEM_TYPES[it.type], p = live.thrower, now = Date.now();
  const at = posOf(it), vel = it.body.linvel(), v = [vel.x, vel.y, vel.z], speed = Math.hypot(vel.x, vel.y, vel.z);
  endLive(it);
  const hard = speed > 4;
  if (other && (other.kind === 'vagrant' || other.kind === 'npc')) {
    if (hard) combat.itemHit(live.by, other, vel, T.mass);           // GAME-85: people react, NPCs fight back
  } else if (other && other.type === 'window' && hard && !T.breaks) {
    addDamage(p, ITEM_RULES.pelt, posOf(other), `Bonked a window with a ${T.name}`);
  } else if (other && other.type === 'window' && hard) {
    // Shatter from the hit point; a broken pane takes two more hits before it's empty,
    // then gets boarded up, then reglazed (GAME-84).
    const a = ACTIONS.window, st = other.state, uv = paneUV(other, at);
    if (now >= (st.brokenUntil || 0)) {
      st.brokenUntil = now + a.repairSec * 1000;
      st.boardAt = now + (a.boardSec || a.repairSec * .3) * 1000;
      st.glass = { s: Math.floor(Math.random() * 2 ** 31), h: [uv] };
      save.windows[other.id] = st;
      addDamage(p, other.value || a.cost, posOf(other), a.verb);
      broadcast({ t: 'fx', kind: 'break', id: other.id, at, v, g: st.glass });
    } else if (now >= st.boardAt) addDamage(p, 5, at, 'Bottled the plywood');
    else {
      if (st.glass && st.glass.h.length < 3) { st.glass.h.push(uv); broadcast({ t: 'fx', kind: 'break', id: other.id, at, v, g: st.glass }); }
      addDamage(p, 15, at, 'More glass');
    }
  } else if (other && other.type === 'car' && hard) {
    if (!T.breaks) addDamage(p, ITEM_RULES.pelt, posOf(other), `Pelted a car with a ${T.name}`);
    else carDamage(other, at, v, 0.14 + Math.min(0.22, T.mass * 0.25), p, it.type);   // dents or cracked glass (GAME-83)
  } else if (other && other.type === 'crate' && hard && T.mass >= 0.4) {
    const a = ACTIONS.crate, spec = other.spec, cp = posOf(other);
    removeEntity(other.id);
    save.objects['o:' + spec.id.slice(2)] = undefined;
    broadcast({ t: 'fx', kind: 'crate', at: cp, s: spec.s, hex: spec.hex, v });
    addDamage(p, a.cost, cp, a.verb);
    setTimeout(() => { if (!entities.has(spec.id)) spawnProp(spec, true); }, a.repairSec * 1000);
  } else if (other && other.type === 'cone' && hard) {
    if (now >= (other.state.hitUntil || 0)) { other.state.hitUntil = now + ACTIONS.cone.repairSec * 1000; addDamage(p, ACTIONS.cone.cost, posOf(other), ACTIONS.cone.verb); }
  } else if (T.shatters && hard) addDamage(p, 3, at, 'Broken bottle');
  if (T.shatters && hard) {
    broadcast({ t: 'fx', kind: 'smash', at, v });
    setTimeout(() => removeEntity(it.id), 30);
  } else if (hard) broadcast({ t: 'fx', kind: 'thud', at, item: it.type, v });
}

// ---------- fire hydrants (GAME-94) ----------
// Find a wrench, crank a hydrant open and it gushes for a while: the jet shoves loose junk,
// crates, sleepers and vagrants along it, puts out any fire it hits, and every second of
// wasted water goes on the town's bill. Same water for everyone: the state rides in meta.
const HYD = { len: 6.5, radius: 0.9, playerPush: 5.2, ...(ACTIONS.hydrant || {}) };
const hydrantOpen = (st, now) => (st.openAt || 0) <= now && (st.openUntil || 0) > now;
const jetOf = h => ({ ox: h.fixedPos[0] + Math.sin(h.dir || 0) * 0.26, oz: h.fixedPos[2] + Math.cos(h.dir || 0) * 0.26, dx: Math.sin(h.dir || 0), dz: Math.cos(h.dir || 0) });
const hydrants = [...entities.values()].filter(e => e.type === 'hydrant');
// Where a point sits in a jet: k = 1 at the nozzle fading to 0 at the far end, or null if outside.
function inJet(j, x, z, pad = 0) {
  const rx = x - j.ox, rz = z - j.oz, along = rx * j.dx + rz * j.dz;
  if (along < -0.2 || along > HYD.len + pad) return null;
  const lat = Math.abs(rx * j.dz - rz * j.dx);
  if (lat > HYD.radius + pad + along * 0.08) return null;
  return Math.max(0, 1 - Math.max(0, along) / HYD.len);
}
function waterPush(x, z) {
  const now = Date.now(), out = { x: 0, z: 0 };
  for (const h of hydrants) {
    if (!hydrantOpen(h.state, now)) continue;
    const j = jetOf(h), k = inJet(j, x, z);
    if (k !== null) { const v = HYD.playerPush * (0.35 + 0.65 * k); out.x += j.dx * v; out.z += j.dz * v; }
  }
  return out;
}
function hydrantAct(s, h, now) {
  const e = s.entity, p = e.player, st = h.state;
  const say = text => broadcast({ t: 'fx', kind: 'say', id: e.id, text });
  if (p.held !== 'wrench') return say(hydrantOpen(st, now) ? "It's gushing. You'd need a wrench to shut it" : "The valve nut won't budge. Need a wrench");
  if ((st.openAt || 0) > now) return;                                   // someone is already cranking it
  if (hydrantOpen(st, now)) {                                           // crank it shut again
    broadcast({ t: 'fx', kind: 'wrench', id: e.id, hyd: h.id }); playAnim(e, 'wrench');
    setTimeout(() => { st.openUntil = Date.now(); st.wetUntil = Date.now() + 40000; }, 900);
    return;
  }
  if ((st.cappedUntil || 0) > now) return say('The water dept. just capped this one. Give it a minute');
  broadcast({ t: 'fx', kind: 'wrench', id: e.id, hyd: h.id }); playAnim(e, 'wrench');
  // The water comes when the crank animation finishes.
  st.openAt = now + 900; st.openUntil = st.openAt + HYD.gushSec * 1000; st.by = p.id; st.flowAcc = 0;
  st.cappedUntil = st.openUntil + HYD.repairSec * 1000;
  setTimeout(() => { if (st.by === p.id) addDamage(p, HYD.cost, h.fixedPos, HYD.verb); }, 900);
}
function stepHydrants(now) {
  for (const h of hydrants) {
    const st = h.state;
    if (!hydrantOpen(st, now)) continue;
    st.wetUntil = st.openUntil + 40000;                                 // the puddle outlives the gush
    const j = jetOf(h);
    // The bill: wasted water, billed to whoever opened it.
    st.flowAcc = (st.flowAcc || 0) + dt;
    if (st.flowAcc >= 2) { st.flowAcc -= 2; const p = save.players[st.by]; if (p) addDamage(p, HYD.flowCost * 2, [j.ox + j.dx * 2, 0.5, j.oz + j.dz * 2], 'Water everywhere'); }
    for (const o of entities.values()) {
      // Loose things get shoved down the jet and lifted a little; heavy things barely slide.
      if (o.body && o.body.isDynamic()) {
        const t = o.body.translation(), gy = groundY(t.x, t.z); if (t.y - gy > 2.2) continue;
        const k = inJet(j, t.x, t.z); if (k === null) continue;
        const m = o.body.mass(), accel = Math.min(28, 160 / Math.max(m, 0.5)) * (0.3 + 0.7 * k);
        o.body.applyImpulse({ x: j.dx * accel * m * dt, y: (t.y - gy < 0.6 ? 6 : 0) * Math.min(m, 3) * k * dt, z: j.dz * accel * m * dt }, true);
      }
      // Fire goes out where the water lands.
      if ((o.state?.fireUntil || 0) > now) {
        const [x, , z] = posOf(o); if (inJet(j, x, z, 0.8) === null) continue;
        o.state.fireUntil = now; o.state.busyUntil = Math.max(o.state.busyUntil || 0, now + 5000);
        broadcast({ t: 'fx', kind: 'douse', id: o.id, at: posOf(o) });
        const p = save.players[st.by]; if (p) broadcast({ t: 'fx', kind: 'say', id: 'p:' + p.id, text: 'Fire out. Soggy ash everywhere' });
      }
    }
  }
}

// Grabbing joins your hands to the object with a ball joint the server owns.
function grab(s) {
  const e = s.entity;
  if (e.grabbing) return releaseGrab(e);
  if (combat.isDown(e)) return;
  const target = nearest(e, 2.6, o => (o.kind === 'prop' || o.kind === 'sleeper') && o.body);
  if (!target) return;
  const a = e.body.translation(), b = target.body.translation();
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
  const reach = target.cat && target.cat.half ? Math.min(1.6, 0.8 + Math.max(target.cat.half[0], target.cat.half[2]) * 0.5) : 1.1;
  // Carts sit at hand height; everything else is held low, at the waist, so it doesn't block your view.
  const anchorOnPlayer = { x: dx / d * reach, y: target.cat && target.cat.handle ? 0.2 : -0.3, z: dz / d * reach };
  // Carts are pushed by the handle; everything else is held by its middle.
  const h = target.cat && target.cat.handle;
  const anchorOnTarget = h ? { x: h[0], y: h[1], z: h[2] } : { x: 0, y: 0, z: 0 };
  const data = RAPIER.JointData.spherical(anchorOnPlayer, anchorOnTarget);
  target.body.wakeUp();
  e.joint = world.createImpulseJoint(data, e.body, target.body, true);
  e.grabbing = target.id;
  broadcast({ t: 'fx', kind: 'grab', id: e.id, target: target.id });
}
function releaseGrab(e) {
  if (e.joint) world.removeImpulseJoint(e.joint, true);
  e.joint = null;
  if (e.grabbing) broadcast({ t: 'fx', kind: 'grab', id: e.id, target: null });
  e.grabbing = null;
}

// ---------- getting hurt and knocked down (GAME-83) ----------
// Getting hurt pays you: car hits go through combat.hurt (GAME-85: HP, $2 per HP, KO at 0).
// Knocked down: the vagrant's capsule becomes a dynamic 70 kg body that tumbles under
// physics. Inputs are ignored until it settles, then it stands back up where it lies.
// Clients turn fx 'hit' into a ragdoll of the vagrant model and fx 'up' into getting up.
const DOWN_MIN_MS = 2600, DOWN_MAX_MS = 6000;
const isDown = (e) => !!(e && e.down);
function knockDown(e, { vel = [0, 0, 0], spin = [0, 0, 0], cause = 'hit', by = null } = {}) {
  if (!e || e.kind !== 'vagrant' || e.down) return false;
  releaseGrab(e);
  const s = e.player && sessions.get(e.player.id);
  if (s && s.queue && s.queue.length) { s.ackSeq = s.queue[s.queue.length - 1].seq; s.queue.length = 0; }
  e.down = { since: Date.now(), cause, by };
  e.vy = 0;
  e.collider.setMass(70);
  e.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  e.body.setLinearDamping(0.2); e.body.setAngularDamping(0.8);
  e.body.enableCcd(true);
  e.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
  e.body.setAngvel({ x: spin[0], y: spin[1], z: spin[2] }, true);
  broadcast({ t: 'fx', kind: 'hit', id: e.id, v: vel.map(n => +n.toFixed(2)), spin: spin.map(n => +n.toFixed(2)), cause, by });
  return true;
}
function getUp(e) {
  if (!e || !e.down) return;
  const t = e.body.translation();
  // Stand on whatever is under the body (ground, a car roof), never inside it.
  const hit = world.castRay(new RAPIER.Ray({ x: t.x, y: t.y + 1.2, z: t.z }, { x: 0, y: -1, z: 0 }), 6, true, undefined, undefined, e.collider, e.body);
  const gy = groundY(t.x, t.z), floor = hit ? t.y + 1.2 - hit.timeOfImpact : gy;
  const y = Math.max(floor, gy) + CAP_HALF + CAP_R + 0.02;
  e.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  e.body.setLinvel({ x: 0, y: 0, z: 0 }, false); e.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  e.body.enableCcd(false);
  e.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  e.body.setTranslation({ x: t.x, y, z: t.z }, true);
  e.body.setNextKinematicTranslation({ x: t.x, y, z: t.z });
  if (e.player) Object.assign(e.player, { x: t.x, y, z: t.z });
  e.down = null; e.vy = 0;
  broadcast({ t: 'fx', kind: 'up', id: e.id, at: [+t.x.toFixed(2), +y.toFixed(2), +t.z.toFixed(2)] });
}
// While down: drop inputs (still ack them) and get up once the body has settled.
function downedStep(s) {
  const e = s.entity, q = s.queue || [];
  if (q.length) { s.ackSeq = q[q.length - 1].seq; q.length = 0; }
  const t = e.body.translation(), v = e.body.linvel();
  Object.assign(e.player, { x: t.x, y: t.y, z: t.z });
  const age = Date.now() - e.down.since;
  if ((age > DOWN_MIN_MS && Math.hypot(v.x, v.y, v.z) < 0.6) || age > DOWN_MAX_MS || t.y < -5) getUp(e);
}

// ---------- car damage (GAME-83) ----------
// Cars keep a list of dents and a crack level per pane (0 fine, 1 cracked, 2 smashed),
// in the car's own frame: nose along +z, y from the ground. Bottles dent the body or
// crack the glass, hitting someone dents the nose (and cracks the windshield when fast),
// and landing hard on a car dents the hood or roof. Clients deform the body mesh.
// A car that's left alone for CAR_REPAIR_MS gets fixed.
const CAR_REPAIR_MS = 150000, MAX_DENTS = 16, STOMP_V = 3;
const r2 = n => Math.round(n * 100) / 100;
function carFrame(e) {
  const b = e.body || e.carBody; if (!b) return null;
  const t = b.translation(), q = b.rotation();
  return { t, yaw: 2 * Math.atan2(q.y, q.w), bodyY: e.kind === 'traffic' ? 0.7 : 0 };
}
function carLocal(f, p, isDir) {
  const dx = isDir ? p[0] : p[0] - f.t.x, dz = isDir ? p[2] : p[2] - f.t.z, c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return [dx * c - dz * s, isDir ? p[1] : p[1] - f.t.y + f.bodyY, dx * s + dz * c];
}
function carZone([x, y, z]) {
  if (y > 0.9 && y < 1.4 && z > 0.3 && z < 1.05 && Math.abs(x) < 0.85) return 'front';
  if (y > 0.95 && y < 1.4 && z < -0.75 && z > -1.55 && Math.abs(x) < 0.85) return 'back';
  if (y > 0.95 && y < 1.36 && z > -1.45 && z < 0.9 && Math.abs(x) > 0.6) return x < 0 ? 'left' : 'right';
  return null;
}
// worldAt: where it hit; dir: which way it was going; size: dent radius in metres.
function carDamage(e, worldAt, dir, size, byPlayer, cause) {
  const f = carFrame(e); if (!f) return;
  const now = Date.now();
  const d = e.state.dmg || (e.state.dmg = { dents: [], glass: {} });
  d.last = now;
  const lp = carLocal(f, worldAt), ld = carLocal(f, dir, true);
  const pane = carZone(lp);
  const A = ACTIONS.car;
  if (pane) {
    const lvl = Math.min(2, (d.glass[pane] || 0) + 1);
    if (lvl === (d.glass[pane] || 0)) { if (byPlayer) addDamage(byPlayer, 15, worldAt, 'More glass'); return; }
    d.glass[pane] = lvl;
    if (byPlayer) addDamage(byPlayer, lvl === 1 ? (pane === 'front' ? A.cost : 300) : 200, worldAt, lvl === 1 ? (pane === 'front' ? A.verb : 'Cracked a car window') : 'Smashed out a car window');
    broadcast({ t: 'fx', kind: 'cardmg', id: e.id, glass: pane, level: lvl, at: lp.map(r2), cause });
    return;
  }
  // Which way the panel faces decides which way it caves in.
  const [x, y, z] = lp;
  let n = y > 1.3 || (y > 0.8 && Math.abs(x) < 0.7 && Math.abs(z) < 2.0 && ld[1] < -0.5) ? [0, 1, 0]
    : Math.abs(z) > 1.9 && Math.abs(x) < 0.8 ? [0, 0, Math.sign(z)] : [Math.sign(x) || 1, 0, 0];
  const dent = [r2(x), r2(y), r2(z), n[0], n[1], n[2], r2(Math.min(0.5, size))];
  d.dents.push(dent); if (d.dents.length > MAX_DENTS) d.dents.shift();
  if (byPlayer) addDamage(byPlayer, cause === 'stomp' ? 40 : 60, worldAt, cause === 'stomp' ? 'Stomped on a car' : 'Dented a car');
  broadcast({ t: 'fx', kind: 'cardmg', id: e.id, dent, cause });
}
// A player landed hard: if it's on a car, dent where their feet hit.
function stompCar(e, t, mv, vy) {
  const now = Date.now();
  if (now - (e.lastStomp || 0) < 250) return;
  const at = { x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z };
  const hit = world.castRay(new RAPIER.Ray(at, { x: 0, y: -1, z: 0 }), CAP_HALF + CAP_R + 0.3, true, undefined, undefined, e.collider, e.body);
  if (!hit) return;
  const car = byCollider.get(hit.collider.handle);
  if (!car || car.type !== 'car') return;
  e.lastStomp = now;
  const foot = [at.x, at.y - hit.timeOfImpact, at.z];
  carDamage(car, foot, [0, vy, 0], Math.min(0.42, 0.18 + (-vy - STOMP_V) * 0.04), e.player, 'stomp');
}
function repairCars(now) {
  for (const e of entities.values()) {
    const d = e.type === 'car' && e.state && e.state.dmg;
    if (d && now - d.last > CAR_REPAIR_MS) { e.state.dmg = null; e.state.brokenUntil = 0; broadcast({ t: 'fx', kind: 'carfix', id: e.id }); }
  }
}

// ---------- simulation ----------
const dt = 1 / PHYSICS_HZ;
world.timestep = dt;

// ---------- traffic ----------
// AI cars are kinematic bodies that follow routes (polylines on road centrelines, driven in
// the right-hand lane). They obey lights and stop signs, stop for anyone in the street ahead,
// and honk if you keep standing there. Old maps with one-way "lanes" still work.
const TRAFFIC = MAP.traffic || { lanes: [], intersections: [], cars: 0 };
const CRUISE = 8, ACCEL = 4, BRAKE = 10, CAR_HALF_LEN = 2.25, CAR_HALF_W = 0.9;
const lightStart = Date.now();
function lightPhase(ix) {
  const c = ix.cycle, period = 2 * (c.green + c.yellow);
  const t = ((Date.now() - lightStart) / 1000) % period;
  // phase for the x axis (east-west); z axis is the mirror image
  if (t < c.green) return { x: 'green', z: 'red' };
  if (t < c.green + c.yellow) return { x: 'yellow', z: 'red' };
  if (t < 2 * c.green + c.yellow) return { x: 'red', z: 'green' };
  return { x: 'red', z: 'yellow' };
}
const ROUTES = (TRAFFIC.routes || []).map(r => ({ ...r, off: r.offset ?? TRAFFIC.laneOffset ?? 1.75 }));
for (const l of TRAFFIC.lanes || []) { // legacy one-way lane: already offset, straight
  const p = s => l.axis === 'x' ? [s, l.at] : [l.at, s];
  ROUTES.push({ id: l.id, pts: [p(l.from), p(l.to)], off: 0 });
}
for (const r of ROUTES) {
  r.y = r.y || 0;
  const dirs = [];
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az);
    dirs.push({ dx: (bx - ax) / L, dz: (bz - az) / L });
  }
  // right of heading (dx,dz) is (-dz,dx); corners sit where the offset lines meet
  const offPt = (i) => {
    const [x, z] = r.pts[i]; let ox = 0, oz = 0;
    for (const d of [dirs[i - 1], dirs[i]]) if (d) { ox += -d.dz * r.off; oz += d.dx * r.off; }
    const a = dirs[i - 1], b = dirs[i];
    if (a && b && Math.abs(a.dx * b.dx + a.dz * b.dz) > 0.99) { ox /= 2; oz /= 2; } // straight-through point
    return [x + ox, z + oz];
  };
  r.segs = dirs.map((d, i) => {
    const a = offPt(i), b = offPt(i + 1), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const seg = { a, d, len, axis: Math.abs(d.dx) > Math.abs(d.dz) ? 'x' : 'z', yaw: Math.atan2(d.dx, d.dz), cross: [] };
    if (!r.noStop) for (const ix of TRAFFIC.intersections) {
      const rx = ix.x - a[0], rz = ix.z - a[1];
      const along = rx * d.dx + rz * d.dz, side = rx * -d.dz + rz * d.dx;
      const half = seg.axis === 'x' ? ix.hx : ix.hz, sideHalf = seg.axis === 'x' ? ix.hz : ix.hx;
      if (Math.abs(side) > sideHalf + 1 || along < half * 0.6 || along > len + half + 1) continue; // we start inside it, or never reach it
      seg.cross.push({ ix, stopAt: along - (half + CAR_HALF_LEN + 0.6), exitAt: along + half + CAR_HALF_LEN });
    }
    return seg;
  });
  r.total = r.segs.reduce((n, g) => n + g.len, 0);
}
const cars = [];
const CAR_COLORS = ['#FF8A7A', '#26D3A0', '#3FB8FF', '#FFC93C', '#8F6BFF', '#FF6E9E'];
function carPos(car) {
  const g = car.route.segs[car.seg];
  return { x: g.a[0] + g.d.dx * car.s, z: g.a[1] + g.d.dz * car.s };
}
function carYaw(car) {
  const g = car.route.segs[car.seg];
  if (car.seg === 0 || car.s > 4) return g.yaw;
  let prev = car.route.segs[car.seg - 1].yaw, dy = g.yaw - prev;
  while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
  return prev + dy * (0.5 + 0.5 * car.s / 4);
}
const yawQuat = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
// Ground under a car: the Skyway deck for routes with a height, else the hills (GAME-96).
const carBase = (car, p) => car.route.y > 0 ? car.route.y : groundY(p.x, p.z);
// Yaw plus nose-up pitch from the slope along the heading, so cars climb the hills nose first.
function carQuat(car, p, yaw) {
  if (car.route.y > 0) return yawQuat(yaw);
  const fx = Math.sin(yaw), fz = Math.cos(yaw), L = 1.9;
  const pitch = Math.atan2(groundY(p.x + fx * L, p.z + fz * L) - groundY(p.x - fx * L, p.z - fz * L), 2 * L);
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2), sx = Math.sin(-pitch / 2), cx = Math.cos(-pitch / 2);
  return { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
}
function placeAt(car, dist) {
  car.seg = 0; car.s = dist;
  while (car.seg < car.route.segs.length - 1 && car.s > car.route.segs[car.seg].len) { car.s -= car.route.segs[car.seg].len; car.seg++; }
}
function spawnCars() {
  if (!ROUTES.length) return;
  const n = TRAFFIC.cars || 0;
  for (let i = 0; i < n; i++) {
    const route = ROUTES[i % ROUTES.length], k = Math.floor(i / ROUTES.length);
    const car = { id: 'c:' + i, route, seg: 0, s: 0, v: CRUISE * 0.5, stopState: {}, lastHonk: 0, blockedSince: 0 };
    placeAt(car, route.total * ((0.12 + 0.41 * k + 0.13 * (i % 3)) % 0.95));
    const p = carPos(car);
    car.rot = carQuat(car, p, carYaw(car));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, carBase(car, p) + 0.7, p.z).setRotation(car.rot));
    const [collider, ...extraColliders] = carColliders(body, 0.7);
    car.entity = addEntity({ id: car.id, kind: 'traffic', type: 'car', body, collider, extraColliders, state: {}, color: CAR_COLORS[i % CAR_COLORS.length] });
    cars.push(car);
  }
}
// Distance along our heading to the first thing in our path (vagrants, sleepers, cars).
// ignorePeople: a raging driver (GAME-83); skipSleepers: shoving a sleeper out of the road.
function obstacleAhead(car, look, ignorePeople = false, skipSleepers = false) {
  const g = car.route.segs[car.seg], p = carPos(car), y = carBase(car, p) + 0.7;
  let best = Infinity, vagrant = null;
  for (const e of entities.values()) {
    if (e === car.entity || !e.body) continue;
    if (!['vagrant', 'sleeper', 'traffic'].includes(e.kind)) continue; // cones and crates just get knocked aside
    if (ignorePeople && e.kind !== 'traffic') continue;
    if (skipSleepers && e.kind === 'sleeper') continue;
    const t = e.body.translation();
    if (Math.abs(t.y - y) > 2.5 && (e.kind === 'traffic' || car.route.y > 2 || t.y > y + 2.7)) continue; // the Skyway and the street below ignore each other; people up on a roof are not in the road
    const rx = t.x - p.x, rz = t.z - p.z;
    const along = rx * g.d.dx + rz * g.d.dz, side = rx * -g.d.dz + rz * g.d.dx;
    // Someone standing on this car: it won't drive off with them, it sits and honks.
    if (e.kind === 'vagrant' && t.y > y - 0.7 + CAR_HOOD_TOP + 0.5 && Math.abs(along) < CAR_HALF_LEN + 0.3 && Math.abs(side) < CAR_HALF_W + 0.3) { best = Math.min(best, 0); vagrant = e; continue; }
    const r = e.kind === 'traffic' ? CAR_HALF_LEN : 0.6;
    if (along <= 0 || along > look + CAR_HALF_LEN + r || Math.abs(side) > CAR_HALF_W + 0.7) continue;
    const gap = along - CAR_HALF_LEN - r;
    if (gap < best) { best = gap; vagrant = (e.kind === 'vagrant' || e.kind === 'sleeper') ? e : null; }
  }
  return { gap: best, vagrant };
}
// Car hits (GAME-83). A car that is still going faster than HIT_SPEED when it reaches
// someone knocks them flying. Cars brake hard for people, so this only happens when you
// step out too close to stop (drivers take REACT_MS to react to someone new), or when a driver gets fed up (RAGE_MS of being blocked:
// it backs up and floors it).
const HIT_SPEED = 2.5, RAGE_MS = 8000, EBRAKE = BRAKE * 1.5, REACT_MS = 350;
function carHits(car, now) {
  if (Math.abs(car.v) < HIT_SPEED) return false;
  const g = car.route.segs[car.seg], sgn = Math.sign(car.v), p = carPos(car), cy = carBase(car, p);
  const f = { x: g.d.dx * sgn, z: g.d.dz * sgn };
  let any = false;
  for (const s of sessions.values()) {
    const e = s.entity;
    if (e.down) continue;
    const t = e.body.translation();
    if (Math.abs(t.y - (cy + 0.7)) > 2.5) continue;             // Skyway vs street
    const rx = t.x - p.x, rz = t.z - p.z;
    const along = rx * g.d.dx + rz * g.d.dz, side = rx * -g.d.dz + rz * g.d.dx;
    if (Math.abs(along) > CAR_HALF_LEN + CAP_R + 0.05 || Math.abs(side) > CAR_HALF_W + CAP_R + 0.05) continue;
    if (t.y > cy + CAR_HOOD_TOP + CAP_HALF + CAP_R - 0.15) continue;   // standing on the hood, not in front of it
    const speed = Math.abs(car.v), ss = Math.sign(side) || 1;
    const perp = { x: -g.d.dz * ss, z: g.d.dx * ss };
    const out = 1 + speed * 0.15;
    const vel = [f.x * speed * 1.15 + perp.x * out, 2 + speed * 0.45, f.z * speed * 1.15 + perp.z * out];
    const roll = speed * 1.3;                                      // tumble head over heels away from the car
    const spin = [f.z * roll + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, -f.x * roll + (Math.random() - 0.5) * 2];
    if (knockDown(e, { vel, spin, cause: 'car', by: car.id })) {
      combat.hurt(e, Math.min(100, Math.round(25 + speed * 9)), { by: car.entity, cause: 'car' });   // no push: the ragdoll already flies
      car.lastHit = now; any = true;
      // dent the nose where it met them
      const nose = { x: carPos(car).x + f.x * CAR_HALF_LEN, y: 0.75, z: carPos(car).z + f.z * CAR_HALF_LEN };
      if (l.axis === 'x') nose.z = t.z; else nose.x = t.x;
      carDamage(car.entity, [nose.x, nose.y, nose.z], [f.x * speed, 0, f.z * speed], 0.2 + speed * 0.03, null, 'hit');
      if (speed > 5) {   // they rolled up onto the windshield
        const ws = { x: carPos(car).x + f.x * 0.65, y: 1.15, z: carPos(car).z + f.z * 0.65 };
        if (l.axis === 'x') ws.z = t.z; else ws.x = t.x;
        carDamage(car.entity, [ws.x, ws.y, ws.z], [f.x, -1, f.z], 0.3, null, 'hit');
      }
      console.log(`[town] ${car.id} hit ${e.player.name} at ${speed.toFixed(1)} m/s`);
    }
  }
  return any;
}
function stepTraffic(now) {
  for (const car of cars) {
    const g = car.route.segs[car.seg];
    let limit = Infinity; // distance we may still travel
    // intersections on this leg
    for (const c of g.cross) {
      const toLine = c.stopAt - car.s;
      if (toLine < -0.3) continue; // past the line: keep going
      if (c.ix.control === 'light') {
        const ph = lightPhase(c.ix)[g.axis];
        if (ph === 'red' || (ph === 'yellow' && toLine > 6)) limit = Math.min(limit, toLine);
      } else if (c.ix.control === 'stop') {
        const key = car.seg + ':' + c.ix.id;
        const st = car.stopState[key] || (car.stopState[key] = { stoppedAt: 0, go: false });
        if (!st.go) {
          if (toLine < 0.4 && car.v < 0.2) {
            st.stoppedAt ||= now;
            const clear = !cars.some(o => o !== car && insideIx(o, c.ix));
            if (now - st.stoppedAt > 1200 && clear) st.go = true;
          }
          if (!st.go) limit = Math.min(limit, toLine);
        }
      }
    }
    // people and cars in the street
    const rage = car.rage;
    const look = 4 + car.v * car.v / (2 * BRAKE) + 2;
    // Someone asleep in the road: honk, wait, then creep forward and shove them aside
    // (otherwise one sleeper jams the whole intersection behind it for good).
    const shoving = !rage && car.blockedBySleeper && now - car.blockedSince > 8000;
    const ob = obstacleAhead(car, look, rage && rage.phase === 'go', shoving);
    car.blockedBySleeper = !!(ob.vagrant && ob.vagrant.kind === 'sleeper') || (shoving && !!obstacleAhead(car, 3).vagrant);
    if (ob.vagrant) car.sawPersonAt ||= now; else car.sawPersonAt = 0;
    const reacting = ob.vagrant && now - car.sawPersonAt < REACT_MS;  // driver hasn't hit the brakes yet
    if (ob.gap < Infinity && !reacting) limit = Math.min(limit, ob.gap - 1.2);
    if (!rage && ob.vagrant && car.v < 0.5 && ob.gap < 6) {
      car.blockedSince ||= now;
      if (now - car.blockedSince > 900 && now - car.lastHonk > 2200) {
        car.lastHonk = now;
        const long = now - car.blockedSince > 5000, p = carPos(car);
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long, at: [p.x, carBase(car, p) + 1, p.z], target: ob.vagrant.id });
      }
      // Fed up: back up a few metres, then floor it.
      const tgt = ob.vagrant;
      if (now - car.blockedSince > RAGE_MS && tgt.kind === 'vagrant' && !tgt.down && ob.gap > -0.5 && tgt.body.translation().y < carBase(car, carPos(car)) + CAR_HOOD_TOP + 0.5) {
        const p = carPos(car);
        car.rage = { phase: 'back', until: now + 1000 };
        car.blockedSince = 0; car.lastHonk = now;
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long: true, rage: true, at: [p.x, carBase(car, p) + 1, p.z], target: tgt.id });
      }
    } else if (!rage && !shoving) car.blockedSince = 0;
    // hits happen at the speed the car arrives with
    const hit = carHits(car, now);
    // speed (slow for corners)
    const last = car.seg === car.route.segs.length - 1;
    const want = Math.min(shoving ? 1.5 : CRUISE, Math.sqrt(2 * BRAKE * Math.max(0, limit)), last ? CRUISE : 4 + 0.5 * Math.max(0, g.len - car.s));
    if (rage && rage.phase === 'back') {
      car.v = Math.max(-2.2, car.v - ACCEL * 2 * dt);
      if (now > rage.until) rage.phase = 'go', rage.until = now + 3500;
    } else if (rage) {
      car.v = Math.min(CRUISE, car.v + 9 * dt);
      if (limit <= 0) car.v = 0;                                     // still won't drive through a car or a red light
      if (hit || now > rage.until) car.rage = null;
    } else {
      if (car.v < want) car.v = Math.min(want, car.v + ACCEL * dt);
      else car.v = Math.max(want, car.v - EBRAKE * dt);
      // Stop dead for lights and cars; for a person, brake as hard as we can and maybe
      // not make it. Right after a hit the car skids on instead of stopping instantly.
      const personBound = ob.vagrant && ob.gap - 1.2 <= limit + 1e-6;
      const skidding = hit || now - (car.lastHit || 0) < 1200;
      if (limit <= 0 && (!personBound || (!skidding && (car.v < HIT_SPEED || ob.gap <= 0.05)))) car.v = 0;
    }
    car.s = Math.max(0, car.s + car.v * dt);                         // backing up never leaves this leg
    if (car.s > g.len) {
      if (!last) { car.s -= g.len; car.seg++; }
      else { // back to the route start (out in the haze), if it is clear
        const r = car.route;
        const clear = !cars.some(o => o !== car && o.route === r && o.seg === 0 && o.s < 8);
        if (clear) { car.seg = 0; car.s = 0; car.stopState = {}; car.rage = null; } else car.s = g.len;
      }
    }
    const p = carPos(car);
    car.entity.body.setNextKinematicTranslation({ x: p.x, y: carBase(car, p) + 0.7, z: p.z });
    car.entity.body.setNextKinematicRotation(carQuat(car, p, carYaw(car)));
    car.entity.state.braking = car.v < want - 0.05 || car.v < 0.1;
  }
}
function insideIx(car, ix) {
  if (car.route.y > 2) return false;
  const p = carPos(car);
  return Math.abs(p.x - ix.x) < ix.hx + CAR_HALF_LEN && Math.abs(p.z - ix.z) < ix.hz + CAR_HALF_LEN;
}
function lightsPayload() {
  const out = {};
  for (const ix of TRAFFIC.intersections) if (ix.control === 'light') out[ix.id] = lightPhase(ix);
  return out;
}

spawnCars();
combat.spawnNpcs();

const notAVagrant = (c) => { const o = byCollider.get(c.handle); return !o || o.kind !== 'vagrant'; };
function stepPlayers() {
  for (const s of sessions.values()) {
    if (s.entity.down) { downedStep(s); continue; }
    // Inputs are played back for exactly the time the client simulated them, so the
    // server lands where the client's prediction did. No input queued: stand still.
    const q = s.queue || (s.queue = []);
    if (!q.length) continue;
    let queued = 0; for (const i of q) queued += i.rem;
    while (queued > 0.5 && q.length > 1) queued -= q.shift().rem;   // way behind: drop old inputs
    const step = queued > 0.15 ? dt * 2 : dt;                       // a little behind: catch up
    const inp = q[0];
    let need = step - inp.rem; inp.rem -= step;
    if (inp.rem <= 1e-6) {
      q.shift(); s.ackSeq = inp.seq;
      if (q.length && need > 0) q[0].rem -= need;                   // carry the overrun into the next input
    }
    s.input = inp;
    const e = s.entity;
    const t = e.body.translation();
    let mx = inp.x || 0, mz = inp.z || 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    let speed = inp.run ? RUN : WALK;
    if (e.grabbing) {
      const g = entities.get(e.grabbing);
      if (g) speed *= g.cat ? g.cat.drag : g.kind === 'sleeper' ? 60 / 70 : 1; // heavy things slow you down
    }
    e.vy += GRAVITY * step;
    const mm = combat.moveMod(e, step);              // knocked out / staggered / knocked back (GAME-85)
    const push = waterPush(t.x, t.z);                // standing in a hydrant's jet shoves you along it (GAME-94)
    const desired = { x: (mx * speed * mm.scale + push.x) * step + mm.kx, y: e.vy * step, z: (mz * speed * mm.scale + push.z) * step + mm.kz };
    // Cars (kinematic) are solid so you can stand on them; other players are not (GAME-83).
    controller.computeColliderMovement(e.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, notAVagrant);
    const mv = controller.computedMovement();
    const grounded = controller.computedGrounded();
    if (grounded && e.vy < -STOMP_V) stompCar(e, t, mv, e.vy);   // landed hard on something: a car? (GAME-83)
    if (grounded) { e.vy = inp.jump && !mm.down ? JUMP : 0; }
    if (typeof inp.yaw === 'number') e.facing = inp.yaw;
    else if (ml > 0.01) e.facing = Math.atan2(mx, mz);
    e.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    const p = e.player;
    p.x = t.x + mv.x; p.y = t.y + mv.y; p.z = t.z + mv.z;
  }
}

let tick = 0;
function physicsTick() {
  stepPlayers();
  stepTraffic(Date.now());
  copper.tick(Date.now());
  combat.stepNpcs(dt);
  world.step(events);
  events.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const a = byCollider.get(h1), b = byCollider.get(h2);
    if (a && a.kind === 'item') onItemHit(a, b);
    else if (b && b.kind === 'item') onItemHit(b, a);
  });
  const now = Date.now();
  for (const e of entities.values()) if (e.live && now > e.live.until) endLive(e);
  if (tick % 30 === 0) stepItems(now);
  stepHydrants(now);
  tick++;
  if (tick % PHYSICS_HZ === 0) { rescueLostProps(); repairCars(now); }
  if (tick % (PHYSICS_HZ / SNAPSHOT_HZ) === 0) sendSnapshot(false);
  if (tick % (PHYSICS_HZ / META_HZ) === 0) sendMeta();
}

// Only bodies that are moving go on the wire; resting bodies cost nothing.
function snapshotRows(all) {
  const rows = [];
  for (const e of entities.values()) {
    if (!e.body) continue;
    if (!all && e.body.isSleeping()) continue;
    if (e.kind === 'prop' && !e.body.isSleeping()) e.moved = true;
    const t = e.body.translation(), q = e.body.rotation();
    const r = [e.id, +t.x.toFixed(2), +t.y.toFixed(2), +t.z.toFixed(2), +q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)];
    if (e.kind === 'vagrant' || e.kind === 'npc') r.push(+(e.facing || 0).toFixed(2));
    rows.push(r);
  }
  return rows;
}
function sendSnapshot(all, ws) {
  const msg = JSON.stringify({ t: 's', ts: Date.now(), b: snapshotRows(all) });
  if (ws) return ws.send(msg);
  for (const s of sessions.values()) {
    if (s.ws.readyState !== 1) continue;
    s.ws.send(msg);
    // Tell each player where the server has them after their latest input, so the
    // client can correct its own prediction gently instead of snapping.
    const p = s.entity.player;
    s.ws.send(JSON.stringify({ t: 'a', seq: s.ackSeq || 0, p: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)] }));
  }
}
function metaPayload() {
  const now = Date.now();
  const objects = {};
  for (const e of entities.values()) {
    const st = e.state || {};
    const o = {};
    if ((st.fireUntil || 0) > now) o.fire = 1;
    else if ((st.burntUntil || 0) > now) o.burnt = 1;
    if ((st.brokenUntil || 0) > now) {
      o.broken = 1;
      if (st.glass) { o.g = st.glass; if (now >= st.boardAt) o.board = 1; }
    } else if (st.glass) { delete st.glass; delete save.windows[e.id]; }
    if (st.braking) o.brake = 1;
    copper.meta(e, o);
    if (st.angry) o.angry = 1;
    if (st.down) o.down = 1;
    if (e.down) o.rag = 1;                            // ragdolled by a car (GAME-83)
    if (e.type === 'hydrant') { if (hydrantOpen(st, now)) o.water = 1; if ((st.wetUntil || 0) > now) o.wet = 1; }
    if (Object.keys(o).length) objects[e.id] = o;
  }
  const owners = {};
  for (const [z, pid] of Object.entries(save.owners)) {
    const p = save.players[pid];
    if (p) owners[z] = { name: p.name, color: p.color };
  }
  const players = Object.values(save.players).map(p => ({ id: p.id, name: p.name, color: p.color, damage: Math.round(p.damage || 0), cash: p.cash || 0, asleep: !sessions.has(p.id), ...copper.playerMeta(p) }))
    .sort((a, b) => b.damage - a.damage).slice(0, 12);
  return { t: 'm', lights: lightsPayload(), town: Math.round(save.town.damage), owners, objects, players, online: sessions.size };
}
function sendMeta() { broadcast(metaPayload()); }

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const sess of sessions.values()) if (sess.ws.readyState === 1) sess.ws.send(s);
}

// Save loose objects and sleepers that have come to rest.
function persistWorld() {
  for (const e of entities.values()) {
    if (!e.body) continue;
    const t = e.body.translation(), q = e.body.rotation();
    if (e.kind === 'prop' && (e.moved || !save.objects[e.id])) { save.objects[e.id] = { p: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w] }; e.moved = !e.body.isSleeping(); }
    if (e.kind === 'sleeper') Object.assign(e.player, { x: t.x, y: t.y, z: t.z, q: [q.x, q.y, q.z, q.w] });
  }
  writeSave();
}

setInterval(physicsTick, 1000 / PHYSICS_HZ);
setInterval(decayHeatAndOwners, 5000);
setInterval(persistWorld, 5000);

// ---------- network ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  // Libraries come from node_modules so the game never depends on a CDN.
  if (url.pathname === '/vendor/cannon-es.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'public, max-age=86400' });
    return fs.createReadStream(path.join(__dirname, 'node_modules', 'cannon-es', 'dist', 'cannon-es.js')).pipe(res);
  }
  if (url.pathname.startsWith('/vendor/three/')) {
    const root = path.join(__dirname, 'node_modules', 'three');
    const f = path.join(root, path.normalize(url.pathname.slice('/vendor/three/'.length)));
    if (!f.startsWith(root + path.sep) || !/^(build|examples)$/.test(path.relative(root, f).split(path.sep)[0])) { res.writeHead(403); return res.end(); }
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'public, max-age=86400' });
      res.end(buf);
    });
  }
  if (url.pathname === '/town.json') { res.writeHead(200, { 'content-type': MIME['.json'] }); return res.end(JSON.stringify(MAP)); }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

wss.on('connection', ws => {
  let pid = null;
  let msgs = 0, windowStart = Date.now();
  ws.on('message', raw => {
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; msgs = 0; }
    if (++msgs > 60) return; // per-connection rate limit
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'hello' && !pid) {
      let token = typeof m.token === 'string' ? m.token : null;
      let acct = token && save.accounts[hashToken(token)];
      if (!acct) {
        token = crypto.randomBytes(24).toString('base64url');
        const id = crypto.randomBytes(6).toString('hex');
        const name = String(m.name || 'Vagrant').replace(/[^\w \-']/g, '').slice(0, 16) || 'Vagrant';
        save.accounts[hashToken(token)] = acct = { pid: id, created: now };
        const spawnJitter = () => (Math.random() - 0.5) * 6;
        save.players[id] = { id, name, color: COLORS[Object.keys(save.players).length % COLORS.length], ...(() => { const sp = MAP.spawnPoints[Object.keys(save.players).length % MAP.spawnPoints.length]; return { x: sp[0] + spawnJitter() * 0.3, y: 1, z: sp[1] + spawnJitter() * 0.3 }; })(), damage: 0, cash: 0, asleep: false };
      }
      pid = acct.pid;
      const p = save.players[pid];
      // Same account from a second tab: the newer tab takes over.
      const old = sessions.get(pid);
      if (old) { clearTimeout(old.graceTimer); old.ws.close(4000, 'logged in elsewhere'); sessions.delete(pid); removeEntity(old.entity.id); }
      const existing = entities.get(vagrantId(pid));
      const entity = existing && existing.kind === 'vagrant' ? existing : wakeUp(p);
      sessions.set(pid, { ws, entity, input: {} });
      ws.send(JSON.stringify({ t: 'welcome', token, you: vagrantId(pid), name: p.name, entities: [...entities.values()].map(describe) }));
      sendSnapshot(true, ws);
      ws.send(JSON.stringify(metaPayload()));
      sendInv(sessions.get(pid));
      copper.sendInv(p);
      saveDirty = true;
      console.log(`[town] ${p.name} woke up (${sessions.size} online)`);
      return;
    }
    const s = pid && sessions.get(pid);
    if (!s || s.ws !== ws) return;
    if (m.t === 'in') {
      const q = s.queue || (s.queue = []);
      if (q.length < 40) q.push({ x: +m.x || 0, z: +m.z || 0, jump: !!m.jump, run: !!m.run, yaw: Number.isFinite(+m.yaw) ? +m.yaw : undefined,
        seq: m.seq >>> 0, rem: Math.min(0.1, Math.max(0, +m.dt || 1 / 30)) });
    }
    else if (s.entity.down) return;                       // knocked down: no actions until you get up
    else if (m.t === 'act') interact(s, !!m.light);
    else if (m.t === 'pickup') pickup(s, typeof m.id === 'string' ? m.id : null);
    else if (m.t === 'drop') dropHeld(s.entity);
    else if (m.t === 'throw' && m.dir) throwHeld(s, { x: +m.dir.x || 0, y: +m.dir.y || 0, z: +m.dir.z || 0 });
    else if (m.t === 'grab') grab(s);
    else if (m.t === 'tp' && process.env.DEV_TP) {        // local testing only: jump to a spot
      const e = s.entity, x = +m.x || 0, z = +m.z || 0;
      const y = groundY(x, z) + CAP_HALF + CAP_R + 0.05;
      e.body.setTranslation({ x, y, z }, true); Object.assign(e.player, { x, y, z }); s.queue = [];
    }
    else if (m.t === 'punch' && m.dir) combat.punch(s.entity, { x: +m.dir.x || 0, z: +m.dir.z || 0 });
  });
  ws.on('close', () => {
    const s = pid && sessions.get(pid);
    if (!s || s.ws !== ws) return;
    s.input = {}; s.queue = [];
    copper.cancel(s, 'left');
    releaseGrab(s.entity);
    // Wait a moment for a reconnect before the vagrant lies down.
    s.graceTimer = setTimeout(() => { if (sessions.get(pid) === s) lieDown(pid); }, GRACE_MS);
  });
});

// Deploys: everyone lies down in place and the world is saved before exit.
function shutdown() {
  console.log('[town] napping (shutdown), saving world');
  for (const pid of [...sessions.keys()]) { const s = sessions.get(pid); clearTimeout(s.graceTimer); try { s.ws.close(4001, 'town is napping'); } catch {} lieDown(pid); }
  persistWorld();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`[town] ${MAP.name} listening on :${PORT}, ${Object.keys(save.players).length} vagrants loaded`));
