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
PROPS = (HERE / 'props.js').read_text()
MINI = (HERE / 'minimap.js').read_text()
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
rep("scene.fog = new THREE.Fog(P.horizon, 70, 260);", "scene.fog = new THREE.Fog(P.horizon, 90, 430);")
# Town module runs right before the bake; the bake becomes a grid bake so far chunks get culled.
rep('\nbake(city);\n', '\n' + TOWN_JS + '\nTOWN.build();\nbakeGrid(city, 64);\n')
i = s.index("\n", s.index("vagrant({x:21.8,z:9.3,ry:-2.4,"))
s = s[:i] + "\nTOWN.afterPeople();" + s[i:]
# Trees and bushes register as burnables (GAME-86) and stay out of the grid bake.
rep("function tree(x,z,s=1,hexA='tx:leafA'){\n  const g=grp(city,x,0,z,R()*6);", "function tree(x,z,s=1,hexA='tx:leafA'){\n  const g=grp(city,x,0,z,R()*6); burnReg('tree',g,x,z,s);")
rep("function bush(x,z,s=1){ const g=grp(city,x,0,z);", "function bush(x,z,s=1){ const g=grp(city,x,0,z); burnReg('bush',g,x,z,s);")
# Sun shadows follow the player across town.
rep("  camera.rotation.set(pitch,yaw,0,'YXZ');\n", "  camera.rotation.set(pitch,yaw,0,'YXZ');\n  TOWN.cam();\n")
rep("  NET.frame(dt, t);\n", "  NET.frame(dt, t);\n  TOWN.frame(dt, t);\n")
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
rep("heldBottle.visible=handKick<.6;", "heldBottle.visible=handKick<.6; NET.vmPose(dt,ml>0);")

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

# Networking module goes right before the loop starts.
i = s.rindex('tick();\n</script>')
s = s[:i] + SETTINGS + '\n' + PROPS + '\n' + NET + '\n' + MINI + '\n' + PREWARM + '\ntick();\n</script>' + s[i + len('tick();\n</script>'):]

OUT.write_text(s)
print(f'wrote {OUT} ({len(s)} bytes) from {SRC}')
