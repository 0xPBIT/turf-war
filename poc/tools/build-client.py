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
NET = (HERE / 'car-damage.js').read_text() + '\n' + (HERE / 'net-client.js').read_text()
HUD = (HERE / 'net-hud.html').read_text()
SETTINGS = (HERE / 'settings.js').read_text()
ITEMS = (HERE / 'items-client.js').read_text()
GLASS = (HERE / 'glass.js').read_text()
FIGHTJS = (HERE / 'fight-client.js').read_text()
SKY = (HERE / 'sky.js').read_text()
PROPS = (HERE / 'props.js').read_text()
MINI = (HERE / 'minimap.js').read_text()
FIRE = (HERE / 'fire-client.js').read_text()
PREWARM = (HERE / 'prewarm.js').read_text()
ANIMJS = (HERE / 'anim.js').read_text()
COPPER = (HERE / 'copper.js').read_text()
CHARS = (HERE / 'characters.js').read_text()
HYDRANTS = (HERE / 'hydrant-client.js').read_text()

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

# City vagrants (GAME-93): characters.js replaces the look test's camper vagrant() (kept, unused,
# as campVagrant) with urban outfits built from six jointed parts (p.parts) for ragdolls and punches.
rep('function vagrant(o){', CHARS + '\nfunction campVagrant(o){')
# First-person sleeve: a heather hoodie sleeve instead of the canvas field jacket with a denim elbow patch.
rep("limb([BX+.17,-.12,BZ+.11],[BX+.36,-.52,BZ+.42],.11,.088,'tx:canvas|'+0xE07A2E,handG,16);",
    "limb([BX+.17,-.12,BZ+.11],[BX+.36,-.52,BZ+.42],.11,.088,'tx:fleece|'+0x5A5F70,handG,16);")
rep("put(CYL(.094,.094,.05,16),0xB85E1E,handG,BX+.18,-.14,BZ+.125,{rz:.5,rx:-.45});", "put(CYL(.094,.094,.05,16),'tx:knit|'+0x4A4E5C,handG,BX+.18,-.14,BZ+.125,{rz:.5,rx:-.45});")
rep("put(B(.13,.012,.012,.004),0xB85E1E,handG,", "put(B(.13,.012,.012,.004),0x464A58,handG,")
rep("put(B(.1,.13,.02,.006),'tx:denim|'+0x6A86C8,sl,-.03,.02,.088,{rx:-.1,ry:-.3});", "put(B(.12,.03,.012,.004),0xC9CCD4,sl,-.03,.02,.092,{rx:-.1,ry:-.3,rz:.6}); put(B(.12,.03,.012,.004),0xC9CCD4,sl,-.03,.02,.094,{rx:-.1,ry:-.3,rz:-.6});")
rep("for(let k=0;k<5;k++) put(B(.012,.012,.012),0xF4ECD8,sl,-.085+k*.028,.088,.098,{ry:-.3});", "")
rep("put(B(.008,.36,.008),0x9A4C18,sl,.095,0,.0);", "put(B(.008,.36,.008),0x464A58,sl,.095,0,.0);")

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

# GAME-83: jump off anything you stand on (car hoods and roofs), not just the ground.
rep("  if(SET.down('jump') && player.position.y<.4){ player.velocity.y=6.5; }", "  if(SET.down('jump') && (player.position.y<.4 || NET.grounded())){ player.velocity.y=6.5; }")
# GAME-83: third-person camera while you are knocked down.
rep("  camera.rotation.set(pitch,yaw,0,'YXZ');\n", "  camera.rotation.set(pitch,yaw,0,'YXZ');\n  NET.knockedCamera(dt);\n")

# GAME-83: cars get a see-through cabin (roof, pillars, tinted glass windshield, windows,
# seats, dash, wheel) instead of a solid dark window band, and a hood + cabin collider
# you can climb onto. Same shape as carColliders() in server.mjs.
rep("[-.95,.94],[-.35,1.4],[.8,1.4],[1.5,1.0]", "[-.95,.94],[1.5,1.0]")
rep("const win=[[-.88,.95],[-.33,1.36],[.78,1.36],[1.44,1.0]]; const wm=shapeExtrude([...win,[1.44,.96],[-.88,.92]],Wd+.04,0x2A3050,g);",
    "carCabin(g,Wd,bodyHex);")
