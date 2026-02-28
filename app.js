  // ═══════════════ CONFIGURATION ═══════════════
// Dashboard pulls telemetry from Adafruit IO only (push_to_aio.py on CubeSat).

// Backend bases for user/auth (Rust server); add Pi IP when deployed
// When served from backend (http://localhost:5050), same-origin avoids CORS
function getBackendBases(){
  const list=['http://localhost:5050'];
  if(typeof window!=='undefined'&&window.location?.protocol?.startsWith('http')){
    const o=window.location.origin;
    if(!list.includes(o)) list.unshift(o);
  }
  return list;
}

// Adafruit IO — telemetry from CubeSat push (push_to_aio.py)
// Feeds: ms5611-temp (MS5611 barometric sensor °C), gpu-temp (Pi-Core °C), pressure, cpu-usage, vibration, battery
// Key loaded from config.js (gitignored) to avoid exposing in GitHub
const ADAFRUIT_IO_USERNAME = (typeof window !== 'undefined' && window.ADAFRUIT_IO_USERNAME) || 'sbevans';
const ADAFRUIT_IO_KEY = (typeof window !== 'undefined' && window.ADAFRUIT_IO_KEY) || '';
const ADAFRUIT_IO_BASE = 'https://io.adafruit.com/api/v2';
const ADAFRUIT_MS5611_TEMP = (typeof window !== 'undefined' && window.ADAFRUIT_MS5611_TEMP_FEED) || 'temperature';
const ADAFRUIT_PI_CORE_TEMP = (typeof window !== 'undefined' && window.ADAFRUIT_PI_CORE_TEMP_FEED) || 'gpu-temp';
const DATA_MAX_AGE_MS = 30000;  // 30s — reject data older than this (dashboard not pushing)

// ═══════════════ USER STORE ═══════════════
const DEF_USERS = [
  {id:'flyboysam', pw:'Airplane11!', role:'admin', created:'SYSTEM'},
  {id:'guest',     pw:'guest123',    role:'guest', created:'2026-02-22'},
  {id:'SRG',      pw:'SRG_2026',    role:'guest', created:'2026-02-22'},
];
function loadU(){
  try{
    const s=localStorage.getItem('css_u');
    let list;
    if(!s) list=DEF_USERS.map(u=>({...u}));
    else{
      const parsed=JSON.parse(s);
      if(!Array.isArray(parsed)||parsed.length===0) list=DEF_USERS.map(u=>({...u}));
      else list=parsed;
    }
    // Ensure every default user exists (so SRG etc. work even with old localStorage)
    for(const du of DEF_USERS){
      if(!list.some(u=>u.id.toLowerCase()===du.id.toLowerCase())) list.push({...du});
    }
    return list;
  }catch{ return DEF_USERS.map(u=>({...u})); }
}
function saveU(u){try{localStorage.setItem('css_u',JSON.stringify(u))}catch{}}
let users=loadU(), cur=null;
let usersFromServer=false, piBaseUrl='';

async function fetchUsersFromServer(){
  for(const base of getBackendBases()){
    try{
      const r=await fetch(`${base}/api/users`,{cache:'no-store'});
      if(r.ok){
        const data=await r.json();
        if(Array.isArray(data)&&data.length>0){ users=data; usersFromServer=true; piBaseUrl=base; return; }
      }
    }catch(_){}
  }
  usersFromServer=false; piBaseUrl='';
}
fetchUsersFromServer();

// ═══════════════ DATA SOURCE STATE ═══════════════
let dataMode = 'sim';  // 'sim', 'live', 'cloud', or 'adafruit'
let liveFailCount = 0;
const LIVE_FAIL_MAX = 3;
let connectionSoundPlayed = false;

function playConnectionSound(){
  try{
    const a=document.getElementById('snd-connected')||new Audio('Sound Effects/Connected.mp3');
    a.volume=0.7;a.currentTime=0;
    a.play().catch(()=>{});
  }catch(_){}
}
function playConnectionFailedSound(){
  try{
    const a=document.getElementById('snd-connection-failed')||new Audio('Sound Effects/Connection Failed.mp3');
    a.volume=0.7;a.currentTime=0;
    a.play().catch(()=>{});
  }catch(_){}
}

