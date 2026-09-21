import * as THREE from 'three';

// One renderer is moved between the chart and hangar. Stats updates must not leak contexts.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeColor = value => /^#[\da-f]{6}$/i.test(value || '') ? value : '#cce3e7';
const iconPaths = {
  queue:'M4 5h5l3 7-3 7H4l3-7Zm16 0h-5l-3 7 3 7h5l-3-7Z',
  expedition:'M12 2 20 18 12 14 4 18ZM12 14v7M3 5h3M18 5h3',
  seasonview:'M5 5h14v14H5ZM9 2v6m6-6v6M8 12h3v4H8m6-4h2v4h-2',
  tournaments:'M3 4h5v5H3Zm0 11h5v5H3ZM8 6.5h4v11H8m4-5.5h5m0-3h4v6h-4Z',
  result:'M7 3h10v7l-5 5-5-5ZM4 5H2v5l5 3m13-8h2v5l-5 3m-5 2v6m-5 0h10',
  profile:'M12 2 21 7v10l-9 5-9-5V7ZM12 7l4 5-4 5-4-5ZM12 2v5m9 10-5-3M3 17l5-3',
  quests:'M5 3h14v18H5Zm4 5 2 2 4-4M9 15h6m-6 3h4',
  scenarios:'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  ranks:'M3 19 12 3l9 16-9-4ZM7 22l5-3 5 3',
  consistency:'M3 17h18M3 11l4-4 4 7 5-11 5 8M7 21h10',
  admin:'M3 6h18M3 18h18M7 3v6m10 6v6M3 12h18m-9-3v6',
  band:'M12 2 21 12 12 22 3 12ZM8 12h8m-4-4v8',
  season:'M3 19l2-6L16 2l6 6-11 11Zm2-6 6 6M3 22h19',
};
let artSerial = 0;
const silhouettes = [
  'M50 5 60 41 88 70 84 81 61 69 50 91 39 69 16 81 12 70 40 41Z',
  'M50 4 62 37 84 21 93 78 72 85 59 65 50 91 41 65 28 85 7 78 16 21 38 37Z',
  'M50 7 63 31 92 57 78 78 58 63 50 90 42 63 22 78 8 57 37 31Z',
  'M50 4 62 37 71 14 88 37 95 84 67 70 50 92 33 70 5 84 12 37 29 14 38 37Z',
  'M50 4 68 33 91 45 82 59 69 61 78 90 50 76 22 90 31 61 18 59 9 45 32 33Z',
  'M50 5 57 30 75 26 90 48 77 82 62 71 50 93 38 71 23 82 10 48 25 26 43 30Z',
  'M50 2 62 31 95 18 86 58 93 88 62 75 50 97 38 75 7 88 14 58 5 18 38 31Z',
];
function art(kind, design = 0, color) {
  const c = safeColor(color), n = ((design % 7) + 7) % 7, id = `cx-${++artSerial}`;
  const defs = `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f1f0e5"/><stop offset=".42" stop-color="${c}"/><stop offset=".44" stop-color="#557180"/><stop offset="1" stop-color="#14202d"/></linearGradient><linearGradient id="${id}-core" x2="0" y2="1"><stop stop-color="#f8f7e4"/><stop offset="1" stop-color="${c}" stop-opacity=".2"/></linearGradient></defs>`;
  let shape;
  if (kind === 'ship') {
    const outline = design < 0 ? 'M50 9 63 46 76 79 55 68 50 88 45 68 24 79 37 46Z' : silhouettes[n];
    shape = `<path d="${outline}" fill="url(#${id})" stroke="#d3e5e8" stroke-opacity=".6" stroke-width=".7"/><path d="M50 12 56 45 52 65 48 65 44 45Z" fill="#091822" stroke="${c}" stroke-width="1"/><path d="M49 20 51 20 53 43 47 43Z" fill="url(#${id}-core)"/><path d="M27 65 40 55M73 65 60 55M35 73 40 63M65 73 60 63" stroke="#dfede8" stroke-width="1.2"/><path d="M43 78 46 97 49 79M51 79 54 97 57 78" fill="url(#${id}-core)"/><path d="M50 66v17" stroke="${c}" stroke-width="1.3"/>`;
  } else if (kind === 'frame') {
    shape = `<path d="M25 9H75L91 25V75L75 91H25L9 75V25ZM29 17H71L83 29V71L71 83H29L17 71V29Z" fill="url(#${id})" fill-rule="evenodd"/><path d="M10 34V25L25 10H35M65 10H75L90 25V35M90 65V75L75 90H65M35 90H25L10 75V65" fill="none" stroke="${c}" stroke-width="2"/><path d="M50 31 63 58 50 52 37 58Z" fill="${c}"/>`;
  } else if (kind === 'banner') {
    shape = `<path d="M14 12H86V91L50 76 14 91Z" fill="url(#${id})"/><path d="M24 12v61l26-11 26 11V12" fill="#0b1723"/><path d="M50 22 67 53 50 46 33 53Z" fill="${c}"/><path d="M20 82 50 69 80 82" fill="none" stroke="${c}"/>`;
  } else if (kind === 'title' || kind === 'insignia') {
    shape = `<path d="M50 8 83 24V60L50 88 17 60V24Z" fill="url(#${id})"/><path d="M50 17 75 29V57L50 78 25 57V29Z" fill="#0b1723" stroke="${c}" stroke-width="1"/><path d="M50 26 66 57 50 50 34 57Z" fill="${c}"/>${Array.from({length:n % 4 + 1},(_,i)=>`<path d="M${39+i*6} 66h3" stroke="#eff2de" stroke-width="2"/>`).join('')}`;
  } else if (kind === 'relic') {
    const forms=["<path d=\"M49 6 72 31 63 82 42 96 22 62 30 23Z\" fill=\"url(#ID)\" stroke=\"COLOR\"/><path d=\"M49 6 45 48 63 82M30 23 45 48 22 62M45 48 72 31M45 48 42 96\" fill=\"none\" stroke=\"#f0f5e4\" stroke-opacity=\".6\"/><path d=\"M48 28 55 44 47 68 40 50Z\" fill=\"#112936\"/>","<path d=\"M50 7 86 68 50 91 14 68Z\" fill=\"url(#ID)\" stroke=\"COLOR\"/><path d=\"M50 7v84M14 68l36-20 36 20\" fill=\"none\" stroke=\"#f0f5e4\" stroke-opacity=\".7\"/><path d=\"M50 28 66 62 50 73 34 62Z\" fill=\"#102431\" stroke=\"COLOR\"/><path d=\"M24 20 16 34M76 20l8 14\" stroke=\"COLOR\" stroke-width=\"2\"/>","<ellipse cx=\"50\" cy=\"51\" rx=\"36\" ry=\"23\" fill=\"none\" stroke=\"url(#ID)\" stroke-width=\"7\" transform=\"rotate(-35 50 51)\"/><path d=\"M50 14 69 35 69 66 50 87 31 66 31 35Z\" fill=\"url(#ID)\" stroke=\"COLOR\"/><path d=\"M50 27 59 43 50 70 41 43Z\" fill=\"#102431\"/><circle cx=\"50\" cy=\"45\" r=\"5\" fill=\"COLOR\"/><path d=\"M50 5V1M50 100v-7\" stroke=\"COLOR\"/>","<path d=\"M50 9 81 23 91 54 72 84 36 91 10 62 18 29Z\" fill=\"url(#ID)\"/><circle cx=\"50\" cy=\"51\" r=\"25\" fill=\"#102431\" stroke=\"COLOR\" stroke-width=\"2\"/><path d=\"M50 32 66 59 34 59ZM50 19v7M19 51h7M74 51h7M50 76v7\" fill=\"none\" stroke=\"COLOR\" stroke-width=\"2\"/>"];
    const variant=design>=18&&design<=23?3:design%3;
    shape=forms[variant].replaceAll('ID',id).replaceAll('COLOR',c);
  } else {
    shape = `<path d="M50 8 78 29 85 62 50 85 15 62 22 29Z" fill="url(#${id})" stroke="${c}" stroke-width=".7"/><path d="M50 8v77M22 29l28 14 28-14M15 62l35-19 35 19M50 43 37 70M50 43 63 70" fill="none" stroke="#f0f5e4" stroke-opacity=".45"/><path d="M50 24 62 43 50 62 38 43Z" fill="#0c1b29"/><circle cx="50" cy="43" r="${5+n%4}" fill="${c}"/>${kind === 'trophy' ? `<path d="M35 84 29 95H71L65 84Z" fill="url(#${id})"/>` : ''}`;
  }
  return `<svg class="exp-art" viewBox="0 0 100 104" aria-hidden="true">${defs}${shape}</svg>`;
}

