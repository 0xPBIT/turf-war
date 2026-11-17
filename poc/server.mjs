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
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'world.json');
const GRACE_MS = Number(process.env.GRACE_MS || 5000); // design doc says 20 s; shorter for the demo
const HEAT_HALF_LIFE_S = Number(process.env.HEAT_HALF_LIFE_S || 600); // design doc says ~24 h
const PHYSICS_HZ = 60, SNAPSHOT_HZ = 20, META_HZ = 2;
const WALK = 6, RUN = 9.5, JUMP = 6.5, GRAVITY = -20;

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'map.json'), 'utf8'));

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
for (const r of MAP.roads) if (r.elevated) fixed(r.x + r.w / 2, 6.3, r.z + r.d / 2, r.w / 2, 0.3, r.d / 2);
for (const b of MAP.buildings) fixed(b.x + b.w / 2, b.h / 2, b.z + b.d / 2, b.w / 2, b.h / 2, b.d / 2);

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
  if (e.fixedPos) d.pos = e.fixedPos;
  if (e.color) d.color = e.color;
  return d;
}

const PROP_SPECS = {
  dumpster:  { shape: () => RAPIER.ColliderDesc.cuboid(1.1, 0.7, 0.65), mass: 300, y: 0.7 },
  trash_can: { shape: () => RAPIER.ColliderDesc.cylinder(0.45, 0.32), mass: 8, y: 0.45 },
  car:       { shape: () => RAPIER.ColliderDesc.cuboid(1.0, 0.6, 2.1), mass: 1100, y: 0.6 },
};
const FIXED_SPECS = {
  window:      [0.9, 0.7, 0.08, 1.6],
  bus_shelter: [1.8, 1.3, 0.7, 1.3],
  stop_light:  [0.15, 2.0, 0.15, 2.0],
  stop_sign:   [0.1, 1.2, 0.1, 1.2],
};

// Map interactables become entities. Movable ones are dynamic bodies whose resting
// position persists, so the town stays as messy as players leave it.
for (const it of MAP.interactables) {
  const id = 'o:' + it.id;
  if (PROP_SPECS[it.type]) {
    const spec = PROP_SPECS[it.type];
    const saved = save.objects[id];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(saved ? saved.p[0] : it.x, saved ? saved.p[1] : spec.y, saved ? saved.p[2] : it.z)
      .setLinearDamping(0.6).setAngularDamping(0.8);
    if (saved) desc.setRotation({ x: saved.q[0], y: saved.q[1], z: saved.q[2], w: saved.q[3] });
    const body = world.createRigidBody(desc);
    const collider = world.createCollider(spec.shape().setMass(spec.mass).setFriction(0.7), body);
    addEntity({ id, kind: 'prop', type: it.type, body, collider, mass: spec.mass, state: {} });
  } else {
    const [hx, hy, hz, cy] = FIXED_SPECS[it.type] || [0.4, 0.3, 0.4, 0.3];
    const collider = it.type === 'campfire'
      ? null
      : fixed(it.x, cy, it.z, hx, hy, hz);
    addEntity({ id, kind: 'fixture', type: it.type, collider, fixedPos: [it.x, cy, it.z], state: {} });
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
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y + 0.3, p.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.4).setFriction(0.5), body);
  return addEntity({ id: vagrantId(p.id), kind: 'vagrant', player: p, body, collider, vy: 0, grabbing: null, state: {} });
}

// A logged-out vagrant lies down where they stood: a dynamic, draggable body.
function spawnSleeper(p) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(p.x, Math.max(p.y, 0.45), p.z)
    .setRotation(p.q ? { x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] } : { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
    .setLinearDamping(1.5).setAngularDamping(2.0);
  const body = world.createRigidBody(desc);
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.4).setMass(70).setFriction(0.9), body);
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
    Object.assign(p, { x: t.x, y: 0.6, z: t.z });
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

