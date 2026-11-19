// ===================== car damage (GAME-83) =====================
// The server sends dents and per-pane crack levels in the car's own frame (nose +z, y from
// the ground). The car model's frame is nose -x, so model = (-z, y, x). Each damaged car
// gets its own finely tessellated copy of the body so dents can push real vertices in,
// and cracked panes get a crack decal (level 1) or go frosted with a big crack (level 2).
const CARDMG = (() => {
  // Split triangles until no edge is longer than MAX, so a dent has vertices to push.
  function tessellate(geo, MAX) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const src = g.attributes.position.array, out = [];
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    const split = (a, b, c, depth) => {
      const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a), m = Math.max(ab, bc, ca);
      if (m <= MAX || depth > 9) { out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); return; }
      if (m === ab) { const p = a.clone().lerp(b, .5); split(a, p, c, depth + 1); split(p, b, c, depth + 1); }
      else if (m === bc) { const p = b.clone().lerp(c, .5); split(a, b, p, depth + 1); split(a, p, c, depth + 1); }
      else { const p = c.clone().lerp(a, .5); split(a, b, p, depth + 1); split(p, b, c, depth + 1); }
    };
    for (let i = 0; i < src.length; i += 9) split(A.set(src[i], src[i + 1], src[i + 2]).clone(), B.set(src[i + 3], src[i + 4], src[i + 5]).clone(), C.set(src[i + 6], src[i + 7], src[i + 8]).clone(), 0);
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.length / 3 * 2), 2));
    ng.computeVertexNormals();
    return ng;
  }
  // A white spiderweb crack on a transparent canvas; one texture, rotated per decal.
  let crackTex = null;
  function crackTexture() {
    if (crackTex) return crackTex;
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
    g.lineCap = 'round'; g.lineJoin = 'round';
    const rays = [];
    for (let i = 0; i < 11; i++) {
      const a0 = i / 11 * Math.PI * 2 + Math.random() * .3, pts = [[S / 2, S / 2]];
      let r = 0, a = a0; while (r < S * .48) { r += 10 + Math.random() * 18; a += (Math.random() - .5) * .35; pts.push([S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r]); }
      rays.push(pts);
    }
    const stroke = (w, col) => {
      g.strokeStyle = col; g.lineWidth = w;
      for (const pts of rays) { g.beginPath(); pts.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); }
      for (const rr of [.12, .24, .36]) {               // rings joining neighbouring rays
        g.beginPath();
        rays.forEach((pts, k) => { const p = pts[Math.min(pts.length - 1, Math.round(pts.length * rr / .48))]; k ? g.lineTo(...p) : g.moveTo(...p); });
        g.closePath(); g.stroke();
      }
    };
    stroke(11, 'rgba(30,36,64,.95)'); stroke(3.5, 'rgba(255,255,255,1)');
    g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(S / 2, S / 2, 7, 0, Math.PI * 2); g.fill();
    crackTex = new THREE.CanvasTexture(cv); crackTex.colorSpace = THREE.SRGBColorSpace;
    return crackTex;
  }
  // Scraped paint: a dark smudge with bright bare-metal scratches.
  let scuffTex = null;
  function scuffTexture() {
    if (scuffTex) return scuffTex;
    const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d');
    const rg = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2); rg.addColorStop(0, 'rgba(40,34,52,.55)'); rg.addColorStop(1, 'rgba(40,34,52,0)');
    g.fillStyle = rg; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 22; i++) {
      const x = S * (.2 + Math.random() * .6), y = S * (.2 + Math.random() * .6), a = -.4 + Math.random() * .8, l = 10 + Math.random() * 34;
      g.strokeStyle = i % 3 ? 'rgba(235,238,245,.85)' : 'rgba(30,26,40,.7)'; g.lineWidth = i % 3 ? 1.2 : 2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    scuffTex = new THREE.CanvasTexture(cv); scuffTex.colorSpace = THREE.SRGBColorSpace; return scuffTex;
  }
  const frostMat = () => new THREE.MeshPhysicalMaterial({ color: 0xE8F4FA, roughness: .5, transparent: true, opacity: .82, side: THREE.DoubleSide, depthWrite: false });
  // car: the model group built by car(); it carries userData.body (mesh) and userData.glass.
  function state(g) {
    const u = g.userData;
    if (!u.dmg) u.dmg = { dents: [], decals: [], glass: {}, geo: null, origGeo: null };
    return u.dmg;
  }
  function ensureGeo(g) {
    const S = state(g), body = g.userData.body;
    if (!S.geo) { S.origGeo = body.geometry; S.geo = tessellate(body.geometry, .11); S.rest = S.geo.attributes.position.array.slice(); body.geometry = S.geo; }
    return S.geo;
  }
  const toModel = (p) => new THREE.Vector3(-p[2], p[1], p[0]);
  // Push vertices near the impact inward, with a crumpled, faceted falloff.
  function dent(g, d) {
    const body = g.userData.body; if (!body) return;
    const geo = ensureGeo(g), pos = geo.attributes.position, arr = pos.array;
    const P = toModel(d), N = toModel([d[3], d[4], d[5]]).normalize(), R = d[6] * 1.6, depth = d[6] * .7;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < arr.length; i += 3) {
      v.set(arr[i], arr[i + 1], arr[i + 2]); w.copy(v).sub(P);
      const along = w.dot(N); if (along < -.35 || along > .5) continue;
      const lat = w.addScaledVector(N, -along).length(); if (lat > R) continue;
      const k = 1 - lat / R, fall = k * k * (3 - 2 * k);
      const crinkle = .45 + 1.1 * Math.abs(Math.sin(arr[i] * 37.1 + arr[i + 1] * 51.7 + arr[i + 2] * 23.3));
      arr[i] -= N.x * depth * fall * crinkle; arr[i + 1] -= N.y * depth * fall * crinkle; arr[i + 2] -= N.z * depth * fall * crinkle;
    }
    pos.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
    // a scuff where the paint got scraped
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(d[6] * 2.2, d[6] * 2.2), new THREE.MeshBasicMaterial({ map: scuffTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    sc.position.copy(P).addScaledVector(N, .015 - depth * .55); sc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), N); sc.rotation.z += Math.random() * 3;
    sc.scale.set(1, .6 + Math.random() * .5, 1); g.add(sc); state(g).decals.push(sc);
  }
  function crack(g, pane, level, at) {
    const gl = g.userData.glass && g.userData.glass[pane]; if (!gl) return;
    const S = state(g), prev = S.glass[pane] || 0; if (level <= prev) return;
    S.glass[pane] = level;
    const n = gl.n.clone();
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    const centre = new THREE.Box3().setFromObject(gl.m).getCenter(new THREE.Vector3()).applyMatrix4(inv);   // the pane's middle (meshes may sit at their own origin)
    const P = at ? toModel(at) : centre;
    const decal = (size, p) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: crackTexture(), alphaTest: .35, side: THREE.DoubleSide }));
      m.position.copy(p).addScaledVector(n, .012); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      m.rotateZ(Math.random() * Math.PI * 2); m.renderOrder = 2; g.add(m); S.decals.push(m); return m;
    };
    if (level >= 1 && prev < 1) decal(1.0, P);
    if (level >= 2) {
      if (!gl.orig) gl.orig = gl.m.material;
      gl.m.material = frostMat();
      decal(1.3, centre); decal(.9, P);
    }
  }
  function apply(g, m) {
    if (!g) return;
    if (m.dent) dent(g, m.dent);
    if (m.glass) crack(g, m.glass, m.level, m.at);
  }
  function applyAll(g, dmg) {
    if (!g || !dmg) return;
    for (const d of dmg.dents || []) dent(g, d);
    for (const [pane, lvl] of Object.entries(dmg.glass || {})) crack(g, pane, lvl, null);
  }
  function reset(g) {
    const S = g && g.userData.dmg; if (!S) return;
    if (S.origGeo) { g.userData.body.geometry = S.origGeo; S.geo.dispose(); }
    for (const d of S.decals) { g.remove(d); d.geometry.dispose(); }
    for (const pane in g.userData.glass || {}) { const gl = g.userData.glass[pane]; if (gl.orig) { gl.m.material = gl.orig; gl.orig = null; } }
    g.userData.dmg = null;
  }
  return { apply, applyAll, reset };
})();