rep("put(B(.03,.42,Wd+.06),bodyHex,g,.25,1.15,0); put(B(.03,.4,Wd+.06),bodyHex,g,-.35,1.15,0,{rz:-.6});", "")
rep("const s=new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0),ry); staticBox(x,.8,z,Math.abs(s.x)*2.2+Math.abs(s.z)*.9,.8,Math.abs(s.z)*2.2+Math.abs(s.x)*.9);",
    "const s=new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0),ry), ax=Math.abs(s.x), az=Math.abs(s.z); staticBox(x,.545,z,ax*2.2+az*.875,.385,az*2.2+ax*.875); staticBox(x+s.x*.25,1.165,z+s.z*.25,ax*.9+az*.8,.235,az*.9+ax*.8);")
rep("function car(x,z,ry,bodyHex){", (HERE / 'car-cabin.js').read_text() + "\nfunction car(x,z,ry,bodyHex){")
# Car damage: keep the body mesh separate (unbaked) so dents can deform it.
rep("shapeExtrude(prof,Wd,bodyHex,g,.04);", "g.userData.body=shapeExtrude(prof,Wd,bodyHex,g,.04); g.userData.body.userData.nobake=1; CAR_GROUPS.push(g);")
rep("root.traverse(o=>{ if(!o.isMesh || o.userData.c===undefined) return;", "root.traverse(o=>{ if(!o.isMesh || o.userData.c===undefined || o.userData.nobake) return;")

# Burning piles: the server counts the damage, so no local +$35 popups.
rep("p.acc+=dt; if(p.acc>2){ p.acc=0; addDamage(35,p.pos.clone().add(new THREE.Vector3(0,1.6,0))); }", "")

# ---------- GAME-81: the full Puddlewick town ----------
TOWN_JS = (HERE / 'town-build.js').read_text()
def drop_line(prefix):
    global s
    lines = s.split('\n'); hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    if len(hits) != 1:
        raise SystemExit(f'expected 1 line starting with {prefix[:60]!r}, found {len(hits)}')
    del lines[hits[0]]; s = '\n'.join(lines)
# The look-test roads, sidewalks and lane paint become the generated road network.
drop_line("put(B(400,.06,ROADW),'tx:asphalt'")
drop_line('walkRun(-200,-16.6,-4.6,true,-1);')
drop_line('walkRun(-200,-5.7,-16.6,false,-1);')
drop_line('for(let x=-200;x<200;x+=4){ if(Math.abs(x+12)<5) continue;')
drop_line('for(let z=-200;z<200;z+=4){ if(Math.abs(z)<5) continue;')
drop_line('for(const s of [-1,1]){ paint(380,.12,0,s*3.2,0xF4F0FF);')
drop_line('for(let i=0;i<7;i++){ paint(.45,2.8,-14.7+i*.9,5.3,0xF7F4FF);')
drop_line('paint(.4,3.3,-7.9,-1.65,0xF7F4FF);')
drop_line('put(B(2.2,.02,1.2),0xF7F4FF,city,-8.9,.07,-2.2')
drop_line("sign(['STOP'],2.0,1.0,null,'#6E74C2',city,-9.4")
# The four corner houses move out to the suburbs (downtown sits on Main St north of Elm now).
for pre in ["house(-21,-11,", "house(-30,-11,", "house(-21,11,", "house(-30,11,"]:
    drop_line(pre)
