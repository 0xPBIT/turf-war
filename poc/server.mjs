// Turf War proof of concept: one persistent, server-authoritative physics town.
// Throwaway code to prove the connection model, not the real game.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import RAPIER from '@dimforge/rapier3d-compat';
import { createCombat } from './combat.mjs';
import { initCopper } from './copper.mjs';

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
fixed(0, -0.5, 0, (maxX - minX) / 2, 0.5, (maxZ - minZ) / 2); // ground
fixed(minX - 0.5, 5, 0, 0.5, 10, 70); fixed(maxX + 0.5, 5, 0, 0.5, 10, 70);
fixed(0, 5, minZ - 0.5, 70, 10, 0.5); fixed(0, 5, maxZ + 0.5, 70, 10, 0.5);
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
let nextBottle = 1;
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
  if (e.player) Object.assign(d, { name: e.player.name, color: e.player.color, pid: e.player.id });
  if (e.grabbing) d.grabbing = e.grabbing;
  if (e.fixedPos) d.pos = e.fixedPos;
  if (e.color) d.color = e.color;
  if (e.index !== undefined) d.index = e.index;
  if (e.spec) { d.s = e.spec.s; d.hex = e.spec.hex; if (e.spec.color) d.color = e.spec.color; }
  if (e.cat) { d.half = e.cat.half; d.r = e.cat.r; d.hh = e.cat.hh; d.drag = e.cat.drag; d.label = e.cat.label; }
  if (e.kind === 'npc') Object.assign(d, combat.describeNpc(e));
  if (e.kind === 'vagrant' && combat && combat.isDown(e)) d.down = 1;
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
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.p[0], 0, c.p[2]).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }));
    [collider, ...extraColliders] = carColliders(b, 0, c.ry !== undefined ? CAR_CABIN_Z : 0);
  } else collider = colliderFor(c);
  if (!c.tag || c.tag === 'npc') return;
  const n = fixtureCount[c.tag] = (fixtureCount[c.tag] || 0) + 1;
  const id = c.tag === 'pile' ? 'pile:' + c.pile : `f:${c.tag}${n}`;
  addEntity({ id, kind: 'fixture', type: c.tag, collider, extraColliders, fixedPos: c.p, index: c.pile, state: {} });
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

combat = createCombat({ RAPIER, world, controller, entities, addEntity, broadcast: (m) => broadcast(m), addDamage: (...a) => addDamage(...a),
  MAP, NPCS: JSON.parse(fs.readFileSync(path.join(__dirname, 'npcs.json'), 'utf8')).npcs, dt: 1 / PHYSICS_HZ, WALK, RUN, GRAVITY, CAP_HALF, CAP_R,
  throwFrom: (e, v) => throwFrom(e, v), releaseGrab: (e) => releaseGrab(e) });

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
function interact(s) {
  const e = s.entity, p = e.player;
  const now = Date.now();
  if (now - (s.lastAct || 0) < 600) return;
  s.lastAct = now;
  // Skip things already burning or burnt, so a charred tree never hides the trash pile beside it.
  const target = nearest(e, 3, o => (o.kind === 'fixture' || o.kind === 'prop') && ACTIONS[o.type] && !HIT_ONLY.has(o.type) && now >= ((o.state && o.state.busyUntil) || 0));
  if (!target) return;
  if (target.type === 'lamppost') return copper.start(s, target);
  const a = ACTIONS[target.type];
  if (target.type.startsWith('shop_')) return buy(s, target);
  if (BURNABLE.has(target.type)) {
    const fuel = fuelOf(p);
    if (!fuel) return tell(s, 'You need a lighter. Dig through a dumpster or buy one at Sunny Mart.');
    p.items.lighter.fuel = fuel - 1;
    if (fuel - 1 <= 0) { p.items.lighter = null; tell(s, 'Your lighter is out of fluid.'); }
    sendInv(s);
    broadcast({ t: 'fx', kind: 'flick', id: e.id });
    return ignite(target, p, now);
  }
  target.state.busyUntil = now + a.repairSec * 1000;
  if (a.cash) { p.cash = (p.cash || 0) + a.cash; broadcast({ t: 'fx', kind: 'say', id: e.id, text: `Spare change? (+$${a.cash})` }); }
  if (a.hangout) broadcast({ t: 'fx', kind: 'say', id: e.id, text: target.type === 'couch' ? 'comfy' : 'warming up' });
  addDamage(p, a.cost, posOf(target), a.verb);
}

