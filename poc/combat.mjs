// GAME-85: hit reactions, fist fights and townsfolk who fight back.
// Everyone who can be hurt (awake vagrants and townsfolk NPCs) carries e.fight:
//   { hp, downUntil, staggerUntil, kb: {x,z}, lastHit, lastPunch }
// hurt() is the one way to deal damage. It pays player victims cash for the hit
// (preston's rule: taking damage adds money to you), so car hits use it too.
export const MAX_HP = 100;
export const PAY_PER_HP = 2;          // $ a player earns per HP of damage taken
const DOWN_MS = 3500;                 // knocked out this long, then get up at full HP
const PUNCH_DMG = 20, NPC_PUNCH_DMG = 15, PUNCH_RANGE = 1.75, PUNCH_COOLDOWN = 420, PUNCH_WINDUP = 140;
const REGEN_DELAY = 4000, REGEN_PER_S = 8;
// What it costs the town when you hurt one of its people.
const TOWN_COST = { punch: 60, item: 150, ko: 300 };
const NPC_LINES = {
  hurt: ['OW!', 'HEY!', 'Hey!!', 'Ow, my face!', 'What the—'],
  fight: ["You wanna go?!", "Oh it's ON.", 'Come here!', "That's it, pal!", 'Put em up!'],
  throw: ['Eat this!', 'Two can play that game!', 'Catch!', 'Right back atcha!'],
  win: ['Stay down!', "And don't come back!", 'Hmph.', "That's MY corner."],
  ko: ['ugh...', 'oof...', 'zzz...'],
  calm: ['...whatever.', 'Not worth it.', 'Tch.'],
};
const pick = a => a[Math.floor(Math.random() * a.length)];

