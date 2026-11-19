// ===================== player animation helper (GAME-92) =====================
// One place for every player animation, in first person (your glove hand and camera) and
// in third person (the vagrant model other players see).
//
// Add an interaction animation:
//   ANIM.define('name', { dur: 1.2, loop: false, cancelOnMove: false,
//     fp: (k, t, m) => ({ x, y, z, rx, ry, rz, camY, camPitch, hideHeld }),  // first person, offsets
//     tp: (k, t, m) => ({ y, fwd, lean, tilt, armR: [x,y,z], armL, legR, legL, head: [x,y,z], hideHeld }) });
//   k is 0..1 through the clip, t is seconds, m is the message the clip was played with.
//   Every number is an offset from rest and is faded in and out for you.
// Play it:
//   client, your own hand:    ANIM.play('name')          (instant, before the server answers)
//   server, everyone else:    playAnim(entity, 'name')   (server.mjs; sends an 'anim' fx)
// Clips never create lights or materials, so they never cause shader compiles mid-game.
//
// The vagrant model is posed through p.parts = { torso, head, armL, armR, legL, legR }: each a
// Group child of p.g, pivot at its joint, rest rotation identity, origin at the feet facing +z.
// Arm rotation x < 0 swings an arm forward/up; leg rotation x < 0 swings a leg forward.
// In clips, armR / legR mean the character's right side (-x, the hand that holds things),
// whichever part carries that name. The held item is v.heldObj (GAME-82), on that arm.
const ANIM = (() => {
  const clips = {};
  const clamp01 = k => k < 0 ? 0 : k > 1 ? 1 : k;
  const ease = k => { k = clamp01(k); return k * k * (3 - 2 * k); };
  // keys([[0,0],[.3,1],[1,0]])(k): smooth curve through (k, value) points.
  const keys = pts => k => {
    if (k <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (k <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * ease((k - a) / (b - a)); }
    return pts[pts.length - 1][1];
  };
  function define(name, c) { clips[name] = { dur: 1, fadeIn: .15, fadeOut: .22, maxLoop: 30, ...c }; }
  function weight(c, s) {
    if (s.out !== undefined) return s.outFrom * (1 - ease(s.out / c.fadeOut));
    const w = ease(s.t / c.fadeIn);
    return c.loop ? w : Math.min(w, ease((c.dur - s.t) / c.fadeOut));
  }
  // Advance one actor's clip state. Returns { c, k, w, s } or null.
  function step(s, dt, moving) {
    if (!s || !s.name) return null;
    const c = clips[s.name]; if (!c) { s.name = null; return null; }
    s.t += dt;
    if (s.out === undefined && ((c.cancelOnMove && moving && s.t > .35) || (c.loop && s.t > c.maxLoop))) { s.outFrom = weight(c, s); s.out = 0; }
    if (s.out !== undefined) { s.out += dt; if (s.out >= c.fadeOut) { s.name = null; return null; } }
    else if (!c.loop && s.t >= c.dur) { s.name = null; return null; }
    const k = c.loop ? (s.t % c.dur) / c.dur : clamp01(s.t / c.dur);
    return { c, k, w: weight(c, s), s };
  }
  const start = (s, name, m) => { s.name = name; s.t = 0; s.out = undefined; s.m = m || {}; s.at = performance.now(); };

  // ---------- first person ----------
  const fpS = {};
  const fpOut = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, camY: 0, camPitch: 0, hideHeld: false, w: 0 };
  function play(name, m) { if (clips[name]) start(fpS, name, m); }
  // The server echoes your own clips back; skip the echo if we already predicted it.
  function echo(name, m) { if ((m && m.tpOnly) || (fpS.name === name && performance.now() - fpS.at < 1500)) return; play(name, m); }
  function fpTick(dt, moving) {
    for (const k in fpOut) fpOut[k] = k === 'hideHeld' ? false : 0;
    const r = step(fpS, dt, moving); if (!r || !r.c.fp) return fpOut;
    const p = r.c.fp(r.k, r.s.t, r.s.m) || {}; fpOut.w = r.w;
    for (const k in p) { if (k === 'w') continue; if (k === 'hideHeld') fpOut.hideHeld = !!p[k] && r.w > .3; else fpOut[k] = p[k] * r.w; }
    return fpOut;
  }
  // Applied right after the look test poses the viewmodel each frame.
  function applyFP(vm, held, dt, moving) {
    const o = fpTick(dt, moving);
    vm.position.x += o.x; vm.position.y += o.y; vm.position.z += o.z;
    vm.rotation.x += o.rx; vm.rotation.y += o.ry; vm.rotation.z += o.rz;
    if (o.hideHeld) held.visible = false;
    // Empty hands sit lowered out of view (GAME-82); bring the glove up while a clip plays.
    if (o.w > .02) { if (typeof NET !== 'undefined' && NET.handDrop) vm.position.y += NET.handDrop() * o.w; handG.visible = true; }
  }
  const camY = () => fpOut.camY, camPitch = () => fpOut.camPitch;

  // ---------- third person ----------
  const ZERO = [0, 0, 0];
  function setRot(o, base, add, w) { o.rotation.set(base[0] + (add ? add[0] * w : 0), base[1] + (add ? add[1] * w : 0), base[2] + (add ? add[2] * w : 0)); }
  // Play a clip on another player's vagrant (v = the entity record in NET).
  function playOn(v, name, m) { if (v && clips[name]) start(v.anim || (v.anim = {}), name, m); }
  // Pose a networked vagrant: walk cycle from its speed, then any clip on top.
  // speed is metres per second along the ground.
  function poseVagrant(v, dt, speed, t) {
    const P = v.model && v.model.parts; if (!P) return;
    const g = v.model.g, moving = speed > .4;
    const run = clamp01((speed - 4.6) / 3.4);
    v.stride = (v.stride || 0) * Math.exp(-dt * 10) + (moving ? 1 : 0) * (1 - Math.exp(-dt * 10));   // eases walk in/out
    v.walk = (v.walk || 0) + dt * (moving ? 4.2 + speed * 1.1 : 0);
    const st = v.stride, sw = Math.sin(v.walk), amp = (.5 + run * .35) * st;
    const arm = [-.3 + sw * amp * .6, 0, .05], armL = [-sw * amp * .9, 0, 0];
    const legR = [-sw * amp, 0, 0], legL = [sw * amp, 0, 0];
    let y = Math.abs(Math.cos(v.walk)) * .05 * st, lean = run * .12 * st, tilt = Math.sin(v.walk) * .025 * st;
    // Grab layer (GAME-87): both arms swing up to what they hold, with a lunge as they grab it;
    // the body leans in and the arms pump while they haul it.
    const want = v.grabbing ? 1 : 0;
    v.reach = (v.reach || 0) + (want - (v.reach || 0)) * (1 - Math.exp(-dt * (want ? 10 : 6)));
    v.lunge = Math.max(0, (v.lunge || 0) - dt * 3.5);
    const re = v.reach;
    if (re > .001) {
      const lunge = Math.sin(v.lunge * Math.PI) * .35, haul = v.grabbing && moving ? Math.sin(v.walk) * .12 : 0;
      arm[0] = arm[0] * (1 - re) - (1.25 + lunge) * re - haul; arm[2] = arm[2] * (1 - re) - .18 * re;
      armL[0] = armL[0] * (1 - re) - (1.25 + lunge) * re + haul; armL[2] = armL[2] * (1 - re) + .18 * re;
      lean += (.16 + lunge * .3) * re;
    }
    const r = step(v.anim, dt, moving);
    let hide = false, pose = null, w = 0;
    if (r && r.c.tp) { pose = r.c.tp(r.k, r.s.t, r.s.m, v) || {}; w = r.w; hide = !!pose.hideHeld && w > .3; }
    const blend = (base, key) => { const a = pose && pose[key]; return a ? base.map((b, i) => b * (1 - w) + a[i] * w) : base; };
    g.position.set(0, -0.9 + y + (pose ? (pose.y || 0) * w : 0), pose ? (pose.fwd || 0) * w : 0);
    g.rotation.set(lean + (pose ? (pose.lean || 0) * w : 0), pose ? (pose.turn || 0) * w : 0, tilt + (pose ? (pose.tilt || 0) * w : 0));
    // Clips name limbs by the character's side: right = -x (the hand that holds things).
    const rx = P.armR.position.x < 0, R = rx ? P.armR : P.armL, L = rx ? P.armL : P.armR;
    const lx = P.legR.position.x < 0, RL = lx ? P.legR : P.legL, LL = lx ? P.legL : P.legR;
    setRot(R, blend(arm, 'armR'), null, 0); setRot(L, blend(armL, 'armL'), null, 0);
    setRot(RL, blend(legR, 'legR'), null, 0); setRot(LL, blend(legL, 'legL'), null, 0);
    setRot(P.torso, ZERO, pose && pose.torso, w);
    P.head.rotation.set(pose && pose.head ? pose.head[0] * w : 0, pose && pose.head ? pose.head[1] * w : 0, Math.sin(t * 1.3 + v.model.ph) * .08 + (pose && pose.head ? pose.head[2] * w : 0));
    if (pose && pose.world && w > 0) {   // slide toward a spot, e.g. onto the couch
      const [wx, wz, face] = pose.world, o = v.obj;
      const dx = wx - o.position.x, dz = wz - o.position.z, c = Math.cos(-o.rotation.y), s = Math.sin(-o.rotation.y);
      g.position.x += (dx * c + dz * s) * w; g.position.z += (-dx * s + dz * c) * w;
      if (face !== undefined) { let d = face - o.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * w; }
    }
    if (v.heldObj) v.heldObj.visible = !hide;
  }

  const api = { define, keys, ease, play, echo, applyFP, camY, camPitch, playOn, poseVagrant, clips, get fp() { return fpS; } };
  window.__anim = api;   // for captures, tests and the console
  return api;
})();

