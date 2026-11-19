// ===================== throwable junk meshes (GAME-82) =====================
// Runs inside the look-test module, so it reuses its materials and helpers (put, B, CYL,
// lumpy, bottleMesh, getMat). One builder per item type in items.mjs; each is centred on
// the point the hand grips, long axis up, at world scale.
const ITEMS = (() => {
  const CAN_COLS = [0xE8343F, 0x3FA8E8, 0x26D3A0, 0xF2C230, 0x8F6BFF, 0xFF7B54];
  const canLabel = {};
  function canMat(hex) {
    if (canLabel[hex]) return canLabel[hex];
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; const g = cv.getContext('2d');
    const c = '#' + new THREE.Color(hex).getHexString();
    g.fillStyle = c; g.fillRect(0, 0, 256, 128);
    g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(0, 50, 256, 30);                  // white band
    g.fillStyle = c; g.font = '900 26px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('FIZZ  POP  FIZZ', 128, 66);
    for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(60,40,30,${Math.random() * .18})`; g.fillRect(Math.random() * 256, Math.random() * 128, 2 + Math.random() * 6, 1 + Math.random() * 3); } // scuffs
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    return (canLabel[hex] = new THREE.MeshPhysicalMaterial({ map: t, roughness: .32, metalness: .35, clearcoat: .6 }));
  }
  const BUILD = {
    bottle: () => bottleMesh(),
    can: (seed) => {
      const g = new THREE.Group(), hex = CAN_COLS[seed % CAN_COLS.length];
      const body = new THREE.Mesh(CYL(.066, .066, .17, 18), canMat(hex)); g.add(body);
      put(CYL(.058, .066, .02, 18), 0xC9CED8, g, 0, .095, 0); put(CYL(.066, .058, .02, 18), 0xC9CED8, g, 0, -.095, 0);   // shoulders
      put(CYL(.056, .056, .006, 18), 0xB4BAC6, g, 0, .106, 0);                                                        // lid
      put(B(.03, .004, .016, .002), 0xDDE1E8, g, .012, .11, 0);                                                     // ring pull
      if (seed % 3 === 0) { g.scale.set(1, .82, 1); g.rotation.z = .12; }                                             // stomped flat-ish
      return g;
    },
    rock: (seed) => {
      const g = new THREE.Group();
      const m = put(lumpy(.09, seed % 7 + 1), 'tx:conc|' + [0x9A948A, 0x8E8A84, 0xA89A86][seed % 3], g, 0, 0, 0);
      m.scale.set(1, .85, 1.1);
      return g;
    },
    brick: (seed) => {
      const g = new THREE.Group(), base = [0xB4553C, 0xA84C36, 0xC0644A][seed % 3];
      put(B(.12, .26, .084, .012), base, g, 0, 0, 0);
      for (const [x, y, z] of [[.061, .06, 0], [.061, -.07, .02], [-.061, .02, -.01]]) put(B(.004, .03, .022, .002), 0x5C2A1E, g, x, y, z);   // chips
      put(B(.124, .02, .088, .004), 0xCFC6B4, g, 0, .12, 0, { ns: true });                                  // old mortar crust
      return g;
    },
  };
  function mesh(type, seed = 0) {
    const g = (BUILD[type] || BUILD.rock)(seed);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  }
  const NAMES = { bottle: 'bottle', can: 'can', rock: 'rock', brick: 'brick' };
  return { mesh, name: t => NAMES[t] || t };
})();
