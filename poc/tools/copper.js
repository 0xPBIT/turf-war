// ===================== copper wire theft (GAME-91) =====================
// Client side of poc/copper.mjs. Draws each lamppost's state (lit, or dark with its hand
// hole pried open and the wiring yanked out onto the sidewalk), the pliers in your hand
// and the stripping animation for you and for everyone watching, plus the pliers chip.
//
// Every mesh here is built once at startup from materials the town already uses, so
// stripping a lamp only flips visibility: no new lights, no shader compiles mid-game.
const COPPER = (() => {
  const COPPER_HEX = 0xD9823B, DARK_LENS = 0x3B3F52, POLE = 0xC8CDDD;
  const lamps = new Map();               // lamp id -> { g, lit, glow, open, base, head }
  let pliers = 0, strip = null;          // strip: { lamp, t0, ms } for your own vagrant
  const watching = new Map();            // vagrant entity id -> { lamp, t0, ms }

  // ---------- models ----------
  // Lineman's pliers: red dipped grips, steel jaws. Built along +y, jaws at the top.
  function pliersMesh() {
    const g = new THREE.Group(), jaw = new THREE.Group(), jaw2 = new THREE.Group();
    for (const [grp2, s] of [[jaw, 1], [jaw2, -1]]) {
      put(B(.022, .16, .016, .006), 0xE8343F, grp2, s * .016, -.06, 0, { rz: s * .12 });       // grip
      put(B(.018, .02, .02, .004), 0x23202E, grp2, s * .018, .03, 0, { rz: s * .12 });         // grip cap
      put(B(.016, .075, .014, .003), METAL, grp2, s * .005, .075, 0, { rz: -s * .08 });        // jaw
      put(B(.006, .03, .014), DARKM, grp2, s * .001, .1, 0);                                    // cutter edge
      g.add(grp2);
    }
    put(CYL(.014, .014, .026, 10), DARKM, g, 0, .04, 0, { rx: Math.PI / 2 });                  // pivot
    g.userData.jaws = [jaw, jaw2];
    return g;
  }
  function snip(p, k) { const [a, b] = p.userData.jaws; a.rotation.z = -k * .22; b.rotation.z = k * .22; }

  // A few metres of wire spilling out of the hand hole and across the sidewalk, cut ends bare.
  function wireSpill(parent, G) {   // G: height of the ground the wire lands on (sidewalk slab = .16)
    // Out of the hole, slumped down the pole, then snaking along the sidewalk both ways.
    const runs = [
      [0x2A2A33, [[0, .8, -.11], [.03, .7, -.19], [.06, .3, -.2], [.12, .03, -.28], [.5, .03, -.42], [.85, .03, -.25], [1.3, .03, -.38]]],
      [0xEDEDED, [[-.01, .79, -.11], [-.03, .68, -.2], [-.07, .25, -.22], [-.16, .03, -.32], [-.55, .03, -.5], [-.9, .03, -.3], [-1.25, .03, -.45]]],
      [0x3FA34D, [[.01, .77, -.11], [.02, .6, -.18], [.0, .15, -.24], [.05, .03, -.42], [-.2, .03, -.75]]],
    ];
    for (const run of runs) run[1] = run[1].map(([x, y, z]) => [x, y < .1 ? y + G : y, z]);
    for (const [hex, pts] of runs) {
      tube(pts, .017, hex, parent, 28);
      const end = pts[pts.length - 1], prev = pts[pts.length - 2];
      const d = new THREE.Vector3(end[0] - prev[0], 0, end[2] - prev[2]).normalize();
      put(CYL(.007, .007, .06, 6), COPPER_HEX, parent, end[0] + d.x * .03, end[1], end[2] + d.z * .03, { rz: Math.PI / 2, ry: Math.atan2(-d.z, d.x) });
    }
    // shredded insulation where the copper got skinned
    let q = 11; const r = () => (q = (q * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 14; i++) put(B(.06 + r() * .07, .01, .016), i % 2 ? 0x2A2A33 : 0xEDEDED, parent, (r() - .5) * 2.2, G + .012, -.2 - r() * .8, { ry: r() * 3 });
    // an empty skin of insulation coiled where they peeled it
    for (let k = 0; k < 3; k++) put(new THREE.TorusGeometry(.14 - k * .015, .012, 6, 18), k % 2 ? 0x2A2A33 : 0xEDEDED, parent, .55 + k * .03, G + .015 + k * .012, -.85, { rx: Math.PI / 2 });
  }

  function buildLamp(l) {
    const g = new THREE.Group(); g.position.set(l.p[0], l.p[1] || 0, l.p[2]); g.rotation.y = l.ry || 0; scene.add(g);
    // lit: a warm glow at the lens and the hand-hole cover screwed shut
    const lit = new THREE.Group(); g.add(lit);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,238,170,.9)'), depthWrite: false, blending: THREE.AdditiveBlending, transparent: true }));
    glow.position.set(0, 6.5, -1.65); glow.scale.set(1.5, 1.1, 1); fxl(glow); lit.add(glow);
    put(B(.1, .22, .016, .004), POLE, lit, 0, .78, -.112);
    for (const y of [.69, .87]) put(CYL(.008, .008, .01, 6), DARKM, lit, 0, y, -.122, { rx: Math.PI / 2 });
    // stripped: dark lens, cover hanging off one screw, black hole, wiring on the ground
    const open = new THREE.Group(); open.visible = false; g.add(open);
    put(B(.3, .035, .52), DARK_LENS, open, 0, 6.585, -1.65);
    put(B(.075, .18, .012), INK, open, 0, .78, -.108);
    const hinge = new THREE.Group(); hinge.position.set(.045, .68, -.116); open.add(hinge);
    put(B(.1, .22, .016, .004), POLE, hinge, -.03, .1, -.02, { rz: 2.5, ry: .5 });
    wireSpill(open, l.gy ?? .16);
    lamps.set(l.id, { g, lit, glow, open, stripped: false, base: new THREE.Vector3(l.p[0], (l.p[1] || 0) + .78, l.p[2]).add(new THREE.Vector3(0, 0, -.14).applyAxisAngle(_up, l.ry || 0)) });
  }
  const _up = new THREE.Vector3(0, 1, 0);
  function setStripped(id, on) {
    const L = lamps.get(id); if (!L || L.stripped === on) return;
    L.stripped = on; L.lit.visible = !on; L.open.visible = on;
  }

  fetch('/town.json').then(r => r.json()).then(m => { for (const l of m.lampposts || []) buildLamp(l); });

  // ---------- effects ----------
  function spark(at, n, power = 1) {
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: i % 3 ? 0xFFD27A : 0xFFFFFF, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.scale.setScalar(.05 + Math.random() * .05); s.position.copy(at); s.layers.set(1);
      s.userData = { t: Math.random() * .3, v: new THREE.Vector3((Math.random() - .5) * 2.4, 1 + Math.random() * 2.2, (Math.random() - .5) * 2.4).multiplyScalar(power) };
      scene.add(s); sparks.push(s);
    }
  }
  function pop(text, at) {
    const v = at.clone().project(camera); if (v.z >= 1) return;
    const d = document.createElement('div'); d.className = 'pop copper'; d.textContent = text;
    d.style.left = ((v.x + 1) / 2 * innerWidth) + 'px'; d.style.top = ((1 - v.y) / 2 * innerHeight) + 'px';
    document.body.appendChild(d); setTimeout(() => d.remove(), 1150);
  }
  const el = id => document.getElementById(id);
  function feed(html) { const f = el('feed'); if (!f) return; const d = document.createElement('div'); d.innerHTML = html; f.prepend(d); setTimeout(() => d.remove(), 5000); while (f.children.length > 5) f.lastChild.remove(); }

  // ---------- HUD: pliers chip and the strip progress bar ----------
  const css = document.createElement('style');
  css.textContent = `#pliersChip{position:fixed;z-index:5;left:max(12px,env(safe-area-inset-left,0px));bottom:calc(136px + env(safe-area-inset-bottom,0px));background:rgba(255,255,255,.94);border-radius:14px;padding:6px 14px;font-size:13.5px;font-weight:700;gap:8px;align-items:center;box-shadow:0 3px 0 rgba(20,60,140,.2);pointer-events:none;display:none}
#pliersChip i{width:9px;height:16px;border-radius:3px;background:linear-gradient(#9AA0B6 0 30%,#E8343F 30%)}
#pliersChip em{font-style:normal;font-variant-numeric:tabular-nums;color:var(--ink-soft)}
#stripBar{position:fixed;z-index:6;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:rgba(255,255,255,.94);border-radius:16px;padding:8px 14px 10px;font-family:var(--display);font-weight:600;font-size:15px;box-shadow:0 3px 0 rgba(20,60,140,.25);display:none;text-align:center;pointer-events:none;min-width:220px}
#stripBar i{display:block;height:10px;border-radius:6px;margin-top:6px;background:#F1E7D8;overflow:hidden}
#stripBar i u{display:block;height:100%;width:0;background:linear-gradient(90deg,#D9823B,#FFB86B);border-radius:6px}
.pop.copper{color:#D9823B;font-size:24px;-webkit-text-stroke:4px #fff}`;
  document.head.appendChild(css);
  const chip = document.createElement('div'); chip.id = 'pliersChip'; document.body.appendChild(chip);
  const bar = document.createElement('div'); bar.id = 'stripBar'; bar.innerHTML = 'Stripping copper wire<i><u></u></i>'; document.body.appendChild(bar);
  function inv(m) {
    if (m.pliers === undefined) return;
    const had = pliers; pliers = m.pliers;
    chip.style.display = pliers > 0 ? 'flex' : 'none';
    chip.innerHTML = `<i></i>Pliers <em>${pliers}</em>`; chip.title = `${pliers} lampposts left in them`;
    if (had > 0 && pliers === 0) feed('Your pliers snapped. Find another pair.');
    else if (!had && pliers > 0) feed('You have pliers. Find a lamppost and press <kbd>E</kbd> to strip its copper wire.');
  }

  // ---------- first-person pliers ----------
  const fpPliers = pliersMesh(); fpPliers.visible = false;
  fpPliers.position.set(-.03, .1, .02); fpPliers.rotation.set(.2, 0, .5); fpPliers.scale.setScalar(2.3); vm.add(fpPliers);
  fpPliers.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 10; } });
  let crouch = 0;
  // Runs after the look test places the camera and hand each frame.
  function viewmodel(dt, t) {
    const k = strip ? Math.min(1, (performance.now() - strip.t0) / strip.ms) : 0;
    crouch += ((strip ? 1 : 0) - crouch) * Math.min(1, dt * 9);
    if (crouch < .01) { if (fpPliers.visible) { fpPliers.visible = false; vm.rotation.z = 0; } return; }
    for (const c of vm.children) if (c !== handG && c !== fpPliers) c.visible = false;   // pocket the held junk; it comes back next frame
    handG.visible = true;
    camera.position.y -= crouch * .55;                              // squat down at the pole base
    heldBottle.visible = false; fpPliers.visible = true;
    // reach in, then a rhythm of snip, twist and yank as the wire comes out
    const cyc = (t * 2.6) % 1, yank = strip && cyc > .7 ? Math.sin((cyc - .7) / .3 * Math.PI) : 0;
    snip(fpPliers, strip ? (cyc < .35 ? Math.sin(cyc / .35 * Math.PI) : 0) : 0);
    vm.position.y += NET.handDrop() * crouch;                       // empty hands sit out of view (GAME-82): bring the glove up
    vm.position.x -= crouch * .04; vm.position.y += crouch * (.015 - yank * .03); vm.position.z -= crouch * (.05 - yank * .05);
    vm.rotation.x += crouch * (-.12 + yank * .22); vm.rotation.z = crouch * (.08 + Math.sin(t * 9) * .025 * (strip ? 1 : 0));
    if (strip) bar.querySelector('u').style.width = (k * 100).toFixed(1) + '%';
  }

  // ---------- other vagrants stripping ----------
  function thirdPerson(v) {
    if (!v.model) return null;
    if (!v.pliers) { const p = pliersMesh(); p.position.set(.08, .78, .42); p.rotation.set(1.1, 0, -.3); p.scale.setScalar(2.4); v.model.g.add(p); v.pliers = p; }
    return v;
  }
  function frame(dt, t) {
    const ents = window.__net && window.__net.ents; if (!ents) return;
    const now = performance.now();
    for (const [id, w] of watching) {
      const v = ents.get(id); if (!v || !v.obj || !thirdPerson(v)) { watching.delete(id); continue; }
      const L = lamps.get(w.lamp);
      if (L) v.obj.rotation.y = Math.atan2(L.base.x - v.obj.position.x, L.base.z - v.obj.position.z);
      const cyc = (t * 2.6) % 1, yank = cyc > .7 ? Math.sin((cyc - .7) / .3 * Math.PI) : 0;
      v.model.g.position.y = -0.9 - .45 + yank * .06;                // down on their haunches at the pole
      v.model.g.rotation.x = .5 - yank * .22;                         // leaning in, rocking back on each yank
      v.model.g.rotation.z = Math.sin(t * 9) * .03;
      v.model.head.rotation.x = .25;
      if (v.model.arms) v.model.arms.forEach((pv, i) => { pv.rotation.x = -1.15 + yank * .5; pv.rotation.z = (i ? 1 : -1) * .22; });   // both hands on the wire
      v.pliers.visible = true; snip(v.pliers, cyc < .35 ? Math.sin(cyc / .35 * Math.PI) : 0);
      if (L && Math.random() < dt * 5) spark(L.base, 2, .7);
    }
    if (strip) { const L = lamps.get(strip.lamp); if (L && Math.random() < dt * 5) spark(L.base, 2, .7); }
  }
  function stopWatching(id) {
    const v = window.__net && window.__net.ents.get(id);
    if (v && v.model) { v.model.g.rotation.x = 0; v.model.head.rotation.x = 0; if (v.pliers) v.pliers.visible = false; if (v.model.arms) v.model.arms.forEach(pv => { pv.rotation.x = 0; pv.rotation.z = 0; }); }
    watching.delete(id);
  }

  // ---------- server events ----------
  function fx(m) {
    const mine = window.__net && m.id === window.__net.me, L = lamps.get(m.lamp);
    if (m.phase === 'start') {
      if (mine) { strip = { lamp: m.lamp, t0: performance.now(), ms: m.ms }; bar.style.display = 'block'; bar.querySelector('u').style.width = '0%'; }
      else watching.set(m.id, { lamp: m.lamp });
      if (L) spark(L.base, 6, .8);
    } else {
      if (mine) { strip = null; bar.style.display = 'none'; } else stopWatching(m.id);
      if (m.phase === 'done') {
        setStripped(m.lamp, true);
        if (L) { spark(L.base, 18, 1.2); spark(L.base.clone().setY(6.55).add(new THREE.Vector3(0, 0, -1.65).applyAxisAngle(_up, L.g.rotation.y)), 10, .6); dust(L.base.clone().setY(.2), 4, 0xcbbfa8); pop('COPPER!', L.base.clone().setY(1.9)); }
        if (mine) feed(`You yank out the copper. <b>+$${m.cash}</b> scrap. ${m.left > 0 ? `Pliers: ${m.left} ${m.left === 1 ? 'use' : 'uses'} left.` : ''}`);
      } else if (mine && m.why === 'moved') feed('You let go of the wire.');
    }
  }
  function meta(m) { for (const id of lamps.keys()) setStripped(id, !!(m.objects[id] && m.objects[id].stripped)); }

  // Prompt text for the E button. Returns null for things that are not ours.
  function verb(type, base) { return type === 'lamppost' && !pliers ? base + ' (need pliers)' : base; }
  const busy = () => !!strip;

  window.__copper = { lamps, get pliers() { return pliers; }, get strip() { return strip; }, setStripped };
  return { fx, meta, inv, verb, frame, viewmodel, busy, pliersMesh };
})();