const vertex = `varying vec3 vN; varying vec3 vP; void main(){vN=normalize(normalMatrix*normal);vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const fragment = `precision highp float; varying vec3 vN; varying vec3 vP; uniform vec3 color; uniform float style; uniform float time;
float h(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z);}
void main(){vec3 p=vP*3.;float n=noise(p)*.6+noise(p*3.)*.27+noise(p*9.)*.13;float bands=sin(vP.y*30.+n*12.)*.5+.5;float fissure=pow(1.-abs(sin(n*18.+vP.y*3.)),12.);vec3 base=mix(color*.13,color*.8,n);if(style<.5)base=mix(vec3(.12,.22,.26),color,n*n);else if(style<1.5)base=mix(vec3(.12,.065,.06),color,pow(n,3.))+color*fissure*.6;else if(style<2.5)base=mix(vec3(.02,.12,.15),color*.72,bands*.55+n*.4);else if(style<3.5)base=mix(color*.12,color,bands*n);else if(style<4.5)base=mix(vec3(.15,.14,.09),color,n);else base=mix(vec3(.12,.04,.08),color,n*.6+bands*.2);vec3 normal=normalize(vN);float light=max(dot(normal,normalize(vec3(-.6,.8,1.))),0.);float rim=pow(1.-max(normal.z,0.),3.);float spec=pow(max(dot(reflect(normalize(vec3(.6,-.8,-1.)),normal),vec3(0,0,1)),0.),32.);vec3 col=base*(.2+light*1.2)+color*rim*.6+vec3(.7,.83,.85)*spec*.3;gl_FragColor=vec4(col,1.);}`;

function material(color, metalness=.65, roughness=.35) { return new THREE.MeshStandardMaterial({color,metalness,roughness}); }
function mesh(geo,mat,parent,pos) { const m=new THREE.Mesh(geo,mat); if(pos)m.position.set(...pos);parent.add(m);return m; }
function shipModel(design, tint) {
  const group=new THREE.Group(), n=Math.max(0,design)%7;
  const hull=material('#dce3df',.72,.28), dark=material('#192734',.85,.24), accent=new THREE.MeshStandardMaterial({color:tint,emissive:tint,emissiveIntensity:.6,metalness:.5,roughness:.25});
  const shape=new THREE.Shape();
  if(design>=0){const points=silhouettes[n].match(/-?\d+(?:\.\d+)?/g).map(Number);for(let i=0;i<points.length;i+=2){const x=(points[i]-50)/43,y=(55-points[i+1])/43;i===0?shape.moveTo(x,y):shape.lineTo(x,y);}}
  else{shape.moveTo(0,1.05);shape.lineTo(.2,-.15);shape.lineTo(.13,-.7);shape.lineTo(0,-.54);shape.lineTo(-.13,-.7);shape.lineTo(-.2,-.15);}
  shape.closePath();
  mesh(new THREE.ExtrudeGeometry(shape,{depth:.13,bevelEnabled:true,bevelThickness:.035,bevelSize:.025,bevelSegments:1,steps:1}),hull,group);
  if(design>=0){
    const points=silhouettes[n].match(/-?\d+(?:\.\d+)?/g).map(Number), alloys=['#b8cdd2','#688592','#e6e5d8','#91adb8'].map(c=>material(c,.48,.38));
    for(let i=0;i<points.length;i+=2){const j=(i+2)%points.length, geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([0,.04,.23,(points[i]-50)/43*.94,(55-points[i+1])/43*.94,.174,(points[j]-50)/43*.94,(55-points[j+1])/43*.94,.174],3));geo.setIndex([0,2,1]);geo.computeVertexNormals();mesh(geo,alloys[(i/2)%alloys.length],group);}
  }
  const width=.55+n*.055, wing=new THREE.Shape();wing.moveTo(.1,.15);wing.lineTo(width,-.45+n*.025);wing.lineTo(width*.9,-.7);wing.lineTo(.12,-.42);wing.closePath();
  if(design<0){const wingGeo=new THREE.ExtrudeGeometry(wing,{depth:.07,bevelEnabled:false});mesh(wingGeo,hull,group,[0,0,.015]);const other=mesh(wingGeo,hull,group,[0,0,.015]);other.scale.x=-1;}
  for(const side of [-1,1]){const plate=mesh(new THREE.BoxGeometry(.19,.39,.018),dark,group,[side*.38,-.27,.17]);plate.rotation.z=side*-.48;const seam=mesh(new THREE.BoxGeometry(.016,.38,.022),accent,group,[side*.27,-.25,.183]);seam.rotation.z=side*-.48;}
  mesh(new THREE.OctahedronGeometry(.15,0),dark,group,[0,.35,.29]).scale.set(.65,2.4,.7);
  for(const x of [-width*.57,width*.57]) {
    mesh(new THREE.BoxGeometry(.09,.42,.11),dark,group,[x,-.45,.08]);
    mesh(new THREE.ConeGeometry(.05,.38,10),accent,group,[x,-.83,.07]).rotation.z=Math.PI;
    mesh(new THREE.BoxGeometry(.035,.29,.02),accent,group,[x,-.37,.145]);
  }
  if(n===1||n===3||n===6) for(const x of [-width,width]) mesh(new THREE.BoxGeometry(.065,.72,.14),hull,group,[x,-.12,0]);
  if(n===4||n===6) {const ring=mesh(new THREE.TorusGeometry(.46,.018,6,50),accent,group,[0,-.23,-.12]);ring.scale.y=.72;}
  group.userData.design=design; return group;
}
function world(index,color) {
  const group=new THREE.Group(), uniforms={color:{value:new THREE.Color(color)},style:{value:index},time:{value:0}};
  const surface=new THREE.ShaderMaterial({vertexShader:vertex,fragmentShader:fragment,uniforms});
  const sphere=mesh(index===4?new THREE.IcosahedronGeometry(.68,0):new THREE.SphereGeometry(.61,40,28),surface,group);
  const pale=material(index===1?'#b99d88':'#d0e2e1',.7,.3), edge=new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.33,metalness:.6,roughness:.3});
  const torus=(r,t=.015,rx=.6,ry=.3,arc=Math.PI*2)=>{const m=mesh(new THREE.TorusGeometry(r,t,7,90,arc),pale,group);m.rotation.set(rx,ry,0);return m;};
  if(index===0) {torus(.85,.025,1.2,.4,Math.PI*1.7);torus(.98,.012,-.7,.9,Math.PI*1.4);for(let j=0;j<5;j++){const a=j*1.256;const crystal=mesh(new THREE.OctahedronGeometry(.12,0),edge,group,[Math.cos(a)*.76,Math.sin(a)*.76,.1]);crystal.scale.y=2.2;}}
  if(index===1) {for(let j=0;j<18;j++){const a=j*.349;const shard=mesh(new THREE.DodecahedronGeometry(.07+(j%3)*.035,0),pale,group,[Math.cos(a)*.88,Math.sin(a)*.55,Math.sin(a)*.4]);shard.rotation.set(j,j*.2,0);}torus(.71,.017,.85,.2);}
  if(index===2) {torus(.82,.03,1.1,.3);torus(1.04,.015,1.1,.3);sphere.scale.y=.88;}
  if(index===3) {for(let j=0;j<3;j++)torus(.82+j*.12,.025,j*.7,.5,Math.PI*1.35);for(let j=0;j<5;j++){const m=mesh(new THREE.OctahedronGeometry(.12,0),edge,group,[Math.sin(j*1.3)*.7,Math.cos(j*1.3)*.7,.3]);m.scale.y=2;}}
  if(index===4) {sphere.scale.set(.65,1.2,.65);const outline=new THREE.LineSegments(new THREE.EdgesGeometry(sphere.geometry),new THREE.LineBasicMaterial({color:'#efe6b5',transparent:true,opacity:.8}));outline.scale.copy(sphere.scale);group.add(outline);torus(.98,.018,.45,-.7,Math.PI*1.75);}
  if(index===5) {torus(.83,.065,1.25,.2);torus(.97,.012,1.25,.2);mesh(new THREE.SphereGeometry(.16,16,12),pale,group,[.82,.52,.3]);}
  group.userData={surface,sphere,index};return group;
}

let renderer, scene, camera, systems, vessel, hangar, hangarShip, canvas, host, context, lastSelected, currentRoot;
let raf=0,lastTime=0,travel=null,paused=false,failed=false,needsFrame=true,shipDesign=null,shipColor=null,frames=0;
let pointer={x:0,y:0}, targetPointer={x:0,y:0}, zoom=1, compact=false;
const planets=[], positions=[], geometries=new Set(), materials=new Set();
const raycaster=new THREE.Raycaster();
const v=new THREE.Vector3();
const parking=document.createDocumentFragment();
let seen;try {seen=new Set(JSON.parse(localStorage.getItem('apogee.cosmic.arrivals')||'[]'));}catch {seen=new Set();}
function visited(id){seen.add(id);try{localStorage.setItem('apogee.cosmic.arrivals',JSON.stringify([...seen]));}catch{}}
function init(){
  if(renderer||failed)return;
  try {
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setClearColor(0x080e17,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
    canvas=renderer.domElement;canvas.className='cosmic-canvas';canvas.setAttribute('aria-hidden','true');
    scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(43,1,.1,80);camera.position.set(0,0,12);
    scene.add(new THREE.HemisphereLight('#dff6ff','#16132a',2));const key=new THREE.DirectionalLight('#fff3dd',3.2);key.position.set(-3,5,7);scene.add(key);const fill=new THREE.DirectionalLight('#689abc',1.8);fill.position.set(5,-2,3);scene.add(fill);
    systems=new THREE.Group();scene.add(systems);
    const colors=['#8de8ff','#ffab79','#86efc4','#c0a3ff','#f1e386','#ff8dbb'];
    colors.forEach((color,i)=>{const p=world(i,color);planets.push(p);positions.push(new THREE.Vector3());systems.add(p);});
    const stars=new Float32Array(900);let seed=923;
    const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};
    for(let i=0;i<300;i++){stars[i*3]=(random()-.5)*25;stars[i*3+1]=(random()-.5)*19;stars[i*3+2]=-3-random()*9;}
    const starGeo=new THREE.BufferGeometry();starGeo.setAttribute('position',new THREE.BufferAttribute(stars,3));scene.add(new THREE.Points(starGeo,new THREE.PointsMaterial({color:'#abc5dc',size:.017,transparent:true,opacity:.65})));
    for(let i=0;i<3;i++){const ring=mesh(new THREE.TorusGeometry(3+i*1.6,.003,3,160),new THREE.MeshBasicMaterial({color:'#537287',transparent:true,opacity:.16}),systems);ring.rotation.x=1.0;ring.position.z=-1.5;}
    hangar=new THREE.Group();hangar.visible=false;scene.add(hangar);
    const base=mesh(new THREE.TorusGeometry(1.75,.015,6,100),material('#7394a8'),hangar,[0,-.35,-.6]);base.scale.y=.43;
    canvas.addEventListener('pointermove',e=>{const b=canvas.getBoundingClientRect();targetPointer={x:(e.clientX-b.left)/b.width*2-1,y:-(e.clientY-b.top)/b.height*2+1};if(reduced.matches)targetPointer={x:0,y:0};});
    canvas.addEventListener('pointerleave',()=>{targetPointer={x:0,y:0};});
    canvas.addEventListener('click',e=>{if(!context||context.page!=='map'||travel)return;const b=canvas.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1),camera);const hits=raycaster.intersectObjects(planets,true);if(!hits.length)return;let p=hits[0].object;while(p.parent!==systems&&p.parent)p=p.parent;const i=planets.indexOf(p);if(i>=0)currentRoot?.querySelector(`.exp-planet[data-destination="${context.view.definition.destinations[i].id}"]`)?.click();});
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();failed=true;stop();travel=null;host?.classList.remove('cosmic-ready');host?.querySelectorAll('.exp-planet').forEach(b=>{b.style.removeProperty('left');b.style.removeProperty('top');});host?.querySelector('.cosmic-travel')?.classList.remove('active');canvas.hidden=true;});
    canvas.addEventListener('webglcontextrestored',()=>{failed=false;canvas.hidden=false;if(currentRoot?.isConnected&&context)mount(currentRoot,context);});
  }catch(err){failed=true;console.warn('3D chart unavailable; destination controls remain available.',err.message);}
}
function resize(){
  if(!renderer||!host||!host.isConnected)return;
  const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
  renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();compact=w<480;
  const layout=compact?[[-1.15,2.6,0],[1.15,2.6,-.4],[-1.15,.1,.4],[1.15,.1,-.2],[-1.15,-2.4,0],[1.15,-2.4,.2]]:[[-3.3,1.9,0],[0,2.1,-.7],[3.3,1.7,0],[-3.2,-1.7,.3],[0,-1.65,.6],[3.3,-1.8,-.2]];
  layout.forEach((p,i)=>{positions[i].set(...p);planets[i].position.copy(positions[i]);planets[i].scale.setScalar(compact?.68:1);});
  needsFrame=true;draw(performance.now());wake();
}
const resizeObserver=new ResizeObserver(resize);
function stop(){cancelAnimationFrame(raf);raf=0;}
function canAnimate(){return !failed&&!paused&&!reduced.matches&&!document.hidden&&document.hasFocus()&&host?.isConnected&&!!host.closest('.screen.active');}
function wake(){if(!renderer||failed)return;if(!canAnimate()){stop();if(needsFrame)draw(performance.now());return;}if(!raf)raf=requestAnimationFrame(tick);}
function tick(now){raf=0;if(!canAnimate())return;if(now-lastTime>=1000/35){lastTime=now;draw(now);}raf=requestAnimationFrame(tick);}
function hideTravel(){const overlay=host?.querySelector('.cosmic-travel');if(overlay?.contains(document.activeElement))host.querySelector('.exp-planet.selected')?.focus({preventScroll:true});overlay?.classList.remove('active');overlay?.setAttribute('aria-hidden','true');}
function finishTravel(){if(!travel)return;vessel.position.copy(travel.to);travel=null;hideTravel();needsFrame=true;draw(performance.now());}
function draw(now){
  if(!renderer||failed||!host?.isConnected||!host.clientWidth)return;
  const map=context?.page==='map';systems.visible=map;if(vessel)vessel.visible=map;hangar.visible=!map;
  const drift=reduced.matches||paused?0:now*.00012;
  pointer.x+=(targetPointer.x-pointer.x)*.045;pointer.y+=(targetPointer.y-pointer.y)*.045;
  const distance=map?Math.max(compact?11.6:11.9,9.4/camera.aspect)/zoom:5.0;
  camera.position.set(map?pointer.x*.2:0,map?pointer.y*.12:0,distance);camera.lookAt(0,0,0);
  planets.forEach((p,i)=>{p.rotation.y=drift*(i%2?-.7:.45)+i*.36;p.rotation.z=Math.sin(drift+i)*.05;});
  if(hangarShip){hangarShip.rotation.set(.28,-.4+Math.sin(drift)*.13,-.28);hangarShip.position.y=Math.sin(drift*2)*.06;}
  if(map&&travel){
    const t=Math.min(1,(now-travel.start)/travel.duration),ease=t*t*(3-2*t);
    vessel.position.lerpVectors(travel.from,travel.to,ease);vessel.position.y+=Math.sin(t*Math.PI)*(compact?.6:1.2);vessel.position.z+=Math.sin(t*Math.PI)*1.2;
    vessel.rotation.z=Math.atan2(travel.to.y-travel.from.y,travel.to.x-travel.from.x)-Math.PI/2;
    if(travel.major){camera.position.z-=Math.sin(t*Math.PI)*.85;camera.lookAt(vessel.position.x*.12,vessel.position.y*.12,0);}
    if(t>=1){travel=null;hideTravel();}
  }else if(map&&vessel){const i=context.view.definition.destinations.findIndex(d=>d.id===context.selected);const p=positions[Math.max(0,i)];vessel.position.set(p.x+.65*(compact?.7:1),p.y+.75*(compact?.7:1),p.z+.9);vessel.rotation.z=-.45;}
  camera.updateMatrixWorld();
  if(map){const buttons=host.querySelectorAll('.exp-planet');buttons.forEach((button,i)=>{if(!positions[i])return;v.copy(positions[i]);v.y-=compact?.42:.59;v.project(camera);button.style.left=`${(v.x*.5+.5)*100}%`;button.style.top=`${(-v.y*.5+.5)*100}%`;});}
  renderer.render(scene,camera);frames++;needsFrame=false;
}
function replaceShip(design,color){
  if(shipDesign===design&&shipColor===color)return;
  for(const old of [vessel,hangarShip])if(old){old.parent?.remove(old);old.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)materials.add(o.material);});}
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());geometries.clear();materials.clear();
  vessel=shipModel(design,color);vessel.scale.setScalar(.32);scene.add(vessel);
  hangarShip=shipModel(design,color);hangarShip.scale.setScalar(1.3);hangar.add(hangarShip);shipDesign=design;shipColor=color;
}
function mount(root,data){
  currentRoot=root;const previous=lastSelected;context=data;lastSelected=data.selected;
  const detail=root.querySelector('.exp-detail');
  if(detail&&!detail.querySelector('.cosmic-destination-art')){const idx=data.view.definition.destinations.findIndex(d=>d.id===data.selected);detail.insertAdjacentHTML('afterbegin',`<div class="cosmic-destination-art"><img src="${esc(window.__COSMIC_ASSETS__?.[idx<0?6:idx]||`assets/atlas/${idx<0?'final':`world-${idx+1}`}.svg`)}" alt=""/><span>${idx<0?'THE LAST PASSAGE':`DESTINATION / 0${idx+1}`}</span></div>`);}
  const nextHost=data.page==='map'&&!data.listMode?root.querySelector('.exp-map'):data.page==='collection'?root.querySelector('.exp-hangar-ship'):null;
  if(host!==nextHost){if(host)resizeObserver.unobserve(host);host=nextHost;}
  if(!host){travel=null;stop();if(canvas)parking.append(canvas);return;}
  if(data.page!=='map')travel=null;
  init();if(failed||!renderer)return;
  host.prepend(canvas);host.classList.add('cosmic-ready');resizeObserver.observe(host);
  const equipped=data.view.rewards.find(r=>r.id===data.view.state?.equipped.ship);replaceShip(equipped?.design??-1,safeColor(equipped?.color));
  if(data.page==='map'){
    host.querySelectorAll('.cosmic-travel,.cosmic-coordinates,.cosmic-map-controls').forEach(el=>el.remove());
    const overlay=document.createElement('div');overlay.className='cosmic-travel';overlay.setAttribute('aria-hidden','true');overlay.innerHTML='<small></small><strong></strong><button type="button">Skip flight</button>';overlay.querySelector('button').onclick=finishTravel;host.append(overlay);
    const coordinates=document.createElement('div');coordinates.className='cosmic-coordinates';coordinates.textContent='FIRST LIGHT / LOCAL STAR CHART';host.append(coordinates);
    const controls=document.createElement('div');controls.className='cosmic-map-controls';controls.innerHTML=`<button type="button" aria-label="Zoom out">−</button><button type="button" aria-label="Reset map view">Reset view</button><button type="button" aria-label="Zoom in">+</button><button type="button" aria-pressed="${paused}">${paused?'Resume motion':'Pause motion'}</button><button type="button">Objective</button>`;host.append(controls);
    const bs=controls.querySelectorAll('button');bs[0].onclick=()=>{zoom=Math.max(.8,zoom-.1);resize();};bs[1].onclick=()=>{zoom=1;targetPointer={x:0,y:0};resize();};bs[2].onclick=()=>{zoom=Math.min(1.15,zoom+.1);resize();};bs[3].onclick=()=>{paused=!paused;bs[3].textContent=paused?'Resume motion':'Pause motion';bs[3].setAttribute('aria-pressed',String(paused));if(paused)finishTravel();needsFrame=true;wake();};
    bs[4].onclick=()=>{const objective=root.querySelector('.exp-objective');objective?.scrollIntoView({block:'center',behavior:reduced.matches?'instant':'smooth'});const heading=objective?.querySelector('h3');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});};
    resize();
    if(previous&&previous!==data.selected&&canAnimate()){const toIdx=data.view.definition.destinations.findIndex(d=>d.id===data.selected),fromIdx=data.view.definition.destinations.findIndex(d=>d.id===previous);if(toIdx>=0){const major=!seen.has(data.selected);const from=positions[Math.max(0,fromIdx)].clone().add(new THREE.Vector3(.5,.6,.9)),to=positions[toIdx].clone().add(new THREE.Vector3(.5,.6,.9));travel={from,to,start:performance.now(),duration:major?3200:900,major};if(major){overlay.querySelector('small').textContent='FIRST ARRIVAL';overlay.querySelector('strong').textContent=data.view.definition.destinations[toIdx].name;overlay.classList.add('active');overlay.setAttribute('aria-hidden','false');}visited(data.selected);if(typeof window.playSound==='function')window.playSound('nav');}}
    else if(!previous)visited(data.selected);
    if(travel&&travel.major){overlay.querySelector('small').textContent='FIRST ARRIVAL';overlay.querySelector('strong').textContent=data.view.definition.destinations.find(d=>d.id===data.selected)?.name||'First Light';overlay.classList.add('active');overlay.setAttribute('aria-hidden','false');}
  }else resize();
  needsFrame=true;wake();
}
function beforeRender(){if(canvas?.isConnected)parking.append(canvas);stop();}

let cinematic=null, cinematicTimer, restoreFocus;
function closeCinematic(){clearTimeout(cinematicTimer);if(!cinematic)return;cinematic.hidden=true;const target=restoreFocus?.isConnected?restoreFocus:currentRoot?.querySelector('.exp-planet.selected, .exp-tabs button[aria-pressed="true"]');target?.focus({preventScroll:true});}
function celebrate(view,ids){
  const clear=ids.find(id=>/:clear$/.test(id));if(!clear||!document.querySelector('#screen-expedition.active'))return;
  const destination=clear.split(':')[0],reward=view.rewards.find(r=>r.id===`${destination}:ship`),name=view.definition.destinations.find(d=>d.id===destination)?.name||'First Light';
  if(reduced.matches)return;
  if(!cinematic){cinematic=document.createElement('div');cinematic.className='cosmic-cinematic';cinematic.setAttribute('role','dialog');cinematic.setAttribute('aria-modal','true');cinematic.setAttribute('aria-labelledby','cosmicClearTitle');cinematic.hidden=true;document.body.append(cinematic);cinematic.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeCinematic();}if(e.key==='Tab'){e.preventDefault();cinematic.querySelector('button').focus();}});}
  restoreFocus=document.activeElement;cinematic.innerHTML=`<div class="cosmic-cinematic-inner"><small>${destination==='final'?'EXPEDITION COMPLETE':'DESTINATION CLEARED'}</small><div class="cosmic-cinematic-art">${art('ship',reward?.design??0,reward?.color)}</div><h2 id="cosmicClearTitle">${esc(name)}</h2><p>${esc(reward?.name||'A new milestone')} · Clear and rewards saved.</p><button type="button">Continue journey</button></div>`;
  cinematic.hidden=false;cinematic.querySelector('button').onclick=closeCinematic;cinematic.querySelector('button').focus();if(typeof window.playSound==='function')window.playSound('celebrate');cinematicTimer=setTimeout(closeCinematic,6500);
}
function refreshIcons(){for(const [screen,path] of Object.entries(iconPaths)){const el=document.querySelector(`.tab[data-screen="${screen}"] .nav-icon`);if(el)el.innerHTML=`<path d="${path}"/>`;}}
function transition(){const screen=document.querySelector('.screen.active');if(screen&&!reduced.matches){screen.classList.remove('cosmic-enter');void screen.offsetWidth;screen.classList.add('cosmic-enter');}if(document.body.dataset.screen!=='expedition')closeCinematic();needsFrame=true;wake();}
new MutationObserver(transition).observe(document.body,{attributes:true,attributeFilter:['data-screen']});
document.addEventListener('visibilitychange',()=>{if(document.hidden)finishTravel();needsFrame=true;wake();});
window.addEventListener('focus',()=>{needsFrame=true;wake();});window.addEventListener('blur',()=>{finishTravel();stop();});
reduced.addEventListener('change',()=>{finishTravel();needsFrame=true;wake();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')finishTravel();});
window.addEventListener('pagehide',()=>{stop();resizeObserver.disconnect();if(renderer){scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});renderer.dispose();}});
refreshIcons();
window.ApogeeCosmic={art,mount,beforeRender,celebrate,inspect:()=>({available:!!renderer&&!failed,frames,animating:!!raf,traveling:!!travel,travelDuration:travel?.duration??0,paused,reduced:reduced.matches,geometries:renderer?.info.memory.geometries??0,canvases:document.querySelectorAll('.cosmic-canvas').length})};
