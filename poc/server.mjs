// Turf War proof of concept: one persistent, server-authoritative physics town.
// Throwaway code to prove the connection model, not the real game.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import RAPIER from '@dimforge/rapier3d-compat';

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
fixed((minX + maxX) / 2, -0.5, (minZ + maxZ) / 2, (maxX - minX) / 2 + 2, 0.5, (maxZ - minZ) / 2 + 2); // ground
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

// ---------- entities ----------
const sessions = new Map(); // playerId -> { ws, entity, input, lastAct, graceTimer }
// Every synced thing is an entity with an id, a kind and (usually) a rigid body.
const entities = new Map();      // id -> entity
const byCollider = new Map();    // collider handle -> entity
let nextBottle = 1;

function addEntity(e) {
  entities.set(e.id, e);
  if (e.collider) byCollider.set(e.collider.handle, e);
  broadcast({ t: 'spawn', e: describe(e) });
  return e;
}
function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
  if (e.joint) { world.removeImpulseJoint(e.joint, true); e.joint = null; }
  for (const other of entities.values()) if (other.grabbing === id) releaseGrab(other);
  if (e.collider) byCollider.delete(e.collider.handle);
  if (e.body) world.removeRigidBody(e.body);
  entities.delete(id);
  broadcast({ t: 'despawn', id });
}
function describe(e) {
  const d = { id: e.id, kind: e.kind, type: e.type };
  if (e.player) Object.assign(d, { name: e.player.name, color: e.player.color, pid: e.player.id });
  if (e.grabbing) d.grabbing = e.grabbing;
  if (e.fixedPos) d.pos = e.fixedPos;
  if (e.color) d.color = e.color;
  if (e.index !== undefined) d.index = e.index;
  if (e.spec) { d.s = e.spec.s; d.hex = e.spec.hex; if (e.spec.color) d.color = e.spec.color; }
  if (e.cat) { d.half = e.cat.half; d.r = e.cat.r; d.hh = e.cat.hh; d.drag = e.cat.drag; d.label = e.cat.label; }
  return d;
}

// Fixtures: static things you can act on (trash piles, the dumpster, the stop sign,
// windows, parked cars). The client already draws them; the server owns their state.
const fixtureCount = {};
MAP.colliders.forEach((c, i) => {
  if (c.loose) return; // drawn and simulated as a movable prop instead (see props)
  const collider = colliderFor(c);
  if (!c.tag || c.tag === 'npc') return;
  const n = fixtureCount[c.tag] = (fixtureCount[c.tag] || 0) + 1;
  const id = c.tag === 'pile' ? 'pile:' + c.pile : `f:${c.tag}${n}`;
  addEntity({ id, kind: 'fixture', type: c.tag, collider, fixedPos: c.p, index: c.pile, state: {} });
});
for (const w of MAP.windows) {
  const collider = colliderFor({ p: w.p, q: w.q, box: w.half });
  addEntity({ id: w.id, kind: 'fixture', type: 'window', collider, fixedPos: w.p, index: w.gi, value: w.value, state: {} });
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
function spawnProp(pr, fresh) {
  const cat = propType(pr);
  const saved = !fresh && save.objects[savedKey(pr)];
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(...(saved ? saved.p : pr.p))
    .setRotation(saved ? { x: saved.q[0], y: saved.q[1], z: saved.q[2], w: saved.q[3] } : propRotation(pr))
    .setLinearDamping(cat.linDamp ?? 0.3).setAngularDamping(cat.angDamp ?? 0.5)
    .setCcdEnabled(!!cat.ccd);
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(propCollider(cat), body);
  body.sleep();
  return addEntity({ id: pr.id, kind: 'prop', type: pr.type, body, collider, mass: cat.mass, cat, spec: pr, unsettled: !saved, state: {} });
}
for (const pr of MAP.props) spawnProp(pr);
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
    e.body.setTranslation({ x: pr.p[0], y: pr.p[1], z: pr.p[2] }, true);
    e.body.setRotation(propRotation(pr), true);
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true); e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}

