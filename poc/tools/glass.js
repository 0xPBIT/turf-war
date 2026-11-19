// ===================== procedural glass fracture (GAME-84) =====================
// Any glass pane can shatter from the exact point it was hit. The crack pattern is a
// radial + concentric fracture (the "spider web" real glass makes) built from a seed,
// so every break is different but every client builds the same one from the same
// numbers. Pieces near the impact fall out as physics shards, the rest stay jammed in
// the frame with cracks running through them. Later hits knock out more.
//
// Usage, for any THREE.Mesh whose geometry is a Box/PlaneGeometry in its local XY plane:
//   GLASS.shatter(mesh, { seed, hits: [[u, v], ...], quiet, dir, hi })
//     u, v in -1..1 across the pane (0,0 is the centre); optional 3rd value: 1 if hit from
//     the side the mesh's +Z faces (default), -1 from behind. Fallen glass lands on the hit side. quiet = build it already
//     broken (late join), with the fallen glass lying on the ground instead of flying.
//   GLASS.board(mesh)    plywood over the hole while the town gets round to it
//   GLASS.restore(mesh)  fresh glass, debris swept up
//   GLASS.state(mesh)    { seed, hits, boarded } or null
// Call GLASS.update(dt) once a frame.
const GLASS = (() => {
  const panes = new Map();        // mesh -> pane state
  const flying = [];              // { m, b, t, pane }  shards with live physics bodies
  const MAX_FLYING = 90, MAX_BODIES_PER_HIT = 18, SETTLE_S = 5;

  // Seeded RNG (mulberry32): same seed, same cracks, on every client.
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Grimy, slightly green safety glass. Kept in the main layer so the ink pass outlines
  // the jagged hole and each loose piece.
  // Vertex colours carry the tint and alpha: crazed white near the hit, dirty clear further out.
  const crackedMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: .14, metalness: 0, clearcoat: .8, envMapIntensity: .9,
    transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide });
  const flyMat = new THREE.MeshPhysicalMaterial({ color: 0xBFE4EE, roughness: .08, clearcoat: 1, envMapIntensity: 1.5,
    transparent: true, opacity: .72, side: THREE.DoubleSide });
  const groundMat = new THREE.MeshPhysicalMaterial({ color: 0x86BEC2, roughness: .12, clearcoat: .6, envMapIntensity: .7,
    transparent: true, opacity: .75, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
  // Cracks are thin ribbons, not 1px lines, so they survive the Blend pass: an ink core with a white glint.
  const crackMat = new THREE.MeshBasicMaterial({ color: 0xF6FCFF, transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide });
  const crackInkMat = new THREE.MeshBasicMaterial({ color: 0x2C3438, transparent: true, opacity: .75, depthWrite: false, side: THREE.DoubleSide });

  // ---------- plywood ----------
  const plyTex = (() => {
    const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s; const g = cv.getContext('2d');
    g.fillStyle = '#C7A06A'; g.fillRect(0, 0, s, s);
    const r = rng(77);
    for (let i = 0; i < 70; i++) { // grain
      g.strokeStyle = `rgba(${120 + r() * 40 | 0},${80 + r() * 30 | 0},${40 + r() * 20 | 0},${.12 + r() * .18})`; g.lineWidth = 1 + r() * 2.5;
      const y = r() * s; g.beginPath(); g.moveTo(0, y); for (let x = 0; x <= s; x += 16) g.lineTo(x, y + Math.sin(x * .03 + i) * (3 + r() * 5)); g.stroke();
    }
    for (let i = 0; i < 5; i++) { const x = r() * s, y = r() * s, rad = 5 + r() * 9; g.fillStyle = 'rgba(110,70,35,.35)'; g.beginPath(); g.ellipse(x, y, rad * 1.8, rad, 0, 0, 6.3); g.fill(); }
    for (let i = 0; i < 30; i++) { // rain streaks and grime
      const x = r() * s; const gr = g.createLinearGradient(0, 0, 0, s); gr.addColorStop(0, 'rgba(60,45,30,.0)'); gr.addColorStop(1, `rgba(60,45,30,${.1 + r() * .2})`);
      g.fillStyle = gr; g.fillRect(x, r() * s * .5, 2 + r() * 6, s);
    }
    const eg = g.createRadialGradient(s / 2, s / 2, s * .3, s / 2, s / 2, s * .75); eg.addColorStop(0, 'rgba(40,30,20,0)'); eg.addColorStop(1, 'rgba(40,30,20,.45)');
    g.fillStyle = eg; g.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();
  const plyMat = new THREE.MeshStandardMaterial({ map: plyTex, color: 0xBFAE95, roughness: .95 }); // weathered, not lumber-yard fresh
  const battenMat = new THREE.MeshStandardMaterial({ color: 0x8E7550, roughness: .95 });
  const nailMat = new THREE.MeshStandardMaterial({ color: 0x55585C, roughness: .5, metalness: .6 });

  // ---------- geometry helpers ----------
  function clipRect(poly, hw, hh) { // Sutherland-Hodgman against the pane rectangle
    const edges = [[1, 0, hw], [-1, 0, hw], [0, 1, hh], [0, -1, hh]]; // n.x*x + n.y*y <= d
    let out = poly;
    for (const [nx, ny, d] of edges) {
      const inp = out; out = []; if (!inp.length) break;
      for (let i = 0; i < inp.length; i++) {
        const a = inp[i], b = inp[(i + 1) % inp.length];
        const da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d;
        if (da <= 0) out.push(a);
        if ((da < 0) !== (db < 0) && da !== db) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
    }
    return out;
  }
  function area(poly) { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function centroid(poly) { let x = 0, y = 0; for (const p of poly) { x += p[0]; y += p[1]; } return [x / poly.length, y / poly.length]; }

  // Build the fracture: rays out from the impact, rings around it, jittered and shared
  // so neighbouring pieces fit like a real crack. Returns pieces in pane-local metres.
  function fracture(w, h, ix, iy, seed) {
    const r = rng(seed), hw = w / 2, hh = h / 2;
    const R = Math.max(...[[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([x, y]) => Math.hypot(x - ix, y - iy))) * 1.3;
    const nRays = 9 + Math.floor(r() * 6), step = Math.PI * 2 / nRays, a0 = r() * 6.283;
    const ang = []; for (let i = 0; i < nRays; i++) ang.push(a0 + i * step + (r() - .5) * step * .7);
    const rings = [0]; let rr = .05 + r() * .05;
    while (rr < R) { rings.push(rr); rr *= 1.55 + r() * .7; }
    rings.push(R);
    const nr = rings.length;
    // Ring vertices, plus a kinked midpoint on every radial and ring segment.
    const P = [], MR = [], MA = [];
    for (let i = 0; i < nRays; i++) {
      P[i] = []; MR[i] = []; MA[i] = [];
      for (let j = 0; j < nr; j++) {
        if (j === 0) { P[i][j] = [ix, iy]; continue; }
        const a = ang[i] + (r() - .5) * .12, d = rings[j] * (j === nr - 1 ? 1 : .82 + r() * .36);
        P[i][j] = [ix + Math.cos(a) * d, iy + Math.sin(a) * d];
      }
    }
    for (let i = 0; i < nRays; i++) for (let j = 0; j < nr - 1; j++) {
      const A = P[i][j], B = P[i][j + 1], L = Math.hypot(B[0] - A[0], B[1] - A[1]), k = (r() - .5) * .22 * L, t = .35 + r() * .3;
      const nx = -(B[1] - A[1]) / (L || 1), ny = (B[0] - A[0]) / (L || 1);
      MR[i][j] = [A[0] + (B[0] - A[0]) * t + nx * k, A[1] + (B[1] - A[1]) * t + ny * k];
    }
    for (let i = 0; i < nRays; i++) for (let j = 1; j < nr; j++) {
      const A = P[i][j], B = P[(i + 1) % nRays][j], m = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const out = Math.hypot(m[0] - ix, m[1] - iy) || 1, bulge = rings[j] * (.04 + r() * .1);
      MA[i][j] = [m[0] + (m[0] - ix) / out * bulge, m[1] + (m[1] - iy) / out * bulge];
    }
    // Some ring cracks never formed: those edges are drawn faint or not at all.
    const ringCrack = []; for (let i = 0; i < nRays; i++) { ringCrack[i] = []; for (let j = 1; j < nr; j++) ringCrack[i][j] = j === nr - 1 ? 0 : (r() < (j <= 2 ? .92 : .55) ? 1 : 0); }
    const pieces = [];
    for (let i = 0; i < nRays; i++) {
      const i2 = (i + 1) % nRays;
      for (let j = 0; j < nr - 1; j++) {
        const poly = j === 0
          ? [P[i][0], MR[i][0], P[i][1], MA[i][1], P[i2][1], MR[i2][0]]
          : [P[i][j], MR[i][j], P[i][j + 1], MA[i][j + 1], P[i2][j + 1], MR[i2][j], P[i2][j], MA[i][j]];
        if (area(poly) < 0) poly.reverse();
        const c = clipRect(poly, hw, hh); if (c.length < 3) continue;
        const ar = Math.abs(area(c)); if (ar < 1e-4) continue;
        const [cx, cy] = centroid(c);
        pieces.push({ poly: c, cx, cy, area: ar, ring: j, ray: i, tilt: [(r() - .5) * .16, (r() - .5) * .16], roll: r(),
          // Crack lines this piece owns: its leading ray and its outer ring (if it formed).
          lines: [[P[i][j], MR[i][j], P[i][j + 1]], ...(ringCrack[i][j + 1] ? [[P[i][j + 1], MA[i][j + 1], P[i2][j + 1]]] : [])],
          // Edges owned by neighbours, drawn only when that neighbour has fallen out (the rim of the hole).
          inner: j > 0 ? [P[i][j], MA[i][j], P[i2][j]] : null, side: [P[i2][j], MR[i2][j], P[i2][j + 1]] });
      }
    }
    return { pieces, rnd: r };
  }

  function clipSeg(a, b, hw, hh) { // Liang-Barsky
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [pp, q] of [[-dx, a[0] + hw], [dx, hw - a[0]], [-dy, a[1] + hh], [dy, hh - a[1]]]) {
      if (pp === 0) { if (q < 0) return null; continue; }
      const t = q / pp; if (pp < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
  }
  function polyGeo(poly, ox, oy, z, tilt) { // centroid fan, faceted normal so each piece glints its own way
    const pos = [], nrm = [], n = new THREE.Vector3(tilt ? tilt[0] : 0, tilt ? tilt[1] : 0, 1).normalize();
    const [cx, cy] = centroid(poly);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      pos.push(cx - ox, cy - oy, z, a[0] - ox, a[1] - oy, z, b[0] - ox, b[1] - oy, z);
      for (let k = 0; k < 3; k++) nrm.push(n.x, n.y, n.z);
    }
    return { pos, nrm };
  }
  function buildMesh(list, mat) {
    const pos = [], nrm = []; for (const g of list) { pos.push(...g.pos); nrm.push(...g.nrm); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return new THREE.Mesh(geo, mat);
  }
  function clearGroup(p) { if (!p.group) return; p.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); p.group.parent && p.group.parent.remove(p.group); p.group = null; }
  function clearDebris(p) {
    for (const o of p.ground) { scene.remove(o); o.geometry.dispose(); } p.ground.length = 0;
    for (let i = flying.length - 1; i >= 0; i--) if (flying[i].pane === p) dropFlying(i);
  }
  function dropFlying(i) { const f = flying[i]; scene.remove(f.m); f.m.geometry.dispose(); if (f.b) world.removeBody(f.b); flying.splice(i, 1); }

  // Sidewalk slabs are visual only (physics ground is y=0), so find the floor by raycasting
  // the rendered scene once per pane, a step out from the foot of the window.
  const caster = new THREE.Raycaster(); caster.layers.set(0);
  function floorAt(mesh, outward) {
    const wp = mesh.getWorldPosition(new THREE.Vector3()).addScaledVector(outward, .8);
    caster.set(wp, new THREE.Vector3(0, -1, 0)); caster.far = wp.y + 1; caster.camera = camera;
    let hits = []; try { hits = caster.intersectObjects(scene.children, true); } catch { return 0; }
    const hit = hits.find(h => h.object.isMesh && !h.object.material.transparent && h.object.visible && h.point.y < .35); // skip bins, bags, sills
    return hit ? hit.point.y : 0;
  }
  function dims(mesh) { const g = mesh.geometry.parameters || {}; return [g.width || 1, g.height || 1]; }

  // What falls out for a hit: everything close to it, then a fading chance further out.
  // Pure function of the pieces and hit list, so late joiners get the same holes.
  function decideFallen(p) {
    const [w, h] = p.size, small = Math.min(w, h), big = w * h < 1.2;
    for (const pc of p.pieces) pc.out = false;
    p.hits.forEach(([hx, hy], k) => {
      const holeR = (k === 0 ? .2 + p.holeJit * .18 : .24) * (big ? 1.7 : 1) + small * .08;
      for (const pc of p.pieces) {
        if (pc.out) continue;
        const d = Math.hypot(pc.cx - hx, pc.cy - hy);
        const chance = d < holeR ? 1 : Math.pow(holeR / d, 2.4) * (k === 0 ? .55 : .8);
        if (pc.roll < chance) { pc.out = true; pc.outBy = k; }
      }
    });
    if (p.hits.length >= 3) { // third hit: it all goes, except teeth stuck in the frame
      const [hw, hh] = [w / 2, h / 2];
      for (const pc of p.pieces) if (!pc.out) {
        const edge = Math.min(hw - Math.abs(pc.cx), hh - Math.abs(pc.cy));
        if (edge > .1 || pc.area > .05) { pc.out = true; pc.outBy = p.hits.length - 1; }
      }
    }
  }

  function rebuildStanding(p) {
    clearGroup(p);
    const { mesh } = p, g = new THREE.Group();
    g.position.copy(mesh.position); g.quaternion.copy(mesh.quaternion); mesh.parent.add(g); p.group = g;
    const keep = p.pieces.filter(pc => !pc.out);
    if (keep.length) {
      const near = (x, y) => Math.min(...p.hits.map(([hx, hy]) => Math.hypot(x - hx, y - hy)));
      const m = buildMesh(keep.map(pc => polyGeo(pc.poly, 0, 0, 0, pc.tilt)), crackedMat);
      const cols = [], tint = new THREE.Color(0x9CC7D2), frost = new THREE.Color(0xEAF6F8), c = new THREE.Color();
      for (const pc of keep) {
        const k = Math.max(0, 1 - near(pc.cx, pc.cy) / .7), a = .55 + k * .35;
        c.copy(tint).lerp(frost, k);
        for (let n = 0; n < pc.poly.length * 3; n++) cols.push(c.r, c.g, c.b, a);
      }
      m.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4)); m.renderOrder = 2; g.add(m);
      // Crack ribbons on the effects layer (no ink pass): wide on the rim of the hole, fine far out.
      const glint = [], ink = [], [hw, hh] = [p.size[0] / 2, p.size[1] / 2], key = new Map(p.pieces.map(pc => [pc.ray + ':' + pc.ring, pc]));
      const nRays = Math.max(...p.pieces.map(pc => pc.ray)) + 1;
      const fell = (ray, ring) => { const n = key.get(((ray + nRays) % nRays) + ':' + ring); return !n || n.out; };
      const ribbon = (out, a, b, w, z, off) => {
        const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * w, ny = dx / L * w, ox = -dy / L * off, oy = dx / L * off;
        const A = [a[0] + ox, a[1] + oy], B = [b[0] + ox, b[1] + oy];
        out.push(A[0] - nx, A[1] - ny, z, B[0] - nx, B[1] - ny, z, B[0] + nx, B[1] + ny, z, A[0] - nx, A[1] - ny, z, B[0] + nx, B[1] + ny, z, A[0] + nx, A[1] + ny, z);
      };
      const add = (ln, rim) => { for (let k = 0; k < ln.length - 1; k++) {
        const c2 = clipSeg(ln[k], ln[k + 1], hw, hh); if (!c2) continue;
        const d = near((c2[0][0] + c2[1][0]) / 2, (c2[0][1] + c2[1][1]) / 2), w = rim ? .02 : .007 + .009 * Math.max(0, 1 - d / 1.2);
        ribbon(ink, c2[0], c2[1], w, .02, 0); ribbon(glint, c2[0], c2[1], w * .6, .021, w * 1.5);
      } };
      for (const pc of keep) {
        for (const ln of pc.lines) add(ln, false);
        if (pc.inner && fell(pc.ray, pc.ring - 1)) add(pc.inner, true);
        if (fell(pc.ray + 1, pc.ring)) add(pc.side, true);
        if (pc.ring > 0 && fell(pc.ray - 1, pc.ring)) add(pc.lines[0], true);
      }
      for (const [list, mat] of [[ink, crackInkMat], [glint, crackMat]]) {
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
        const rm = new THREE.Mesh(geo, mat); rm.layers.set(1); rm.renderOrder = 3; g.add(rm);
      }
    }
  }

  // Fallen pieces: thrown with physics when we saw it happen, lying on the ground if not.
  function spill(p, pieces, quiet, dir) {
    const { mesh } = p; mesh.updateMatrixWorld(true);
    const q = mesh.getWorldQuaternion(new THREE.Quaternion());
    const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // Glass mostly lands on the side it was hit from: the street, not the (painted-on) shop interior.
    const outward = nrm.clone().multiplyScalar(p.side);
    if (p.floor === undefined) p.floor = floorAt(mesh, outward);
    const r = rng(p.seed ^ (p.hits.length * 2654435761));
    pieces.sort((a, b) => a.dist - b.dist);
    let bodies = 0;
    const groundList = [];
    for (const pc of pieces) {
      const wp = mesh.localToWorld(new THREE.Vector3(pc.cx, pc.cy, 0));
      if (quiet || bodies >= MAX_BODIES_PER_HIT || pc.area > .5) {
        // Lies flat near the foot of the wall, mostly on the side it was hit from.
        if (groundList.length > 60) continue;
        const d = .25 + r() * 1.4;
        const gp = new THREE.Vector3(wp.x, 0, wp.z).addScaledVector(outward, d);
        gp.x += (r() - .5) * .6; gp.z += (r() - .5) * .6;
        gp.y = p.floor + .012 + groundList.length * .0006; // on the sidewalk, not under it
        const s = Math.min(1, (.05 + r() * .07) / Math.sqrt(pc.area)); // it breaks up again when it lands: small bits
        const poly = pc.poly.map(([x, y]) => [(x - pc.cx) * s, (y - pc.cy) * s]);
        const g = polyGeo(poly, 0, 0, 0, null);
        const m4 = new THREE.Matrix4().makeRotationX(-Math.PI / 2 + (r() - .5) * .3).premultiply(new THREE.Matrix4().makeRotationY(r() * 6.283)).setPosition(gp); // a little propped up, so the ink catches the edges
        const v = new THREE.Vector3();
        for (let k = 0; k < g.pos.length; k += 3) { v.set(g.pos[k], g.pos[k + 1], g.pos[k + 2]).applyMatrix4(m4); g.pos[k] = v.x; g.pos[k + 1] = v.y; g.pos[k + 2] = v.z; }
        const nn = new THREE.Vector3(0, 0, 1).transformDirection(m4); for (let k = 0; k < g.nrm.length; k += 3) { g.nrm[k] = nn.x; g.nrm[k + 1] = nn.y; g.nrm[k + 2] = nn.z; }
        groundList.push(g);
        continue;
      }
      bodies++;
      const g = polyGeo(pc.poly, pc.cx, pc.cy, 0, null);
      const m = buildMesh([g], flyMat); m.position.copy(wp); m.quaternion.copy(q); m.castShadow = true; scene.add(m);
      let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9; for (const [x, y] of pc.poly) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
      const b = new CANNON.Body({ mass: Math.max(.03, pc.area * 6), shape: new CANNON.Box(new CANNON.Vec3(Math.max(.02, (maxx - minx) * .35), Math.max(.02, (maxy - miny) * .35), .006)), linearDamping: .05, angularDamping: .2 });
      b.collisionFilterGroup = 4; b.collisionFilterMask = 1;
      b.position.set(wp.x, wp.y, wp.z); b.quaternion.set(q.x, q.y, q.z, q.w);
      // Close to the hit: punched through along the throw. Further out: mostly just drops.
      const kick = Math.max(.15, 1 - pc.dist / .8);
      const v = outward.clone().multiplyScalar(.3 + r() * 1.6 * kick).addScaledVector(dir, .3 * kick);
      b.velocity.set(v.x + (r() - .5) * .8, v.y + r() * .8 * kick, v.z + (r() - .5) * .8);
      b.angularVelocity.set((r() - .5) * 14 * kick + (r() - .5) * 2, (r() - .5) * 8 * kick, (r() - .5) * 14 * kick + (r() - .5) * 2);
      world.addBody(b);
      flying.push({ m, b, t: 0, pane: p });
      while (flying.length > MAX_FLYING) dropFlying(0);
    }
    if (groundList.length) { const gm = buildMesh(groundList, groundMat); gm.receiveShadow = true; scene.add(gm); p.ground.push(gm); }
  }

  function applyHit(p, k, quiet, dir) {
    const before = new Set(p.pieces.filter(pc => pc.out));
    decideFallen(p);
    const [hx, hy] = p.hits[k];
    const newly = p.pieces.filter(pc => pc.out && !before.has(pc));
    for (const pc of newly) pc.dist = Math.hypot(pc.cx - hx, pc.cy - hy);
    spill(p, newly, quiet, dir);
    rebuildStanding(p);
  }

  function shatter(mesh, { seed, hits, quiet = false, dir = null, hi = null }) {
    if (!mesh || !hits || !hits.length) return;
    let p = panes.get(mesh);
    if (p && (p.seed !== seed || p.boarded)) { restore(mesh); p = null; }
    if (!p) {
      const [w, h] = dims(mesh);
      const [u, v] = hits[0];
      const fr = fracture(w, h, u * w / 2 * .92, v * h / 2 * .92, seed);
      p = { mesh, seed, side: hits[0][2] || 1, size: [w, h], pieces: fr.pieces, holeJit: fr.rnd(), hits: [], ground: [], group: null, hi, boarded: false, boards: null };
      panes.set(mesh, p);
      mesh.visible = false; if (hi) hi.visible = false;
    }
    // Kick direction: through the glass, away from whoever threw it.
    const d = new THREE.Vector3(0, 0, -p.side).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
    for (let k = p.hits.length; k < hits.length; k++) {
      const [u, v] = hits[k], [w, h] = p.size;
      p.hits.push([u * w / 2 * .92, v * h / 2 * .92]);
      applyHit(p, k, quiet, d);
    }
  }

  function board(mesh) {
    const p = panes.get(mesh); if (!p || p.boarded) return;
    p.boarded = true; clearGroup(p);
    for (let i = flying.length - 1; i >= 0; i--) if (flying[i].pane === p) dropFlying(i); // swept up
    for (const o of p.ground) { scene.remove(o); o.geometry.dispose(); } p.ground.length = 0;
    const [w, h] = p.size, g = new THREE.Group(), r = rng(p.seed + 99);
    g.position.copy(mesh.position); g.quaternion.copy(mesh.quaternion); mesh.parent.add(g); p.group = g;
    // One sheet per 1.2 m, cut a bit rough, plus a couple of battens screwed across.
    const n = Math.max(1, Math.ceil(w / 1.25)), sw = w / n;
    for (let i = 0; i < n; i++) {
      const geo = new THREE.BoxGeometry(sw + .02, h + .08, .02);
      const uv = geo.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * sw * .8 + r(), uv.getY(k) * h * .8 + r());
      const sheet = new THREE.Mesh(geo, plyMat); sheet.position.set(-w / 2 + sw * (i + .5), (r() - .5) * .03, .1 + i * .002); sheet.rotation.z = (r() - .5) * .025;
      sheet.castShadow = sheet.receiveShadow = true; g.add(sheet);
    }
    const nb = h > 1.2 ? 2 : 1;
    for (let k = 0; k < nb; k++) {
      const y = nb === 1 ? 0 : (k ? -1 : 1) * h * .28, bt = new THREE.Mesh(new THREE.BoxGeometry(w + .18, .09, .035), battenMat);
      bt.position.set(0, y, .13); bt.rotation.z = (r() - .5) * .08; bt.castShadow = true; g.add(bt);
      for (const sx of [-1, 1]) { const nl = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, .01, 6), nailMat); nl.rotation.x = Math.PI / 2; nl.position.set(sx * (w / 2 + .03), y, .152); g.add(nl); }
    }
  }

  function restore(mesh) {
    const p = panes.get(mesh); if (!p) return;
    clearGroup(p); clearDebris(p);
    mesh.visible = true; if (p.hi) p.hi.visible = true;
    panes.delete(mesh);
  }

  function update(dt) {
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i]; if (!f.b) continue;
      f.t += dt;
      // Physics ground is y=0 under the sidewalk slab: stop shards on the slab instead.
      if (f.b.position.y < f.pane.floor + .012 && f.pane.floor > .02) { f.b.position.y = f.pane.floor + .012; f.b.velocity.set(0, 0, 0); f.b.angularVelocity.set(0, 0, 0); f.t = SETTLE_S + 1; }
      f.m.position.copy(f.b.position); f.m.quaternion.copy(f.b.quaternion);
      // Once it has landed, drop the physics body: the shard stays as a plain mesh.
      if (f.t > SETTLE_S || f.b.sleepState === 2 || f.b.position.y < -2) { world.removeBody(f.b); f.b = null; if (f.m.position.y < -2) dropFlying(i); }
    }
  }

  function state(mesh) { const p = panes.get(mesh); return p ? { seed: p.seed, hits: p.hits.length, boarded: p.boarded, standing: p.pieces.filter(pc => !pc.out).length, fallen: p.pieces.filter(pc => pc.out).length, floor: p.floor } : null; }
  // For the shader prewarm (tools/prewarm.js): [material, needs RGBA vertex colours].
  const materials = [[crackedMat, true], [flyMat], [groundMat], [crackMat], [crackInkMat], [plyMat], [battenMat], [nailMat]];
  return { shatter, board, restore, update, state, fracture, materials, get flying() { return flying.length; } };
})();
