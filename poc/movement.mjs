// Player movement (GAME-99): one movement model shared by the server and the client.
// The server runs it to own where every vagrant is; the client runs the exact same code,
// on the same physics engine (Rapier) and the same static world, to predict your own
// vagrant, so a correction is rare and tiny instead of a constant tug.
//
// How it works (the usual recipe for a server-authoritative first-person game):
//   - Fixed tick: the client samples input once per 1/60 s tick and steps movement for
//     exactly TICK; every tick becomes a numbered command the server replays for TICK too.
//   - Momentum: you accelerate up to speed and slow to a stop with ground friction instead of
//     switching velocity instantly; in the air you keep your momentum and steer a little.
//   - Kinematic capsule: Rapier's character controller slides along walls, steps up curbs,
//     climbs slopes up to MAX_SLOPE and snaps down onto the ground so you don't hop off crests.
//   - Forgiving jumps: coyote time (jump just after walking off an edge) and a jump buffer
//     (press just before landing). A held key does not bunny-hop; each press is one jump.
//   - Reconciliation: the server acks the last command with its full movement state; the
//     client rewinds to it, replays the commands still in flight and eases any difference out.
// The client inlines this file (build-client.py strips the `export`).
export const MOVE = (() => {
  const C = {
    TICK: 1 / 60,
    WALK: 4.6, RUN: 8,
    GROUND_ACCEL: 55,     // m/s² toward the speed you want: walking pace in ~0.1 s, a full run in ~0.15 s
    GROUND_FRICTION: 9,   // 1/s, Quake-style: stops from a run in ~0.25 s once you let go
    STOP_SPEED: 2.2,      // friction acts as if you were going at least this fast, so the last bit of slide dies quickly
    AIR_ACCEL: 12,        // m/s² of steering while airborne
    JUMP: 6.5, GRAVITY: -18, MAX_FALL: -40,
    COYOTE: 0.1, JUMP_BUFFER: 0.12,
    CAP_HALF: 0.55, CAP_R: 0.35, SKIN: 0.05,   // capsule centre sits 0.9 m (+ skin) above the feet
    STEP: 0.45, STEP_MIN_W: 0.2, SNAP: 0.4,
    MAX_SLOPE: 50 * Math.PI / 180, SLIDE_SLOPE: 55 * Math.PI / 180,
  };

  function makeController(world) {
    const c = world.createCharacterController(C.SKIN);
    c.enableAutostep(C.STEP, C.STEP_MIN_W, true);
    c.enableSnapToGround(C.SNAP);
    c.setMaxSlopeClimbAngle(C.MAX_SLOPE);
    c.setMinSlopeSlideAngle(C.SLIDE_SLOPE);
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(false);
    return c;
  }

  // Fresh movement state. Lives on the server entity and in the client's predictor.
  const state = () => ({ vx: 0, vy: 0, vz: 0, g: 1, air: 0, jb: 0, jh: 0 });
  const copyState = (to, from) => { to.vx = from.vx; to.vy = from.vy; to.vz = from.vz; to.g = from.g; to.air = from.air; to.jb = from.jb; to.jh = from.jh; return to; };
  const packState = (s) => [+s.vx.toFixed(5), +s.vy.toFixed(5), +s.vz.toFixed(5), s.g ? 1 : 0, +s.air.toFixed(4), +s.jb.toFixed(4), s.jh ? 1 : 0];
  const unpackState = (a, s = state()) => { [s.vx, s.vy, s.vz, s.g, s.air, s.jb, s.jh] = a; return s; };

  // One tick of movement.
  //   st:  movement state (mutated)
  //   inp: { x, z } world-space wish direction (length <= 1), run, jump (key held),
  //        scale (speed multiplier: dragging something heavy, staggered; 0 = can't move),
  //        noJump (knocked out), push { x, z } extra velocity (hydrant jet), kick { x, z } displacement this tick (knockback)
  //   move(desired) -> { x, y, z, grounded }: the character controller's corrected displacement
  // Returns the displacement to apply this tick.
  function step(st, inp, dt, move) {
    let wx = inp.x || 0, wz = inp.z || 0;
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    const top = (inp.run ? C.RUN : C.WALK) * (inp.scale ?? 1);
    const wantX = wx * top, wantZ = wz * top, want = Math.hypot(wantX, wantZ);
    if (st.g) {
      // Friction first (so letting go glides to a stop), then accelerate toward what you want.
      const sp = Math.hypot(st.vx, st.vz);
      if (sp > 1e-4) {
        const drop = Math.max(sp, C.STOP_SPEED) * C.GROUND_FRICTION * dt * (want > 0.01 ? 0.25 : 1);
        const k = Math.max(0, sp - drop) / sp; st.vx *= k; st.vz *= k;
      }
      const dx = wantX - st.vx, dz = wantZ - st.vz, dl = Math.hypot(dx, dz), a = C.GROUND_ACCEL * dt;
      if (dl > 1e-5) { const f = Math.min(1, a / dl); st.vx += dx * f; st.vz += dz * f; }
    } else if (want > 0.01) {
      // Air steering: nudge toward the wish, but never speed past what you'd reach on the ground.
      const dx = wantX - st.vx, dz = wantZ - st.vz, dl = Math.hypot(dx, dz), a = C.AIR_ACCEL * dt;
      if (dl > 1e-5) {
        const before = Math.hypot(st.vx, st.vz), f = Math.min(1, a / dl);
        st.vx += dx * f; st.vz += dz * f;
        const after = Math.hypot(st.vx, st.vz), cap = Math.max(before, top);
        if (after > cap) { st.vx *= cap / after; st.vz *= cap / after; }
      }
    }
    // Jumping: a press is remembered for JUMP_BUFFER, and works up to COYOTE after leaving the ground.
    const held = inp.jump ? 1 : 0;
    if (held && !st.jh) st.jb = C.JUMP_BUFFER;
    st.jh = held;
    let jumped = false;
    if (st.jb > 0 && (st.g || st.air < C.COYOTE) && !inp.noJump) { st.vy = C.JUMP; st.jb = 0; st.g = 0; st.air = C.COYOTE; jumped = true; }
    st.jb = Math.max(0, st.jb - dt);
    if (!st.g || jumped) st.vy = Math.max(C.MAX_FALL, st.vy + C.GRAVITY * dt);
    else st.vy = 0;                                    // grounded: snap-to-ground keeps you on slopes; pushing into the floor makes the controller stall
    const px = (inp.push && inp.push.x) || 0, pz = (inp.push && inp.push.z) || 0;
    const kx = (inp.kick && inp.kick.x) || 0, kz = (inp.kick && inp.kick.z) || 0;
    const desired = { x: (st.vx + px) * dt + kx, y: st.vy * dt, z: (st.vz + pz) * dt + kz };
    const mv = move(desired);
    // Ran into something: lose the speed the wall ate, so you don't keep pressing into it.
    const wantH = Math.hypot(desired.x - kx, desired.z - kz);
    if (wantH > 1e-5) {
      const gotX = mv.x - kx, gotZ = mv.z - kz;
      const along = (gotX * (desired.x - kx) + gotZ * (desired.z - kz)) / (wantH * wantH);
      if (along < 0.999) {
        const ax = gotX / dt - px, az = gotZ / dt - pz;
        if (Math.hypot(ax, az) < Math.hypot(st.vx, st.vz)) { st.vx = ax; st.vz = az; }
      }
    }
    if (mv.grounded && !jumped) { st.g = 1; st.air = 0; if (st.vy < 0) st.vy = 0; }
    else {
      st.g = 0; st.air += dt;
      if (st.vy > 0 && desired.y > 1e-4 && mv.y < desired.y * 0.5) st.vy = 0;   // bumped your head
    }
    return mv;
  }

  // Wraps a Rapier character controller as step()'s move() for one collider.
  function mover(controller, collider, flags, groups, predicate) {
    return (desired) => {
      controller.computeColliderMovement(collider, desired, flags, groups, predicate);
      const m = controller.computedMovement();
      return { x: m.x, y: m.y, z: m.z, grounded: controller.computedGrounded() };
    };
  }

  // The static world players collide with, identical on server and client: the ground slab,
  // the hills heightfield (GAME-96), the town-edge walls, every town.json collider (parked
  // cars as hood + cabin), the extra hydrants and the window panes.
  // on(kind, info) is called for each fixture so the server can make it an entity.
  const CAR_HOOD_TOP = 0.93, CAR_ROOF = 1.4, CAR_CABIN_Z = -0.25;
  function carColliders(RAPIER, world, body, bodyY, cabinZ = CAR_CABIN_Z) {
    const lower = RAPIER.ColliderDesc.cuboid(0.875, CAR_HOOD_TOP / 2 - 0.08, 2.2).setTranslation(0, CAR_HOOD_TOP / 2 + 0.08 - bodyY, 0).setFriction(0.8);
    const cabin = RAPIER.ColliderDesc.cuboid(0.8, (CAR_ROOF - CAR_HOOD_TOP) / 2, 0.9).setTranslation(0, (CAR_ROOF + CAR_HOOD_TOP) / 2 - bodyY, cabinZ).setFriction(0.8);
    return [world.createCollider(lower, body), world.createCollider(cabin, body)];
  }
  function buildStatic(RAPIER, world, MAP, TERRAIN, on = () => {}) {
    const fixed = (x, y, z, hx, hy, hz) => {
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
      return world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.8), b);
    };
    const { minX, maxX, minZ, maxZ } = MAP.bounds;
    // Flat ground slab, except under the hills heightfield: there it sits 0.25 m lower as a safety
    // net, because a slab flush with the heightfield's flat parts gives the character controller two
    // coplanar floors, which made it hitch on their seams (and hitch differently on server and client).
    { const A = TERRAIN.AREA, x0 = minX - 2, x1 = maxX + 2, z0 = minZ - 2, z1 = maxZ + 2, zs = Math.max(z0, Math.min(z1, A.minZ));
      if (zs > z0) fixed((x0 + x1) / 2, -0.5, (z0 + zs) / 2, (x1 - x0) / 2, 0.5, (zs - z0) / 2);
      if (z1 > zs) fixed((x0 + x1) / 2, -0.75, (zs + z1) / 2, (x1 - x0) / 2, 0.5, (z1 - zs) / 2); }
    { const A = TERRAIN.AREA, nc = A.maxX - A.minX, nr = A.maxZ - A.minZ, hs = new Float32Array((nr + 1) * (nc + 1));
      for (let i = 0; i <= nr; i++) for (let j = 0; j <= nc; j++) hs[i + j * (nr + 1)] = TERRAIN.h(A.minX + j, A.minZ + i);   // rows run along z, columns along x
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation((A.minX + A.maxX) / 2, 0, (A.minZ + A.maxZ) / 2));
      world.createCollider(RAPIER.ColliderDesc.heightfield(nr, nc, hs, { x: nc, y: 1, z: nr }).setFriction(0.8), b); }
    { const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, hx = (maxX - minX) / 2 + 1, hz = (maxZ - minZ) / 2 + 1;
      fixed(minX - 0.5, 5, cz, 0.5, 10, hz); fixed(maxX + 0.5, 5, cz, 0.5, 10, hz);
      fixed(cx, 5, minZ - 0.5, hx, 10, 0.5); fixed(cx, 5, maxZ + 0.5, hx, 10, 0.5); }
    const colliderFor = (c) => {
      const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(c.p[0], c.p[1], c.p[2]);
      if (c.q) desc.setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] });
      const b = world.createRigidBody(desc);
      const shape = c.box ? RAPIER.ColliderDesc.cuboid(c.box[0], c.box[1], c.box[2]) : RAPIER.ColliderDesc.cylinder(c.cyl[1] / 2, c.cyl[0]);
      return world.createCollider(shape.setFriction(0.8), b);
    };
    for (const c of MAP.colliders) {
      if (c.loose || c.tag === 'npc') continue;   // movable props and the street NPCs are entities, not static
      if (c.tag === 'car') {
        // Parked cars: same hood + cabin shape as traffic. c.ry is the look-test model's yaw; the car shape's nose points along +z.
        const yaw = c.ry !== undefined ? c.ry - Math.PI / 2 : (c.box[0] > c.box[2] ? Math.PI / 2 : 0);
        const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.p[0], TERRAIN.h(c.p[0], c.p[2]), c.p[2]).setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }));
        const [collider, ...extraColliders] = carColliders(RAPIER, world, b, 0, c.ry !== undefined ? CAR_CABIN_Z : 0);
        on('collider', { c, collider, extraColliders, carBody: b });
      } else on('collider', { c, collider: colliderFor(c) });
    }
    (MAP.hydrants || []).forEach((h, i) => {
      const p = [h.p[0], TERRAIN.h(h.p[0], h.p[1]) + 0.35, h.p[1]];
      on('hydrant', { h, i, p, collider: colliderFor({ p, cyl: [0.17, 0.7] }) });
    });
    for (const w of MAP.windows || []) on('window', { w, collider: colliderFor({ p: w.p, q: w.q, box: w.half }) });
  }

  return { C, makeController, state, copyState, packState, unpackState, step, mover, buildStatic, carColliders, CAR_HOOD_TOP, CAR_ROOF, CAR_CABIN_Z };
})();
