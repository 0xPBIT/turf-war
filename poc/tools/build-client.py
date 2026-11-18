#!/usr/bin/env python3
"""Builds poc/public/index.html from the approved art look test.

The look test (GAME-75, /mnt/project-files/art/look-test/index.html) is the reference
build for the art direction. This script copies it and swaps its single-player bits
(local player, local bottles, local props, shader dials) for the multiplayer client in
net-client.js, so the live game keeps the exact Blend shader and assets.

Usage: python3 tools/build-client.py [path/to/look-test/index.html]
"""
import pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/mnt/project-files/art/look-test/index.html')
OUT = HERE.parent / 'public' / 'index.html'
NET = (HERE / 'net-client.js').read_text()
HUD = (HERE / 'net-hud.html').read_text()

s = SRC.read_text()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        raise SystemExit(f'expected {count} match(es), found {n}: {old[:90]!r}')
    s = s.replace(old, new)

# Charset, title, local libraries (no CDN dependency at runtime).
rep('<title>Turf War Look Test</title>', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Turf War</title>')
rep('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', '/vendor/three/build/three.module.js')
rep('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/', '/vendor/three/examples/jsm/')
rep('https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js', '/vendor/cannon-es.js')

# HUD: hide the look-test panels (the Blend look is locked), add the multiplayer HUD.
rep('<div class="hud" id="tl">', '<div class="hud" id="tl" style="display:none">')
rep('<div class="panel" id="dials">', '<div class="panel" id="dials" style="display:none">')
rep('<div class="panel" id="places">', '<div class="panel" id="places" style="display:none">')
rep('<div class="hud" id="cap">', '<div class="hud" id="cap" style="display:none">')
rep('<div id="joy"><span></span></div>', '<div id="joy"><span></span></div>\n' + HUD)

# No local props: the server owns crates and cones.
rep('spawnProps();\nconst starTex', 'const starTex')
# Debris never pushes the predicted player around.
rep('function addDebris(m,b){ debris.push({m,b});', 'function addDebris(m,b){ if(b){ b.collisionFilterGroup=4; } debris.push({m,b});')
# The player sphere only collides with the static town, like the server's character controller.
rep('player.position.set(4,.35,1.5); world.addBody(player);', 'player.position.set(4,.35,1.5); player.collisionFilterGroup=2; player.collisionFilterMask=1; world.addBody(player);')
# Trash piles are lit through the server.
rep("addEventListener('keydown',e=>{ if(e.code==='KeyF'){ const p=nearPile(); if(p) lightPile(p); } });", '')
rep("actEl.addEventListener('click',()=>{ const p=nearPile(); if(p) lightPile(p); });", "actEl.addEventListener('click',()=>NET.act());")
rep("function updateAct(){ const p=nearPile(); actEl.hidden=!p; }", "function updateAct(){ NET.updatePrompt(actEl); }")
# Clicks throw through the server; pointer lock on desktop for smooth mouse look.
rep("ray.setFromCamera({x:nx,y:ny},camera); throwBottle(ray.ray.direction.clone());", "ray.setFromCamera({x:nx,y:ny},camera); NET.throwDir(ray.ray.direction.clone());")
# Shader is locked to Blend: no number-key switching.
rep("addEventListener('keydown',e=>{ if(e.target.tagName==='INPUT') return; const n=parseInt(e.key,10); if(n>=1&&n<=9) applyStyle(ORDER[n-1]); else if(n===0) applyStyle(ORDER[9]); else if(e.code==='KeyB') applyStyle('blend'); });", '')
rep("applyStyle('blend'); goSpot('store'); fromHash(); addEventListener('hashchange',fromHash);",
    "applyStyle('blend'); setMix(.85,.45,.75); goSpot('store');")

# Movement: same feel as the look test, plus prediction bookkeeping and reconciliation.
rep("  if(keys.has('Space') && player.position.y<.4){ player.velocity.y=6.5; }",
    "  if(keys.has('Space') && player.position.y<.4){ player.velocity.y=6.5; }\n  NET.beforeStep(dt, mx, mz, speed);")
rep("  const speed=keys.has('ShiftLeft')?8:4.6;", "  const speed=(keys.has('ShiftLeft')||keys.has('ShiftRight')?8:4.6)*NET.speedScale();")
rep("  world.step(1/90,dt,6);\n  processBreaks();", "  world.step(1/90,dt,6);\n  NET.afterStep(dt);\n  processBreaks();")
rep("  // camera\n  bobT+=dt*(ml>0?speed*2.2:0);", "  NET.frame(dt, t);\n  // camera\n  bobT+=dt*(ml>0?speed*2.2:0);")

# Burning piles: the server counts the damage, so no local +$35 popups.
rep("p.acc+=dt; if(p.acc>2){ p.acc=0; addDamage(35,p.pos.clone().add(new THREE.Vector3(0,1.6,0))); }", "")

# Networking module goes right before the loop starts.
i = s.rindex('tick();\n</script>')
s = s[:i] + NET + '\ntick();\n</script>' + s[i + len('tick();\n</script>'):]

OUT.write_text(s)
print(f'wrote {OUT} ({len(s)} bytes) from {SRC}')
