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
SETTINGS = (HERE / 'settings.js').read_text()
ITEMS = (HERE / 'items-client.js').read_text()
FIGHTJS = (HERE / 'fight-client.js').read_text()
SKY = (HERE / 'sky.js').read_text()
PROPS = (HERE / 'props.js').read_text()
MINI = (HERE / 'minimap.js').read_text()
FIRE = (HERE / 'fire-client.js').read_text()
PREWARM = (HERE / 'prewarm.js').read_text()

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

# Sky (GAME-89): the sphere-clump clouds are replaced by clouds painted into the sky dome
# (tools/sky.js); dome and sun follow the camera. The floating soap bubbles go too: under the
# Blend shader they draw as flat pale discs hanging in the sky, which read as stray clouds.
def cut(start, end, new):
    global s
    a = s.index(start); b = s.index(end, a)
    s = s[:a] + new + s[b:]
cut('// ---------- sky dome ----------', '// ---------- sun character ----------', SKY + '\n')
cut('// ---------- clouds & bubbles ----------', '// ---------- physics ----------', '')
rep("  for(const b of bubbles){ b.position.y+=b.userData.v*dt; b.position.x+=Math.sin(t*.6+b.userData.ph)*dt*.4; if(b.position.y>26){ b.position.y=1; } }\n", "")
rep("  for(const c of clouds) c.position.x+=dt*.6;\n",
    "  skyDome.position.copy(camera.position); skyDome.material.uniforms.time.value=t; sunGroup.position.copy(camera.position).add(SUN_OFFSET);\n")

# No local props: the server owns crates and cones.
rep('spawnProps();\nconst starTex', 'const starTex')
# GAME-87: the couch, mattress and shopping cart under the bridge are movable props the
# server simulates (tools/props.js draws them). Drop their static copies, keep the cardboard.
a = s.index('  // couch (cushions, arms, sag)\n')
b = s.index("  staticBox(X-.8,.5,12.4,.35,.5,.5);\n") + len("  staticBox(X-.8,.5,12.4,.35,.5,.5);\n")
if not (0 < b - a < 6000) or 'const cart=grp(city' not in s[a:b] or 'const mt=grp(city' not in s[a:b]:
    raise SystemExit('look test changed around the couch / mattress / cart block')
s = s[:a] + "  put(B(1.0,.03,.8),0xB08A5A,city,X-.4,.03,8.6,{ry:.4,ns:true}); put(B(.7,.03,.6),0xA07E52,city,X+.7,.05,9.1,{ry:-.2,ns:true});\n" + s[b:]
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
rep("  // camera\n  bobT+=dt*(ml>0?speed*2.2:0);", "  NET.frame(dt, t);\n  MINI.frame(dt, t);\n  // camera\n  bobT+=dt*(ml>0?speed*2.2:0);")

# Settings (GAME-79): key bindings, run toggle, look sensitivity / invert, head bob.
rep("  let mx=0,mz=0; if(keys.has('KeyW')||keys.has('ArrowUp')) mz+=1; if(keys.has('KeyS')||keys.has('ArrowDown')) mz-=1; if(keys.has('KeyA')||keys.has('ArrowLeft')) mx-=1; if(keys.has('KeyD')||keys.has('ArrowRight')) mx+=1;",
    "  let mx=0,mz=0; if(SET.down('fwd')) mz+=1; if(SET.down('back')) mz-=1; if(SET.down('left')) mx-=1; if(SET.down('right')) mx+=1;")
rep("  const speed=(keys.has('ShiftLeft')||keys.has('ShiftRight')?8:4.6)*NET.speedScale();", "  const speed=(SET.running()?8:4.6)*NET.speedScale();")
rep("  if(keys.has('Space') && player.position.y<.4){ player.velocity.y=6.5; }", "  if(SET.down('jump') && player.position.y<.4){ player.velocity.y=6.5; }")
rep("const k=e.pointerType==='touch'?.006:.004; yaw-=dx*k; pitch=Math.max(-1.2,Math.min(1.2,pitch-dy*k));", "SET.lookDrag(dx,dy,e.pointerType==='touch');")
rep("player.position.y+1.25+Math.sin(bobT)*.04", "player.position.y+1.25+Math.sin(bobT)*.04*SET.bob()")
rep("vm.position.set(.2+Math.cos(bobT*.5)*.008,-.17+Math.abs(Math.sin(bobT*.5))*.01-handKick*.1", "vm.position.set(.2+Math.cos(bobT*.5)*.008*SET.bob(),-.17+Math.abs(Math.sin(bobT*.5))*.01*SET.bob()-handKick*.1")
# Throwable junk (GAME-82): the hand drops out of view when empty and only shows what you hold.
rep("-handKick*.1,-.45+handKick*.06); vm.rotation.x=-handKick*.9; heldBottle.visible=handKick<.6;", "-handKick*.1-NET.handDrop(),-.45+handKick*.06); vm.rotation.x=-handKick*.9; NET.heldVisible(handKick); NET.vmAnim(dt);")

