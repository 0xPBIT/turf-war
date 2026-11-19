// ===================== Puddlewick: the whole town (GAME-81) =====================
// Builds the rest of the GAME-74 town around the look-test corner, with the look-test's own
// builders (house, tree, car, windowPane, sign...) so everything shares the locked Blend look.
// World axes: +x = south on the concept map, +z = west. Main St runs along x at z=0,
// Elm Ave along z at x=-12, the Route 9 Skyway deck along z at x=22.
// Planters, flower beds and reeds join the look test's BURN list (GAME-86: trees and bushes,
// id "t:N" in build order) and stay out of the grid bake as their own small baked groups.
function burnReg(type,g,x,z,s){ BURN.push({id:'t:'+BURN.length,type,g,x,z,s}); g.userData.nobake=true; }
// Lampposts copper can be stripped from (GAME-91): the look test's five on Main St, then ours.
const LAMPS=[0,1,2,3,4].map(i=>({id:'lamp:'+i,p:[-34+i*17,0,5.5],ry:0,style:'cobra'}));
// Merge a group's meshes per material in the group's own space (bake() assumes a root at the origin).
function bakeLocal(root){
  root.updateMatrixWorld(true); const inv=new THREE.Matrix4().copy(root.matrixWorld).invert(), groups=new Map(), kill=[], m4=new THREE.Matrix4();
  root.traverse(o=>{ if(!o.isMesh || o.userData.c===undefined) return; let g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone(); g.applyMatrix4(m4.multiplyMatrices(inv,o.matrixWorld));
    for(const k of Object.keys(g.attributes)) if(!['position','normal','uv'].includes(k)) g.deleteAttribute(k);
    if(!g.attributes.uv) g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(g.attributes.position.count*2),2));
    const key=o.userData.c; if(typeof key==='string'){ const t=TILE[key.slice(3).split('|')[0]]; if(t) worldUV(g,t); }
    const sk=key+(o.castShadow?'':'#ns'); if(!groups.has(sk)) groups.set(sk,{key,cast:o.castShadow,list:[]}); groups.get(sk).list.push(g); kill.push(o); });
  for(const o of kill) o.parent.remove(o);
  for(const {key,cast,list} of groups.values()){ const m=new THREE.Mesh(mergeGeometries(list,false),getMat(key)); m.userData.c=key; m.userData.baked=1; m.castShadow=cast; m.receiveShadow=true; root.add(m); }
}
// Grid bake: static detail merged per material per cell, so chunks behind you or out of the
// shadow camera get culled instead of drawing the whole town every frame.
const VC_MATS=new Map();
// One vertex-colour clone per (style, base). Baked meshes carry userData.vc so setMatMode swaps them
// with the rest of the town when the look switches (gloss at build time, Blend/toon once applied).
function vcMat(base, mode=matMode){ const k=mode+'|'+base; if(!VC_MATS.has(k)){ const m=getMat(base==='vc'?0xffffff:base, mode).clone(); m.vertexColors=true; VC_MATS.set(k,m); } return VC_MATS.get(k); }
function bakeGrid(root,cell){
  for(const b of BURN) if(b.g.userData.nobake) bakeLocal(b.g);
  // Window interiors (flat planes behind the glass) merge per material and cell; the glass and its
  // highlight stay separate so panes can still break one by one. Highlights skip the ink pass.
  { const ints=new Map(), kill=[], c=new THREE.Vector3(); root.updateMatrixWorld(true);
    root.traverse(o=>{ if(!o.isMesh || o.material!==glassMat) return; const par=o.parent;
      for(const k of par.children){ if(k.isMesh && k!==o && k.geometry.type==='PlaneGeometry' && Math.abs(k.position.z-.03)<1e-4 && k.material.type==='MeshBasicMaterial' && !k.material.transparent){ const g=k.geometry.clone().applyMatrix4(k.matrixWorld); g.computeBoundingBox(); g.boundingBox.getCenter(c); const key=k.material.uuid+'@'+Math.floor(c.x/cell)+','+Math.floor(c.z/cell); if(!ints.has(key)) ints.set(key,{mat:k.material,list:[]}); ints.get(key).list.push(g); kill.push(k); }
        else if(k.isMesh && k.material.transparent && k.material.type==='MeshBasicMaterial' && k.geometry.type==='PlaneGeometry') fxl(k); } });
    for(const k of kill) k.parent.remove(k);
    for(const {mat,list} of ints.values()){ const m=new THREE.Mesh(mergeGeometries(list,false),mat); m.userData.baked=1; root.add(m); } }
  root.updateMatrixWorld(true); const groups=new Map(), kill=[], c=new THREE.Vector3();
  const skip=o=>{ for(let q=o; q && q!==root; q=q.parent) if(q.userData.nobake) return true; return false; };
  root.traverse(o=>{ if(!o.isMesh || o.userData.c===undefined || o.userData.baked || skip(o)) return; let g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone(); g.applyMatrix4(o.matrixWorld);
    for(const k of Object.keys(g.attributes)) if(!['position','normal','uv'].includes(k)) g.deleteAttribute(k);
    if(!g.attributes.uv) g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(g.attributes.position.count*2),2));
    const key=o.userData.c; if(typeof key==='string'){ const t=TILE[key.slice(3).split('|')[0]]; if(t) worldUV(g,t); }
    // Tints become vertex colours, so every plain colour (and every tint of one texture) shares a draw call.
    const isS=typeof key==='string', base=typeof key==='number'?'vc':isS?key.split('|')[0]:key, tint=typeof key==='number'?key:(isS&&key.includes('|')?parseInt(key.split('|')[1]):0xffffff);
    const col=new THREE.Color(tint), n=g.attributes.position.count, ca=new Float32Array(n*3); for(let i=0;i<n;i++){ ca[i*3]=col.r; ca[i*3+1]=col.g; ca[i*3+2]=col.b; } g.setAttribute('color',new THREE.BufferAttribute(ca,3));
    g.computeBoundingBox(); g.boundingBox.getCenter(c); const big=g.boundingBox.max.x-g.boundingBox.min.x>cell||g.boundingBox.max.z-g.boundingBox.min.z>cell;
    const sk=(typeof base==='object'?'o'+(base.uuid||base.id||''):base)+(o.castShadow?'':'#ns')+'@'+(big?'big':Math.floor(c.x/cell)+','+Math.floor(c.z/cell));
    if(!groups.has(sk)) groups.set(sk,{base,cast:o.castShadow,list:[]}); groups.get(sk).list.push(g); kill.push(o); });
  for(const o of kill) o.parent.remove(o);
  for(const {base,cast,list} of groups.values()){ const m=new THREE.Mesh(mergeGeometries(list,false),vcMat(base)); m.userData.baked=1; m.userData.vc=base; m.castShadow=cast; m.receiveShadow=true; root.add(m); }
}

