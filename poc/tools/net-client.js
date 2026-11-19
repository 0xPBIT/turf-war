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
  function buildVagrant(e) {
    const p = vagrant({ x: 0, z: 0, ry: 0, ...vagrantLook(e), rig: true });
    world.removeBody(p.bodyRef); people.splice(people.indexOf(p), 1); scene.remove(p.g);
    p.g.position.set(0, -0.9, 0); p.g.rotation.set(0, 0, 0);
    // The beer bottle everyone carries, in the right glove (others see it raised and thrown).
    if (p.parts) { const b = bottleMesh(); b.position.set(-.07, -.6, .11); b.rotation.x = .15; p.parts.armR.add(b); p.held = b; }
    return p;
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
      extra = { model: v, tag };
      if (e.kind === 'sleeper') { const z = zzzTag(); z.position.y = 1.4; obj.add(z); extra.zz = z; }
    } else if (e.kind === 'traffic') obj = buildCar(e.color);
    else if (e.kind === 'prop') obj = buildProp(e);
    else if (e.kind === 'bottle') obj = bottleMesh();
    else return;
    scene.add(obj);
    ents.set(e.id, { ...e, obj, buf: [], ...extra });
  }
  function despawn(id) { const v = ents.get(id); if (v && v.obj) scene.remove(v.obj); ents.delete(id); fixtures.delete(id); }

  // ---------- snapshots and interpolation ----------
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
  function onSnapshot(m) {
    const sample = m.ts - performance.now();
    // Track the smallest observed delay; drift slowly so a late packet doesn't jerk everything.
    if (clockOffset === null || sample > clockOffset) clockOffset = sample; else clockOffset += (sample - clockOffset) * 0.02;
    for (const r of m.b) {
      const v = ents.get(r[0]); if (!v || v.own) continue;
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
    if (!haveAck) { player.velocity.x = player.velocity.z = 0; }   // stand still until the server places us
  }
  function afterStep(dt) {
    // Blend in any correction over a few frames so it never reads as a snap.
    if (corr.lengthSq() > 1e-6) { const k = 1 - Math.exp(-dt * 8); player.position.x += corr.x * k; player.position.z += corr.z * k; corr.multiplyScalar(1 - k); }
    sendAcc += dt;
    if (ws && ws.readyState === 1 && me && haveAck && sendAcc >= 1 / 30) {
      const span = Math.min(sendAcc, 0.1); sendAcc = 0; seq = (seq + 1) >>> 0;
      ws.send(JSON.stringify({ t: 'in', seq, dt: +span.toFixed(4), x: +lastIn.x.toFixed(3), z: +lastIn.z.toFixed(3), yaw: +Math.atan2(-Math.sin(yaw), -Math.cos(yaw)).toFixed(3),
        jump: SET.down('jump'), run: SET.running() }));
      hist.push({ seq, x: player.position.x + corr.x, y: player.position.y + 0.55, z: player.position.z + corr.z });
      if (hist.length > 120) hist.shift();
    }
  }
  function onAck(m) {
    const [sx, sy, sz] = m.p;
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
  const speedScale = () => { const g = grabbing && ents.get(grabbing); return g && g.kind === 'sleeper' ? 60 / 70 : 1; };

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
    else if (m.kind === 'honk') { popText(m.long ? 'HOOONK!!' : 'HONK!', [m.at[0], 2.2, m.at[2]], 'honk'); honkSound(m.long, m.at); if (m.target === me) feed('A car is honking at you. Get out of the street!'); }
    else if (m.kind === 'say') { const v = ents.get(m.id); const at = v && v.obj ? [v.obj.position.x, v.obj.position.y + 1.3, v.obj.position.z] : (m.id === me ? null : null); if (at) popText(m.text, at, 'say'); else if (m.id === me) feed(esc(m.text)); }
    else if (m.kind === 'anim') { if (m.id === me) ANIM.echo(m.clip, m); else ANIM.playOn(ents.get(m.id), m.clip, m); }
    else if (m.kind === 'grab') { if (m.id === me) { grabbing = m.target; feed(m.target ? 'Got it. Press grab again to let go.' : 'You let go.'); } }
    else if (m.kind === 'turf') feed(`<b>${esc(m.by)}</b> now owns <b>${esc(m.zone)}</b>`);
  }
  function onMeta(m) {
    meta = m; damage = m.town;
    const mine = m.players.find(p => p.id === myPid);
    el('rows').innerHTML = m.players.map(p => `<div class="r ${p.asleep ? 'zz' : ''}"><i style="background:${p.color}"></i>${esc(p.name)}${p.asleep ? ' (asleep)' : ''}<em>${money(p.damage)}</em></div>`).join('')
      + (mine ? `<div class="r" style="margin-top:4px;color:var(--ink-soft)">Your cash<em>${money(mine.cash)}</em></div>` : '');
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
        // Ground speed, smoothed so interpolation steps don't stutter the walk cycle.
        const sp = dt > 0 ? Math.hypot(s.p.x - cur.x, s.p.z - cur.z) / dt : 0;
        v.spd = (v.spd || 0) + (Math.min(sp, 12) - (v.spd || 0)) * (1 - Math.exp(-dt * 8));
        ANIM.poseVagrant(v, dt, v.spd, t);
      } else if (v.kind === 'sleeper') {
        v.obj.position.copy(s.p); v.model.g.quaternion.copy(s.q);   // lying ragdoll pose comes from the body
        v.zz.position.y = 1.0 + Math.sin(t * 2) * .12;
      } else { v.obj.position.copy(s.p); v.obj.quaternion.copy(s.q); }
    }
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
  function nearestAction() {
    if (!MAP) return null; let best = null, bd = 9;
    for (const f of fixtures.values()) {
      const a = MAP.actions[f.type]; if (!a || ['window', 'car', 'crate', 'cone'].includes(f.type)) continue;
      if (f.type === 'pile') { const p = piles[f.index]; if (p && p.state !== 'idle') continue; }
      const st = meta && meta.objects[f.id]; if (st && (st.fire || st.burnt)) continue;
      const d = (f.pos[0] - player.position.x) ** 2 + (f.pos[2] - player.position.z) ** 2; if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
  function updatePrompt(btn) {
    const f = nearestAction(); btn.hidden = !f;
    if (f) { const k = __set.s.binds.act, html = `${esc(MAP.actions[f.type].verb)} <kbd>${esc(k.startsWith('Key') ? k.slice(3) : k)}</kbd>`; if (btn.innerHTML !== html) btn.innerHTML = html; }
  }
  // Same clip names as ACTION_ANIM in server.mjs; played at once so the hand moves on the key press.
  const ACTION_ANIM = { pile: 'light', dumpster: 'toss', stop_sign: 'panhandle', fire_can: 'warm', couch: 'sit' };
  let lastAct = 0;
  const act = () => {
    if (!ws || ws.readyState !== 1) return;
    const f = nearestAction(), now = performance.now();
    if (f && now - lastAct > 600) { lastAct = now; const clip = (MAP.actions[f.type] || {}).anim || ACTION_ANIM[f.type]; if (clip) ANIM.play(clip); }
    ws.send('{"t":"act"}');
  };
  let lastPointer = 'mouse';
  canvas.addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, true);
  function throwDir(dir) {
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
    if (SET.isBind('act', e.code) || e.code === 'KeyF') act();
    if (SET.isBind('grab', e.code) && ws && ws.readyState === 1) ws.send('{"t":"grab"}');
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
  window.__net = { get me() { return me; }, ents, fixtures, get corr() { return corr.length(); }, get pos() { return player.position; }, errs,
    look(y, p) { yaw = y; pitch = p ?? pitch; }, get yaw() { return yaw; } };   // look() aims the camera for captures and tests
  return { beforeStep, afterStep, frame, speedScale, updatePrompt, act, throwDir };
})();
