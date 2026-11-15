/* ARES V6 — Static GitHub Pages data/routing bridge.
 * All API-like operations happen in the browser. No HTTP server is required.
 * NASA MOLA terrain samples are kept separate from the Pyodide planner.
 */
(() => {
  'use strict';
  const API = {};
  const RADIUS = 3396;
  const N = 433;
  const CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
  const ORIGIN = new URL(location.protocol==='about:' ? 'https://ares-v6.test/' : './', location.protocol==='about:' ? 'https://ares-v6.test/' : location.href);
  const nativeFetch = window.fetch.bind(window);
  const urlFor = file => new URL(file, ORIGIN).href;
  const DEFAULTS = Object.freeze({speed: 2, mass: 900, power: 100, efficiency: .6, rolling: .08, maxSlope: 25, hoursPerSol: 6});
  const state = {
    original: null, terrain: null, terrainKey: '', sourceBuffer: new Map(),
    globeUrl: '', textureUrl: '', names: null, status: 'Checking bundled global NASA terrain',
    loading: false, globalStarted: false, bestPpd: 0, py: null,
    globalErrors: [], globalReady: null, resolveGlobal: null, load16Started: false,
    plannerInstalled: '', pyPromise: null, error: null
  };
  const response = (payload, status=200) => new Response(JSON.stringify(payload), {
    status, headers: {'Content-Type':'application/json; charset=utf-8'}
  });
  const fail = (message, code=400) => response({error: String(message)},code);
  const bytesHash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b=>b.toString(16).padStart(2,'0')).join('');
  const readBinary = (buffer, len) => {
    const view=new DataView(buffer), n=Math.min(view.byteLength/2,len||view.byteLength/2);
    const out=new Array(n);
    for(let i=0;i<n;i++)out[i]=view.getInt16(i*2,false);
    return out;
  };
  function geometry(meta, heights, places) {
    const n=meta.n,latStep=meta.stepLat||meta.step,lonStep=meta.stepLon||meta.step;
    const dy=RADIUS*latStep*Math.PI/180;
    const dx=Array.from({length:n},(_,r)=>Math.max(1e-6,RADIUS*lonStep*Math.PI/180*Math.abs(Math.cos((meta.north-r*latStep)*Math.PI/180))));
    const slopes=new Array(n*n),roughness=new Array(n*n);
    for(let r=0;r<n;r++)for(let c=0;c<n;c++){
      const i=r*n+c,l=r*n+Math.max(0,c-1),right=r*n+Math.min(n-1,c+1),up=Math.max(0,r-1)*n+c,down=Math.min(n-1,r+1)*n+c;
      const gx=(heights[right]-heights[l])/((Math.min(n-1,c+1)-Math.max(0,c-1))*dx[r]*1000);
      const gy=(heights[down]-heights[up])/((Math.min(n-1,r+1)-Math.max(0,r-1))*dy*1000);
      const steep=Math.max(...[l,right,up,down].map(j=>Math.abs(heights[j]-heights[i])/(j===l||j===right?dx[r]:dy)/1000));
      slopes[i]=Math.atan(Math.max(Math.hypot(gx,gy),steep))*180/Math.PI;
      roughness[i]=Math.min(3,Math.abs(heights[l]+heights[right]+heights[up]+heights[down]-4*heights[i])/200);
      // Missing MOLA values remain explicitly non-traversable rather than being mistaken for a crater.
      if(heights[i]<=-32768 || heights[l]<=-32768 || heights[right]<=-32768 || heights[up]<=-32768 || heights[down]<=-32768){
        slopes[i]=90;roughness[i]=3;
      }
    }
    const width=(n-1)*dx[Math.floor(n/2)],height=(n-1)*dy;
    return {meta:{...meta,width,height,radius:RADIUS,south:meta.north-(n-1)*latStep,east:meta.west+(n-1)*lonStep},
            heights,slopes,roughness,places,defaults:DEFAULTS};
  }
  async function loadOriginal() {
    if(state.original)return state.original;
    const res=await nativeFetch(urlFor('mars_map.bin'));
    if(!res.ok)throw Error('The original Mars map file (mars_map.bin) is missing from the published site.');
    const buffer=await res.arrayBuffer(),view=new DataView(buffer),magic='ARES-MOLA-MAP-1\n';
    if(new TextDecoder().decode(new Uint8Array(buffer,0,magic.length))!==magic)throw Error('mars_map.bin is not a valid ARES map.');
    const headerLen=view.getUint32(magic.length,false);
    if(headerLen<100||headerLen>50000)throw Error('Invalid ARES map metadata header.');
    const header=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,magic.length+4,headerLen)));
    const start=magic.length+4+headerLen,compressed=new Uint8Array(buffer,start,header.compressed_dem_size);
    if(await bytesHash(compressed)!==header.compressed_dem_sha256)throw Error('NASA Noctis elevation checksum does not match.');
    if(!('DecompressionStream' in window))throw Error('This browser needs DecompressionStream (recent Chrome, Firefox, Safari, or Edge).');
    const compressedResponse=new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')));
    const raw=await compressedResponse.arrayBuffer();
    if(await bytesHash(raw)!==header.terrain.sha256)throw Error('NASA original MOLA sample checksum failed.');
    const heights=readBinary(raw,N*N);
    if(heights.length!==N*N)throw Error('Native MOLA crop dimensions are incorrect.');
    const imageStart=start+header.compressed_dem_size;
    const jpeg=new Uint8Array(buffer,imageStart,header.jpeg_size);
    if(await bytesHash(jpeg)!==header.jpeg_sha256)throw Error('Viking VIS image checksum failed.');
    state.textureUrl=URL.createObjectURL(new Blob([jpeg],{type:'image/jpeg'}));
    const names=await getNames();
    const places=filterPlaces(names.places,header.terrain);
    state.original=geometry(header.terrain,heights,places);
    return state.original;
  }
  async function getNames(){
    if(state.names)return state.names;
    const r=await nativeFetch(urlFor('mars_iau_place_names.json'));
    if(!r.ok)throw Error('Mars USGS/IAU place-name data is not bundled.');
    const obj=await r.json();
    if(!Array.isArray(obj.places)||obj.places.length<1500)throw Error('Mars place-name catalogue is incomplete.');
    state.names=obj;
    return obj;
  }
  function filterPlaces(places,meta){
    const width=(meta.n-1)*(meta.stepLon||meta.step),height=(meta.n-1)*(meta.stepLat||meta.step);
    return places.filter(p=>p.lat>=meta.north-height-1e-7&&p.lat<=meta.north+1e-7 && (p.lon-meta.west+720)%360<=width+1e-7)
      .map(p=>({...p,lon:meta.west+(p.lon-meta.west+720)%360}));
  }
  async function loadGlobalFile(ppd, timeoutMs=30000){
    const name=`mola_global_${ppd}ppd.img`,w=ppd*360,h=ppd*180;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await nativeFetch(urlFor(name),{cache:'default',signal:controller.signal});
      if(!r.ok)throw Error(`${name}: HTTP ${r.status} (${r.status===404?'not published at the site root':'server error'})`);
      const data=await r.arrayBuffer();
      if(data.byteLength!==w*h*2)throw Error(`${name}: expected ${w*h*2} bytes, received ${data.byteLength}. Check that the raw NASA .img file was uploaded without modification.`);
      // Native NASA MEGDR: signed 16-bit big-endian, no PDS label prepended.
      const view=new DataView(data);
      state.sourceBuffer.set(ppd,view);
      state.bestPpd=Math.max(...state.sourceBuffer.keys());
      state.status=`Global NASA MOLA ready (${[...state.sourceBuffer.keys()].sort((a,b)=>a-b).join(' / ')} ppd)`;
      state.globeUrl='';
      if(state.resolveGlobal){state.resolveGlobal();state.resolveGlobal=null;}
      return true;
    }catch(e){
      const detail=e?.name==='AbortError'?`${name}: loading timed out. Check GitHub Pages file size and connectivity.`:(e?.message||String(e));
      state.globalErrors.push(detail);
      console.warn('ARES global terrain',detail);
      return false;
    }finally{clearTimeout(timeout);}
  }
  function startGlobalLoad(){
    if(state.globalStarted)return;
    state.globalStarted=true;state.loading=true;
    state.globalReady=new Promise(resolve=>{state.resolveGlobal=resolve;});
    // Prioritize the tiny 4 ppd DEM. Do not block the whole-planet map on the
    // much larger 16 ppd download. Fetch the latter only when more detail is
    // requested in a narrower region.
    (async()=>{
      const success=await loadGlobalFile(4,22000);
      state.loading=false;
      if(!success){
        state.status='Global terrain unavailable: '+state.globalErrors.at(-1);
        // A deployment containing only the 16 ppd file is also supported.
        state.loading=true;
        await loadGlobalFile(16,55000);
        state.loading=false;
      }
      if(!state.bestPpd){state.status='No global NASA MOLA data found. '+state.globalErrors.join(' | ');}
      if(state.resolveGlobal){state.resolveGlobal();state.resolveGlobal=null;}
    })().catch(e=>{
      state.loading=false;state.globalErrors.push(e.message||String(e));
      state.status='Global data error: '+e.message;
      if(state.resolveGlobal){state.resolveGlobal();state.resolveGlobal=null;}
    });
  }
  function startHighResolutionLoad(){
    if(state.load16Started||state.sourceBuffer.has(16))return;
    state.load16Started=true;
    // A background improvement only; never block 4 ppd map display.
    loadGlobalFile(16,55000);
  }
  function parseRegion(){
    const params=new URLSearchParams(location.search),trip=params.get('drive');
    if(trip){
      try{const snapshot=JSON.parse(localStorage.getItem(`ares.v6.trip.${trip}`)||'null');if(snapshot?.region)return snapshot.region;}
      catch(e){console.warn('Could not restore trip region',e);}
    }
    const hasBounds=['west','east','north','south'].some(k=>params.has(k));
    if(hasBounds){
      const fields=['west','east','north','south'];
      if(fields.some(k=>!params.has(k)))throw Error('A Mars coverage rectangle needs west, east, north and south.');
      const values=fields.map(k=>Number(params.get(k))),[west,east,north,south]=values;
      if(values.some(v=>!Number.isFinite(v))||!(-180<=west&&west<east&&east<=180&&-90<=south&&south<north&&north<=90)||east-west<.25||north-south<.25)throw Error('Your Mars rectangle exceeds valid geographic bounds.');
      return {kind:'bounds',west,east,north,south};
    }
    if(params.has('lon')||params.has('lat')){
      const lon=Number(params.get('lon')),lat=Number(params.get('lat'));
      if(!Number.isFinite(lon)||!Number.isFinite(lat)||Math.abs(lat)>90||Math.abs(lon)>1e5)throw Error('Invalid Mars latitude or longitude.');
      return {kind:'global',lon,lat};
    }
    return {kind:'noctis'};
  }
  function readHeight(view,ppd,row,col){
    const ww=360*ppd,hh=180*ppd;
    const r=Math.max(0,Math.min(hh-1,row));
    const c=((col%ww)+ww)%ww;
    return view.getInt16((r*ww+c)*2,false);
  }
  function globalTerrain(region){
    const isBroad=region.kind==='bounds' && (region.east-region.west>=80 || region.north-region.south>=40);
    // 4 ppd is fully sufficient for a 433-cell whole-Mars rendering. Use 16 ppd
    // only for finer selected regions after it has been loaded in the background.
    const ppd=(isBroad && state.sourceBuffer.has(4))?4:state.bestPpd;
    const source=state.sourceBuffer.get(ppd);
    if(!source)throw Error('NASA global elevation data is unavailable. '+state.globalErrors.join(' | '));
    let west,east,north,south;
    if(region.kind==='bounds')({west,east,north,south}=region);
    else{
      const centreLon=((region.lon+180)%360+360)%360-180;
      const half=216/ppd;
      west=centreLon-half;east=centreLon+half;
      north=Math.min(90,region.lat+half);south=Math.max(-90,region.lat-half);
      // Keep the original 433x433 sampling grid at the poles.
      if(north-south<432/ppd){if(north>=90)south=90-432/ppd;else north=-90+432/ppd;}
    }
    const stepLon=(east-west)/432,stepLat=(north-south)/432;
    const heights=new Array(N*N),raw=new ArrayBuffer(N*N*2),dv=new DataView(raw);
    for(let row=0;row<N;row++){
      const latitude=north-row*stepLat;
      const rowIndex=Math.round((90-latitude)*ppd-.5);
      for(let col=0;col<N;col++){
        const longitude=west+col*stepLon;
        const sourceCol=Math.round(((longitude%360+360)%360)*ppd-.5);
        const z=readHeight(source,ppd,rowIndex,sourceCol);
        heights[row*N+col]=z;dv.setInt16((row*N+col)*2,z,false);
      }
    }
    return {meta:{n:N,west,north,step:stepLon,stepLon,stepLat,ppd,planetwide:true,
                  selectedBounds:{west,east,north,south},wholeMars:west===-180&&east===180&&north===90&&south===-90,
                  demo:[[151,225],[281,200]],min:heights.reduce((a,v)=>v<=-32768?a:Math.min(a,v),Infinity),max:heights.reduce((a,v)=>v<=-32768?a:Math.max(a,v),-Infinity),
                  source:`NASA PDS MGS MOLA MEGDR v2.0 (${ppd} px/degree)`},heights,raw};
  }
  async function terrain(){
    const region=parseRegion(),key=JSON.stringify(region);
    if(key===state.terrainKey&&state.terrain)return state.terrain;
    if(region.kind==='noctis')state.terrain=await loadOriginal();
    else{
      if(!state.bestPpd){startGlobalLoad();await state.globalReady;}
      if(!state.bestPpd)throw Error(state.status||'Global NASA terrain files are missing.');
      const broad=region.kind==='bounds' && (region.east-region.west>=80 || region.north-region.south>=40);
      if(!broad && state.sourceBuffer.has(4))startHighResolutionLoad();
      const source=globalTerrain(region);
      source.meta.sha256=await bytesHash(source.raw);
      source.meta.min=Number.isFinite(source.meta.min)?source.meta.min:0;
      source.meta.max=Number.isFinite(source.meta.max)?source.meta.max:0;
      const names=await getNames();
      state.terrain=geometry(source.meta,source.heights,filterPlaces(names.places,source.meta));
    }
    state.terrainKey=key;state.plannerInstalled='';
    return state.terrain;
  }
  function globeUrl(){
    if(state.globeUrl)return state.globeUrl;
    const ppd=state.sourceBuffer.has(4)?4:state.bestPpd;
    if(!ppd)return '';
    const grid=state.sourceBuffer.get(ppd),canvas=document.createElement('canvas');
    canvas.width=720;canvas.height=360;
    const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(720,360);
    const read=(r,c)=>readHeight(grid,ppd,r,c);
    for(let y=0;y<360;y++)for(let x=0;x<720;x++){
      const row=Math.min(180*ppd-1,Math.floor((y+.5)/2*ppd));
      const c=Math.floor(((x/2-180+360)%360)*ppd);
      const z=read(row,c),idx=(y*720+x)*4;
      if(z<=-32768){pixels.data.set([35,40,43,255],idx);continue;}
      const t=Math.min(1,Math.max(0,(z+8500)/22000));
      const dzx=read(row,c+ppd)-read(row,c-ppd);
      const dzy=read(Math.min(180*ppd-1,row+ppd),c)-read(Math.max(0,row-ppd),c);
      const shade=Math.min(1.2,Math.max(.5,.82-(dzx+dzy)/10000));
      pixels.data[idx]=Math.round((69+133*t)*shade);
      pixels.data[idx+1]=Math.round((43+107*t)*shade);
      pixels.data[idx+2]=Math.round((38+77*t)*shade);
      pixels.data[idx+3]=255;
    }
    ctx.putImageData(pixels,0,0);state.globeUrl=canvas.toDataURL('image/png');
    return state.globeUrl;
  }
  async function loadPlanner(){
    if(state.py)return state.py;
    if(state.pyPromise)return state.pyPromise;
    state.pyPromise=(async()=>{
      if(!window.loadPyodide){
        const script=document.createElement('script');script.src=CDN+'pyodide.js';
        await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Pyodide CDN could not be loaded. Connect to the internet and retry.'));document.head.append(script);});
      }
      const py=await window.loadPyodide({indexURL:CDN});
      const r=await nativeFetch(urlFor('planner.py'));
      if(!r.ok)throw Error('planner.py is missing from this site.');
      await py.runPythonAsync(await r.text());state.py=py;
      return py;
    })().catch(e=>{state.pyPromise=null;throw e;});
    return state.pyPromise;
  }
  async function routes(body){
    const t=await terrain();
    const py=await loadPlanner();
    if(state.plannerInstalled!==state.terrainKey){
      py.globals.set('MARS_INPUT',JSON.stringify(t));
      py.runPython('install_region(MARS_INPUT)');
      state.plannerInstalled=state.terrainKey;
    }
    py.globals.set('ROUTE_INPUT',JSON.stringify(body));
    const result=JSON.parse(py.runPython('calculate_routes(ROUTE_INPUT)'));
    for(const route of result.routes){
      if(!route.available)continue;
      const token=crypto.randomUUID().replace(/-/g,'');route.tripId=token;
      const snapshot={version:2,route,settings:body.settings,terrainSHA256:t.meta.sha256,region:parseRegion(),savedAt:Date.now()};
      try{
        const key='ares.v6.trip.'+token;
        const all=Object.keys(localStorage).filter(k=>k.startsWith('ares.v6.trip.'));
        for(const old of all.slice(0,Math.max(0,all.length-17)))localStorage.removeItem(old);
        localStorage.setItem(key,JSON.stringify(snapshot));
      }catch(e){
        route.tripId=null; console.warn('Browser storage prevents rover tab',e);
      }
    }
    return result;
  }
  API.fetch=async (url,options={})=>{
    try{
      const target=new URL(String(url).replace(/^\/api\//,'api/'),ORIGIN),path=target.pathname;
      if(path.endsWith('/api/terrain'))return response(await terrain());
      if(path.endsWith('/api/global-status')){
        startGlobalLoad();return response({ready:state.bestPpd>0,bestPpd:state.bestPpd,
         availablePpd:[...state.sourceBuffer.keys()].sort(),downloading:state.loading,message:state.status,
         errors:state.globalErrors.slice(),
         source:'NASA MGS MOLA MEGDR v2.0'});
      }
      if(path.endsWith('/api/places')){
        const t=await terrain(),names=await getNames();
        return response({places:filterPlaces(names.places,t.meta),status:{ready:true,count:names.places.length,source:names.source}});
      }
      if(path.endsWith('/api/places-status')){
        const names=await getNames();return response({ready:true,count:names.places.length,downloading:false,source:names.source});
      }
      if(path.endsWith('/api/routes'))return response(await routes(JSON.parse(options.body||'{}')));
      if(path.includes('/api/trip/')){
        const token=path.split('/api/trip/')[1];
        if(!/^[a-f0-9]{32}$/.test(token))return fail('Invalid trip ID.',404);
        const value=localStorage.getItem('ares.v6.trip.'+token);
        if(!value)return fail('This rover trip is no longer saved in your browser. Calculate the route again.',404);
        return response(JSON.parse(value));
      }
      if(path.endsWith('/api/texture-info'))return response({source:'NASA Viking MDIM 2.1 image embedded in mars_map.bin'});
      return fail('Unknown browser API endpoint: '+path,404);
    }catch(e){console.error('ARES V6 browser data layer:',e);return fail(e.message||String(e),409);}
  };
  API.textureUrl=()=>state.textureUrl||'';
  API.globeUrl=globeUrl;
  API.ensureTerrain=terrain;
  API.debugStatus=()=>({region:parseRegion(),terrainLoaded:!!state.terrain,
    globalPpd:state.bestPpd,availablePpd:[...state.sourceBuffer.keys()],
    errors:state.globalErrors.slice(),placeCount:state.names?.places.length||0});
  window.ARES_API=API;
  // Start fetching optional global MOLA while the original Noctis region loads.
  startGlobalLoad();
})();