const TOWN=(()=>{
const HP=Math.PI/2, FACE={'+z':0,'-z':Math.PI,'+x':HP,'-x':-HP};
let rs=8101; const rnd=()=>{ rs=(rs*16807)%2147483647; return (rs-1)/2147483646; };
const pick=a=>a[(rnd()*a.length)|0], rr=(a,b)=>a+rnd()*(b-a);
const META={ roads:[], walks:[], lots:[], buildings:[], decks:[] };
const PROPS=[];
const css=h=>'#'+new THREE.Color(h).getHexString();
const colOf=k=>typeof k==='number'?css(k):({ 'tx:brickRed':'#C9605A','tx:brickPink':'#E2848F','tx:brickYel':'#F2C76A','tx:stuccoPink':'#FF8FB0','tx:stuccoCream':'#FFF4E6',
  'tx:sidPink':'#FFB9CF','tx:sidBlue':'#A9E4FF','tx:sidYel':'#FFE48A','tx:sidLav':'#CDBDFF','tx:sidMint':'#A8F0D8','tx:sidPeach':'#FFD0A8','tx:sidWhite':'#F4F2FA','tx:sidSage':'#C8E6A0',
  'tx:shGrape':'#8D6BEA','tx:shGum':'#F06E98','tx:shMint':'#2CB98F','tx:shTang':'#F28E2B','tx:brickTan':'#D9A77A','tx:brickBlue':'#7FA8E0','tx:brickCream':'#F2E3C4',
  'tx:stuccoMint':'#9EE8CF','tx:stuccoSky':'#A8DCFF','tx:stuccoLemon':'#FFE58A','tx:stuccoLilac':'#D5C4FF','tx:stuccoPeach':'#FFC4A0','tx:ribGrey':'#9AA2B8','tx:form':'#BDB8E8','tx:gravel':'#A9A4C8','tx:conc':'#DCD6EA' })[k]||'#cccccc';
const rect=(list,x0,z0,x1,z1,extra)=>list.push({x:+Math.min(x0,x1).toFixed(2),z:+Math.min(z0,z1).toFixed(2),w:+Math.abs(x1-x0).toFixed(2),d:+Math.abs(z1-z0).toFixed(2),...extra});
function bmeta(x,z,hw,hd,ry,wall,roof,name){ META.buildings.push({x:+x.toFixed(2),z:+z.toFixed(2),hw:+hw.toFixed(2),hd:+hd.toFixed(2),ry:+(ry||0).toFixed(4),wall:colOf(wall),roof:colOf(roof),name:name||''}); }

// ---------- small helpers ----------
const G=(x,z,face=0)=>grp(city,x,0,z,typeof face==='number'?face:FACE[face]);
const _v=new THREE.Vector3();
function L(g,x,y,z){ g.updateMatrixWorld(true); return _v.set(x,y,z).applyMatrix4(g.matrixWorld).clone(); }
function solid(g,lx,ly,lz,hx,hy,hz,tag){ const p=L(g,lx,ly,lz); const b=staticBox(p.x,p.y,p.z,hx,hy,hz,g.rotation.y); if(tag) b.twTag=tag; return b; }
function postBody(x,z,r,h,tag){ const b=new CANNON.Body({mass:0,shape:new CANNON.Cylinder(r,r,h,8)}); b.position.set(x,h/2,z); world.addBody(b); if(tag) b.twTag=tag; return b; }
const lastBody=()=>world.bodies[world.bodies.length-1];
function T(x,z,s=1,leaf){ tree(x,z,s,leaf||(rnd()<.35?'tx:leafB':'tx:leafA')); }
function Bu(x,z,s=1){ bush(x,z,s); }
function parked(x,z,ry,hex){ car(x,z,ry,hex??pick(CARS)); lastBody().twTag='car'; }
const CARS=[0xFF8A7A,P.mint,0x3FB8FF,0xFFC93C,0x8F6BFF,0xFF6E9E,0xF4F7FF,0x6C74C4,0xE8343F,0x9BE36B,0xFFB86B];
function txt(t,w,h,bg,fg,parent,x,y,z,ry=0){ const m=sign(Array.isArray(t)?t:[t],w,h,bg,fg,parent,x,y,z,ry); m.material.toneMapped=false; return m; }

// ---------- extra surface textures ----------
function textures(){
  sidingTex('sidMint','#A8F0D8'); sidingTex('sidPeach','#FFD0A8'); sidingTex('sidWhite','#F4F2FA'); sidingTex('sidSage','#C8E6A0');
  TK=1.3; brickTex('brickTan','#D9A77A','#EFE4D6'); brickTex('brickBlue','#7FA8E0','#E8EEF8'); brickTex('brickCream','#F2E3C4','#FBF6EC',30,10); TK=1.9;
  stuccoTex('stuccoMint','#9EE8CF'); stuccoTex('stuccoSky','#A8DCFF'); stuccoTex('stuccoLemon','#FFE58A'); stuccoTex('stuccoLilac','#D5C4FF'); stuccoTex('stuccoPeach','#FFC4A0');
  ribTex('ribRed','#E0645A',14); ribTex('ribTeal','#2FB5A8',14); ribTex('ribYel','#F2B83A',14); ribTex('ribBlue','#4F86E8',14);
  stuccoTex('ballast','#9C98B0'); woodTex('tie','#7A5A44',3,1.2); dirtTex('dirtPath','#E2CDA0');
  mkTex('water',512,6,(g,s)=>{ g.fillStyle='#4FB8F0'; g.fillRect(0,0,s,s); blotch(g,s,30,'rgba(20,90,200,.18)',30,120); blotch(g,s,20,'rgba(255,255,255,.12)',20,70);
    g.strokeStyle='rgba(255,255,255,.35)'; g.lineWidth=2; for(let i=0;i<60;i++){ const x=R()*s,y=R()*s,l=10+R()*30; g.beginPath(); g.moveTo(x,y); g.quadraticCurveTo(x+l/2,y-3,x+l,y); g.stroke(); } });
  mkTex('turf',512,12,(g,s)=>{ for(let i=0;i<8;i++){ g.fillStyle=i%2?'#6FD64C':'#5EC83F'; g.fillRect(0,i*s/8,s,s/8); } speckle(g,s,9000,['rgba(0,0,0,.06)','rgba(255,255,255,.07)'],1.2); });
  mkTex('track',256,3,(g,s)=>{ g.fillStyle='#D8644E'; g.fillRect(0,0,s,s); speckle(g,s,9000,['rgba(0,0,0,.12)','rgba(255,255,255,.1)'],1.2); });
  mkTex('mulch',256,2,(g,s)=>{ g.fillStyle='#9A6A48'; g.fillRect(0,0,s,s); for(let i=0;i<1600;i++){ g.fillStyle=jit('#9A6A48',.12,.08); g.save(); g.translate(R()*s,R()*s); g.rotate(R()*3); g.fillRect(-4,-1,8,2.4); g.restore(); } });
  mkTex('rubber',256,2,(g,s)=>{ g.fillStyle='#4FA3E8'; g.fillRect(0,0,s,s); speckle(g,s,9000,['rgba(0,0,0,.12)','rgba(255,255,255,.12)','rgba(255,90,140,.4)','rgba(255,220,80,.4)'],1.4); });
  mkTex('tileRoof',512,1.6,(g,s)=>{ g.fillStyle='#B4553E'; g.fillRect(0,0,s,s); const rh=s/10; for(let r=0;r<10;r++){ for(let i=-1;i<9;i++){ const x=i*s/8+(r%2)*s/16; const gr=g.createLinearGradient(x,0,x+s/8,0); gr.addColorStop(0,jit('#D9735A',.06)); gr.addColorStop(1,jit('#A9493A',.06)); g.fillStyle=gr; g.fillRect(x+1,r*rh,s/8-2,rh-2); } } speckle(g,s,4000,['rgba(0,0,0,.1)','rgba(255,255,255,.08)']); });
  // storefront interiors: lit, readable at a glance through the glass
  INT.diner=interior('#F7E9D8',(g,s)=>{ for(let i=0;i<4;i++){ g.fillStyle='#E8343F'; g.fillRect(i*s/4+8,s*.55,s/4-16,s*.3); g.fillStyle='#FFFFFF'; g.fillRect(i*s/4+18,s*.6,s/4-36,s*.06); } g.fillStyle='#C8CDDD'; g.fillRect(0,s*.88,s,s*.12); for(let x=0;x<s;x+=32) for(let y=s*.88;y<s;y+=16){ g.fillStyle=((x+y)/16)%2?'#2E2350':'#FFFFFF'; g.fillRect(x,y,16,16); } g.fillStyle='#3FB8FF'; for(let i=0;i<5;i++){ g.beginPath(); g.arc(30+i*110,40,12,0,7); g.fill(); } });
  INT.barber=interior('#DDF3FF',(g,s)=>{ for(let i=0;i<3;i++){ g.fillStyle='#BFE8FF'; g.fillRect(20+i*165,30,130,170); g.fillStyle='#2E2350'; g.fillRect(55+i*165,240,60,110); g.fillStyle='#E8343F'; g.fillRect(45+i*165,215,80,40); } g.fillStyle='#F4F0F8'; g.fillRect(0,s*.86,s,s*.14); });
  INT.laundry=interior('#E8F7FF',(g,s)=>{ for(let r=0;r<2;r++) for(let i=0;i<5;i++){ const x=50+i*100,y=150+r*200; g.fillStyle='#FFFFFF'; g.fillRect(x-42,y-60,84,120); g.fillStyle='#2E2350'; g.beginPath(); g.arc(x,y,32,0,7); g.fill(); g.fillStyle='#7FD3FF'; g.beginPath(); g.arc(x,y,24,0,7); g.fill(); } });
  INT.books=interior('#3B2F4A',(g,s)=>{ const pal=['#FF6E9E','#FFC93C','#3FB8FF','#26D3A0','#8F6BFF','#FFFFFF','#E8343F','#FF9F1C']; for(let r=0;r<5;r++){ const y=r*s/5; g.fillStyle='#8A6648'; g.fillRect(0,y+s/5-8,s,8); let x=2; while(x<s-4){ const w=6+R()*10,h=s/5-24-R()*20; g.fillStyle=pal[(R()*8)|0]; g.fillRect(x,y+s/5-8-h,w,h); x+=w+1; } } });
  INT.pawn=interior('#2E3350',(g,s)=>{ g.fillStyle='#FFC93C'; for(let i=0;i<4;i++){ g.save(); g.translate(60+i*120,170); g.rotate(-.2); g.beginPath(); g.ellipse(0,40,32,40,0,0,7); g.fill(); g.fillRect(-6,-110,12,110); g.restore(); } g.fillStyle='#1A1D30'; for(let i=0;i<4;i++){ g.fillRect(20+i*125,320,100,75); g.fillStyle='#7FD3FF'; g.fillRect(28+i*125,328,84,59); g.fillStyle='#1A1D30'; } });
  INT.office=interior('#EAF0FA',(g,s)=>{ for(let y=0;y<s;y+=14){ g.fillStyle='rgba(60,60,110,.18)'; g.fillRect(0,y,s,5); } g.fillStyle='#8A6648'; g.fillRect(40,s*.7,s-80,20); g.fillStyle='#3FB8FF'; g.fillRect(90,s*.55,70,50); g.fillRect(320,s*.55,70,50); });
  INT.toys=interior('#FFF3D6',(g,s)=>{ const pal=['#FF6E9E','#FFC93C','#3FB8FF','#26D3A0','#8F6BFF','#FF9F1C']; for(let r=0;r<3;r++){ g.fillStyle='#F4F0F8'; g.fillRect(0,r*s/3+s/3-10,s,10); for(let i=0;i<7;i++){ g.fillStyle=pal[(i+r)%6]; const x=20+i*70,y=r*s/3+s/3-10; if((i+r)%3===0){ g.beginPath(); g.arc(x+25,y-26,24,0,7); g.fill(); } else g.fillRect(x,y-55,50,55); } } });
  INT.flowers=interior('#F0FFF0',(g,s)=>{ for(let i=0;i<40;i++){ const x=R()*s,y=s*.4+R()*s*.5; g.fillStyle='#3FBE3A'; g.fillRect(x-2,y,4,40); g.fillStyle=['#FF6E9E','#FFC93C','#FF4D7E','#FFFFFF','#8F6BFF'][i%5]; g.beginPath(); g.arc(x,y,10+R()*8,0,7); g.fill(); } g.fillStyle='#B98D5E'; g.fillRect(0,s*.88,s,s*.12); });
  INT.video=interior('#2B2240',(g,s)=>{ const pal=['#FF6E9E','#FFC93C','#3FB8FF','#26D3A0','#8F6BFF','#E8343F']; for(let r=0;r<4;r++){ for(let i=0;i<16;i++){ g.fillStyle=pal[(i*7+r)%6]; g.fillRect(6+i*32,20+r*120,26,90); } } });
  INT.lobby=interior('#3A1F3A',(g,s)=>{ g.fillStyle='#E8343F'; g.fillRect(0,s*.7,s,s*.3); for(let i=0;i<3;i++){ g.fillStyle=['#FFC93C','#3FB8FF','#FF6E9E'][i]; g.fillRect(30+i*165,40,120,180); g.fillStyle='#2E2350'; g.fillRect(45+i*165,60,90,40); } g.fillStyle='#FFF6D0'; g.fillRect(180,260,150,70); });
  INT.dark=interior('#3A3F5E',(g,s)=>{ blotch(g,s,10,'rgba(255,255,255,.06)',40,120); });
  INT.mart=interior('#F4F0F8',(g,s)=>{ const pal=['#FF6E9E','#FFC93C','#3FB8FF','#26D3A0','#FF9F1C','#8F6BFF','#FFFFFF','#E8343F']; for(let r=0;r<4;r++){ g.fillStyle='#C8CDDD'; g.fillRect(0,r*s/4+s/4-8,s,8); let x=2; while(x<s-6){ const w=10+R()*16,h=24+R()*(s/4-50); g.fillStyle=pal[(R()*8)|0]; g.fillRect(x,r*s/4+s/4-8-h,w,h); x+=w+2; } } g.fillStyle='rgba(255,255,230,.25)'; g.fillRect(0,0,s,40); });
  INT.gym=interior('#F2D9A8',(g,s)=>{ g.strokeStyle='#E8343F'; g.lineWidth=6; g.beginPath(); g.arc(s/2,s*.95,140,Math.PI,0); g.stroke(); g.fillStyle='#FFFFFF'; g.fillRect(s/2-40,40,80,60); g.strokeStyle='#FF9F1C'; g.beginPath(); g.arc(s/2,110,18,0,7); g.stroke(); });
  INT.classroom=interior('#FFF8E6',(g,s)=>{ g.fillStyle='#2E5E4A'; g.fillRect(40,40,s-80,150); g.fillStyle='#FFFFFF'; g.font='bold 40px sans-serif'; g.fillText('A B C  1 2 3',80,130); for(let i=0;i<6;i++){ g.fillStyle=['#FF6E9E','#FFC93C','#3FB8FF'][i%3]; g.fillRect(30+i*80,300,60,40); } });
}
const INT={};
function interior(bg,draw){ const name='int'+Object.keys(INT).length; mkTex(name,512,0,(g,s)=>{ g.fillStyle=bg; g.fillRect(0,0,s,s); draw(g,s); const gr=g.createLinearGradient(0,0,0,s); gr.addColorStop(0,'rgba(255,255,230,.15)'); gr.addColorStop(1,'rgba(0,0,30,.25)'); g.fillStyle=gr; g.fillRect(0,0,s,s); },1);
  return new THREE.MeshStandardMaterial({ map:TEX[name], roughness:.85, emissive:0xffffff, emissiveMap:TEX[name], emissiveIntensity:.14 }); }

// ================= road network =================
// axis 'x' roads run north-south (along x) at z=at; axis 'z' roads run east-west at x=at.
const ROADS=[
  { id:'main',  name:'MAIN ST',   axis:'x', at:0,   from:-200, to:200 },
  { id:'elm',   name:'ELM AVE',   axis:'z', at:-12, from:-76,  to:72 },
  { id:'oak',   name:'OAK AVE',   axis:'z', at:72,  from:-76,  to:200 },
  { id:'creek', name:'CREEK RD',  axis:'x', at:72,  from:-200, to:200 },
  { id:'pine',  name:'PINE ST',   axis:'x', at:-76, from:-200, to:200 },
  { id:'maple', name:'MAPLE ROW', axis:'z', at:34,  from:0,    to:150, res:true },
  { id:'birch', name:'BIRCH LN',  axis:'z', at:110, from:0,    to:124, res:true },
];
const RW=3.5, SW=5.7;      // half road width, outer edge of the sidewalk band
// Intersections and who controls them (matches the server's traffic.intersections).
const IX=[];
function intersections(){
  for(let i=0;i<ROADS.length;i++) for(let j=i+1;j<ROADS.length;j++){
    const a=ROADS[i], b=ROADS[j]; if(a.axis===b.axis) continue;
    const ra=a.axis==='x'?a:b, rb=a.axis==='x'?b:a;   // ra runs along x at z=ra.at; rb runs along z at x=rb.at
    const x=rb.at, z=ra.at;
    if(x<ra.from-.1||x>ra.to+.1||z<rb.from-.1||z>rb.to+.1) continue;
    const endA=Math.abs(x-ra.from)<.2||Math.abs(x-ra.to)<.2, endB=Math.abs(z-rb.from)<.2||Math.abs(z-rb.to)<.2;
    IX.push({ x,z, ra,rb, endA,endB, owner: endB?rb:endA?ra:(i<j?a:b), id:ra.id+'_'+rb.id,
      control: (ra.res||rb.res)?'yield' : (ra.id==='main'&&rb.id==='oak')?'light':'stop' });
  }
}
// Gaps along road r where other roads meet it: [lo,hi] in r's axis coordinate.
function gapsFor(r,side){
  const out=[];
  for(const ix of IX){ if(ix.ra!==r && ix.rb!==r) continue;
    const other=ix.ra===r?ix.rb:ix.ra, c=r.axis==='x'?ix.x:ix.z;
    const rEnds=ix.ra===r?ix.endA:ix.endB, oEnds=ix.ra===r?ix.endB:ix.endA;
    if(rEnds) continue;                                   // r stops here: roadEnds() handles it
    if(oEnds){ const oSide=Math.abs(other.from-r.at)<.3?1:-1; if(oSide!==side) continue; out.push([c-SW,c+SW]); continue; }
    const owner=ROADS.indexOf(r)<ROADS.indexOf(other);
    out.push(owner?[c-RW,c+RW]:[c-SW,c+SW]);
  }
  return out.sort((a,b)=>a[0]-b[0]);
}
function runs(from,to,gaps){ const out=[]; let s=from; for(const [a,b] of gaps){ if(b<=s) continue; if(a>s) out.push([s,Math.min(a,to)]); s=Math.max(s,b); if(s>=to) break; } if(s<to) out.push([s,to]); return out.filter(([a,b])=>b-a>.3); }
function roadEnds(r){   // where a road stops at a T: extend its sidewalks to the cross road's asphalt
  let from=r.from, to=r.to;
  for(const ix of IX){ const mine=ix.ra===r?ix.endA:ix.rb===r?ix.endB:false; if(!mine) continue; const c=r.axis==='x'?ix.x:ix.z; if(Math.abs(c-r.from)<.2) from=c+RW; else to=c-RW; }
  return [from,to];
}
function walkSeg(r,a,b,side){   // side +1: the +z (axis x) or +x (axis z) side of the road
  const len=b-a, c=(a+b)/2, o=r.at+side*4.6;
  if(r.axis==='x'){ walkRun(a,b,o,true,side); rect(META.walks,a,r.at+side*RW,b,r.at+side*SW); }
  else { walkRun(a,b,o,false,side); rect(META.walks,r.at+side*RW,a,r.at+side*SW,b); }
}
function stripe(r,s0,s1,off,wid,hex){ const len=s1-s0, c=(s0+s1)/2; if(len<.05) return; if(r.axis==='x') paint(len,wid,c,r.at+off,hex); else paint(wid,len,r.at+off,c,hex); }
function roads(){
  ROADS.forEach((r,i)=>{
    const len=r.to-r.from, c=(r.from+r.to)/2, y=.03+i*.0007, h=.06+i*.0014;
    if(r.axis==='x') put(B(len,h,RW*2),'tx:asphalt',city,c,y,r.at,{ns:true}); else put(B(RW*2,h,len),'tx:asphalt',city,r.at,y,c,{ns:true});
    if(r.axis==='x') rect(META.roads,r.from,r.at-RW,r.to,r.at+RW,{name:r.name,kind:r.res?'lane':'road'}); else rect(META.roads,r.at-RW,r.from,r.at+RW,r.to,{name:r.name,kind:r.res?'lane':'road'});
    const [f,t]=roadEnds(r);
    for(const side of [-1,1]) for(const [a,b] of runs(f,t,gapsFor(r,side))) walkSeg(r,a,b,side);
    // lane paint: worn double yellow and white edge lines, broken at intersections
    if(!r.res){
      const gaps=IX.filter(ix=>ix.ra===r||ix.rb===r).map(ix=>{ const cc=r.axis==='x'?ix.x:ix.z; return [cc-7,cc+7]; }).sort((a,b)=>a[0]-b[0]);
      for(const [a,b] of runs(r.from,r.to,gaps)){
        for(let s=a; s<b-1; s+=4){ const e=Math.min(b,s+3.4); stripe(r,s,e,-.09,.1,0xFFE27A); stripe(r,s,e,.09,.1,0xFFE27A); }
        stripe(r,a,b,-3.2,.12,0xF4F0FF); stripe(r,a,b,3.2,.12,0xF4F0FF);
      }
    }
  });
  // crosswalks, stop lines, STOP lettering, curb ramps
  for(const ix of IX){
    if(ix.control==='yield') continue;
    for(const r of [ix.ra,ix.rb]){
      const c=r.axis==='x'?ix.x:ix.z, other=r===ix.ra?ix.rb:ix.ra, oc=r.axis==='x'?ix.z:ix.x;
      for(const dir of [-1,1]){         // approach from the c-dir*... side
        const s0=c+dir*SW; if(s0<r.from-.1||s0>r.to+.1) continue;
        // zebra across r at distance 4.6 from the centre (matches the sidewalk band of the cross street)
        for(let k=0;k<7;k++){ const off=-2.7+k*.9; if(r.axis==='x') paint(2.0,.45,c+dir*4.6,r.at+off,0xF7F4FF); else paint(.45,2.0,r.at+off,c+dir*4.6,0xF7F4FF); }
        // stop line on the right-hand lane of traffic heading toward the intersection (heading = -dir)
        const hd=-dir, rightOff=(r.axis==='x'?1:-1)*hd*1.75;
        if(r.axis==='x') paint(.4,3.3,c+dir*6.0,r.at+rightOff,0xF7F4FF); else paint(3.3,.4,r.at+rightOff,c+dir*6.0,0xF7F4FF);
        if(ix.control==='stop'){
          const ry=r.axis==='x'?(hd>0?-HP:HP):(hd>0?Math.PI:0);
          const p=r.axis==='x'?[c+dir*8.6,r.at+rightOff]:[r.at+rightOff,c+dir*8.6];
          put(B(r.axis==='x'?1.2:2.2,.012,r.axis==='x'?2.2:1.2),0xF7F4FF,city,p[0],.07,p[1],{ns:true});
          const m=sign(['STOP'],2.0,1.0,null,'#6E74C2',city,p[0],.072,p[1]); m.rotation.set(-HP,0,ry);
        }
      }
    }
  }
}
// The right-hand side of a road for traffic heading `hd` (+1 = increasing axis coordinate).
function rightSide(r,hd){ return (r.axis==='x'?1:-1)*hd; }

// ---------- street furniture ----------
function stopSign(x,z,ry,names){
  const g=grp(city,x,0,z,ry);
  put(B(.07,2.9,.07),0xB9C0D2,g,0,1.45,0); for(let y=.4;y<2.8;y+=.12) put(B(.022,.022,.01),0x6E7389,g,0,y,.036);
  put(new THREE.CylinderGeometry(.47,.47,.03,8),0xFFFFFF,g,0,2.5,.06,{rx:HP,ry:Math.PI/8});
  const face=new THREE.Mesh(new THREE.CircleGeometry(.43,8),new THREE.MeshStandardMaterial({map:labelTex(['STOP'],256,256,'#E8343F','#FFFFFF',84,0),roughness:.5})); face.material.map.center.set(.5,.5); face.material.map.rotation=-Math.PI/8; face.rotation.z=Math.PI/8; face.position.set(0,2.5,.082); g.add(face);
  put(new THREE.CylinderGeometry(.46,.46,.02,8),0xB9C0D2,g,0,2.5,.04,{rx:HP,ry:Math.PI/8});
  if(names) for(const [k,txt2] of names.entries()){ const bl=grp(g,0,3.02+k*.16,0,k?HP:0); put(B(1.2,.2,.02),0x1F8A5A,bl,0,0,0); sign([txt2],1.1,.16,null,'#FFFFFF',bl,0,0,.012); sign([txt2],1.1,.16,null,'#FFFFFF',bl,0,0,-.012,Math.PI); }
  put(B(.12,.1,.12),0x7E8399,g,0,2.94,0);
  postBody(x,z,.08,2.9,'stop_sign');
}
// Traffic signal on a mast arm. Lamps keep their own materials (outside the bake) so the
// client can switch them from the server's light phases without recompiling anything.
const SIGNALS=[];
const lampMats={ red:[0x4A1520,0xFF3B4E], yellow:[0x4A3A10,0xFFC93C], green:[0x10402A,0x3CFF8A] };
function signalHead(parent,x,y,z,ry,ix,axis){
  const h=grp(parent,x,y,z,ry); put(B(.42,1.2,.32,.03),0xFFC93C,h,0,0,0); put(B(.5,1.32,.04),0x2E2350,h,0,0,-.17);
  const lamps={};
  [['red',.38],['yellow',0],['green',-.38]].forEach(([c,yy])=>{ put(B(.36,.08,.22),0x2E2350,h,0,yy+.17,.2); const m=new THREE.MeshBasicMaterial({color:lampMats[c][0],toneMapped:false});
    const d=new THREE.Mesh(new THREE.CircleGeometry(.13,18),m); d.position.set(0,yy,.165); h.add(d); lamps[c]=m; });
  SIGNALS.push({ix,axis,lamps});
}
function signalPole(x,z,ry,armLen,ix,axis,names){
  const g=grp(city,x,0,z,ry);
  put(CYL(.3,.34,.4,14),'tx:conc',g,0,.2,0); put(CYL(.11,.14,6.2,12),0xC8CDDD,g,0,3.3,0); put(CYL(.15,.15,.3,12),0xB9C0D2,g,0,.55,0);
  tube([[0,5.9,0],[armLen*.5,6.25,0],[armLen,6.35,0]],.08,0xC8CDDD,g,10); tube([[0,4.9,0],[armLen*.35,5.9,0]],.04,0xC8CDDD,g,6);
  signalHead(g,armLen*.55,5.55,.0,0,ix,axis); signalHead(g,armLen*.95,5.55,0,0,ix,axis);
  signalHead(g,-.05,3.0,.2,0,ix,axis);
  // pedestrian push button and a street name blade on the arm
  put(B(.14,.22,.1),0xFFC93C,g,.14,1.15,.06); put(CYL(.04,.04,.03,10),0x2E2350,g,.14,1.15,.12,{rx:HP});
  if(names){ const bl=grp(g,armLen*.25,6.0,0); put(B(1.6,.3,.03),0x1F8A5A,bl,0,0,0); sign([names],1.5,.24,null,'#FFFFFF',bl,0,0,.02); sign([names],1.5,.24,null,'#FFFFFF',bl,0,0,-.02,Math.PI); }
  postBody(x,z,.14,6.2,'signal');
}
function cobra(x,z,ry){ LAMPS.push({id:'lamp:'+LAMPS.length,p:[+x.toFixed(2),0,+z.toFixed(2)],ry:+ry.toFixed(4),style:'cobra',gy:.16}); const g=grp(city,x,0,z,ry); put(CYL(.07,.11,6.4,10),0xC8CDDD,g,0,3.2,0); put(CYL(.18,.2,.4,10),0xC8CDDD,g,0,.2,0); tube([[0,6.3,0],[0,6.7,-.4],[0,6.75,-1.4]],.05,0xC8CDDD,g,8); put(B(.38,.16,.75,.05),0xC8CDDD,g,0,6.68,-1.65); put(B(.28,.03,.5),0xFFF6D0,g,0,6.59,-1.65); postBody(x,z,.12,6.4); }
function hydrant(x,z){ const g=grp(city,x,0,z,rnd()*6); const prof=[[0,0],[.17,0],[.17,.06],[.13,.08],[.13,.5],[.15,.52],[.15,.56],[.11,.6],[.06,.68],[0,.7]].map(([a,b])=>new THREE.Vector2(a,b)); put(new THREE.LatheGeometry(prof,14),0xFFD84A,g,0,0,0); for(const r of [0,HP,Math.PI]){ const o=grp(g,0,.4,0,r); put(CYL(.06,.06,.12,10),0xFFD84A,o,.17,0,0,{rz:HP}); put(CYL(.07,.07,.03,6),0xE8343F,o,.24,0,0,{rz:HP}); } put(CYL(.035,.035,.05,5),0xE8343F,g,0,.72,0); postBody(x,z,.17,.7); }
function bench(x,z,ry,hex=null){ const g=grp(city,x,0,z,ry); for(let k=0;k<4;k++) put(B(2.2,.04,.12),hex??'tx:woodPale',g,0,.48,-.2+k*.13); for(let k=0;k<3;k++) put(B(2.2,.12,.03),hex??'tx:woodPale',g,0,.68+k*.16,.3,{rx:-.15}); for(const x2 of [-.9,.9]){ put(B(.06,.48,.06),DARKM,g,x2,.24,-.2); put(B(.06,.48,.06),DARKM,g,x2,.24,.2); put(B(.06,.06,.5),DARKM,g,x2,.46,0); put(B(.06,.6,.06),DARKM,g,x2,.75,.3,{rx:-.15}); } solid(g,0,.45,0,1.1,.45,.35); }
function trashCan(x,z,hex=0x26A0D9){ const g=grp(city,x,0,z,rnd()*6); put(CYL(.3,.27,.95,16),hex,g,0,.48,0); for(const y of [.25,.7]) put(new THREE.TorusGeometry(.3,.02,6,16),DARKM,g,0,y,0,{rx:HP}); put(CYL(.33,.33,.08,16),DARKM,g,0,.98,0); put(CYL(.12,.12,.05,12),0x1A1D30,g,0,1.03,0); postBody(x,z,.3,1); }
function binCurb(x,z,ry,hex=0x2FAE6A){ const g=grp(city,x,0,z,ry); put(B(.62,.95,.7,.03),hex,g,0,.52,0); put(B(.68,.07,.78),new THREE.Color(hex).offsetHSL(0,0,-.1).getHex(),g,0,1.02,-.02); put(CYL(.1,.1,.05,10),INK,g,-.26,.1,-.38,{rz:HP}); put(CYL(.1,.1,.05,10),INK,g,.26,.1,-.38,{rz:HP}); }
function newsBox(x,z,ry,hex=0x3FB8FF,label='NEWS'){ const np=grp(city,x,0,z,ry); put(B(.45,.8,.4,.02),hex,np,0,.75,0); put(B(.4,.3,.02),0xD8F2FF,np,0,.95,.21); put(CYL(.03,.03,.4,8),DARKM,np,-.15,.2,0); put(CYL(.03,.03,.4,8),DARKM,np,.15,.2,0); sign([label],.36,.12,'#FFFFFF','#2E2350',np,0,.68,.205); }
function mailbox(x,z,ry){ const g=grp(city,x,0,z,ry); put(B(.5,.75,.45,.03),0x2F6FD0,g,0,.85,0); put(new THREE.CylinderGeometry(.25,.25,.45,16,1,false,0,Math.PI),0x2F6FD0,g,0,1.22,0,{rz:HP,ry:HP}); for(const s of [-1,1]) put(B(.05,.5,.05),DARKM,g,s*.2,.25,0); sign(['MAIL'],.36,.12,null,'#FFFFFF',g,0,.95,.23); }
function meter(x,z,ry){ const g=grp(city,x,0,z,ry); put(CYL(.04,.04,1.1,8),0x8E95AE,g,0,.55,0); put(B(.18,.3,.14,.03),0x8E95AE,g,0,1.25,0); put(B(.12,.1,.02),0xC8E8FF,g,0,1.3,.075); put(new THREE.SphereGeometry(.09,10,8,0,Math.PI*2,0,HP),0x8E95AE,g,0,1.4,0); }
function planter(x,z,s=1){ const g=grp(city,x,0,z); put(B(1.2*s,.5,1.2*s,.04),'tx:conc',g,0,.25,0); put(B(1.05*s,.06,1.05*s),'tx:mulch',g,0,.5,0); const b=grp(city,x,0,z); for(let k=0;k<5;k++){ const a=rnd()*6.28; put(lumpy(.22+rnd()*.12,rnd()*50),k%2?'tx:leafA':'tx:leafB',b,Math.cos(a)*.25*s,.62+rnd()*.15,Math.sin(a)*.25*s); } for(let k=0;k<6;k++) put(new THREE.SphereGeometry(.06,6,5),pick([0xFF6E9E,0xFFC93C,0xFFFFFF,0xFF4D7E]),b,(rnd()-.5)*.7*s,.82,(rnd()-.5)*.7*s); burnReg('plant',b,x,z,s); }
function flowerBed(x,z,w,d,ry=0){ const g=grp(city,x,0,z,ry); put(B(w,.12,d),'tx:mulch',g,0,.06,0,{ns:true}); put(B(w+.1,.16,.08),'tx:curb',g,0,.08,d/2); put(B(w+.1,.16,.08),'tx:curb',g,0,.08,-d/2); const b=grp(city,x,0,z,ry); const n=Math.round(w*d*3); for(let k=0;k<n;k++){ const px=(rnd()-.5)*(w-.2), pz=(rnd()-.5)*(d-.2); put(B(.03,.25,.03),0x3FBE3A,b,px,.22,pz,{ns:true}); put(new THREE.SphereGeometry(.07,6,5),pick([0xFF6E9E,0xFFC93C,0xFFFFFF,0xFF4D7E,0x8F6BFF,0xFF9F1C]),b,px,.37,pz,{ns:true}); } burnReg('plant',b,x,z,1); }
function hedge(x,z,len,ry=0,h=1){ const g=grp(city,x,0,z,ry); put(B(len,h,.8,.18),'tx:leafA',g,0,h/2,0); for(let k=0;k<len/1.2;k++) put(lumpy(.42,rnd()*50),k%2?'tx:leafB':'tx:leafA',g,-len/2+.6+k*1.2,h-.05,(rnd()-.5)*.2); burnReg('plant',g,x,z,len); solid(g,0,h/2,0,len/2,h/2,.4); }
function lightPole(x,z,ry=0){ const g=grp(city,x,0,z,ry); put(CYL(.3,.35,.5,12),'tx:conc',g,0,.25,0); put(CYL(.07,.09,7,10),0xC8CDDD,g,0,3.75,0); put(B(.9,.18,.45,.04),0xC8CDDD,g,-.35,7.3,0); put(B(.7,.03,.35),0xFFF6D0,g,-.35,7.2,0); put(B(.9,.18,.45,.04),0xC8CDDD,g,.35,7.3,0,{ry:Math.PI}); put(B(.7,.03,.35),0xFFF6D0,g,.35,7.2,0); postBody(x,z,.3,.5); }
function bollard(x,z,hex=P.sunny){ put(CYL(.1,.1,.9,14),hex,city,x,.45,z); put(CYL(.11,.11,.06,14),DARKM,city,x,.75,z); }
function busStop(x,z,ry,name){ const g=grp(city,x,0,z,ry); put(B(3.4,.08,1.5),'tx:conc',g,0,.04,0,{ns:true}); for(const s of [-1,1]){ put(B(.08,2.4,.08),0xC8CDDD,g,s*1.6,1.2,-.6); put(B(.08,2.4,.08),0xC8CDDD,g,s*1.6,1.2,.6); }
  put(B(3.5,.1,1.6,.03),0x3FB8FF,g,0,2.45,0); const gl=new THREE.Mesh(new THREE.BoxGeometry(3.2,1.8,.03),glassMat); gl.position.set(0,1.25,-.62); g.add(gl); const gl2=new THREE.Mesh(new THREE.BoxGeometry(.03,1.8,1.1),glassMat); gl2.position.set(-1.6,1.25,-.05); g.add(gl2);
  for(let k=0;k<3;k++) put(B(2.4,.04,.12),'tx:woodPale',g,0,.48,-.35+k*.13); put(B(.06,.48,.4),DARKM,g,-1,.24,-.25); put(B(.06,.48,.4),DARKM,g,1,.24,-.25);
  const ad=sign([name||'BUS','ROUTE 9'],.9,1.3,'#FFC93C','#2E2350',g,1.6,1.4,.1,-HP);
  put(CYL(.04,.04,2.8,8),0xB9C0D2,g,1.9,1.4,.7); const sb=sign(['BUS STOP'],.6,.45,'#2F6FD0','#FFFFFF',g,1.9,2.6,.74); solid(g,0,1.2,-.6,1.7,1.2,.1); }
function graffiti(x,y,z,ry,t,c,w=1.6,h=.8){ const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:labelTex(Array.isArray(t)?t:[t],512,256,null,c,120),transparent:true,depthWrite:false})); m.position.set(x,y,z); m.rotation.y=ry; fxl(m); scene.add(m); }
function puddle(x,z,r){ const m=new THREE.Mesh(new THREE.CircleGeometry(r,20),new THREE.MeshPhysicalMaterial({color:0x8FB8E8,roughness:.05,clearcoat:1,transparent:true,opacity:.55,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3})); m.rotation.x=-HP; m.scale.y=.6+rnd()*.5; m.position.set(x,.075,z); fxl(m); scene.add(m); }
function cardboard(x,z,ry){ put(B(1.0,.03,.8),0xB08A5A,city,x,.03,z,{ry,ns:true}); }
function dumpster(x,z,ry,tex='tx:ribMint',lid=0x17A87D){
  const g=grp(city,x,0,z,ry); put(B(3,1.35,1.6),tex,g,0,.85,0); put(B(3.05,.12,1.65),lid,g,0,1.55,0);
  for(const s of [-1,1]) put(B(1.48,.06,1.72),0x1E2A3A,g,s*.76,1.64,-.02,{rx:-.08});
  for(const s of [-1,1]) put(B(.28,.18,1.7),lid,g,s*1.6,.75,0); for(const s of [-1,1]) put(B(.5,.22,.1),lid,g,s*.7,.9,.82);
  for(const s of [-1,1]) for(const t of [-1,1]){ put(B(.1,.12,.1),DARKM,g,s*1.25,.16,t*.65); put(CYL(.09,.09,.08,12),INK,g,s*1.25,.09,t*.65,{rx:HP}); }
  sign(['NO DUMPING'],1.0,.22,'#FFFFFF','#E8343F',g,0,1.1,.81);
  solid(g,0,.85,0,1.5,.85,.8,'dumpster');
}
function chainFence(points,h=2.1){   // posts and rails (baked) plus see-through mesh (alpha-tested, on the fx layer)
  for(let i=0;i<points.length-1;i++){ const [x0,z0]=points[i],[x1,z1]=points[i+1]; const len=Math.hypot(x1-x0,z1-z0), ry=Math.atan2(-(z1-z0),x1-x0); const g=grp(city,(x0+x1)/2,0,(z0+z1)/2,ry);
    put(CYL(.04,.04,len,6),0xB9C0D2,g,0,h,0,{rz:HP}); put(CYL(.03,.03,len,6),0xB9C0D2,g,0,.12,0,{rz:HP});
    for(let k=0;k<=Math.ceil(len/3);k++){ const px=-len/2+k*len/Math.ceil(len/3); put(CYL(.05,.05,h+.05,8),0xB9C0D2,g,px,(h+.05)/2,0); }
    const pg=new THREE.PlaneGeometry(len,h-.1); const uv=pg.attributes.uv; for(let k=0;k<uv.count;k++) uv.setXY(k,uv.getX(k)*len*1.6,uv.getY(k)*(h-.1)*1.6); const m=new THREE.Mesh(pg,chainMat); m.position.set(0,h/2,0); g.add(m); fxl(m);
    const p=L(g,0,h/2,0); const b=staticBox(p.x,p.y,p.z,len/2,h/2,.05,ry); }
}
let chainMat=null;
function makeChainMat(){ const cv=document.createElement('canvas'); cv.width=cv.height=64; const g=cv.getContext('2d'); g.strokeStyle='#C8CDDD'; g.lineWidth=3; for(let i=-64;i<128;i+=16){ g.beginPath(); g.moveTo(i,0); g.lineTo(i+64,64); g.stroke(); g.beginPath(); g.moveTo(i+64,0); g.lineTo(i,64); g.stroke(); }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(1,1); chainMat=new THREE.MeshStandardMaterial({map:t,alphaTest:.5,transparent:false,side:THREE.DoubleSide,roughness:.5,metalness:.3});
 }
function woodFence(x0,z0,x1,z1,hex='tx:woodPale',h=1.6){ const len=Math.hypot(x1-x0,z1-z0), ry=Math.atan2(-(z1-z0),x1-x0); const g=grp(city,(x0+x1)/2,0,(z0+z1)/2,ry);
  for(let px=-len/2+.08;px<len/2;px+=.17) put(B(.15,h-(Math.floor((px+len)*3)%2)*.06,.03),hex,g,px,(h)/2,0); for(const y of [.35,h-.3]) put(B(len,.09,.05),hex,g,0,y,-.04); for(let px=-len/2;px<=len/2+.01;px+=2.4) put(B(.1,h+.08,.1),'tx:wood',g,px,(h+.08)/2,-.06);
  const p=L(g,0,h/2,0); staticBox(p.x,p.y,p.z,len/2,h/2,.06,ry); }