function interact(s) {
  const e = s.entity, p = e.player;
  const now = Date.now();
  if (now - (s.lastAct || 0) < 600) return;
  s.lastAct = now;
  const target = nearest(e, 3, o => o.type && ACTIONS[o.type] && o.type !== 'window' && o.type !== 'car');
  if (!target) return;
  const a = ACTIONS[target.type];
  const busyUntil = target.state.busyUntil || 0;
  if (now < busyUntil) return;
  target.state.busyUntil = now + a.repairSec * 1000;
  if (target.type === 'dumpster' || target.type === 'trash_can') target.state.fireUntil = now + a.repairSec * 1000;
  if (a.cash) { p.cash = (p.cash || 0) + a.cash; broadcast({ t: 'fx', kind: 'say', id: e.id, text: `Spare change? (+$${a.cash})` }); }
  if (a.hangout) broadcast({ t: 'fx', kind: 'say', id: e.id, text: 'just vibin by the fire' });
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
    .setTranslation(t.x + dx * 0.7, t.y + 0.6 + dy * 0.7, t.z + dz * 0.7)
    .setLinvel(dx * 16, dy * 16 + 2.5, dz * 16).setAngvel({ x: 8, y: 0, z: 3 }).setCcdEnabled(true));
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
  if (other && ['window', 'car', 'bus_shelter'].includes(other.type)) {
    const a = ACTIONS[other.type];
    if (now >= (other.state.brokenUntil || 0)) {
      other.state.brokenUntil = now + a.repairSec * 1000;
      addDamage(p, a.cost, posOf(other), a.verb.replace('Throw a beer bottle', 'Smashed a window'));
    } else addDamage(p, 15, at, 'More glass');
  } else addDamage(p, 3, at, 'Broken bottle');
  broadcast({ t: 'fx', kind: 'smash', at });
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
const CRUISE = 9, ACCEL = 4, BRAKE = 10, CAR_HALF_LEN = 2.1, CAR_HALF_W = 1.0;
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
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.6, p.z).setRotation(car.rot));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(CAR_HALF_W, 0.6, CAR_HALF_LEN), body);
    car.entity = addEntity({ id: car.id, kind: 'traffic', type: 'car', body, collider, state: {}, color: COLORS[(i * 3) % COLORS.length] });
    cars.push(car);
  }
}
// Distance along the lane to the first thing in our path (vagrants, sleepers, cars).
function obstacleAhead(car, look) {
  const l = car.lane;
  let best = Infinity, vagrant = null;
  for (const e of entities.values()) {
    if (e === car.entity || !e.body) continue;
    if (!['vagrant', 'sleeper', 'traffic', 'prop'].includes(e.kind)) continue;
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
    car.entity.body.setNextKinematicTranslation({ x: p.x, y: 0.6, z: p.z });
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
    const e = s.entity, inp = s.input;
    const t = e.body.translation();
    let mx = inp.x || 0, mz = inp.z || 0;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    let speed = inp.run ? RUN : WALK;
    if (e.grabbing) {
      const g = entities.get(e.grabbing);
      if (g && g.mass) speed *= Math.max(0.25, Math.min(1, 60 / g.mass)); // heavy things slow you down
    }
    e.vy += GRAVITY * dt;
    const desired = { x: mx * speed * dt, y: e.vy * dt, z: mz * speed * dt };
    controller.computeColliderMovement(e.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    const mv = controller.computedMovement();
    const grounded = controller.computedGrounded();
    if (grounded) { e.vy = inp.jump ? JUMP : 0; }
    if (typeof inp.yaw === 'number') e.facing = inp.yaw;
    else if (ml > 0.01) e.facing = Math.atan2(mx, mz);
    e.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    const p = e.player;
    p.x = t.x; p.y = t.y; p.z = t.z;
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
  const msg = JSON.stringify({ t: 's', b: snapshotRows(all) });
  if (ws) return ws.send(msg);
  for (const s of sessions.values()) if (s.ws.readyState === 1) s.ws.send(msg);
}
function metaPayload() {
  const now = Date.now();
  const objects = {};
  for (const e of entities.values()) {
    const st = e.state || {};
    const o = {};
    if ((st.fireUntil || 0) > now) o.fire = 1;
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
  if (url.pathname === '/vendor/three.module.js' || url.pathname === '/vendor/three.core.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    return fs.createReadStream(path.join(__dirname, 'node_modules', 'three', 'build', path.basename(url.pathname))).pipe(res);
  }
  if (url.pathname === '/map.json') { res.writeHead(200, { 'content-type': MIME['.json'] }); return res.end(JSON.stringify(MAP)); }
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
        save.players[id] = { id, name, color: COLORS[Object.keys(save.players).length % COLORS.length], x: MAP.spawn.x + spawnJitter(), y: 1, z: MAP.spawn.z + spawnJitter(), damage: 0, cash: 0, asleep: false };
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
    if (m.t === 'in') s.input = { x: +m.x || 0, z: +m.z || 0, jump: !!m.jump, run: !!m.run, yaw: Number.isFinite(+m.yaw) ? +m.yaw : undefined };
    else if (m.t === 'act') interact(s);
    else if (m.t === 'throw' && m.dir) throwBottle(s, { x: +m.dir.x || 0, y: +m.dir.y || 0, z: +m.dir.z || 0 });
    else if (m.t === 'grab') grab(s);
  });
  ws.on('close', () => {
    const s = pid && sessions.get(pid);
    if (!s || s.ws !== ws) return;
    s.input = {};
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
