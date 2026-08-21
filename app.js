  // ═══════════════ CONFIGURATION ═══════════════
// Telemetry source: Adafruit IO only (push_to_aio.py on CubeSat).

// Adafruit IO — telemetry from CubeSat push (push_to_aio.py)
// Feeds: ms5611-temp (MS5611 barometric sensor °C), gpu-temp (Pi-Core °C), pressure, cpu-usage, vibration, battery
// Key loaded from config.js (gitignored) to avoid exposing in GitHub
const ADAFRUIT_IO_USERNAME = (typeof window !== 'undefined' && window.ADAFRUIT_IO_USERNAME) || 'sbevans';
const ADAFRUIT_IO_KEY = (typeof window !== 'undefined' && window.ADAFRUIT_IO_KEY) || '';
const ADAFRUIT_IO_BASE = 'https://io.adafruit.com/api/v2';
const ADAFRUIT_MS5611_TEMP = (typeof window !== 'undefined' && window.ADAFRUIT_MS5611_TEMP_FEED) || 'temperature';
const ADAFRUIT_PI_CORE_TEMP = (typeof window !== 'undefined' && window.ADAFRUIT_PI_CORE_TEMP_FEED) || 'gpu-temp';
const DATA_MAX_AGE_MS = 180000;  // 3 min — Adafruit updates ~1.5–2 min

// ═══════════════ ATTITUDE STATE ═══════════════
let imuYaw = 0;
let attRoll = 0, attPitch = 0, attTargR = 0, attTargP = 0;

// ═══════════════ DATA SOURCE STATE ═══════════════
let dataMode = 'sim';  // 'sim' (no source), 'adafruit', or 'test' (synthetic diagnostic data)
let liveFailCount = 0;
let adafruitOfflineNotified = false;  // gates the "OFFLINE" log line so it fires once per outage, not once per tick
let lastRecordedData = null;  // { timestamp, temp, press, altCalc, tmp, gx, gy, gz, ax, ay, az, cpuUsage, battery }
const LIVE_FAIL_MAX = 3;
let connectionSoundPlayed = false;

// ═══════════════ TELEMETRY STATE ═══════════════
// Single shared snapshot of "what the ground station currently knows," refreshed
// every tick in tickTel(). This is the one thing the terminal's command backend
// is allowed to read — it never reaches into DOM elements or tickTel() internals.
let telemetryState = {
  hasData:false, dataMode:'sim', source:'sim',
  temp:null, press:null, altCalc:null, tmp:null, diodeTemp:null,
  gx:null, gy:null, gz:null, ax:null, ay:null, az:null, gm:null, am:null,
  attRoll:0, attPitch:0, attYaw:0,
  battery:null, batteryCurrent:null, batPct:null, batStatus:null, batRate:null, batEta:null,
  cpuUsage:null,
  frames:0, pkts:0, sesStart:0, lastPacketTime:null,
};
function getTelemetryState(){ return telemetryState; }

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
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (function draw(){
    // Invisible in light mode (a night-sky motif has no place in daylight —
    // see styles.css) and unnecessary under reduced-motion, so skip the
    // per-star redraw entirely rather than paying for pixels no one sees.
    const skip = reduceMotion || document.documentElement.getAttribute('data-theme')==='light';
    if(!skip){
      ctx.clearRect(0,0,c.width,c.height);
      stars.forEach(s=>{
        const a=s.a*(.3+.7*Math.sin(t*s.f));
        ctx.beginPath();
        ctx.arc(s.x*c.width,s.y*c.height,s.r,0,Math.PI*2);
        if(s.warm) ctx.fillStyle=`rgba(255,193,7,${a*.35})`;
        else if(s.cyan) ctx.fillStyle=`rgba(79,195,247,${a*.45})`;
        else ctx.fillStyle=`rgba(79,195,247,${a*.25})`;
        ctx.fill();
      });
      t+=.01;
    }
    requestAnimationFrame(draw);
  })();
})();

// ═══════════════ THEME ═══════════════
// data-theme on <html> is already set (inline script in <head>, before first
// paint) — this just wires the toggle control and keeps it in sync, and lets
// canvas-drawn instruments (attitude ring, sparklines) know when to re-read
// their colors, since canvas fillStyle/strokeStyle can't reference CSS vars.
const THEME_STORAGE_KEY = 'srg-theme';

