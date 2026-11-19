// ===================== city vagrants (GAME-93) =====================
// Replaces the look test's camper/hiker vagrant (canvas field jacket, bedroll, hiking boots)
// with city street looks: hoodies, puffers, track jackets, flannels and bombers over joggers,
// baggy jeans or cargos, sneakers or slides with socks, caps, watch caps, hoods and bucket hats.
// Same skin, sleepy face and fingerless gloves as before, so the first-person hand still matches.
//
// Part layout shared with the ragdoll (GAME-83) and fist fights (GAME-85): p.parts holds six
// THREE.Groups, all children of p.g (origin at the feet, facing +z), each pivoting at its joint
// with an identity rest rotation:
//   torso (hips, ~(0,.92,0)), head (neck), armL / armR (shoulders, arm hangs straight down),
//   legL / legR (hips). armL / legL are on -x. parts.foreL / foreR are children of the arms at
//   the elbows. p.head === parts.head, p.sign is the panhandler's cardboard sign.
// Look keys stay compatible with npcs.json (coat, coatSh, hat, hatSh, pants, hoodie, skin, skinSh,
// beard, scarf, pack, roll, boot, brow, sign); style keys (top, bottom, shoe, headwear, hair,
// face, acc) are optional and picked from a seed when missing.

// extra fabrics: heather fleece (hoodies, joggers), nylon (puffers, bombers), plaid (flannels)
mkTex('fleece', 128, .28, (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); speckle(g, s, 2600, ['rgba(0,0,0,.10)', 'rgba(255,255,255,.18)', 'rgba(40,40,80,.08)'], 1.3); for (let x = 0; x < s; x += 4) { g.fillStyle = 'rgba(0,0,0,.04)'; g.fillRect(x, 0, 1, s); } blotch(g, s, 5, 'rgba(60,40,30,.08)', 8, 26); }, 1.4);
mkTex('nylon', 128, .5, (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); for (let y = 0; y < s; y += 2) { g.fillStyle = 'rgba(0,0,0,.035)'; g.fillRect(0, y, s, 1); } speckle(g, s, 500, ['rgba(0,0,0,.08)', 'rgba(255,255,255,.2)'], 1.1); blotch(g, s, 4, 'rgba(50,40,30,.09)', 10, 30); }, 1.3);
mkTex('plaid', 128, .32, (g, s) => { g.fillStyle = '#fff'; g.fillRect(0, 0, s, s); g.fillStyle = 'rgba(20,20,40,.42)'; g.fillRect(0, 0, s, s * .34); g.fillRect(0, 0, s * .34, s);
  g.fillStyle = 'rgba(20,20,40,.25)'; g.fillRect(0, s * .6, s, s * .08); g.fillRect(s * .6, 0, s * .08, s); g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(0, s * .82, s, 3); g.fillRect(s * .82, 0, 3, s);
  for (let y = 0; y < s; y += 2) { g.fillStyle = 'rgba(0,0,0,.05)'; g.fillRect(0, y, s, 1); } speckle(g, s, 400, ['rgba(0,0,0,.08)', 'rgba(255,255,255,.12)'], 1.2); }, 1.2);