function picketRun(x0,z0,x1,z1,hex=TRIM){ const len=Math.hypot(x1-x0,z1-z0), ry=Math.atan2(-(z1-z0),x1-x0); const g=grp(city,(x0+x1)/2,0,(z0+z1)/2,ry); for(let px=-len/2;px<=len/2;px+=.3){ put(B(.09,.85,.035),hex,g,px,.43,0); put(new THREE.ConeGeometry(.064,.12,4),hex,g,px,.9,0,{ry:Math.PI/4}); } for(const fy of [.25,.65]) put(B(len,.07,.05),hex,g,0,fy,-.04); }
function parkingStalls(x0,z0,n,dir,spacing=2.6,len=5,axis='x'){ // painted stall lines starting at (x0,z0)
  for(let i=0;i<=n;i++){ if(axis==='x') paint(.12,len,x0+i*spacing,z0+dir*len/2,0xF7F4FF); else paint(len,.12,x0+dir*len/2,z0+i*spacing,0xF7F4FF); } }
function wheelStop(x,z,ry){ put(B(1.6,.14,.22,.03),'tx:curb',city,x,.07,z,{ry}); }
function lot(x0,z0,x1,z1,kind='lot'){ const w=Math.abs(x1-x0), d=Math.abs(z1-z0); put(B(w,.07,d),kind==='dirt'?'tx:dirt':'tx:asphalt',city,(x0+x1)/2,kind==='dirt'?.012:.035,(z0+z1)/2,{ns:true}); rect(META.lots,x0,z0,x1,z1,{kind}); }
function curbRun(x0,z0,x1,z1){ const len=Math.hypot(x1-x0,z1-z0), ry=Math.atan2(-(z1-z0),x1-x0); put(B(len,.18,.25),'tx:curb',city,(x0+x1)/2,.09,(z0+z1)/2,{ry}); }
function slab(x0,z0,x1,z1,tex='tx:walk',y=.085){ put(B(Math.abs(x1-x0),y*2,Math.abs(z1-z0)),tex,city,(x0+x1)/2,y,(z0+z1)/2,{ns:true}); }
function lawn(x0,z0,x1,z1){ /* ground is already grass */ }
function hvac(parent,x,y,z,s=1){ const u=grp(parent,x,y,z); put(B(1.5*s,.85*s,1.15*s,.02),0xD8DCE8,u,0,.43*s,0); put(CYL(.44*s,.44*s,.05,24),0x7A819A,u,0,.88*s,0); for(let k=-3;k<=3;k++) put(B(.86*s,.02,.03),0xB9BFD0,u,0,.92*s,k*.11*s); put(B(1.52*s,.6*s,.02),0xB9BFD0,u,0,.4*s,.585*s); for(let k=0;k<8;k++) put(B(1.4*s,.02,.03),0x8E95AE,u,0,(.15+k*.07)*s,.6*s); }

// ================= building kits =================
// Storefront: 1 or 2 floors, real parapet, cornice, bays of breakable glass, door, sign box,
// optional striped awning, rooftop units, downspouts, meter, side posters, back door.
function shop(o){
  const {x,z,w,d,face='+z',wall='tx:brickRed',trim=TRIM}=o; const floors=o.floors||1, h=o.h||(floors>1?7.6:4.6), ph=o.parapet??.75, fz=d/2;
  const g=G(x,z,face); const frame=o.frame??DARKM;
  put(B(w,h,d),wall,g,0,h/2,0);
  put(B(w+.08,.95,d+.08),o.base||'tx:conc',g,0,.475,0); put(B(w+.16,.08,d+.16),trim,g,0,.97,0);
  // parapet walls, caps and cornice
  put(B(w+.24,.16,d+.24),trim,g,0,h-.02,0);
  for(const s of [-1,1]){ put(B(w+.06,ph,.28),wall,g,0,h+ph/2,s*(d/2-.11)); put(B(.28,ph,d+.06),wall,g,s*(w/2-.11),h+ph/2,0); put(B(w+.34,.12,.42),trim,g,0,h+ph+.02,s*(d/2-.12)); put(B(.42,.12,d+.34),trim,g,s*(w/2-.12),h+ph+.02,0); }
  for(let i=-w/2+.25;i<w/2;i+=.42) put(B(.16,.14,.1),trim,g,i,h-.19,fz+.06);
  if(o.cornice!==false){ put(B(w+.3,.1,.3),trim,g,0,h-.32,fz+.1); }
  put(B(w-.5,.04,d-.5),'tx:gravel',g,0,h+.02,0,{ns:true});
  hvac(g,-w*.22,h,-d*.15,.9); if(w>9) hvac(g,w*.25,h,d*.1,.9);
  for(const [vx,vz] of [[w*.38,-d*.3],[-w*.4,d*.25]]){ put(CYL(.07,.07,.7,10),0xB9BFD0,g,vx,h+.35,vz); put(CYL(.12,.12,.06,10),0x8E95AE,g,vx,h+.72,vz); }
  put(B(.9,.25,.9),0xC8CDDD,g,w*.1,h+.12,-d*.3);
  // ground-floor bays: pilasters, glass, door
  const bays=o.bays||(()=>{ const doorAt=o.doorAt??.62; const ww=w-.8; const dw=1.5; const left=(doorAt*ww)-dw/2, right=ww-left-dw; const out=[]; if(left>.6) out.push({t:'win',w:left}); out.push({t:'door',w:dw}); if(right>.6) out.push({t:'win',w:right}); return out; })();
  let cx=-w/2+.4; const sh=o.storeH||2.2, sy=1.05+sh/2;
  for(const b of bays){ const mid=cx+b.w/2;
    if(b.t==='win') windowPane(g,mid,sy,fz,b.w-.2,sh,0,o.value||300,{frame,ft:.08,mullV:Math.max(1,Math.round(b.w/1.6)),mullH:0,interior:o.interior||INT.mart,head:false,sill:true,bars:o.bars});
    else if(b.t==='door'){ const dg=grp(g,mid,0,fz); put(B(b.w,2.6,.12),frame,dg,0,1.3,.02); const dgl=new THREE.Mesh(new THREE.BoxGeometry(b.w-.3,2.0,.03),glassMat); dgl.position.set(0,1.25,.1); dg.add(dgl); const di=new THREE.Mesh(new THREE.PlaneGeometry(b.w-.3,2.0),o.interior||INT.mart); di.position.set(0,1.25,.085); dg.add(di);
      put(B(b.w-.3,.08,.05),0xC8CDDD,dg,0,1.1,.14); put(B(b.w-.3,.25,.04),0xC8CDDD,dg,0,.2,.12); put(B(b.w,.4,.12),frame,dg,0,2.82,.02); put(B(b.w+.4,.1,.7),'tx:conc',dg,0,.05,.35);
      if(o.hours) txt(o.hours,b.w-.2,.3,'#2E2350','#FFE27A',dg,0,2.82,.09); }
    if(b.t!=='door' || true) put(B(.2,sh+.5,.16),trim===TRIM?frame:trim,g,cx,1.05+(sh+.5)/2-.05,fz+.06);
    cx+=b.w; }
  put(B(.2,sh+.5,.16),trim===TRIM?frame:trim,g,w/2-.4,1.05+(sh+.5)/2-.05,fz+.06);
  // sign band
  const sbY=o.signY??(floors>1?3.85:h-.95);
  if(o.sign){ const sw=o.signW||Math.min(w-.8,Math.max(3.2,o.sign.length*.55+1)); const sg=grp(g,o.signX||0,sbY,fz+.1);
    put(B(sw+.2,.95,.3,.04),o.signFrame??DARKM,sg,0,0,.12); put(B(sw,.8,.05),o.signHex??0xFFE27A,sg,0,0,.29);
    txt([o.sign],sw-.2,.7,o.signBg||'#FFD84A',o.signFg||'#2E2350',sg,0,0,.32); for(const s of [-1,1]) put(B(.08,.5,.3),METAL,sg,s*(sw/2-.3),.6,-.02); }
  // awning
  if(o.awning!==undefined && o.awning!==null){ const aw=grp(g,0,floors>1?3.25:h-2.05,fz); const AW=w*.9, n=Math.max(8,Math.round(AW/.6)); const c2=o.awning2??0xFFFFFF;
    for(let i=0;i<n;i++){ const c=i%2?c2:o.awning; put(B(AW/n,.03,1.25),c,aw,-AW/2+(i+.5)*AW/n,.18,.6,{rx:.42}); put(B(AW/n,.28,.03),c,aw,-AW/2+(i+.5)*AW/n,-.15,1.15); }
    for(let i=0;i<=4;i++) tube([[-AW/2+i*AW/4,.45,0],[-AW/2+i*AW/4,-.02,1.15]],.025,METAL,aw,2); }
  // upper floor(s)
  if(floors>1){ put(B(w+.12,.14,d+.12),trim,g,0,4.45,0); const n=Math.max(2,Math.floor(w/2.4)); for(let i=0;i<n;i++){ const wx=-w/2+(i+.5)*w/n; windowPane(g,wx,5.75,fz,1.05,1.45,0,150,{frame:trim===TRIM?0xF4F0F8:trim,mullV:2,mullH:1,head:true,interior:o.upInt||INT.office}); }
    if(o.upSign) txt(o.upSign,w*.6,.5,null,o.upSignFg||'#2E2350',g,0,h-.6,fz+.02); }
  // side and back detail
  downspout(g,w/2+.07,-d/2+.6,h+.3,HP); downspout(g,-w/2-.07,d/2-.8,h+.3,-HP);
  const mb=grp(g,w/2+.06,0,-d*.2,HP); put(B(.5,.7,.18),0xC8CDDD,mb,0,1.5,0); put(CYL(.12,.12,.08,16),0xE8ECF6,mb,0,1.55,.12,{rx:HP}); put(CYL(.035,.035,1.2,8),METAL,mb,0,.6,0);
  const bd=grp(g,-w*.25,0,-d/2,Math.PI); put(B(1.2,2.3,.1),0x7F8BA6,bd,0,1.15,.03); put(B(.3,.2,.2),0xE8ECF6,bd,0,2.6,.1); put(B(.05,.05,.15),METAL,bd,.42,1.05,.1);
  if(o.posters) o.posters.forEach(([pz,t,bg],i)=>sign(t,1.0,1.3,bg,'#2E2350',g,-w/2-.02,2.2,pz,-HP));
  if(o.extra) o.extra(g,{w,d,h,fz});
  solid(g,0,(h+ph)/2,0,w/2,(h+ph)/2,d/2);
  bmeta(x,z,(face==='+x'||face==='-x')?d/2:w/2,(face==='+x'||face==='-x')?w/2:d/2,0,wall,'tx:gravel',o.name||o.sign);
  return g;
}

// ================= districts =================
function streetFurniture(){
  // stop signs on the right of each approach at all-way stops (the look test already has Main & Elm NE)
  const names={main:'MAIN ST',elm:'ELM AVE',oak:'OAK AVE',creek:'CREEK RD',pine:'PINE ST'};
  for(const ix of IX){ if(ix.control==='yield') continue;
    for(const r of [ix.ra,ix.rb]){ const c=r.axis==='x'?ix.x:ix.z; const other=r===ix.ra?ix.rb:ix.ra;
      for(const dir of [-1,1]){ const s0=c+dir*SW; if(s0<r.from-.1||s0>r.to+.1) continue;
        const hd=-dir, side=rightSide(r,hd); const off=r.at+side*5.0, along=c+dir*6.6;
        const [px,pz]=r.axis==='x'?[along,off]:[off,along];
        const ry=r.axis==='x'?(hd>0?-HP:HP):(hd>0?Math.PI:0);
        if(ix.control==='stop'){ if(ix.id==='main_elm' && Math.hypot(px+8.2,pz+4.3)<12) continue; stopSign(px,pz,ry,[names[ix.ra.id],names[ix.rb.id]]); }
        else if(ix.control==='light'){ signalPole(px,pz,ry,-3.6, ix.id, r.axis, names[other.id]); }
      } } }
  // street lamps along every road, alternating sides, clear of intersections and the skyway deck
  for(const r of ROADS){ const step=r.res?26:22; const [f,t]=roadEnds(r); let k=0;
    for(let s=Math.max(f,-96)+6; s<Math.min(t,r.axis==='x'?150:170)-4; s+=step, k++){
      if(IX.some(ix=>(ix.ra===r||ix.rb===r) && Math.abs((r.axis==='x'?ix.x:ix.z)-s)<9)) continue;
      if(r.axis==='x' && s>16 && s<28) continue;
      if(r.id==='main' && s>-40 && s<40) continue;   // the look test already lit this stretch
      const side=k%2?1:-1; const o=r.at+side*5.25; const [x,z]=r.axis==='x'?[s,o]:[o,s];
      const ry=r.axis==='x'?(side>0?0:Math.PI):side*HP; cobra(x,z,ry);
    } }
  // hydrants, news boxes, mailboxes, bus stops, trash cans
  for(const [x,z] of [[-30,-5.0],[-58,5.0],[48,-5.0],[90,5.0],[-12+5.0,40],[-12-5.0,-40],[72-5,-30],[72+5,30],[60,72-5],[100,-76+5],[-40,72-5],[-40,-76+5],[30,72+5],[110,-76-5]]) hydrant(x,z);
  for(const [x,z,ry] of [[-22,5.2,Math.PI],[-60,-5.2,0],[-7.2,-24,HP],[68,5.2,Math.PI]]){ newsBox(x,z,ry); newsBox(x+.6,z,ry,0xFF6E9E,'FREE'); }
  mailbox(-40,-5.1,0); mailbox(64,5.1,Math.PI);
  busStop(-38.5,-5.3,0,'DOWNTOWN'); busStop(46,5.4,Math.PI,'PLAZA'); busStop(-17.6,-48,HP,'SCHOOL');
  for(const [x,z] of [[-26,-5.1],[-52,5.1],[-70,-5.1],[-7.2,30],[-16.8,-30],[60,-5.1],[80,5.1],[-7.2,-60]]) trashCan(x,z);
}

