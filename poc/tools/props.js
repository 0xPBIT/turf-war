// ===================== loose props (GAME-87) =====================
// Meshes for the movable props the server simulates (carts, mattresses, the couch,
// cardboard boxes, trash cans). Each builder draws the prop standing on y=0 in its
// own frame, using the look test's materials and helpers; PROPS.build() then shifts
// it so its origin is the physics body's centre, which is what snapshots move.
// A type with no builder is drawn as a plain cardboard-coloured box of its size.
const PROPS = (() => {
  const WIRE = 0xC8CDDD;
  const ART = {
    couch(g) {
      put(B(2.4, .35, .95, .04), 0x7A55F0, g, 0, .3, 0);
      for (const cx of [-.6, .6]) { put(B(1.1, .22, .85, .08), P.grape, g, cx, .58, .04, { rz: cx * .04 }); put(B(1.1, .62, .24, .08), P.grape, g, cx, .95, -.36, { rx: -.12 }); }
      put(B(2.4, .7, .25, .05), 0x7A55F0, g, 0, .78, -.48);
      for (const s of [-1, 1]) put(B(.28, .62, .95, .08), 0x7A55F0, g, s * 1.28, .62, 0);
      for (const s of [-1, 1]) for (const t of [-1, 1]) put(CYL(.04, .03, .14, 6), INK, g, s * 1.1, .07, t * .38);
    },
    mattress(g) {
      put(B(1.9, .22, 1.4, .08), 0xF2EEE6, g, 0, .11, 0);
      for (let k = 0; k < 4; k++) put(B(1.9, .01, .02), 0xD8D0C4, g, 0, .222, -.45 + k * .3);
      put(B(.55, .006, .4), 0xCDBB8A, g, .32, .224, .18, { ns: true });   // the stain
      put(B(.25, .006, .2), 0xBFAE7E, g, -.5, .224, -.3, { ns: true });
    },
    cart(g) {
      for (const s of [-1, 1]) { put(B(.02, .55, .02), WIRE, g, s * .3, .75, -.45); put(B(.02, .55, .02), WIRE, g, s * .3, .75, .45); }
      for (let k = 0; k < 6; k++) { put(B(.6, .012, .012), WIRE, g, 0, .5 + k * .1, -.45); put(B(.6, .012, .012), WIRE, g, 0, .5 + k * .1, .45); put(B(.012, .012, .9), WIRE, g, -.3, .5 + k * .1, 0); put(B(.012, .012, .9), WIRE, g, .3, .5 + k * .1, 0); }
      for (let k = 0; k < 8; k++) { put(B(.012, .55, .012), WIRE, g, -.3, .75, -.45 + k * .128); put(B(.012, .55, .012), WIRE, g, .3, .75, -.45 + k * .128); }
      put(B(.6, .02, .9), WIRE, g, 0, .48, 0); tube([[-.32, 1.05, -.5], [0, 1.08, -.55], [.32, 1.05, -.5]], .025, 0xFF6E9E, g, 6);
      for (const s of [-1, 1]) for (const t of [-1, 1]) { put(B(.02, .4, .02), WIRE, g, s * .25, .28, t * .38); put(CYL(.06, .06, .04, 10), INK, g, s * .25, .06, t * .38, { rz: Math.PI / 2 }); }
    },
    box(g) {
      put(B(.6, .44, .48, .01), 0xB08A5A, g, 0, .22, 0);
      put(B(.6, .006, .012), 0x8A6A42, g, 0, .443, 0);                     // flap seam
      put(B(.09, .008, .485), 0xD9C79A, g, 0, .444, 0);                    // tape
      put(B(.09, .2, .008), 0xD9C79A, g, 0, .34, .242); put(B(.09, .2, .008), 0xD9C79A, g, 0, .34, -.242);
      put(B(.2, .12, .004), 0x6E5236, g, .15, .22, .241, { ns: true });  // scrawled marker label
    },
    trashcan(g, e) {
      const col = e.color ? new THREE.Color(e.color).getHex() : 0x8FA3C8;
      put(CYL(.32, .28, .86, 20), col, g, 0, .43, 0);
      for (const y of [.28, .6]) put(new THREE.TorusGeometry(.305, .022, 6, 24), 0xffffff, g, 0, y, 0, { rx: Math.PI / 2 });
      put(CYL(.34, .33, .06, 20), col, g, 0, .89, 0); put(B(.18, .04, .05, .01), DARKM, g, 0, .94, 0);
      for (const s of [-1, 1]) put(B(.04, .1, .1, .01), DARKM, g, s * .33, .8, 0);
    },
  };
  // Where the body centre sits in the builder's frame, beyond half its height.
  const OFFSET = { couch: [0, 0, .065] };
  function halfY(e) { return e.half ? e.half[1] : e.hh || .3; }
  function build(e) {
    const root = new THREE.Group(), inner = new THREE.Group(); root.add(inner);
    if (ART[e.type]) ART[e.type](inner, e);
    else { const h = e.half || [.3, .3, .3]; put(B(h[0] * 2, h[1] * 2, h[2] * 2, .02), 0xB08A5A, inner, 0, h[1], 0); }
    bake(inner);
    const o = OFFSET[e.type] || [0, 0, 0];
    inner.position.set(o[0], -halfY(e) + o[1], o[2]);
    return root;
  }
  return { build, has: t => !!ART[t] };
})();
