// ---------- sky dome, painted clouds (GAME-89) ----------
// The look test's clouds were six clumps of lit spheres parked ~150 m away and drifting off
// for good, fogged grey, peeking over rooftops like eggs. Here the clouds are painted into
// the sky dome itself: cel-shaded cumulus (white tops, lilac undersides, ink rim) on a sky
// plane, so they shrink toward the horizon with real perspective, drift forever and never
// run out. The dome and the sun follow the camera, so the sky holds up anywhere on the map.
// One shader, compiled with the scene at load: no meshes, lights or runtime variants added.
const SUN_OFFSET = new THREE.Vector3(-150, 120, -330);
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), new THREE.ShaderMaterial({
  side:THREE.BackSide, depthWrite:false, fog:false,
  uniforms:{
    top:{value:new THREE.Color(P.aero)}, mid:{value:new THREE.Color(P.sky)}, bot:{value:new THREE.Color(P.horizon)},
    cLit:{value:new THREE.Color(0xFFFFFF)}, cMid:{value:new THREE.Color(0xE3E9FF)}, cShade:{value:new THREE.Color(0xAFB6EC)},
    cInk:{value:new THREE.Color(P.ink)}, sunDir:{value:SUN_OFFSET.clone().normalize()}, time:{value:0}
  },
  vertexShader:`varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader:`
  uniform vec3 top,mid,bot,cLit,cMid,cShade,cInk,sunDir; uniform float time; varying vec3 vP;
  vec2 h2(vec2 p){ p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }
  float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(h2(i).x,h2(i+vec2(1,0)).x,f.x), mix(h2(i+vec2(0,1)).x,h2(i+vec2(1,1)).x,f.x), f.y); }
  // round puffs: inverted cellular noise gives the scalloped cartoon-cumulus edge
  float puffs(vec2 p){ vec2 i=floor(p), f=fract(p); float d=1.;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec2 g=vec2(x,y); vec2 o=.5+.4*sin(6.2831*h2(i+g)); d=min(d,length(g+o-f)); }
    return 1.-d; }
  float field(vec2 p){
    float m = smoothstep(.25,.8, vnoise(p*.3) * .65 + vnoise(p*.8+7.3) * .35);   // where clouds gather (leaves clear sky between)
    float b = puffs(p*1.6) * .55 + puffs(p*3.4+3.1) * .3 + vnoise(p*6.) * .15;
    return m * .7 + b * .45 * (.35+.65*m);
  }
  void main(){
    float h=vP.y;
    vec3 c = h<0.08? bot : (h<0.35? mix(bot,mid,(h-0.08)/0.27) : mix(mid,top,clamp((h-0.35)/0.5,0.,1.)));
    if(h>0.015){
      vec2 uv = vP.xz/(h+.12)*1.7 + vec2(time*.012, time*.004);
      float d = field(uv), th = .57;
      float w = max(fwidth(d), 1e-4);
      float cover = smoothstep(th-w, th+w, d);
      if(cover>0.){
        // seen from the street, a cloud's top edge is its far side on the sky plane: tops stay
        // white, undersides (near side) and thick cores take the lilac shade, a bit more away from the sun
        vec2 r = normalize(vP.xz+1e-4), s2 = normalize(sunDir.xz+1e-4);
        float under = d - field(uv - r*.28);
        float away = .5 - .5*dot(r, s2);
        float core = smoothstep(th+.06, th+.24, d)*.5 + clamp(under*5., 0., 1.)*.8 + away*.15;
        vec3 cc = core>.62 ? cShade : (core>.3 ? cMid : cLit);
        cc = mix(cc, c, smoothstep(.35,.0,h)*.55);                  // atmospheric haze low in the sky
        float ink = 1.-smoothstep(1.4,2.6, (d-th)/w);                // even-width rim, in pixels
        cc = mix(cc, cInk, ink*.8*smoothstep(.04,.2,h));
        float fade = smoothstep(.015,.11,h);                         // melt into the horizon band
        c = mix(c, cc, cover*fade);
      }
    }
    gl_FragColor=vec4(c,1.);
  }`
})); fxl(skyDome); scene.add(skyDome);