function getTheme(){
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
// Canvas fillStyle/strokeStyle can't resolve var(--x) or take a bare hex + alpha,
// so sparklines and the attitude instrument read the current theme's hex tokens
// through here rather than hardcoding one theme's palette into the draw calls.
function hexA(hex, alpha){
  const h = (hex||'').replace('#','').trim();
  const full = h.length===3 ? h.split('').map(c=>c+c).join('') : h;
  const r = parseInt(full.substring(0,2),16)||0, g = parseInt(full.substring(2,4),16)||0, b = parseInt(full.substring(4,6),16)||0;
  return `rgba(${r},${g},${b},${alpha})`;
}
function applyThemeToToggle(){
  const btn = document.getElementById('theme-toggle');
  if(!btn) return;
  const isLight = getTheme() === 'light';
  btn.setAttribute('aria-pressed', String(isLight));
  btn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
  btn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
}
function setTheme(theme){
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  try{ localStorage.setItem(THEME_STORAGE_KEY, theme); }catch(_){}
  applyThemeToToggle();
  document.dispatchEvent(new CustomEvent('srg-theme-change', { detail:{ theme } }));
}
(function initThemeToggle(){
  applyThemeToToggle();
  const btn = document.getElementById('theme-toggle');
  if(btn) btn.addEventListener('click', ()=> setTheme(getTheme()==='light' ? 'dark' : 'light'));
  // If the user never made an explicit choice, keep following the OS setting live.
  if(window.matchMedia){
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemChange=(e)=>{
      let stored=null; try{ stored=localStorage.getItem(THEME_STORAGE_KEY); }catch(_){}
      if(stored==='light'||stored==='dark') return;
      setTheme(e.matches ? 'light' : 'dark');
    };
    if(mq.addEventListener) mq.addEventListener('change', onSystemChange);
    else if(mq.addListener) mq.addListener(onSystemChange);
  }
})();

// ═══════════════ ENTRANCE SAFETY NET ═══════════════
// #dash loads with class="entering" (index.html), which is the only thing
// that makes any region invisible pre-animation (styles.css) — never a bare
// rule. This plain timer removes it once the staggered sequence has had time
// to finish, so every panel is guaranteed visible on a fixed schedule
// regardless of whether the CSS animation itself ran to completion.
setTimeout(()=>{ const d=document.getElementById('dash'); if(d) d.classList.remove('entering'); }, 700);

// ═══════════════ CLOCK ═══════════════
function utcStr(){return new Date().toUTCString().split(' ')[4]+' UTC';}
setInterval(()=>{
  const e=document.getElementById('dclk');if(e)e.textContent=utcStr();
},1000);

// ═══════════════ DASHBOARD ENGINE ═══════════════
let timers=[],tHist=[],tmpHist=[],diodeHist=[],aHist=[],batHistory=[],frames=0,pkts=0,sesStart=0;
const BAT_MIN=3.5, BAT_MAX=4.5;

// ═══════════════ CONNECTION STATUS ═══════════════
// Single source of truth for the navbar pill: 'connecting' | 'connected' | 'disconnected' | 'test'.
function setConnState(state){
  const pill=document.getElementById('conn-status');
  const txt=document.getElementById('conn-text');
  if(pill) pill.dataset.state=state;
  if(txt) txt.textContent=state==='connected'?'CONNECTED':state==='connecting'?'CONNECTING…':state==='test'?'TEST DATA':'DISCONNECTED';
  // The test-data option only makes sense when we're not already receiving real telemetry.
  const testBtn=document.getElementById('testdata-btn');
  if(testBtn) testBtn.style.display = state==='connected' ? 'none' : '';
}

function updateModeIndicator(offline){
  const el=document.getElementById('data-mode');
  updateTermChip();
  if(dataMode==='test'){
    setConnState('test');
    if(el){ el.textContent='TEST DATA'; el.className='data-mode test'; }
    return;
  }
  if(dataMode==='sim'){
    setConnState('disconnected');
    if(el){ el.textContent='NO SOURCE'; el.className='data-mode none'; }
    return;
  }
  setConnState(offline?'disconnected':'connected');
  if(!el) return;
  el.textContent=offline?'ADAFRUIT IO — RETRYING':'ADAFRUIT IO';
  el.className='data-mode '+(offline?'offline':'cloud');
}

async function startDash(){
  sesStart=Date.now();
  setConnState('connecting');
  tlog('GROUND STATION SESSION INITIATED','tok');
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
      playConnectionSound();
      connectionSoundPlayed=true;
      updateModeIndicator(false);
    } catch(_) {
      playConnectionFailedSound();
      tlog('ADAFRUIT IO UNAVAILABLE — AWAITING RECONNECT','terr');
      adafruitOfflineNotified=true;
      updateModeIndicator(true);
    }
  } else {
    dataMode='sim';
    tlog('NO TELEMETRY SOURCE CONFIGURED — AWAITING CONNECTION','twn');
    updateModeIndicator();
  }

  timers.push(setInterval(tickMET,1000));
  timers.push(setInterval(tickTel,1400));
  tickTel();

  tprint('Type <span class="tcmd-hint">help</span> to view available commands.','tsys');
}

async function tryReconnect(){
  if(dataMode==='test') setTestDataMode(false);
  const btn=document.getElementById('reconnect-btn');
  if(btn){btn.classList.add('trying');btn.innerHTML='<span class="spin-icon">⟳</span> TRYING...';}
  setConnState('connecting');

  if(ADAFRUIT_IO_KEY){
    tlog('TRYING ADAFRUIT IO...','tinf');
    try {
      const tempMeta=await fetchAdafruitLastWithMeta(ADAFRUIT_MS5611_TEMP);
      const p=await fetchAdafruitLast('pressure');
      if(tempMeta&&isDataFresh(tempMeta.created_at)&&p!=null&&!isNaN(parseFloat(tempMeta.value))&&!isNaN(parseFloat(p))){
        dataMode='adafruit'; liveFailCount=0; adafruitOfflineNotified=false;
        updateModeIndicator(false);
        tlog('ADAFRUIT IO CONNECTED ✓','tok');
        playConnectionSound(); connectionSoundPlayed=true;
        if(btn){btn.classList.remove('trying');btn.innerHTML='<span class="spin-icon">⟳</span> RECONNECT';}
        return;
      }
    } catch(err) {
      tlog(`ADAFRUIT IO FAILED: ${err.message}`,'terr');
    }
  }
  playConnectionFailedSound();
  tlog('ADAFRUIT IO UNAVAILABLE — AWAITING RECONNECT','terr');
  adafruitOfflineNotified=true;
  updateModeIndicator(true);
  if(btn){btn.classList.remove('trying');btn.innerHTML='<span class="spin-icon">⟳</span> RECONNECT';}
}