# Houses can face any direction: rotate their collider with them.
rep('staticBox(x,base+h/2,z,w/2,(base+h)/2+.2,d/2);', 'staticBox(x,base+h/2,z,w/2,(base+h)/2+.2,d/2,ry);')
# The school becomes a function the town places on its own campus.
rep('// ---------- Sunnyside School ----------\n(function(){', '// ---------- Sunnyside School ----------\nfunction lookSchool(){')
rep("  for(let i=0;i<5;i++){ const bx=grp(city,-.5+i*.55,0,7.9); put(new THREE.TorusGeometry(.32,.03,6,16,Math.PI),METAL,bx,0,.05,0); }\n})();",
    "  for(let i=0;i<5;i++){ const bx=grp(city,-.5+i*.55,0,7.9); put(new THREE.TorusGeometry(.32,.03,6,16,Math.PI),METAL,bx,0,.05,0); }\n}")
# The overpass becomes the whole Route 9 Skyway: 400 m long, pillars clear of the cross streets.
rep("put(B(7.4,1.0,120),'tx:form',city,X,top-.5,0);", "put(B(7.4,1.0,400),'tx:form',city,X,top-.5,0);")
rep("put(B(.5,.08,120),'tx:conc',city,X+gx,top-1.04,0); put(B(.08,.6,120),'tx:conc',city,X+gx,top-1.36,0); put(B(.5,.08,120),'tx:conc',city,X+gx,top-1.68,0);",
    "put(B(.5,.08,400),'tx:conc',city,X+gx,top-1.04,0); put(B(.08,.6,400),'tx:conc',city,X+gx,top-1.36,0); put(B(.5,.08,400),'tx:conc',city,X+gx,top-1.68,0);")
rep("for(const z of [-30,-18,-6,6,18,30]){", "for(const z of [-198,-186,-174,-162,-150,-138,-126,-114,-102,-90,-66,-54,-42,-30,-18,-6,6,18,30,42,54,90,102,114,126,138,150,162,174,186,198]){")
rep("const jb=shapeExtrude([[-.3,0],[.3,0],[.12,.25],[.08,.8],[-.08,.8],[-.12,.25]],120,'tx:conc',city);", "const jb=shapeExtrude([[-.3,0],[.3,0],[.12,.25],[.08,.8],[-.08,.8],[-.12,.25]],400,'tx:conc',city);")
rep("for(let z=-56;z<=56;z+=4) put(B(.16,.02,.6),0x8F8AC0,city,X+s*3.35,top+.81,z,{ns:true}); }", "for(let z=-196;z<=196;z+=4) put(B(.16,.02,.6),0x8F8AC0,city,X+s*3.35,top+.81,z,{ns:true}); }")
rep("put(B(7.4,.08,120),'tx:asphalt',city,X,top+.04,0,{ns:true});", "put(B(7.4,.08,400),'tx:asphalt',city,X,top+.04,0,{ns:true});")
rep("for(const z of [-24,0,24]){ put(CYL(.08,.1,5,10),METAL,city,X+3.35,top+3.3,z);", "for(const z of [-168,-120,-72,-24,0,24,72,120,168]){ put(CYL(.08,.1,5,10),METAL,city,X+3.35,top+3.3,z);")
# Street trees and hedges that sat inside the new downtown, lot and road footprints.
rep("[[-4,-6.7],[10.8,-6.7],[-36,-7],[-18,-6.6],[-4,6.6],[15,6.6],[26,-14],[31,-10],[-36,8],[31,14],[-6,22],[4,26],[16,22],[-24,-18],[-14,18],[28,22]].forEach(",
    "[[-4,-6.7],[10.8,-6.7],[-4,6.6],[15,6.6],[-6,22],[28,22]].forEach(")
