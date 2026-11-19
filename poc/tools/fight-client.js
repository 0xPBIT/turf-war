// ===================== fist fights and hit reactions (GAME-85) =====================
// Punching with empty hands, being hit (by fists, thrown things or cars), knockouts,
// and the arm poses that let other vagrants and townsfolk throw hands.
const FIGHT = (() => {
  const MAX_HP = 100;
  const own = { hp: MAX_HP, downUntil: 0, staggerUntil: 0, lastHit: 0, lastPunch: 0, punchT: 0, hand: 'R', flash: 0, shake: 0, ko: 0, kb: new THREE.Vector3() };
  const now = () => performance.now();

  // ---------- HUD: health pill, hurt vignette, knocked-out card ----------
  const css = document.createElement('style');
  css.textContent = `
#hpWrap{position:fixed;z-index:5;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.92);border-radius:999px;padding:5px 12px 5px 10px;box-shadow:0 3px 0 rgba(20,60,140,.22);pointer-events:none;font-family:var(--display);font-weight:700;font-size:13px;color:var(--ink);transition:opacity .4s}
#hpWrap.full{opacity:.55}
#hpBar{width:120px;height:10px;border-radius:999px;background:#F1E4EC;overflow:hidden}
#hpBar i{display:block;height:100%;width:100%;border-radius:999px;background:linear-gradient(90deg,#FF6E9E,#FFC93C);transition:width .15s}
#hurtVig{position:fixed;inset:0;z-index:3;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,60,80,0) 45%,rgba(200,20,50,.55) 100%)}
#koCard{position:fixed;z-index:6;left:50%;top:38%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;display:none}
#koCard b{display:block;font-family:var(--display);font-weight:700;font-size:44px;color:#fff;-webkit-text-stroke:6px #E8343F;paint-order:stroke fill;letter-spacing:1px}
#koCard span{display:inline-block;margin-top:6px;background:rgba(255,255,255,.94);border-radius:14px;padding:5px 12px;font-weight:700;font-size:14px;color:var(--ink)}
.pop.pow{color:#FFC93C;font-size:30px;-webkit-text-stroke:6px #E8343F}
.pop.paid{color:#26B07A;font-size:24px}
@media (pointer:coarse){ #hpWrap{bottom:calc(150px + env(safe-area-inset-bottom,0px))} }`;
  document.head.appendChild(css);
  const hud = document.createElement('div');
  hud.innerHTML = `<div id="hpWrap" class="full">♥<div id="hpBar"><i></i></div></div><div id="hurtVig"></div><div id="koCard"><b>KNOCKED OUT</b><span id="koSub"></span></div>`;
  document.body.append(...hud.children);
  const $ = id => document.getElementById(id);
  let koPaid = 0;
  function drawHp() {
    $('hpBar').firstChild.style.width = Math.max(0, own.hp) + '%';
    $('hpWrap').classList.toggle('full', own.hp >= MAX_HP);
  }

  // ---------- sounds ----------
  let ac = null;
  function sfx(kind, at) {
    const d = at ? camera.position.distanceTo(new THREE.Vector3(...at)) : 0; if (d > 35) return;
    try { ac ||= new AudioContext(); } catch { return; }
    const vol = (1 - d / 35) * SET.vol(); if (vol <= 0) return;
    const len = kind === 'swoosh' ? .16 : .12, buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, kind === 'swoosh' ? 1.5 : 4);
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = kind === 'swoosh' ? 'bandpass' : 'lowpass'; f.frequency.value = kind === 'swoosh' ? 1400 : kind === 'bonk' ? 900 : 420;
    const g = ac.createGain(); g.gain.value = (kind === 'swoosh' ? .05 : .32) * vol;
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start();
    if (kind !== 'swoosh') { const o = ac.createOscillator(), og = ac.createGain(); o.frequency.setValueAtTime(kind === 'bonk' ? 520 : 140, ac.currentTime); o.frequency.exponentialRampToValueAtTime(60, ac.currentTime + .12); og.gain.value = .12 * vol; og.gain.exponentialRampToValueAtTime(.001, ac.currentTime + .14); o.connect(og); og.connect(ac.destination); o.start(); o.stop(ac.currentTime + .15); }
  }

  // ---------- first-person fists ----------
  // Same fingerless knit gloves and orange canvas sleeves as the bottle hand.
  const HAND = { glove: 0x7C8299, skin: 0xF2C6A0 };
  function fist(side) {
    const root = new THREE.Group();
    const h = glove(root, [0, 0, 0], [0, 1, 0], HAND, false);
    // knuckles forward (glove +y -> -z), palm down (glove +z -> -y), turned in a little
    h.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)))
      .premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side * .25, side * -.35)));
    h.scale.setScalar(1.2);
    const end = new THREE.Vector3(side * .1, -.3, .34);                  // forearm runs back and down out of view
    limb([0, -.004, .05], end.toArray(), .034, .044, 'tx:canvas|' + 0xE07A2E, root, 14);
    put(CYL(.05, .05, .035, 12), 'tx:knit|' + 0x9AA3B8, root, 0, -.002, .055, { rx: Math.PI / 2 - .55 });  // hoodie cuff
    put(CYL(.043, .043, .025, 14), 0xB85E1E, root, side * .008, -.02, .09, { rx: Math.PI / 2 - .6 });     // sleeve hem
    root.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 10; } });
    camera.add(root); root.visible = false; return root;
  }
  const fists = { L: fist(-1), R: fist(1) };
  const REST = { L: new THREE.Vector3(-.15, -.2, -.42), R: new THREE.Vector3(.15, -.195, -.41) };
  const HIT = { L: new THREE.Vector3(-.04, -.09, -.66), R: new THREE.Vector3(.04, -.09, -.66) };
  const _v = new THREE.Vector3();

  // Empty hands (GAME-82 window.__net.held is null) mean fists.
  const holding = () => (window.__net && 'held' in window.__net) ? window.__net.held != null : true;
  const isDown = () => now() < own.downUntil;

  function punch(dir) {
    const t = now();
    if (isDown() || t - own.lastPunch < 420 || !NET.me) return;
    own.lastPunch = t;
    own.hand = holding() ? 'L' : (own.hand === 'L' ? 'R' : 'L');   // bottle in the right hand: jab with the left
    own.punchT = 1;
    sfx('swoosh');
    NET.send({ t: 'punch', dir: { x: dir.x, y: dir.y, z: dir.z } });
  }

  // ---------- movement while hurt (mirrors combat.mjs moveMod) ----------
  function speedScale() { const t = now(); return t < own.downUntil ? 0 : t < own.staggerUntil ? .35 : 1; }
  // Knockback for one movement tick (GAME-99: fed into the shared movement step, like the server's moveMod).
  function kick(dt) {
    if (own.kb.lengthSq() <= 1e-4) return null;
    const k = { x: own.kb.x * dt, z: own.kb.z * dt };
    own.kb.multiplyScalar(Math.exp(-dt * 7));
    return k;
  }
  function afterStep() {}

  // ---------- events from the server ----------
  function stars() {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96; const g = cv.getContext('2d');
    g.font = '700 64px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 10; g.strokeStyle = '#fff'; g.fillStyle = '#FFC93C';
    g.strokeText('✦ ✦ ✦', 128, 50); g.fillText('✦ ✦ ✦', 128, 50);
    const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx, depthWrite: false, transparent: true, fog: false })); s.scale.set(.75, .28, 1); fxl(s); return s;
  }
  const headAt = v => [v.obj.position.x, v.obj.position.y + (v.down ? -.4 : 1.1), v.obj.position.z];
  const fx = v => v.fight || (v.fight = { punch: 0, hand: 'R', hurt: 0, fall: v.down ? 1 : 0, guardUntil: 0 });
  function onFx(m) {
    const meId = NET.me, v = NET.ents.get(m.id);
    if (m.kind === 'punch') {
      if (m.id === meId || !v || !v.model) return;
      const F = fx(v); F.punch = 1; F.hand = m.hand; F.guardUntil = now() + 4000;
      sfx('swoosh', headAt(v));
    } else if (m.kind === 'hurt') {
      const bonk = m.cause === 'item';
      if (m.id === meId) {
        own.hp = m.hp; own.lastHit = now(); own.staggerUntil = now() + 350; own.flash = 1; own.shake = bonk ? .05 : .035;
        if (m.push) own.kb.add(new THREE.Vector3(m.push[0], 0, m.push[2]));
        if (m.paid) { koPaid += m.paid; const at = camera.getWorldDirection(_v).multiplyScalar(1.2).add(camera.position); NET.popText('+' + NET.money(m.paid), [at.x, at.y - .2, at.z], 'paid'); }
        if (m.cause === 'car') NET.feed(`Hit by a car! <b>+${NET.money(m.paid)}</b> for your pain and suffering.`);
        drawHp(); sfx(bonk ? 'bonk' : 'thud');
      } else if (v && v.model) {
        const F = fx(v); F.hurt = 1;
        const at = headAt(v);
        NET.popText(m.cause === 'punch' ? ['POW!', 'BAM!', 'WHAP!', 'OOF!'][Math.floor(Math.random() * 4)] : m.cause === 'car' ? 'WHAM!' : 'BONK!', [at[0], at[1] + .5, at[2]], 'pow');
        sfx(bonk ? 'bonk' : 'thud', at);
        dust(new THREE.Vector3(at[0], at[1] - .1, at[2]), 3, 0xE8E0D0);
        if (m.by === meId && m.paid === 0 && v.kind === 'vagrant') NET.feed(`You hit <b>${NET.esc(v.name)}</b>. They got paid for it.`);
      }
    } else if (m.kind === 'ko') {
      if (m.id === meId) {
        own.downUntil = now() + m.ms; own.hp = 0; drawHp();
        $('koSub').textContent = koPaid ? `+${NET.money(koPaid)} in damages. Getting up in a sec...` : 'Getting up in a sec...';
        $('koCard').style.display = 'block';
      } else if (v && v.model) {
        v.down = 1; NET.popText('K.O.!', headAt(v), 'pow');
        if (m.by === meId) NET.feed(`You knocked out <b>${NET.esc(v.name || 'someone')}</b>!`);
      }
    } else if (m.kind === 'koup') {
      if (m.id === meId) { own.downUntil = 0; own.hp = MAX_HP; koPaid = 0; drawHp(); $('koCard').style.display = 'none'; }
      else if (v) v.down = 0;
    } else if (m.kind === 'thud') { sfx('thud', m.at); dust(new THREE.Vector3(...m.at), 3, 0xE8E0D0); }
  }
  function onMeta(m) {
    for (const v of NET.ents.values()) {
      if (v.kind !== 'npc' && v.kind !== 'vagrant') continue;
      const st = m.objects[v.id] || {};
      v.angry = !!st.angry; if (!v.own) v.down = !!st.down;
    }
  }

  // ---------- poses for other vagrants and townsfolk ----------
  const ease = k => 1 - Math.pow(1 - k, 3);
  function pose(v, dt, t) {
    const m = v.model; if (!m) return;
    const F = fx(v), g = m.g;
    F.punch = Math.max(0, F.punch - dt / (F.hand === 'T' ? .5 : .3));
    F.hurt = Math.max(0, F.hurt - dt * 3);
    F.fall = Math.min(1, Math.max(0, F.fall + (v.down ? dt * 3.2 : -dt * 1.6)));
    const guard = v.angry || now() < F.guardUntil;
    const k = F.punch > 0 ? Math.sin((1 - F.punch) * Math.PI) : 0;
    if (m.sign) m.sign.visible = !guard && !v.down && F.fall === 0;
    if (F.stars) F.stars.visible = !!v.down;
    // Not fighting: leave the walk / grab arm animation alone.
    if (!guard && !v.down && F.punch === 0 && F.hurt === 0 && F.fall === 0) return;
    if (m.arms && m.arms.length === 2) {
      const [L, R] = m.arms, base = guard ? -.95 : 0;
      L.rotation.set(base, 0, guard ? .32 : 0); R.rotation.set(base, 0, guard ? -.32 : 0);
      if (F.punch > 0) {
        if (F.hand === 'T') { const p = 1 - F.punch; R.rotation.x = p < .4 ? -2.8 * (p / .4) : -2.8 + 2.0 * ((p - .4) / .6); R.rotation.z = -.1; }
        else { const A = F.hand === 'L' ? L : R; A.rotation.x = base + (-1.6 - base) * k; A.rotation.z *= 1 - k * .7; }
      }
      if (v.down) { L.rotation.set(-2.6, 0, .5); R.rotation.set(-2.4, 0, -.6); }   // sprawled
    }
    const twist = F.punch > 0 && F.hand !== 'T' ? (F.hand === 'R' ? -1 : 1) * .35 * k : 0;
    g.rotation.y = twist;
    g.rotation.x = (guard ? .1 : 0) + .15 * k - .4 * F.hurt - Math.PI / 2 * ease(F.fall);
    g.rotation.z += Math.sin(t * 18) * F.hurt * .18;
    if (F.fall > 0) g.position.y = -.9 + .12 * ease(F.fall);
    if (v.down && !F.stars) { F.stars = stars(); F.stars.position.set(0, 2.0, 0); g.add(F.stars); }
    if (F.stars) { F.stars.visible = !!v.down; F.stars.material.rotation = Math.sin(t * 3) * .3; F.stars.position.x = Math.sin(t * 4) * .08; }
  }

  // ---------- camera: hurt shake, knocked-out view, fists ----------
  function afterCamera(dt, t) {
    const down = isDown();
    own.ko = Math.min(1, Math.max(0, own.ko + (down ? dt * 3 : -dt * 1.5)));
    if (own.ko > 0) {
      const k = ease(own.ko);
      camera.position.y -= 1.0 * k;
      camera.rotation.x += (1.1 - camera.rotation.x) * k * .85;
      camera.rotation.z += .55 * k + Math.sin(t * 1.7) * .05 * k;
    }
    if (down && $('koCard').style.display === 'none') $('koCard').style.display = 'block';
    if (!down && $('koCard').style.display !== 'none' && own.downUntil === 0) $('koCard').style.display = 'none';
    if (own.shake > 0) { camera.rotation.x += (Math.random() - .5) * own.shake; camera.rotation.y += (Math.random() - .5) * own.shake; own.shake = Math.max(0, own.shake - dt * .25); }
    own.flash = Math.max(0, own.flash - dt * 2.2);
    $('hurtVig').style.opacity = Math.max(own.flash, down ? .6 : 0, own.hp < 35 ? .25 + Math.sin(t * 5) * .08 : 0).toFixed(3);
    if (!down && own.hp < MAX_HP && now() - own.lastHit > 4000) { own.hp = Math.min(MAX_HP, own.hp + 8 * dt); if (Math.floor(own.hp) % 4 === 0 || own.hp >= MAX_HP) drawHp(); }
    vm.visible = !down;                 // the bottle hand drops out of view while you're out cold
    // fists
    own.punchT = Math.max(0, own.punchT - dt / .28);
    const empty = !holding(), pk = own.punchT > 0 ? Math.sin((1 - own.punchT) * Math.PI) : 0;
    for (const h of ['L', 'R']) {
      const f = fists[h], active = own.punchT > 0 && own.hand === h;
      f.visible = !down && (empty || active) && !(window.__net && window.__net.busy);   // GAME-82 reach/dig uses the gloved hand
      if (!f.visible) continue;
      const k = active ? pk : 0;
      _v.copy(REST[h]).lerp(HIT[h], k);
      _v.y += Math.sin(t * 2.2 + (h === 'L' ? 1 : 0)) * .006 - (empty ? 0 : (1 - k) * .2);
      f.position.copy(_v);
      f.rotation.set(-k * .25, (h === 'L' ? 1 : -1) * (.12 - k * .1), (h === 'L' ? -1 : 1) * k * .3);
    }
  }

  // Runs last, after every viewmodel module has posed the hand (GAME-98). The idle fists are
  // the default empty-handed pose, so they step aside whenever something else owns the view:
  // an interaction animation raising the gloved hand (ANIM, reach/dig, grab, copper, wrench),
  // the lighter flick, a knockout, or your own ragdoll (both hide vm). A punch still shows.
  function afterViewmodel() {
    const other = handG.visible || FIRE.flicking;
    for (const h of ['L', 'R']) {
      const f = fists[h]; if (!f.visible) continue;
      if (!vm.visible || NET.ragdolled || (other && !(own.punchT > 0 && own.hand === h))) f.visible = false;
    }
  }

  drawHp();
  window.__fight = { own, pose, onFx, send: o => NET.send(o) };
  return { holding, punch, speedScale, afterStep, kick, onFx, onMeta, pose, afterCamera, afterViewmodel, isDown };
})();
