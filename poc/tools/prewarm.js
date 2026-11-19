// ===================== shader prewarm (frame drops fix) =====================
// Shards, broken glass, splinters, stains and thrown bottles only appear mid-game, and the
// first time each material draws, three.js compiles its shader on the spot: a visible
// hitch on the first smash. Compile them all now, behind the loading screen.
(function prewarm() {
  const g = new THREE.Group(), geo = new THREE.PlaneGeometry(1, 1);
  for (const m of [shardMat, bottleShardMat, brokenGlassMat, glassMat, woodMat]) { const o = new THREE.Mesh(geo, m); o.castShadow = o.receiveShadow = true; g.add(o); }
  // Procedural glass (GAME-84); the cracked pane uses RGBA vertex colours, a separate program.
  const rgba = new THREE.PlaneGeometry(1, 1); rgba.setAttribute('color', new THREE.Float32BufferAttribute(new Array(16).fill(1), 4));
  for (const [m, vc] of GLASS.materials) { const o = new THREE.Mesh(vc ? rgba : geo, m); o.castShadow = o.receiveShadow = true; g.add(o); }
  const st = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: stainTex, transparent: true, depthWrite: false })); g.add(st);
  for (const [map, blending] of [[flameTex, THREE.AdditiveBlending], [smokeTex, THREE.NormalBlending]])
    g.add(new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending })));
  // Hydrant water (GAME-94): spray points and the puddle decal.
  const pt = new THREE.BufferGeometry(); pt.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  for (const m of HYD.materials) g.add(m.isPointsMaterial ? new THREE.Points(pt, m) : new THREE.Mesh(geo, m));
  g.add(ITEMS.mesh('wrench'));
  const b = bottleMesh(); b.traverse(o => { if (o.isMesh) o.castShadow = true; }); g.add(b);
  // A speck in front of the camera, so the first real frames draw it through every pass.
  g.scale.setScalar(.002); camera.updateMatrixWorld();
  g.position.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()));
  scene.add(g); renderer.compile(scene, camera);
  let n = 0; (function drop() { if (++n < 4) return requestAnimationFrame(drop); scene.remove(g); })();
})();