# Burning piles: the server counts the damage, so no local +$35 popups.
rep("p.acc+=dt; if(p.acc>2){ p.acc=0; addDamage(35,p.pos.clone().add(new THREE.Vector3(0,1.6,0))); }", "")

# GAME-87: other players' arms can move. With o.armRig, vagrant() builds each arm on its
# own shoulder pivot (not baked into the body) so the client can swing them forward to
# grab, push and drag things.
rep("""  } else {
    for(const [i,s] of [[0,-1],[1,1]]){ const e=[s*.29,1.06,-.02], w=[s*.3,.82,.08];""",
"""  } else if(o.armRig){
    for(const [i,s] of [[0,-1],[1,1]]){ const pv=new THREE.Group(), rel=v=>[v[0]-sh[i][0],v[1]-sh[i][1],v[2]-sh[i][2]], e=rel([s*.29,1.06,-.02]), w=rel([s*.3,.82,.08]);
      limb([0,0,0],e,.06,.065,'tx:canvas|'+o.coat,pv); limb(e,w,.05,.058,'tx:canvas|'+o.coat,pv); put(CYL(.058,.058,.04,10),'tx:knit|'+o.hoodie,pv,...w); glove(pv,rel([s*.3,.76,.09]),[0,-1,.15],o,false);
      bake(pv); pv.position.set(...sh[i]); o.armRig.push(pv); }
  } else {
    for(const [i,s] of [[0,-1],[1,1]]){ const e=[s*.29,1.06,-.02], w=[s*.3,.82,.08];""")
rep("  bake(head); bake(g); head.position.y=1.62; g.add(head);", "  bake(head); bake(g); head.position.y=1.62; g.add(head); if(o.armRig) for(const pv of o.armRig) g.add(pv);")
# First-person hands reach out, grip and strain while you hold something (net-client.js vmPose).
rep("NET.heldVisible(handKick); NET.vmAnim(dt);", "NET.heldVisible(handKick); NET.vmPose(dt,ml>0); NET.vmAnim(dt);")

# Frame drops (fires, first smash): adding a light at runtime changes the scene's light
# count, and three.js then recompiles every lit shader (about 12 programs, a long freeze).
# Fires borrow from a fixed pool of lights made at startup instead; the pool follows the
# fires nearest the camera, so the light count never changes.
rep("function emitter(pos,{radius=.3,fire=1,smoke=1,light=true}={}){ const e={pos:pos.clone(),radius,fire,smoke,accF:0,accS:0}; if(light){ e.light=new THREE.PointLight(0xFF8A3C,0,8,2); e.light.position.copy(pos).add(new THREE.Vector3(0,.6,0)); scene.add(e.light); } emitters.push(e); return e; }",
    "const FIRE_LIGHTS=Array.from({length:4},()=>{ const l=new THREE.PointLight(0xFF8A3C,0,8,2); l.position.set(0,-50,0); scene.add(l); return l; }); let fireLightT=0;\n"
    "function assignFireLights(){ const c=camera.position, live=emitters.filter(e=>e.wantsLight&&e.fire>0).sort((a,b)=>a.pos.distanceToSquared(c)-b.pos.distanceToSquared(c)); for(const e of emitters) e.light=null; FIRE_LIGHTS.forEach((l,i)=>{ const e=live[i]; if(e){ e.light=l; l.position.copy(e.pos); l.position.y+=.6; } else l.intensity=0; }); }\n"
    "function emitter(pos,{radius=.3,fire=1,smoke=1,light=true}={}){ const e={pos:pos.clone(),radius,fire,smoke,accF:0,accS:0,wantsLight:light,light:null}; emitters.push(e); fireLightT=0; return e; }")
rep("function updateFX(dt,t){\n", "function updateFX(dt,t){\n  if((fireLightT-=dt)<=0){ fireLightT=.25; assignFireLights(); }\n")
# Shard geometry is made per shard; free it when old debris is dropped (it leaked GPU memory).
rep("const m=new THREE.Mesh(g,mat); m.castShadow=true;", "const m=new THREE.Mesh(g,mat); m.castShadow=true; m.userData.ownGeo=true;")
rep("if(debris.length>260){ const o=debris.shift(); scene.remove(o.m); if(o.b) world.removeBody(o.b); }",
    "if(debris.length>260){ const o=debris.shift(); scene.remove(o.m); if(o.b) world.removeBody(o.b); if(o.m.userData.ownGeo) o.m.geometry.dispose(); }")