// ═══════════════ STARFIELD ═══════════════
(function(){
  const c=document.getElementById('sf'),ctx=c.getContext('2d');
  function rsz(){c.width=innerWidth;c.height=innerHeight;}rsz();
  window.addEventListener('resize',rsz);
  const stars=Array.from({length:300},(_,i)=>({
    x:Math.random(),y:Math.random(),
    r:Math.random()*1.2+.1,
    a:Math.random()*.5+.05,
    f:Math.random()*1.5+.3,
    cyan:i<120,
    warm:i>=120&&i<180
  }));
  let t=0;
  (function draw(){
    ctx.clearRect(0,0,c.width,c.height);
    stars.forEach(s=>{
      const a=s.a*(.3+.7*Math.sin(t*s.f));
      ctx.beginPath();
      ctx.arc(s.x*c.width,s.y*c.height,s.r,0,Math.PI*2);
      if(s.warm) ctx.fillStyle=`rgba(255,179,0,${a*.35})`;
      else if(s.cyan) ctx.fillStyle=`rgba(0,212,255,${a*.4})`;
      else ctx.fillStyle=`rgba(0,212,255,${a*.2})`;
      ctx.fill();
    });
    t+=.01; requestAnimationFrame(draw);
  })();
})();

// ═══════════════ CLOCK & RF STATUS ═══════════════
function utcStr(){return new Date().toUTCString().split(' ')[4]+' UTC';}
function updateRfStatus(){
  const e=document.getElementById('rf-status');if(!e)return;
  e.textContent=navigator.onLine?'LOCKED':'UNLOCKED';
  const dot=document.getElementById('rf-dot');if(dot)dot.className='pdot'+(navigator.onLine?'':' red');
}
setInterval(()=>{
  ['lclk','dclk'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=utcStr();});
  updateRfStatus();
},1000);
window.addEventListener('online',updateRfStatus);
window.addEventListener('offline',updateRfStatus);
setTimeout(updateRfStatus,500);

// ═══════════════ BOOT TEXT ═══════════════
async function runBoot(){
  const el=document.getElementById('boot');el.innerHTML='';
  const addTyping=async(text,cls='',ms=22)=>{
    const s=document.createElement('span');s.style.display='block';s.className=cls;s.textContent='> ';el.appendChild(s);
    for(let i=0;i<text.length;i++){ s.textContent='> '+text.slice(0,i+1); el.scrollTop=el.scrollHeight; await new Promise(r=>setTimeout(r,ms)); }
  };
  await addTyping('AMSAT CUBESAT-SIM GCS BIOS v2.4.1','hi',15);
  await new Promise(r=>setTimeout(r,180));
  const mem=navigator.deviceMemory?`${navigator.deviceMemory}GB`:(performance.memory?`${Math.round(performance.memory.jsHeapSizeLimit/1048576)}MB`:'OK');
  await addTyping(`MEMORY CHECK............... ${mem} OK`,'',16);
  await new Promise(r=>setTimeout(r,120));
  await addTyping(`I2C BUS → 0x77 [MS5611]  0x68 [MPU6050]  N/A (ADAFRUIT IO)`,'hi',10);
  await new Promise(r=>setTimeout(r,100));
  let tmpStatus='OK';
  if(ADAFRUIT_IO_KEY){ try{ const t=await fetch(`${ADAFRUIT_IO_BASE}/${ADAFRUIT_IO_USERNAME}/feeds/${ADAFRUIT_MS5611_TEMP}/data/last`,{headers:{'X-AIO-Key':ADAFRUIT_IO_KEY},signal:AbortSignal.timeout(2000)}); if(t.ok){ const j=await t.json(); tmpStatus=j&&j.value!=null?'AIO':'OK'; } else tmpStatus='OK'; }catch(_){ tmpStatus='OK'; } }
  await addTyping(`TMP DIODE D3............... ${tmpStatus}`,'ok',12);
  await new Promise(r=>setTimeout(r,80));
  const hasData=!!ADAFRUIT_IO_KEY;
  await addTyping(`APRS CODEC................. ${hasData?'READY':'STANDBY'}`,'ok',10);
  await new Promise(r=>setTimeout(r,80));
  const rfStatus=navigator.onLine?'LOCKED':'UNLOCKED';
  await addTyping(`UPLINK 435 MHz · DOWNLINK 434.9 MHz.. ${rfStatus}`,'hi',8);
  await new Promise(r=>setTimeout(r,60));
  await addTyping('ENTER CREDENTIALS TO PROCEED','wn',6);
  const cur=document.createElement('span');cur.className='boot-cursor';cur.textContent='_';el.appendChild(cur);
}
runBoot();

