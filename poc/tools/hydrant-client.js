// ===================== fire hydrants (GAME-94) =====================
// Runs inside the look-test module (reuses put, grp, CYL, decal, dust, flameTex, fxl).
// The server says which hydrants are open (meta objects[id].water); this draws the jet,
// the spreading puddle, the shove you feel standing in it, and the gush sound.
// Cheap on purpose: one Points draw per jet, materials made at load, no lights.
const HYD = (() => {
  const LEN = 6.5, RADIUS = 0.9, PUSH = 5.2;          // same numbers as the server (server.mjs HYD)
  const jets = new Map();                              // fixture id -> jet
  // Shared materials, made now so they compile behind the loading screen (see prewarm.js).
  // Drops: a firm, saturated blue disc. The Blend shader washes pale blues out to nothing, so water has to be a strong blue to read.
  const dropTex = (() => {
    const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s; const g = cv.getContext('2d');
    const rg = g.createRadialGradient(s * .42, s * .4, 0, s / 2, s / 2, s / 2);
    rg.addColorStop(0, 'rgba(190,232,255,1)'); rg.addColorStop(.3, 'rgba(40,160,255,1)'); rg.addColorStop(.75, 'rgba(20,110,230,.95)'); rg.addColorStop(1, 'rgba(20,110,230,0)');
    g.fillStyle = rg; g.fillRect(0, 0, s, s); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const waterMat = new THREE.PointsMaterial({ map: dropTex, color: 0xFFFFFF, size: .34, transparent: true, opacity: .95, depthWrite: false, sizeAttenuation: true });
  const mistMat = new THREE.PointsMaterial({ map: flameTex, color: 0x4AAEFF, size: .9, transparent: true, opacity: .3, depthWrite: false, sizeAttenuation: true });
  const puddleTex = (() => {
    const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s; const g = cv.getContext('2d');
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * 6.28, d = Math.random() * s * .26, x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d, r = s * (.1 + Math.random() * .16);
      const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, 'rgba(52,84,118,.55)'); rg.addColorStop(1, 'rgba(52,84,118,0)'); g.fillStyle = rg; g.fillRect(0, 0, s, s);
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  // The solid core of the jet right out of the outlet: a tapered translucent cone.
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x2299FF, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide });
  const coreGeo = (() => { const g = new THREE.CylinderGeometry(.16, .055, 1.7, 10, 1, true); g.translate(0, .85, 0); g.rotateZ(-Math.PI / 2); return g; })();   // along +x from the origin
  const puddleMat = new THREE.MeshBasicMaterial({ map: puddleTex, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -2 });

  // Same model as the look test's hydrant, turned so an outlet cap faces the jet.
  function buildHydrant(x, z, dir) {
    const g = grp(scene, x, 0, z, dir - Math.PI / 2);
    const prof = [[0, 0], [.17, 0], [.17, .06], [.13, .08], [.13, .5], [.15, .52], [.15, .56], [.11, .6], [.06, .68], [0, .7]].map(([a, b]) => new THREE.Vector2(a, b));
    put(new THREE.LatheGeometry(prof, 14), 0xFFD84A, g, 0, 0, 0);
    for (const r of [0, Math.PI / 2, Math.PI]) { const o = grp(g, 0, .4, 0, r); put(CYL(.06, .06, .12, 10), 0xFFD84A, o, .17, 0, 0, { rz: Math.PI / 2 }); put(CYL(.07, .07, .03, 6), 0xE8343F, o, .24, 0, 0, { rz: Math.PI / 2 }); }
    put(CYL(.035, .035, .05, 5), 0xE8343F, g, 0, .72, 0);
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(.17, .17, .7, 8) }); b.position.set(x, .35, z); world.addBody(b);
  }

  function makeJet(f) {
    const dir = f.dir || 0, dx = Math.sin(dir), dz = Math.cos(dir);
    const N = 320, M = 36;
    const mk = (n, mat) => {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-50), 3));
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; fxl(pts); scene.add(pts); return pts;
    };
    const puddle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), puddleMat.clone());   // clone shares the compiled program
    puddle.rotation.x = -Math.PI / 2; puddle.position.set(f.pos[0] + dx * 2.6, .085, f.pos[2] + dz * 2.6); puddle.scale.set(5.5, 5.5, 1); fxl(puddle); scene.add(puddle);
    const core = new THREE.Mesh(coreGeo, coreMat); core.position.set(f.pos[0] + dx * .28, .4, f.pos[2] + dz * .28);
    core.rotation.set(0, dir - Math.PI / 2, .16, 'YXZ'); core.visible = false; fxl(core); scene.add(core);
    return { f, dx, dz, ox: f.pos[0] + dx * .3, oz: f.pos[2] + dz * .3, on: false, wet: 0, wetTarget: 0, core,
      drops: mk(N, waterMat), mist: mk(M, mistMat), p: new Float32Array(N * 3), v: new Float32Array(N * 3), age: new Float32Array(N).fill(9),
      mp: new Float32Array(M * 3), mv: new Float32Array(M * 3), mage: new Float32Array(M).fill(9), acc: 0, macc: 0, next: 0, mnext: 0, puddle };
  }
  function jetFor(f) { let j = jets.get(f.id); if (!j) { j = makeJet(f); jets.set(f.id, j); } return j; }

  function init(MAP) { for (const h of MAP.hydrants || []) buildHydrant(h.p[0], h.p[1], h.dir || 0); }

  function onMeta(m, fixtures) {
    for (const [id, f] of fixtures) {
      if (f.type !== 'hydrant') continue;
      const st = m.objects[id] || {};
      if (!st.water && !st.wet && !jets.has(id)) continue;
      const j = jetFor(f);
      if (st.water && !j.on) feedOpen(j);
      j.on = !!st.water; j.wetTarget = st.water ? 1 : st.wet ? .55 : 0;
    }
  }
  let feedOpen = () => {};

  // Shove for your own predicted vagrant: same shape as the server's waterPush().
  function push() {
    const out = { x: 0, z: 0 }, x = player.position.x, z = player.position.z;
    for (const j of jets.values()) {
      if (!j.on) continue;
      const rx = x - j.ox, rz = z - j.oz, along = rx * j.dx + rz * j.dz;
      if (along < -.2 || along > LEN) continue;
      if (Math.abs(rx * j.dz - rz * j.dx) > RADIUS + along * .08) continue;
      const v = PUSH * (.35 + .65 * Math.max(0, 1 - Math.max(0, along) / LEN)); out.x += j.dx * v; out.z += j.dz * v;
    }
    return out;
  }

  // ---------- sound: a hissing gush, louder the closer you are ----------
  let actx = null, noiseBuf = null;
  function gushNode(j) {
    try { actx ||= new AudioContext(); } catch { return; }
    if (!noiseBuf) { noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate); const d = noiseBuf.getChannelData(0); let b = 0; for (let i = 0; i < d.length; i++) { b = b * .6 + (Math.random() * 2 - 1) * .4; d[i] = b; } }
    const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = .6;
    const g = actx.createGain(); g.gain.value = 0;
    src.connect(bp); bp.connect(g); g.connect(actx.destination); src.start();
    j.snd = { src, g, bp };
  }
  function clank(at, n = 3) {                         // ratchet clicks while the wrench turns
    try { actx ||= new AudioContext(); } catch { return; }
    const d = camera.position.distanceTo(new THREE.Vector3(...at)); if (d > 25) return;
    const vol = .12 * (1 - d / 25) * SET.vol(); if (vol <= 0) return;
    for (let i = 0; i < n; i++) {
      const t0 = actx.currentTime + .12 + i * .26, o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(1900 - i * 120, t0); o.frequency.exponentialRampToValueAtTime(420, t0 + .07);
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.0001, t0 + .09);
      o.connect(g); g.connect(actx.destination); o.start(t0); o.stop(t0 + .1);
    }
  }

  const G = 9.8;
  function frame(dt) {
    for (const j of jets.values()) {
      // drops: launched from the outlet, arc down under gravity, die on the ground
      const { p, v, age } = j, N = age.length;
      if (j.on) {
        j.acc += dt * 330;
        while (j.acc > 1) {
          j.acc--; const i = j.next; j.next = (j.next + 1) % N;
          const sp = 7.5 + Math.random() * 3.2, side = (Math.random() - .5) * 1.1, up = 1.4 + Math.random() * 1.4;
          p[i * 3] = j.ox; p[i * 3 + 1] = .4; p[i * 3 + 2] = j.oz;
          v[i * 3] = j.dx * sp + j.dz * side; v[i * 3 + 1] = up; v[i * 3 + 2] = j.dz * sp - j.dx * side;
          const pre = Math.random() * dt - dt;                  // rewind 0..dt; the step below moves it forward dt, so the batch spreads along the arc and low frame rates still read as a stream
          p[i * 3] += v[i * 3] * pre; p[i * 3 + 1] += (up - G * pre / 2) * pre; p[i * 3 + 2] += v[i * 3 + 2] * pre; v[i * 3 + 1] -= G * pre; age[i] = pre;
        }
      }
      let live = 0;
      for (let i = 0; i < N; i++) {
        if (age[i] > 2) continue;
        age[i] += dt; v[i * 3 + 1] -= G * dt;
        p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
        if (p[i * 3 + 1] < .06) {                              // hits the ground: skitter along a little, then gone
          p[i * 3 + 1] = .06; v[i * 3 + 1] = Math.abs(v[i * 3 + 1]) * .18; v[i * 3] *= .45; v[i * 3 + 2] *= .45;
          if (Math.abs(v[i * 3]) + Math.abs(v[i * 3 + 2]) < 1.2) age[i] = 9;
          else if (j.on && Math.random() < .08) spawnMist(j, p[i * 3], p[i * 3 + 2]);
        }
        live++;
      }
      const pa = j.drops.geometry.attributes.position.array;
      for (let i = 0; i < N; i++) { const dead = age[i] > 2; pa[i * 3] = dead ? 0 : p[i * 3]; pa[i * 3 + 1] = dead ? -50 : p[i * 3 + 1]; pa[i * 3 + 2] = dead ? 0 : p[i * 3 + 2]; }
      j.drops.geometry.attributes.position.needsUpdate = true;
      if (j.on) { j.macc += dt * 10; while (j.macc > 1) { j.macc--; spawnMist(j, j.ox + j.dx * (.3 + Math.random() * 1.2), j.oz + j.dz * (.3 + Math.random() * 1.2), .5); } }
      // mist puffs drift up and fade (all share one material, so they fade by shrinking)
      const { mp, mv, mage } = j, M = mage.length, ma = j.mist.geometry.attributes.position.array;
      for (let i = 0; i < M; i++) {
        if (mage[i] > 1.2) { ma[i * 3 + 1] = -50; continue; }
        mage[i] += dt; mp[i * 3] += mv[i * 3] * dt; mp[i * 3 + 1] += mv[i * 3 + 1] * dt; mp[i * 3 + 2] += mv[i * 3 + 2] * dt;
        ma[i * 3] = mp[i * 3]; ma[i * 3 + 1] = mp[i * 3 + 1]; ma[i * 3 + 2] = mp[i * 3 + 2];
      }
      j.mist.geometry.attributes.position.needsUpdate = true;
      j.core.visible = j.on; if (j.on) j.core.scale.set(1 + Math.sin(performance.now() * .031) * .06, 1 + Math.random() * .1, 1 + Math.random() * .1);
      j.drops.visible = live > 0; j.mist.visible = j.on || mage.some(a => a < 1.2);
      // puddle spreads while it gushes, then dries slowly
      j.wet += (j.wetTarget - j.wet) * (1 - Math.exp(-dt * (j.wetTarget > j.wet ? .35 : .05)));
      j.puddle.material.opacity = j.wet * .9; j.puddle.scale.set(2 + j.wet * 4.5, 2 + j.wet * 3.5, 1); j.puddle.visible = j.wet > .01;
      // sound
      if (j.on && !j.snd) gushNode(j);
      if (j.snd) {
        const d = Math.hypot(camera.position.x - j.ox, camera.position.z - j.oz);
        const target = j.on ? .22 * Math.max(0, 1 - d / 35) * SET.vol() : 0;
        j.snd.g.gain.value += (target - j.snd.g.gain.value) * Math.min(1, dt * 4);
        if (!j.on && j.snd.g.gain.value < .002) { try { j.snd.src.stop(); } catch {} j.snd = null; }
      }
    }
  }
  function spawnMist(j, x, z, up = .25) {
    const i = j.mnext; j.mnext = (j.mnext + 1) % j.mage.length;
    j.mp[i * 3] = x; j.mp[i * 3 + 1] = .2 + Math.random() * .3; j.mp[i * 3 + 2] = z;
    j.mv[i * 3] = j.dx * .8 + (Math.random() - .5) * .6; j.mv[i * 3 + 1] = up + Math.random() * .4; j.mv[i * 3 + 2] = j.dz * .8 + (Math.random() - .5) * .6; j.mage[i] = 0;
  }

  // Water hits a fire: hissing steam and the fire dies down to a smoulder.
  function douse(f, at) {
    const p = new THREE.Vector3(at[0], (at[1] || .4) + .4, at[2]);
    dust(p, 12, 0xF4F6F8);
    if (f && f.type === 'pile') { const pl = piles[f.index]; if (pl && pl.state === 'burning') { pl.state = 'smolder'; pl.t = 0; if (pl.e) { pl.e.fire = 0; pl.e.smoke = .5; } } }
  }

  return { init, onMeta, frame, push, douse, clank, set onOpen(fn) { feedOpen = fn; }, materials: [waterMat, mistMat, puddleMat, coreMat], jets };
})();
window.__hyd = HYD;   // for capture/debug scripts
