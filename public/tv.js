const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const percent = value => Math.round(Math.max(0,Math.min(1,Number(value)||0))*100);
const money = value => Number(value||0).toLocaleString(undefined,{maximumFractionDigits:0});
const ranked = market => [...market.options].sort((a,b)=>b.probability-a.probability);
let markets = [], selected = 0, lastSuccess = 0, fetching = false, wakeLock;
let failed = false;
let tickerSignature = '';
function render() {
  $('#market-count').textContent = `${markets.length} MARKETS`;
  if (!markets.length) {
    $('#feature').innerHTML = '<h1>The board is clear.</h1><p class="empty">New guild predictions will appear here automatically.</p>';
    $('#watchlist').innerHTML = '';
    $('#rotation').textContent = '';
    $('#ticker').textContent = 'Data(g)Market · Waiting for the next prediction';
    tickerSignature = '';
    return;
  }
  selected %= markets.length;
  const market = markets[selected], options = ranked(market), leader = options[0];
  const closed = new Date(market.closesAt).getTime() <= Date.now();
  $('#rotation').textContent = `${selected+1} / ${markets.length}`;
  $('#feature').innerHTML = `<div class="category">${esc(market.category)}</div><h1><a href="/market/${encodeURIComponent(market.slug)}">${esc(market.question)}</a></h1><div class="leader"><div class="odds">${percent(leader?.probability)}<small>%</small></div><div class="leader-label"><span>CURRENT LEADER</span>${esc(leader?.label || '—')}</div></div><div class="outcomes">${options.slice(0,4).map(option=>`<div class="outcome"><span class="outcome-name">${esc(option.label)}</span><strong>${percent(option.probability)}%</strong><svg viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true"><rect width="${Math.max(0,Math.min(100,Number(option.probability)*100))}" height="5"/></svg></div>`).join('')}</div><div class="market-meta"><span>◈ ${money(market.volume)} volume</span><span>${closed?'Awaiting resolution':`Closes ${new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(market.closesAt))} · Helsinki`}</span></div>`;
  const others = Array.from({length:Math.min(4,markets.length-1)},(_,i)=>markets[(selected+i+1)%markets.length]);
  $('#watchlist').innerHTML = others.map(m=>{const lead=ranked(m)[0];return `<a class="watch" href="/market/${encodeURIComponent(m.slug)}"><h2>${esc(m.question)}</h2><div class="watch-row"><span>${esc(lead?.label || '—')}</span><strong>${percent(lead?.probability)}%</strong></div></a>`;}).join('');
  const signature = JSON.stringify(markets.map(m=>[m.question,m.options]));
  if(signature!==tickerSignature){
    const items=markets.map(m=>{const lead=ranked(m)[0];return `<span>${esc(m.question)}<strong>${esc(lead?.label || '—')} ${percent(lead?.probability)}%</strong></span>`;}).join('');
    $('#ticker').innerHTML=`<div class="ticker-group">${items}</div><div class="ticker-group" aria-hidden="true">${items}</div>`;
    tickerSignature=signature;
  }
}
function updateStatus() {
  const fresh=!failed && lastSuccess && Date.now()-lastSuccess<25000;
  $('#connection').className=fresh?'live':'stale';
  $('#connection').textContent=fresh?'● LIVE':lastSuccess?`Reconnecting · updated ${Math.floor((Date.now()-lastSuccess)/1000)}s ago`:'Connecting…';
  $('#clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',hour:'2-digit',minute:'2-digit'}).format(new Date());
}
async function refresh() {
  if(fetching)return;
  fetching=true;
  try {
    const response=await fetch('/api/markets?status=active&sort=trending',{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Market feed unavailable');
    const data=await response.json();
    if(!Array.isArray(data.markets))throw new Error('Invalid market feed');
    const slug=markets[selected]?.slug;
    markets=data.markets;
    selected=Math.max(0,markets.findIndex(m=>m.slug===slug));
    lastSuccess=Date.now();failed=false;render();
  } catch {
    if(!lastSuccess)$('#feature').innerHTML='<h1>Reconnecting to the market…</h1><p class="empty">The board will return automatically.</p>';
    failed=true;
  } finally {fetching=false;updateStatus();}
}
async function keepAwake(){try{if('wakeLock' in navigator && document.visibilityState==='visible' && !wakeLock) {wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}}catch{}}
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();await keepAwake();}catch{$('#fullscreen').title='Use the TV browser fullscreen control';}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refresh();keepAwake();}});
window.addEventListener('online',refresh);
setInterval(refresh,10000);
setInterval(()=>{if(markets.length>1){selected=(selected+1)%markets.length;render();}},20000);
setInterval(updateStatus,1000);
updateStatus();refresh();keepAwake();
