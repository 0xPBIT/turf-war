// GAME-83: see-through car cabin. Model frame of car(): nose at -x, width along z,
// beltline at y ~.95, roof at 1.4. Glass is its own (unbaked) transparent mesh.
let carGlassMat = null;
const CAR_GROUPS = [];   // parked cars' model groups, so car damage can find them
function carGlass(m){ if(!carGlassMat){ carGlassMat = glassMat.clone(); carGlassMat.color.set(0x8CC6E6); carGlassMat.opacity = .42; carGlassMat.side = THREE.DoubleSide; }
  m.material = carGlassMat; delete m.userData.c; m.castShadow = false; m.receiveShadow = false; return m; }
function carPane(parent, a, b, w){   // a flat pane spanning the car's width between two (x,y) points
  const dx = b[0]-a[0], dy = b[1]-a[1], len = Math.hypot(dx, dy);
  return carGlass(put(B(len, .012, w), 0xFFFFFF, parent, (a[0]+b[0])/2, (a[1]+b[1])/2, 0, { rz: Math.atan2(dy, dx) }));
}
function carCabin(g, Wd, bodyHex){
  const hw = Wd/2 - .05, SEAT = 0x4E4466, DASH = 0x2E2A40;
  // roof and pillars (A at the windshield, B behind the doors, C at the back glass)
  shapeExtrude([[-.4,1.35],[.82,1.35],[.86,1.42],[-.37,1.42]], Wd-.04, bodyHex, g, .02);
  for(const s of [-1,1]){
    limb([-.93,.93,s*hw],[-.39,1.37,s*hw], .035, .04, bodyHex, g, 6);
    limb([1.47,.99,s*hw],[.83,1.37,s*hw], .05, .05, bodyHex, g, 6);
    put(B(.08,.43,.05), bodyHex, g, .24, 1.15, s*hw);
    put(B(.02,.02,.42), 0x2A3050, g, -.9, .965, s*.32, { ry: s*.35 });          // wipers
  }
  // inside: dash, steering wheel, front seats, back bench
  put(B(.26,.14,Wd-.16), DASH, g, -.78, .99, 0);
  put(new THREE.TorusGeometry(.13,.022,6,18), DASH, g, -.58, 1.08, -.36, { ry: Math.PI/2, rz: .45 });
  for(const s of [-1,1]){
    put(B(.44,.1,.42,.03), SEAT, g, -.12, .74, s*.37);
    put(B(.1,.5,.42,.03), SEAT, g, .13, 1.0, s*.37, { rz: -.18 });
    put(B(.08,.13,.26,.03), SEAT, g, .19, 1.3, s*.37, { rz: -.18 });
  }
  put(B(.44,.1,Wd-.28,.03), SEAT, g, .88, .74, 0);
  put(B(.1,.42,Wd-.28,.03), SEAT, g, 1.1, .97, 0, { rz: -.25 });
  // glass: windshield, back glass, side windows
  // panes and their outward normals (model frame), for cracks (car-damage.js)
  const paneN = m => { const n = new THREE.Vector3(0,1,0).applyQuaternion(m.quaternion); return n.x > 0 && n.y < 0 ? n.negate() : n.y < 0 ? n.negate() : n; };
  const front = carPane(g, [-.93,.94], [-.39,1.365], Wd-.1), back = carPane(g, [1.47,1.0], [.83,1.365], Wd-.1);
  g.userData.glass = { front: { m: front, n: paneN(front) }, back: { m: back, n: paneN(back) } };
  for(const s of [-1,1]){
    const w = shapeExtrude([[-.9,.95],[-.4,1.345],[.8,1.345],[1.44,1.0]], .012, 0xFFFFFF, g);
    w.position.z = s*(hw+.005); carGlass(w);
    g.userData.glass[s < 0 ? 'left' : 'right'] = { m: w, n: new THREE.Vector3(0, 0, s) };
  }
  // a bright streak on the windshield so it reads as glass from far away
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: .5, depthWrite: false });
  for(const [z, w] of [[.3, .07], [.16, .03]]){
    const st = put(B(.5,.004,w), 0xFFFFFF, g, -.655, 1.16, z, { rz: Math.atan2(.425,.54) }); st.position.y += .012;
    st.material = streakMat; delete st.userData.c; st.castShadow = false;
  }
}