export function createCombat(ctx) {
  const { RAPIER, world, controller, entities, addEntity, broadcast, addDamage, MAP, dt, WALK, RUN, GRAVITY, CAP_HALF, CAP_R, throwFrom } = ctx;

  const fightOf = e => e.fight || (e.fight = { hp: MAX_HP, downUntil: 0, staggerUntil: 0, kb: { x: 0, z: 0 }, lastHit: 0, lastPunch: 0 });
  const isDown = e => !!e.fight && Date.now() < e.fight.downUntil;
  const canFight = e => e && (e.kind === 'vagrant' || e.kind === 'npc');
  const posOf = e => { const t = e.body.translation(); return [t.x, t.y, t.z]; };
  const say = (e, kind) => broadcast({ t: 'fx', kind: 'say', id: e.id, text: pick(NPC_LINES[kind]) });
  // The player (account) who did it, if a player did.
  const playerOf = by => (by && by.player && by.kind === 'vagrant') ? by.player : null;

  // victim: vagrant or npc entity. amount: HP. by: attacker entity or null.
  // cause: 'punch' | 'item' | 'car' | ... push: optional {x,y,z} knock velocity (m/s).
  function hurt(victim, amount, { by = null, cause = 'hit', push = null } = {}) {
    if (!canFight(victim) || amount <= 0) return false;
    const f = fightOf(victim), now = Date.now();
    if (now < f.downUntil) {                       // kicking someone who's down: a shove, no extra damage
      if (push) { f.kb.x += push.x * 0.5; f.kb.z += push.z * 0.5; }
      return false;
    }
    amount = Math.round(amount);
    f.hp -= amount; f.lastHit = now; f.staggerUntil = now + 350;
    if (push) { f.kb.x += push.x; f.kb.z += push.z; }
    const p = victim.player;
    let paid = 0;
    if (p && victim.kind === 'vagrant') { paid = amount * PAY_PER_HP; p.cash = (p.cash || 0) + paid; }
    const ko = f.hp <= 0;
    broadcast({ t: 'fx', kind: 'hurt', id: victim.id, by: by ? by.id : null, cause, amount, hp: Math.max(0, f.hp), paid, at: posOf(victim), push: push ? [push.x, push.y || 0, push.z] : null });
    const attacker = playerOf(by);
    if (victim.kind === 'npc') {
      if (attacker) addDamage(attacker, ko ? TOWN_COST.ko : (TOWN_COST[cause] || 60), posOf(victim), ko ? 'Knocked out a local' : cause === 'punch' ? 'Punched a local' : 'Beaned a local');
      if (!ko) provoke(victim, by);
    }
    if (ko) knockOut(victim, by);
    return ko;
  }

  function knockOut(e, by) {
    const f = fightOf(e), now = Date.now();
    f.hp = 0; f.downUntil = now + DOWN_MS;
    if (e.joint) ctx.releaseGrab?.(e);
    e.state.down = 1;
    broadcast({ t: 'fx', kind: 'ko', id: e.id, by: by ? by.id : null, ms: DOWN_MS });
    if (e.kind === 'npc') { say(e, 'ko'); e.ai.mode = 'down'; }
    // Whoever knocked them out is satisfied.
    if (by && by.kind === 'npc' && by.ai.target === e.id) { say(by, 'win'); calmDown(by); }
  }
  function getUp(e) {
    const f = fightOf(e);
    f.hp = MAX_HP; f.downUntil = 0; e.state.down = 0;
    broadcast({ t: 'fx', kind: 'koup', id: e.id });
    if (e.kind === 'npc') {
      // Half the time they get up still mad; otherwise they've had enough.
      const t = e.ai.target && entities.get(e.ai.target);
      if (t && !isDown(t) && Math.random() < 0.5) { e.ai.mode = 'fight'; e.ai.angryUntil = Date.now() + 12000; e.state.angry = 1; say(e, 'fight'); }
      else calmDown(e);
    }
  }

  // ---------- punching ----------
  // Swing now, land a moment later if the target is still in front of you, so a
  // well-timed step back dodges it.
  function punch(attacker, dir) {
    const f = fightOf(attacker), now = Date.now();
    if (now < f.downUntil || now - f.lastPunch < PUNCH_COOLDOWN) return false;
    f.lastPunch = now;
    const len = Math.hypot(dir.x, dir.z) || 1, dx = dir.x / len, dz = dir.z / len;
    f.hand = f.hand === 'L' ? 'R' : 'L';
    broadcast({ t: 'fx', kind: 'punch', id: attacker.id, hand: f.hand });
    setTimeout(() => landPunch(attacker, dx, dz), PUNCH_WINDUP);
    return true;
  }
  function landPunch(attacker, dx, dz) {
    if (!entities.has(attacker.id) || isDown(attacker)) return;
    const a = attacker.body.translation();
    let best = null, bestScore = Infinity;
    for (const o of entities.values()) {
      if (o === attacker || !o.body) continue;
      const fighter = canFight(o), loose = o.kind === 'prop' || o.kind === 'sleeper' || o.kind === 'item';
      if (!fighter && !loose) continue;
      const t = o.body.translation();
      const ox = t.x - a.x, oz = t.z - a.z, oy = t.y - a.y;
      const d = Math.hypot(ox, oz);
      const reach = PUNCH_RANGE + (fighter || o.kind === 'sleeper' ? CAP_R : 0.3);
      if (d > reach || Math.abs(oy) > 1.6) continue;
      const along = (ox * dx + oz * dz) / (d || 1);
      if (d > 0.4 && along < 0.55) continue;      // must be roughly in front
      const score = d * (2 - along) + (fighter ? 0 : 0.6);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (!best) return;
    const push = { x: dx * 4.5, y: 0, z: dz * 4.5 };
    if (canFight(best)) hurt(best, (attacker.kind === 'npc' ? NPC_PUNCH_DMG : PUNCH_DMG) + Math.round(Math.random() * 6 - 3), { by: attacker, cause: 'punch', push });
    else {
      const m = best.body.mass() || 1;
      best.body.wakeUp();
      best.body.applyImpulse({ x: dx * Math.min(m, 8) * 5, y: Math.min(m, 8) * 1.5, z: dz * Math.min(m, 8) * 5 }, true);
      broadcast({ t: 'fx', kind: 'thud', at: posOf(best) });
    }
  }

  // A thrown thing hit a person. damage scales with how hard it was going.
  function itemHit(thrower, victim, vel, mass = 0.4) {
    if (!canFight(victim)) return false;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < 3) return false;
    const amount = Math.max(8, Math.min(70, mass * speed * 4));
    const hs = Math.hypot(vel.x, vel.z) || 1, kick = Math.min(7, hs * Math.min(1, mass * 0.6));
    hurt(victim, amount, { by: thrower, cause: 'item', push: { x: vel.x / hs * kick, y: 0, z: vel.z / hs * kick } });
    return true;
  }

  // ---------- movement modifiers for anyone who fights ----------
  // Returns how much of your own input you get (0 while down or staggered a bit)
  // plus this step's knockback displacement.
  function moveMod(e, step) {
    const f = e.fight; if (!f) return { scale: 1, kx: 0, kz: 0, down: false };
    const now = Date.now();
    if (f.downUntil && now >= f.downUntil) getUp(e);
    const down = now < f.downUntil;
    const kx = f.kb.x * step, kz = f.kb.z * step;
    const damp = Math.exp(-step * 7); f.kb.x *= damp; f.kb.z *= damp;
    if (!down && f.hp < MAX_HP && now - f.lastHit > REGEN_DELAY) f.hp = Math.min(MAX_HP, f.hp + REGEN_PER_S * step);
    return { scale: down ? 0 : now < f.staggerUntil ? 0.35 : 1, kx, kz, down };
  }

  // ---------- townsfolk NPCs ----------
  const npcs = [];
  function spawnNpcs() {
    (ctx.NPCS || MAP.npcs || []).forEach((n, i) => {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(n.x, CAP_HALF + CAP_R + 0.05, n.z));
      const collider = world.createCollider(RAPIER.ColliderDesc.capsule(CAP_HALF, CAP_R).setFriction(0.5), body);
      const e = addEntity({ id: 'n:' + i, kind: 'npc', name: n.name || 'Local', look: n.look || {}, body, collider, vy: 0, facing: n.ry || 0, state: {},
        ai: { mode: 'idle', home: { x: n.x, z: n.z, ry: n.ry || 0 }, target: null, angryUntil: 0, nextAct: 0, throws: 0, wanderAt: 0, temper: n.temper ?? Math.random() } });
      fightOf(e);
      npcs.push(e);
    });
  }
  function provoke(npc, by) {
    if (!by || by === npc || !canFight(by)) return;
    const ai = npc.ai, now = Date.now();
    const wasCalm = ai.mode === 'idle' || ai.mode === 'home';
    ai.target = by.id; ai.angryUntil = now + 15000; npc.state.angry = 1;
    if (!wasCalm) return;
    const t = by.body.translation(), me = npc.body.translation();
    const d = Math.hypot(t.x - me.x, t.z - me.z);
    // Far away (or a hothead with bottles handy): throw stuff back. Close: fists.
    if (d > 5 && Math.random() > ai.temper * 0.6) { ai.mode = 'throw'; ai.throws = 2 + Math.floor(Math.random() * 3); say(npc, 'throw'); }
    else { ai.mode = 'fight'; say(npc, 'fight'); }
    ai.nextAct = now + 450;
  }
  function calmDown(npc) {
    npc.ai.mode = 'home'; npc.ai.target = null; npc.state.angry = 0;
  }
  function moveNpc(e, wantX, wantZ, speed, step) {
    const mm = moveMod(e, step);
    const t = e.body.translation();
    e.vy += GRAVITY * step;
    const desired = { x: wantX * speed * step * mm.scale + mm.kx, y: e.vy * step, z: wantZ * speed * step * mm.scale + mm.kz };
    controller.computeColliderMovement(e.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    const mv = controller.computedMovement();
    if (controller.computedGrounded()) e.vy = 0;
    if (Math.abs(mv.x) + Math.abs(mv.y) + Math.abs(mv.z) > 1e-5) e.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    return mm;
  }
  const turnTo = (e, yaw, step, rate = 10) => { let d = yaw - e.facing; d = Math.atan2(Math.sin(d), Math.cos(d)); e.facing += d * Math.min(1, step * rate); };

  function stepNpcs(step) {
    const now = Date.now();
    for (const e of npcs) {
      const ai = e.ai, me = e.body.translation();
      let wx = 0, wz = 0, speed = WALK;
      const tgt = ai.target ? entities.get(ai.target) : null;
      if (isDown(e)) { moveNpc(e, 0, 0, 0, step); continue; }
      if (ai.mode === 'down') ai.mode = tgt ? 'fight' : 'home';
      if ((ai.mode === 'fight' || ai.mode === 'throw')) {
        // Give up if the target is gone, asleep, knocked out, far, or it's been a while.
        if (!tgt || !canFight(tgt)) { calmDown(e); }
        else if (isDown(tgt)) { say(e, 'win'); calmDown(e); }
        else {
          const t = tgt.body.translation(), dx = t.x - me.x, dz = t.z - me.z, d = Math.hypot(dx, dz) || 1;
          if (d > 30 || now > ai.angryUntil) { say(e, 'calm'); calmDown(e); }
          else {
            turnTo(e, Math.atan2(dx, dz), step);
            if (ai.mode === 'throw') {
              if (d < 4 || ai.throws <= 0) { ai.mode = 'fight'; if (ai.throws <= 0) say(e, 'fight'); }
              else if (now > ai.nextAct) {
                ai.nextAct = now + 1300 + Math.random() * 700; ai.throws--;
                throwAt(e, t, d);
              }
              // keep a little distance while throwing
              if (d < 7) { wx = -dx / d * 0.5; wz = -dz / d * 0.5; }
            }
            if (ai.mode === 'fight') {
              if (d > PUNCH_RANGE * 0.8) { wx = dx / d; wz = dz / d; speed = d > 4 ? RUN * 0.85 : WALK; }
              else if (now > ai.nextAct) { ai.nextAct = now + 750 + Math.random() * 500; punch(e, { x: dx, z: dz }); }
            }
          }
        }
      }
      if (ai.mode === 'home') {
        const dx = ai.home.x - me.x, dz = ai.home.z - me.z, d = Math.hypot(dx, dz);
        if (d > 0.4) { wx = dx / d; wz = dz / d; turnTo(e, Math.atan2(dx, dz), step, 6); }
        else { ai.mode = 'idle'; }
      }
      if (ai.mode === 'idle') turnTo(e, ai.home.ry, step, 2);
      moveNpc(e, wx, wz, speed, step);
    }
  }
  // Lob something at the target, leading a little and arcing to reach them.
  function throwAt(e, t, d) {
    const me = e.body.translation();
    const tv = { x: t.x - me.x, y: (t.y + 0.4) - (me.y + 0.55), z: t.z - me.z };
    const speed = 16, flight = d / speed;
    const vy = tv.y / flight + 0.5 * -GRAVITY * flight;   // arc so it lands on them
    broadcast({ t: 'fx', kind: 'punch', id: e.id, hand: 'T' }); // throwing arm swing
    throwFrom(e, { x: tv.x / d * speed + (Math.random() - 0.5), y: Math.min(9, vy), z: tv.z / d * speed + (Math.random() - 0.5) });
  }
  function describeNpc(e) { return { name: e.name, look: e.look, angry: e.state.angry || 0, down: isDown(e) ? 1 : 0 }; }

  return { hurt, punch, itemHit, moveMod, isDown, stepNpcs, spawnNpcs, describeNpc, fightOf, npcs };
}