// ---------- downtown (north of Elm) ----------
function downtown(){
  // west side of Main (z>0), facing Main (-z)
  const W='-z', E='+z';
  shop({x:-25,z:13.5,w:11,d:12,face:W,wall:'tx:brickRed',sign:'DOT\'S DINER',signHex:0xFF6E9E,signBg:'#FF6E9E',signFg:'#FFFFFF',interior:INT.diner,awning:0xE8343F,doorAt:.25,hours:['OPEN 24/7'],name:'Dot\'s Diner',
    extra:(g,{w,h,fz})=>{ put(B(w+.1,.22,.1),METAL,g,0,3.32,fz+.07); const ne=new THREE.Mesh(new THREE.PlaneGeometry(1.4,.6),new THREE.MeshBasicMaterial({map:labelTex(['EAT'],256,110,null,'#FF4D7E',90),transparent:true})); ne.position.set(w*.3,2.5,fz+.12); g.add(ne);
      const rs=grp(g,0,h+.8,0); put(B(.12,2.2,.12),METAL,rs,-1.6,1.1,0); put(B(.12,2.2,.12),METAL,rs,1.6,1.1,0); put(B(4,1.2,.25,.04),0xFFFFFF,rs,0,2.2,0); txt(['DOT\'S'],3.7,1.0,'#FFFFFF','#E8343F',rs,0,2.2,.13); txt(['DOT\'S'],3.7,1.0,'#FFFFFF','#E8343F',rs,0,2.2,-.13,Math.PI); } });
  shop({x:-36.5,z:12.5,w:8,d:10,face:W,wall:'tx:stuccoSky',sign:'BARBER',interior:INT.barber,awning:0x3FB8FF,signBg:'#FFFFFF',signHex:0xFFFFFF,name:'Barber',
    extra:(g,{w,fz})=>{ const bp=grp(g,-w/2+.5,0,fz+.25); put(CYL(.12,.12,.08,14),METAL,bp,0,2.85,0); put(CYL(.1,.1,1.0,16),0xFFFFFF,bp,0,2.3,0); for(let k=0;k<6;k++) put(new THREE.TorusGeometry(.105,.022,6,16),k%2?0xE8343F:0x3FB8FF,bp,0,1.9+k*.16,0,{rx:HP-.35}); put(CYL(.12,.12,.08,14),METAL,bp,0,1.75,0); put(B(.05,.05,.25),METAL,bp,0,2.3,-.15); } });
  shop({x:-45.5,z:13,w:9,d:11,face:W,wall:'tx:brickTan',sign:'PAWN',signBg:'#2E2350',signFg:'#FFC93C',signHex:0x2E2350,interior:INT.pawn,floors:2,upInt:INT.office,upSign:['LOANS · GOLD · GUITARS'],name:'Pawn',
    extra:(g,{w,fz})=>{ for(let i=0;i<14;i++) put(B(.03,2.1,.03),0x5A5F78,g,-w/2+.7+i*.32,2.15,fz+.16); put(B(w-1,.04,.04),0x5A5F78,g,0,3.2,fz+.16); put(B(w-1,.04,.04),0x5A5F78,g,0,1.1,fz+.16);
      for(const [px,c] of [[-1.2,0xFFC93C],[0,0xFFC93C],[1.2,0xFFC93C]]) put(new THREE.SphereGeometry(.22,14,10),c,g,px,4.2,fz+.6); put(B(3.2,.05,.05),METAL,g,0,4.2,fz+.45); } });
  // Town Hall on a plaza, set back from Main
  townHall(-68,34);
  // Penny Bank, hardware and thrift along Elm (facing south, +x)
  shop({x:-25,z:32,w:13,d:11,face:'+x',wall:'tx:brickCream',sign:'PENNY BANK',signBg:'#26D3A0',signFg:'#FFFFFF',signHex:0x26D3A0,interior:INT.office,floors:2,h:7.8,name:'Penny Bank',storeH:2.6,
    extra:(g,{w,h,fz})=>{ for(let i=0;i<4;i++){ const cx=-w/2+1.5+i*((w-3)/3); put(CYL(.28,.32,6.2,16),0xFFFFFF,g,cx,3.4,fz+1.0); put(B(.8,.25,.8),0xF4F0F8,g,cx,.3,fz+1.0); put(B(.8,.25,.8),0xF4F0F8,g,cx,6.6,fz+1.0); }
      put(B(w+.2,.6,1.9),'tx:brickCream',g,0,7.0,fz+.95); shapeExtrude([[-w/2-.1,0],[w/2+.1,0],[0,1.4]],1.9,0xFFFFFF,g).position.set(0,7.3,fz+.95); txt(['¢'],1.0,1.0,null,'#FFC93C',g,0,7.85,fz+1.92);
      for(let k=0;k<3;k++) put(B(w-1,.16,.5),'tx:conc',g,0,.08+k*.16,fz+1.7-k*.45);
      const atm=grp(g,w/2-1.2,0,fz+.02); put(B(1.0,1.9,.3,.03),0xC8CDDD,atm,0,1.2,.1); put(B(.6,.4,.04),0x2E2350,atm,0,1.55,.26); put(B(.5,.1,.06),0xFFC93C,atm,0,1.2,.27); txt(['ATM'],.7,.25,'#26D3A0','#FFFFFF',atm,0,2.0,.27); } });
  shop({x:-25,z:46,w:9,d:11,face:'+x',wall:'tx:stuccoLemon',sign:'HARDWARE',signBg:'#E8343F',signFg:'#FFFFFF',signHex:0xE8343F,interior:INT.mart,awning:0xE8343F,name:'Hardware',
    extra:(g,{w,fz})=>{ for(let i=0;i<3;i++){ const r=grp(g,-w/2+1+i*.9,0,fz+.9); put(B(.6,.6,.6,.03),pick([0xFF9F1C,0x3FB8FF,0x26D3A0]),r,0,.3,0); } const ld=grp(g,w/2-.8,0,fz+.6,.2); for(const s of [-1,1]) put(B(.06,2.4,.06),0xC8CDDD,ld,s*.22,1.2,0,{rx:.12}); for(let k=0;k<7;k++) put(B(.44,.04,.04),0xC8CDDD,ld,0,.3+k*.3,.02-k*.035); } });
  shop({x:-25,z:58,w:10,d:11,face:'+x',wall:'tx:sidSage',sign:'THRIFT',signBg:'#8F6BFF',signFg:'#FFFFFF',signHex:0x8F6BFF,interior:INT.toys,awning:0x8F6BFF,name:'Thrift',
    extra:(g,{w,fz})=>{ const rk=grp(g,-w/2+1.2,0,fz+1.0); put(B(1.6,.04,.04),METAL,rk,0,1.5,0); for(const s of [-1,1]) put(B(.04,1.5,.04),METAL,rk,s*.78,.75,0); for(let k=0;k<6;k++) put(B(.24,.7,.05),pick([0xFF6E9E,0xFFC93C,0x3FB8FF,0x26D3A0]),rk,-.6+k*.24,1.12,0); } });

  // east side of Main (z<0), facing Main (+z)
  shop({x:-24.5,z:-13,w:10,d:12,face:E,wall:'tx:brickBlue',sign:'BOOKS',signBg:'#FFFFFF',signFg:'#2E2350',signHex:0xFFFFFF,interior:INT.books,awning:0x26D3A0,floors:2,upSign:['USED · RARE · COMICS'],name:'Books'});
  shop({x:-36,z:-12.5,w:12,d:11,face:E,wall:'tx:stuccoMint',sign:'SUDSY LAUNDROMAT',signBg:'#3FB8FF',signFg:'#FFFFFF',signHex:0x3FB8FF,interior:INT.laundry,doorAt:.85,name:'Sudsy Laundromat',hours:['OPEN 6-11'],
    extra:(g,{w,fz})=>{ for(let k=0;k<5;k++){ const b2=new THREE.Mesh(new THREE.SphereGeometry(.18+k*.04,16,12),glassMat); b2.position.set(-w/2+1+k*.9,3.9+((k*7)%3)*.2,fz+.4); fxl(b2); g.add(b2); } } });
  cinema(-53,-15);
  shop({x:-70,z:-12.5,w:8,d:11,face:E,wall:'tx:stuccoPeach',sign:'FLOWERS',signBg:'#FF6E9E',signFg:'#FFFFFF',signHex:0xFF6E9E,interior:INT.flowers,awning:0xFF6E9E,name:'Flowers',
    extra:(g,{w,fz})=>{ for(let i=0;i<4;i++){ const b=grp(g,-w/2+1+i*1.1,0,fz+.9); put(B(.9,.5,.5),'tx:woodPale',b,0,.25,0); for(let k=0;k<5;k++) put(new THREE.SphereGeometry(.12,8,6),pick([0xFF6E9E,0xFFC93C,0xFFFFFF,0x8F6BFF]),b,-.3+k*.15,.6,(rnd()-.5)*.2); } } });
  shop({x:-79,z:-12.5,w:8,d:11,face:E,wall:'tx:brickPink',sign:'TOYS',signBg:'#FFC93C',signFg:'#2E2350',signHex:0xFFC93C,interior:INT.toys,awning:0xFFC93C,name:'Toys'});
  // north side of Elm, east of Main (facing south)
  shop({x:-25,z:-31,w:11,d:11,face:'+x',wall:'tx:stuccoLilac',sign:'VIDEO PALACE',signBg:'#2E2350',signFg:'#FF6E9E',signHex:0x2E2350,interior:INT.video,awning:0x8F6BFF,name:'Video Palace',hours:['NEW RELEASES']});
  shop({x:-25,z:-45,w:11,d:11,face:'+x',wall:'tx:brickRed',sign:'MAIN ST SHOPS',signBg:'#FFE27A',signFg:'#2E2350',interior:INT.toys,bays:[{t:'win',w:2.6},{t:'door',w:1.4},{t:'win',w:2.6},{t:'door',w:1.4},{t:'win',w:2.2}],floors:2,name:'Main St Shops'});
  shop({x:-25,z:-59,w:11,d:11,face:'+x',wall:'tx:brickYel',sign:'PIZZA PIE',signBg:'#E8343F',signFg:'#FFFFFF',signHex:0xE8343F,interior:INT.diner,awning:0x26D3A0,awning2:0xE8343F,name:'Pizza Pie',hours:['HOT SLICES']});
  // back alleys behind both blocks: dumpsters, trash piles, back lots, graffiti
  lot(-86,46,-34,64,'lot');  // municipal lot behind Town Hall
  parkingStalls(-84,46.2,19,1,2.6,5.2,'x'); parkingStalls(-84,63.8,19,-1,2.6,5.2,'x');
  for(const [x,z,ry] of [[-80.1,48.8,HP],[-72.3,48.8,HP],[-61.9,48.8,HP],[-49.1,61.2,-HP],[-56.9,61.2,-HP],[-75.1,61.2,-HP],[-38.7,48.8,HP]]) parked(x,z,ry);
  dumpster(-36,24.5,HP); dumpster(-46,24.5,HP,'tx:ribBlue',0x2F6FD0);
  lot(-86,-27,-34,-52,'lot'); parkingStalls(-84,-27.2,19,-1,2.6,5.2,'x'); parkingStalls(-84,-51.8,19,1,2.6,5.2,'x');
  for(const [x,z,ry] of [[-81.4,-29.8,HP],[-68.4,-29.8,HP],[-63.2,-29.8,HP],[-50.2,-29.8,HP],[-76.2,-49.2,-HP],[-42.6,-49.2,-HP]]) parked(x,z,ry);
  dumpster(-40,-21,HP); dumpster(-66,-22,HP,'tx:ribRed',0xC4473F);
  graffiti(-24.5,2.0,-19.06,Math.PI,['NO TURF','4 U'],'#FF3D8B'); graffiti(-41.9,1.8,18.55,0,['☺ PUDDLE','CREW'],'#26D3A0');
  // sidewalk dressing along Main
  for(const x of [-28,-34,-40,-48,-54,-62]){ meter(x,-5.25,0); meter(x+1,5.25,Math.PI); }
  for(const x of [-30,-44,-58,-76]){ T(x,-4.9,.75); } for(const x of [-34,-52,-80]) T(x,4.9,.75);
  for(const x of [-33,-50]) bench(x,6.6,Math.PI); for(const x of [-60,-76]) bench(x,-6.6,0);
  planter(-20,6.4,1); planter(-20,-6.4,1); planter(-64,-6.6,.9);
  for(const z of [-30,-44,-58]){ bollard(-18.6,z-1); }
}
function townHall(x,z){
  const g=G(x,z,'-z'); const w=20,d=14,h=8.5;
  // plaza in front, toward Main
  slab(x-14,6,x+14,z-d/2-.2,'tx:walk',.09);
  put(B(w,h,d),'tx:stuccoCream',g,0,h/2,0); put(B(w+.12,1.0,d+.12),'tx:brickCream',g,0,.5,0); put(B(w+.3,.2,d+.3),TRIM,g,0,h,0); put(B(w+.5,.25,d+.5),0xF4F0F8,g,0,h+.4,0);
  shapeExtrude([[-w/2-.3,0],[w/2+.3,0],[0,2.6]],d+.4,'tx:tileRoof',g).position.y=h+.5;
  // portico with columns, pediment, steps
  const pz=d/2; for(let i=0;i<6;i++){ const cx=-7.5+i*3; put(CYL(.42,.48,6.6,18),0xFFFFFF,g,cx,1.5+3.3,pz+2.6); put(B(1.1,.3,1.1),0xF4F0F8,g,cx,1.65,pz+2.6); put(B(1.1,.3,1.1),0xF4F0F8,g,cx,8.0,pz+2.6); }
  put(B(18,.5,3.6),0xF4F0F8,g,0,8.3,pz+1.9); shapeExtrude([[-9.2,0],[9.2,0],[0,2.4]],.6,0xFFFFFF,g).position.set(0,8.55,pz+3.4);
  const crest=new THREE.Mesh(new THREE.CircleGeometry(.75,30),new THREE.MeshBasicMaterial({map:labelTex(['☀'],256,256,'#FFC93C','#FF6E9E',150,128)})); crest.position.set(0,9.35,pz+3.72); g.add(crest);
  for(let k=0;k<4;k++) put(B(19-k*.4,.3,1.0),'tx:conc',g,0,.15+k*.3,pz+5.6-k*.85);
  put(B(18,1.5,4),'tx:conc',g,0,.75,pz+2.6);
  txt(['PUDDLEWICK TOWN HALL'],9,.7,'#2E2350','#FFE27A',g,0,7.35,pz+.02);
  for(const s of [-1,1]) for(let i=0;i<2;i++){ windowPane(g,s*(4.5+i*3.2),2.6,pz,1.4,2.2,0,250,{frame:0xF4F0F8,mullV:2,mullH:2,head:true}); windowPane(g,s*(4.5+i*3.2),6.0,pz,1.4,1.8,0,250,{frame:0xF4F0F8,mullV:2,mullH:1,head:true}); }
  const dg=grp(g,0,1.5,pz); put(B(2.6,3.4,.15),0x8A6648,dg,0,1.7,.05); put(B(2.9,.3,.2),0xF4F0F8,dg,0,3.5,.05); put(new THREE.SphereGeometry(.06,10,8),0xFFD84A,dg,.3,1.6,.15); put(new THREE.SphereGeometry(.06,10,8),0xFFD84A,dg,-.3,1.6,.15);
  // clock cupola
  const cu=grp(g,0,h+2.2,-1); put(B(3.4,3.4,3.4),'tx:stuccoCream',cu,0,1.7,0); put(B(3.7,.2,3.7),TRIM,cu,0,3.45,0);
  for(const [ry,] of [[0],[HP],[Math.PI],[-HP]]){ const f=grp(cu,0,1.9,0,ry); const cf=new THREE.Mesh(new THREE.CircleGeometry(1.1,40),new THREE.MeshStandardMaterial({color:0xFFFDF4,roughness:.6})); cf.position.z=1.72; f.add(cf); put(new THREE.TorusGeometry(1.12,.07,8,40),DARKM,f,0,0,1.73); for(let k=0;k<12;k++){ const a=k/12*Math.PI*2; put(B(.05,.18,.02),INK,f,Math.sin(a)*.9,Math.cos(a)*.9,1.74,{rz:-a}); } put(B(.06,.6,.02),INK,f,.1,.22,1.76,{rz:-.45}); put(B(.06,.8,.02),INK,f,-.1,.32,1.77,{rz:.3}); }
  const dome=new THREE.SphereGeometry(1.9,24,12,0,Math.PI*2,0,HP); put(dome,0x26D3A0,cu,0,3.55,0); put(CYL(.05,.05,1.4,8),0xFFD84A,cu,0,5.9,0); put(new THREE.SphereGeometry(.18,12,10),0xFFD84A,cu,0,6.65,0);
  for(const s of [-1,1]){ downspout(g,s*(w/2+.07),pz-1,h,s*HP); }
  solid(g,0,h/2,0,w/2,h/2,d/2); solid(g,0,.75,pz+2.6,9,.75,2);
  bmeta(x,z,d/2+2,w/2,0,'tx:stuccoCream','tx:tileRoof','Town Hall');
  // plaza: fountain, flagpoles, benches, planters, statue of the sun
  const fx=x, fz=z-d/2-9;
  const fo=grp(city,fx,0,fz); put(CYL(2.6,2.7,.6,32),'tx:conc',fo,0,.3,0); const wtr=new THREE.Mesh(new THREE.CylinderGeometry(2.35,2.35,.05,32),new THREE.MeshPhysicalMaterial({color:0x6FCBFF,roughness:.05,clearcoat:1,transparent:true,opacity:.8})); wtr.position.y=.55; fo.add(wtr);
  put(CYL(.4,.6,1.4,16),'tx:conc',fo,0,1.0,0); put(CYL(1.0,.8,.2,24),'tx:conc',fo,0,1.75,0); put(CYL(.15,.25,.8,12),'tx:conc',fo,0,2.2,0);
  for(let k=0;k<10;k++){ const a=k/10*Math.PI*2; tube([[0,2.6,0],[Math.cos(a)*.6,2.9,Math.sin(a)*.6],[Math.cos(a)*1.0,1.85,Math.sin(a)*1.0]],.03,0xBFE8FF,fo,6); }
  postBody(fx,fz,2.7,.6);
  for(const s of [-1,1]){ put(CYL(.06,.08,10,10),0xE8ECF6,city,x+s*8,5,z-d/2-4); put(new THREE.SphereGeometry(.14,10,8),0xFFD84A,city,x+s*8,10.05,z-d/2-4); }
  const flagG=new THREE.PlaneGeometry(2.2,1.3,16,4); const fp=flagG.attributes.position; for(let i=0;i<fp.count;i++){ const fx2=fp.getX(i)+1.1; fp.setZ(i,Math.sin(fx2*3)*.12*fx2); } flagG.computeVertexNormals();
  for(const [s,t,bg,fg] of [[-1,'☀','#3FB8FF','#FFE27A'],[1,'PW','#FF6E9E','#FFFFFF']]){ const fl=new THREE.Mesh(flagG,new THREE.MeshStandardMaterial({map:labelTex([t],256,160,bg,fg,110),side:THREE.DoubleSide,roughness:.8})); fl.position.set(x+s*8,9.2,z-d/2-4+1.1); fl.rotation.y=HP; fl.castShadow=true; scene.add(fl); }
  for(const s of [-1,1]){ bench(x+s*5.5,fz,s>0?HP:-HP); bench(x+s*5.5,fz-4,s>0?HP:-HP); planter(x+s*11,fz+3,1.1); planter(x+s*11,fz-5,1.1); }
  // statue: a sunny little mascot on a plinth
  const st=grp(city,x-11,0,fz-1); put(B(1.6,1.4,1.6),'tx:conc',st,0,.7,0); put(B(1.8,.15,1.8),'tx:curb',st,0,1.45,0); put(new THREE.SphereGeometry(.75,20,14),0xC9A04A,st,0,2.5,0); for(let k=0;k<10;k++){ const a=k/10*Math.PI*2; put(new THREE.ConeGeometry(.16,.45,6),0xC9A04A,st,Math.cos(a)*.95,2.5+Math.sin(a)*.95,0,{rz:a-HP}); } txt(['OUR SUN','EST. 1952'],1.4,.5,null,'#2E2350',st,0,.8,.81);
  postBody(x-11,fz-1,.9,1.5);
  for(const s of [-1,1]) T(x+s*14,z-d/2-14,1.05); T(x-14,z+4,1); T(x+14,z+4,1.1);
}
function cinema(x,z){
  const w=16,d=18,h=9; const g=G(x,z,'+z');
  put(B(w,h,d),'tx:stuccoPink',g,0,h/2,0); put(B(w+.1,1.0,d+.1),'tx:brickPink',g,0,.5,0); put(B(w+.3,.25,d+.3),TRIM,g,0,h,0); put(B(w+.4,.5,d+.4),0xFFC93C,g,0,h+.35,0);
  for(let i=0;i<5;i++) put(B(.5,h-1.2,.2),0xFFD1E0,g,-w/2+1.2+i*((w-2.4)/4),h/2+.4,d/2+.1);
  // marquee
  const mq=grp(g,0,4.6,d/2); put(B(w-1,1.6,2.6,.05),0xFFFFFF,mq,0,0,1.3); put(B(w-.8,.15,2.8),0xFFC93C,mq,0,.86,1.3); put(B(w-.8,.15,2.8),0xFFC93C,mq,0,-.86,1.3);
  for(const [zz,ry] of [[2.62,0]]){ txt(['NOW SHOWING'],w-3,.45,'#2E2350','#FFE27A',mq,0,.4,zz); txt(['SUNNY DAYS 2  ·  MOP WARS'],w-2,.5,'#FFFFFF','#E8343F',mq,0,-.25,zz); }
  for(let i=0;i<40;i++){ const bx=-w/2+.8+i*((w-1.6)/39); put(new THREE.SphereGeometry(.05,6,5),0xFFF6D0,mq,bx,.75,2.68,{ns:true}); put(new THREE.SphereGeometry(.05,6,5),0xFFF6D0,mq,bx,-.75,2.68,{ns:true}); }
  for(const s of [-1,1]) tube([[s*(w/2-1.5),.8,2.4],[s*(w/2-1.5),3.2,.2]],.05,METAL,mq,3);
  // vertical blade sign
  const bl=grp(g,w/2-1.2,6.2,d/2+.7); put(B(.4,5.6,1.5,.05),0xE8343F,bl,0,0,0); for(let k=0;k<6;k++){ const ch='CINEMA'[k]; txt([ch],.9,.8,null,'#FFE27A',bl,.21,2.2-k*.88,0,HP); txt([ch],.9,.8,null,'#FFE27A',bl,-.21,2.2-k*.88,0,-HP); }
  // box office, doors, posters
  const bo=grp(g,0,0,d/2); put(B(2.2,2.6,1.2),0xFFC93C,bo,0,1.3,.6); const bgl=new THREE.Mesh(new THREE.BoxGeometry(1.6,1.0,.03),glassMat); bgl.position.set(0,1.7,1.22); bo.add(bgl); txt(['TICKETS'],1.6,.3,'#E8343F','#FFFFFF',bo,0,2.4,1.22);
  for(const s of [-1,1]){ windowPane(g,s*3.4,1.7,d/2,2.4,2.2,0,300,{frame:0xFFC93C,ft:.1,mullV:2,interior:INT.lobby}); }
  for(const [px,t,bg] of [[-6.6,['SUNNY','DAYS 2'],'#3FB8FF'],[6.6,['MOP','WARS'],'#FF9F1C']]){ put(B(1.3,1.9,.08),0xFFC93C,g,px,1.9,d/2+.05); sign(t,1.1,1.6,bg,'#2E2350',g,px,1.9,d/2+.1); }
  hvac(g,-4,h+.6,-3); hvac(g,3,h+.6,2);
  solid(g,0,h/2,0,w/2,h/2,d/2); bmeta(x,z,w/2,d/2,0,'tx:stuccoPink','tx:gravel','Cinema');
}

// ---------- Dumpster Alley (west of Main, between Elm and the Skyway) ----------
function dumpsterAlley(){
  lot(-3.5,10,16,62); for(const z of [12,24.5,37,49.5]) parkingStalls(-3.3,z,4,1,2.5,5,'z');
  for(const z of [12,24.5,37,49.5]) parkingStalls(16.2-.2,z,4,-1,2.5,5,'z');
  const L2=[[-1,14],[-1,19.5],[-1,27],[-1,39],[-1,44],[-1,54],[13.5,16.5],[13.5,29],[13.5,41.5],[13.5,56.5]];
  L2.forEach(([x,z],i)=>{ if(i%3!==2) parked(x,z,0); });
  for(const z of [18,33,48]) lightPole(6.3,z);
  for(const z of [14,26,40,52]) wheelStop(2.5,z,HP);
  // the back alley along Creek Rd side: gravel strip, dumpsters, a burnable trash pile, graffiti wall
  put(B(19.5,.03,4),'tx:gravel',city,6.3,.02,64.5,{ns:true}); rect(META.lots,-3.5,62.5,16,66.3,{kind:'dirt'});
  const wall=grp(city,6.3,0,66.1); put(B(19.6,2.6,.3),'tx:brickRed',wall,0,1.3,0); put(B(19.8,.12,.4),'tx:curb',wall,0,2.65,0); staticBox(6.3,1.3,66.1,9.8,1.3,.15);
  graffiti(2,1.4,65.92,Math.PI,['ALLEY','KATS'],'#FF3D8B',2.4,1.1); graffiti(10,1.5,65.92,Math.PI,['♥ MOP'],'#26D3A0',1.8,.9);
  dumpster(-.5,63.8,0); dumpster(4,63.8,0,'tx:ribBlue',0x2F6FD0); dumpster(13,63.8,0,'tx:ribYel',0xD9A400);
  for(let i=0;i<4;i++) cardboard(7.5+i*.9,63.5+(i%2)*.4,rnd());
  puddle(9,60,1.2); puddle(-2,58,.8);
  for(const [x,z] of [[-5.2,10],[-5.2,62],[17.5,10]]) T(x,z,.9);
  chainFence([[17.4,9.5],[17.4,62.5]]);
}

// ---------- corner store block extras: gas station + construction lot ----------
function gasStation(){
  const cx=4, cz=-31;   // forecourt centre
  lot(-4,-21,15,-45);
  const cg=grp(city,cx,0,cz); const CW=9,CD=13,CH=4.6;
  put(B(CW,.7,CD,.06),0xFFFFFF,cg,0,CH,0); put(B(CW+.1,.3,CD+.1),0xE8343F,cg,0,CH-.25,0); put(B(CW-.6,.04,CD-.6),0xFFF6D0,cg,0,CH-.37,0,{ns:true});
  for(const [px,pz] of [[-2.5,-4],[2.5,-4],[-2.5,4],[2.5,4]]){ put(B(.4,CH,.4),0xFFFFFF,cg,px,CH/2,pz); postBody(cx+px,cz+pz,.25,CH); }
  txt(['GAS · FUEL'],5,.55,'#E8343F','#FFFFFF',cg,0,CH-.1,CD/2+.07); txt(['GAS · FUEL'],5,.55,'#E8343F','#FFFFFF',cg,0,CH-.1,-CD/2-.07,Math.PI);
  for(const pz of [-4,4]){ put(B(1.2,.25,4.6,.04),'tx:conc',cg,0,.12,pz); for(const pzz of [-1.2,1.2]){ const pu=grp(cg,0,.25,pz+pzz); put(B(.9,1.7,.55,.04),0xF4F7FF,pu,0,.85,0); put(B(.92,.3,.57),0xE8343F,pu,0,1.55,0); put(B(.5,.35,.03),0x2E2350,pu,0,1.15,.29); put(B(.5,.35,.03),0x2E2350,pu,0,1.15,-.29); tube([[.46,1.2,0],[.7,.9,.1],[.6,.4,.2]],.03,0x1E1A2E,pu,6); put(B(.12,.3,.1),0x1E1A2E,pu,.5,1.0,0); }
    put(B(.4,1.2,.4),0xFFC93C,cg,0,.6,pz-2.5); put(B(.4,1.2,.4),0xFFC93C,cg,0,.6,pz+2.5); }
  // kiosk
  shop({x:11.5,z:-41.5,w:7,d:5,face:'+z',wall:'tx:stuccoCream',sign:'KWIK STOP',signBg:'#E8343F',signFg:'#FFFFFF',signHex:0xE8343F,interior:INT.mart,name:'Kwik Stop',
    extra:(g,{w,fz})=>{ const ic=grp(g,w/2-1,0,fz+.4); put(B(1.2,1.0,.6,.03),0xF4F7FF,ic,0,.55,0); txt(['ICE'],.8,.35,null,'#3FB8FF',ic,0,.55,.31); } });
  // price sign on Main
  const ps=grp(city,-5,0,-23,0); put(B(.3,4.8,.3),0xC8CDDD,ps,-.9,2.4,0); put(B(.3,4.8,.3),0xC8CDDD,ps,.9,2.4,0); put(B(2.6,2.4,.4,.04),0xFFFFFF,ps,0,4.6,0); put(B(2.4,.6,.42),0xE8343F,ps,0,5.5,0);
  txt(['GAS'],2,.5,null,'#FFFFFF',ps,0,5.5,.22); for(const [i,t] of ['REG 3.49','PLUS 3.79','DSL 3.99'].entries()){ txt([t],2.2,.45,'#2E2350','#FFE27A',ps,0,4.95-i*.55,.21); txt([t],2.2,.45,'#2E2350','#FFE27A',ps,0,4.95-i*.55,-.21,Math.PI); }
  postBody(-5,-23,.4,3);
  bmeta(cx,cz,CW/2,CD/2,0,0xFFFFFF,0xE8343F,'Gas');
  for(const [x,z] of [[-2,-20.6],[14,-20.6]]) bollard(x,z,0xE8343F);
  parked(2,-26.5,0,0x3FB8FF); trashCan(8.5,-24); trashCan(8.5,-37);
  const air=grp(city,13.5,0,-22.5); put(B(.6,1.4,.5,.03),0x3FB8FF,air,0,.7,0); txt(['AIR'],.5,.2,'#FFFFFF','#2E2350',air,0,1.2,.26);
}
function construction(){
  // a fenced lot where the town is "improving" something: diggable dirt, heavy gear, pipes, port-a-potty
  lot(-4,-50,16,-68,'dirt'); chainFence([[-4.5,-49.5],[16.5,-49.5],[16.5,-68.5],[-4.5,-68.5],[-4.5,-61]]);
  for(const [x,z] of [[-4.5,-56],[-4.5,-58.5]]) cone2(x,z);
  // mini excavator
  const ex=grp(city,6,0,-58,.6); put(B(3.2,.5,1.0,.05),0x2E2350,ex,0,.35,-.9); put(B(3.2,.5,1.0,.05),0x2E2350,ex,0,.35,.9); for(let k=0;k<7;k++){ put(B(.18,.55,1.04),0x1A1D30,ex,-1.5+k*.5,.35,-.9); put(B(.18,.55,1.04),0x1A1D30,ex,-1.5+k*.5,.35,.9); }
  put(CYL(1.2,1.2,.3,20),0x4A4F66,ex,0,.75,0); put(B(2.4,1.0,2.0,.08),0xFFC93C,ex,-.3,1.4,0); const cab=grp(ex,.4,1.9,.3); put(B(1.2,1.5,1.2,.05),0xFFC93C,cab,0,.75,0); const cgl=new THREE.Mesh(new THREE.BoxGeometry(1.0,.9,1.22),glassMat); cgl.position.set(.05,.95,0); cab.add(cgl);
  put(B(.5,.4,1.6),0x4A4F66,ex,-1.4,1.5,0); txt(['DIGGO'],1.0,.3,null,'#2E2350',ex,-.3,1.5,1.01);
  const boom=grp(ex,1.0,1.6,-.4); tube([[0,0,0],[1.4,1.4,0],[2.8,1.6,0]],.17,0xFFC93C,boom,8); tube([[2.8,1.6,0],[3.4,.6,0],[3.3,-.6,0]],.13,0xFFC93C,boom,8); put(B(.8,.6,.8),0x4A4F66,boom,3.3,-.85,0,{rz:.4}); for(let k=0;k<4;k++) put(new THREE.ConeGeometry(.08,.25,5),0xC8CDDD,boom,3.0+k*.2,-1.2,0,{rx:Math.PI});
  staticBox(6,1.2,-58,1.9,1.2,1.6,.6);
  // dirt pile, pipe stack, barriers, port-a-potty
  const dp=put(lumpy(2.6,5),'tx:dirt',city,12,-.6,-62); dp.scale.set(1.2,.55,1); postBody(12,-62,2.2,1.4);
  for(let i=0;i<3;i++) for(let j=0;j<3-i;j++){ put(CYL(.45,.45,4,16),0x8E95AE,city,-0+j*.95+i*.47,.45+i*.8,-53,{rz:HP}); put(CYL(.33,.33,4.05,16),0x3A3D5E,city,0+j*.95+i*.47,.45+i*.8,-53,{rz:HP}); }
  staticBox(1,1.2,-53,2,1.2,1.4);
  const pp=grp(city,14.5,0,-66.5,Math.PI); put(B(1.2,2.3,1.2,.05),0x3FB8FF,pp,0,1.15,0); put(B(1.3,.1,1.3),0xFFFFFF,pp,0,2.35,0); put(B(.9,1.9,.04),0x2F8FD9,pp,0,1.05,.61); txt(['PORTA','POTTY'],.7,.4,'#FFFFFF','#2E2350',pp,0,1.8,.64); solid(pp,0,1.15,0,.6,1.15,.6);
  for(let i=0;i<4;i++){ const jb=grp(city,-3+i*2.2,0,-49,0); put(B(2,.8,.5,.04),i%2?0xFF9F1C:0xFFFFFF,jb,0,.4,0); put(B(2.02,.2,.52),i%2?0xFFFFFF:0xFF9F1C,jb,0,.6,0); }
  txt(['PARDON OUR DUST!','NEW PUDDLEWICK PARKADE'],5,1.2,'#FFC93C','#2E2350',city,6,1.6,-49.25,Math.PI);
  bmeta(6,-58,10,9,0,'tx:dirt',0xFFC93C,'Construction');
}
function cone2(x,z){ const g=grp(city,x,0,z); put(B(.46,.04,.46,.015),0x2E2A33,g,0,.02,0); put(CYL(.03,.165,.66,20),0xFF6A1E,g,0,.38,0); put(CYL(.127,.142,.1,20),0xF4F6FF,g,0,.32,0); put(CYL(.077,.092,.07,20),0xF4F6FF,g,0,.52,0); }