// ---------- players ----------
const controller = world.createCharacterController(0.05);
controller.enableAutostep(0.45, 0.25, true);
controller.enableSnapToGround(0.4);
controller.setMaxSlopeClimbAngle(50 * Math.PI / 180);

const COLORS = ['#ff5fa2', '#46c6ff', '#ffb627', '#7ae582', '#b388ff', '#ff7b54', '#00d1b2', '#ffd6e0'];

function vagrantId(pid) { return 'p:' + pid; }

function spawnAwake(p) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, Math.max(p.y, CAP_HALF + CAP_R) + 0.05, p.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF, CAP_R).setFriction(0.5), body);
  return addEntity({ id: vagrantId(p.id), kind: 'vagrant', player: p, body, collider, vy: 0, grabbing: null, state: {} });
}

// A logged-out vagrant lies down where they stood: a dynamic, draggable body.
function spawnSleeper(p) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(p.x, Math.max(p.y, 0.45), p.z)
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
  if (cost <= 0) return;
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

const HIT_ONLY = new Set(['window', 'car', 'crate', 'cone']);
function interact(s) {
  const e = s.entity, p = e.player;
  const now = Date.now();
  if (now - (s.lastAct || 0) < 600) return;
  s.lastAct = now;
  const target = nearest(e, 3, o => (o.kind === 'fixture' || o.kind === 'prop') && ACTIONS[o.type] && !HIT_ONLY.has(o.type));
  if (!target) return;
  const a = ACTIONS[target.type];
  const busyUntil = target.state.busyUntil || 0;
  if (now < busyUntil) return;
  target.state.busyUntil = now + a.repairSec * 1000;
  // A trash pile burns for 30 s then sits charred until the town cleans it up.
  if (target.type === 'pile') target.state.fireUntil = now + 30000;
  if (target.type === 'dumpster') target.state.fireUntil = now + a.repairSec * 1000;
  if (target.type === 'pile' || target.type === 'dumpster') target.state.burntUntil = now + a.repairSec * 1000;
  if (a.cash) { p.cash = (p.cash || 0) + a.cash; broadcast({ t: 'fx', kind: 'say', id: e.id, text: `Spare change? (+$${a.cash})` }); }
  if (a.hangout) broadcast({ t: 'fx', kind: 'say', id: e.id, text: target.type === 'couch' ? 'comfy' : 'warming up' });
  addDamage(p, a.cost, posOf(target), a.verb);
}

function throwBottle(s, dir) {
  const now = Date.now();
  if (now - (s.lastThrow || 0) < 450) return;
  s.lastThrow = now;
  const e = s.entity;
  // First person: throw along the look direction, from eye height.
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len, dy = Math.max(-0.6, Math.min(0.9, dir.y / len)), dz = dir.z / len;
  const t = e.body.translation();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(t.x + dx * 0.6, t.y + 0.55 + dy * 0.6, t.z + dz * 0.6)
    .setLinvel(dx * 22, dy * 22 + 3, dz * 22).setAngvel({ x: 8, y: 0, z: 3 }).setCcdEnabled(true));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.12, 0.07).setMass(0.4)
    .setRestitution(0.2).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
  addEntity({ id: 'b:' + nextBottle++, kind: 'bottle', body, collider, thrower: e.player, born: now, state: {} });
}

