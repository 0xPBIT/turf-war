// ===================== lighters and burning plants (GAME-86) =====================
// You need a lighter to start a fire. This file draws the lighter (HUD and first-person
// flick), the Sunny Mart lighter sticker, and trees and bushes catching fire, burning
// down to charred, half-bare husks, and coming back once the town replants them.
// Trees and bushes come from the look test's tree()/bush(), which build-client.py
// patches to keep each one as its own small baked group in BURN (id "t:N", build order).
const FIRE = (() => {
  let lighter = 0;                                   // flicks of fuel left; 0 = no lighter
  const BURNABLE = new Set(['pile', 'dumpster', 'tree', 'bush', 'plant']);
  const byId = new Map(BURN.map(b => [b.id, b]));

  // Charred stages share cached materials (same shader as the living leaves, new colour),
  // so a fire never compiles a new program mid-game.
  const STAGES = [
    { leafA: 'tx:leafA|' + 0xA88A48, leafB: 'tx:leafB|' + 0x967238, pole: 'tx:pole|' + 0x7A604C },   // scorched, browning
    { leafA: 'tx:leafA|' + 0x6E5440, leafB: 'tx:leafB|' + 0x5A4434, pole: 'tx:pole|' + 0x4E423A },   // charring
    { leafA: 'tx:leafA|' + 0x6A625C, leafB: 'tx:leafB|' + 0x4A4440, pole: 'tx:pole|' + 0x3A3330 },   // burnt: ash-grey husk, still shaded so the ink lines read
  ];
  for (const st of STAGES) for (const k of Object.values(st)) getMat(k);   // same shader as live leaves: no new program
  const partOf = key => typeof key === 'string' ? key.slice(3).split('|')[0] : null;
  function prepare(b) {
    if (b.parts) return;
    b.parts = [];
    for (const m of b.g.children) {
      if (!m.isMesh) continue;
      const part = partOf(m.userData.c);
      const leaf = part === 'leafA' || part === 'leafB';
      if (leaf) {   // re-centre canopy meshes so they can shrink in place as the leaves burn away
        m.geometry.computeBoundingBox(); const c = new THREE.Vector3(); m.geometry.boundingBox.getCenter(c);
        m.geometry.translate(-c.x, -c.y, -c.z); m.position.copy(c);
      }
      b.parts.push({ m, part, key: m.userData.c, leaf });
    }
    const top = b.type === 'tree' ? 3.9 * b.s : .6 * b.s;   // flames start at the outside of the canopy, not hidden inside it
    b.canopy = new THREE.Vector3(b.x, top, b.z);
    b.scorch = decal(scorchTex, b.x, b.z, b.type === 'tree' ? 2.2 * b.s : 1.3 * b.s, 0);
  }
  function setStage(b, k) {
    if (b.stage === k) return; b.stage = k;
    for (const p of b.parts) {
      const key = k < 0 || !p.part || !STAGES[k][p.part] ? p.key : STAGES[k][p.part];
      p.m.userData.c = key; p.m.material = getMat(key);
    }
  }
  function ignite(b) {
    prepare(b);
    if (b.state === 'burning') return;
    b.state = 'burning'; b.t0 = performance.now(); b.t = 0;
    const tree = b.type === 'tree';
    // Fires share the fixed FIRE_LIGHTS pool (never a new light, so no shader recompile).
    b.fx = emitter(b.canopy, { radius: (tree ? .9 : .75) * b.s, fire: .1, smoke: .2 });
    if (tree) b.skirt = emitter(new THREE.Vector3(b.x, 2.2 * b.s, b.z), { radius: 1.35 * b.s, fire: .1, smoke: 0, light: false });   // flames licking up the sides
    if (tree) b.base = emitter(new THREE.Vector3(b.x, .15, b.z), { radius: .3 * b.s, fire: .1, smoke: 0, light: false });   // trunk flames: glow comes from the canopy fire
  }
  // Daylight flames: the look test's additive flames vanish against a bright sky, so burning
  // plants also shed solid, normal-blended tongues of flame off the canopy surface. They go
  // through the same particle list, so they age yellow -> orange -> sooty red like the rest.
  const _v = new THREE.Vector3();
  { // compile the tongue shader at load: prewarm.js (runs after this file) compiles the whole scene once
    const w = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, toneMapped: false }));
    w.layers.set(1); w.scale.setScalar(.001); camera.updateMatrixWorld(); w.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3())); scene.add(w);
    let n = 0; (function drop() { if (++n < 5) return requestAnimationFrame(drop); scene.remove(w); })();
  }
  function tongues(b, dt, amount) {
    b.accT = (b.accT || 0) + dt * amount * (b.type === 'tree' ? 110 : 40);
    const tree = b.type === 'tree', k = 1 - (b.shrunk || 0) * (tree ? .38 : .55);
    const cy = tree ? 3.0 * b.s : .45 * b.s, r = (tree ? 1.35 : .6) * b.s * k;
    while (b.accT > 1) {
      b.accT--;
      const a = Math.random() * 6.28, up = Math.random() * .9 - .15;   // sides and top of the canopy
      _v.set(b.x + Math.cos(a) * r * Math.sqrt(1 - up * up), cy + up * r * .9, b.z + Math.sin(a) * r * Math.sqrt(1 - up * up));
      const hot = Math.random();
      const mat = new THREE.SpriteMaterial({ map: flameTex, color: hot < .25 ? 0xFFB020 : hot < .8 ? 0xFF5A12 : 0xC8280A, transparent: true, depthWrite: false, opacity: .95, rotation: Math.random() * 6.28, toneMapped: false });
      const sp = new THREE.Sprite(mat); sp.layers.set(1); sp.position.copy(_v); const s0 = (.45 + Math.random() * .45) * (tree ? b.s : .7 * b.s); sp.scale.setScalar(s0); scene.add(sp);
      // kind 'tongue' takes the smoke path in updateFX: fixed colour, fade in then out, slows as it rises.
      parts.push({ s: sp, kind: 'tongue', vel: new THREE.Vector3((Math.random() - .5) * .5, 1.4 + Math.random() * 1.2, (Math.random() - .5) * .5), life: .55 + Math.random() * .45, t: 0, size0: s0, size1: s0 * .3, opacity: 1.7, spin: (Math.random() - .5) * 1.2 });
    }
  }
  function stop(e) { if (!e) return; e.fire = 0; e.smoke = 0; const i = emitters.indexOf(e); if (i >= 0) emitters.splice(i, 1); }
  function charNow(b) {         // seen already burnt (joined late): go straight to the husk
    prepare(b); stop(b.fx); stop(b.base); stop(b.skirt); b.fx = b.base = b.skirt = null;
    b.state = 'burnt'; setStage(b, 2); shrink(b, 1); b.scorch.material.opacity = .9;
  }
  function shrink(b, u) {
    const k = 1 - u * (b.type === 'tree' ? .38 : .55);
    b.shrunk = u;
    for (const p of b.parts) if (p.leaf) p.m.scale.set(k, k * (1 - u * .1), k);
  }
  function replant(b) {
    if (!b.parts || b.state === 'idle' || !b.state) return;
    stop(b.fx); stop(b.base); stop(b.skirt); b.fx = b.base = b.skirt = null;
    b.state = 'idle'; setStage(b, -1); shrink(b, 0); b.scorch.material.opacity = 0;
  }
  function burnLen(b) { return ((MAPA && MAPA.actions[b.type] && MAPA.actions[b.type].burnSec) || 30); }
  let MAPA = null; fetch('/town.json').then(r => r.json()).then(m => { MAPA = m; });

  function update(dt) {
    for (const b of BURN) {
      if (b.state !== 'burning' && b.state !== 'smolder') continue;
      b.t = (performance.now() - b.t0) / 1000;   // wall clock, so a slow frame or hidden tab keeps pace with the server
      const L = burnLen(b), tree = b.type === 'tree';
      if (b.state === 'burning') {
        const ramp = Math.min(1, b.t / (tree ? 5 : 2.5)), fade = Math.max(0, Math.min(1, (L - b.t) / 6));
        b.fx.fire = (.1 + ramp * (tree ? 2.1 : 1.4)) * fade; b.fx.smoke = (.3 + ramp * (tree ? 2.2 : 1.4)) * Math.max(.4, fade);
        if (b.base) { b.base.fire = Math.min(1, b.t / 2) * .8 * fade; b.skirt.fire = ramp * 1.6 * fade; }
        const u = Math.min(1, b.t / (L * .8));
        setStage(b, u < .15 ? -1 : u < .4 ? 0 : u < .75 ? 1 : 2);
        shrink(b, Math.max(0, (u - .2) / .8));
        b.scorch.material.opacity = Math.min(.9, b.t / 8);
        tongues(b, dt, ramp * fade);
        if (b.t > L) { b.state = 'smolder'; b.t0 = performance.now(); b.t = 0; stop(b.base); stop(b.skirt); b.base = b.skirt = null; b.fx.fire = 0; b.fx.smoke = .7; setStage(b, 2); shrink(b, 1); }
      } else {
        b.fx.smoke = Math.max(0, .7 - b.t / 25);
        if (b.t > 18) { stop(b.fx); b.fx = null; b.state = 'burnt'; }
      }
    }
    updateOthers(dt);
    // first-person lighter flick
    if (flickT > 0) {
      flickT = Math.max(0, flickT - dt);
      const u = 1 - flickT / FLICK;                     // 0..1
      const up = u < .2 ? u / .2 : u > .8 ? (1 - u) / .2 : 1;
      lg.position.set(-.9, -.95 + up * .9, .1); lg.rotation.set(-.2, .35, .18 - up * .1);
      lg.visible = up > 0;
      const lit = u > .28 && u < .85;
      flame.visible = lit; if (lit) { const f = .8 + Math.random() * .35; flame.scale.set(.09 * f, .16 * f, 1); }
      wheel.rotation.x = u < .3 ? u * 30 : wheel.rotation.x;
    }
  }

  // ---------- server state ----------
  function onMeta(m, fixtures) {
    for (const [id, f] of fixtures) {
      const b = byId.get(id); if (!b) continue;
      const st = m.objects[id] || {};
      if (st.fire) { if (b.state !== 'burning' && b.state !== 'smolder') ignite(b); }
      else if (st.burnt) { if (!b.state || b.state === 'idle') charNow(b); }
      else replant(b);
    }
  }
  function onInv(m) {
    if (!('lighter' in m)) return;   // other pocket items (pliers...) send their own fields
    const had = lighter; lighter = m.lighter || 0;
    const el = document.getElementById('inv');
    el.hidden = !lighter; el.innerHTML = `<i></i>Lighter <em>${lighter}</em>`;
    el.title = `${lighter} lights left`;
    if (lighter && !had) feed2('You have a lighter. Walk up to trash, a bush or a tree and press <kbd>F</kbd>.');
  }
  function feed2(html) { const f = document.getElementById('feed'), d = document.createElement('div'); d.innerHTML = html; f.prepend(d); setTimeout(() => d.remove(), 6000); }
  // Other players see you lean in and spark the lighter at hand height for a moment.
  const others = new Map();   // entity id -> { t, flame }
  function onFlick(isMe, id) {
    if (isMe) { flickT = FLICK; return; }
    const v = window.__net && __net.ents.get(id); if (!v || !v.obj || !v.model) return;
    let o = others.get(id);
    if (!o) {
      const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: 0xFFB347, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      fl.position.set(.22, .05, .42); fl.visible = false; fxl(fl); v.obj.add(fl);
      o = { flame: fl, v }; others.set(id, o);
    }
    o.t = FLICK;
  }
  function updateOthers(dt) {
    for (const [id, o] of others) {
      o.t = Math.max(0, o.t - dt);
      const u = 1 - o.t / FLICK, up = o.t <= 0 ? 0 : u < .2 ? u / .2 : u > .8 ? (1 - u) / .2 : 1;
      o.v.model.g.rotation.x = up * .32;
      const lit = o.t > 0 && u > .28 && u < .85;
      o.flame.visible = lit; if (lit) { const f = .8 + Math.random() * .35; o.flame.scale.set(.12 * f, .22 * f, 1); }
      if (o.t <= 0) others.delete(id);
    }
  }
  // Prompt text for the nearest action, so you know before you press.
  function verb(type, base) {
    if (BURNABLE.has(type) && !lighter) return base + ' (need a lighter)';
    return base;
  }

  // ---------- first-person lighter (left hand) ----------
  const FLICK = 1.1; let flickT = 0;
  const lg = new THREE.Group(); lg.visible = false; vm.add(lg);
  (function () {
    const body = 0xD8343F;
    put(B(.11, .26, .06, .018), body, lg, 0, 0, 0);                                   // translucent-red plastic body
    put(B(.1, .2, .005), 0xF3B7AE, lg, 0, -.02, .031);                                 // label
    put(B(.114, .07, .064, .006), METAL, lg, 0, .16, 0);                               // steel hood
    for (let k = 0; k < 3; k++) put(B(.016, .03, .004), DARKM, lg, -.03 + k * .03, .165, .033); // hood vents
    put(B(.03, .03, .03), 0x2a2a2a, lg, .03, .14, 0);                                   // fork / gas valve
    // glove: fist around the body, thumb on the wheel
    const GL = 'tx:knit|' + 0x7C8299;
    put(B(.16, .2, .11, .045), GL, lg, .03, -.07, -.02);
    for (let k = 0; k < 4; k++) put(CYL(.028, .028, .09, 8), GL, lg, .0, -.13 + k * .045, .055, { rz: Math.PI / 2 });
    tube([[.08, -.04, .03], [.06, .1, .04], [.0, .2, .02]], .03, GL, lg, 8);
    put(new THREE.SphereGeometry(.027, 10, 8), 0xF2C6A0, lg, -.005, .205, .02);
    limb([.07, -.15, -.03], [.2, -.6, -.1], .085, .08, 'tx:canvas|' + 0xE07A2E, lg, 14);
  })();
  const wheel = put(CYL(.028, .028, .05, 12), 0x5E636E, lg, -.015, .205, 0, { rz: Math.PI / 2 });
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: 0xFFB347, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  flame.position.set(-.015, .31, 0); flame.visible = false; lg.add(flame);
  lg.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 10; } });

  // ---------- Sunny Mart sells lighters ----------
  const stick = sign(['LIGHTERS $5'], 1.1, .3, '#E8343F', '#FFFFFF', scene, 4.2, 1.75, -5.93);
  stick.material.toneMapped = false;

  window.__look = (y, p) => { yaw = y; pitch = p; };   // test hooks for in-engine screenshots
  window.__burn = BURN;
  return { update, onMeta, onInv, onFlick, verb, get lighter() { return lighter; }, get flicking() { return flickT > 0; } };
})();