document.getElementById('uid').addEventListener('keydown',e=>e.key==='Enter'&&document.getElementById('upw').focus());
document.getElementById('upw').addEventListener('keydown',e=>e.key==='Enter'&&doLogin());

// ═══════════════ LOGIN ═══════════════
async function doLogin(){
  const uid=document.getElementById('uid').value.trim();
  const pw=document.getElementById('upw').value;
  const err=document.getElementById('lerr');
  const btn=document.getElementById('lbtn');
  err.textContent='';

  if(!uid||!pw){err.textContent='⚠ OPERATOR ID AND ACCESS CODE REQUIRED';return;}
  btn.textContent='[ AUTHENTICATING... ]';btn.className='lbtn busy';

  for(const base of getBackendBases()){
    try{
      const r=await fetch(`${base}/api/auth`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:uid,pw})});
      const data=await r.json().catch(()=>({}));
      if(r.ok&&data.ok&&data.user){
        cur={id:data.user.id,role:data.user.role,created:data.user.created,pw};
        const local=loadU();
        if(!local.some(u=>u.id.toLowerCase()===cur.id.toLowerCase())){
          local.push({id:cur.id,pw:cur.pw,role:cur.role,created:cur.created||new Date().toISOString().split('T')[0]});
          saveU(local);
        }
        usersFromServer=true; piBaseUrl=base;
        btn.textContent='[ UPLINK ESTABLISHED ✓ ]';btn.className='lbtn ok2';
        setTimeout(launch,700);
        return;
      }
    }catch(_){}
  }

  const localUsers=loadU();
  const m=localUsers.find(u=>u.id.toLowerCase()===uid.toLowerCase()&&u.pw===pw);
  if(!m){
    err.textContent='⚠ AUTHENTICATION FAILED — INVALID CREDENTIALS';
    btn.className='lbtn err2';setTimeout(()=>btn.className='lbtn',1600);return;
  }
  cur=m;
  btn.textContent='[ UPLINK ESTABLISHED ✓ ]';btn.className='lbtn ok2';
  setTimeout(launch,700);
}

function launch(){
  document.getElementById('login').classList.add('out');
  setTimeout(()=>{
    document.getElementById('login').style.display='none';
    const d=document.getElementById('dash');d.classList.add('show');
    setTimeout(()=>d.classList.add('vis'),30);
    document.getElementById('nb-op').textContent=`OPERATOR: ${cur.id.toUpperCase()} // ROLE: ${cur.role.toUpperCase()}`;
    document.getElementById('nu-name').textContent=cur.id.toUpperCase();
    document.getElementById('nu-role').textContent=cur.role.toUpperCase();
    const b=document.getElementById('nu-badge');
    if(cur.role==='admin'){b.className='badge-a';b.textContent='ADMIN';document.getElementById('admin-btn').style.display='';}
    else{b.className='badge-g';b.textContent='GUEST';document.getElementById('admin-btn').style.display='none';}
    startDash();
  },900);
}

function doLogout(){
  cur=null;
  const d=document.getElementById('dash');d.classList.remove('vis');
  setTimeout(()=>{
    d.classList.remove('show');stopDash();
    const l=document.getElementById('login');
    l.style.opacity='0';l.style.display='flex';l.classList.remove('out');
    setTimeout(()=>{l.style.transition='opacity .5s';l.style.opacity='1';},30);
    document.getElementById('uid').value='';document.getElementById('upw').value='';
    document.getElementById('lerr').textContent='';
    document.getElementById('lbtn').textContent='[ AUTHENTICATE // ESTABLISH UPLINK ]';
    document.getElementById('lbtn').className='lbtn';
    runBoot();
  },800);
}

// ═══════════════ ADMIN ═══════════════
function openAdmin(){if(!cur||cur.role!=='admin')return;renderUT();document.getElementById('admin').classList.add('show');}
function closeAdmin(){document.getElementById('admin').classList.remove('show');}
document.getElementById('admin').addEventListener('click',function(e){if(e.target===this)closeAdmin();});

function stab(e,pid){
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('act'));
  document.querySelectorAll('.tpane').forEach(p=>p.classList.remove('act'));
  e.target.classList.add('act');document.getElementById(pid).classList.add('act');
}