// ---------- school campus (north-east, east of Pine St) ----------
function schoolCampus(){
  relocate(lookSchool, 6,12, -46,-104, Math.PI);   // the look-test school, facing Pine St
  // gym wing and covered walkway
  shop({x:-46,z:-128,w:16,d:12,face:'+z',wall:'tx:brickYel',sign:'GO PUDDLES!',signBg:'#2E2350',signFg:'#FFE27A',signHex:0x2E2350,interior:INT.gym,h:7,parapet:.6,name:'Gym',doorAt:.5,bays:[{t:'win',w:4.5},{t:'door',w:2.2},{t:'win',w:3.5},{t:'win',w:4.0}]});
  const cw=grp(city,-46,0,-114.5); for(let k=0;k<4;k++){ put(CYL(.07,.07,2.8,8),METAL,cw,-1.2,1.4,-3+k*2); put(CYL(.07,.07,2.8,8),METAL,cw,1.2,1.4,-3+k*2); } put(B(3,.12,8.4,.03),0x3FB8FF,cw,0,2.85,0);
  // classroom portables
  for(const [x,i] of [[-22,0],[-14,1]]){ const g=G(x,-136,'+x'); put(B(10,2.8,6),'tx:sidYel',g,0,1.9,0); put(B(10.2,.5,6.2),'tx:ribGrey',g,0,.25,0); put(B(10.4,.15,6.4),0xF4F0F8,g,0,3.35,0);
    for(const wx of [-3,3]) windowPane(g,wx,2.1,3,1.6,1.0,0,150,{frame:0xFFFFFF,mullV:2,interior:INT.classroom});
    const st=grp(g,0,0,3.6); put(B(1.6,.1,1.2),'tx:woodPale',st,0,.5,0); for(let k=0;k<3;k++) put(B(1.0,.08,.3),'tx:woodPale',st,0,.12+k*.15,.8-k*.0); put(B(.9,2.0,.06),0x8A6648,g,0,1.5,3.04); txt(['ROOM '+(12+i)],1.2,.3,'#FFFFFF','#2E2350',g,0,2.9,3.04); solid(g,0,1.9,0,5,1.9,3); bmeta(x,-136,3,5,0,'tx:sidYel',0xF4F0F8,'Portable'); }
  // sports field with running track, goals and bleachers (north part of campus)
  const fx=-70, fz=-120, SL2=40;
  put(B(30,.03,SL2),'tx:track',city,fx,.015,fz,{ns:true}); put(B(22,.035,SL2),'tx:turf',city,fx,.02,fz,{ns:true});
  for(const s of [-1,1]){ put(new THREE.CylinderGeometry(15,15,.03,40,1,false,s>0?-HP:HP,Math.PI),'tx:track',city,fx,.015,fz+s*SL2/2,{ns:true}); put(new THREE.CylinderGeometry(11,11,.04,40,1,false,s>0?-HP:HP,Math.PI),'tx:turf',city,fx,.02,fz+s*SL2/2,{ns:true}); }
  for(let l=1;l<5;l++) for(const s of [-1,1]) paint(.06,SL2,fx+s*(11+l*.8),fz,0xFFFFFF);
  paint(22,.12,fx,fz,0xFFFFFF); const cc=new THREE.Mesh(new THREE.RingGeometry(3,3.15,32),getMat(0xFFFFFF)); cc.userData.c=0xFFFFFF; cc.rotation.x=-HP; cc.position.set(fx,.07,fz); city.add(cc);
  for(const s of [-1,1]){ const gg=grp(city,fx,0,fz+s*19,s>0?0:Math.PI); put(CYL(.06,.06,2.4,8),0xFFFFFF,gg,-3.6,1.2,0); put(CYL(.06,.06,2.4,8),0xFFFFFF,gg,3.6,1.2,0); put(CYL(.06,.06,7.3,8),0xFFFFFF,gg,0,2.4,0,{rz:HP}); for(let k=0;k<8;k++) put(B(7.2,.015,.015),0xE8ECF6,gg,0,.3+k*.28,.8,{ns:true}); put(B(7.2,2.4,.015),0xE8ECF6,gg,0,1.2,1.0,{ns:true}); }
  const bl=grp(city,fx-17.2,0,fz,-HP); for(let k=0;k<5;k++){ put(B(16,.1,.6),'tx:woodPale',bl,0,.45+k*.45,k*.6); put(B(16,.45,.05),0xC8CDDD,bl,0,.22+k*.45,k*.6-.3); } for(let k=-4;k<=4;k++) put(B(.08,2.6,.08),METAL,bl,k*2,1.3,2.6); staticBox(fx-17.2-1.3,1.1,fz,1.5,1.1,8);
  const sb=grp(city,fx,0,fz-33.5); put(B(.25,5,.25),0xC8CDDD,sb,-2,2.5,0); put(B(.25,5,.25),0xC8CDDD,sb,2,2.5,0); put(B(5,2.4,.4,.04),0x2E2350,sb,0,5.2,0); txt(['HOME 3  ·  AWAY 0'],4.4,.6,'#2E2350','#FFE27A',sb,0,5.6,.21,0); txt(['PUDDLES'],3,.6,null,'#FF6E9E',sb,0,4.6,.21,0);
  chainFence([[fx-15.6,fz-35.5],[fx+15.6,fz-35.5],[fx+15.6,fz+35.5],[fx-15.6,fz+35.5],[fx-15.6,fz-35.5]],2.4);
  rect(META.lots,fx-15,fz-35,fx+15,fz+35,{kind:'park'});
  // bus loop and parent parking (south part of campus), with two school buses
  lot(-26,-84,8,-126); parkingStalls(-24,-125.8,12,1,2.6,5,'x');
  schoolBus(-14,-97,HP); schoolBus(-14,-104,HP);
  for(const [x,z] of [[-21.4,-123.2],[-8.4,-123.2],[-3.2,-123.2]]) parked(x,z,HP);
  curbRun(-26,-110,8,-110); txt(['BUS LOOP','NO PARKING'],3,1,null,'#FFC93C',city,-6,.075,-100).rotation.set(-HP,0,HP);
  // playground by the gym
  playground(-26,-147,0);
  // trees and benches around the campus
  for(const [x,z] of [[-30,-86],[-62,-86],[-84,-90],[-84,-150],[-30,-152],[-55,-150]]) T(x,z,1.05);
  for(const x of [-34,-40,-52,-58]) Bu(x,-97.5,1.1);
  rect(META.lots,-86,-86,-30,-153,{kind:'park'});
}
function schoolBus(x,z,ry){ const g=grp(city,x,0,z,ry); const L2=10,W=2.4;
  put(B(L2-1.2,2.2,W,.12),0xFFC21A,g,-.6,1.55,0); put(B(1.6,1.2,W,.1),0xFFC21A,g,L2/2-.8,1.05,0); put(B(L2,.35,W+.05),0x2E2350,g,0,.55,0); put(B(.12,.3,W*.9),0xC8CDDD,g,L2/2+.05,.6,0);
  for(let i=0;i<8;i++) for(const s of [-1,1]){ const gw=new THREE.Mesh(new THREE.BoxGeometry(.85,.7,.03),glassMat); gw.position.set(-4.6+i*1.05,2.05,s*(W/2+.01)); g.add(gw); put(B(.08,.75,.04),0x2E2350,g,-4.15+i*1.05,2.05,s*(W/2+.01)); }
  const ws=new THREE.Mesh(new THREE.BoxGeometry(.03,.9,W*.85),glassMat); ws.position.set(L2/2-1.43,2.05,0); g.add(ws);
  for(const s of [-1,1]) put(B(L2-1.4,.08,.03),0x2E2350,g,-.6,1.2,s*(W/2+.02));
  txt(['SCHOOL BUS'],3,.45,'#FFC21A','#2E2350',g,-.6,2.9,W/2+.02); txt(['SCHOOL BUS'],3,.45,'#FFC21A','#2E2350',g,-.6,2.9,-W/2-.02,Math.PI);
  put(B(.05,.5,.5),0xE8343F,g,L2/2-3,1.6,W/2+.2); txt(['STOP'],.4,.4,'#E8343F','#FFFFFF',g,L2/2-3,1.6,W/2+.23);
  for(const [wx,wz] of [[3.2,1],[-3.2,1],[3.2,-1],[-3.2,-1]]){ const w=grp(g,wx,.5,wz*(W/2-.15)); put(CYL(.5,.5,.32,20),0x23202E,w,0,0,0,{rx:HP}); put(CYL(.28,.28,.34,14),0xC8CDDD,w,0,0,0,{rx:HP}); }
  for(const s of [-1,1]){ put(B(.06,.2,.3),0xFFFBEA,g,L2/2+.04,.95,s*.8); put(new THREE.SphereGeometry(.09,8,6),0xFF3B5C,g,-L2/2+.1,2.45,s*.9); }
  const s2=new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0),ry); staticBox(x,1.3,z,Math.abs(s2.x)*L2/2+Math.abs(s2.z)*W/2,1.3,Math.abs(s2.z)*L2/2+Math.abs(s2.x)*W/2).twTag='car'; }
function playground(x,z,ry){ const g=grp(city,x,0,z,ry);
  put(B(16,.06,12),'tx:rubber',g,0,.03,0,{ns:true}); for(const s of [-1,1]){ put(B(16.3,.25,.25),'tx:wood',g,0,.12,s*6.1); put(B(.25,.25,12.3),'tx:wood',g,s*8.1,.12,0); }
  // tower + slide
  const tw=grp(g,-3,0,0); for(const [a,b] of [[-1,-1],[1,-1],[-1,1],[1,1]]) put(B(.18,3.6,.18),0xFF6E9E,tw,a*1.1,1.8,b*1.1); put(B(2.4,.15,2.4),'tx:woodPale',tw,0,1.8,0); shapeExtrude([[-1.4,0],[1.4,0],[0,1.2]],2.6,0x3FB8FF,tw).position.y=3.6;
  for(const s of [-1,1]) put(B(2.3,.5,.06),0xFFC93C,tw,0,2.3,s*1.12); const sl=grp(tw,2.6,1.0,0); put(B(3.2,.08,.9),0x26D3A0,sl,0,0,0,{rz:-.55}); for(const s of [-1,1]) put(B(3.2,.3,.06),0x26D3A0,sl,0,.12,s*.45,{rz:-.55});
  for(let k=0;k<6;k++) put(B(.08,.06,.9),0xFFC93C,tw,-1.4,.3+k*.3,0);
  solid(g,-3,1.8,0,1.2,1.8,1.2);
  // swings
  const sw=grp(g,4,0,-2); for(const s of [-1,1]){ tube([[s*2.4,0,-.9],[s*2.4,2.6,0],[s*2.4,0,.9]],.08,0x8F6BFF,sw,6); } put(CYL(.07,.07,4.8,8),0x8F6BFF,sw,0,2.6,0,{rz:HP});
  for(const s of [-1,1]){ put(B(.06,1.9,.02),0x8E95AE,sw,s*1.0-.25,1.6,0); put(B(.06,1.9,.02),0x8E95AE,sw,s*1.0+.25,1.6,0); put(B(.6,.06,.25),INK,sw,s*1.0,.65,0); }
  // seesaw, spring rider, sandbox
  const ss=grp(g,4,0,3); put(B(.4,.5,.4),0xFF9F1C,ss,0,.25,0); put(B(3.6,.1,.3),0x3FB8FF,ss,0,.55,0,{rz:.15}); for(const s of [-1,1]) put(B(.06,.3,.3),0xFF9F1C,ss,s*1.6,.75+s*.25,0);
  const sp=grp(g,-6,0,3.5); put(CYL(.12,.12,.6,8),0x8E95AE,sp,0,.3,0); put(new THREE.SphereGeometry(.45,14,10),0xFFC93C,sp,0,.9,0); put(new THREE.SphereGeometry(.2,10,8),0xFFC93C,sp,.4,1.2,0);
  const sb=grp(g,-5.5,0,-3.5); for(const s of [-1,1]){ put(B(3,.3,.2),'tx:wood',sb,0,.15,s*1.4); put(B(.2,.3,3),'tx:wood',sb,s*1.4,.15,0); } put(B(2.7,.05,2.7),0xEED9A0,sb,0,.06,0,{ns:true});
  rect(META.lots,x-8,z-6,x+8,z+6,{kind:'park'});
}
function relocate(fn,px,pz,nx,nz,rot){
  const nc=city.children.length, ns=scene.children.length, nb=world.bodies.length, ng=glassPanes.length; fn();
  const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),rot), cq=new CANNON.Quaternion(q.x,q.y,q.z,q.w);
  const mv=(p)=>{ const dx=p.x-px, dz=p.z-pz; const c=Math.cos(rot), s=Math.sin(rot); return [nx+dx*c+dz*s, nz-dx*s+dz*c]; };
  for(const o of [...city.children.slice(nc), ...scene.children.slice(ns)]){ const [x,z]=mv(o.position); o.position.x=x; o.position.z=z; o.quaternion.premultiply(q); }
  for(const b of world.bodies.slice(nb)){ const [x,z]=mv(b.position); b.position.x=x; b.position.z=z; b.quaternion=cq.mult(b.quaternion); }
}

// ---------- the Underpass: east camp under the Skyway, and the rest of the deck ----------
function underpass(){
  put(B(9,.02,22),'tx:dirt',city,22,.013,-17,{ns:true}); rect(META.lots,17.5,-28,26.5,-6,{kind:'dirt'}); rect(META.lots,17.5,-5,26.5,21,{kind:'dirt'});
  rect(META.decks,18.3,-200,25.7,200,{name:'ROUTE 9 SKYWAY'});
  // tents: tarps over ridge poles, guy lines, sleeping bags
  for(const [x,z,ry,c] of [[20.2,-12,0.3,0x3FB8FF],[23.2,-22,-.4,0x26D3A0],[20.6,-26,1.4,0xFF9F1C]]){ const t=grp(city,x,0,z,ry);
    put(CYL(.03,.03,2.6,6),METAL,t,0,1.2,0,{rx:HP}); for(const s of [-1,1]){ put(CYL(.025,.025,1.3,6),METAL,t,0,.6,s*1.3); }
    const tarp=new THREE.BufferGeometry(); tarp.setAttribute('position',new THREE.Float32BufferAttribute([-1.0,0,-1.3, 0,1.25,-1.3, 0,1.25,1.3, -1.0,0,-1.3, 0,1.25,1.3, -1.0,0,1.3, 1.0,0,-1.3, 0,1.25,1.3, 0,1.25,-1.3, 1.0,0,-1.3, 1.0,0,1.3, 0,1.25,1.3],3)); tarp.computeVertexNormals(); const tm=mesh(tarp,c,t); tm.material=getMat(c); tm.userData.c=c;
    put(B(.7,.12,1.8,.05),0x5A4C80,t,0,.08,.1,{ns:true}); solid(t,0,.6,0,1.0,.6,1.3); }
  // couch #2, pallets, crates as tables, grill, mattress, shopping carts, cardboard signs
  const couch=grp(city,24.5,0,-14,HP+.25); put(B(2.4,.35,.95,.04),0x9A5A3A,couch,0,.3,0); for(const cx of [-.6,.6]){ put(B(1.1,.22,.85,.08),0xC07A4A,couch,cx,.58,.04); put(B(1.1,.62,.24,.08),0xC07A4A,couch,cx,.95,-.36,{rx:-.12}); } put(B(2.4,.7,.25,.05),0x9A5A3A,couch,0,.78,-.48); for(const s of [-1,1]) put(B(.28,.62,.95,.08),0x9A5A3A,couch,s*1.28,.62,0);
  solid(couch,0,.5,0,1.3,.5,.6,'couch');
  for(let i=0;i<3;i++){ const pl=grp(city,25.2-i*.1,0,-7.6-i*1.35,i*.3); for(let k=0;k<5;k++) put(B(1.2,.03,.14),'tx:wood',pl,0,.14,-.5+k*.25); for(const s of [-1,0,1]) put(B(.14,.12,1.2),'tx:wood',pl,s*.5,.06,0); }
  const gr=grp(city,22.6,0,-9.5); put(new THREE.SphereGeometry(.4,16,8,0,Math.PI*2,HP,HP),0x23272B,gr,0,.9,0); for(let k=0;k<3;k++){ const a=k/3*Math.PI*2; put(CYL(.02,.02,.9,6),0x23272B,gr,Math.cos(a)*.25,.45,Math.sin(a)*.25,{rz:Math.cos(a)*.2,rx:Math.sin(a)*.2}); } put(CYL(.4,.4,.02,16),0x8E95AE,gr,0,.92,0);
  const mt=grp(city,25.6,0,-23,Math.PI); put(B(1.9,.22,1.4,.08),0xEDE4D6,mt,0,.12,0); for(let k=0;k<4;k++) put(B(1.9,.01,.02),0xD8D0C4,mt,0,.24,-.5+k*.33); stain(25.3,-23.2);
  for(const [x,z] of [[18.6,-21],[25.2,-27]]){ const sc=grp(city,x,0,z,rnd()*3); const wire=0xC8CDDD; for(const s of [-1,1]){ put(B(.02,.55,.02),wire,sc,s*.3,.75,-.45); put(B(.02,.55,.02),wire,sc,s*.3,.75,.45); } for(let k=0;k<5;k++){ put(B(.6,.012,.012),wire,sc,0,.5+k*.12,-.45); put(B(.6,.012,.012),wire,sc,0,.5+k*.12,.45); put(B(.012,.012,.9),wire,sc,-.3,.5+k*.12,0); put(B(.012,.012,.9),wire,sc,.3,.5+k*.12,0); } put(B(.6,.02,.9),wire,sc,0,.48,0); for(const s of [-1,1]) for(const t of [-1,1]) put(CYL(.06,.06,.04,10),INK,sc,s*.25,.06,t*.38,{rz:HP}); put(B(.45,.3,.35),0x23272B,sc,0,.75,.1); }
  for(const [x,z,t] of [[24.6,-11.6,['ANYTHING','HELPS']],[20.3,-15.6,['GOD BLESS']]]){ const c=grp(city,x,0,z,rnd()*2); put(B(.7,.5,.03),0xB08A5A,c,0,.35,0,{rx:-.3}); sign(t,.6,.4,null,'#2E2350',c,0,.36,.03); }
  for(let i=0;i<10;i++) stain(18.5+rnd()*7,-26+rnd()*18);
  decal(scorchTex,22.4,-18,1.8,.6);
  graffiti(22-2.4-.51,2.2,-18,-HP,['MOP','GANG'],'#FFC93C'); graffiti(22+2.4+.51,2.4,-30,HP,['SKY','WAY ☺'],'#3FB8FF'); graffiti(22-2.4,2.3,-6-.51,Math.PI,['PW'],'#FF3D8B',.9,.6);
  graffiti(22-2.4-.51,2.0,42,-HP,['ZZZ','HOTEL'],'#8F6BFF'); graffiti(22+2.4+.51,2.1,-54,HP,['NO','COPS'],'#FF3D8B'); graffiti(22-2.4-.51,1.9,-90,-HP,['FIZZY','KIDS'],'#26D3A0');
  // weeds and chain-link along the skyway away from the camps
  chainFence([[17.6,-40],[17.6,-66]]); chainFence([[26.4,-40],[26.4,-66]]); chainFence([[17.6,30],[17.6,62]]); chainFence([[26.4,30],[26.4,62]]);
  for(let i=0;i<30;i++){ const z=pick([-1,1])*rr(32,150), x=22+rr(-3,3); if(Math.abs(z-72)<8||Math.abs(z+76)<8) continue; Bu(x,z,.5+rnd()*.4); }
}