# GAME-85: the panhandler's arms get shoulder pivots too (so he can drop his sign and fight),
# the sign is handed back on p.sign, and the knocked-out camera / fists run after the camera is placed.
rep("""  if(o.sign){
    for(const [i,s] of [[0,-1],[1,1]]){ const e=[s*.27,1.08,.1], w=[s*.17,1.0,.33];""",
"""  if(o.sign && o.armRig){
    for(const [i,s] of [[0,-1],[1,1]]){ const pv=new THREE.Group(), rel=v=>[v[0]-sh[i][0],v[1]-sh[i][1],v[2]-sh[i][2]], e=rel([s*.27,1.08,.1]), w=rel([s*.17,1.0,.33]);
      limb([0,0,0],e,.06,.065,'tx:canvas|'+o.coat,pv); limb(e,w,.05,.058,'tx:canvas|'+o.coat,pv); put(CYL(.058,.058,.04,10),'tx:knit|'+o.hoodie,pv,...w); glove(pv,rel([s*.2,1.0,.39]),[0,1,.2],o,false);
      bake(pv); pv.position.set(...sh[i]); o.armRig.push(pv); }
    const sg=new THREE.Mesh(new THREE.BoxGeometry(.66,.42,.012),[0,0,0,0,new THREE.MeshLambertMaterial({map:labelTex(o.sign,512,330,'#D9A866','#3A2410',42)}),0].map(m=>m||new THREE.MeshLambertMaterial({color:0xB98A50}))); sg.position.set(0,1.02,.4); sg.rotation.set(-.15,0,-.05); g.add(sg); sg.castShadow=true; o._sign=sg;
  } else if(o.sign){
    for(const [i,s] of [[0,-1],[1,1]]){ const e=[s*.27,1.08,.1], w=[s*.17,1.0,.33];""")
rep("const p={g,head,ph:Math.random()*6,wob:0,bodyRef:b,hy:1.62};", "const p={g,head,ph:Math.random()*6,wob:0,bodyRef:b,hy:1.62,sign:o._sign||null};")
rep("  camera.rotation.set(pitch,yaw,0,'YXZ');", "  camera.rotation.set(pitch,yaw,0,'YXZ');\n  FIGHT.afterCamera(dt, t);")

# Burnable trees and bushes (GAME-86): each one stays out of the city bake as its own small
# baked group in burnGroup, listed in BURN with the id the server uses ("t:N", build order).
rep("function lumpy(rad,sd){", "const burnGroup=new THREE.Group(); scene.add(burnGroup); const BURN=[];\nfunction lumpy(rad,sd){")
rep("  const g=grp(city,x,0,z,R()*6);\n  put(CYL(.12*s,.22*s,2.2*s,8),'tx:pole',g,0,1.1*s,0);",
    "  const g=grp(burnGroup,0,0,0), ry0=R()*6;\n  put(CYL(.12*s,.22*s,2.2*s,8),'tx:pole',g,0,1.1*s,0);")
rep("  const b=new CANNON.Body({mass:0,shape:new CANNON.Cylinder(.25*s,.25*s,2.2*s,8)}); b.position.set(x,1.1*s,z); world.addBody(b);\n}",
    "  bake(g); g.position.set(x,0,z); g.rotation.y=ry0; BURN.push({id:'t:'+BURN.length,type:'tree',g,x,z,s});\n  const b=new CANNON.Body({mass:0,shape:new CANNON.Cylinder(.25*s,.25*s,2.2*s,8)}); b.position.set(x,1.1*s,z); world.addBody(b);\n}")
rep("function bush(x,z,s=1){ const g=grp(city,x,0,z);", "function bush(x,z,s=1){ const g=grp(burnGroup,0,0,0);")
rep(",Math.sin(a)*.35*s); } }", ",Math.sin(a)*.35*s); } bake(g); g.position.set(x,0,z); BURN.push({id:'t:'+BURN.length,type:'bush',g,x,z,s}); }")
# Burning plants update with the other fire effects.
rep("updatePiles(dt); updateAct();", "updatePiles(dt); FIRE.update(dt); updateAct();")

# Networking module goes right before the loop starts.
i = s.rindex('tick();\n</script>')
s = s[:i] + SETTINGS + '\n' + PROPS + '\n' + FIRE + '\n' + ITEMS + '\n' + NET + '\n' + FIGHTJS + '\n' + MINI + '\n' + PREWARM + '\ntick();\n</script>' + s[i + len('tick();\n</script>'):]

OUT.write_text(s)
print(f'wrote {OUT} ({len(s)} bytes) from {SRC}')