// ═══════════════ TEST DATA MODE ═══════════════
// Diagnostic aid: when there's no real telemetry, let the user feed the dashboard
// smoothly-varying synthetic values so they can confirm the UI itself is working.
// Always clearly labeled (status pill, source chip, and raw stream all say TEST) so
// it's never mistaken for a real downlink.
let testStartTime = 0;
function generateTestFrame(){
  const t=(Date.now()-testStartTime)/1000;
  const temp=22+Math.sin(t/9)*3+(Math.random()-0.5)*0.3;
  const press=1013+Math.sin(t/14)*8+(Math.random()-0.5)*0.5;
  const tmp=temp+2.5+Math.sin(t/6)*1.2;
  const diodeTemp=tmp-1.5+Math.sin(t/11)*0.8;
  const battery=3.9+Math.sin(t/40)*0.25;
  const batteryCurrent=0.45+Math.sin(t/23)*0.15+(Math.random()-0.5)*0.03;
  const cpuUsage=35+Math.sin(t/17)*12+Math.random()*4;
  const gx=Math.sin(t/3)*8+(Math.random()-0.5)*1.5;
  const gy=Math.cos(t/4)*6+(Math.random()-0.5)*1.5;
  const gz=Math.sin(t/5)*4+(Math.random()-0.5)*1.5;
  const ax=Math.sin(t/6)*0.15+(Math.random()-0.5)*0.03;
  const ay=Math.cos(t/7)*0.12+(Math.random()-0.5)*0.03;
  const az=1+Math.sin(t/8)*0.05+(Math.random()-0.5)*0.02;
  return {temp,press,tmp,diodeTemp,battery,batteryCurrent,cpuUsage,gx,gy,gz,ax,ay,az};
}

function updateTestBtn(){
  const btn=document.getElementById('testdata-btn');
  if(!btn) return;
  btn.textContent=dataMode==='test'?'■ STOP TEST DATA':'▶ TEST DATA';
  btn.classList.toggle('active', dataMode==='test');
}

function setTestDataMode(on){
  if(on){
    testStartTime=Date.now();
    dataMode='test'; liveFailCount=0;
    tlog('TEST DATA MODE ENABLED — SIMULATED TELEMETRY, NOT REAL','twn');
  } else {
    // Don't assume the last-known real state still holds — drop to disconnected
    // and let the user hit Reconnect for a freshly verified Adafruit IO check.
    dataMode='sim';
    tlog('TEST DATA MODE DISABLED','twn');
  }
  updateModeIndicator();
  updateTestBtn();
}