// ---------- Maple Row, Birch Ln and Bluebell Ct (west of Main, south of the Skyway) ----------
const HOUSE_SIDS=['tx:sidPink','tx:sidBlue','tx:sidYel','tx:sidLav','tx:sidMint','tx:sidPeach','tx:sidWhite','tx:sidSage'];
const HOUSE_ROOFS=['tx:shGrape','tx:shGum','tx:shMint','tx:shTang'];
const DOORS=[P.grape,P.gum,P.mint,P.tang,0xE8343F,0x3FB8FF,0xFFC93C,0x2E2350];
function suburbHouse(x,z,face,i){
  const w=6.4+((i*37)%3)*.6, d=6, h=3.1+((i*13)%3)*.2;
  const ry=FACE[face];
  house(x,z,w,d,h,HOUSE_SIDS[i%8],HOUSE_ROOFS[(i*3+1)%4],TRIM,ry,DOORS[(i*5)%8]);
  bmeta(x,z,(face==='+x'||face==='-x')?d/2:w/2,(face==='+x'||face==='-x')?w/2:d/2,0,HOUSE_SIDS[i%8],HOUSE_ROOFS[(i*3+1)%4],'House');
  const g=G(x,z,face); g.userData.terrain='split'; const fz=d/2+4.2;   // the lot's pieces each find their own ground (GAME-96)
  // driveway to a detached garage on the right-hand side of the lot
  const dx=w/2+2.6; put(B(3,.05,fz+.9+d/2),'tx:walk',g,dx,.025,(fz+.3-d/2-.6)/2,{ns:true});
  if(i%3!==1){ const gg=grp(g,dx,0,-1.6); put(B(3.6,2.6,4.2),HOUSE_SIDS[(i+3)%8],gg,0,1.3,0); put(B(3.8,.12,4.4),TRIM,gg,0,2.62,0); shapeExtrude([[-2.1,0],[2.1,0],[0,1.0]],4.6,HOUSE_ROOFS[(i*3+1)%4],gg).position.y=2.66;
    const door=grp(gg,0,0,2.11); put(B(3.0,2.2,.05),0xF4F0F8,door,0,1.1,0); for(let k=0;k<4;k++) put(B(3.0,.03,.03),0xC8CDDD,door,0,.5+k*.5,.03); for(let k=0;k<4;k++) put(B(.5,.3,.02),0xC8E8FF,door,-1.1+k*.73,1.8,.035);
    put(B(.3,.2,.15),0xFFF6D0,gg,1.65,2.3,2.15); solid(gg,0,1.3,0,1.8,1.3,2.1); }
  else { const cp=grp(g,dx,0,-.6); for(const s of [-1,1]) for(const t of [-1,1]) put(B(.12,2.4,.12),TRIM,cp,s*1.5,1.2,t*1.8); put(B(3.4,.1,4.0),0x8E95AE,cp,0,2.45,0,{rx:.05}); }
  // a car on some driveways
  if(i%4===0||i%4===3){ const p=L(g,dx,0,fz-2.9); car(p.x,p.z,ry+HP,pick(CARS)); lastBody().twTag='car'; }
  // curbside bins, basketball hoop, kiddie pool, garden gnome, porch chair, bike, flower bed, tree
  const bp=L(g,dx+1.9,0,fz+.6); binCurb(bp.x,bp.z,ry,i%2?0x2FAE6A:0x3F7FD0);
  if(i%5===2){ const hp=grp(g,dx+1.4,0,1.5); put(CYL(.06,.06,3.0,8),0x8E95AE,hp,0,1.5,0); put(B(1.0,.65,.04),0xFFFFFF,hp,0,3.05,-.15); put(new THREE.TorusGeometry(.22,.02,6,16),0xFF6A1E,hp,0,2.8,-.45,{rx:HP}); }
  if(i%6===1){ const kp=grp(g,-w/2-1.2,0,-2.8); put(CYL(.9,.9,.3,24,1),0x3FB8FF,kp,0,.15,0); const wt=new THREE.Mesh(new THREE.CircleGeometry(.8,24),new THREE.MeshPhysicalMaterial({color:0x8FE0FF,roughness:.05,clearcoat:1})); wt.rotation.x=-HP; wt.position.y=.28; kp.add(wt); }
  if(i%4===2){ const gn=grp(g,-w*.3,0,d/2+1.4); put(new THREE.ConeGeometry(.09,.25,8),0xE8343F,gn,0,.42,0); put(new THREE.SphereGeometry(.07,8,6),0xFFD9B8,gn,0,.27,0); put(new THREE.ConeGeometry(.08,.12,8),0xFFFFFF,gn,0,.2,.04,{rx:.4}); put(CYL(.07,.08,.18,8),0x3FB8FF,gn,0,.09,0); }
  if(i%3===0){ const ch=grp(g,w*.18,.5,d/2+1.2,.4); put(B(.5,.06,.5),'tx:woodPale',ch,0,.4,0); put(B(.5,.5,.06),'tx:woodPale',ch,0,.65,-.25,{rx:-.2}); for(const s of [-1,1]) for(const t of [-1,1]) put(B(.05,.4,.05),'tx:woodPale',ch,s*.22,.2,t*.22); }
  if(i%5===4){ const bk=grp(g,dx-1.6,0,fz-1.6,.3); for(const s of [-1,1]){ put(new THREE.TorusGeometry(.3,.03,6,18),INK,bk,s*.5,.33,0); } put(B(1.0,.04,.04),0xFF6E9E,bk,0,.55,0,{rz:.2}); put(B(.04,.4,.04),0xFF6E9E,bk,.35,.6,0); put(B(.25,.05,.1),INK,bk,-.35,.78,0); }
  const fp=L(g,-w/2-1.3,0,1.0); T(fp.x,fp.z,.8+((i*7)%4)*.08);
}
function suburbs(){
  let n=0;
  // Maple Row south side (facing north), Oak north side (facing south), Oak south side (facing north),
  // Birch north side (facing south), Birch south side (facing north). Lots 14 m wide.
  const cols1=[13,27,41,55], cols2=[85,99,113,127,141];
  for(const z of [...cols1,...cols2]) suburbHouse(47.2,z,'-x',n++);
  for(const z of [...cols1,...cols2]) suburbHouse(58.8,z,'+x',n++);
  for(const z of [...cols1,...cols2]) suburbHouse(85.2,z,'-x',n++);
  for(const z of [...cols1,...cols2.slice(0,3)]) suburbHouse(96.8,z,'+x',n++);
  for(const z of [...cols1,...cols2.slice(0,3)]) suburbHouse(123.2,z,'-x',n++);
  // Bluebell Ct: cul-de-sac bulb at the west end of Birch with three houses around it
  const cx=110, cz=134; const bulb=new THREE.CylinderGeometry(10,10,.06,40); put(bulb,'tx:asphalt',city,cx,.033,cz,{ns:true});
  const ring=new THREE.CylinderGeometry(12.2,12.2,.16,40,1,true); put(new THREE.RingGeometry(10,12.2,40),'tx:walk',city,cx,.165,cz,{rx:-HP,ns:true}); put(new THREE.CylinderGeometry(3,3,.3,24),'tx:curb',city,cx,.15,cz); put(new THREE.CylinderGeometry(2.8,2.8,.32,24),'tx:mulch',city,cx,.16,cz); T(cx,cz,1.1);
  rect(META.roads,cx-10,cz-10,cx+10,cz+10,{name:'BLUEBELL CT',kind:'lane'});
  suburbHouse(cx,cz+12.2+7.4,'-z',n++); suburbHouse(cx-17.5,cz+9,'+x',n++); suburbHouse(cx+17.5,cz+9,'-x',n++);
  txt(['BLUEBELL CT'],2.4,.5,'#1F8A5A','#FFFFFF',city,cx-5,2.8,cz-13).rotation.y=HP;
  // sound wall and greenbelt between the Skyway and Maple Row
  for(const [z0,z1] of [[8,64.5],[79.5,150]]){ const zc=(z0+z1)/2, ln=z1-z0; const sw=grp(city,28.2,0,zc); put(B(.4,2.4,ln),'tx:form',sw,0,1.2,0); put(B(.6,.12,ln+.2),'tx:curb',sw,0,2.45,0); staticBox(28.2,1.2,zc,.2,1.2,ln/2); }
  for(let z=10;z<146;z+=9){ const zz=z+rnd()*3; if(Math.abs(zz-72)<8) continue; T(27.0,zz,.8+rnd()*.3); }
  // the residential lanes get yield signs at Main / Creek, and street trees along the curb
  for(const [x,z,ry] of [[34+4.8,6.6,Math.PI],[110+4.8,6.6,Math.PI],[34-4.8,66.6,0],[34+4.8,78.4,Math.PI],[110-4.8,66.6,0],[110+4.8,78.4,Math.PI]]) yieldSign(x,z,ry);
  // power poles along Oak Ave with sagging wires
  const PX=66.8, ps=[]; for(let z=10;z<160;z+=16){ if(Math.abs(z-72)<8) continue; ps.push(z); const g=grp(city,PX,0,z); put(CYL(.14,.18,9,10),'tx:pole',g,0,4.5,0); put(B(.14,.14,2.4),'tx:pole',g,0,8.3,0); for(const s of [-1,0,1]) put(CYL(.05,.06,.18,8),0x5FD2A8,g,0,8.46,s*1.05); if(z%32===10) put(CYL(.32,.32,.9,14),0xB9C0D2,g,.35,7.2,0); postBody(PX,z,.18,9); }
  for(let i=0;i<ps.length-1;i++){ const a=ps[i],b=ps[i+1]; if(b-a>20) continue; for(const s of [-1,0,1]) tube([[PX,8.54,a+s*1.05],[PX,8.15,a+4+s*1.05],[PX,7.95,(a+b)/2+s*1.05],[PX,8.15,b-4+s*1.05],[PX,8.54,b+s*1.05]],.018,INK,city,16).userData.terrain='drape'; }
  // a barricade where Maple Row dead-ends
  const bc=grp(city,34,0,149.5); for(const s of [-1,1]) put(B(.12,1.2,.12),0xFFFFFF,bc,s*3,.6,0); for(let k=0;k<2;k++) for(let i=0;i<8;i++) put(B(.75,.22,.06),i%2?0xFFFFFF:0xE8343F,bc,-2.6+i*.75,.75+k*.35,0); staticBox(34,.7,149.5,3.1,.7,.1);
  rect(META.lots,28,6,143,165,{kind:'park'});
}
function yieldSign(x,z,ry){ const g=grp(city,x,0,z,ry); put(B(.07,2.6,.07),0xB9C0D2,g,0,1.3,0); const tri=new THREE.Shape(); tri.moveTo(-.5,.3); tri.lineTo(.5,.3); tri.lineTo(0,-.55); tri.closePath(); const m=new THREE.Mesh(new THREE.ShapeGeometry(tri),new THREE.MeshStandardMaterial({map:labelTex(['YIELD'],256,256,'#FFFFFF','#E8343F',60,0),roughness:.5})); m.position.set(0,2.3,.05); g.add(m); const bk=new THREE.Mesh(new THREE.ShapeGeometry(tri),getMat(0xE8343F)); bk.scale.setScalar(1.12); bk.position.set(0,2.32,.04); g.add(bk); postBody(x,z,.08,2.6); }

// ---------- Sunny Plaza strip mall (east of Main, between the Skyway and Oak) ----------
function stripMall(){
  lot(43,-6.5,66,-70.5); for(const x0 of [43.5,48.5,60]) parkingStalls(x0,-8,22,1,-2.6,5,'z');
  const units=[['DONUT HOLE',0xFF6E9E,'#FF6E9E',INT.diner],['NAILS ♥',0x8F6BFF,'#8F6BFF',INT.barber],['DOLLAR+',0x26D3A0,'#26D3A0',INT.mart],['PHONE FIX',0x3FB8FF,'#3FB8FF',INT.video],['TAN-O-RAMA',0xFF9F1C,'#FF9F1C',INT.toys],['WASH & FOLD',0x3FB8FF,'#3FB8FF',INT.laundry]];
  units.forEach(([n,hex,cssc,int],i)=>{ shop({x:36,z:-13-i*9.4,w:9.4,d:9,face:'+x',wall:i%2?'tx:stuccoLilac':'tx:stuccoCream',sign:n,signHex:hex,signBg:cssc,signFg:'#FFFFFF',interior:int,awning:null,parapet:.9,name:n,
    extra:(g,{w,fz})=>{ put(B(w,.14,2.4),0xF4F0F8,g,0,3.3,fz+1.2); for(const s of [-1,1]) put(B(.25,3.3,.25),0xF4F0F8,g,s*(w/2-.15),1.65,fz+2.3); } }); });
  slab(40.5,-8.5,43,-69,'tx:walk',.09);
  // pylon sign at Main & Oak
  const py=grp(city,66,0,-8.5,HP); put(B(.6,7,.6),'tx:brickYel',py,-1.4,3.5,0); put(B(.6,7,.6),'tx:brickYel',py,1.4,3.5,0); put(B(3.8,2,.6,.05),0x8F6BFF,py,0,6.6,0); txt(['SUNNY PLAZA'],3.4,1.0,'#8F6BFF','#FFE27A',py,0,6.8,.31); txt(['SUNNY PLAZA'],3.4,1.0,'#8F6BFF','#FFE27A',py,0,6.8,-.31,Math.PI);
  for(const [i,t] of ['DONUTS · NAILS','DOLLAR+ · TAN'].entries()){ txt([t],3.2,.5,'#FFFFFF','#2E2350',py,0,5.2-i*.6,.31); }
  postBody(66,-8.5,.8,7);
  const spots=[]; for(const x of [46,51,62.5]) for(let k=0;k<22;k++) spots.push([x,-9.3-k*2.6]);
  spots.forEach(([x,z],k)=>{ if((k*7+3)%10<4) parked(x,z,0); });
  for(const z of [-18,-34,-50,-66]) lightPole(56.7,z);
  dumpster(29.3,-20,HP); dumpster(29.3,-48,HP,'tx:ribBlue',0x2F6FD0);
  for(const z of [-30,-60]){ trashCan(42.6,z); bench(41.9,z+4,-HP); }
  // cart corral and a lone shopping cart
  
}

// ---------- JumboMart and the Big Lot (south-east) ----------
function bigLot(){
  lot(103,-6.5,143,-70.5); for(const x0 of [108,113,124,129]) parkingStalls(x0,-8,23,1,-2.6,5,'z');
  const g=G(93,-38,'+x'); const w=56,d=18,h=8;
  put(B(w,h,d),'tx:ribBlue',g,0,h/2,0); put(B(w+.1,1.2,d+.1),'tx:brickBlue',g,0,.6,0); put(B(w+.3,.3,d+.3),0xFFFFFF,g,0,h,0); put(B(w-.4,.04,d-.4),'tx:gravel',g,0,h+.17,0,{ns:true});
  put(B(18,3,.6,.06),0xFFFFFF,g,0,h+.8,d/2+.1); txt(['JUMBOMART'],16.5,2.4,'#FFFFFF','#2F6FD0',g,0,h+.8,d/2+.42);
  put(B(9,4.8,3,.08),0xFFC93C,g,0,2.4,d/2+1.5); const eg=new THREE.Mesh(new THREE.BoxGeometry(7,3,.03),glassMat); eg.position.set(0,1.6,d/2+3.02); g.add(eg); const ei=new THREE.Mesh(new THREE.PlaneGeometry(7,3),INT.mart); ei.position.set(0,1.6,d/2+3.0); g.add(ei); txt(['ENTER'],3,.6,'#2E2350','#FFE27A',g,0,3.7,d/2+3.03);
  for(const s of [-1,1]) for(let i=0;i<3;i++) windowPane(g,s*(9+i*5.5),2.0,d/2,4.2,2.0,0,400,{frame:0xFFFFFF,ft:.1,mullV:3,interior:INT.mart});
  txt(['EVERYDAY JUMBO PRICES!'],10,.7,'#FFC93C','#2E2350',g,-16,4.6,d/2+.02); txt(['GARDEN ·  PHARMACY ·  TIRES'],12,.7,'#26D3A0','#FFFFFF',g,16,4.6,d/2+.02);
  for(let i=0;i<4;i++) hvac(g,-20+i*13,h+.2,-3,1.2);
  const ld=grp(g,0,0,-d/2); for(const s of [-1,0,1]){ put(B(3.4,3.6,.15),0xD8DCE8,ld,s*6,1.8,-.05); put(B(4,.6,1.2),'tx:conc',ld,s*6,.3,-.6); }
  solid(g,0,h/2,0,w/2,h/2,d/2); bmeta(93,-38,d/2,w/2,0,'tx:ribBlue','tx:gravel','JumboMart'); slab(102,-12,103,-64,'tx:walk');
  // cart corrals, carts, lot lights, islands with trees, cars
  for(const [x,z] of [[121,-25],[137,-50]]){ const c=grp(city,x,0,z); for(const s of [-1,1]) put(B(6,1.0,.06),0xC8CDDD,c,0,.8,s*1.0); put(B(.06,1.0,2),0xC8CDDD,c,3,.8,0); txt(['CARTS'],1.5,.4,'#2F6FD0','#FFFFFF',c,-1,1.4,1.04); for(let k=0;k<4;k++) cartModel(x-2+k*1.0,z,0); staticBox(x,.6,z,3,.6,1.05); }
  for(const z of [-16,-34,-52]) for(const x of [121,137]) lightPole(x,z);
  for(const z of [-12,-26,-40,-54,-66]) T(142,z,.8);
  for(const x of [110.5,115.5,126.5,131.5]) for(let k=0;k<23;k++) if(((x*7+k*13)|0)%10<4) parked(x,-9.3-k*2.6,0);
  for(let i=0;i<6;i++) cartModel(pick([119,121,135,138]),-10-rnd()*56,rnd()*6);
  dumpster(80.6,-62,HP); dumpster(80.6,-14,HP,'tx:ribYel',0xD9A400);
  txt(['FIRE LANE'],5,.6,null,'#E8343F',city,100,.075,-38).rotation.set(-HP,0,HP);
  
}
function cartModel(x,z,ry){ const sc=grp(city,x,0,z,ry); const wire=0xC8CDDD; for(const s of [-1,1]){ put(B(.02,.5,.02),wire,sc,s*.28,.72,-.42); put(B(.02,.5,.02),wire,sc,s*.28,.72,.42); } for(let k=0;k<5;k++){ put(B(.56,.012,.012),wire,sc,0,.5+k*.1,-.42); put(B(.56,.012,.012),wire,sc,0,.5+k*.1,.42); put(B(.012,.012,.84),wire,sc,-.28,.5+k*.1,0); put(B(.012,.012,.84),wire,sc,.28,.5+k*.1,0); } put(B(.56,.02,.84),wire,sc,0,.47,0); tube([[-.3,1.02,-.48],[0,1.05,-.52],[.3,1.02,-.48]],.025,0xE8343F,sc,6); for(const s of [-1,1]) for(const t of [-1,1]){ put(B(.02,.38,.02),wire,sc,s*.24,.27,t*.36); put(CYL(.055,.055,.04,10),INK,sc,s*.24,.055,t*.36,{rz:HP}); } }

// ---------- rail yard, Bottle Depot and Fizzy Creek (east of Pine, south of the Skyway) ----------
let CAMP=[96,-158];
function railYard(){
  // two tracks running east-west at x=34 and x=38.5, ballast, ties, rails
  for(const tx of [34,38.5]){ put(B(3.2,.25,198),'tx:ballast',city,tx,.12,-181,{ns:true}); for(let z=-83;z>-280;z-=.8) put(B(2.6,.12,.26),'tx:tie',city,tx,.28,z,{ns:true}); for(const s of [-1,1]){ put(B(.12,.16,197),0x8E95AE,city,tx+s*.72,.42,-181.5); put(B(.06,.04,197),0xE8ECF6,city,tx+s*.72,.51,-181.5,{ns:true}); }
    const bs=grp(city,tx,0,-83.4); put(B(2.4,.9,.5),0xE8343F,bs,0,.75,0); for(const s of [-1,1]) put(B(.25,.25,1.6),0xE8343F,bs,s*.72,.6,-.6,{rx:.5}); put(B(1.6,.3,.06),0xFFFFFF,bs,0,.9,.26); staticBox(tx,.6,-83.4,1.2,.6,.3); }
  rect(META.lots,32.4,-83,40.1,-165,{kind:'dirt'});
  // boxcars and a tank car
  const cars2=[[34,-100,'tx:ribRed','PWR 1977'],[34,-114,'tx:ribTeal','FIZZY CO'],[34,-128,'tx:ribYel','SUNNY LINE'],[38.5,-120,'tx:ribBlue','ROUTE 9 RR'],[38.5,-134,'tx:ribRed','PWR 2041']];
  for(const [x,z,t,lab] of cars2){ const g=grp(city,x,0,z); put(B(3,3,12,.04),t,g,0,2.6,0); put(B(3.1,.15,12.1),0x4A4F66,g,0,4.15,0); put(B(2.6,.3,12),0x2E2350,g,0,1.0,0);
    for(const s of [-1,1]){ put(B(.06,2.5,3),0x8E95AE,g,s*1.53,2.5,0); txt([lab],2.6,.45,null,'#FFFFFF',g,s*1.54,3.4,-3.5,s*HP); for(const zz of [-4.4,4.4]){ const tr=grp(g,0,.5,zz); for(const w of [-.72,.72]) for(const ww of [-.7,.7]) put(CYL(.36,.36,.12,14),INK,tr,w,0,ww,{rz:HP}); put(B(1.7,.3,2),0x23272B,tr,0,.1,0); } }
    put(B(.3,.3,.4),0x23272B,g,0,1.0,6.2); put(B(.3,.3,.4),0x23272B,g,0,1.0,-6.2); for(let k=0;k<6;k++) put(B(.04,.04,.6),0xC8CDDD,g,1.0,1.6+k*.4,-6.05); staticBox(x,2.2,z,1.55,2.2,6.1); bmeta(x,z,1.5,6,0,t,0x4A4F66,'Boxcar'); }
  graffiti(34+1.6,2.8,-108,HP,['FIZZ','KID'],'#FF3D8B',2.2,1.1); graffiti(38.5-1.6,2.6,-126,-HP,['☺☺☺'],'#FFC93C',2,1);
  // Bottle Depot
  shop({x:52,z:-96,w:20,d:12,face:'+z',wall:'tx:ribGrey',base:'tx:conc',sign:'BOTTLE DEPOT',signHex:0x26D3A0,signBg:'#26D3A0',signFg:'#FFFFFF',interior:INT.mart,h:6,parapet:.5,doorAt:.2,name:'Bottle Depot',
    bays:[{t:'door',w:1.6},{t:'win',w:3},{t:'win',w:3}],
    extra:(g,{w,d,fz})=>{ const rd=grp(g,w/2-4,0,fz+.02); put(B(5,4.2,.12),0xD8DCE8,rd,0,2.1,0); for(let k=0;k<12;k++) put(B(4.9,.04,.04),0xB9BFD0,rd,0,.3+k*.33,.08); txt(['CASH FOR CANS','5¢ EVERY BOTTLE!'],6,1.2,'#FFC93C','#2E2350',g,-1,4.9,fz+.03);
      for(let k=0;k<4;k++){ const cg=grp(g,-w/2+2+k*2.6,0,fz+3.2); put(B(2.2,1.8,1.6),0x3FB8FF,cg,0,.9,0); put(B(2.3,.12,1.7),0x2F6FD0,cg,0,1.85,0); txt([['GLASS','CANS','PLASTIC','PAPER'][k]],1.6,.4,null,'#FFFFFF',cg,0,1.2,.81); } solid(g,0,.9,fz+3.2,5.5,.9,.8); } });
  for(let i=0;i<6;i++){ const bc=grp(city,44+i*1.5,0,-109.5); put(B(1.2,1.2,1.2),0xC8CDDD,bc,0,.6,0); for(let k=0;k<8;k++) put(new THREE.CapsuleGeometry(.05,.15,4,6),k%2?0x3FAE6A:0x8A5A2A,bc,(rnd()-.5)*.9,.2+rnd()*.8,(rnd()-.5)*.9,{rz:rnd()*3}); }
  dumpster(64.5,-93,HP); dumpster(64.5,-99,HP,'tx:ribRed',0xC4473F);
  for(let i=0;i<3;i++){ const pl=grp(city,46+i*1.4,0,-112.5); for(let k=0;k<4;k++) for(let j=0;j<5;j++) put(B(1.2,.03,.14),'tx:wood',pl,0,.14+k*.16,-.5+j*.25); }
  // Fizzy Creek: a winding stream with banks, reeds, rocks and a little footbridge
  const pts=[]; for(let i=0;i<=36;i++){ const t=i/36; pts.push(new THREE.Vector2(44+t*102, -150+Math.sin(t*6.5)*7+Math.sin(t*2.1)*4)); }
  const curve=new THREE.SplineCurve(pts); const sp=curve.getPoints(160);
  const left=[],right=[]; for(let i=0;i<sp.length;i++){ const a=sp[Math.max(0,i-1)], b=sp[Math.min(sp.length-1,i+1)]; const dx=b.x-a.x, dz=b.y-a.y, l=Math.hypot(dx,dz); const nx=-dz/l, nz=dx/l; left.push([sp[i].x+nx*3.2,sp[i].y+nz*3.2]); right.push([sp[i].x-nx*3.2,sp[i].y-nz*3.2]); }
  const strip=(L1,R1,y,key,ns)=>{ const pos=[]; for(let i=0;i<L1.length-1;i++){ const a=L1[i],b=L1[i+1],c=R1[i],d=R1[i+1]; const up=((c[1]-a[1])*(b[0]-a[0])-(c[0]-a[0])*(b[1]-a[1]))>0; if(up) pos.push(a[0],y,a[1], c[0],y,c[1], b[0],y,b[1], b[0],y,b[1], c[0],y,c[1], d[0],y,d[1]); else pos.push(a[0],y,a[1], b[0],y,b[1], c[0],y,c[1], b[0],y,b[1], d[0],y,d[1], c[0],y,c[1]); } const gg=new THREE.BufferGeometry(); gg.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); gg.computeVertexNormals(); const m=mesh(gg,key,city); m.castShadow=false; return m; };
  const off=(arr,k)=>arr.map((p,i)=>{ const s=sp[i]; const dx=p[0]-s.x, dz=p[1]-s.y; return [s.x+dx*k, s.y+dz*k]; });
  strip(left,right,.03,'tx:water'); strip(off(left,1.6),left,.05,'tx:dirtPath'); strip(right,off(right,1.6),.05,'tx:dirtPath');
  for(let i=4;i<sp.length-4;i+=5){ for(const side of [left,right]){ const p=side[i]; if(rnd()<.5) put(lumpy(.35+rnd()*.3,rnd()*50),0xA9A4C8,city,p[0],.05,p[1],{s:[1,.5,1]}); else { const rg=grp(city,p[0],0,p[1]); for(let k=0;k<6;k++) put(B(.05,.9+rnd()*.5,.05),0x5FA83A,rg,(rnd()-.5)*.6,.5,(rnd()-.5)*.6,{rz:(rnd()-.5)*.3}); burnReg('plant',rg,p[0],p[1],.6); } } }
  for(let i=0;i<sp.length;i+=10) rect(META.lots,sp[i].x-3.2,sp[i].y-3.2,sp[i].x+3.2,sp[i].y+3.2,{kind:'water'});
  // creek bodies: the water is shallow but you can't walk through the banks' rocks; keep it open
  const bi=48, bp=sp[bi]; const fb=grp(city,bp.x,0,bp.y,0); put(B(1.8,.12,9,.03),'tx:woodPale',fb,0,.75,0); for(const s of [-1,1]){ for(let k=0;k<5;k++) put(B(.08,.9,.08),'tx:wood',fb,s*.85,1.1,-4+k*2); put(B(.08,.08,9),'tx:wood',fb,s*.85,1.5,0); } for(let k=0;k<4;k++) put(B(.2,.8,.2),'tx:wood',fb,(k%2?.7:-.7),.4,k<2?-3:3);
  // a quiet camp by the creek
  const cp=sp[110]; CAMP=[cp.x+1.6,cp.y+9]; const tt=grp(city,cp.x,0,cp.y+7,.5); const tarp=new THREE.BufferGeometry(); tarp.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,-1.2, 0,1.2,-1.2, 0,1.2,1.2, -1,0,-1.2, 0,1.2,1.2, -1,0,1.2, 1,0,-1.2, 0,1.2,1.2, 0,1.2,-1.2, 1,0,-1.2, 1,0,1.2, 0,1.2,1.2],3)); tarp.computeVertexNormals(); mesh(tarp,0x8F6BFF,tt); solid(tt,0,.6,0,1,.6,1.2);
  for(const [x,z] of [[100,-140],[120,-160],[90,-162],[70,-160],[132,-150],[50,-158],[142,-162],[78,-140],[110,-138],[58,-141]]) T(x,z,1+rnd()*.3);
  for(let i=0;i<14;i++) Bu(46+rnd()*95,-141-rnd()*21,.7+rnd()*.5);
  industrial();
  rect(META.lots,40.5,-81.7,143,-165,{kind:'park'});
}