// ---------- clips for today's interactions ----------
// Light the trash pile: crouch, cup the hand down at the pile, two flicks of a lighter.
ANIM.define('light', { dur: 1.5,
  fp: k => { const flick = Math.max(0, Math.sin((k - .35) * Math.PI * 7)) * (k > .35 && k < .8 ? 1 : 0);
    return { camY: -.5, camPitch: -.3, x: -.1, y: .02, z: -.04, rx: -.6 - flick * .15, rz: flick * .2, hideHeld: true }; },
  tp: k => { const flick = Math.max(0, Math.sin((k - .35) * Math.PI * 7)) * (k > .35 && k < .8 ? 1 : 0);
    return { y: -.12, lean: .22, armR: [-.95 - flick * .2, 0, .15], armL: [-.35, 0, -.15], legR: [-.5, 0, 0], legL: [.35, 0, 0], head: [.45, 0, 0], hideHeld: true }; } });
// Set the dumpster on fire: wind up and lob a lit match over the lip.
ANIM.define('toss', { dur: 1.1,
  fp: k => { const wind = ANIM.keys([[0, 0], [.3, 1], [.5, -.6], [1, 0]])(k);
    return { x: -.06, y: .05 * Math.abs(wind), z: wind * .05, rx: wind * .9, camPitch: -wind * .05, hideHeld: k > .2 && k < .9 }; },
  tp: k => { const wind = ANIM.keys([[0, 0], [.3, 1], [.5, -.6], [1, 0]])(k);
    return { armR: [-1.2 - wind * 1.2, 0, .1], lean: -wind * .15, turn: wind * .25, head: [.1, 0, 0], hideHeld: k > .2 && k < .9 }; } });