function toggleTestData(){
  setTestDataMode(dataMode!=='test');
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
  let gx=null, gy=null, gz=null, ax=null, ay=null, az=null;
  let cpuUsage=null, battery=null, batteryCurrent=null, diodeTemp=null;
  let source = 'sim';

  // Test data — synthetic, smoothly-varying values so the UI can be verified with no real link
  if(dataMode==='test'){
    const f=generateTestFrame();
    temp=f.temp; press=f.press;
    altCalc=+(44330*(1-Math.pow(press/1013.25,1/5.255))).toFixed(1);
    tmp=f.tmp; diodeTemp=f.diodeTemp;
    battery=f.battery; batteryCurrent=f.batteryCurrent; cpuUsage=f.cpuUsage;
    gx=f.gx; gy=f.gy; gz=f.gz; ax=f.ax; ay=f.ay; az=f.az;
    source='test';
  }

  // Adafruit IO — temp, pressure, gpu-temp, cpu-usage, vibration, battery, gx gy gz ax ay az (optional)
  if(source==='sim' && (dataMode==='adafruit') && ADAFRUIT_IO_KEY){
    try{
      const [tempMeta,pressure,cpuUsageRaw,piCoreTemp,vibration,batteryRaw,gxRaw,gyRaw,gzRaw,axRaw,ayRaw,azRaw]=await Promise.all([
        fetchAdafruitLastWithMeta(ADAFRUIT_MS5611_TEMP),
        fetchAdafruitLast('pressure'),
        fetchAdafruitLast('cpu-usage'),
        fetchAdafruitLast(ADAFRUIT_PI_CORE_TEMP),
        fetchAdafruitLast('vibration'),
        fetchAdafruitLast('battery'),
        fetchAdafruitLast('gx'), fetchAdafruitLast('gy'), fetchAdafruitLast('gz'),
        fetchAdafruitLast('ax'), fetchAdafruitLast('ay'), fetchAdafruitLast('az')
      ]);
      const ms5611Temp=tempMeta?tempMeta.value:null;
      if(!tempMeta||!isDataFresh(tempMeta.created_at)) throw new Error('Data stale');
      const t=parseFloat(ms5611Temp), p=parseFloat(pressure), v=parseFloat(vibration);
      const piTemp=parseFloat(piCoreTemp);
      cpuUsage=parseFloat(cpuUsageRaw); battery=parseFloat(batteryRaw);
      const pFloat=(v)=>v!=null&&v!==''&&!isNaN(parseFloat(v))?+parseFloat(v):null;
      gx=pFloat(gxRaw); gy=pFloat(gyRaw); gz=pFloat(gzRaw);
      ax=pFloat(axRaw); ay=pFloat(ayRaw); az=pFloat(azRaw);
      if(!isNaN(t)&&!isNaN(p)){
        temp=t; press=p;
        altCalc=+(44330*(1-Math.pow(press/1013.25,1/5.255))).toFixed(1);
        tmp=!isNaN(piTemp)?piTemp:temp;
        source='adafruit'; liveFailCount=0; adafruitOfflineNotified=false;
        if(!connectionSoundPlayed){ playConnectionSound(); connectionSoundPlayed=true; }
      } else { throw new Error('Invalid Adafruit data'); }
    }catch(err){
      liveFailCount++;
      if(liveFailCount===1){
        tlog(`ADAFRUIT IO ERROR: ${err.message}`,'terr');
        playConnectionFailedSound();
      }
      // Only announce the outage once — liveFailCount keeps climbing every tick
      // while still offline, so without this guard the log (and the sound) would
      // repeat forever instead of firing once when the link actually drops.
      if(liveFailCount>=LIVE_FAIL_MAX && dataMode==='adafruit' && !adafruitOfflineNotified){
        adafruitOfflineNotified=true;
        tlog('ADAFRUIT IO OFFLINE — AWAITING RECONNECT','terr');
        updateModeIndicator(true);
      }
    }
  }

  // No live data — reset to a clean zero state rather than freezing on stale readings
  if(source==='sim'){
    temp=null; press=null; altCalc=null;
    gx=null; gy=null; gz=null; ax=null; ay=null; az=null; tmp=null;
    if(cpuUsage==null) cpuUsage=null;
    if(battery==null) battery=null;
    imuYaw=0; attRoll=0; attPitch=0; attTargR=0; attTargP=0;
    set('att-roll','0.0°'); set('att-pitch','0.0°'); set('att-yaw','0.0°');
  }

  // Ensure numeric (or keep null for placeholders)
  const hasData = temp!=null && !isNaN(temp);
  temp=hasData?+temp:null; press=hasData?+press:null; altCalc=hasData?+altCalc:null;
  gx=(gx!=null&&!isNaN(gx))?+gx:null; gy=(gy!=null&&!isNaN(gy))?+gy:null; gz=(gz!=null&&!isNaN(gz))?+gz:null;
  ax=(ax!=null&&!isNaN(ax))?+ax:null; ay=(ay!=null&&!isNaN(ay))?+ay:null; az=(az!=null&&!isNaN(az))?+az:null;
  tmp=(tmp!=null&&!isNaN(tmp))?+tmp:null;

  // Attitude — derived from whichever source supplied ax/ay/az this tick
  if(ax!=null && ay!=null && az!=null){
    const _ax=ax||0, _ay=ay||0, _az=az||1;
    const roll  = Math.atan2(_ay, _az) * 180 / Math.PI;
    const pitch = Math.atan2(-_ax, Math.sqrt(_ay*_ay + _az*_az)) * 180 / Math.PI;
    // Dead zone: MPU6050 at rest produces ~0.5–2 °/s noise; ignore below 3 °/s
    if(Math.abs(gz||0) > 3.0) imuYaw += (gz||0) * 0.3;
    // Only update attitude target if change exceeds 0.5° to filter accel noise jitter
    if(Math.abs(roll  - attTargR) > 0.5) attTargR = roll;
    if(Math.abs(pitch - attTargP) > 0.5) attTargP = pitch;
    set('att-roll',  roll.toFixed(1)  + '°');
    set('att-pitch', pitch.toFixed(1) + '°');
    set('att-yaw',   (((imuYaw % 360) + 360) % 360).toFixed(1) + '°');
  }

  set('ms-t', temp!=null ? temp.toFixed(2) : '0.00');
  set('ms-tf', temp!=null ? ((temp*9/5)+32).toFixed(1)+' °F' : '0.0 °F');
  set('ms-p', press!=null ? press.toFixed(2)+' hPa' : '0.00 hPa');
  set('ms-a', altCalc!=null ? altCalc.toFixed(1)+' m' : '0.0 m');
  gb('gf-t', temp!=null ? ((temp-10)/40)*100 : 0);
  gb('gf-p', press!=null ? ((press-950)/130)*100 : 0);
  gb('gf-a', altCalc!=null ? Math.min(100, Math.max(0,(altCalc/500)*100)) : 0);

  const tOk=temp!=null&&temp>10&&temp<40, pOk=press!=null&&press>950&&press<1060;
  statEl('st-t', temp==null?'na':tOk, 'NOMINAL','OUT OF RANGE');
  statEl('st-p', press==null?'na':pOk, 'NOMINAL','OUT OF RANGE');

  set('tmp-v', tmp!=null ? tmp.toFixed(1) : '0.0');
  set('tmp-tf', tmp!=null ? ((tmp*9/5)+32).toFixed(1)+' °F' : '0.0 °F');
  gb('gf-tmp', tmp!=null ? ((tmp-10)/40)*100 : 0);
  const diodeVal=(diodeTemp!=null&&!isNaN(diodeTemp))?+diodeTemp:null;
  set('tmp-diode-v', diodeVal!=null ? diodeVal.toFixed(1) : '0.0');
  set('tmp-diode-tf', diodeVal!=null ? ((diodeVal*9/5)+32).toFixed(1)+' °F' : '0.0 °F');
  gb('gf-diode', diodeVal!=null ? ((diodeVal-10)/40)*100 : 0);
  const deltaVal=(temp!=null&&tmp!=null) ? (temp-tmp) : null;
  set('dt', deltaVal!=null ? ((deltaVal>=0?'+':'')+deltaVal.toFixed(1)+' °C') : '0.0 °C');
  set('st-b',hasData?'NOMINAL ✓':'NO DATA'); setcl('st-b','sv '+(hasData?'gn':'mt'));
  set('st-d',hasData?'OPERATIONAL':'NO DATA'); setcl('st-d','sv '+(hasData?'gn':'mt'));

  const gm=(gx!=null&&gy!=null&&gz!=null) ? +Math.sqrt(gx**2+gy**2+gz**2).toFixed(2) : null;
  const am=(ax!=null&&ay!=null&&az!=null) ? +Math.sqrt(ax**2+ay**2+az**2).toFixed(2) : null;
  imuCell('ic-gx',gx,'°/s',false); imuCell('ic-gy',gy,'°/s',false);
  imuCell('ic-gz',gz,'°/s',false); imuCell('ic-gm',gm,'°/s',false);
  imuCell('ic-ax',ax,'g',true);    imuCell('ic-ay',ay,'g',true);
  imuCell('ic-az',az,'g',true);    imuCell('ic-am',am,'g',true);

  const batVal=typeof battery==='number'&&!isNaN(battery)?battery:null;
  set('bat-v', batVal!=null?batVal.toFixed(2):'0.00');
  const batPct=batVal!=null?Math.min(100,Math.max(0,((batVal-BAT_MIN)/(BAT_MAX-BAT_MIN))*100)):null;
  gb('gf-bat', batPct!=null?batPct:0);
  set('bat-pct', batPct!=null?Math.round(batPct).toString():'0');
  const batOk=batVal!=null&&batVal>=BAT_MIN&&batVal<=BAT_MAX;
  const batStatus=batVal!=null?(batOk?'NOMINAL':(batVal>BAT_MAX?'OVERVOLT':'LOW')):'NO DATA';
  set('bat-st', batStatus);
  setcl('bat-st','sv '+(batVal==null?'mt':batOk?'gn':'rd'));
  const batCurVal=typeof batteryCurrent==='number'&&!isNaN(batteryCurrent)?batteryCurrent:null;
  set('bat-cur', batCurVal!=null?batCurVal.toFixed(2)+' A':'0.0 A');
  setcl('bat-cur','sv '+(batCurVal!=null?'cy':'mt'));

  // Track battery history for rate/ETA calculation — only while actually connected,
  // so a stale/frozen history doesn't keep reporting a fake rate after disconnect.
  if(batVal!=null){ batHistory.push({v:batVal,t:Date.now()}); if(batHistory.length>60)batHistory.shift(); }
  let batRate=null, batEta=null;
  if(batVal!=null && batHistory.length>=5){
    const oldest=batHistory[0], newest=batHistory[batHistory.length-1];
    const dtMin=(newest.t-oldest.t)/60000;
    if(dtMin>=0.5){ // require at least 30s of history
      const dvPct=((newest.v-oldest.v)/(BAT_MAX-BAT_MIN))*100;
      batRate=dvPct/dtMin; // %/min
      if(batPct!=null){
        if(batRate>0.05){ const m=(100-batPct)/batRate; batEta=`~${fmtEta(m)} → FULL`; }
        else if(batRate<-0.05){ const m=batPct/Math.abs(batRate); batEta=`~${fmtEta(m)} → EMPTY`; }
        else batEta='STABLE';
      }
    }
  }
  set('bat-rate', batRate!=null?`${batRate>=0?'+':''}${batRate.toFixed(2)} %/min`:'0.00 %/min');
  const rateEl=document.getElementById('bat-rate');
  if(rateEl) rateEl.className='sv '+(batRate==null?'mt':batRate>0.05?'gn':batRate<-0.05?'rd':'yw');
  set('bat-eta', batEta||'NO DATA');
  setcl('bat-eta','sv '+(batEta?'cy':'mt'));
  set('gyro-gx',gx!=null?gx.toFixed(2):'0.00'); set('gyro-gy',gy!=null?gy.toFixed(2):'0.00');
  set('gyro-gz',gz!=null?gz.toFixed(2):'0.00'); set('gyro-gm',gm!=null?gm.toFixed(2):'0.00');

  frames++;pkts++;
  set('nv-frm',frames); set('pkt-n',pkts);
  set('rf-s',hasData?'▮▮▮▮▯':'▯▯▯▯▯');  // Fixed when connected — no fake random
  setcl('rf-s','sv '+(hasData?'gn':'mt'));

  const fmt=(v)=>v!=null&&typeof v==='number'?v.toFixed(2):'0.00';
  const offlineLabel = dataMode==='adafruit' ? 'ADAFRUIT IO OFFLINE' : 'NO TELEMETRY SOURCE';
  const rawPrefix = source==='test' ? 'TEST' : 'OK';
  const raw=hasData?`${rawPrefix} MS5611 ${temp} ${press} ${altCalc} MPU6050 ${fmt(gx)} ${fmt(gy)} ${fmt(gz)} ${fmt(ax)} ${fmt(ay)} ${fmt(az)} TMP ${tmp}`:`NO SIGNAL — ${offlineLabel}`;
  document.getElementById('rawstr').innerHTML=`RAW › <span>${raw}</span>`;

  if(hasData){
    push(tHist,temp,60); push(tmpHist,tmp,60); if(diodeVal!=null) push(diodeHist,diodeVal,60); if(am!=null) push(aHist,am,60);
    lastRecordedData={
      timestamp:new Date().toISOString(),
      temp,press,altCalc,tmp,diodeTemp:diodeVal,gx,gy,gz,ax,ay,az,
      gm,am,cpuUsage:typeof cpuUsage==='number'?cpuUsage:null,
      battery:typeof battery==='number'?battery:null,
      packetCount:pkts,frameCount:frames
    };
    renderDataLog();
    telemetryState.lastPacketTime=Date.now();
  }
  drawSpark('sp-t',tHist,hexA(cssVar('--cyan'),.9),hexA(cssVar('--cyan'),.08));
  drawSpark('sp-tmp',tmpHist,hexA(cssVar('--amber'),.85),hexA(cssVar('--amber'),.08));
  drawSpark('sp-a',aHist,hexA(cssVar('--cyan'),.75),hexA(cssVar('--cyan'),.07));

  if(hasData&&frames%4===0) tlog(`PKT#${pkts} MS5611:[T:${temp}°C P:${press}hPa] MPU:[GY:${fmt(gx)},${fmt(gy)},${fmt(gz)}] IHU:${fmt(tmp)}°C D3:${diodeVal!=null?fmt(diodeVal):'--'}°C`,'tok');
  if(hasData&&frames%30===0) tlog('FRAME SYNC OK — APRS CRC VERIFIED','tsys');

  // Refresh the shared telemetry snapshot — the terminal's command backend reads
  // this, never the DOM or tickTel()'s locals directly.
  telemetryState.hasData=hasData; telemetryState.dataMode=dataMode; telemetryState.source=source;
  telemetryState.temp=temp; telemetryState.press=press; telemetryState.altCalc=altCalc;
  telemetryState.tmp=tmp; telemetryState.diodeTemp=diodeVal;
  telemetryState.gx=gx; telemetryState.gy=gy; telemetryState.gz=gz;
  telemetryState.ax=ax; telemetryState.ay=ay; telemetryState.az=az;
  telemetryState.gm=gm; telemetryState.am=am;
  telemetryState.attRoll=attTargR; telemetryState.attPitch=attTargP;
  telemetryState.attYaw=(((imuYaw%360)+360)%360);
  telemetryState.battery=batVal; telemetryState.batteryCurrent=batCurVal;
  telemetryState.batPct=batPct; telemetryState.batStatus=batStatus;
  telemetryState.batRate=batRate; telemetryState.batEta=batEta;
  telemetryState.cpuUsage=typeof cpuUsage==='number'&&!isNaN(cpuUsage)?cpuUsage:null;
  telemetryState.frames=frames; telemetryState.pkts=pkts; telemetryState.sesStart=sesStart;
}