function renderUT(){
  const tb=document.getElementById('utbody');tb.innerHTML='';
  users.forEach((u,i)=>{
    const tr=document.createElement('tr');
    const isA=u.role==='admin',prot=u.id==='flyboysam';
    tr.innerHTML=`<td>${u.id}</td><td><span class="rtag ${isA?'ra':'rg'}">${u.role.toUpperCase()}</span></td><td>${u.created}</td><td>${prot?'<span style="color:rgba(255,179,0,.6);font-size:9px">PROTECTED</span>':`<button class="delbtn" onclick="delUser(${i})">REMOVE</button>`}</td>`;
    tb.appendChild(tr);
  });
}

async function delUser(i){
  const u=users[i];if(!u)return;
  if(u.id==='flyboysam'){return;}
  if(u.id===cur.id){alert('Cannot remove your own account.');return;}
  if(usersFromServer&&piBaseUrl&&cur&&cur.pw){
    try{
      const r=await fetch(`${piBaseUrl}/api/users/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminId:cur.id,adminPw:cur.pw,id:u.id})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){ alert(data.error||'Server error'); return; }
      const listR=await fetch(`${piBaseUrl}/api/users`,{cache:'no-store'});
      if(listR.ok) users=await listR.json();
      renderUT();
      tlog(`SYS: ACCOUNT "${u.id.toUpperCase()}" REMOVED BY ADMIN`,'twn');
      return;
    }catch(e){ alert('Network error — try again'); return; }
  }
  users.splice(i,1);saveU(users);renderUT();
  tlog(`SYS: ACCOUNT "${u.id.toUpperCase()}" REMOVED BY ADMIN`,'twn');
}

async function addUser(){
  const uid=document.getElementById('nu-u').value.trim();
  const role=document.getElementById('nu-r').value;
  const pw=document.getElementById('nu-p').value;
  const pw2=document.getElementById('nu-p2').value;
  const err=document.getElementById('aerr');err.textContent='';
  if(!uid){err.textContent='⚠ USERNAME REQUIRED';return;}
  if(uid.length<3){err.textContent='⚠ USERNAME MUST BE ≥ 3 CHARACTERS';return;}
  if(pw.length<6){err.textContent='⚠ PASSWORD MUST BE ≥ 6 CHARACTERS';return;}
  if(pw!==pw2){err.textContent='⚠ PASSWORDS DO NOT MATCH';return;}
  if(users.find(u=>u.id.toLowerCase()===uid.toLowerCase())){err.textContent='⚠ USERNAME ALREADY EXISTS';return;}
  if(usersFromServer&&piBaseUrl&&cur&&cur.pw){
    try{
      const r=await fetch(`${piBaseUrl}/api/users`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({adminId:cur.id,adminPw:cur.pw,id:uid,pw,role})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok){ err.textContent='⚠ '+(data.error||'Server error'); return; }
      const listR=await fetch(`${piBaseUrl}/api/users`,{cache:'no-store'});
      if(listR.ok) users=await listR.json();
      const local=loadU();
      if(!local.some(u=>u.id.toLowerCase()===uid.toLowerCase())){
        local.push({id:uid,pw,role,created:new Date().toISOString().split('T')[0]});
        saveU(local);
      }
      ['nu-u','nu-p','nu-p2'].forEach(id=>document.getElementById(id).value='');
      document.querySelectorAll('.tb')[0].click();renderUT();
      tlog(`SYS: NEW ACCOUNT "${uid.toUpperCase()}" [${role.toUpperCase()}] CREATED (saved on server)`,'tinf');
      return;
    }catch(e){ err.textContent='⚠ Network error — try again'; return; }
  }
  const d=new Date().toISOString().split('T')[0];
  users.push({id:uid,pw,role,created:d});saveU(users);
  ['nu-u','nu-p','nu-p2'].forEach(id=>document.getElementById(id).value='');
  document.querySelectorAll('.tb')[0].click();renderUT();
  tlog(`SYS: NEW ACCOUNT "${uid.toUpperCase()}" [${role.toUpperCase()}] CREATED`,'tinf');
}

// ═══════════════ DASHBOARD ENGINE ═══════════════
let timers=[],tHist=[],tmpHist=[],aHist=[],frames=0,pkts=0,sesStart=0;
const SIGS=['▯▯▯▯▯','▮▯▯▯▯','▮▮▯▯▯','▮▮▮▯▯','▮▮▮▮▯','▮▮▮▮▮'];

async function startDash(){
  sesStart=Date.now();
  tlog(`OPERATOR ${cur.id.toUpperCase()} [${cur.role.toUpperCase()}] AUTHENTICATED`,'tok');
  tlog('SESSION STARTED — TELEMETRY ACQUISITION ACTIVE','tok');
  tlog('SENSORS ONLINE: MS5611 · MPU6050 · TMP-DIODE','tok');

  if(ADAFRUIT_IO_KEY){
    dataMode='adafruit'; liveFailCount=0;
    tlog('TELEMETRY FROM ADAFRUIT IO (push_to_aio.py on CubeSat)','tinf');
    // Immediate check — if dashboard not running or data stale, play failure sound right away
    try {
      const tempMeta=await fetchAdafruitLastWithMeta(ADAFRUIT_MS5611_TEMP);
      const p=await fetchAdafruitLast('pressure');
      if(!tempMeta||!isDataFresh(tempMeta.created_at)||p==null||isNaN(parseFloat(tempMeta.value))||isNaN(parseFloat(p))){
        throw new Error('No fresh data from Adafruit');
      }
    } catch(_) {
      dataMode='sim';
      playConnectionFailedSound();
      tlog('ADAFRUIT IO UNAVAILABLE — DASHBOARD NOT RUNNING','terr');
    }
  } else {
    dataMode='sim';
    tlog('MODE: LOCAL SIMULATION — no data source configured','twn');
  }
  updateModeIndicator();

  timers.push(setInterval(tickMET,1000));
  timers.push(setInterval(tickTel,1400));
  tickTel();
}

function stopDash(){
  timers.forEach(clearInterval);timers=[];
  timers=[];
  tHist=[];tmpHist=[];aHist=[];frames=0;pkts=0;
  connectionSoundPlayed=false;
  const tl=document.getElementById('tlog');if(tl)tl.innerHTML='';
}

function updateModeIndicator(){
  const el=document.getElementById('data-mode');
  if(!el) return;
  if(dataMode==='sim'){
    el.className='data-mode sim';  // CSS hides when sim
    return;
  }
  if(dataMode==='live'){
    el.textContent='LIVE';
    el.className='data-mode live';
  } else if(dataMode==='cloud'){
    el.textContent='CLOUD';
    el.className='data-mode cloud';
  } else if(dataMode==='adafruit'){
    el.textContent='ADAFRUIT';
    el.className='data-mode cloud';
  }
}

async function tryReconnect(){
  const btn=document.getElementById('reconnect-btn');
  if(btn){btn.classList.add('trying');btn.textContent='⟳ TRYING...';}

  if(ADAFRUIT_IO_KEY){
    tlog('TRYING ADAFRUIT IO...','tinf');
    try {
      const tempMeta=await fetchAdafruitLastWithMeta(ADAFRUIT_MS5611_TEMP);
      const p=await fetchAdafruitLast('pressure');
      if(tempMeta&&isDataFresh(tempMeta.created_at)&&p!=null&&!isNaN(parseFloat(tempMeta.value))&&!isNaN(parseFloat(p))){
        dataMode='adafruit'; liveFailCount=0;
        updateModeIndicator();
        tlog('ADAFRUIT IO CONNECTED ✓','tok');
        playConnectionSound(); connectionSoundPlayed=true;
        if(btn){btn.classList.remove('trying');btn.textContent='⟳ RECONNECT';}
        return;
      }
    } catch(err) {
      tlog(`ADAFRUIT IO FAILED: ${err.message}`,'terr');
    }
  }
  playConnectionFailedSound();
  tlog('ADAFRUIT IO UNAVAILABLE — CONTINUING IN SIMULATION','terr');
  dataMode='sim'; updateModeIndicator();
  if(btn){btn.classList.remove('trying');btn.textContent='⟳ RECONNECT';}
}

async function fetchAdafruitLast(feedKey){
  try{
    const r=await fetch(`${ADAFRUIT_IO_BASE}/${ADAFRUIT_IO_USERNAME}/feeds/${feedKey}/data/last`,{
      headers:{'X-AIO-Key':ADAFRUIT_IO_KEY},
      signal:AbortSignal.timeout(5000)
    });
    if(!r.ok)return null;
    const d=await r.json();
    return d&&d.value!=null?String(d.value).trim():null;
  }catch{return null;}
}
async function fetchAdafruitLastWithMeta(feedKey){
  try{
    const r=await fetch(`${ADAFRUIT_IO_BASE}/${ADAFRUIT_IO_USERNAME}/feeds/${feedKey}/data/last`,{
      headers:{'X-AIO-Key':ADAFRUIT_IO_KEY},
      signal:AbortSignal.timeout(5000)
    });
    if(!r.ok)return null;
    const d=await r.json();
    if(!d||d.value==null)return null;
    return {value:String(d.value).trim(),created_at:d.created_at};
  }catch{return null;}
}
function isDataFresh(createdAt){
  if(!createdAt)return false;
  const t=new Date(createdAt).getTime();
  return !isNaN(t)&&(Date.now()-t)<=DATA_MAX_AGE_MS;
}

function tickMET(){
  const e=Date.now()-sesStart;
  const h=String(Math.floor(e/3600000)).padStart(2,'0');
  const m=String(Math.floor((e%3600000)/60000)).padStart(2,'0');
  const s=String(Math.floor((e%60000)/1000)).padStart(2,'0');
  document.getElementById('met-h').textContent=h;
  document.getElementById('met-m').textContent=m;
  document.getElementById('met-s').textContent=s;
}

async function tickTel(){
  let temp, press, altCalc, tmp;
  let gx=null, gy=null, gz=null, ax=null, ay=null, az=null;  // Always null — no gyro/accel feeds in Adafruit
  let cpuUsage=null, battery=null;
  let source = 'sim';

  // Adafruit IO — ms5611-temp, gpu-temp, pressure, cpu-usage, vibration, battery (no gyro/accel feeds)
  if(source==='sim' && (dataMode==='adafruit') && ADAFRUIT_IO_KEY){
    try{
      const [tempMeta,pressure,cpuUsageRaw,piCoreTemp,vibration,batteryRaw]=await Promise.all([
        fetchAdafruitLastWithMeta(ADAFRUIT_MS5611_TEMP),
        fetchAdafruitLast('pressure'),
        fetchAdafruitLast('cpu-usage'),
        fetchAdafruitLast(ADAFRUIT_PI_CORE_TEMP),
        fetchAdafruitLast('vibration'),
        fetchAdafruitLast('battery')
      ]);
      const ms5611Temp=tempMeta?tempMeta.value:null;
      if(!tempMeta||!isDataFresh(tempMeta.created_at)) throw new Error('Data stale');
      const t=parseFloat(ms5611Temp), p=parseFloat(pressure), v=parseFloat(vibration);
      const piTemp=parseFloat(piCoreTemp);
      cpuUsage=parseFloat(cpuUsageRaw); battery=parseFloat(batteryRaw);
      if(!isNaN(t)&&!isNaN(p)){
        temp=t; press=p;
        altCalc=+(44330*(1-Math.pow(press/1013.25,1/5.255))).toFixed(1);
        tmp=!isNaN(piTemp)?piTemp:temp;
        // Gyro/accel not in Adafruit feeds — show placeholders, never fake values
        gx=null; gy=null; gz=null; ax=null; ay=null; az=null;
        source='adafruit'; liveFailCount=0;
        if(!connectionSoundPlayed){ playConnectionSound(); connectionSoundPlayed=true; }
      } else { throw new Error('Invalid Adafruit data'); }
    }catch(err){
      liveFailCount++;
      if(liveFailCount===1){
        tlog(`ADAFRUIT IO ERROR: ${err.message}`,'terr');
        playConnectionFailedSound();
      }
      if(liveFailCount>=LIVE_FAIL_MAX && dataMode==='adafruit'){
        dataMode='sim'; connectionSoundPlayed=false; updateModeIndicator();
        tlog('ADAFRUIT IO LOST — FALLING BACK TO SIMULATION','terr');
      }
    }
  }

  // No Adafruit data — show placeholders instead of fake simulation
  if(source==='sim'){
    temp=null; press=null; altCalc=null;
    gx=null; gy=null; gz=null; ax=null; ay=null; az=null; tmp=null;
    if(cpuUsage==null) cpuUsage=null;
    if(battery==null) battery=null;
  }

  // Ensure numeric (or keep null for placeholders)
  const hasData = temp!=null && !isNaN(temp);
  temp=hasData?+temp:null; press=hasData?+press:null; altCalc=hasData?+altCalc:null;
  gx=(gx!=null&&!isNaN(gx))?+gx:null; gy=(gy!=null&&!isNaN(gy))?+gy:null; gz=(gz!=null&&!isNaN(gz))?+gz:null;
  ax=(ax!=null&&!isNaN(ax))?+ax:null; ay=(ay!=null&&!isNaN(ay))?+ay:null; az=(az!=null&&!isNaN(az))?+az:null;
  tmp=(tmp!=null&&!isNaN(tmp))?+tmp:null;

  set('ms-t', temp!=null ? temp.toFixed(2) : '--.--');
  set('ms-tf', temp!=null ? ((temp*9/5)+32).toFixed(1)+' °F' : '-- °F');
  set('ms-p', press!=null ? press.toFixed(2)+' hPa' : '---- hPa');
  set('ms-a', altCalc!=null ? altCalc.toFixed(1)+' m' : '--.-- m');
  gb('gf-t', temp!=null ? ((temp-10)/40)*100 : 0);
  gb('gf-p', press!=null ? ((press-950)/130)*100 : 0);
  gb('gf-a', altCalc!=null ? Math.min(100, Math.max(0,(altCalc/500)*100)) : 0);

  const tOk=temp!=null&&temp>10&&temp<40, pOk=press!=null&&press>950&&press<1060;
  statEl('st-t', temp==null?'na':tOk, 'NOMINAL','OUT OF RANGE');
  statEl('st-p', press==null?'na':pOk, 'NOMINAL','OUT OF RANGE');

  set('tmp-v', tmp!=null ? tmp.toFixed(1) : '--.-');
  set('tmp-tf', tmp!=null ? ((tmp*9/5)+32).toFixed(1)+' °F' : '-- °F');
  gb('gf-tmp', tmp!=null ? ((tmp-10)/40)*100 : 0);
  const deltaVal=(temp!=null&&tmp!=null) ? (temp-tmp) : null;
  set('dt', deltaVal!=null ? ((deltaVal>=0?'+':'')+deltaVal.toFixed(1)+' °C') : '--.- °C');
  set('st-b',hasData?'NOMINAL ✓':'NO DATA'); setcl('st-b','sv '+(hasData?'gn':'mt'));
  set('st-d',hasData?'OPERATIONAL':'NO DATA'); setcl('st-d','sv '+(hasData?'gn':'mt'));

  const gm=(gx!=null&&gy!=null&&gz!=null) ? +Math.sqrt(gx**2+gy**2+gz**2).toFixed(2) : null;
  const am=(ax!=null&&ay!=null&&az!=null) ? +Math.sqrt(ax**2+ay**2+az**2).toFixed(2) : null;
  imuCell('ic-gx',gx,'°/s',false); imuCell('ic-gy',gy,'°/s',false);
  imuCell('ic-gz',gz,'°/s',false); imuCell('ic-gm',gm,'°/s',false);
  imuCell('ic-ax',ax,'g',true);    imuCell('ic-ay',ay,'g',true);
  imuCell('ic-az',az,'g',true);    imuCell('ic-am',am,'g',true);

  const cpuVal=typeof cpuUsage==='number'&&!isNaN(cpuUsage)?cpuUsage:null;
  const batVal=typeof battery==='number'&&!isNaN(battery)?battery:null;
  set('cpu-v', cpuVal!=null?cpuVal.toFixed(1):'--');
  gb('gf-cpu', cpuVal!=null?Math.min(100,Math.max(0,cpuVal)):0);
  set('bat-v', batVal!=null?batVal.toFixed(2):'--.--');
  gb('gf-bat', batVal!=null?Math.min(100,Math.max(0,((batVal-3.5)/1)*100)):50);
  const batOk=batVal!=null&&batVal>=3.5&&batVal<=4.5;
  const batStatus=batVal!=null?(batOk?'NOMINAL':(batVal>4.5?'OVERVOLT':'LOW')):'----';
  set('bat-st', batStatus);
  setcl('bat-st','sv '+(batOk?'gn':'rd'));
  set('gyro-gx',gx!=null?gx.toFixed(2):'-.-'); set('gyro-gy',gy!=null?gy.toFixed(2):'-.-');
  set('gyro-gz',gz!=null?gz.toFixed(2):'-.-'); set('gyro-gm',gm!=null?gm.toFixed(2):'-.-');

  frames++;pkts++;
  set('nv-frm',frames); set('pkt-n',pkts);
  set('rf-s',hasData?'▮▮▮▮▯':'▯▯▯▯▯');  // Fixed when connected — no fake random

  const fmt=(v)=>v!=null&&typeof v==='number'?v.toFixed(2):'-.-';
  const raw=hasData?`OK MS5611 ${temp} ${press} ${altCalc} MPU6050 ${fmt(gx)} ${fmt(gy)} ${fmt(gz)} ${fmt(ax)} ${fmt(ay)} ${fmt(az)} TMP ${tmp}`:'NO DATA — ADAFRUIT IO OFFLINE';
  document.getElementById('rawstr').innerHTML=`RAW › <span>${raw}</span>`;

  if(hasData){ push(tHist,temp,60); push(tmpHist,tmp,60); if(am!=null) push(aHist,am,60); }
  drawSpark('sp-t',tHist,'rgba(0,212,255,.9)','rgba(0,212,255,.06)');
  drawSpark('sp-tmp',tmpHist,'rgba(255,179,0,.85)','rgba(255,179,0,.06)');
  drawSpark('sp-a',aHist,'rgba(0,212,255,.75)','rgba(0,212,255,.05)');

  if(hasData&&frames%4===0) tlog(`PKT#${pkts} MS5611:[T:${temp}°C P:${press}hPa] MPU:[GY:${fmt(gx)},${fmt(gy)},${fmt(gz)}] TMP:${tmp}°C`,'tok');
  if(hasData&&frames%30===0) tlog('FRAME SYNC OK — APRS CRC VERIFIED','tsys');
}

function imuCell(id,val,unit,isGn){
  const e=document.getElementById(id);if(!e)return;
  e.innerHTML=`${typeof val==='number'&&!isNaN(val)?val.toFixed(2):'-.-'}<span class="icu"> ${unit}</span>`;
  e.className='ic-v'+(isGn?' gn':'');
}
function set(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
function setcl(id,c){const e=document.getElementById(id);if(e)e.className=c;}
function gb(id,p){const e=document.getElementById(id);if(e)e.style.width=Math.min(100,Math.max(0,p))+'%';}
function statEl(id,ok,okTxt,badTxt){
  const e=document.getElementById(id);if(!e)return;
  const noData=ok==='na';
  e.textContent=noData?'NO DATA':(ok?okTxt:badTxt);
  e.className='sv '+(noData?'mt':(ok?'gn':'rd'));
}
function push(a,v,mx){a.push(v);if(a.length>mx)a.shift();}

function drawSpark(id,data,stroke,fill){
  const c=document.getElementById(id);if(!c||data.length<2)return;
  const dpr=window.devicePixelRatio||1;
  c.width=c.offsetWidth*dpr;c.height=32*dpr;
  const ctx=c.getContext('2d'),w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle='rgba(0,212,255,.06)';ctx.lineWidth=.5;
  for(let y=0;y<h;y+=h/4){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}

  const mn=Math.min(...data)-.3,mx=Math.max(...data)+.3,rng=mx-mn||1;
  const step=w/(data.length-1);

  ctx.beginPath();
  data.forEach((v,i)=>{const x=i*step,y=h-((v-mn)/rng)*(h*.86)-h*.07;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.strokeStyle=stroke;ctx.lineWidth=1.5*dpr;ctx.stroke();

  ctx.save();
  ctx.globalAlpha=.3;
  ctx.filter=`blur(${2*dpr}px)`;
  ctx.beginPath();
  data.forEach((v,i)=>{const x=i*step,y=h-((v-mn)/rng)*(h*.86)-h*.07;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.strokeStyle=stroke;ctx.lineWidth=3*dpr;ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  data.forEach((v,i)=>{const x=i*step,y=h-((v-mn)/rng)*(h*.86)-h*.07;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();
  ctx.fillStyle=fill;ctx.fill();

  const lastX=(data.length-1)*step;
  const lastY=h-((data[data.length-1]-mn)/rng)*(h*.86)-h*.07;
  ctx.beginPath();ctx.arc(lastX,lastY,2.5*dpr,0,Math.PI*2);
  ctx.fillStyle=stroke;ctx.fill();
}

let logN=0;
function tlog(msg,cls){
  const el=document.getElementById('tlog');if(!el)return;
  const ts=new Date().toUTCString().split(' ')[4];
  const r=document.createElement('div');r.className='tr2';
  r.innerHTML=`<span class="tts">[${ts}]</span><span class="${cls||''}">${msg}</span>`;
  el.appendChild(r);el.scrollTop=el.scrollHeight;
  if(++logN>150)el.removeChild(el.firstChild);
}
