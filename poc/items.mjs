// Throwable junk (GAME-82): what exists, how it flies, and where it lies around town.
// Add a new item by adding a row to ITEM_TYPES (and a mesh in tools/items-client.js).
// Spawn spots are generated from the map, so every dumpster, trash pile, fire can,
// couch and stop sign the map places gets litter around it with no extra work.

export const ITEM_TYPES = {
  //        mass kg, throw speed m/s, shatters on impact, can break glass, chance weights
  bottle: { name: 'bottle', mass: 0.4, speed: 22, shatters: true, breaks: true, ground: 3, dumpster: 6,
    shape: R => R.ColliderDesc.capsule(0.12, 0.07) },
  can: { name: 'can', mass: 0.15, speed: 24, shatters: false, breaks: false, ground: 4, dumpster: 6,
    shape: R => R.ColliderDesc.cylinder(0.1, 0.066) },
  rock: { name: 'rock', mass: 0.9, speed: 21, shatters: false, breaks: true, ground: 4, dumpster: 0,
    shape: R => R.ColliderDesc.ball(0.085) },
  brick: { name: 'brick', mass: 1.6, speed: 17, shatters: false, breaks: true, ground: 1, dumpster: 1.5,
    shape: R => R.ColliderDesc.cuboid(0.06, 0.13, 0.042) },
  // Heavy pipe wrench (GAME-94): hold it and press E at a fire hydrant to crank it open.
  // Never in random ground litter; it lies at hand-placed spots (town.json items.spots) and turns up in dumpsters.
  wrench: { name: 'pipe wrench', mass: 1.3, speed: 17, shatters: false, breaks: true, ground: 0, dumpster: 0.8, hitVerb: 'Wrenched',
    shape: R => R.ColliderDesc.cuboid(0.035, 0.19, 0.05) },
};

export const ITEM_RULES = {
  pickupReach: 2.6,         // metres from your middle to the item
  respawnMinS: 40, respawnMaxS: 90,
  maxLoose: 70,             // thrown/dropped items beyond this get tidied away, oldest first
  dumpsterStock: 4,         // finds per dumpster before it is picked clean
  dumpsterRefillS: 45,      // one find comes back every this many seconds
  pelt: 20,                 // cost when something that can't break glass hits a window or car
};

// Pocket finds: small things that go in your pockets (p.items), not your throwing hand.
// The lighter is what lighting fires checks for (GAME-86).
export const POCKET_TYPES = {
  lighter: { name: 'lighter', dumpster: 1 },
  cigarettes: { name: 'half a pack of smokes', dumpster: 2 },
  pliers: { name: 'a pair of pliers', dumpster: 2 },   // copper stripping (GAME-91) checks p.items.pliers
};
// One roll for a dumpster dig: a throwable or a pocket find.
export function dumpsterFind(rand = Math.random) {
  const rows = [...Object.entries(ITEM_TYPES).map(([k, t]) => [k, t.dumpster, false]), ...Object.entries(POCKET_TYPES).map(([k, t]) => [k, t.dumpster, true])].filter(r => r[1] > 0);
  let r = rand() * rows.reduce((a, x) => a + x[1], 0);
  for (const [k, w, pocket] of rows) { r -= w; if (r <= 0) return { key: k, pocket }; }
  const last = rows[rows.length - 1]; return { key: last[0], pocket: last[2] };
}

// Litter rings around tagged fixtures: how many spots, which items.
const LITTER = {
  dumpster: { n: 3, types: ['bottle', 'can', 'can', 'brick'] },
  pile: { n: 2, types: ['bottle', 'can'] },
  fire_can: { n: 2, types: ['bottle', 'can', 'rock'] },
  couch: { n: 2, types: ['bottle', 'can'] },
  stop_sign: { n: 1, types: ['can', 'rock'] },
};

export function pickWeighted(table, rand = Math.random) {
  const rows = Object.entries(ITEM_TYPES).filter(([, t]) => t[table] > 0);
  let total = 0; for (const [, t] of rows) total += t[table];
  let r = rand() * total;
  for (const [k, t] of rows) { r -= t[table]; if (r <= 0) return k; }
  return rows[rows.length - 1][0];
}

// Deterministic so spots land in the same places every restart.
function seeded(seed) { let s = seed % 2147483647 || 1; return () => (s = s * 16807 % 2147483647) / 2147483647; }

function blocked(MAP, x, z, pad = 0.25) {
  const hit = (p, hx, hz) => Math.abs(x - p[0]) < hx + pad && Math.abs(z - p[2]) < hz + pad;
  for (const c of MAP.colliders) {
    if (c.box) { const r = c.q ? Math.max(c.box[0], c.box[2]) : 0; if (hit(c.p, r || c.box[0], r || c.box[2])) return true; }
    else if (c.cyl && hit(c.p, c.cyl[0], c.cyl[0])) return true;
  }
  for (const w of MAP.windows || []) { const r = Math.max(w.half[0], w.half[2]); if (hit(w.p, r, r)) return true; }
  for (const p of MAP.props || []) if (hit(p.p, 0.45, 0.45)) return true;
  const b = MAP.bounds; return x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1;
}

// Spots: { x, z, types } from map.items.spots (optional, hand placed) plus litter
// rings around fixtures plus a few rocks scattered in each turf zone.
export function itemSpots(MAP) {
  const out = [], rand = seeded(8221);
  const tryAdd = (x, z, types) => { if (!blocked(MAP, x, z) && !out.some(s => (s.x - x) ** 2 + (s.z - z) ** 2 < 0.6)) { out.push({ x, z, types }); return true; } return false; };
  for (const s of MAP.items?.spots || []) out.push({ x: s.p[0], z: s.p[1], types: s.types || null });
  for (const c of MAP.colliders) {
    const l = LITTER[c.tag]; if (!l) continue;
    const r0 = (c.box ? Math.max(c.box[0], c.box[2]) : c.cyl[0]) + 0.5;
    for (let k = 0, placed = 0; k < l.n * 6 && placed < l.n; k++) {
      const a = rand() * Math.PI * 2, r = r0 + rand() * 1.2;
      if (tryAdd(c.p[0] + Math.cos(a) * r, c.p[2] + Math.sin(a) * r, l.types)) placed++;
    }
  }
  const perZone = MAP.items?.perZone ?? 2;
  for (const zn of MAP.zones || []) {
    for (let k = 0, placed = 0; k < perZone * 8 && placed < perZone; k++)
      if (tryAdd(zn.x + rand() * zn.w, zn.z + rand() * zn.d, ['rock', 'rock', 'can'])) placed++;
  }
  return out;
}