function onBottleHit(bottle, other) {
  if (bottle.state.smashed) return;
  if (other && other.player === bottle.thrower && other.kind === 'vagrant') return;
  bottle.state.smashed = true;
  const at = posOf(bottle);
  const p = bottle.thrower;
  const now = Date.now();
  const vel = bottle.body.linvel();
  if (other && (other.type === 'window' || other.type === 'car')) {
    const a = ACTIONS[other.type];
    if (now >= (other.state.brokenUntil || 0)) {
      other.state.brokenUntil = now + a.repairSec * 1000;
      addDamage(p, other.value || a.cost, posOf(other), a.verb);
      broadcast({ t: 'fx', kind: 'break', id: other.id, at, v: [vel.x, vel.y, vel.z] });
    } else addDamage(p, 15, at, 'More glass');
  } else if (other && other.type === 'crate') {
    const a = ACTIONS.crate, spec = other.spec, cp = posOf(other);
    removeEntity(other.id);
    save.objects['o:' + spec.id.slice(2)] = undefined;
    broadcast({ t: 'fx', kind: 'crate', at: cp, s: spec.s, hex: spec.hex, v: [vel.x, vel.y, vel.z] });
    addDamage(p, a.cost, cp, a.verb);
    setTimeout(() => { if (!entities.has(spec.id)) spawnProp(spec, true); }, a.repairSec * 1000);
  } else if (other && other.type === 'cone') {
    if (now >= (other.state.hitUntil || 0)) { other.state.hitUntil = now + ACTIONS.cone.repairSec * 1000; addDamage(p, ACTIONS.cone.cost, posOf(other), ACTIONS.cone.verb); }
  } else addDamage(p, 3, at, 'Broken bottle');
  broadcast({ t: 'fx', kind: 'smash', at, v: [vel.x, vel.y, vel.z] });
  setTimeout(() => removeEntity(bottle.id), 30);
}

// Grabbing joins your hands to the object with a ball joint the server owns.
function grab(s) {
  const e = s.entity;
  if (e.grabbing) return releaseGrab(e);
  const target = nearest(e, 2.6, o => (o.kind === 'prop' || o.kind === 'sleeper' || o.kind === 'bottle') && o.body);
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
    car.rot = yawQuat(carYaw(car));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, route.y + 0.7, p.z).setRotation(car.rot));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(CAR_HALF_W, 0.7, CAR_HALF_LEN), body);
    car.entity = addEntity({ id: car.id, kind: 'traffic', type: 'car', body, collider, state: {}, color: CAR_COLORS[i % CAR_COLORS.length] });
    cars.push(car);
  }
}
// Distance along our heading to the first thing in our path (vagrants, sleepers, cars).
function obstacleAhead(car, look, skipSleepers) {
  const g = car.route.segs[car.seg], p = carPos(car), y = car.route.y + 0.7;
  let best = Infinity, vagrant = null;
  for (const e of entities.values()) {
    if (e === car.entity || !e.body) continue;
    if (!['vagrant', 'sleeper', 'traffic'].includes(e.kind)) continue; // cones and crates just get knocked aside
    if (skipSleepers && e.kind === 'sleeper') continue;
    const t = e.body.translation();
    if (Math.abs(t.y - y) > 2.5) continue; // the Skyway and the street below ignore each other
    const rx = t.x - p.x, rz = t.z - p.z;
    const along = rx * g.d.dx + rz * g.d.dz, side = rx * -g.d.dz + rz * g.d.dx;
    const r = e.kind === 'traffic' ? CAR_HALF_LEN : 0.6;
    if (along <= 0 || along > look + CAR_HALF_LEN + r || Math.abs(side) > CAR_HALF_W + 0.7) continue;
    const gap = along - CAR_HALF_LEN - r;
    if (gap < best) { best = gap; vagrant = (e.kind === 'vagrant' || e.kind === 'sleeper') ? e : null; }
  }
  return { gap: best, vagrant };
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
    const look = 4 + car.v * car.v / (2 * BRAKE) + 2;
    // Someone asleep in the road: honk, wait, then creep forward and shove them aside
    // (otherwise one sleeper jams the whole intersection behind it for good).
    const shoving = car.blockedBySleeper && now - car.blockedSince > 8000;
    const ob = obstacleAhead(car, look, shoving);
    if (ob.gap < Infinity) limit = Math.min(limit, ob.gap - 1.2);
    car.blockedBySleeper = !!(ob.vagrant && ob.vagrant.kind === 'sleeper') || (shoving && !!obstacleAhead(car, 3).vagrant);
    if (ob.vagrant && car.v < 0.5 && ob.gap < 6) {
      car.blockedSince ||= now;
      if (now - car.blockedSince > 900 && now - car.lastHonk > 2200) {
        car.lastHonk = now;
        const long = now - car.blockedSince > 5000, p = carPos(car);
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long, at: [p.x, car.route.y + 1, p.z], target: ob.vagrant.id });
      }
    } else if (!shoving) car.blockedSince = 0;
    // speed (slow for corners)
    const last = car.seg === car.route.segs.length - 1;
    const want = Math.min(shoving ? 1.5 : CRUISE, Math.sqrt(2 * BRAKE * Math.max(0, limit)), last ? CRUISE : 4 + 0.5 * Math.max(0, g.len - car.s));
    if (car.v < want) car.v = Math.min(want, car.v + ACCEL * dt);
    else car.v = Math.max(want, car.v - BRAKE * 1.5 * dt);
    if (limit <= 0) car.v = 0;
    car.s += car.v * dt;
    if (car.s > g.len) {
      if (!last) { car.s -= g.len; car.seg++; }
      else { // back to the route start (out in the haze), if it is clear
        const r = car.route, a = r.segs[0].a;
        const clear = !cars.some(o => o !== car && o.route === r && o.seg === 0 && o.s < 8);
        if (clear) { car.seg = 0; car.s = 0; car.stopState = {}; } else car.s = g.len;
        void a;
      }
    }
    const p = carPos(car);
    car.entity.body.setNextKinematicTranslation({ x: p.x, y: car.route.y + 0.7, z: p.z });
    car.entity.body.setNextKinematicRotation(yawQuat(carYaw(car)));
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

