// Puddlewick terrain (GAME-96): one smooth height function shared by the server (physics,
// spawns, traffic) and the client (ground mesh, draping roads and placing everything on it).
// The downtown core, the underpass, the school and the rail yard stay flat (y = 0); hills live in:
//   - Bluebell Heights: the suburbs climb about 7 m north of Creek Rd (up to a 15% grade), so Maple Row, Oak Ave and
//     Birch Ln become sloping streets (no cross slope: each road runs straight up the grade).
//   - Puddle Park: rolling lawns, Gazebo Hill, a picnic knoll and a sledding slope, with the pond
//     left level in its hollow.
// Heights only ever go up (H >= 0), so anything that assumed flat ground sits at or below it.
// The client inlines this file (build-client.py strips the `export`).
export const TERRAIN = (() => {
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const PARK = { x0: -88, x1: 12, z0: 78, z1: 163 };
  // Park hills: [x, z, height, radius]. Gaussian bumps, so the steepest part is ~0.86 h / r.
  const HILLS = [
    [-72, 147, 5.6, 22],   // Gazebo Hill (the gazebo sits on top)
    [-13, 102, 3.0, 14],   // east lawn mound by Creek Rd
    [-70, 95, 2.4, 13],    // picnic knoll
    [-38, 170, 4.6, 22],   // sledding slope along the north edge
    [-94, 116, 3.6, 18],   // west bank against the town edge
  ];
  // The rise starts behind the Creek Rd sidewalks and fades out west across the greenbelt, low enough
  // under the Skyway deck to keep headroom.
  const SUB = { amp: 7, z0: 76, z1: 146, x0: 17, x1: 30 };
  function park(x, z) {
    // Fade out toward Creek Rd (south edge) and the east edge; keep the pond basin level.
    const m = ss(PARK.z0 + 3, PARK.z0 + 13, z) * (1 - ss(PARK.x1 - 10, PARK.x1 + 2, x));
    if (m <= 0) return 0;
    const e = ((x + 46) / 30) ** 2 + ((z - 118) / 24) ** 2, pond = ss(1.0, 2.0, e);
    if (pond <= 0) return 0;
    let h = 0;
    for (const [hx, hz, hh, r] of HILLS) { const d2 = (x - hx) ** 2 + (z - hz) ** 2; if (d2 < 9 * r * r) h += hh * Math.exp(-d2 / (r * r)); }
    h += 0.45 * (1 + Math.sin(x * 0.085 + 1.3) * Math.sin(z * 0.11 + 0.4));   // gentle roll everywhere
    return h * m * pond;
  }
  function suburbs(x, z) {
    if (z <= SUB.z0 || x <= SUB.x0) return 0;
    return SUB.amp * ss(SUB.z0, SUB.z1, z) * ss(SUB.x0, SUB.x1, x);
  }
  function h(x, z) { return park(x, z) + suburbs(x, z); }
  // Surface normal (unit) from central differences.
  function normal(x, z, e = 0.25) {
    const dx = (h(x + e, z) - h(x - e, z)) / (2 * e), dz = (h(x, z + e) - h(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
  }
  // Highest / lowest ground under an axis-aligned footprint (centre x,z, half sizes hx,hz).
  function range(x, z, hx, hz) {
    let lo = Infinity, hi = -Infinity; const nx = Math.max(2, Math.ceil(hx * 2 / 1.5)), nz = Math.max(2, Math.ceil(hz * 2 / 1.5));
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) { const y = h(x - hx + 2 * hx * i / nx, z - hz + 2 * hz * j / nz); if (y < lo) lo = y; if (y > hi) hi = y; }
    return [lo, hi];
  }
  // Where the terrain is not flat (for building the physics heightfield and fine ground mesh).
  const AREA = { minX: -150, maxX: 220, minZ: 70, maxZ: 240 };
  return { h, normal, range, AREA };
})();
