// ===================== multiplayer client (GAME-77) =====================
// Runs inside the look-test module, so it reuses its scene, shader and asset builders.
// The server owns the world; this file draws it, predicts your own vagrant, and
// smoothly interpolates everyone and everything else.
const NET = (() => {
  const MAPP = fetch('/town.json').then(r => r.json());
  let MAP = null; MAPP.then(m => { MAP = m; });
  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const money = n => '$' + Math.round(n).toLocaleString('en-US');

  // The server has walls at the town edge; mirror them so prediction agrees.
  for (const [x, z, hx, hz] of [[-60.5, 0, .5, 70], [60.5, 0, .5, 70], [0, -60.5, 70, .5], [0, 60.5, 70, .5]]) staticBox(x, 5, z, hx, 10, hz);

  // ---------- entities ----------
  const ents = new Map();            // id -> { kind, type, obj, buf: [{t,p,q,f}], ... }
  const fixtures = new Map();        // fixture id -> desc
  let me = null, myPid = null, meta = null, ws = null, grabbing = null;
  const INTERP_MS = 110;
  let clockOffset = null;            // serverTime - performance.now()
  const serverNow = () => performance.now() + (clockOffset || 0);

  function shade(hex, l) { const c = new THREE.Color(hex); c.offsetHSL(0, 0, l); return c.getHex(); }
  const SKINS = [[0xFFD9B8, 0xE9AE88], [0xC98A5E, 0xA86F48], [0xFFE7D6, 0xF0C4A6], [0x8D5A3B, 0x6E432B], [0xE8B48A, 0xC98F66]];
  const BEARDS = [0x8B5A3C, 0x2E221A, 0xD9C6A8, 0x5A3A2A, 0xB04A2A];
  function hash(str) { let h = 7; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
  function vagrantLook(e) {
    const h = hash(e.pid || e.id), col = new THREE.Color(e.color || '#ff6e9e').getHex();
    const [skin, skinSh] = SKINS[h % SKINS.length];
    const hat = [0xFF5D8F, 0xF2C230, 0x3FA8E8, 0x26D3A0, 0x8F6BFF][(h >> 3) % 5];
    return { coat: col, coatSh: shade(col, -.12), hat, hatSh: shade(hat, -.12), pants: [0x4D6FC9, 0x5A4C80, 0x6A6E7E, 0x3E5A8A][(h >> 5) % 4],
      hoodie: [0x9AA3B8, 0x7A3E4E, 0xD8C9A8, 0x5E7A4A][(h >> 7) % 4], skin, skinSh, beard: BEARDS[(h >> 9) % BEARDS.length], scarf: (h >> 11) % 2 ? 0xE8343F : 0 };
  }
  // vagrant() builds a detailed NPC with its own static body; strip that for networked players.
  // It is built unbaked and split into six limbs so it can ragdoll (GAME-83).
  function buildVagrant(e) {
    const armRig = [], realBake = bake; bake = () => {};
    let p; try { p = vagrant({ x: 0, z: 0, ry: 0, ...vagrantLook(e), armRig }); } finally { bake = realBake; }
    p.arms = armRig;
    world.removeBody(p.bodyRef); people.splice(people.indexOf(p), 1); scene.remove(p.g);
    rig(p);
    p.g.position.set(0, -0.9, 0); p.g.rotation.set(0, 0, 0);
    return p;
  }

  // ---------- ragdolls (GAME-83) ----------
  // The server tumbles one capsule per knocked-down vagrant; each client runs a six-part
  // cannon ragdoll of the model, seeded with the same hit velocity and pulled softly
  // toward the server's capsule so everyone sees the body land in the same spot.
  // Model space (p.g): origin at the feet, facing +z, left side on -x. A model may come with
  // p.parts already split (six groups pivoting at their joints); otherwise rig() splits it.
  const JOINTS = { torso: [0, .9, 0], head: [0, 1.48, 0], armL: [-.24, 1.36, 0], armR: [.24, 1.36, 0], legL: [-.1, .9, 0], legR: [.1, .9, 0] };
  const RAGM = { torso: { m: 30 }, head: { m: 5, cone: .55 }, armL: { m: 4, cone: 1.6 }, armR: { m: 4, cone: 1.6 }, legL: { m: 9, cone: .9 }, legR: { m: 9, cone: .9 } };
  function partOf(c) {
    if (c.y > 1.47) return 'head';
    if (Math.abs(c.x) > .21 && c.y > .62) return c.x < 0 ? 'armL' : 'armR';
    if (c.y < .86) return c.x < 0 ? 'legL' : 'legR';
    return 'torso';
  }
  // Split the (unbaked, parentless) model: each mesh goes under the pivot of its limb, then
  // each limb is baked so a player still costs only a handful of draw calls.
  function rig(p) {
    const g = p.g; g.position.set(0, 0, 0); g.rotation.set(0, 0, 0); g.updateMatrixWorld(true);
    const box = new THREE.Box3(), c = new THREE.Vector3();
    if (!p.parts) {
      const parts = {}, arms = p.arms && p.arms.length === 2 ? p.arms : null;   // GAME-87 arm pivots (at the shoulders), left first
      for (const k in JOINTS) parts[k] = new THREE.Group();
      if (arms) { parts.armL = arms[0]; parts.armR = arms[1]; }
      for (const ch of [...g.children]) {
        if (arms && arms.includes(ch)) continue;
        box.setFromObject(ch); if (box.isEmpty()) continue; box.getCenter(c);
        let k = partOf(c); if (arms && k.startsWith('arm')) k = 'torso';
        ch.position.sub(new THREE.Vector3(...JOINTS[k])); parts[k].add(ch);
      }
      for (const k in parts) {   // bake each limb at the origin, then put it back at its joint
        const pv = parts[k], at = arms && k.startsWith('arm') ? pv.position.clone() : new THREE.Vector3(...JOINTS[k]);
        g.remove(pv); pv.position.set(0, 0, 0); pv.rotation.set(0, 0, 0); pv.updateMatrixWorld(true); bake(pv); pv.position.copy(at); g.add(pv);
      }
      p.parts = parts;
    }
    // Physics box per limb from its bounds; offset = box centre relative to the joint.
    g.updateMatrixWorld(true); p.rag = {};
    for (const k in RAGM) {
      const pv = p.parts[k]; if (!pv) continue;
      box.setFromObject(pv); const ctr = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      p.rag[k] = { pv, rest: pv.position.clone(), off: ctr.sub(pv.position), h: size.multiplyScalar(.42).max(new THREE.Vector3(.05, .05, .05)) };
    }
  }
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _m1 = new THREE.Matrix4();
  function startRagdoll(v, vel, spin) {
    if (v.rag && !v.rag.up) return;
    if (v.rag) endRagdollNow(v);
    const P = v.model.rag; v.obj.updateMatrixWorld(true);
    const bodies = {}, cons = [], torsoAt = P.torso.pv.localToWorld(P.torso.off.clone());
    const V = new THREE.Vector3(...vel), W = new THREE.Vector3(...spin);
    for (const k in P) {
      const d = P[k];
      const b = new CANNON.Body({ mass: RAGM[k].m, shape: new CANNON.Box(new CANNON.Vec3(d.h.x, d.h.y, d.h.z)), linearDamping: .05, angularDamping: .35 });
      b.collisionFilterGroup = 8; b.collisionFilterMask = 1;      // the town and cars, not each other or you
      d.pv.localToWorld(_v1.copy(d.off)); d.pv.getWorldQuaternion(_q1);
      b.position.copy(_v1); b.quaternion.copy(_q1);
      _v2.copy(W).cross(_v1.clone().sub(torsoAt)).add(V);         // rigid body velocity: v + w x r
      b.velocity.set(_v2.x, _v2.y, _v2.z); b.angularVelocity.set(W.x, W.y, W.z);
      world.addBody(b); bodies[k] = b;
    }
    for (const k in P) {
      if (k === 'torso' || !bodies.torso) continue;
      const jw = P[k].pv.getWorldPosition(new THREE.Vector3()), A = bodies.torso, B = bodies[k], J = new CANNON.Vec3(jw.x, jw.y, jw.z);
      const c = new CANNON.ConeTwistConstraint(A, B, { pivotA: A.pointToLocalFrame(J), pivotB: B.pointToLocalFrame(J),
        axisA: new CANNON.Vec3(0, 1, 0), axisB: new CANNON.Vec3(0, 1, 0), angle: RAGM[k].cone, twistAngle: .6 });
      c.collideConnected = false; world.addConstraint(c); cons.push(c);
    }
    v.rag = { bodies, cons, up: null };
  }
  function removeRagBodies(R) { if (!R || !R.bodies) return; for (const c of R.cons) world.removeConstraint(c); for (const k in R.bodies) world.removeBody(R.bodies[k]); R.bodies = null; }
  function endRagdollNow(v) {
    removeRagBodies(v.rag); v.rag = null;
    for (const k in v.model.rag) { const d = v.model.rag[k]; d.pv.position.copy(d.rest); d.pv.quaternion.identity(); }
  }
  // Getting up: freeze the pose and blend each limb back to standing over ~0.7 s.
  function getUpRagdoll(v) {
    const R = v.rag; if (!R || R.up) return;
    const from = {};
    for (const k in v.model.rag) { const pv = v.model.rag[k].pv; from[k] = { p: pv.getWorldPosition(new THREE.Vector3()), q: pv.getWorldQuaternion(new THREE.Quaternion()) }; }
    removeRagBodies(R); R.up = { t: 0, from };
  }
  // Pose the model from the ragdoll (call after the normal transform is set). Returns false once standing again.
  function poseRagdoll(v, dt, target) {
    const R = v.rag, P = v.model.rag, g = v.model.g;
    if (!R.up) {
      const tb = R.bodies.torso;
      if (target) {   // drift toward the server's body; limbs follow through the joints
        const k = 1 - Math.exp(-dt * 2.5);
        for (const b of Object.values(R.bodies)) { b.position.x += (target.x - tb.position.x) * k; b.position.z += (target.z - tb.position.z) * k; if (target.y > tb.position.y + .6) b.position.y += (target.y - tb.position.y) * k; }
      }
      v.obj.position.set(tb.position.x, tb.position.y, tb.position.z); v.obj.quaternion.identity();
      g.position.set(0, -0.9, 0); g.rotation.set(0, 0, 0); g.scale.set(1, 1, 1);
      v.obj.updateMatrixWorld(true);
      _m1.copy(g.matrixWorld).invert();
      for (const k in P) {   // pivot = body centre minus the rotated joint-to-centre offset
        const b = R.bodies[k], d = P[k];
        d.pv.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        d.pv.position.set(b.position.x, b.position.y, b.position.z).sub(_v1.copy(d.off).applyQuaternion(d.pv.quaternion)).applyMatrix4(_m1);
      }
      return true;
    }
    R.up.t += dt; const k = Math.min(1, R.up.t / .7), e = k * k * (3 - 2 * k);
    v.obj.updateMatrixWorld(true);
    _m1.copy(g.matrixWorld).invert(); g.getWorldQuaternion(_q1).invert();
    for (const key in P) {
      const d = P[key], f = R.up.from[key];
      _v1.copy(f.p).applyMatrix4(_m1); d.pv.position.copy(_v1).lerp(d.rest, e);
      d.pv.quaternion.copy(_q1).multiply(f.q).slerp(new THREE.Quaternion(), e);
    }
    if (k >= 1) { endRagdollNow(v); return false; }
    return true;
  }
  function nameTag(text) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 112; const g = cv.getContext('2d');
    g.font = '700 54px Fredoka, sans-serif'; const w = Math.min(500, g.measureText(text).width + 56);
    g.fillStyle = 'rgba(255,255,255,.94)'; g.beginPath(); g.roundRect((512 - w) / 2, 10, w, 92, 46); g.fill();
    g.fillStyle = '#2E2350'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 58);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true, fog: false }));
    s.scale.set(1.6, .35, 1); fxl(s); return s;
  }
  function zzzTag() {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const g = cv.getContext('2d');
    g.font = '700 80px Fredoka, sans-serif'; g.fillStyle = '#8F6BFF'; g.strokeStyle = '#fff'; g.lineWidth = 12; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.strokeText('Zzz', 128, 66); g.fillText('Zzz', 128, 66);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true, fog: false })); s.scale.set(.9, .45, 1); fxl(s); return s;
  }
  function buildCar(hex) {
    const before = city.children.length, nb = world.bodies.length;
    car(0, 0, 0, new THREE.Color(hex).getHex());
    const g = city.children[before]; city.remove(g);
    while (world.bodies.length > nb) world.removeBody(world.bodies[world.bodies.length - 1]);
    g.position.set(0, -0.7, 0); g.rotation.set(0, Math.PI / 2, 0);   // model is long along x, nose at -x
    const w = new THREE.Group(); w.add(g); return w;
  }
  function buildProp(e) {
    if (e.type !== 'crate' && e.type !== 'cone') return PROPS.build(e);   // GAME-87 movable props
    const n = dyn.length;
    if (e.type === 'crate') crate(0, 0, 0, e.s, e.hex); else cone(0, 0);
    const d = dyn.splice(n, 1)[0]; world.removeBody(d.b); d.m.position.set(0, 0, 0);
    return d.m;
  }
  function spawn(e) {
    if (ents.has(e.id)) despawn(e.id);
    if (e.kind === 'fixture') { fixtures.set(e.id, e); return; }
    if (e.id === me) { ents.set(e.id, { ...e, own: true, buf: [] }); return; }
    let obj, extra = {};
    if (e.kind === 'vagrant' || e.kind === 'sleeper') {
      obj = new THREE.Group(); const v = buildVagrant(e); obj.add(v.g);
      const tag = nameTag(e.name); tag.position.y = e.kind === 'sleeper' ? 0.9 : 1.25; obj.add(tag);
      extra = { model: v, tag, grabbing: e.grabbing || null, reach: 0, lunge: 0 };
      if (e.kind === 'sleeper') { const z = zzzTag(); z.position.y = 1.4; obj.add(z); extra.zz = z; }
    } else if (e.kind === 'traffic') {
      obj = buildCar(e.color);
      // Same hood + cabin boxes as the server (nose along +z, body origin 0.7 m up).
      const b = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC });
      b.addShape(new CANNON.Box(new CANNON.Vec3(.875, .385, 2.2)), new CANNON.Vec3(0, .545 - .7, 0));
      b.addShape(new CANNON.Box(new CANNON.Vec3(.8, .235, .9)), new CANNON.Vec3(0, 1.165 - .7, -.25));
      b.position.set(0, -50, 0); world.addBody(b); extra = { body: b };
    }
    else if (e.kind === 'prop') obj = buildProp(e);
    else if (e.kind === 'bottle') obj = bottleMesh();
    else return;
    scene.add(obj);
    ents.set(e.id, { ...e, obj, buf: [], ...extra });
  }
  function despawn(id) {
    const v = ents.get(id);
    if (v) { if (v.obj) scene.remove(v.obj); if (v.body) world.removeBody(v.body); if (v.rag) removeRagBodies(v.rag); }
    if (id === me && ownRag) { scene.remove(ownRag.obj); removeRagBodies(ownRag.rag); ownRag = null; }
    ents.delete(id); fixtures.delete(id);
  }

  // ---------- snapshots and interpolation ----------
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
  function onSnapshot(m) {
    const sample = m.ts - performance.now();
    // Track the smallest observed delay; drift slowly so a late packet doesn't jerk everything.
    if (clockOffset === null || sample > clockOffset) clockOffset = sample; else clockOffset += (sample - clockOffset) * 0.02;
    for (const r of m.b) {
      const v = ents.get(r[0]); if (!v) continue;
      v.buf.push({ t: m.ts, p: new THREE.Vector3(r[1], r[2], r[3]), q: new THREE.Quaternion(r[4], r[5], r[6], r[7]), f: r[8] });
      if (v.buf.length > 30) v.buf.shift();
    }
  }
  function sampleBuf(v, t) {
    const b = v.buf; if (!b.length) return null;
    if (t <= b[0].t) return b[0];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= t) {
        const a = b[i], c = b[i + 1];
        if (!c) return a;                                  // hold the last known state
        const k = (t - a.t) / (c.t - a.t);
        const out = { p: a.p.clone().lerp(c.p, k), q: _q.copy(a.q).slerp(c.q, k).clone() };
        if (a.f !== undefined && c.f !== undefined) { let d = c.f - a.f; d = Math.atan2(Math.sin(d), Math.cos(d)); out.f = a.f + d * k; }
        while (b.length > 2 && b[1].t < t - 500) b.shift();
        return out;
      }
    }
    return b[0];
  }

  // ---------- prediction for your own vagrant ----------
  let seq = 0, sendAcc = 0, lastIn = { x: 0, z: 0 };
  const hist = [];                   // [{seq, x, y, z}] in server space (capsule centre)
  const corr = new THREE.Vector3();  // correction still to blend in
  let haveAck = false;
  const errs = [];                   // recent prediction errors, for debugging
  function beforeStep(dt, mx, mz) {
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    lastIn.x = f.x * mz + r.x * mx; lastIn.z = f.z * mz + r.z * mx;
    if (!haveAck || ownRag) { player.velocity.x = player.velocity.z = 0; }   // stand still until the server places us, or while knocked down
  }
  function afterStep(dt) {
    // Blend in any correction over a few frames so it never reads as a snap.
    if (corr.lengthSq() > 1e-6) { const k = 1 - Math.exp(-dt * 8); player.position.x += corr.x * k; player.position.z += corr.z * k; corr.multiplyScalar(1 - k); }
    sendAcc += dt;
    if (ws && ws.readyState === 1 && me && haveAck && !ownRag && sendAcc >= 1 / 30) {
      const span = Math.min(sendAcc, 0.1); sendAcc = 0; seq = (seq + 1) >>> 0;
      ws.send(JSON.stringify({ t: 'in', seq, dt: +span.toFixed(4), x: +lastIn.x.toFixed(3), z: +lastIn.z.toFixed(3), yaw: +Math.atan2(-Math.sin(yaw), -Math.cos(yaw)).toFixed(3),
        jump: SET.down('jump'), run: SET.running() }));
      hist.push({ seq, x: player.position.x + corr.x, y: player.position.y + 0.55, z: player.position.z + corr.z });
      if (hist.length > 120) hist.shift();
    }
  }
  function onAck(m) {
    const [sx, sy, sz] = m.p;
    if (ownRag && !ownRag.rag.up) return;                       // knocked down: the server is moving us
    if (!haveAck) { haveAck = true; player.position.set(sx, Math.max(.35, sy - 0.55), sz); player.velocity.set(0, 0, 0); hist.length = 0; return; }
    while (hist.length && hist[0].seq < m.seq) hist.shift();
    const h = hist[0]; if (!h || h.seq !== m.seq) return;
    const ex = sx - h.x, ez = sz - h.z, ey = sy - h.y, err = Math.hypot(ex, ez);
    errs.push(+err.toFixed(3)); if (errs.length > 400) errs.shift();
    if (err > 3 || Math.abs(ey) > 1.5) {                         // way off (teleport, stuck): snap
      player.position.x += ex; player.position.z += ez; if (Math.abs(ey) > 1.5) player.position.y = Math.max(.35, sy - .55);
      corr.set(0, 0, 0); for (const k of hist) { k.x += ex; k.z += ez; }
    } else if (err > 0.1) {                                     // small drift: blend it in
      corr.x += ex; corr.z += ez; for (const k of hist) { k.x += ex; k.z += ez; }
    }
  }
  const speedScale = () => { const g = grabbing && ents.get(grabbing); return !g ? 1 : g.drag || (g.kind === 'sleeper' ? 60 / 70 : 1); };

  // ---------- fixtures and effects ----------
  let dumpFire = null;
  function paneFor(f) { return glassPanes[f.index]; }
  function breakPane(t, quiet) {
    if (!t || t.broken) return; t.broken = true;
    const gl = t.mesh, p = new THREE.Vector3(); gl.getWorldPosition(p);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(gl.getWorldQuaternion(new THREE.Quaternion()));
    gl.material = brokenGlassMat; gl.scale.x = Math.random() < .5 ? -1 : 1; if (t.hi) t.hi.visible = false;
    if (!quiet) shards(p, 22, shardMat, .28, n.multiplyScalar(2.5), gl.geometry.parameters);
  }
  function repairPane(t) { if (!t || !t.broken) return; t.broken = false; t.mesh.material = glassMat; t.mesh.scale.x = 1; if (t.hi) t.hi.visible = true; }
  function resetPile(p) {
    p.state = 'idle'; p.t = 0; p.acc = 0; if (p.e) { p.e.fire = 0; p.e.smoke = 0; }
    p.mats.forEach(({ m, c }) => m.color.copy(c)); p.scorch.material.opacity = 0; if (p.soot) p.soot.material.opacity = 0;
  }
  function splinters(at, s, hex, v) {
    const p = new THREE.Vector3(...at);
    for (let k = 0; k < 7; k++) {
      const len = s * (.5 + Math.random() * .5), wd = s * (.14 + Math.random() * .12);
      const pm = new THREE.Mesh(new THREE.BoxGeometry(len, s * .07, wd), k % 3 === 0 ? getMat(hex) : woodMat); pm.userData.ownGeo = true; if (k % 3 === 0) pm.userData.c = hex; pm.castShadow = pm.receiveShadow = true;
      pm.position.set(p.x + (Math.random() - .5) * s, p.y + (Math.random() - .5) * s, p.z + (Math.random() - .5) * s);
      const pb = new CANNON.Body({ mass: .25, shape: new CANNON.Box(new CANNON.Vec3(len / 2, s * .035, wd / 2)) }); pb.position.set(pm.position.x, pm.position.y, pm.position.z);
      pb.quaternion.setFromEuler(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      pb.velocity.set(v[0] * .3 + (Math.random() - .5) * 5, v[1] * .3 + 2 + Math.random() * 3, v[2] * .3 + (Math.random() - .5) * 5); pb.angularVelocity.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
      scene.add(pm); world.addBody(pb); addDebris(pm, pb);
    }
    dust(p, 8, 0xcbbfa8);
  }
  function popText(text, at, cls) {
    const v = new THREE.Vector3(...at).project(camera); if (v.z >= 1) return;
    const d = document.createElement('div'); d.className = 'pop ' + (cls || ''); d.textContent = text;
    d.style.left = ((v.x + 1) / 2 * innerWidth) + 'px'; d.style.top = ((1 - v.y) / 2 * innerHeight) + 'px';
    document.body.appendChild(d); setTimeout(() => d.remove(), 1150);
  }
  function feed(html) {
    const f = el('feed'), d = document.createElement('div'); d.innerHTML = html; f.prepend(d);
    setTimeout(() => d.remove(), 5000); while (f.children.length > 5) f.lastChild.remove();
  }
  let actx = null;
  function honkSound(long, at) {
    const d = camera.position.distanceTo(new THREE.Vector3(...at)); if (d > 40) return;
    try { actx ||= new AudioContext(); } catch { return; }
    const g = actx.createGain(); g.gain.value = .06 * (1 - d / 40) * SET.vol(); if (g.gain.value <= 0) return; g.connect(actx.destination);
    for (const fq of [392, 494]) { const o = actx.createOscillator(); o.type = 'square'; o.frequency.value = fq; o.connect(g); o.start(); o.stop(actx.currentTime + (long ? .9 : .28)); }
  }
  function onFx(m) {
    if (m.kind === 'damage') addDamage(m.cost, new THREE.Vector3(m.at[0], m.at[1] + 1.4, m.at[2]));
    else if (m.kind === 'smash') { const p = new THREE.Vector3(...m.at), v = new THREE.Vector3(...(m.v || [0, 0, 0])); shards(p, 8, bottleShardMat, .09, v.multiplyScalar(-.15)); if (p.y < .6) stain(p.x, p.z); dust(p, 3, 0xd8d2c4); }
    else if (m.kind === 'break') {
      const f = fixtures.get(m.id); if (!f) return;
      if (f.type === 'window') breakPane(paneFor(f));
      else shards(new THREE.Vector3(...m.at), 18, shardMat, .22, new THREE.Vector3(...m.v).multiplyScalar(-.1));
    }
    else if (m.kind === 'crate') splinters(m.at, m.s, m.hex, m.v || [0, 0, 0]);
    else if (m.kind === 'honk') {
      popText(m.rage ? 'THAT\'S IT!!' : m.long ? 'HOOONK!!' : 'HONK!', [m.at[0], 2.2, m.at[2]], 'honk'); honkSound(m.long, m.at);
      if (m.target === me) feed(m.rage ? 'The driver has had enough of you. <b>Move!</b>' : 'A car is honking at you. Get out of the street!');
    }
    else if (m.kind === 'say') { const v = ents.get(m.id); const at = v && v.obj ? [v.obj.position.x, v.obj.position.y + 1.3, v.obj.position.z] : (m.id === me ? null : null); if (at) popText(m.text, at, 'say'); else if (m.id === me) feed(esc(m.text)); }
    else if (m.kind === 'grab') {
      if (m.id === me) { grabbing = m.target; if (m.target) vmLunge = 1; feed(m.target ? 'Got it. Press grab again to let go.' : 'You let go.'); }
      const v = ents.get(m.id); if (v && v.model) { v.grabbing = m.target; if (m.target) v.lunge = 1; }
    }
    else if (m.kind === 'hit') onHit(m);
    else if (m.kind === 'up') onUp(m);
    else if (m.kind === 'hurt') {
      const v = ents.get(m.id), at = m.id === me ? null : v && v.obj ? [v.obj.position.x, v.obj.position.y + 1.1, v.obj.position.z] : m.at;
      if (at) popText(`+${money(m.cash)}`, at, 'cash');
      if (m.id === me) { feed(`Ouch. That's worth <b>+${money(m.cash)}</b>.`); popScreen(`+${money(m.cash)}`); }
    }
    else if (m.kind === 'turf') feed(`<b>${esc(m.by)}</b> now owns <b>${esc(m.zone)}</b>`);
  }
  // ---------- getting hit (GAME-83) ----------
  let ownRag = null;                 // { obj, model, rag, cam } while you are knocked down
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function thud(at, hard) {
    const d = camera.position.distanceTo(new THREE.Vector3(...at)); if (d > 45) return;
    try { actx ||= new AudioContext(); } catch { return; }
    const vol = .5 * (1 - d / 45) * SET.vol() * (hard ? 1 : .5); if (vol <= 0) return;
    const n = actx.sampleRate * .35, buf = actx.createBuffer(1, n, actx.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = actx.createBufferSource(); src.buffer = buf;
    const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const g = actx.createGain(); g.gain.value = vol; src.connect(lp); lp.connect(g); g.connect(actx.destination); src.start();
  }
  function flash() {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:5;pointer-events:none;background:radial-gradient(circle,rgba(255,255,255,.0) 30%,rgba(232,52,63,.55));opacity:1;transition:opacity .9s ease-out';
    document.body.appendChild(d); requestAnimationFrame(() => requestAnimationFrame(() => { d.style.opacity = 0; })); setTimeout(() => d.remove(), 1000);
  }
  function popScreen(text) {
    const d = document.createElement('div'); d.className = 'pop cash'; d.textContent = text;
    d.style.left = '50%'; d.style.top = '38%'; document.body.appendChild(d); setTimeout(() => d.remove(), 1150);
  }
  function onHit(m) {
    if (m.id === me) {
      const e = ents.get(me); if (!e) return;
      if (ownRag) { scene.remove(ownRag.obj); removeRagBodies(ownRag.rag); }
      // Your own body appears where you stood, facing where you looked, and goes flying.
      const obj = new THREE.Group(), model = buildVagrant(e); obj.add(model.g);
      obj.position.set(player.position.x, player.position.y + .55, player.position.z);
      obj.rotation.y = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
      scene.add(obj);
      const v = { obj, model };
      startRagdoll(v, m.v, m.spin);
      ownRag = { obj, model, rag: v.rag, v, t: 0, back: 0 };
      camPos.copy(camera.position); camLook.copy(obj.position);
      vm.visible = false; grabbing = null;
      flash(); thud(obj.position.toArray(), true);
      if (m.cause === 'car') feed('<b>WHAM.</b> You got hit by a car.');
      return;
    }
    const v = ents.get(m.id); if (!v || !v.model) return;
    startRagdoll(v, m.v, m.spin);
    thud(v.obj.position.toArray(), true);
    popText(m.cause === 'car' ? 'WHAM!' : 'OOF!', [v.obj.position.x, v.obj.position.y + 1.2, v.obj.position.z], 'honk');
  }
  function onUp(m) {
    if (m.id === me) {
      if (!ownRag) return;
      getUpRagdoll(ownRag.v); ownRag.rag = ownRag.v.rag;
      // Snap your predicted body to where the server stood you up.
      haveAck = false; hist.length = 0; corr.set(0, 0, 0);
      player.position.set(m.at[0], Math.max(.35, m.at[1] - .55), m.at[2]); player.velocity.set(0, 0, 0);
      return;
    }
    const v = ents.get(m.id); if (v && v.rag) getUpRagdoll(v);
  }
  // Third-person camera on your own ragdoll, mouse orbits it; eases back to your eyes as you get up.
  function knockedCamera(dt) {
    if (!ownRag) { vm.visible = true; return; }
    const R = ownRag.v.rag;
    const target = R && !R.up && R.bodies ? new THREE.Vector3(R.bodies.torso.position.x, R.bodies.torso.position.y, R.bodies.torso.position.z) : ownRag.obj.position.clone();
    const want = target.clone().add(new THREE.Vector3(Math.sin(yaw) * 3.4, 1.9, Math.cos(yaw) * 3.4));
    const k = 1 - Math.exp(-dt * 5);
    camPos.lerp(want, k); camLook.lerp(target, 1 - Math.exp(-dt * 10));
    const eye = camera.position.clone(), eyeQ = camera.quaternion.clone();
    camera.position.copy(camPos); camera.lookAt(camLook);
    if (R && R.up) {                                            // getting up: blend back into first person
      const e = Math.min(1, R.up.t / .7);
      camera.position.lerp(eye, e); camera.quaternion.slerp(eyeQ, e);
    }
    vm.visible = false;
  }
  function frameOwnRag(dt) {
    if (!ownRag) return;
    const v = ownRag.v;
    const s = sampleBuf(ents.get(me) || { buf: [] }, serverNow() - INTERP_MS);
    if (v.rag && v.rag.up) { v.obj.position.set(player.position.x, player.position.y + .55, player.position.z); v.obj.rotation.set(0, Math.atan2(-Math.sin(yaw), -Math.cos(yaw)), 0); }
    const still = v.rag ? poseRagdoll(v, dt, s && s.p) : false;
    if (!still) { scene.remove(v.obj); ownRag = null; vm.visible = true; }
  }
  // Standing on something (ground, a car hood, a roof) so you can jump again.
  function grounded() {
    for (const c of world.contacts) {
      if (c.bi === player && c.ni.y < -.5) return true;
      if (c.bj === player && c.ni.y > .5) return true;
    }
    return false;
  }

  function onMeta(m) {
    meta = m; damage = m.town;
    const mine = m.players.find(p => p.id === myPid);
    el('rows').innerHTML = m.players.map(p => `<div class="r ${p.asleep ? 'zz' : ''}"><i style="background:${p.color}"></i>${esc(p.name)}${p.asleep ? ' (asleep)' : ''}<em>${money(p.damage)}</em></div>`).join('')
      + (mine ? `<div class="r" style="margin-top:4px;color:var(--ink-soft)">Your cash<em>${money(mine.cash)}</em></div>` : '');
    for (const [id, v] of ents) if (v.kind === 'vagrant' && v.model && m.objects[id] && m.objects[id].down && !v.rag) startRagdoll(v, [0, 0, 0], [0, 0, 0]);
    for (const [id, f] of fixtures) {
      const st = m.objects[id] || {};
      if (f.type === 'window') { const t = paneFor(f); if (st.broken) breakPane(t, true); else repairPane(t); }
      else if (f.type === 'pile') { const p = piles[f.index]; if (!p) continue; if (st.fire && p.state === 'idle') lightPile(p); if (!st.fire && !st.burnt && p.state !== 'idle') resetPile(p); }
      else if (f.type === 'dumpster') {
        if (st.fire && !dumpFire) dumpFire = emitter(new THREE.Vector3(f.pos[0], 1.6, f.pos[2]), { radius: .9, fire: 1.2, smoke: 1.4 });
        if (!st.fire && dumpFire) { dumpFire.fire = 0; dumpFire.smoke = 0; if (dumpFire.light) dumpFire.light.intensity = 0; emitters.splice(emitters.indexOf(dumpFire), 1); dumpFire = null; }
      }
    }
  }

  // ---------- grab / push / drag animation (GAME-87) ----------
  // Other players: both arms swing up and forward to the thing they hold, with a quick
  // lunge as they grab it; the body leans into it and the arms pump while they haul it.
  function animateArms(v, dt, moving) {
    const want = v.grabbing ? 1 : 0;
    v.reach += (want - v.reach) * (1 - Math.exp(-dt * (want ? 10 : 6)));
    v.lunge = Math.max(0, v.lunge - dt * 3.5);
    const lunge = Math.sin(v.lunge * Math.PI) * .35;
    const haul = v.grabbing && moving ? Math.sin(v.walk * 1.0) * .12 : 0;
    const swing = !v.grabbing && moving ? Math.sin(v.walk) * .35 : 0;   // normal walk arm swing
    v.model.arms.forEach((pv, i) => {
      const side = i ? 1 : -1;
      pv.rotation.x = -(1.25 + lunge) * v.reach + (haul * side) + swing * side * (1 - v.reach);
      pv.rotation.z = side * .18 * v.reach;                            // hands come in toward the middle
    });
    v.model.g.rotation.x = (.16 + lunge * .3) * v.reach;                 // lean into it
  }
  // You (first person): the hand drops the bottle out of view, shoots forward to grab,
  // then holds a tight grip that strains and shakes a little while you drag.
  let vmGrab = 0, vmLunge = 0, vmT = 0;
  function vmPose(dt, moving) {
    vmGrab += ((grabbing ? 1 : 0) - vmGrab) * (1 - Math.exp(-dt * 9));
    vmLunge = Math.max(0, vmLunge - dt * 3.2); vmT += dt;
    const g = vmGrab, l = Math.sin(vmLunge * Math.PI);
    const strain = grabbing && moving ? 1 : grabbing ? .3 : 0;
    vm.position.x += -.06 * g + Math.sin(vmT * 31) * .003 * strain;
    vm.position.y += -.05 * g + Math.sin(vmT * 7) * .012 * strain;
    vm.position.z += -.16 * g - .12 * l;
    vm.rotation.x += .5 * g - .25 * l;
    vm.rotation.z = -.6 * g + Math.sin(vmT * 23) * .02 * strain;
    if (g > .25) heldBottle.visible = false;
  }

  // ---------- per-frame ----------
  const cur = new THREE.Vector3();
  function frame(dt, t) {
    const rt = serverNow() - INTERP_MS, showTags = SET.tags();
    for (const v of ents.values()) {
      if (!v.obj) continue;
      if (v.tag) v.tag.visible = showTags;
      const s = sampleBuf(v, rt); if (!s) continue;
      if (v.kind === 'vagrant') {
        cur.copy(v.obj.position); v.obj.position.copy(s.p);
        if (s.f !== undefined) v.obj.rotation.y = s.f;
        const moving = cur.distanceTo(s.p) > dt * .5;
        v.walk = (v.walk || 0) + (moving ? dt * 9 : 0);
        v.model.g.position.y = -0.9 + (moving ? Math.abs(Math.sin(v.walk)) * .05 : 0);
        v.model.g.rotation.z = moving ? Math.sin(v.walk) * .04 : 0;
        v.model.head.rotation.z = Math.sin(t * 1.3 + v.model.ph) * .08;
        animateArms(v, dt, moving);
      } else if (v.kind === 'sleeper') {
        v.obj.position.copy(s.p); v.model.g.quaternion.copy(s.q);   // lying ragdoll pose comes from the body
        v.zz.position.y = 1.0 + Math.sin(t * 2) * .12;
      } else {
        v.obj.position.copy(s.p); v.obj.quaternion.copy(s.q);
        if (v.body) {                                            // kinematic car collider follows the drawn car
          const b = v.body;
          if (dt > 0 && b.position.y > -10) b.velocity.set((s.p.x - b.position.x) / dt, 0, (s.p.z - b.position.z) / dt);
          b.position.set(s.p.x, s.p.y, s.p.z); b.quaternion.set(s.q.x, s.q.y, s.q.z, s.q.w);
        }
      }
      if (v.rag && v.model) poseRagdoll(v, dt, v.rag.up || v.rag.noPull ? null : s.p);
    }
    frameOwnRag(dt);
    // zone readout
    if (MAP) {
      const px = player.position.x, pz = player.position.z;
      const zn = MAP.zones.find(z => px >= z.x && px <= z.x + z.w && pz >= z.z && pz <= z.z + z.d);
      el('zoneName').textContent = zn ? zn.name : 'The Streets';
      const o = zn && meta && meta.owners[zn.id];
      el('zoneOwner').innerHTML = zn ? (o ? `turf of <b style="color:${o.color}">${esc(o.name)}</b>` : 'nobody owns this turf') : 'no turf here';
    }
  }

  // ---------- actions ----------
  // Props can carry an action too (the couch); they are wherever they were left.
  function* actionables() {
    yield* fixtures.values();
    for (const v of ents.values()) if (v.kind === 'prop' && v.obj) yield { id: v.id, type: v.type, pos: [v.obj.position.x, v.obj.position.y, v.obj.position.z] };
  }
  function nearestAction() {
    if (!MAP) return null; let best = null, bd = 9;
    for (const f of actionables()) {
      const a = MAP.actions[f.type]; if (!a || ['window', 'car', 'crate', 'cone'].includes(f.type)) continue;
      if (f.type === 'pile') { const p = piles[f.index]; if (p && p.state !== 'idle') continue; }
      const st = meta && meta.objects[f.id]; if (st && (st.fire || st.burnt)) continue;
      const d = (f.pos[0] - player.position.x) ** 2 + (f.pos[2] - player.position.z) ** 2; if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  // Anything loose within reach can be grabbed and dragged (same reach as the server).
  function nearestGrabbable() {
    let best = null, bd = 2.6 * 2.6;
    for (const v of ents.values()) {
      if ((v.kind !== 'prop' && v.kind !== 'sleeper') || !v.obj) continue;
      const d = (v.obj.position.x - player.position.x) ** 2 + (v.obj.position.z - player.position.z) ** 2; if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  const keyLabel = k => esc(k.startsWith('Key') ? k.slice(3) : k);
  let promptMode = null;
  function updatePrompt(btn) {
    const f = nearestAction(), g = !f && (grabbing ? ents.get(grabbing) : nearestGrabbable());
    promptMode = f ? 'act' : g ? 'grab' : null; btn.hidden = !promptMode;
    let html = '';
    if (f) html = `${esc(MAP.actions[f.type].verb)} <kbd>${keyLabel(__set.s.binds.act)}</kbd>`;
    else if (g) html = `${grabbing ? 'Let go of' : 'Grab'} the ${esc(g.kind === 'sleeper' ? g.name : g.label || g.type)} <kbd>${keyLabel(__set.s.binds.grab)}</kbd>`;
    if (html && btn.innerHTML !== html) btn.innerHTML = html;
  }
  const sendAct = () => { if (ws && ws.readyState === 1 && !ownRag) ws.send('{"t":"act"}'); };
  const sendGrab = () => { if (ws && ws.readyState === 1 && !ownRag) ws.send('{"t":"grab"}'); };
  const act = () => (promptMode === 'grab' ? sendGrab : sendAct)();   // the on-screen button does whatever it says
  let lastPointer = 'mouse';
  canvas.addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, true);
  function throwDir(dir) {
    if (ownRag) return;
    if (lastPointer === 'mouse' && document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
    if (document.pointerLockElement === canvas) camera.getWorldDirection(dir);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'throw', dir: { x: dir.x, y: dir.y, z: dir.z } }));
    handKick = 1;
  }
  addEventListener('mousemove', e => {
    if (document.pointerLockElement !== canvas) return;
    SET.lookMouse(e.movementX, e.movementY);
  });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.repeat) return;
    if (SET.isBind('act', e.code) || e.code === 'KeyF') sendAct();
    if (SET.isBind('grab', e.code)) sendGrab();
  });

  // ---------- connection ----------
  function connect(name) {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: (() => { try { return localStorage.getItem('tw_token'); } catch { return null; } })(), name }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 's') onSnapshot(m);
      else if (m.t === 'a') onAck(m);
      else if (m.t === 'm') onMeta(m);
      else if (m.t === 'fx') onFx(m);
      else if (m.t === 'spawn') spawn(m.e);
      else if (m.t === 'despawn') despawn(m.id);
      else if (m.t === 'welcome') {
        try { localStorage.setItem('tw_token', m.token); } catch {}
        for (const id of [...ents.keys(), ...fixtures.keys()]) despawn(id);
        me = m.you; myPid = m.you.slice(2); haveAck = false; hist.length = 0; corr.set(0, 0, 0);
        m.entities.forEach(spawn);
        el('status').style.display = 'none';
        feed(`Good morning, <b>${esc(m.name)}</b>. You stretch and get up.`);
      }
    };
    ws.onclose = ev => {
      el('status').textContent = ev.code === 4000 ? 'You logged in somewhere else.' : 'The town is napping. Reconnecting...';
      el('status').style.display = 'block';
      if (ev.code !== 4000) setTimeout(() => connect(name), 1500);
    };
  }
  let token = null; try { token = localStorage.getItem('tw_token'); } catch {}
  if (token) connect();
  else {
    el('login').style.display = 'grid';
    const go = () => { el('login').style.display = 'none'; connect(el('nameInput').value.trim() || 'Vagrant'); };
    el('go').onclick = go; el('nameInput').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') go(); };
    el('login').addEventListener('pointerdown', e => e.stopPropagation());
    setTimeout(() => el('nameInput').focus(), 50);
  }
  window.__net = { get me() { return me; }, ents, fixtures, get corr() { return corr.length(); }, get pos() { return player.position; }, errs, get down() { return !!ownRag; },
    // Debug: ragdoll someone locally without the server (vel/spin as in fx 'hit').
    ragdoll(id, vel = [6, 4, 0], spin = [0, 0, -8]) { const v = ents.get(id); if (v && v.model) { startRagdoll(v, vel, spin); v.rag.noPull = true; } },
    getUp(id) { const v = ents.get(id); if (v && v.rag) getUpRagdoll(v); } };
  // Read-only view of the networked world for the mini map (GAME-80).
  const view = { ents, fixtures, get meta() { return meta; }, get myPid() { return myPid; }, get me() { return me; }, get map() { return MAP; } };
  return { beforeStep, afterStep, frame, speedScale, updatePrompt, act, throwDir, vmPose, view, grounded, knockedCamera };
})();
