// ===================== turf mini map (GAME-80) =====================
// Round map under the damage counter: the streets around you, whose turf is whose,
// where the heat is, and who is nearby. Press M (or click it) for the big town map.
// Runs inside the look-test module after NET, so it can read the scene state.
//
// Territory is MOCK data for now (TURF_MOCK below): the real turf system is not built yet.
// Open the game with ?turf=live to colour blocks from the proof-of-concept server's owners instead.
const MINI = (() => {
  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const LIVE = /[?&]turf=live\b/.test(location.search);
  // Town north is -x (GAME-74 concept map: +x = south, +z = west). Map rotation that puts north at the top:
  const NORTH_UP = Math.PI / 2;

  // ---------- mock turf (replace with the server's turf state later) ----------
  // share = how much of the block's heat each crew has. Owner needs a 10% lead or the block is contested.
  const RIVALS = { gary: { name: 'Gutter Gary', color: '#FF9F1C' }, dee: { name: 'Dumpster Dee', color: '#8F6BFF' } };
  // Mock rivals never share your colour: pick the first pool colours whose hue is far from yours.
  const POOL = ['#FF9F1C', '#8F6BFF', '#26D3A0', '#3FA8E8', '#E8343F', '#F2C230'];
  const hue = hex => { const c = new THREE.Color(hex), o = {}; c.getHSL(o); return o.h * 360; };
  let rivalsFor = '';
  function pickRivals(myColor) {
    if (rivalsFor === myColor) return; rivalsFor = myColor;
    const far = POOL.filter(c => { const d = Math.abs(hue(c) - hue(myColor)); return Math.min(d, 360 - d) > 45; });
    RIVALS.gary.color = far[0] || POOL[0]; RIVALS.dee.color = far[1] || POOL[1];
  }
  const TURF_MOCK = {
    camp:        { you: .78, gary: .14 },
    main_corner: { you: .61, dee: .22 },
    sunny_mart:  { you: .47, dee: .43 },
    parking_lot: { dee: .72, you: .10 },
    school:      { gary: .66, you: .08 },
    creek_south: { gary: .41, dee: .37 },
    creek_north: {},
  };
  const HEAT_MOCK = [[22, 9, 9, 1], [3, -7, 6, .8], [10.4, 7.4, 4, .55], [-12, 0, 5, .5], [6, 14, 6, .45], [13, -10, 4, .5]];

  // ---------- the town, as a map ----------
  // Matches what the look test builds (art/look-test/index.html): roads, sidewalks, lot, camp, buildings.
  const PAL = {
    out: '#8FC96A', grass: '#A9DD7E', grassDot: '#97D06C', road: '#8A8DB8', roadEdge: '#F4F0FF', yellow: '#FFE27A',
    walk: '#F3EAD7', lot: '#9396BE', dirt: '#D9B98C', dirtDot: '#C9A574', ink: '#2E2350', deck: 'rgba(214,210,232,.62)',
    tree: '#58B347', treeHi: '#7DD64A',
  };
  const BUILDINGS = [   // [x, z, halfW, halfD, wall, roof]
    [3, -10, 5, 4, '#F59AB0', '#FFD84A'],     // Sunny Mart
    [-21, -11, 3.5, 3, '#F7A8C4', '#8F6BFF'], [-30, -11, 3, 3, '#9FD3FF', '#FF7DB0'],
    [-21, 11, 3.5, 3, '#FFE38A', '#43D6A4'], [-30, 11, 3, 3, '#C9B8FF', '#FF9F5A'],
    [6, 12, 7, 3.5, '#F2C66B', '#E8734A'],    // Sunnyside School
  ];
  // Layer canvases cover the town bounds (+ margin). K = layer pixels per metre, capped so big towns stay < 2400 px.
  let TOWN = { x0: -64, z0: -64, x1: 64, z1: 64 }, K = 8;
  function setBounds(map) {
    const b = map.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    TOWN = { x0: b.minX - 4, z0: b.minZ - 4, x1: b.maxX + 4, z1: b.maxZ + 4 };
    K = Math.min(8, 2400 / Math.max(TOWN.x1 - TOWN.x0, TOWN.z1 - TOWN.z0));
  }
  const mk = () => { const c = document.createElement('canvas'); c.width = Math.ceil((TOWN.x1 - TOWN.x0) * K); c.height = Math.ceil((TOWN.z1 - TOWN.z0) * K); return [c, c.getContext('2d')]; };
  const metres = g => g.setTransform(K, 0, 0, K, -TOWN.x0 * K, -TOWN.z0 * K);
  function rand(seed) { let a = 0; for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  let base = null;
  function buildBase(map) {
    const [c, g] = mk(); const r = rand('base');
    metres(g);       // draw in metres
    const b = map.bounds, bw = b.maxX - b.minX, bd = b.maxZ - b.minZ;
    g.fillStyle = PAL.out; g.fillRect(TOWN.x0, TOWN.z0, TOWN.x1 - TOWN.x0, TOWN.z1 - TOWN.z0);
    g.fillStyle = PAL.grass; g.fillRect(b.minX, b.minZ, bw, bd);
    g.fillStyle = PAL.grassDot; for (let i = 0; i < bw * bd / 10; i++) { g.beginPath(); g.arc(b.minX + r() * bw, b.minZ + r() * bd, .12 + r() * .2, 0, 7); g.fill(); }
    if (map.roads && map.roads.length) drawFromData(g, map, r); else drawCorner(g, map, r);
    trees(g, map);
    // town edge
    g.strokeStyle = 'rgba(46,35,80,.35)'; g.lineWidth = .5; g.setLineDash([2, 1.4]); g.strokeRect(b.minX, b.minZ, bw, bd); g.setLineDash([]);
    base = c;
  }
  function building(g, x, z, hw, hd, wall, roof, ry = 0) {
    g.save(); g.translate(x, z); g.rotate(-ry);
    g.fillStyle = 'rgba(46,35,80,.22)'; g.fillRect(-hw + .6, -hd + .8, hw * 2, hd * 2);
    g.fillStyle = wall; g.fillRect(-hw, -hd, hw * 2, hd * 2);
    g.fillStyle = roof; g.fillRect(-hw + .7, -hd + .7, hw * 2 - 1.4, hd * 2 - 1.4);
    g.strokeStyle = PAL.ink; g.lineWidth = .3; g.strokeRect(-hw, -hd, hw * 2, hd * 2);
    g.restore();
  }
  function deck(g, x, z, w, d) {
    g.fillStyle = PAL.deck; g.fillRect(x, z, w, d);
    g.strokeStyle = 'rgba(46,35,80,.55)'; g.lineWidth = .22; g.setLineDash([1.2, .8]); g.strokeRect(x, z, w, d); g.setLineDash([]);
  }
  function trees(g, map) {
    for (const col of map.colliders || []) {
      if (!col.cyl || col.tag || col.cyl[1] > 3 || col.cyl[0] < .2) continue;
      const [x, , z] = col.p, rr = col.cyl[0] * 6.2;
      g.fillStyle = 'rgba(46,35,80,.18)'; g.beginPath(); g.arc(x + .35, z + .45, rr, 0, 7); g.fill();
      g.fillStyle = PAL.tree; g.beginPath(); g.arc(x, z, rr, 0, 7); g.fill();
      g.fillStyle = PAL.treeHi; g.beginPath(); g.arc(x - rr * .25, z - rr * .25, rr * .55, 0, 7); g.fill();
      g.strokeStyle = PAL.ink; g.lineWidth = .16; g.beginPath(); g.arc(x, z, rr, 0, 7); g.stroke();
    }
  }
  // Full town (GAME-81): town.json carries roads / walks / lots / buildings / decks as rects.
  function drawFromData(g, map, r) {
    const LOT = { lot: PAL.lot, dirt: PAL.dirt, park: '#93D46A', water: '#7FCBF2' };
    for (const l of map.lots || []) { g.fillStyle = LOT[l.kind] || PAL.lot; g.fillRect(l.x, l.z, l.w, l.d); }
    g.fillStyle = PAL.walk; for (const w of map.walks || []) g.fillRect(w.x, w.z, w.w, w.d);
    for (const rd of map.roads) { if (!map.walks) { g.fillStyle = PAL.walk; g.fillRect(rd.x - 2.2, rd.z - 2.2, rd.w + 4.4, rd.d + 4.4); } }
    for (const rd of map.roads) { g.fillStyle = rd.kind === 'lane' ? '#A3A5C8' : PAL.road; g.fillRect(rd.x, rd.z, rd.w, rd.d); }
    g.strokeStyle = PAL.yellow; g.lineWidth = .32; g.setLineDash([2.4, 1.6]); g.beginPath();
    for (const rd of map.roads) {
      if (rd.kind === 'lane') continue;
      if (rd.w >= rd.d) { g.moveTo(rd.x, rd.z + rd.d / 2); g.lineTo(rd.x + rd.w, rd.z + rd.d / 2); } else { g.moveTo(rd.x + rd.w / 2, rd.z); g.lineTo(rd.x + rd.w / 2, rd.z + rd.d); }
    }
    g.stroke(); g.setLineDash([]);
    for (const bl of map.buildings || []) building(g, bl.x, bl.z, bl.hw, bl.hd, bl.wall || '#F2D7B6', bl.roof || '#C9B8FF', bl.ry || 0);
    for (const d of map.decks || []) deck(g, d.x, d.z, d.w, d.d);
  }
  // The look-test corner (until town.json carries roads): matches art/look-test/index.html.
  function drawCorner(g, map, r) {
    // camp dirt and the parking lot
    g.fillStyle = PAL.dirt; g.fillRect(17.5, -5, 9, 26);
    g.fillStyle = PAL.dirtDot; for (let i = 0; i < 160; i++) { g.beginPath(); g.arc(17.5 + r() * 9, -5 + r() * 26, .1 + r() * .18, 0, 7); g.fill(); }
    g.fillStyle = PAL.lot; g.fillRect(8.5, -15, 9, 9);
    g.strokeStyle = PAL.roadEdge; g.lineWidth = .14; for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(9.6 + i * 2.5, -14.8); g.lineTo(9.6 + i * 2.5, -10.4); g.stroke(); }
    // sidewalks, then roads on top
    g.fillStyle = PAL.walk; g.fillRect(-60, -5.7, 120, 11.4); g.fillRect(-17.7, -60, 11.4, 120);
    g.fillStyle = PAL.road; g.fillRect(-60, -3.5, 120, 7); g.fillRect(-15.5, -60, 7, 120);
    g.strokeStyle = PAL.roadEdge; g.lineWidth = .14;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(-60, s * 3.2); g.lineTo(-15.5, s * 3.2); g.moveTo(-8.5, s * 3.2); g.lineTo(60, s * 3.2); g.stroke();
      g.beginPath(); g.moveTo(-12 + s * 3.2, -60); g.lineTo(-12 + s * 3.2, -3.5); g.moveTo(-12 + s * 3.2, 3.5); g.lineTo(-12 + s * 3.2, 60); g.stroke();
    }
    g.strokeStyle = PAL.yellow; g.lineWidth = .32; g.setLineDash([2.4, 1.6]);
    g.beginPath(); g.moveTo(-60, 0); g.lineTo(-16, 0); g.moveTo(-8, 0); g.lineTo(60, 0); g.moveTo(-12, -60); g.lineTo(-12, -4); g.moveTo(-12, 4); g.lineTo(-12, 60); g.stroke(); g.setLineDash([]);
    g.fillStyle = PAL.roadEdge;                                         // crosswalks
    for (let i = 0; i < 7; i++) { g.fillRect(-14.9 + i * .9, 4.1, .45, 2.2); g.fillRect(-14.9 + i * .9, -6.3, .45, 2.2); g.fillRect(-7.4, -2.95 + i * .9, 2.2, .45); g.fillRect(-18.8, -2.95 + i * .9, 2.2, .45); }
    // buildings: drop shadow, wall, roof inset, ink outline (cel + ink, like the game)
    for (const [x, z, hw, hd, wall, roof] of BUILDINGS) building(g, x, z, hw, hd, wall, roof);
    // the overpass deck floats over everything, with its pillars
    deck(g, 18.3, -64, 7.4, 128);
    g.fillStyle = 'rgba(46,35,80,.45)'; for (const z of [-30, -18, -6, 6, 18, 30]) for (const s of [-1, 1]) g.fillRect(22 + s * 2.4 - .5, z - .5, 1, 1);
  }

  // ---------- turf layer: blocks tagged in spray paint ----------
  let turf = null, turfC = null, turfKey = '', zoneInfo = {};
  function crewOf(id, myColor) { return id === 'you' ? { name: 'You', color: myColor, you: true } : RIVALS[id] || { name: id, color: '#999' }; }
  function resolveTurf(map, view) {
    const mine = view.meta && view.meta.players.find(p => p.id === view.myPid);
    const myColor = (mine && mine.color) || '#FF6E9E', myName = mine ? mine.name : 'You';
    pickRivals(myColor);
    const out = {};
    for (const zn of map.zones) {
      if (LIVE) {
        const o = view.meta && view.meta.owners[zn.id];
        out[zn.id] = o ? { owner: o.name === myName ? { name: 'You', color: myColor, you: true } : { name: o.name, color: o.color }, contested: null, share: null } : { owner: null };
        continue;
      }
      const sh = Object.entries(TURF_MOCK[zn.id] || {}).sort((a, b) => b[1] - a[1]);
      const [a, b] = sh;
      if (!a || a[1] < .2) { out[zn.id] = { owner: null, shares: sh.map(([k, v]) => [crewOf(k, myColor), v]) }; continue; }
      const contested = b && a[1] - b[1] < .1 ? crewOf(b[0], myColor) : null;
      out[zn.id] = { owner: crewOf(a[0], myColor), contested, shares: sh.map(([k, v]) => [crewOf(k, myColor), v]) };
    }
    return out;
  }
  function stripes(c1, c2, alpha) {
    const p = document.createElement('canvas'); p.width = p.height = 24; const g = p.getContext('2d');
    g.globalAlpha = alpha; g.fillStyle = c1; g.fillRect(0, 0, 24, 24);
    if (c2) { g.globalAlpha = Math.min(1, alpha + .15); g.strokeStyle = c2; g.lineWidth = 8; g.beginPath(); for (let k = -24; k <= 48; k += 24) { g.moveTo(k, 24); g.lineTo(k + 24, 0); } g.stroke(); }
    return p;
  }
  function sprayRect(g, zn, color, seed, width) {
    // Rough, hand-sprayed outline: jittered path + soft overspray halo + a few speckles.
    const r = rand(seed), pts = [], st = .7, inset = .45;
    const x0 = zn.x + inset, z0 = zn.z + inset, x1 = zn.x + zn.w - inset, z1 = zn.z + zn.d - inset;
    const edge = (ax, az, bx, bz) => { const n = Math.max(2, Math.round(Math.hypot(bx - ax, bz - az) / st)); for (let i = 0; i < n; i++) { const k = i / n; pts.push([ax + (bx - ax) * k + (r() - .5) * .3, az + (bz - az) * k + (r() - .5) * .3]); } };
    edge(x0, z0, x1, z0); edge(x1, z0, x1, z1); edge(x1, z1, x0, z1); edge(x0, z1, x0, z0);
    g.save(); g.strokeStyle = color; g.lineJoin = g.lineCap = 'round';
    g.shadowColor = color; g.shadowBlur = width * K * 1.6; g.globalAlpha = .9; g.lineWidth = width;
    g.beginPath(); pts.forEach(([x, z], i) => i ? g.lineTo(x, z) : g.moveTo(x, z)); g.closePath(); g.stroke();
    g.shadowBlur = 0; g.globalAlpha = .5; g.fillStyle = color;
    for (let i = 0; i < pts.length; i += 2) { const [x, z] = pts[i]; g.beginPath(); g.arc(x + (r() - .5) * 1.6, z + (r() - .5) * 1.6, .06 + r() * .1, 0, 7); g.fill(); }
    g.restore();
  }
  function buildTurf(map, info) {
    const [c, g] = mk(), [cc, gc] = mk();
    metres(g); metres(gc);
    for (const zn of map.zones) {
      const z = info[zn.id];
      if (!z.owner) {                               // unclaimed: faint chalk outline
        g.save(); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = .22; g.setLineDash([.9, .7]);
        g.strokeRect(zn.x + .45, zn.z + .45, zn.w - .9, zn.d - .9); g.restore(); continue;
      }
      const t = z.contested ? gc : g, own = z.owner.color;
      const pat = t.createPattern(stripes(own, z.contested ? z.contested.color : (z.owner.you ? null : own), z.owner.you ? .34 : .2), 'repeat');
      pat.setTransform(new DOMMatrix().scale(1 / K));
      t.fillStyle = pat; t.fillRect(zn.x + .45, zn.z + .45, zn.w - .9, zn.d - .9);
      sprayRect(t, zn, own, zn.id, z.owner.you ? .55 : .38);
      if (z.contested) sprayRect(t, { x: zn.x + .7, z: zn.z + .7, w: zn.w - 1.4, d: zn.d - 1.4 }, z.contested.color, zn.id + 'c', .3);
    }
    turf = c; turfC = cc;
  }

  let heat = null;
  function buildHeat() {
    const [c, g] = mk(); metres(g);
    for (const [x, z, r, a] of HEAT_MOCK) {
      const gr = g.createRadialGradient(x, z, 0, x, z, r);
      gr.addColorStop(0, `rgba(255,96,40,${.55 * a})`); gr.addColorStop(.5, `rgba(255,150,60,${.25 * a})`); gr.addColorStop(1, 'rgba(255,190,90,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, z, r, 0, 7); g.fill();
    }
    heat = c;
  }

  // ---------- markers ----------
  function flame(g, x, y, s, t) {
    const w = 1 + Math.sin(t * 9 + x) * .08;
    g.save(); g.translate(x, y); g.scale(s, s * w);
    g.fillStyle = '#FF5A1F'; g.strokeStyle = '#fff'; g.lineWidth = 1.6 / s;
    g.beginPath(); g.moveTo(0, -7); g.bezierCurveTo(5, -2, 5, 4, 0, 5); g.bezierCurveTo(-5, 4, -5, -2, 0, -7); g.fill(); g.stroke();
    g.fillStyle = '#FFD84A'; g.beginPath(); g.moveTo(0, -2); g.bezierCurveTo(2.6, 1, 2.4, 4, 0, 4.4); g.bezierCurveTo(-2.4, 4, -2.6, 1, 0, -2); g.fill();
    g.restore();
  }
  function octagon(g, x, y, r) {
    g.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath();
    g.fillStyle = '#E8343F'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke();
  }

  // Draws the map into ctx. o: { w, h, cx, cz, ppm, rot, round, big }
  const _v = new THREE.Vector3();
  function draw(g, o, view, t) {
    const { w, h, cx, cz, ppm, rot } = o, R = Math.min(w, h) / 2, ox = w / 2, oy = h / 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const S = (x, z) => { const dx = (x - cx) * ppm, dz = (z - cz) * ppm; return [ox + dx * cs - dz * sn, oy + dx * sn + dz * cs]; };
    g.save(); g.clearRect(0, 0, w, h);
    if (o.round) { g.beginPath(); g.arc(ox, oy, R, 0, 7); g.clip(); }
    // layers (world space)
    g.save(); g.translate(ox, oy); g.rotate(rot); g.scale(ppm / K, ppm / K); g.translate((TOWN.x0 - cx) * K, (TOWN.z0 - cz) * K);
    g.imageSmoothingQuality = 'high';
    g.drawImage(base, 0, 0);
    if (heat && o.heat) { g.globalAlpha = .85; g.drawImage(heat, 0, 0); }
    g.globalAlpha = 1; g.drawImage(turf, 0, 0);
    g.globalAlpha = .55 + .45 * Math.sin(t * 4); g.drawImage(turfC, 0, 0); g.globalAlpha = 1;
    g.restore();

    const map = view.map, px = player.position.x, pz = player.position.z;
    // zone names on the big map
    if (o.big) {
      g.font = '700 13px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      for (const zn of map.zones) {
        const [x, y] = S(zn.x + zn.w / 2, zn.z + zn.d / 2), z = zoneInfo[zn.id];
        g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,.95)'; g.strokeText(zn.name, x, y - 7); g.fillStyle = PAL.ink; g.fillText(zn.name, x, y - 7);
        const sub = !z || !z.owner ? 'unclaimed' : (z.contested ? 'contested' : (z.owner.you ? 'your turf' : z.owner.name));
        g.font = '700 11px Nunito, sans-serif'; g.strokeText(sub, x, y + 8); g.fillStyle = z && z.owner ? z.owner.color : '#5D5486'; g.fillText(sub, x, y + 8);
        g.font = '700 13px Fredoka, sans-serif';
      }
    }
    // fixtures: stop sign, fires
    const ms = o.big ? 1.25 : 1;
    for (const f of view.fixtures.values()) {
      const st = view.meta && view.meta.objects[f.id];
      if (f.type === 'stop_sign') { const [x, y] = S(f.pos[0], f.pos[2]); octagon(g, x, y, 4 * ms); }
      if ((f.type === 'pile' || f.type === 'dumpster') && st && st.fire) { const [x, y] = S(f.pos[0], f.pos[2]); flame(g, x, y, .9 * ms, t); }
    }
    // cars
    for (const v of view.ents.values()) {
      if (v.kind !== 'traffic' || !v.obj) continue;
      const [x, y] = S(v.obj.position.x, v.obj.position.z); if (o.round && Math.hypot(x - ox, y - oy) > R + 10) continue;
      _v.set(0, 0, 1).applyQuaternion(v.obj.quaternion);
      g.save(); g.translate(x, y); g.rotate(Math.atan2(_v.z, _v.x) + rot);
      const L = 4.4 * ppm, W = 2 * ppm; g.fillStyle = v.color || '#fff'; g.strokeStyle = PAL.ink; g.lineWidth = 1.2;
      g.beginPath(); g.roundRect(-L / 2, -W / 2, L, W, W * .35); g.fill(); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(L * .1, -W / 2 + 1.5, L * .18, W - 3);
      g.restore();
    }
    // other vagrants and sleepers
    for (const v of view.ents.values()) {
      if ((v.kind !== 'vagrant' && v.kind !== 'sleeper') || !v.obj) continue;
      let [x, y] = S(v.obj.position.x, v.obj.position.z);
      if (o.round) { const d = Math.hypot(x - ox, y - oy), lim = R - 7; if (d > lim) { x = ox + (x - ox) / d * lim; y = oy + (y - oy) / d * lim; } }
      g.beginPath(); g.arc(x, y, 4.5 * ms, 0, 7); g.fillStyle = v.kind === 'sleeper' ? '#B9B4D6' : (v.color || '#ff6e9e'); g.fill();
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1; g.strokeStyle = PAL.ink; g.beginPath(); g.arc(x, y, 5.6 * ms, 0, 7); g.stroke();
      if (v.kind === 'sleeper') { g.font = '700 10px Fredoka, sans-serif'; g.fillStyle = '#8F6BFF'; g.textAlign = 'left'; g.fillText('z', x + 5, y - 5); }
      if (o.big) { g.font = '700 11px Nunito, sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = '#fff'; g.strokeText(v.name || '', x, y - 11); g.fillStyle = PAL.ink; g.fillText(v.name || '', x, y - 11); }
    }
    // you: view cone + arrow
    {
      const [x, y] = S(px, pz), head = -yaw + rot;      // arrow drawn pointing up, rotated to your facing
      const hf = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
      const cr = Math.min(R * .9, 16 * ppm);
      g.save(); g.translate(x, y); g.rotate(head);
      const gr = g.createRadialGradient(0, 0, 2, 0, 0, cr); gr.addColorStop(0, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, cr, -Math.PI / 2 - hf / 2, -Math.PI / 2 + hf / 2); g.closePath(); g.fill();
      const a = 7.5 * ms;
      g.beginPath(); g.moveTo(0, -a * 1.35); g.lineTo(a, a); g.lineTo(0, a * .45); g.lineTo(-a, a); g.closePath();
      g.fillStyle = zoneInfo.__myColor || '#FF6E9E'; g.fill(); g.lineJoin = 'round'; g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke();
      g.lineWidth = 1; g.strokeStyle = PAL.ink; g.stroke();
      g.restore();
    }
    g.restore();
    if (o.round) {   // inner ink ring + soft inner shade
      const sh = g.createRadialGradient(ox, oy, R * .78, ox, oy, R); sh.addColorStop(0, 'rgba(46,35,80,0)'); sh.addColorStop(1, 'rgba(46,35,80,.22)');
      g.fillStyle = sh; g.beginPath(); g.arc(ox, oy, R, 0, 7); g.fill();
      g.lineWidth = 1.5; g.strokeStyle = 'rgba(46,35,80,.5)'; g.beginPath(); g.arc(ox, oy, R - .75, 0, 7); g.stroke();
    }
  }

  // ---------- DOM ----------
  const wrap = el('mini'), cv = el('miniMap'), ctx = cv.getContext('2d'), north = el('miniN');
  const big = el('bigMap'), bcv = el('bigMapCv'), bctx = bcv.getContext('2d');
  let bigOpen = false, view = null;
  function fit(c, px) { const d = Math.min(devicePixelRatio, 2), n = Math.round(px * d); if (c.width !== n) { c.width = c.height = n; } return d; }
  function toggleBig(on) {
    bigOpen = on ?? !bigOpen; big.classList.toggle('open', bigOpen);
    if (bigOpen) renderLegend();
  }
  wrap.addEventListener('pointerdown', e => { e.stopPropagation(); toggleBig(true); });
  big.addEventListener('pointerdown', e => { e.stopPropagation(); toggleBig(false); });
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.repeat || SET.isOpen()) return;
    if (SET.isBind('map', e.code)) toggleBig();
    else if (e.code === 'Escape' && bigOpen) { toggleBig(false); e.stopImmediatePropagation(); }
  }, true);

  function renderLegend() {
    if (!view || !view.map) return;
    const mineCount = view.map.zones.filter(z => zoneInfo[z.id] && zoneInfo[z.id].owner && zoneInfo[z.id].owner.you).length;
    const crews = new Map();
    for (const z of view.map.zones) { const o = zoneInfo[z.id] && zoneInfo[z.id].owner; if (o && !o.you) crews.set(o.name, o.color); }
    el('bigLegend').innerHTML =
      `<div class="lg you"><i style="background:${zoneInfo.__myColor}"></i>Your turf<em>${mineCount} of ${view.map.zones.length} blocks</em></div>`
      + [...crews].map(([n, c]) => `<div class="lg"><i style="background:${c}"></i>${esc(n)}</div>`).join('')
      + `<div class="lg"><i class="st"></i>Contested (pulsing)</div><div class="lg"><i class="un"></i>Unclaimed</div><div class="lg"><i class="ht"></i>Heat (recent damage)</div>`
      + (LIVE ? '' : '<p>Turf here is mock data until the turf system is built.</p>');
  }

  // ---------- info strip under the map ----------
  let lastZone = '#', lastInfo = '';
  function updateInfo(map) {
    const px = player.position.x, pz = player.position.z;
    const zn = map.zones.find(z => px >= z.x && px <= z.x + z.w && pz >= z.z && pz <= z.z + z.d);
    const z = zn && zoneInfo[zn.id];
    let html;
    if (!zn) html = `<b>The Streets</b><span class="tag none">no turf here</span>`;
    else {
      const tag = !z.owner ? '<span class="tag none">unclaimed</span>'
        : z.contested ? `<span class="tag" style="--c:${z.owner.color};--c2:${z.contested.color}">contested</span>`
        : z.owner.you ? `<span class="tag" style="--c:${z.owner.color}">your turf</span>`
        : `<span class="tag" style="--c:${z.owner.color}">${esc(z.owner.name)}'s turf</span>`;
      let bar = '';
      if (z.shares && z.shares.length) {
        const tot = Math.max(1, z.shares.reduce((a, [, v]) => a + v, 0));
        bar = `<div class="heat">${z.shares.map(([c, v]) => `<i style="width:${(v / tot * 100).toFixed(1)}%;background:${c.color}" title="${esc(c.name)}"></i>`).join('')}</div>`
          + `<small>${z.shares.slice(0, 2).map(([c, v]) => `${esc(c.name)} ${Math.round(v * 100)}%`).join(' · ')}</small>`;
      }
      html = `<b>${esc(zn.name)}</b>${tag}${bar}`;
    }
    if (html !== lastInfo) { el('miniInfo').innerHTML = html; lastInfo = html; }
  }

  let turfAt = -1e9;
  function frame(dt, t) {
    view = NET.view; const map = view.map;
    if (!map) return;
    if (!base) { setBounds(map); buildBase(map); buildHeat(); }
    if (performance.now() - turfAt > 1000) {        // ownership changes slowly; re-resolve once a second
      turfAt = performance.now();
      zoneInfo = resolveTurf(map, view);
      const mine = view.meta && view.meta.players.find(p => p.id === view.myPid);
      zoneInfo.__myColor = (mine && mine.color) || '#FF6E9E';
      const key = JSON.stringify(zoneInfo);
      if (key !== turfKey) { turfKey = key; buildTurf(map, zoneInfo); if (bigOpen) renderLegend(); }
    }
    const show = SET.opt('minimap');
    wrap.style.visibility = show ? '' : 'hidden'; el('miniInfo').style.visibility = show ? '' : 'hidden';
    if (show) {
      const px = wrap.clientWidth, d = fit(cv, px), rot = SET.opt('mapRotate') ? yaw : NORTH_UP;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      draw(ctx, { w: px, h: px, cx: player.position.x, cz: player.position.z, ppm: px / 2 / 30, rot, round: true, heat: true }, view, t);
      north.style.transform = `rotate(${rot - NORTH_UP}rad) translateY(-${px / 2}px) rotate(${NORTH_UP - rot}rad)`;
      updateInfo(map);
    }
    if (bigOpen) {
      const px = bcv.clientWidth, d = fit(bcv, px);
      bctx.setTransform(d, 0, 0, d, 0, 0);
      const b = map.bounds, cor = !(map.roads && map.roads.length);
      draw(bctx, { w: px, h: px, cx: cor ? -4 : (b.minX + b.maxX) / 2, cz: cor ? 0 : (b.minZ + b.maxZ) / 2, ppm: cor ? px / 2 / 46 : px / Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * .98, rot: NORTH_UP, round: false, heat: true, big: true }, view, t);
    }
  }
  window.__mini = { toggleBig, get info() { return zoneInfo; } };
  return { frame, toggleBig };
})();