// ---------- Fizzy Co. bottling plant, water tower, scrapyard and container stacks (rail yard) ----------
function industrial(){
  // bottling plant on Pine, loading docks out back
  shop({x:95,z:-95,w:34,d:18,face:'+z',wall:'tx:ribTeal',base:'tx:conc',sign:'FIZZY CO. BOTTLING',signHex:0xFF6E9E,signBg:'#FF6E9E',signFg:'#FFFFFF',interior:INT.office,h:8,parapet:.6,doorAt:.15,name:'Fizzy Co. Bottling',
    bays:[{t:'door',w:1.6},{t:'win',w:4},{t:'win',w:4},{t:'wall',w:14},{t:'win',w:4},{t:'win',w:4},{t:'door',w:1.6}],
    extra:(g,{w,d,fz})=>{ txt(['EST. 1952','EVERY SIP A SUNNY DAY'],8,1.4,'#FFF6D0','#2E2350',g,0,6.4,fz+.03);
      // big fake bottle on the roof
      const bt=grp(g,w/2-4,8.6,0); put(CYL(1.2,1.2,3.4,16),0x5FE3B0,bt,0,1.7,0); put(CYL(.5,1.2,1.4,16),0x5FE3B0,bt,0,4.1,0); put(CYL(.45,.45,.9,16),0x5FE3B0,bt,0,5.2,0); put(CYL(.55,.55,.3,16),0xE8343F,bt,0,5.8,0); put(CYL(1.22,1.22,1.2,16),0xFFF6D0,bt,0,1.9,0); solid(g,w/2-4,10.5,0,1.2,2.5,1.2);
      // silos on the side
      for(const k of [0,1]){ const sx=-w/2-2.6, sz=-4+k*5.5; put(CYL(2.2,2.2,10,18),0xE8ECF6,g,sx,5.6,sz); put(new THREE.ConeGeometry(2.3,1.4,18),0xC8CDDD,g,sx,11.3,sz); put(CYL(.12,.12,11,6),0x8E95AE,g,sx+2.3,5.5,sz); solid(g,sx,5.6,sz,2.2,5.6,2.2); for(let r=0;r<5;r++) put(CYL(2.25,2.25,.08,18),0xB9BFD0,g,sx,1.6+r*2.1,sz); }
    } });
  bmeta(95,-95,17,9,0,'tx:ribTeal','tx:gravel','Fizzy Co. Bottling');
  // back lot: dock doors, dock bumpers, box trucks, pallets of crates
  slab(76,-104,114,-121,'tx:asphalt',.03); rect(META.lots,76,-104,114,-121,{kind:'lot'});
  for(let k=0;k<5;k++){ const dx=82+k*6.5; const dg=grp(city,dx,0,-104.06,Math.PI); put(B(3.4,3.6,.08),0xD8DCE8,dg,0,1.8+.3,0); for(let r=0;r<10;r++) put(B(3.3,.04,.05),0xB9BFD0,dg,0,.5+r*.36,.06); put(B(3.8,.2,.25),0xFFC93C,dg,0,4.05,.1); for(const sx of [-1.6,1.6]) put(B(.25,.6,.3),0x2E2350,dg,sx,1.2,.18); put(B(3.6,1.1,1.6),'tx:conc',dg,0,.55,.8); }
  staticBox(95,.55,-104.86,17,.55,.8);
  const truck=(x,z,ry,cab,label)=>{ const g=grp(city,x,0,z,ry); put(B(2.4,2.8,6.2,.06),'tx:ribGrey',g,0,2.4,-1); put(B(2.3,1.9,1.9,.2),cab,g,0,1.75,3.2); put(B(2.1,.9,.08),glassMat,g,0,2.15,4.16); put(B(2.4,.3,8.4),0x2E2350,g,0,.75,0);
    for(const zz of [-3,-1.8,3.2]) for(const s of [-1,1]) put(CYL(.48,.48,.32,14),INK,g,s*1.1,.48,zz,{rz:HP});
    if(label) for(const s of [-1,1]) txt([label],5,.9,null,'#FF6E9E',g,s*1.22,2.6,-1,s*HP);
    solid(g,0,1.6,0,1.25,1.6,4.3,'car'); bmeta(x,z,1.25,4.3,ry,cab,0xD8DCE8,'Box truck'); };
  truck(82,-111,0,0xFF6E9E,'FIZZY CO.'); truck(101.5,-112,0,0x3FB8FF,'FIZZY CO.');
  for(let i=0;i<4;i++){ const pg=grp(city,108+(i%2)*1.6,0,-108-(i>>1)*1.6); put(B(1.2,.14,1.2),'tx:wood',pg,0,.07,0); for(let k=0;k<6;k++) put(B(.55,.35,.38),k%2?0x5FE3B0:0xFF8A7A,pg,(k%2-.5)*.6,.33+(k>>1)*.36,0); }
  solid(grp(city,108.8,0,-108.8),0,.6,0,1.6,.6,1.6);
  dumpster(112.5,-116,HP); woodFence(76,-121.5,114,-121.5);
  // water tower
  const wt=grp(city,126,0,-96); for(const [lx,lz] of [[-2.4,-2.4],[2.4,-2.4],[2.4,2.4],[-2.4,2.4]]){ put(CYL(.18,.22,15,8),0xC8CDDD,wt,lx,7.5,lz); put(CYL(.5,.5,.5,8),'tx:conc',wt,lx,.25,lz); staticBox(126+lx,3,-96+lz,.25,3,.25); }
  for(const y of [4,9]) for(const s of [-1,1]){ put(B(4.8,.1,.1),0xB9BFD0,wt,0,y,s*2.4); put(B(.1,.1,4.8),0xB9BFD0,wt,s*2.4,y,0); }
  put(CYL(4,4,5,24),0x8FD3F4,wt,0,17.5,0); put(new THREE.ConeGeometry(4.3,2.2,24),0x3FB8FF,wt,0,21.1,0); put(new THREE.SphereGeometry(.3,10,8),0xFFFFFF,wt,0,22.3,0); put(CYL(4.25,4.25,.2,24),0xFFFFFF,wt,0,15.1,0);
  put(new THREE.TorusGeometry(4.3,.06,4,32),0xFFFFFF,wt,0,15.2,0,{rx:HP}); for(let k=0;k<16;k++){ const a=k/16*Math.PI*2; put(CYL(.03,.03,1,4),0xFFFFFF,wt,Math.cos(a)*4.3,15.7,Math.sin(a)*4.3); }
  for(const ry of [0,Math.PI]) txt(['PUDDLEWICK'],6.4,1.3,null,'#FFFFFF',grp(wt,0,0,0,ry),0,17.6,4.05);
  put(B(.5,15,.12),0x8E95AE,wt,0,7.5,2.5); graffiti(126,2.6,-93.5,0,['GRUB','4EVA'],'#FF3D8B',1.6,.8);
  // scrapyard behind a chain-link fence
  slab(116,-106,144,-134,'tx:gravel',.025); rect(META.lots,116,-106,144,-134,{kind:'dirt'});
  chainFence([[116,-112],[116,-106],[144,-106],[144,-134],[116,-134],[116,-118]],2.4);
  const crushed=(x,z,ry,n)=>{ for(let k=0;k<n;k++){ const c=pick(CARS); const cg=grp(city,x+(rnd()-.5)*.3,0,z+(rnd()-.5)*.3,ry+(rnd()-.5)*.2); put(B(1.9,.85,4,.08),c,cg,0,.43+k*.86,0); put(B(1.6,.12,2.4),0x6C74C4,cg,0,.9+k*.86,.1); for(const s of [-1,1]) put(B(.05,.3,1.4),glassMat,cg,s*.96,.6+k*.86,.3); }
    solid(grp(city,x,0,z,ry),0,n*.43,0,1,n*.43,2.05); bmeta(x,z,1,2.05,ry,0x8E95AE,0x6C74C4,'Scrap'); };
  crushed(120,-110,0,3); crushed(123,-110,0,2); crushed(126,-110.5,.1,3); crushed(120,-130,HP,2); crushed(127,-130,HP,3);
  const tires=(x,z,n)=>{ for(let k=0;k<n;k++) put(new THREE.TorusGeometry(.36,.15,6,14),0x2B2B33,city,x+(rnd()-.5)*.15,.15+k*.28,z+(rnd()-.5)*.15,{rx:HP}); solid(grp(city,x,0,z),0,n*.14,0,.5,n*.14,.5); };
  for(const [x,z,n] of [[134,-110,5],[135.2,-111,3],[134.5,-112.3,6],[140,-128,4],[141,-130,6],[139,-130.2,2]]) tires(x,z,n);
  for(let i=0;i<10;i++) put(new THREE.TorusGeometry(.36,.15,6,14),0x2B2B33,city,130+rnd()*10,.15,-118-rnd()*8,{rx:HP+(rnd()-.5)*.6,ry:rnd()*3});
  // the crane that does the crushing
  const cr=grp(city,133,0,-121,.6); put(B(3,1.6,4.4),0xFFC93C,cr,0,1.2,0); put(B(2.2,1.6,1.8),0xFFC93C,cr,0,2.8,1); put(B(2,.9,.06),glassMat,cr,0,3,1.92); for(const s of [-1,1]) put(B(.6,.8,5),0x2E2350,cr,s*1.5,.4,0);
  const arm=grp(cr,0,3.2,-1,0); put(B(.5,.5,8),0xFFC93C,arm,0,2.1,-3.4,{rx:.55}); put(B(.4,.4,5),0xFFC93C,arm,0,3.4,-8.6,{rx:-.7}); put(CYL(.03,.03,3,4),0x2E2350,arm,0,2.2,-9.2); put(new THREE.TorusGeometry(.6,.1,6,12,Math.PI),0x8E95AE,arm,0,.6,-9.2,{rz:Math.PI});
  solid(cr,0,1.6,0,1.6,1.6,2.5); bmeta(133,-121,1.6,2.5,.6,0xFFC93C,0xFFC93C,'Crane');
  shop({x:139,z:-120,w:5,d:8,face:'-x',wall:'tx:sidWhite',sign:'SCRAP OFFICE',signHex:0xFFC93C,signBg:'#FFC93C',signFg:'#2E2350',interior:INT.office,h:2.8,parapet:.2,name:'Scrap office',bays:[{t:'win',w:1.6},{t:'door',w:1.2},{t:'win',w:1.4}]});
  txt(['WE BUY','COPPER $$$'],3,1.2,'#FFFFFF','#E8343F',city,116.06,1.6,-109,-HP);
  // container stacks by the tracks
  slab(44,-114,74,-136,'tx:gravel',.025); rect(META.lots,44,-114,74,-136,{kind:'dirt'});
  const cont=(x,z,y,ry,tex,lab)=>{ const g=grp(city,x,y,z,ry); put(B(2.44,2.6,6.1,.05),tex,g,0,1.3,0); for(const s of [-1,1]) put(B(2.3,2.4,.06),0x4A4F66,g,0,1.3,s*3.06); for(let k=0;k<4;k++) put(B(.05,2.3,.05),0xC8CDDD,g,-.6+k*.4,1.3,3.1); if(lab) for(const s of [-1,1]) txt([lab],3.6,.7,null,'#FFFFFF',g,s*1.23,1.9,0,s*HP); };
  const CT=['tx:ribRed','tx:ribBlue','tx:ribYel','tx:ribTeal','tx:ribMint','tx:ribGrey'], LB=['SUNNY LINE','PWR','FIZZY CO.','JUMBO','','MAERSKY'];
  for(const [x,z,n,ry] of [[48,-119,3,0],[51,-119,2,0],[54,-119,1,0],[48,-130,2,0],[51,-130,3,0],[62,-118,2,HP],[62,-126,1,HP],[69,-126,2,HP],[64,-133,1,HP+.1]]){ for(let k=0;k<n;k++){ const i=((x*7+z*3+k)|0)%6; cont(x,z,k*2.6,ry,CT[(i+6)%6],LB[(i+6)%6]); } solid(grp(city,x,0,z,ry),0,n*1.3,0,1.22,n*1.3,3.05); bmeta(x,z,1.22,3.05,ry,CT[0],0x4A4F66,'Container'); }
  graffiti(49.25,1.6,-119,HP,['SIDE','QUEST'],'#FFC93C',2.2,1.1); graffiti(52.25,1.4,-130,HP,['☺'],'#26D3A0',1.2,1);
  // cable spools you can hide behind
  for(const [x,z,r] of [[58,-131,1.1],[60.5,-131.5,.8],[70,-117,1.3]]){ const sg=grp(city,x,0,z,rnd()*3); for(const s of [-1,1]) put(CYL(r,r,.12,18),'tx:woodPale',sg,0,r,s*.55,{rx:HP}); put(CYL(r*.55,r*.55,1.1,14),0x3E8FD8,sg,0,r,0,{rx:HP}); solid(sg,0,r,0,r*.8,r,.65); }
  for(const [x,z] of [[78,-88],[112,-88]]) lightPole(x,z,0);
  for(const [x,z] of [[118,-104.5],[142,-104.5],[46,-112.5],[72,-112.5]]) lightPole(x,z,Math.PI);
}

// ---------- Puddle Park (north-west, west of Creek Rd) ----------
function puddlePark(){
  const x0=-88, x1=12, z0=78, z1=163;
  rect(META.lots,x0,z0,x1,z1,{kind:'park'});
  // pond with a soft shoreline, lily pads, ducks and a little island
  const shape=new THREE.Shape(); const pc=[-46,118]; for(let i=0;i<=40;i++){ const a=i/40*Math.PI*2; const r=16+Math.sin(a*3)*3+Math.cos(a*5)*1.5; const px=Math.cos(a)*r*1.25, pz=Math.sin(a)*r; if(i) shape.lineTo(px,pz); else shape.moveTo(px,pz); }
  const pg=new THREE.ShapeGeometry(shape,24); pg.rotateX(-HP); const pm=put(pg,'tx:water',city,pc[0],.04,pc[1],{ns:true});
  const sg=new THREE.ShapeGeometry(shape,24); sg.rotateX(-HP); put(sg,'tx:dirtPath',city,pc[0],.025,pc[1],{s:[1.1,1,1.12],ns:true});
  for(let i=0;i<14;i++){ const a=rnd()*6.28, r=rnd()*11; put(CYL(.4,.4,.02,12),0x3FAE4A,city,pc[0]+Math.cos(a)*r*1.2,.06,pc[1]+Math.sin(a)*r,{ns:true}); }
  const ducks=[]; for(let i=0;i<6;i++){ const a=i*1.1, r=5+i; const dg=grp(city,pc[0]+Math.cos(a)*r,0,pc[1]+Math.sin(a)*r*.8,a); put(new THREE.SphereGeometry(.22,12,8),0xFFE14D,dg,0,.12,0,{s:[1.3,.8,1]}); put(new THREE.SphereGeometry(.13,10,8),0xFFE14D,dg,.22,.3,0); put(new THREE.ConeGeometry(.05,.12,6),0xFF9F1C,dg,.36,.29,0,{rz:-HP}); }
  const isl=put(lumpy(3,7),'tx:grass',city,pc[0]+6,-1.1,pc[1]-2,{s:[1.4,.6,1]}); T(pc[0]+6,pc[1]-2,.9);
  // sit-out deck over the pond
  const dk=grp(city,pc[0]-4,0,pc[1]+15,0); put(B(4,.15,6),'tx:woodPale',dk,0,.4,-2); for(const s of [-1,1]) for(let k=0;k<4;k++) put(B(.12,1.1,.12),'tx:wood',dk,s*1.9,.55,-4.8+k*1.8); for(const s of [-1,1]) put(B(.1,.1,6),'tx:wood',dk,s*1.9,1.05,-2);
  // gazebo
  const gz=grp(city,-70,0,145); put(new THREE.CylinderGeometry(4,4.2,.4,6),'tx:conc',gz,0,.2,0); for(let k=0;k<6;k++){ const a=k/6*Math.PI*2+Math.PI/6; put(CYL(.15,.15,3,10),0xFFFFFF,gz,Math.cos(a)*3.6,1.9,Math.sin(a)*3.6); if(k) put(B(3.6,.9,.08),0xFFFFFF,gz,Math.cos(a+Math.PI/6)*3.2,.85,Math.sin(a+Math.PI/6)*3.2,{ry:-(a+Math.PI/6)+HP}); }
  put(new THREE.ConeGeometry(4.8,2.2,6),'tx:shGum',gz,0,4.5,0); put(new THREE.CylinderGeometry(4.6,4.6,.25,6),0xFFFFFF,gz,0,3.45,0); put(new THREE.SphereGeometry(.25,10,8),0xFFD84A,gz,0,5.7,0); postBody(-70,145,1,3.4);
  // playground, picnic tables, restroom, benches, lamps, paths
  playground(-24,150,0);
  for(const [x,z,r] of [[-74,96,.2],[-66,100,-.4],[-80,108,1.1],[-14,96,.4]]){ const pt=grp(city,x,0,z,r); put(B(2.2,.08,.9),'tx:woodPale',pt,0,.78,0); for(const s of [-1,1]){ put(B(2.2,.06,.3),'tx:woodPale',pt,0,.45,s*.75); put(B(.08,.8,1.8),'tx:wood',pt,s*.85,.4,0,{rx:0}); } solid(pt,0,.4,0,1.1,.4,.9); }
  shop({x:-10,z:128,w:6,d:5,face:'+x',wall:'tx:brickTan',sign:'RESTROOMS',signBg:'#3FB8FF',signFg:'#FFFFFF',signHex:0x3FB8FF,interior:INT.dark,h:3.2,parapet:.4,bays:[{t:'door',w:1.4},{t:'win',w:1.6},{t:'door',w:1.4}],name:'Restrooms'});
  // winding gravel paths
  const path=(pts,w=2.2)=>{ const c=new THREE.CatmullRomCurve3(pts.map(([x,z])=>new THREE.Vector3(x,0,z))); const P2=c.getPoints(pts.length*12); for(let i=0;i<P2.length-1;i++){ const a=P2[i],b=P2[i+1]; const l=a.distanceTo(b); put(B(w,.04,l+.3),'tx:dirtPath',city,(a.x+b.x)/2,.02,(a.z+b.z)/2,{ry:Math.atan2(b.x-a.x,b.z-a.z),ns:true}); } return P2; };
  const p1=path([[-6.3,82],[-20,92],[-30,99],[-46,98],[-62,103],[-74,118],[-72,138],[-70,141]]);
  const p2=path([[-6.3,120],[-18,118],[-26,128],[-30,140],[-28,150]]);
  const p3=path([[-46,98],[-50,90],[-60,86],[-86,84]]);
  const p4=path([[-72,138],[-60,140],[-46,138],[-32,141]]);
  for(const [x,z,r] of [[-28,96,.4],[-56,101,-.3],[-74,124,HP],[-50,140,Math.PI],[-20,121,1.4]]) bench(x,z,r,0xC77DFF);
  for(const [x,z] of [[-24,94],[-52,102],[-71,130],[-36,141],[-14,117]]){ const lp=grp(city,x,0,z); put(CYL(.07,.09,3.6,10),0x2E2350,lp,0,1.8,0); put(new THREE.SphereGeometry(.28,14,10),0xFFF6D0,lp,0,3.75,0); put(CYL(.2,.12,.15,10),0x2E2350,lp,0,3.5,0); postBody(x,z,.09,3.6); trashCan(x+1,z+.6,0x2FAE6A); }
  // trees: a ring of big trees and a small grove
  const tz=[[-84,82],[-84,96],[-84,112],[-84,128],[-84,144],[-84,160],[-70,162],[-54,162],[-38,162],[-12,162],[-4,148],[-4,108],[-60,84],[-36,84],[-20,104],[-30,112],[-62,122],[-58,134],[-40,150],[-14,138],[-66,92],[-78,152],[-48,156],[-6,92]];
  tz.filter(([x,z])=>((x+46)/24)**2+((z-118)/20)**2>1.15).forEach(([x,z],i)=>T(x,z,.95+((i*17)%5)*.08,i%3?'tx:leafA':'tx:leafB'));
  for(let i=0;i<16;i++){ const bx=-84+rnd()*80, bz=82+rnd()*78, bs=.8+rnd()*.5; if(((bx+46)/24)**2+((bz-118)/20)**2>1.15) Bu(bx,bz,bs); }
  for(const [x,z,w,d] of [[-12,84,6,1.6],[-46,96,3,3],[-70,149,4,1.4]]) flowerBed(x,z,w,d);
  // park sign at Creek Rd and a low hedge along the street
  const ps=grp(city,-40,0,78.6,0); put(B(4.4,.7,.5),'tx:brickYel',ps,0,.35,0); put(B(4.2,1.1,.25),0x2E2350,ps,0,1.3,0); txt(['PUDDLE PARK'],3.9,.8,'#2E2350','#FFE27A',ps,0,1.3,-.13,Math.PI); staticBox(-40,.7,78.6,2.2,.7,.25);
  for(const [a,b] of [[-86,-46],[-34,-8]]) hedge((a+b)/2,79.2,b-a,0,.9);
  // a sleeping spot under a tree
  const sbag=grp(city,-64,0,110,.5); put(B(.7,.18,1.9,.08),0x5A4C80,sbag,0,.09,0); put(B(.5,.15,.4,.06),0xEDE4D6,sbag,0,.17,.75);
}

// ---------- props, piles, fire barrels and extra people ----------
function hangouts(){
  trashPile(-33,22.6); trashPile(-43.5,-21); trashPile(7.5,62.6); trashPile(28.5,-25); trashPile(81,-56);
  trashPile(61.5,-104); trashPile(-28,-118); trashPile(19.2,-9.2); trashPile(-12,140.5); trashPile(118,-130);
  fireCan(21.4,-19.5,0,true); fireCan(66,-100.5,0x8FA3C8,false);
}
function props(){
  let n=13;
  const crate=(x,z,s,hex,y=.36)=>PROPS.push({ id:'o:crate'+(n++), type:'crate', p:[x,y*(s/.7),z], s, hex });
  const cone=(x,z)=>PROPS.push({ id:'o:cone'+(n++), type:'cone', p:[x,.38,z] });
  crate(-37.5,22.2,.7,P.sunny); crate(-38.4,22.2,.7,P.gum); crate(-46,-22.5,.7,P.sky);
  crate(25.3,-11.2,.7,P.sunny); crate(25.3,-12.1,.7,P.mint); crate(25.3,-11.65,.7,P.gum,1.06);
  crate(45,-111.2,.7,P.sunny); crate(46,-111.2,.7,P.sky); crate(-36,-112,.6,P.gum);
  for(const [x,z] of [[-2,-47.6],[0,-47.6],[2.2,-47.6],[14,-47.6],[15.5,-47.4],[-5.6,-57],[10,-46.5],[70,-3.8],[73.5,3.8],[-12,-3.8]]) cone(x,z);
  crate(9,64,.7,P.sunny); crate(29,-30,.7,P.gum);
}
// Townsfolk are server-driven NPCs now (GAME-85/93, npcs.json); the town only says where its camp is.
function extraPeople(){}

// ---------- zones (turf), spawn points, traffic routes (for town.json) ----------
const ZONES=[
  {id:'puddle_park',name:'Puddle Park',x:-92,z:78,w:106,d:87},
  {id:'downtown_w',name:'Downtown West',x:-92,z:6,w:74,d:60},
  {id:'downtown_e',name:'Downtown East',x:-92,z:-70,w:74,d:64},
  {id:'school',name:'Sunnyside School',x:-92,z:-158,w:106,d:76},
  {id:'dumpster_alley',name:'Dumpster Alley',x:-6,z:6,w:23,d:60},
  {id:'corner_store',name:'Sunny Mart',x:-6,z:-70,w:23,d:64},
  {id:'underpass',name:'The Underpass',x:16,z:-40,w:12,d:80},
  {id:'maple_row',name:'Maple Row',x:28,z:6,w:118,d:159},
  {id:'strip_mall',name:'Sunny Plaza',x:28,z:-70,w:38,d:64},
  {id:'big_lot',name:'The Big Lot',x:78,z:-70,w:68,d:64},
  {id:'rail_yard',name:'Rail Yard',x:28,z:-158,w:118,d:76},
];
const BOUNDS={minX:-92,maxX:146,minZ:-158,maxZ:165};
function trafficSpec(){
  // Routes are polylines on road centrelines; the server drives the right-hand lane.
  const N=-200, S=200;
  const routes=[
    {id:'main_s',  pts:[[N,0],[S,0]]},           {id:'main_n',  pts:[[S,0],[N,0]]},
    {id:'creek_s', pts:[[N,72],[S,72]]},         {id:'creek_n', pts:[[S,72],[N,72]]},
    {id:'pine_s',  pts:[[N,-76],[S,-76]]},       {id:'pine_n',  pts:[[S,-76],[N,-76]]},
    {id:'elm_e',   pts:[[N,72],[-12,72],[-12,-76],[S,-76]]},
    {id:'elm_w',   pts:[[S,-76],[-12,-76],[-12,72],[N,72]]},
    {id:'oak_e',   pts:[[72,S],[72,-76],[S,-76]]},
    {id:'oak_w',   pts:[[S,-76],[72,-76],[72,S]]},
    {id:'elm_main',pts:[[N,0],[-12,0],[-12,72],[S,72]]},
    {id:'oak_main',pts:[[S,0],[72,0],[72,-76],[N,-76]]},
    {id:'sky_e',   pts:[[22,S],[22,-S]], y:7.2, noStop:true}, {id:'sky_w', pts:[[22,-S],[22,S]], y:7.2, noStop:true},
  ];
  const intersections=IX.filter(ix=>ix.control!=='yield').map(ix=>({id:ix.id,x:ix.x,z:ix.z,hx:5.5,hz:5.5,control:ix.control,...(ix.control==='light'?{cycle:{green:12,yellow:3}}:{})}));
  return { note:'Routes follow road centrelines (GAME-81); cars keep to the right-hand lane, 1.75 m off centre. Lights cycle per axis.', cars:22, laneOffset:1.75, routes, intersections, lanes:[] };
}