const CITY = {
  tops: ['hoodie', 'puffer', 'track', 'flannel', 'bomber'],
  bottoms: ['joggers', 'baggy', 'cargo', 'trackpants'],
  shoes: ['runner', 'hightop', 'slides'],
  headwear: ['cap', 'capBack', 'watch', 'hood', 'bucket', 'cap', 'watch', 'hood', 'none'],
  hair: ['buzz', 'fro', 'messy', 'curls', 'buzz', 'messy', 'bald'],
  face: ['scruff', 'goatee', 'beard', 'stache', 'clean'],
  pants: [0x2B2D35, 0x4A4E5C, 0x8E93A3, 0x2E3F66, 0x5B6B45, 0x4D6FC9, 0x7FA0D8, 0x8A7356],
  shoeCol: [0xF4F2EE, 0x2B2D35, 0xE8343F, 0x8E93A3, 0x3FA8E8, 0xF2C230],
  hats: [0x2B2D35, 0xE8343F, 0x2E3F66, 0xF4F2EE, 0xD9A400, 0x26A37A, 0xFF5D8F],
  inner: [0xF4F2EE, 0x8E93A3, 0x2B2D35, 0x7A3E4E, 0x3E5A8A, 0x3E7A5A],
  hairCol: [0x1E1814, 0x2E221A, 0x5A3A2A, 0x8B5A3C, 0xD9C6A8, 0xB04A2A],
  accent: [0xE8343F, 0x3FA8E8, 0xF2C230, 0xF4F2EE, 0x26D3A0],
};
function cityShade(hex, l) { const c = new THREE.Color(hex); c.offsetHSL(0, 0, l); return c.getHex(); }
function cityMix(a, b, t) { return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex(); }
function citySeed(v) { let h = 7; for (const ch of String(v)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
// Seeds are mixed first: ids like 'p1', 'p2' hash to nearby numbers, which would otherwise pick near-identical outfits.
function cityRng(seed) { let h = seed >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B); h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35); h ^= h >>> 16; let q = ((h >>> 0) % 2147483646) + 1; const next = () => (q = (q * 16807) % 2147483647) / 2147483647; next(); next(); return next; }
// Fills every style key the caller left out, picked from a seed so the same vagrant always looks the same.
function cityStyle(o, seed) {
  const r = cityRng(seed), pick = a => a[Math.floor(r() * a.length) % a.length];
  const s = { top: pick(CITY.tops), bottom: pick(CITY.bottoms), shoe: pick(CITY.shoes), headwear: pick(CITY.headwear), hair: pick(CITY.hair), face: pick(CITY.face) };
  const acc = []; for (const a of ['headphones', 'shades', 'chain', 'sling', 'daypack', 'tape']) if (r() < (a === 'tape' ? .45 : .28)) acc.push(a);
  if (s.headwear === 'hood' && !['hoodie', 'bomber'].includes(o.top ?? s.top)) s.headwear = 'watch';
  return { ...s, acc, pants: pick(CITY.pants), boot: pick(CITY.shoeCol), hat: pick(CITY.hats), hoodie: pick(CITY.inner), hair: s.hair, hairCol: pick(CITY.hairCol), accent: pick(CITY.accent), ...o };
}
// Look for a networked vagrant: the player's colour is the outer layer, the rest comes from their id.
const CITY_SKINS = [[0xFFD9B8, 0xE9AE88], [0xC98A5E, 0xA86F48], [0xFFE7D6, 0xF0C4A6], [0x8D5A3B, 0x6E432B], [0xE8B48A, 0xC98F66]];
function charLook(id, color) {
  const h = citySeed(id), coat = new THREE.Color(color || '#ff6e9e').getHex(), [skin, skinSh] = CITY_SKINS[h % CITY_SKINS.length];
  const hairCol = CITY.hairCol[(h >> 4) % CITY.hairCol.length];
  return cityStyle({ coat, coatSh: cityShade(coat, -.12), skin, skinSh, beard: hairCol, hairCol }, h);
}
window.charLook = charLook;