function throwBottle(s, dir) {
  const now = Date.now();
  if (now - (s.lastThrow || 0) < 450 || combat.isDown(s.entity)) return;
  s.lastThrow = now;
  // First person: throw along the look direction, from eye height.
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len, dy = Math.max(-0.6, Math.min(0.9, dir.y / len)), dz = dir.z / len;
  throwFrom(s.entity, { x: dx * 22, y: dy * 22 + 3, z: dz * 22 });
}
// Any vagrant or NPC can throw a bottle with a given launch velocity.
function throwFrom(e, v) {
  const t = e.body.translation(), sp = Math.hypot(v.x, v.y, v.z) || 1;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(t.x + v.x / sp * 0.6, t.y + 0.55 + v.y / sp * 0.6, t.z + v.z / sp * 0.6)
    .setLinvel(v.x, v.y, v.z).setAngvel({ x: 8, y: 0, z: 3 }).setCcdEnabled(true));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.12, 0.07).setMass(0.4)
    .setRestitution(0.2).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
  addEntity({ id: 'b:' + nextBottle++, kind: 'bottle', body, collider, thrower: e.player || null, by: e, born: Date.now(), state: {} });
}

function onBottleHit(bottle, other) {
  if (bottle.state.smashed) return;
  if (other && other === bottle.by) return;
  if (other && other.kind === 'bottle') return;
  bottle.state.smashed = true;
  const at = posOf(bottle);
  const p = bottle.thrower;
  const now = Date.now();
  const vel = bottle.body.linvel();
  if (other && (other.kind === 'vagrant' || other.kind === 'npc')) {
    combat.itemHit(bottle.by, other, vel, 0.4);       // GAME-85: people react, NPCs fight back
  } else if (other && (other.type === 'window' || other.type === 'car')) {
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
  if (combat.isDown(e)) return;
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
  const floor = hit ? t.y + 1.2 - hit.timeOfImpact : 0;
  const y = Math.max(floor, 0) + CAP_HALF + CAP_R + 0.02;
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

// ---------- simulation ----------
const dt = 1 / PHYSICS_HZ;
world.timestep = dt;

// ---------- traffic ----------
// AI cars are kinematic bodies on one-way lanes. They obey lights and stop signs,
// stop for anyone in the street ahead, and honk if you keep standing there.
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
const laneCrossings = new Map(); // lane id -> intersections it crosses, with stop line positions
for (const lane of TRAFFIC.lanes) {
  const list = [];
  for (const ix of TRAFFIC.intersections) {
    const crossCoord = lane.axis === 'x' ? ix.z : ix.x;
    const crossHalf = lane.axis === 'x' ? ix.hz : ix.hx;
    if (Math.abs(lane.at - crossCoord) > crossHalf) continue;
    const center = lane.axis === 'x' ? ix.x : ix.z;
    const half = lane.axis === 'x' ? ix.hx : ix.hz;
    list.push({ ix, stopAt: center - lane.dir * (half + CAR_HALF_LEN + 0.6), exitAt: center + lane.dir * (half + CAR_HALF_LEN) });
  }
  laneCrossings.set(lane.id, list);
}
const cars = [];
const CAR_COLORS = ['#FF8A7A', '#26D3A0', '#3FB8FF', '#FFC93C', '#8F6BFF', '#FF6E9E'];
function carPos(car) {
  const l = car.lane;
  return l.axis === 'x' ? { x: car.s, z: l.at } : { x: l.at, z: car.s };
}
function spawnCars() {
  const n = TRAFFIC.cars || 0, lanes = TRAFFIC.lanes;
  for (let i = 0; i < n; i++) {
    const lane = lanes[i % lanes.length];
    const k = Math.floor(i / lanes.length);
    const span = lane.to - lane.from;
    const car = { id: 'c:' + i, lane, s: lane.from + span * (0.15 + 0.37 * k + 0.11 * (i % 3)), v: CRUISE * 0.5, stopState: {}, lastHonk: 0, blockedSince: 0 };
    const p = carPos(car);
    const yaw = lane.axis === 'x' ? (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (lane.dir > 0 ? 0 : Math.PI);
    car.rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.7, p.z).setRotation(car.rot));
    const [collider, ...extraColliders] = carColliders(body, 0.7);
    car.entity = addEntity({ id: car.id, kind: 'traffic', type: 'car', body, collider, extraColliders, state: {}, color: CAR_COLORS[i % CAR_COLORS.length] });
    cars.push(car);
  }
}
// Distance along the lane to the first thing in our path (vagrants, sleepers, cars).
function obstacleAhead(car, look, ignorePeople = false) {
  const l = car.lane;
  let best = Infinity, vagrant = null;
  for (const e of entities.values()) {
    if (e === car.entity || !e.body) continue;
    if (!['vagrant', 'sleeper', 'traffic'].includes(e.kind)) continue; // cones and crates just get knocked aside
    if (ignorePeople && e.kind !== 'traffic') continue;
    const t = e.body.translation();
    const along = (l.axis === 'x' ? t.x - car.s : t.z - car.s) * l.dir;
    const side = l.axis === 'x' ? t.z - l.at : t.x - l.at;
    if (e.kind !== 'traffic' && t.y > 3.4) continue;              // up on a roof or a bridge, not in the road
    // Someone standing on this car: it won't drive off with them, it sits and honks.
    if (e.kind === 'vagrant' && t.y > CAR_HOOD_TOP + 0.5 && Math.abs(along) < CAR_HALF_LEN + 0.3 && Math.abs(side) < CAR_HALF_W + 0.3) { best = Math.min(best, 0); vagrant = e; continue; }
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
  const l = car.lane, sgn = Math.sign(car.v) * l.dir;
  const f = l.axis === 'x' ? { x: sgn, z: 0 } : { x: 0, z: sgn };
  let any = false;
  for (const s of sessions.values()) {
    const e = s.entity;
    if (e.down) continue;
    const t = e.body.translation();
    const along = (l.axis === 'x' ? t.x - car.s : t.z - car.s) * l.dir;
    const side = l.axis === 'x' ? t.z - l.at : t.x - l.at;
    if (Math.abs(along) > CAR_HALF_LEN + CAP_R + 0.05 || Math.abs(side) > CAR_HALF_W + CAP_R + 0.05) continue;
    if (t.y > CAR_HOOD_TOP + CAP_HALF + CAP_R - 0.15) continue;   // standing on the hood, not in front of it
    const speed = Math.abs(car.v), ss = Math.sign(side) || 1;
    const perp = l.axis === 'x' ? { x: 0, z: ss } : { x: ss, z: 0 };
    const out = 1 + speed * 0.15;
    const vel = [f.x * speed * 1.15 + perp.x * out, 2 + speed * 0.45, f.z * speed * 1.15 + perp.z * out];
    const roll = speed * 1.3;                                      // tumble head over heels away from the car
    const spin = [f.z * roll + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 4, -f.x * roll + (Math.random() - 0.5) * 2];
    if (knockDown(e, { vel, spin, cause: 'car', by: car.id })) {
      combat.hurt(e, Math.min(100, Math.round(25 + speed * 9)), { by: car.entity, cause: 'car' });   // no push: the ragdoll already flies
      car.lastHit = now; any = true;
      console.log(`[town] ${car.id} hit ${e.player.name} at ${speed.toFixed(1)} m/s`);
    }
  }
  return any;
}
function stepTraffic(now) {
  for (const car of cars) {
    const l = car.lane;
    let limit = Infinity; // distance we may still travel
    // intersections
    for (const c of laneCrossings.get(l.id)) {
      const toLine = (c.stopAt - car.s) * l.dir;
      if (toLine < -0.3) { if ((c.exitAt - car.s) * l.dir < 0) car.stopState[c.ix.id] = null; continue; }
      if (c.ix.control === 'light') {
        const ph = lightPhase(c.ix)[l.axis];
        if (ph === 'red' || (ph === 'yellow' && toLine > 6)) limit = Math.min(limit, toLine);
      } else if (c.ix.control === 'stop') {
        const st = car.stopState[c.ix.id] || (car.stopState[c.ix.id] = { stoppedAt: 0, go: false });
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
    const ob = obstacleAhead(car, look, rage && rage.phase === 'go');
    if (ob.vagrant) car.sawPersonAt ||= now; else car.sawPersonAt = 0;
    const reacting = ob.vagrant && now - car.sawPersonAt < REACT_MS;  // driver hasn't hit the brakes yet
    if (ob.gap < Infinity && !reacting) limit = Math.min(limit, ob.gap - 1.2);
    if (!rage && ob.vagrant && car.v < 0.5 && ob.gap < 6) {
      car.blockedSince ||= now;
      if (now - car.blockedSince > 900 && now - car.lastHonk > 2200) {
        car.lastHonk = now;
        const long = now - car.blockedSince > 5000;
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long, at: [carPos(car).x, 1, carPos(car).z], target: ob.vagrant.id });
      }
      // Fed up: back up a few metres, then floor it.
      const tgt = ob.vagrant;
      if (now - car.blockedSince > RAGE_MS && tgt.kind === 'vagrant' && !tgt.down && ob.gap > -0.5 && tgt.body.translation().y < CAR_HOOD_TOP + 0.5) {
        car.rage = { phase: 'back', until: now + 1000 };
        car.blockedSince = 0; car.lastHonk = now;
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long: true, rage: true, at: [carPos(car).x, 1, carPos(car).z], target: tgt.id });
      }
    } else if (!rage) car.blockedSince = 0;
    // hits happen at the speed the car arrives with
    const hit = carHits(car, now);
    // speed
    const want = Math.min(CRUISE, Math.sqrt(2 * BRAKE * Math.max(0, limit)));
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
    car.s += car.v * dt * l.dir;
    // loop back to the lane start at the map edge, if the start is clear
    if ((car.s - l.to) * l.dir > 0) {
      const clear = !cars.some(o => o !== car && o.lane === l && Math.abs(o.s - l.from) < 8);
      if (clear) { car.s = l.from; car.stopState = {}; } else car.s = l.to;
    }
    const p = carPos(car);
    car.entity.body.setNextKinematicTranslation({ x: p.x, y: 0.7, z: p.z });
    car.entity.state.braking = car.v < want - 0.05 || car.v < 0.1;
  }
}
function insideIx(car, ix) {
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
    const desired = { x: mx * speed * step * mm.scale + mm.kx, y: e.vy * step, z: mz * speed * step * mm.scale + mm.kz };
    // Cars (kinematic) are solid so you can stand on them; other players are not (GAME-83).
    controller.computeColliderMovement(e.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, notAVagrant);
    const mv = controller.computedMovement();
    const grounded = controller.computedGrounded();
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
    if ((st.brokenUntil || 0) > now) o.broken = 1;
    if (st.braking) o.brake = 1;
    copper.meta(e, o);
    if (st.angry) o.angry = 1;
    if (st.down) o.down = 1;
    if (e.down) o.rag = 1;                            // ragdolled by a car (GAME-83)
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
    else if (m.t === 'act') interact(s);
    else if (m.t === 'throw' && m.dir) throwBottle(s, { x: +m.dir.x || 0, y: +m.dir.y || 0, z: +m.dir.z || 0 });
    else if (m.t === 'grab') grab(s);
    else if (m.t === 'tp' && process.env.DEV_TP) {        // local testing only: jump to a spot
      const e = s.entity, x = +m.x || 0, z = +m.z || 0;
      e.body.setTranslation({ x, y: CAP_HALF + CAP_R + 0.05, z }, true); Object.assign(e.player, { x, y: CAP_HALF + CAP_R + 0.05, z }); s.queue = [];
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