rep("[[-17,-8],[-25.5,-8],[-26,8],[-17,8.2],[8.6,-6.6],[18,-6.7],[-33.5,-8],[-33.5,8]].forEach(", "[[8.6,-6.6],[18,-6.7]].forEach(")
# Background hills move out past the town limits; haze reaches further for a town this size.
rep("const r=170+(i%3)*25; const h=put(new THREE.IcosahedronGeometry(40+(i%4)*10,2)", "const r=330+(i%3)*35; const h=put(new THREE.IcosahedronGeometry(80+(i%4)*20,2)")
rep("scene.fog = new THREE.Fog(P.horizon, 70, 260);", "scene.fog = new THREE.Fog(P.horizon, 85, 340);")
# Town module runs right before the bake; the bake becomes a grid bake so far chunks get culled.
# GAME-81: baked town chunks (vertex-colour materials) follow the look switch too.
rep("if(o.isMesh && o.userData.c !== undefined) o.material = getMat(o.userData.c, mode); });",
    "if(o.isMesh && o.userData.c !== undefined) o.material = getMat(o.userData.c, mode); else if(o.isMesh && o.userData.vc !== undefined) o.material = vcMat(o.userData.vc, mode); });")
# GAME-97: look-test placements that clash with the full town (GAME-81).
# The fifth Main St cobra lamp (x=34) stood in the mouth of Maple Row; it moves to the corner past it.
rep("for(let x=-34;x<=34;x+=17){ const g=grp(city,x,0,5.5);", "for(const x of [-34,-17,0,17,41.5]){ const g=grp(city,x,0,5.5);")
# The x=24 power pole ran up through the Route 9 Skyway deck; the line now hops the deck between poles on either side.
rep("for(const x of [-40,-24,8,24,40]){ const g=grp(city,x,0,-5.55);", "for(const x of [-40,-24,8,15,30,40]){ const g=grp(city,x,0,-5.55);")
rep('\nbake(city);\n', '\n' + TOWN_JS + '\nTOWN.build();\nbakeGrid(city, 64);\n')
i = s.index("\n", s.index("vagrant({x:21.8,z:9.3,ry:-2.4,"))
s = s[:i] + "\nTOWN.afterPeople();" + s[i:]
# Sun shadows follow the player across town.
rep("  camera.rotation.set(pitch,yaw,0,'YXZ');\n", "  camera.rotation.set(pitch,yaw,0,'YXZ');\n  TOWN.cam();\n")
rep("  NET.frame(dt, t);\n", "  NET.frame(dt, t);\n  TOWN.frame(dt, t);\n")
# First-person hands reach out, grip and strain while you hold something (net-client.js vmPose).
rep("NET.heldVisible(handKick); NET.vmAnim(dt);", "NET.heldVisible(handKick); NET.vmPose(dt,ml>0); NET.vmAnim(dt); COPPER.viewmodel(dt,t);")

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

# Player animation (GAME-92): the first-person hand and camera take offsets from the shared
# animation helper (tools/anim.js); other players' vagrants are posed through p.parts in net-client.
rep("NET.vmPose(dt,ml>0);", "vm.rotation.y=0; vm.rotation.z=0; NET.vmPose(dt,ml>0); ANIM.applyFP(vm,heldBottle,dt,ml>0);")
rep("player.position.y+1.25+Math.sin(bobT)*.04*SET.bob()", "player.position.y+1.25+Math.sin(bobT)*.04*SET.bob()+ANIM.camY()")
rep("camera.rotation.set(pitch,yaw,0,'YXZ');", "camera.rotation.set(pitch+ANIM.camPitch(),yaw,0,'YXZ');")
# GAME-98: the idle fists hide once the viewmodel modules have run, so an animation's own hand
# pose is the only hand on screen, and nothing floats in front of the camera while ragdolled.
rep("COPPER.viewmodel(dt,t);", "COPPER.viewmodel(dt,t); FIGHT.afterViewmodel();")

# Networking module goes right before the loop starts.
i = s.rindex('tick();\n</script>')
s = s[:i] + SETTINGS + '\n' + ANIMJS + '\n' + PROPS + '\n' + FIRE + '\n' + GLASS + '\n' + ITEMS + '\n' + HYDRANTS + '\n' + NET + '\n' + COPPER + '\n' + FIGHTJS + '\n' + MINI + '\n' + PREWARM + '\ntick();\n</script>' + s[i + len('tick();\n</script>'):]

OUT.write_text(s)
print(f'wrote {OUT} ({len(s)} bytes) from {SRC}')