// The client turns bake() off while it builds networked vagrants (it splits and bakes old
// models itself); these parts are already split, so they always bake with the real one.
const cityBake = bake;
function vagrant(o) {
  o = { skin: 0xFFD9B8, skinSh: 0xE9AE88, beard: 0x2E221A, glove: 0x4A4A5E, coat: 0xFF6E9E, ...o };
  o = cityStyle(o, citySeed([o.coat, o.skin, o.beard, o.hat, o.pants].join()));
  o.coatSh ??= cityShade(o.coat, -.12); o.hatSh ??= cityShade(o.hat, -.1); o.hairCol ??= o.beard;
  if (o.scarf) o.accent = o.scarf;                       // old scarf colour becomes the accent (headphones, stripes)
  const acc = new Set(o.acc), S = o.skin, top = o.top, C = o.coat, CS = o.coatSh;
  const fab = { hoodie: 'tx:fleece|', puffer: 'tx:nylon|', track: '', flannel: 'tx:plaid|', bomber: 'tx:nylon|' }[top] ?? 'tx:fleece|';
  const TOP = fab ? fab + C : C, TOPSH = fab ? fab + CS : CS;
  const IN = 'tx:fleece|' + o.hoodie;                    // inner layer: hoodie or tee under the jacket
  const PANT = (o.bottom === 'baggy' ? 'tx:denim|' : o.bottom === 'cargo' ? 'tx:canvas|' : 'tx:fleece|') + o.pants;
  const g = new THREE.Group(), parts = {};
  // Builds a part in body coordinates, bakes it (optionally posed by quaternion q about the
  // pivot, so a posed part still rests at identity), and returns it pivoting at `pivot`.
  const part = (name, pivot, build, q) => { const P = new THREE.Group(), Q = new THREE.Group(), I = new THREE.Group(); if (q) Q.quaternion.copy(q); I.position.set(-pivot[0], -pivot[1], -pivot[2]); Q.add(I); P.add(Q); build(I); cityBake(P); P.remove(Q); P.position.set(...pivot); parts[name] = P; return P; };

  // ---------- legs + shoes ----------
  for (const [name, s] of [['legL', -1], ['legR', 1]]) g.add(part(name, [s * .1, .92, 0], L => {
    const x = s * .1, baggy = o.bottom === 'baggy';
    const rT = baggy ? .1 : o.bottom === 'cargo' ? .09 : .086, rK = baggy ? .095 : .078, rA = baggy ? .1 : o.bottom === 'cargo' ? .072 : .06;
    limb([x, .92, 0], [x, .52, .01], rK, rT, PANT, L, 12);
    limb([x, .52, .01], [x * 1.05, baggy ? .1 : .16, 0], rA, rK, PANT, L, 12);
    if (baggy) { for (const [y, r] of [[.13, .108], [.2, .104], [.29, .1]]) put(new THREE.TorusGeometry(r, .016, 6, 14), PANT, L, x * 1.05, y, 0, { rx: Math.PI / 2 + (y - .2) * 1.5 }); // stacked hem
      if ((citySeed(o.coat) >> 3) % 2) put(B(.07, .05, .012, .006), S, L, x, .55, .085, { rz: .3 * s }); } // ripped knee
    else put(CYL(rA + .004, rA + .004, .07, 12), 'tx:knit|' + o.pants, L, x * 1.05, .19, 0);        // ribbed ankle cuff
    if (o.bottom === 'cargo') { put(B(.035, .12, .1, .01), PANT, L, x + s * .085, .62, .0); put(B(.04, .025, .11, .008), PANT, L, x + s * .088, .69, .0); }
    if (o.bottom === 'trackpants') put(B(.006, .74, .02), 0xF4F2EE, L, x + s * .084, .56, 0, { rz: s * -.01 });
    // shoes
    const f = grp(L, x * 1.05, 0, .02), U = o.boot, W = 0xF4F2EE;
    if (o.shoe === 'slides') {
      put(B(.1, .05, .2, .02), W, f, 0, .05, .03); put(CYL(.052, .055, .13, 10), W, f, 0, .12, -.02);           // white socks
      put(CYL(.056, .056, .03, 10), 0xC9CCD4, f, 0, .17, -.02);
      put(B(.12, .03, .28, .012), 0x2B2D35, f, 0, .015, .03); put(B(.125, .035, .11, .015), U === W ? 0x2B2D35 : U, f, 0, .05, .07);
    } else {
      const high = o.shoe === 'hightop';
      put(B(.125, high ? .05 : .042, .3, .015), W, f, 0, high ? .025 : .021, .03);                       // midsole
      put(B(.127, .012, .302, .005), 0x8E93A3, f, 0, .004, .03);                                          // outsole
      put(B(.115, high ? .12 : .08, .25, .04), U, f, 0, high ? .1 : .075, .02);                           // upper
      put(B(.11, .05, .08, .025), U === W ? 0xE8E4EA : W, f, 0, high ? .07 : .06, .14);                   // toe cap
      put(B(.06, .006, .12, .003), U === W ? 0x8E93A3 : W, f, 0, high ? .165 : .118, .07, { rx: -.35 });  // laces
      for (const sd of [-1, 1]) put(B(.006, .028, .13, .003), o.accent ?? 0xE8343F, f, sd * .059, high ? .09 : .07, .0, { rz: 0, rx: -.25 }); // side stripe
      if (high) put(CYL(.072, .075, .09, 12), U, f, 0, .2, -.02); else put(B(.08, .05, .04, .015), U, f, 0, .11, -.1);
    }
  }));

  // ---------- torso ----------
  const T = part('torso', [0, .92, 0], t => {
    put(CYL(.175, .17, .14, 16), PANT, t, 0, .92, 0, { s: [1, 1, .72] });                         // seat / hips
    put(CYL(.178, .178, .04, 16), o.bottom === 'baggy' ? 0x3B2C26 : 'tx:knit|' + o.pants, t, 0, .985, 0, { s: [1, 1, .73] }); // belt or waistband
    if (o.bottom === 'baggy') put(CYL(.16, .16, .03, 16), 'tx:knit|0xF4F2EE', t, 0, 1.02, 0, { s: [1, 1, .7] }); // boxers showing
    const prof = (w, y0) => [[.19 + w, y0], [.2 + w, .92], [.215 + w, 1.1], [.225 + w, 1.26], [.21 + w, 1.36], [.15 + w, 1.43], [.07, 1.47]];
    const shell = (pts, key, ps, pl, sz = .72) => lathe(pts, key, t, 22, ps ?? 0, pl ?? Math.PI * 2).scale.set(1, 1, sz);
    const hoodBack = key => { put(new THREE.SphereGeometry(.14, 12, 8), key, t, 0, 1.42, -.13, { s: [1.15, .62, .6] }); for (const s of [-1, 1]) limb([s * .045, 1.42, .14], [s * .05, 1.2, .175], .008, .008, 0xE8E4F0, t, 6); };
    if (top === 'hoodie') {
      shell(prof(0, .82), TOP);
      put(CYL(.2, .195, .06, 20), 'tx:knit|' + CS, t, 0, .83, 0, { s: [1, 1, .73] });          // hem band
      put(B(.24, .13, .02, .012), TOPSH, t, 0, .99, .158, { rx: -.08 });                        // kangaroo pocket
      put(B(.09, .06, .004), o.accent ?? 0xF4F2EE, t, 0, 1.24, .17, { rx: -.12 });              // chest print
      if (o.headwear !== 'hood') hoodBack(TOP);
    } else if (top === 'puffer') {
      const pts = []; for (let i = 0; i <= 24; i++) { const y = .8 + i * .027, k = i / 24; const base = k < .55 ? .225 + k * .06 : .258 - (k - .55) * .2; pts.push([base + .02 + Math.abs(Math.sin(i * Math.PI / 4)) * .022, y]); }
      pts.push([.12, 1.47]); shell(pts, TOP, 0, Math.PI * 2, .78);
      put(CYL(.115, .135, .12, 18), TOP, t, 0, 1.47, .0, { s: [1, 1, .85] });                 // tall collar
      put(B(.014, .62, .012), 0x2B2D35, t, 0, 1.12, .215);                                       // zipper
      put(B(.03, .05, .012, .004), 0xC9CCD4, t, .01, 1.4, .222);
      if (acc.has('tape')) { put(B(.12, .025, .006), 0xC9CCD4, t, -.1, 1.05, .225, { rz: .7 }); put(B(.12, .025, .006), 0xC9CCD4, t, -.1, 1.05, .226, { rz: -.7 }); } // duct tape patch
    } else if (top === 'track') {
      shell(prof(-.01, .84), TOP);
      put(CYL(.2, .19, .05, 20), CS, t, 0, .85, 0, { s: [1, 1, .73] });
      put(CYL(.1, .115, .07, 18), CS, t, 0, 1.46, 0, { s: [1, 1, .9] });                       // stand collar
      put(B(.012, .58, .012), 0xC9CCD4, t, 0, 1.15, .162); put(B(.025, .045, .01, .004), 0xC9CCD4, t, .0, 1.38, .158);
      for (const s of [-1, 1]) put(B(.02, .5, .006), o.accent ?? 0xF4F2EE, t, s * .19, 1.16, .07, { rz: s * .03 }); // side stripes
      put(new THREE.SphereGeometry(.06, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), IN, t, 0, 1.43, .08, { s: [1, .4, .5] }); // tee at the neck
    } else if (top === 'flannel') {
      shell(prof(-.01, .86), IN);                                                                 // tee
      shell(prof(.012, .78).slice(0, 6).concat([[.11, 1.44]]), TOP, .45, Math.PI * 2 - .9, .74);  // open flannel
      for (const s of [-1, 1]) { put(B(.075, .07, .012, .004), TOP, t, s * .08, 1.41, .15, { rz: s * .6, rx: -.4 }); put(B(.07, .06, .01, .004), TOPSH, t, s * .13, 1.22, .158, { ry: s * .35 }); } // collar points, pockets
      put(B(.1, .07, .004), o.accent ?? 0x2B2D35, t, 0, 1.2, .162);                              // tee print
    } else { // bomber over a hoodie
      shell(prof(-.01, .86), IN); hoodBack(IN);
      shell(prof(.02, .9).slice(1).map(([r, y], i) => [r, i === 0 ? .88 : y]).slice(0, 6).concat([[.12, 1.43]]), TOP, .3, Math.PI * 2 - .6, .74);
      put(CYL(.235, .225, .07, 20), 'tx:knit|' + CS, t, 0, .88, 0, { s: [1, 1, .74] });          // ribbed hem
      put(new THREE.TorusGeometry(.13, .025, 6, 18), 'tx:knit|' + CS, t, 0, 1.43, 0, { rx: Math.PI / 2, s: [1, .8, 1] });
      for (const s of [-1, 1]) put(B(.03, .1, .02, .006), CS, t, s * .14, 1.0, .16, { rz: s * .3 }); // welt pockets
      put(B(.04, .1, .006), o.accent ?? 0xF2C230, t, -.24, 1.26, .0, { rz: .1 });               // sleeve pocket hint
    }
    // accessories on the body
    if (acc.has('chain')) put(new THREE.TorusGeometry(.085, .008, 5, 18), 0xF2C94C, t, 0, 1.42, .1, { rx: Math.PI / 2 - .9 });
    if (acc.has('headphones') && o.headwear !== 'hood') { put(new THREE.TorusGeometry(.1, .014, 6, 16, Math.PI), 0x2B2D35, t, 0, 1.47, .02, { rx: -Math.PI / 2 - .4 }); for (const s of [-1, 1]) put(CYL(.045, .045, .03, 12), o.accent ?? 0xE8343F, t, s * .1, 1.47, .05, { rz: Math.PI / 2 }); }
    if (acc.has('daypack')) { const P = o.pack ?? 0x2B2D35; put(B(.28, .34, .12, .04), P, t, 0, 1.14, -.22); put(B(.2, .14, .05, .02), cityShade(P, -.08), t, 0, 1.06, -.29); for (const s of [-1, 1]) put(B(.04, .36, .012), 0x2B2D35, t, s * .11, 1.18, .12, { rx: -.08 }); }
    else if (acc.has('sling')) { const P = o.pack ?? 0x2B2D35; put(B(.025, .62, .008), 0x2B2D35, t, .0, 1.15, .175, { rz: .72 }); put(B(.22, .1, .065, .025), P, t, .13, .98, .17, { rz: .2 }); put(B(.15, .012, .07), 0xC9CCD4, t, .13, 1.02, .175, { rz: .2 }); }
  });
  g.add(T);

  // ---------- arms (hang straight down at rest), forearms, fingerless gloves ----------
  const SL = { hoodie: [.07, .066, .062, .058], puffer: [.088, .084, .08, .072], track: [.062, .06, .057, .054], flannel: [.064, .062, .058, .055], bomber: [.075, .07, .066, .06] }[top];
  // The panhandler holds his sign out front: that pose is baked into his arms, like before.
  const qArm = s => o.sign ? new THREE.Quaternion().setFromEuler(new THREE.Euler(-.65, 0, s * -.12)) : null;
  const qFore = s => o.sign ? qArm(s).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-.95, 0, 0))) : null;
  for (const [name, fname, s] of [['armL', 'foreL', -1], ['armR', 'foreR', 1]]) {
    const x = s * .235, sh = [x, 1.36, 0], el = [x, 1.08, 0], wr = [x, .84, 0];
    const A = part(name, sh, a => {
      put(new THREE.SphereGeometry(SL[0] + .006, 10, 8), TOP, a, x, 1.36, 0);
      limb(el, sh, SL[1], SL[0], TOP, a, 12);
      if (top === 'puffer') for (const y of [1.28, 1.17]) put(new THREE.TorusGeometry(SL[0] - .004, .012, 6, 14), TOP, a, x, y, 0, { rx: Math.PI / 2 });
      if (top === 'track') put(B(.006, .3, .02), o.accent ?? 0xF4F2EE, a, x + s * SL[0], 1.22, 0);
    }, qArm(s));
    const F = part(fname, el, f => {
      put(new THREE.SphereGeometry(SL[1], 10, 8), TOP, f, x, 1.08, 0);
      limb([x, .87, 0], el, SL[3], SL[2], TOP, f, 12);
      if (top === 'puffer') put(new THREE.TorusGeometry(SL[2] - .004, .012, 6, 14), TOP, f, x, .98, 0, { rx: Math.PI / 2 });
      if (top === 'track') put(B(.006, .2, .02), o.accent ?? 0xF4F2EE, f, x + s * SL[2], .97, 0);
      const cuff = top === 'flannel' ? TOPSH : top === 'track' ? CS : 'tx:knit|' + (top === 'bomber' ? CS : C);
      put(CYL(SL[3] + .004, SL[3] + .004, .045, 12), cuff, f, x, .865, 0);
      glove(f, [x, wr[1] - .02, .0], [0, -1, .02], o, false);
    }, qFore(s));
    F.position.set(0, el[1] - sh[1], 0); if (o.sign) F.position.applyQuaternion(qArm(s)); A.add(F); parts[fname] = F; g.add(A);
  }

  // ---------- head: sleepy face, city hair and headwear ----------
  const H = part('head', [0, 1.5, 0], hp => {
    put(CYL(.055, .06, .12, 12), S, hp, 0, 1.51, 0);                                            // neck
    const h = grp(hp, 0, 1.62, 0);
    put(new THREE.SphereGeometry(.135, 24, 18), S, h, 0, .02, 0, { s: [1, 1.12, 1.05] });
    put(B(.2, .1, .18, .05), S, h, 0, -.08, .02);                                               // jaw
    const brow = o.brow ?? o.hairCol;
    for (const s of [-1, 1]) {
      put(new THREE.SphereGeometry(.035, 10, 8), o.skinSh, h, s * .135, .0, -.01, { s: [.5, 1, .8] });
      put(new THREE.SphereGeometry(.036, 14, 10), 0xF6F2EA, h, s * .052, .03, .118, { s: [1.25, .8, .5] });
      put(new THREE.SphereGeometry(.017, 10, 8), 0x2A1F3A, h, s * .05, .024, .132, { s: [1, 1, .5] });
      put(new THREE.SphereGeometry(.039, 14, 10, 0, Math.PI * 2, 0, Math.PI * .55), o.skinSh, h, s * .052, .032, .118, { s: [1.28, .85, .58], rx: .15 });
      put(B(.06, .008, .01), o.skinSh, h, s * .052, -.005, .128, { rz: s * .12 });
      put(B(.065, .016, .02, .006), brow, h, s * .055, .083, .128, { rz: s * -.18 });
    }
    put(new THREE.SphereGeometry(.03, 12, 10), 0xE88F78, h, 0, -.025, .15, { s: [1, .9, 1] });
    put(B(.03, .05, .04, .012), S, h, 0, .01, .135);
    // facial hair
    const BD = o.beard, scruff = cityMix(S, BD, .45);
    if (o.face !== 'clean') put(new THREE.SphereGeometry(.124, 16, 10, 0, Math.PI * 2, Math.PI * .5, Math.PI * .5), o.face === 'beard' ? BD : scruff, h, 0, -.035, .025, { s: [1, 1.02, 1.04] });
    if (['goatee', 'stache', 'beard'].includes(o.face)) put(B(.085, .016, .02, .008), BD, h, 0, -.058, .137);
    if (o.face === 'goatee') { put(B(.05, .05, .03, .012), BD, h, 0, -.125, .1); put(new THREE.ConeGeometry(.02, .04, 5), BD, h, 0, -.16, .1, { rx: Math.PI }); }
    if (o.face === 'beard') { let q = 11; for (let i = 0; i < 14; i++) { q = (q * 16807) % 2147483647; const a = -1.2 + i / 13 * 2.4, len = .03 + (q / 2147483647) * .03; put(new THREE.ConeGeometry(.02, len, 5), BD, h, Math.sin(a) * .1, -.13 - len * .3 + Math.abs(Math.sin(a)) * .04, .03 + Math.cos(a) * .08, { rx: Math.PI + Math.cos(a) * .3, rz: -Math.sin(a) * .4 }); } }
    // hair (hidden under a hood)
    const HC = o.hairCol, hw = o.headwear;
    if (hw !== 'hood') {
      if (o.hair === 'buzz') put(new THREE.SphereGeometry(.141, 18, 10, 0, Math.PI * 2, 0, Math.PI * .45), HC, h, 0, .025, -.005, { s: [1, 1.1, 1.05] });
      else if (o.hair === 'fro') { put(new THREE.SphereGeometry(.18, 16, 12), HC, h, 0, .08, -.02, { s: [1.05, .9, 1] }); }
      else if (o.hair === 'curls') { put(new THREE.SphereGeometry(.143, 16, 10, 0, Math.PI * 2, 0, Math.PI * .5), HC, h, 0, .03, -.005, { s: [1, 1.1, 1.05] }); for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; put(new THREE.SphereGeometry(.035, 6, 5), HC, h, Math.cos(a) * .11, .12 + (i % 2) * .02, Math.sin(a) * .1 - .01); } }
      else if (o.hair === 'messy') { put(new THREE.SphereGeometry(.145, 16, 10, Math.PI * 1.5 - 1.2, 2.4, 0, Math.PI * .62), HC, h, 0, .025, -.004, { s: [1, 1.12, 1.05] }); for (let i = 0; i < 8; i++) { const a = Math.PI * 1.5 - 1 + i * .28; put(new THREE.ConeGeometry(.022, .07, 5), HC, h, -Math.cos(a) * .14, -.05, Math.sin(a) * .14, { rx: Math.PI + Math.sin(a) * .3, rz: Math.cos(a) * .3 }); } }
      else put(new THREE.SphereGeometry(.142, 16, 8, Math.PI * 1.5 - 1.3, 2.6, Math.PI * .38, Math.PI * .18), HC, h, 0, .02, 0, { s: [1, 1.1, 1.05] }); // bald with a ring
    }
    // headwear
    if (hw === 'cap' || hw === 'capBack') {
      const c = grp(h, 0, 0, 0, hw === 'capBack' ? Math.PI : 0), puff = o.hair === 'fro' ? .02 : 0;
      put(new THREE.SphereGeometry(.148 + puff, 20, 12, 0, Math.PI * 2, 0, Math.PI * .5), o.hat, c, 0, .075, 0, { s: [1, .8, 1.06] });
      put(CYL(.15 + puff, .15 + puff, .03, 20), o.hat, c, 0, .075, 0, { s: [1, 1, 1.06] });
      put(CYL(.016, .016, .01, 8), o.hatSh, c, 0, .195 + puff * .8, 0);
      put(B(.2, .014, .13, .006), o.hatSh, c, 0, .07, .19, { rx: .1 });                          // brim
      put(B(.05, .03, .006), o.accent ?? 0xF4F2EE, c, 0, .12, .15 + puff, { rx: -.5 });           // front patch
    } else if (hw === 'watch') {
      lathe([[.152, .1], [.15, .15], [.128, .2], [.07, .232], [.0, .24]], 'tx:knit|' + o.hat, h, 22);
      put(CYL(.158, .155, .06, 22), 'tx:knit|' + o.hatSh, h, 0, .125, 0);                          // high cuff above the ears
    } else if (hw === 'bucket') {
      put(CYL(.13, .152, .11, 20), 'tx:canvas|' + o.hat, h, 0, .15, 0, { s: [1, 1, 1.05] });
      put(CYL(.135, .135, .02, 20), 'tx:canvas|' + o.hat, h, 0, .206, 0);
      put(CYL(.15, .2, .045, 24), 'tx:canvas|' + o.hatSh, h, 0, .085, 0, { s: [1, 1, 1.05] });   // short brim sloping down
    } else if (hw === 'hood') {
      const HK = top === 'hoodie' ? TOP : IN;
      put(new THREE.SphereGeometry(.18, 18, 12, Math.PI / 2 + .95, Math.PI * 2 - 1.9, 0, Math.PI * .78), HK, h, 0, .03, -.01, { s: [1, 1.1, 1.08] });
      put(new THREE.TorusGeometry(.125, .03, 8, 20), HK, h, 0, .0, .125, { s: [1, 1.25, 1] });     // rim around the face
      for (const s of [-1, 1]) limb([s * .05, -.11, .15], [s * .055, -.3, .17], .008, .008, 0xE8E4F0, h, 6);
    }
    if (acc.has('shades')) { for (const s of [-1, 1]) put(B(.06, .032, .012, .008), 0x1E1B26, h, s * .052, .03, .145); put(B(.04, .008, .01), 0x1E1B26, h, 0, .04, .146); for (const s of [-1, 1]) put(B(.008, .008, .12), 0x1E1B26, h, s * .1, .035, .09); }
  });
  g.add(H);

  // arms for the grab / push / fight animations (GAME-87, GAME-85), left first
  if (o.armRig) o.armRig.push(parts.armL, parts.armR);
  let sign = null;
  if (o.sign) {
    sign = new THREE.Mesh(new THREE.BoxGeometry(.66, .42, .012), [0, 0, 0, 0, new THREE.MeshLambertMaterial({ map: labelTex(o.sign, 512, 330, '#D9A866', '#3A2410', 42) }), 0].map(m => m || new THREE.MeshLambertMaterial({ color: 0xB98A50 })));
    sign.position.set(0, 1.0, .46); sign.rotation.set(-.12, 0, -.04); sign.castShadow = true; g.add(sign);
  }
  g.position.set(o.x ?? 0, 0, o.z ?? 0); g.rotation.y = o.ry ?? 0; scene.add(g);
  const b = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(.3, .3, 1.85, 10) }); b.position.set(o.x ?? 0, .93, o.z ?? 0); world.addBody(b);
  const p = { g, head: H, parts, arms: [parts.armL, parts.armR], sign, look: o, ph: Math.random() * 6, wob: 0, bodyRef: b, hy: 1.5 }; b.tw = { type: 'person', p }; people.push(p); return p;
}
