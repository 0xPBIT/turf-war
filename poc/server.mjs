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

// ---------- entities ----------
const sessions = new Map(); // playerId -> { ws, entity, input, lastAct, graceTimer }
// Every synced thing is an entity with an id, a kind and (usually) a rigid body.
const entities = new Map();      // id -> entity
const byCollider = new Map();    // collider handle -> entity
let nextItem = 1;

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
  if (e.player) Object.assign(d, { name: e.player.name, color: e.player.color, pid: e.player.id, held: e.player.held || null });
  if (e.fixedPos) d.pos = e.fixedPos;
  if (e.color) d.color = e.color;
  if (e.index !== undefined) d.index = e.index;
  if (e.spec) { d.s = e.spec.s; d.hex = e.spec.hex; }
  if (e.dir !== undefined) d.dir = e.dir;
  return d;
}

// Fixtures: static things you can act on (trash piles, the dumpster, the stop sign,
// windows, parked cars). The client already draws them; the server owns their state.
const fixtureCount = {};
MAP.colliders.forEach((c, i) => {
  const collider = colliderFor(c);
  if (!c.tag || c.tag === 'npc') return;
  const n = fixtureCount[c.tag] = (fixtureCount[c.tag] || 0) + 1;
  const id = c.tag === 'pile' ? 'pile:' + c.pile : `f:${c.tag}${n}`;
  addEntity({ id, kind: 'fixture', type: c.tag, collider, fixedPos: c.p, index: c.pile, dir: c.dir, state: {} });
});
// Extra fire hydrants (GAME-94): the client builds their models from the same list.
(MAP.hydrants || []).forEach((h, i) => {
  const p = [h.p[0], 0.35, h.p[1]];
  const collider = colliderFor({ p, cyl: [0.17, 0.7] });
  addEntity({ id: 'f:hydrantx' + (i + 1), kind: 'fixture', type: 'hydrant', collider, fixedPos: p, dir: h.dir || 0, state: {} });
});
for (const w of MAP.windows) {
  const collider = colliderFor({ p: w.p, q: w.q, box: w.half });
  addEntity({ id: w.id, kind: 'fixture', type: 'window', collider, fixedPos: w.p, index: w.gi, value: w.value, state: {} });
}
// Props: crates and cones are dynamic bodies. Their resting spots persist.
const PROP_SHAPES = {
  crate: (pr) => RAPIER.ColliderDesc.cuboid(pr.s / 2, pr.s / 2, pr.s / 2).setMass(2),
  cone: () => RAPIER.ColliderDesc.cylinder(0.38, 0.2).setMass(0.8),
};
function spawnProp(pr, fresh) {
  const saved = !fresh && save.objects['o:' + pr.id.slice(2)];
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(...(saved ? saved.p : pr.p)).setLinearDamping(0.3).setAngularDamping(0.5);
  if (saved) desc.setRotation({ x: saved.q[0], y: saved.q[1], z: saved.q[2], w: saved.q[3] });
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(PROP_SHAPES[pr.type](pr).setFriction(0.6).setRestitution(0.25), body);
  body.sleep();
  return addEntity({ id: pr.id, kind: 'prop', type: pr.type, body, collider, mass: pr.type === 'crate' ? 2 : 0.8, spec: pr, state: {} });
}
for (const pr of MAP.props) spawnProp(pr);

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
// E does the fixture's main thing (dumpsters: dig for junk); F lights anything that burns.
function interact(s, light) {
  const e = s.entity, p = e.player;
  const now = Date.now();
  if (now - (s.lastAct || 0) < 600) return;
  s.lastAct = now;
  // Holding a wrench, a hydrant in reach wins over whatever else is nearer (GAME-94).
  const target = (!light && p.held === 'wrench' && nearest(e, 3, o => o.type === 'hydrant'))
    || nearest(e, 3, o => o.kind === 'fixture' && ACTIONS[o.type] && !HIT_ONLY.has(o.type) && (!light || o.type === 'pile' || o.type === 'dumpster'));
  if (!target) return;
  if (target.type === 'hydrant') return hydrantAct(s, target, now);
  if ((target.type === 'dumpster' || target.type === 'pile') && !light) return rummage(s, target, now);
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
    const e = spawnItem(type, [sp.x, 0.25, sp.z], { rot: type === 'bottle' || type === 'can' ? (Math.random() < 0.6 ? lyingDown() : randomUpright()) : randomUpright(), spot: sp });
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
  if (key === 'lighter') items.lighter = { fuel: Math.max(10, items.lighter?.fuel || 0) };
  else if (key === 'pliers') items.pliers = true;
  else items[key] = (items[key] || 0) + 1;
  saveDirty = true;
  broadcast({ t: 'fx', kind: 'pocket', id: e.id, key, name: POCKET_TYPES[key]?.name || key });
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
  if (!type || now - (s.lastThrow || 0) < 350) return;
  s.lastThrow = now;
  const T = ITEM_TYPES[type];
  // First person: throw along the look direction, from eye height.
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len, dy = Math.max(-0.6, Math.min(0.9, dir.y / len)), dz = dir.z / len;
  const t = e.body.translation();
  const it = spawnItem(type, [t.x + dx * 0.6, t.y + 0.55 + dy * 0.6, t.z + dz * 0.6], {
    vel: [dx * T.speed, dy * T.speed + 3, dz * T.speed], spin: type === 'can' ? { x: 14, y: 2, z: 4 } : { x: 8, y: 0, z: 3 } });
  it.live = { thrower: e.player, until: now + 6000 };
  broadcast({ t: 'fx', kind: 'throw', id: e.id });
  it.collider.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  setHeld(e, null);
}
function endLive(it) { it.live = null; it.collider.setActiveEvents(RAPIER.ActiveEvents.NONE); }