// Panhandle at the stop sign: hold out a cupped hand, give it a hopeful little shake.
ANIM.define('panhandle', { dur: 1.8,
  fp: (k, t) => { const shake = Math.sin(t * 22) * (k > .3 && k < .75 ? 1 : 0);
    return { x: -.1, y: .05, z: -.06, rx: .3 + shake * .05, rz: -.4 + shake * .06, hideHeld: true }; },
  tp: (k, t) => { const shake = Math.sin(t * 22) * (k > .3 && k < .75 ? 1 : 0);
    return { armR: [-1.35 + shake * .08, 0, .05], lean: .12, head: [.15, 0, .12], hideHeld: true }; } });
// Warm your hands at the fire can: lean in, rub, palms out. Stops when you walk off.
ANIM.define('warm', { dur: 1.2, loop: true, cancelOnMove: true, maxLoop: 6,
  fp: (k, t) => ({ x: -.12 + Math.cos(t * 9) * .012, y: .03 + Math.sin(t * 9) * .01, z: -.02, rx: -.3, rz: .25 + Math.sin(t * 9) * .08, camPitch: -.15, hideHeld: true }),
  tp: (k, t) => ({ armR: [-1.1 + Math.sin(t * 9) * .08, 0, -.3], armL: [-1.1 - Math.sin(t * 9) * .08, 0, .3], lean: .18, head: [.15, 0, 0], hideHeld: true }) });
// Hang out on the couch: slide onto the seat and slump. Stops when you walk off.
ANIM.define('sit', { dur: 4, loop: true, cancelOnMove: true, fadeIn: .4, fadeOut: .3,
  fp: (k, t) => ({ camY: -.55, camPitch: .05, y: -.05, rx: .2, z: .03 + Math.sin(t * 1.6) * .006, hideHeld: false }),
  tp: (k, t, m) => ({ y: -.28, lean: -.3, world: m.seat, legR: [-1.2, 0, -.1], legL: [-1.2, 0, .1], armR: [-.25, 0, -.35], armL: [-.25, 0, .35], head: [-.1, 0, Math.sin(t * 1.6) * .05] }) });
// Pick something up off the ground (GAME-82 plays the first-person part): bend and scoop.
ANIM.define('reach', { dur: .65,
  tp: k => { const d = ANIM.keys([[0, 0], [.45, 1], [1, 0]])(k);
    return { y: -.1 * d, lean: .45 * d, armR: [-1.1 * d, 0, .1 * d], armL: [-.3 * d, 0, 0], legR: [-.35 * d, 0, 0], legL: [.25 * d, 0, 0], head: [.35 * d, 0, 0], hideHeld: k < .45 }; } });
// Dig through a dumpster or trash pile (GAME-82 plays the first-person part): lean in and root around.
ANIM.define('dig', { dur: 1.2,
  tp: (k, t) => { const r = Math.sin(t * 16);
    return { lean: .35, fwd: .05, armR: [-1.3 + r * .25, 0, .15], armL: [-1.3 - r * .25, 0, -.15], head: [.3, 0, r * .05], tilt: r * .03, hideHeld: true }; } });
// Throw what you hold (other players see it; your hand already kicks in first person).
ANIM.define('throw', { dur: .6,
  tp: k => { const s = ANIM.keys([[0, 0], [.3, 1], [.55, -.5], [1, 0]])(k);
    return { armR: [-1.6 - s * 1.3, 0, .1], turn: s * .3, lean: -s * .1, hideHeld: k > .3 && k < .95 }; } });