function stepPlayers() {
  for (const s of sessions.values()) {
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
    const desired = { x: mx * speed * step, y: e.vy * step, z: mz * speed * step };
    controller.computeColliderMovement(e.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    const mv = controller.computedMovement();
    const grounded = controller.computedGrounded();
    if (grounded) { e.vy = inp.jump ? JUMP : Math.min(e.vy, 0) * 0; }
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
  world.step(events);
  events.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    const a = byCollider.get(h1), b = byCollider.get(h2);
    if (a && a.kind === 'bottle') onBottleHit(a, b);
    else if (b && b.kind === 'bottle') onBottleHit(b, a);
  });
  const now = Date.now();
  for (const e of entities.values()) {
    if (e.kind === 'bottle' && now - e.born > 6000) removeEntity(e.id);
  }
  tick++;
  if (tick % PHYSICS_HZ === 0) rescueLostProps();
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
    if (e.kind === 'vagrant') r.push(+(e.facing || 0).toFixed(2));
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
    if ((st.brokenUntil || 0) > now) o.broken = 1;
    if (st.braking) o.brake = 1;
    if (Object.keys(o).length) objects[e.id] = o;
  }
  const owners = {};
  for (const [z, pid] of Object.entries(save.owners)) {
    const p = save.players[pid];
    if (p) owners[z] = { name: p.name, color: p.color };
  }
  const players = Object.values(save.players).map(p => ({ id: p.id, name: p.name, color: p.color, damage: Math.round(p.damage || 0), cash: p.cash || 0, asleep: !sessions.has(p.id) }))
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
    else if (m.t === 'act') interact(s);
    else if (m.t === 'throw' && m.dir) throwBottle(s, { x: +m.dir.x || 0, y: +m.dir.y || 0, z: +m.dir.z || 0 });
    else if (m.t === 'grab') grab(s);
  });
  ws.on('close', () => {
    const s = pid && sessions.get(pid);
    if (!s || s.ws !== ws) return;
    s.input = {}; s.queue = [];
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