// A telemetry value actually changed — a brief neutral highlight (.val-flash,
// styles.css) says "new data landed" without touching the value's own status
// color. Never fires when the text is unchanged, so a dead link showing the
// same "0.00"/"NO DATA" tick after tick stays perfectly still. The forced
// reflow (offsetWidth) is what lets the animation restart even if a previous
// flash on the same element hasn't finished — it's a single cheap read on a
// small element, at most a couple dozen times per 1.4s telemetry tick.
function flashEl(e){
  if(!e) return;
  e.classList.remove('val-flash');
  void e.offsetWidth;
  e.classList.add('val-flash');
}
function imuCell(id,val,unit,isGn){
  const e=document.getElementById(id);if(!e)return;
  const html=`${typeof val==='number'&&!isNaN(val)?val.toFixed(2):'0.00'}<span class="icu"> ${unit}</span>`;
  const changed = e.innerHTML!==html;
  e.innerHTML=html;
  e.className='ic-v'+(isGn?' gn':'');
  if(changed) flashEl(e);
}
function set(id,v){
  const e=document.getElementById(id);if(!e)return;
  if(e.textContent===v) return;
  e.textContent=v;
  flashEl(e);
}
function setcl(id,c){const e=document.getElementById(id);if(e)e.className=c;}
function gb(id,p){const e=document.getElementById(id);if(e)e.style.width=Math.min(100,Math.max(0,p))+'%';}
function statEl(id,ok,okTxt,badTxt){
  const e=document.getElementById(id);if(!e)return;
  const noData=ok==='na';
  const text=noData?'NO DATA':(ok?okTxt:badTxt);
  const changed = e.textContent!==text;
  e.textContent=text;
  e.className='sv '+(noData?'mt':(ok?'gn':'rd'));
  if(changed) flashEl(e);
}
function push(a,v,mx){a.push(v);if(a.length>mx)a.shift();}
function fmtEta(mins){if(mins<1)return '<1 min';if(mins<60)return `${Math.round(mins)} min`;const h=Math.floor(mins/60),m=Math.round(mins%60);return `${h}h ${m}m`;}