function onItemHit(it, other) {
  const live = it.live;
  if (!live) return;
  if (other && other.player === live.thrower && other.kind === 'vagrant') return;
  if (other && other.kind === 'item') return;                      // junk clacking into junk is free
  const T = ITEM_TYPES[it.type], p = live.thrower, now = Date.now();
  const at = posOf(it), vel = it.body.linvel(), v = [vel.x, vel.y, vel.z], speed = Math.hypot(vel.x, vel.y, vel.z);
  endLive(it);
  const hard = speed > 4;
  if (other && (other.type === 'window' || other.type === 'car') && hard) {
    const a = ACTIONS[other.type];
    if (!T.breaks) addDamage(p, ITEM_RULES.pelt, posOf(other), other.type === 'car' ? `Pelted a car with a ${T.name}` : `Bonked a window with a ${T.name}`);
    else if (now >= (other.state.brokenUntil || 0)) {
      other.state.brokenUntil = now + a.repairSec * 1000;
      addDamage(p, other.value || a.cost, posOf(other), other.type === 'car' && it.type !== 'bottle' ? `${T.hitVerb || (T.name === 'rock' ? 'Rocked' : 'Bricked')} a windshield` : a.verb);
      broadcast({ t: 'fx', kind: 'break', id: other.id, at, v });
    } else addDamage(p, 15, at, 'More glass');
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
    broadcast({ t: 'fx', kind: 'wrench', id: e.id, hyd: h.id });
    setTimeout(() => { st.openUntil = Date.now(); st.wetUntil = Date.now() + 40000; }, 900);
    return;
  }
  if ((st.cappedUntil || 0) > now) return say('The water dept. just capped this one. Give it a minute');
  broadcast({ t: 'fx', kind: 'wrench', id: e.id, hyd: h.id });
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
        const t = o.body.translation(); if (t.y > 2.2) continue;
        const k = inJet(j, t.x, t.z); if (k === null) continue;
        const m = o.body.mass(), accel = Math.min(28, 160 / Math.max(m, 0.5)) * (0.3 + 0.7 * k);
        o.body.applyImpulse({ x: j.dx * accel * m * dt, y: (t.y < 0.6 ? 6 : 0) * Math.min(m, 3) * k * dt, z: j.dz * accel * m * dt }, true);
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
  const target = nearest(e, 2.6, o => (o.kind === 'prop' || o.kind === 'sleeper') && o.body);
  if (!target) return;
  const a = e.body.translation(), b = target.body.translation();
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
  const reach = 1.1;
  const anchorOnPlayer = { x: dx / d * reach, y: 0.2, z: dz / d * reach };
  const data = RAPIER.JointData.spherical(anchorOnPlayer, { x: 0, y: 0, z: 0 });
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
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(CAR_HALF_W, 0.7, CAR_HALF_LEN), body);
    car.entity = addEntity({ id: car.id, kind: 'traffic', type: 'car', body, collider, state: {}, color: CAR_COLORS[i % CAR_COLORS.length] });
    cars.push(car);
  }
}
// Distance along the lane to the first thing in our path (vagrants, sleepers, cars).
function obstacleAhead(car, look) {
  const l = car.lane;
  let best = Infinity, vagrant = null;
  for (const e of entities.values()) {
    if (e === car.entity || !e.body) continue;
    if (!['vagrant', 'sleeper', 'traffic'].includes(e.kind)) continue; // cones and crates just get knocked aside
    const t = e.body.translation();
    const along = (l.axis === 'x' ? t.x - car.s : t.z - car.s) * l.dir;
    const side = l.axis === 'x' ? t.z - l.at : t.x - l.at;
    const r = e.kind === 'traffic' ? CAR_HALF_LEN : 0.6;
    if (along <= 0 || along > look + CAR_HALF_LEN + r || Math.abs(side) > CAR_HALF_W + 0.7) continue;
    const gap = along - CAR_HALF_LEN - r;
    if (gap < best) { best = gap; vagrant = (e.kind === 'vagrant' || e.kind === 'sleeper') ? e : null; }
  }
  return { gap: best, vagrant };
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
    const look = 4 + car.v * car.v / (2 * BRAKE) + 2;
    const ob = obstacleAhead(car, look);
    if (ob.gap < Infinity) limit = Math.min(limit, ob.gap - 1.2);
    if (ob.vagrant && car.v < 0.5 && ob.gap < 6) {
      car.blockedSince ||= now;
      if (now - car.blockedSince > 900 && now - car.lastHonk > 2200) {
        car.lastHonk = now;
        const long = now - car.blockedSince > 5000;
        broadcast({ t: 'fx', kind: 'honk', id: car.id, long, at: [carPos(car).x, 1, carPos(car).z], target: ob.vagrant.id });
      }
    } else car.blockedSince = 0;
    // speed
    const want = Math.min(CRUISE, Math.sqrt(2 * BRAKE * Math.max(0, limit)));
    if (car.v < want) car.v = Math.min(want, car.v + ACCEL * dt);
    else car.v = Math.max(want, car.v - BRAKE * 1.5 * dt);
    if (limit <= 0) car.v = 0;
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
      if (g && g.mass) speed *= Math.max(0.25, Math.min(1, 60 / g.mass)); // heavy things slow you down
    }
    e.vy += GRAVITY * step;
    const push = waterPush(t.x, t.z);                               // standing in a hydrant's jet shoves you along it
    const desired = { x: (mx * speed + push.x) * step, y: e.vy * step, z: (mz * speed + push.z) * step };
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
    if (a && a.kind === 'item') onItemHit(a, b);
    else if (b && b.kind === 'item') onItemHit(b, a);
  });
  const now = Date.now();
  for (const e of entities.values()) if (e.live && now > e.live.until) endLive(e);
  if (tick % 30 === 0) stepItems(now);
  stepHydrants(now);
  tick++;
  if (tick % (PHYSICS_HZ / SNAPSHOT_HZ) === 0) sendSnapshot(false);
  if (tick % (PHYSICS_HZ / META_HZ) === 0) sendMeta();
}

// Only bodies that are moving go on the wire; resting bodies cost nothing.
function snapshotRows(all) {
  const rows = [];
  for (const e of entities.values()) {
    if (!e.body) continue;
    if (!all && e.body.isSleeping()) continue;
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
    if (e.type === 'hydrant') { if (hydrantOpen(st, now)) o.water = 1; if ((st.wetUntil || 0) > now) o.wet = 1; }
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
    if (e.kind === 'prop') save.objects[e.id] = { p: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w] };
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
    else if (m.t === 'act') interact(s, !!m.light);
    else if (m.t === 'pickup') pickup(s, typeof m.id === 'string' ? m.id : null);
    else if (m.t === 'drop') dropHeld(s.entity);
    else if (m.t === 'throw' && m.dir) throwHeld(s, { x: +m.dir.x || 0, y: +m.dir.y || 0, z: +m.dir.z || 0 });
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