// ---------- per-frame: shadows follow the player, signal lamps follow the server ----------
const sun0=new THREE.Vector3().copy(sunLight.position);
// Debug / screenshot camera: window.__townCam([x,y,z],[tx,ty,tz]) flies the camera; __townCam() hands it back.
let camOv=null, far0=0;
let fog0=null; window.__townCam=(p,t,clear)=>{ if(!far0){ far0=camera.far; fog0=[scene.fog.near,scene.fog.far]; } camOv=p?{p,t,clear}:null; cullT=0; camera.far=p?1200:far0; camera.updateProjectionMatrix(); scene.fog.near=p&&clear?900:fog0[0]; scene.fog.far=p&&clear?2000:fog0[1]; vm.visible=!p; };
function cam(){ if(camOv){ camera.position.set(...camOv.p); camera.lookAt(...camOv.t); } }
// Distance culling for small static detail (signs, window interiors, glass, street clutter, trees):
// they move to an unused layer when far away, so .visible stays the game's to use.
let DET=null, cullT=0; const CULL_LAYER=1<<6;
function buildCull(){
  DET=[]; city.updateMatrixWorld(true); const sp=new THREE.Sphere(), burn=new Set(); for(const t of BURN) t.g.traverse(o=>burn.add(o));
  for(const t of BURN) t.g.updateMatrixWorld(true);
  const visit=o=>{ if(!(o.isMesh||o.isSprite)) return; const isTree=burn.has(o);
    if(o.isMesh){ if(!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); sp.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld); } else { sp.center.setFromMatrixPosition(o.matrixWorld); sp.radius=1; }
    const r=sp.radius; const chunk=o.userData.baked && !isTree;
    if(r>9 && !chunk) return; if(chunk && r>70) return;
    if(!chunk && !isTree && r<.8 && o.castShadow) o.castShadow=false;   // street clutter: no shadow-pass draw
    const d=chunk?300+r:isTree?120:r<1.2?60:r<4?80:150; DET.push({o,x:sp.center.x,z:sp.center.z,r2:d*d,off:false,m:0,chunk}); };
  city.traverse(visit); for(const t of BURN) if(!t.g.userData.nobake) t.g.traverse(visit);
}
function cull(dt){
  if(!DET || (cullT-=dt)>0) return; cullT=.25; const cx=camera.position.x, cz=camera.position.z, all=camOv&&camOv.clear;
  const q=typeof SET!=='undefined'&&SET.opt?SET.opt('quality'):'high', k2=q==='low'?.4:q==='medium'?.65:1;   // Graphics quality pulls detail in closer
  for(const d of DET){ const off=!all && (d.x-cx)**2+(d.z-cz)**2>d.r2*(d.chunk?1:k2); if(off===d.off) continue; d.off=off;
    if(off){ d.m=d.o.layers.mask; d.o.layers.mask=CULL_LAYER; } else d.o.layers.mask=d.m; }
}
const _fw=new THREE.Vector3();
function frame(dt){
  cull(dt||0);
  // Centre the shadow box a little ahead of the camera (not the player body: spectating, capture
  // shots and the debug camera all look from somewhere else).
  camera.getWorldDirection(_fw); const ah=camOv?0:Math.min(20,Math.hypot(_fw.x,_fw.z)*20);
  const fl=Math.hypot(_fw.x,_fw.z)||1, px=camOv?camOv.t[0]:camera.position.x+_fw.x/fl*ah, pz=camOv?camOv.t[2]:camera.position.z+_fw.z/fl*ah, snap=1.0;
  const cx=Math.round(px/snap)*snap, cz=Math.round(pz/snap)*snap;
  sunLight.position.set(cx+sun0.x, sun0.y, cz+sun0.z); sunLight.target.position.set(cx,0,cz); sunLight.target.updateMatrixWorld();
}
function lights(phases){
  for(const s of SIGNALS){ const ph=phases&&phases[s.ix]; const st=ph?ph[s.axis]:null;
    for(const c of ['red','yellow','green']) s.lamps[c].color.setHex(lampMats[c][st===c?1:0]); }
}

// ================= hills (GAME-96) =================
// The town is built on flat ground, then set onto TERRAIN (terrain.mjs, shared with the server):
//  - the grass becomes a height-mapped grid (fine where it isn't flat, coarse far out);
//  - flat or long things (roads, sidewalks, paint, lots, paths, curbs, fences, hedges, walls, wires)
//    are draped: tessellated where the ground curves, then every vertex is lifted by H(x,z);
//  - everything else (buildings, trees, lamps, benches, cars, signs) moves up as one piece; buildings
//    sit level at the highest corner of their footprint on a concrete footing, like real houses on a hill;
//  - static colliders follow (long ones are cut into short pieces that step with the slope), so the
//    town.json extract and the client's own prediction both see the hills.
const _tb=new THREE.Box3(), _tv=new THREE.Vector3();
function terrainFlat(box,pad=.3){ const [,hi]=TERRAIN.range((box.min.x+box.max.x)/2,(box.min.z+box.max.z)/2,(box.max.x-box.min.x)/2+pad,(box.max.z-box.min.z)/2+pad); return hi<.004; }
// Edge-consistent refinement: an edge is split only by a test on its own two end points, so the two
// triangles sharing it always split it the same way and the draped surface has no cracks.
function edgeNeedsSplit(ax,az,bx,bz){
  const L=Math.hypot(bx-ax,bz-az); if(L<1.1) return false;
  if(ax>bx||(ax===bx&&az>bz)){ let t=ax; ax=bx; bx=t; t=az; az=bz; bz=t; }
  const ha=TERRAIN.h(ax,az), hb=TERRAIN.h(bx,bz), n=Math.max(2,Math.ceil(L/6));
  for(let i=1;i<n;i++){ const t=i/n, y=TERRAIN.h(ax+(bx-ax)*t,az+(bz-az)*t); if(Math.abs(y-(ha+(hb-ha)*t))>.012) return true; }
  return false;
}
function refineGeo(g){
  const names=Object.keys(g.attributes), sizes=names.map(k=>g.attributes[k].itemSize), arrs=names.map(k=>g.attributes[k].array);
  const stride=sizes.reduce((a,b)=>a+b,0), out=[], cnt=g.attributes.position.count, pIdx=names.indexOf('position');
  let pOff=0; for(let i=0;i<pIdx;i++) pOff+=sizes[i];
  const vert=i=>{ const v=new Float32Array(stride); let o=0; names.forEach((k,a)=>{ for(let c=0;c<sizes[a];c++) v[o++]=arrs[a][i*sizes[a]+c]; }); return v; };
  const mid=(a,b)=>{ const v=new Float32Array(stride); for(let i=0;i<stride;i++) v[i]=(a[i]+b[i])/2; return v; };
  const need=(a,b)=>edgeNeedsSplit(a[pOff],a[pOff+2],b[pOff],b[pOff+2]);
  let budget=400000;
  const tri=(A,B,C,d)=>{
    const s0=d<22&&budget>0&&need(A,B), s1=d<22&&budget>0&&need(B,C), s2=d<22&&budget>0&&need(C,A), n=s0+s1+s2;
    if(!n){ out.push(A,B,C); budget--; return; }
    if(n===3){ const ab=mid(A,B), bc=mid(B,C), ca=mid(C,A); tri(A,ab,ca,d+1); tri(ab,B,bc,d+1); tri(ca,bc,C,d+1); tri(ab,bc,ca,d+1); return; }
    // rotate so the split edges come first: one split edge = AB; two = AB and BC
    if(n===1){ if(s1) return tri(B,C,A,d); if(s2) return tri(C,A,B,d); const ab=mid(A,B); tri(A,ab,C,d+1); tri(ab,B,C,d+1); return; }
    if(!s0) return tri(B,C,A,d); if(!s1) return tri(C,A,B,d);
    const ab=mid(A,B), bc=mid(B,C); tri(ab,B,bc,d+1); tri(A,ab,bc,d+1); tri(A,bc,C,d+1);
  };
  for(let i=0;i<cnt;i+=3) tri(vert(i),vert(i+1),vert(i+2),0);
  const ng=new THREE.BufferGeometry(); let o=0;
  names.forEach((k,a)=>{ const n=sizes[a], arr=new Float32Array(out.length*n); out.forEach((v,j)=>{ for(let c=0;c<n;c++) arr[j*n+c]=v[o+c]; }); o+=n; ng.setAttribute(k,new THREE.BufferAttribute(arr,n)); });
  return ng;
}
// Lift every vertex of a mesh by the ground under it, in place (keeps its parent, material, burn group).
function drapeMesh(m){
  m.updateMatrixWorld(true); const M=m.matrixWorld, inv=new THREE.Matrix4().copy(M).invert();
  let g=m.geometry.index?m.geometry.toNonIndexed():m.geometry.clone(); g.applyMatrix4(M);
  for(const k of Object.keys(g.attributes)) if(g.attributes[k].isInterleavedBufferAttribute) g.setAttribute(k,g.attributes[k].clone());
  g=refineGeo(g);
  const p=g.attributes.position, nr=g.attributes.normal;
  for(let i=0;i<p.count;i++){ const x=p.getX(i), z=p.getZ(i); p.setY(i,p.getY(i)+TERRAIN.h(x,z));
    if(nr){ const ny=nr.getY(i); if(Math.abs(ny)>.6){ const n=TERRAIN.normal(x,z), s=Math.sign(ny); nr.setXYZ(i,n[0]*s,n[1]*s,n[2]*s); } } }
  g.applyMatrix4(inv); if(nr) g.normalizeNormals?.();
  g.computeBoundingBox(); g.computeBoundingSphere(); m.geometry=g;
}
function drapeNode(n){ n.traverse(o=>{ if(o.isMesh) drapeMesh(o); }); }
// Concrete footing under a building that sits level on a slope.
function footing(node,lo,hi){
  const fb=new THREE.Box3(); let any=false; node.updateMatrixWorld(true);
  node.traverse(o=>{ if(!o.isMesh) return; _tb.setFromObject(o); if(_tb.min.y-node.position.y<.3 && _tb.max.y-_tb.min.y>.8 && _tb.max.x-_tb.min.x<40 && _tb.max.z-_tb.min.z<40){ fb.union(_tb); any=true; } });
  if(!any) return; const w=fb.max.x-fb.min.x-.04, d=fb.max.z-fb.min.z-.04, y0=lo-.35, y1=hi+.04;
  const f=put(B(w,y1-y0,d),'tx:conc',city,(fb.min.x+fb.max.x)/2,(y0+y1)/2,(fb.min.z+fb.max.z)/2,{ns:true}); f.userData.terrainDone=true;
}
function placeNode(n){
  if(n.userData.terrainDone || n.isLight || n.isCamera) return;
  n.updateMatrixWorld(true); _tb.setFromObject(n); if(_tb.isEmpty()) return;
  const L=Math.max(_tb.max.x-_tb.min.x,_tb.max.z-_tb.min.z), W=Math.min(_tb.max.x-_tb.min.x,_tb.max.z-_tb.min.z), hgt=_tb.max.y-_tb.min.y;
  if(L>460 && n!==GROUND) return;                     // sky, distant scenery
  if(terrainFlat(_tb)) return;
  const cx=(_tb.min.x+_tb.max.x)/2, cz=(_tb.min.z+_tb.max.z)/2;
  if(n.userData.terrain==='split'){ for(const c of [...n.children]) placeNode(c); return; }
  if(n.userData.terrain==='drape'){ drapeNode(n); return; }
  if(_tb.min.y>3.2) return;                           // up on the Skyway: its piers carry it
  // Skyway piers and the like: tall and narrow under the deck. Stretch so the foot meets the ground and the top stays put.
  if(_tb.max.y>5.2 && _tb.min.y<.5 && L<4 && cx>14 && cx<30){ const top=_tb.max.y; n.traverse(o=>{ if(!o.isMesh) return; o.updateMatrixWorld(true); const M=o.matrixWorld, inv=new THREE.Matrix4().copy(M).invert(); let g=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone(); g.applyMatrix4(M); const p=g.attributes.position; for(let i=0;i<p.count;i++){ const y=p.getY(i); p.setY(i,y+TERRAIN.h(p.getX(i),p.getZ(i))*Math.max(0,1-y/top)); } g.applyMatrix4(inv); g.computeBoundingBox(); g.computeBoundingSphere(); o.geometry=g; }); return; }
  let glass=false; n.traverse(o=>{ if(o.material===glassMat) glass=true; });
  const flatish=hgt<.6 && _tb.min.y<.45, longLow=L>4 && hgt<2.7 && !glass && _tb.min.y<1.2;
  if(n===GROUND || flatish&&L>1.2 || longLow){ drapeNode(n); return; }
  // One rigid piece.
  if(L<2.6){ n.position.y+=TERRAIN.h(cx,cz); return; }
  const [lo,hi]=TERRAIN.range(cx,cz,(_tb.max.x-_tb.min.x)/2,(_tb.max.z-_tb.min.z)/2);
  const building=glass || (W>2.8 && hgt>2.2 && !n.userData.nobake);
  if(building){ n.position.y+=hi; if(hi-lo>.06) footing(n,lo,hi); }
  else n.position.y+=lo+(hi-lo)*.4;
}
// Colliders: lift with the ground; long ones are cut into pieces so they follow the slope.
function placeBodies(){
  const add=[], kill=[];
  for(const b of world.bodies){
    if(b.mass>0 || b===groundBody || b.twTerrain || !b.shapes.length) continue;
    const s=b.shapes[0]; let hx,hz;
    if(s instanceof CANNON.Box){ const q=b.quaternion, yaw=2*Math.atan2(q.y,q.w), c=Math.abs(Math.cos(yaw)), sn=Math.abs(Math.sin(yaw)); hx=s.halfExtents.x*c+s.halfExtents.z*sn; hz=s.halfExtents.x*sn+s.halfExtents.z*c; }
    else if(s instanceof CANNON.Cylinder || s instanceof CANNON.Sphere){ hx=hz=s.radiusTop||s.radius||.3; } else continue;
    const x=b.position.x, z=b.position.z;
    if(b.position.y-(s.halfExtents?s.halfExtents.y:(s.height||0)/2)>3.2) continue;   // on the Skyway
    const [lo,hi]=TERRAIN.range(x,z,hx,hz); if(hi<.004) continue;
    const q=b.quaternion, axisAligned=Math.abs(q.x)<1e-4&&Math.abs(q.z)<1e-4&&(Math.abs(q.y)<1e-4||Math.abs(Math.abs(q.y)-Math.SQRT1_2)<1e-3||Math.abs(q.w)<1e-4);
    if(s instanceof CANNON.Box && Math.max(hx,hz)>3 && hi-lo>.25 && !b.tw && !b.twTag && axisAligned){
      // a long wall / hedge / fence: pieces of <= 3 m, each sitting on its own stretch of ground
      const alongX=hx>=hz, len=alongX?hx:hz, n=Math.ceil(len/1.5), hy=s.halfExtents.y, y0=b.position.y-hy;
      for(let i=0;i<n;i++){ const c=-len+len*(2*i+1)/n, px=alongX?x+c:x, pz=alongX?z:z+c, phx=alongX?len/n:hx, phz=alongX?hz:len/n;
        const [l2,h2]=TERRAIN.range(px,pz,phx,phz), top=y0+2*hy+h2, bot=y0+l2-.2;
        const nb=new CANNON.Body({mass:0,shape:new CANNON.Box(new CANNON.Vec3(phx,(top-bot)/2,phz))}); nb.position.set(px,(top+bot)/2,pz); nb.twTerrain=true; add.push(nb); }
      kill.push(b); continue;
    }
    if(Math.max(hx,hz)>1.25 && s instanceof CANNON.Box && hi-lo>.03){
      // sits level at its highest corner and reaches down to the lowest, like the footing drawn under it
      const hy=s.halfExtents.y, top=b.position.y+hy+hi, bot=b.position.y-hy+lo;
      b.removeShape(s); b.addShape(new CANNON.Box(new CANNON.Vec3(s.halfExtents.x,(top-bot)/2,s.halfExtents.z))); b.position.y=(top+bot)/2;
    } else b.position.y+=TERRAIN.h(x,z);
    b.aabbNeedsUpdate=true; b.twTerrain=true;
  }
  for(const b of kill) world.removeBody(b); for(const b of add) world.addBody(b);
  // The client's own walking (prediction) uses cannon: give it the same hills as the server's heightfield.
  const A=TERRAIN.AREA, data=[]; for(let i=0;i<=A.maxX-A.minX;i++){ const row=[]; for(let j=0;j<=A.maxZ-A.minZ;j++) row.push(TERRAIN.h(A.minX+i,A.maxZ-j)); data.push(row); }
  const hb=new CANNON.Body({mass:0,shape:new CANNON.Heightfield(data,{elementSize:1})}); hb.quaternion.setFromEuler(-Math.PI/2,0,0); hb.position.set(A.minX,0,A.maxZ); hb.twTerrain=true; hb.twEdge=true; world.addBody(hb); TERRAIN_BODY=hb;
}
let GROUND=null, TERRAIN_BODY=null;
// The look test's 800 m grass slab becomes a grid: 1.5 m cells over the hills, 20 m cells far out.
function groundGrid(){
  GROUND=city.children.find(o=>o.isMesh && o.userData.c==='tx:grass' && o.geometry.parameters && o.geometry.parameters.width>=800);
  if(!GROUND) return; const A=TERRAIN.AREA;
  const axis=(lo,hi)=>{ const v=[]; for(let x=-400;x<lo;x+=20) v.push(x); for(let x=lo;x<hi;x+=1.5) v.push(x); for(let x=hi;x<=400;x+=20) v.push(x); if(v[v.length-1]<400) v.push(400); return v; };
  const xs=axis(A.minX,A.maxX), zs=axis(A.minZ,A.maxZ), nx=xs.length, nz=zs.length, pos=new Float32Array(nx*nz*3), nrm=new Float32Array(nx*nz*3), idx=[];
  for(let j=0;j<nz;j++) for(let i=0;i<nx;i++){ const k=(j*nx+i)*3, x=xs[i], z=zs[j], n=TERRAIN.normal(x,z); pos[k]=x; pos[k+1]=TERRAIN.h(x,z); pos[k+2]=z; nrm[k]=n[0]; nrm[k+1]=n[1]; nrm[k+2]=n[2]; }
  for(let j=0;j<nz-1;j++) for(let i=0;i<nx-1;i++){ const a=j*nx+i, b=a+1, c=a+nx, d=c+1; idx.push(a,c,b, b,c,d); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('normal',new THREE.BufferAttribute(nrm,3)); g.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(nx*nz*2),2)); g.setIndex(idx);
  GROUND.geometry=g; GROUND.position.set(0,0,0); GROUND.userData.terrainDone=true;
}
function terrain(){
  groundGrid();
  // Burn targets, trash piles and lamps keep their own records of where they stand.
  for(const node of [...city.children, ...burnGroup.children, ...scene.children.filter(o=>o!==city && o!==burnGroup && (o.isMesh||o.isGroup))]) placeNode(node);
  for(const p of piles){ const y=TERRAIN.h(p.pos.x,p.pos.z); if(y>.004){ if(p.g.parent===scene && Math.abs(p.g.position.y)<1e-6) p.g.position.y=y; p.pos.y+=y; } }
  for(const l of LAMPS) l.p[1]=+TERRAIN.h(l.p[0],l.p[2]).toFixed(3);
  placeBodies();
}

function build(){
  textures(); makeChainMat(); intersections(); roads(); streetFurniture();
  downtown(); dumpsterAlley(); gasStation(); construction(); schoolCampus(); underpass(); suburbs(); stripMall(); bigLot(); railYard(); puddlePark();
  hangouts(); props();
  // look-test pieces in the map metadata
  bmeta(3,-10,5,4,0,'tx:stuccoPink','tx:gravel','Sunny Mart'); rect(META.lots,8.5,-6,17.5,-15,{kind:'lot'});
  rect(META.lots,17.5,-5,26.5,21,{kind:'dirt'});
  // trees placed by the look test before the town: register them too
  sc.left=-48; sc.right=48; sc.top=48; sc.bottom=-48; sc.far=170; sunLight.shadow.camera.updateProjectionMatrix();
  terrain();
}
function afterPeople(){ extraPeople(); buildCull(); }

// Everything the server needs, read straight from what the client just built.
function dump(){
  const LOOK_TAGS=[[23.4,.5,10.5,'couch'],[-8.2,1.45,-4.3,'stop_sign'],[9.6,.85,-7.6,'dumpster'],[13.3,.8,-11.6,'car'],[-24,.8,3.1,'car']];
  const r3=v=>+(+v).toFixed(3);
  const colliders=[], windows=[];
  for(const b of world.bodies){
    if(b.mass>0 || b.twEdge || b===groundBody || !b.shapes.length) continue;
    const s=b.shapes[0], p=[r3(b.position.x),r3(b.position.y),r3(b.position.z)];
    const q=b.quaternion; const hasQ=Math.abs(q.y)>1e-4||Math.abs(q.x)>1e-4||Math.abs(q.z)>1e-4;
    if(b.tw && b.tw.type==='glass'){ const gi=glassPanes.indexOf(b.tw); windows.push({ id:'w:'+windows.length, gi, p, q:[r3(q.x),r3(q.y),r3(q.z),r3(q.w)], half:[r3(s.halfExtents.x),r3(s.halfExtents.y),r3(s.halfExtents.z)], value:b.tw.value }); continue; }
    const c={ p };
    if(s instanceof CANNON.Box) c.box=[r3(s.halfExtents.x),r3(s.halfExtents.y),r3(s.halfExtents.z)];
    else if(s instanceof CANNON.Cylinder) c.cyl=[r3(s.radiusTop),r3(s.height)];
    else continue;
    if(hasQ) c.q=[r3(q.x),r3(q.y),r3(q.z),r3(q.w)];
    let tag=b.twTag||null;
    if(b.tw && b.tw.type==='person') tag='npc';
    if(!tag){ const lt=LOOK_TAGS.find(t=>Math.abs(t[0]-p[0])<.01&&Math.abs(t[1]-p[1])<.01&&Math.abs(t[2]-p[2])<.01); if(lt) tag=lt[3]; }
    if(!tag && c.cyl && Math.abs(c.cyl[0]-.42)<.001 && Math.abs(c.cyl[1]-1)<.001) tag='fire_can';
    if(!tag && c.box && Math.abs(c.box[0]-.7)<.001 && Math.abs(c.box[1]-.35)<.001){ const pi=piles.findIndex(pl=>Math.abs(pl.pos.x-p[0])<.01&&Math.abs(pl.pos.z-p[2])<.01); if(pi>=0){ tag='pile'; c.pile=pi; } }
    if(tag==='signal') tag=null;
    if(tag) c.tag=tag;
    colliders.push(c);
  }
  return {
    bounds:BOUNDS, zones:ZONES, colliders, windows,
    piles:piles.map((p,i)=>({id:'pile:'+i,i,x:r3(p.pos.x),z:r3(p.pos.z)})),
    npcs:people.map(p=>({x:r3(p.g.position.x),z:r3(p.g.position.z),ry:r3(p.g.rotation.y)})),
    newProps:PROPS, traffic:trafficSpec(),
    camp:CAMP, burnables:BURN.map(b=>({id:b.id,type:b.type,p:[r3(b.x),r3(TERRAIN.h(b.x,b.z)),r3(b.z)],s:r3(b.s)})), lampposts:LAMPS,
    roads:META.roads, walks:META.walks, lots:META.lots, buildings:META.buildings, decks:META.decks,
  };
}
window.__townDump=dump;
return { build, frame, cam, lights, afterPeople, dump, BOUNDS, ZONES, IX, SIGNALS };
})();