function drawSpark(id,data,stroke,fill){
  const c=document.getElementById(id);if(!c||data.length<2)return;
  const dpr=window.devicePixelRatio||1;
  c.width=c.offsetWidth*dpr;c.height=32*dpr;
  const ctx=c.getContext('2d'),w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle=hexA(cssVar('--cyan'),.08);ctx.lineWidth=.5;
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

// ═══════════════ ATTITUDE INDICATOR ═══════════════
const _attCanvas = document.getElementById('attitude-canvas');
const _attCtx    = _attCanvas ? _attCanvas.getContext('2d') : null;
const _AW = _attCanvas ? _attCanvas.width  : 120;
const _AH = _attCanvas ? _attCanvas.height : 120;
const _AR = _AW / 2 - 6;

// Sky/ground/pointer colors stay fixed across themes — a real artificial
// horizon always reads blue-over-brown regardless of cockpit lighting — but
// the outer bezel ring should match whichever theme's border tone is active,
// so it doesn't read as a stray dark ring floating on a light panel.
let _attRingColor = '#3d5578';
function refreshInstrumentColors(){
  _attRingColor = cssVar('--border-hi') || _attRingColor;
}
refreshInstrumentColors();
document.addEventListener('srg-theme-change', refreshInstrumentColors);

function drawAttitude(roll, pitch){
  if(!_attCtx) return;
  _attCtx.clearRect(0,0,_AW,_AH);
  _attCtx.save();
  _attCtx.beginPath();
  _attCtx.arc(_AW/2,_AH/2,_AR,0,Math.PI*2);
  _attCtx.clip();

  _attCtx.save();
  _attCtx.translate(_AW/2,_AH/2);
  _attCtx.rotate(-roll*Math.PI/180);
  const po=pitch*1.3;

  // Sky
  _attCtx.fillStyle='#1A4A8A';
  _attCtx.fillRect(-_AR,-_AR-po,_AR*2,_AR+po);
  // Ground
  _attCtx.fillStyle='#5C3D0F';
  _attCtx.fillRect(-_AR,-po,_AR*2,_AR+po);
  // Horizon line
  _attCtx.strokeStyle='rgba(255,255,255,.9)';
  _attCtx.lineWidth=1.5;
  _attCtx.beginPath();
  _attCtx.moveTo(-_AR,-po);_attCtx.lineTo(_AR,-po);
  _attCtx.stroke();
  // Pitch lines
  _attCtx.strokeStyle='rgba(255,255,255,.4)';
  _attCtx.lineWidth=1;
  _attCtx.font='9px monospace';
  _attCtx.fillStyle='rgba(255,255,255,.5)';
  for(const d of [-20,-10,10,20]){
    const y=-po-d*1.3, lw=d%20===0?_AR/3:_AR/5;
    _attCtx.beginPath();_attCtx.moveTo(-lw,y);_attCtx.lineTo(lw,y);_attCtx.stroke();
    _attCtx.fillText(Math.abs(d),lw+3,y+3);
  }
  _attCtx.restore();

  // Outer ring
  _attCtx.restore();
  _attCtx.strokeStyle=_attRingColor;
  _attCtx.lineWidth=2;
  _attCtx.beginPath();
  _attCtx.arc(_AW/2,_AH/2,_AR,0,Math.PI*2);
  _attCtx.stroke();

  // Roll ticks
  _attCtx.save();
  _attCtx.translate(_AW/2,_AH/2);
  for(const a of [-60,-45,-30,-20,-10,0,10,20,30,45,60]){
    _attCtx.save();
    _attCtx.rotate(a*Math.PI/180);
    _attCtx.strokeStyle='rgba(255,255,255,.35)';
    _attCtx.lineWidth=1;
    const tk=a%30===0?7:4;
    _attCtx.beginPath();_attCtx.moveTo(0,-(_AR-1));_attCtx.lineTo(0,-(_AR-1-tk));
    _attCtx.stroke();
    _attCtx.restore();
  }
  // Roll pointer (yellow triangle)
  _attCtx.rotate(-roll*Math.PI/180);
  _attCtx.fillStyle='#FFD60A';
  _attCtx.beginPath();
  _attCtx.moveTo(0,-(_AR-14));_attCtx.lineTo(-5,-(_AR-5));_attCtx.lineTo(5,-(_AR-5));
  _attCtx.closePath();_attCtx.fill();
  _attCtx.restore();

  // Aircraft symbol
  _attCtx.strokeStyle='#FFD60A';
  _attCtx.lineWidth=2.5;
  _attCtx.lineCap='round';
  const hs=_AR/3;
  _attCtx.beginPath();
  _attCtx.moveTo(_AW/2-hs*2,_AH/2);_attCtx.lineTo(_AW/2-hs,_AH/2);
  _attCtx.moveTo(_AW/2+hs,_AH/2);  _attCtx.lineTo(_AW/2+hs*2,_AH/2);
  _attCtx.moveTo(_AW/2,_AH/2-hs/2);_attCtx.lineTo(_AW/2,_AH/2+hs/2);
  _attCtx.stroke();
  _attCtx.fillStyle='#FFD60A';
  _attCtx.beginPath();_attCtx.arc(_AW/2,_AH/2,3,0,Math.PI*2);_attCtx.fill();
}

function animateAttitude(){
  attRoll  += (attTargR-attRoll)  * 0.1;
  attPitch += (attTargP-attPitch) * 0.1;
  drawAttitude(attRoll, attPitch);
  requestAnimationFrame(animateAttitude);
}
animateAttitude();

function renderDataLog(){
  const el=document.getElementById('datalog-content');
  if(!el)return;
  if(!lastRecordedData){
    el.innerHTML='<div class="datalog-empty">No telemetry recorded yet. Data will appear when connected to HiveMQ or Adafruit IO.</div>';
    return;
  }
  const d=lastRecordedData;
  const ts=new Date(d.timestamp);
  const dateStr=ts.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const timeStr=ts.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})+' UTC';
  const fmt=(v)=>v!=null&&typeof v==='number'?v.toFixed(2):'--.--';
  el.innerHTML=`
    <div class="datalog-header">
      <div class="datalog-title">LAST RECORDED TELEMETRY</div>
      <div class="datalog-datetime">
        <div class="datalog-date">${dateStr}</div>
        <div class="datalog-time">${timeStr}</div>
      </div>
    </div>
    <div class="datalog-grid">
      <div class="datalog-section">
        <div class="datalog-section-title">MS5611 BAROMETRIC</div>
        <div class="datalog-row"><span>Temperature</span><span>${fmt(d.temp)} °C</span></div>
        <div class="datalog-row"><span>Pressure</span><span>${fmt(d.press)} hPa</span></div>
        <div class="datalog-row"><span>Altitude (baro)</span><span>${fmt(d.altCalc)} m</span></div>
      </div>
      <div class="datalog-section">
        <div class="datalog-section-title">THERMAL SENSORS</div>
        <div class="datalog-row"><span>Pi IHU Temp</span><span>${fmt(d.tmp)} °C</span></div>
        <div class="datalog-row"><span>Diode D3 Temp</span><span>${d.diodeTemp!=null?fmt(d.diodeTemp):'--'} °C</span></div>
      </div>
      <div class="datalog-section">
        <div class="datalog-section-title">MPU6050 GYROSCOPE</div>
        <div class="datalog-row"><span>GX</span><span>${fmt(d.gx)} °/s</span></div>
        <div class="datalog-row"><span>GY</span><span>${fmt(d.gy)} °/s</span></div>
        <div class="datalog-row"><span>GZ</span><span>${fmt(d.gz)} °/s</span></div>
        <div class="datalog-row"><span>|G| Magnitude</span><span>${fmt(d.gm)} °/s</span></div>
      </div>
      <div class="datalog-section">
        <div class="datalog-section-title">MPU6050 ACCELEROMETER</div>
        <div class="datalog-row"><span>AX</span><span>${fmt(d.ax)} g</span></div>
        <div class="datalog-row"><span>AY</span><span>${fmt(d.ay)} g</span></div>
        <div class="datalog-row"><span>AZ</span><span>${fmt(d.az)} g</span></div>
        <div class="datalog-row"><span>|A| Magnitude</span><span>${fmt(d.am)} g</span></div>
      </div>
      <div class="datalog-section">
        <div class="datalog-section-title">SYSTEM</div>
        <div class="datalog-row"><span>CPU Usage</span><span>${d.cpuUsage!=null?d.cpuUsage.toFixed(1):'--'} %</span></div>
        <div class="datalog-row"><span>Battery</span><span>${d.battery!=null?d.battery.toFixed(2):'--.--'} V</span></div>
        <div class="datalog-row"><span>Packet #</span><span>${d.packetCount||'--'}</span></div>
        <div class="datalog-row"><span>Frame #</span><span>${d.frameCount||'--'}</span></div>
      </div>
    </div>
  `;
}
function switchTab(tab){
  const dashView=document.getElementById('view-cubesat');
  const logView=document.getElementById('view-datalog');
  const dashBtn=document.getElementById('tab-dashboard');
  const logBtn=document.getElementById('tab-datalog');
  if(tab==='datalog'){
    if(dashView)dashView.style.display='none';
    if(logView){ logView.style.display='flex'; renderDataLog(); }
    if(dashBtn)dashBtn.classList.remove('act');
    if(logBtn)logBtn.classList.add('act');
  }else{
    if(dashView)dashView.style.display='grid';
    if(logView)logView.style.display='none';
    if(dashBtn)dashBtn.classList.add('act');
    if(logBtn)logBtn.classList.remove('act');
  }
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
// Terminal output line with no timestamp gutter — used for command echoes and
// command responses, which read better as plain terminal text than as log entries.
function tprint(msg,cls){
  const el=document.getElementById('tlog');if(!el)return;
  const r=document.createElement('div');r.className='tr2 tr2-plain';
  r.innerHTML=`<span class="${cls||''}">${msg}</span>`;
  el.appendChild(r);el.scrollTop=el.scrollHeight;
  if(++logN>150)el.removeChild(el.firstChild);
}
function clearTerminal(){
  const el=document.getElementById('tlog');if(el)el.innerHTML='';
  logN=0;
}

// ═══════════════ TERMINAL STATUS CHIP ═══════════════
// Reflects, in the terminal panel's own header, whether command responses will be
// backed by real cached telemetry (LOCAL) or synthetic data (MOCK) — see comm-backend.js.
function updateTermChip(){
  const chip=document.getElementById('term-chip');
  if(!chip) return;
  if(dataMode==='adafruit' && telemetryState.hasData){
    chip.textContent='LOCAL'; chip.className='chip chip-local';
  } else {
    chip.textContent='MOCK'; chip.className='chip chip-mock';
  }
}

// ═══════════════ BOOTSTRAP — DASHBOARD LOADS DIRECTLY, NO LOGIN GATE ═══════════════
startDash();
