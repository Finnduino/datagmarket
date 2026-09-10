const app = document.querySelector('#app');
const account = document.querySelector('#account-actions');
const loginDialog = document.querySelector('#login-dialog');
const createDialog = document.querySelector('#create-dialog');
const profileDialog = document.querySelector('#profile-dialog');
let me = null;
let tradeState = { action: 'BUY', outcome: 'YES' };
let chartRange = 'ALL';
let marketRefreshTimer;

const esc = (value = '') => String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const money = value => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pct = value => `${Math.round(Number(value) * 100)}%`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const date = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const relative = value => {
  const diff = new Date(value) - Date.now();
  if (diff <= 0) return 'closed';
  const hours = Math.floor(diff / 3600000);
  return hours > 48 ? `${Math.ceil(hours / 24)}d left` : `${Math.max(1, hours)}h left`;
};

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
}

function updateAccount() {
  account.innerHTML = me ? `
    <span class="balance">◈ ${money(me.balance)} DGC</span>
    ${['ADMIN','MODERATOR'].includes(me.role) ? `<a class="secondary staff-link" data-link href="/organizer">${me.role === 'ADMIN' ? 'Admin' : 'Staff'}</a>` : ''}
    <a class="profile-link" data-link href="/profile/${encodeURIComponent(me.username)}"><img src="${esc(me.avatarUrl)}" alt=""><span>${esc(me.username)}</span></a>
    <button class="text-button" data-logout>Exit</button>
  ` : '<button class="primary" data-login>Sign in with Telegram <span>→</span></button>';
}

function navigate(path) {
  history.pushState({}, '', path); route();
}

function marketCard(m) {
  const ranked = [...m.options].sort((a,b)=>b.probability-a.probability);
  return `<a class="market-card" href="/market/${encodeURIComponent(m.slug)}" data-link>
    <div class="card-meta"><span>${esc(m.category)}</span><span>${m.status === 'OPEN' ? relative(m.closesAt) : esc(m.status)}</span></div>
    <h3>${esc(m.question)}</h3>
    <div class="outcome-mini">${ranked.slice(0,3).map((option,index)=>`<span class="option-color-${index}"><b>${esc(option.label)}</b><strong>${pct(option.probability)}</strong></span>`).join('')}</div>
    <div class="card-bottom"><span>◈ ${money(m.volume)} volume</span></div>
  </a>`;
}

async function home() {
  const data = await api('/api/markets?status=active');
  app.innerHTML = `<div class="page">
    <div class="discovery-head"><h1>Markets</h1><button class="primary" data-create>Create market <span>＋</span></button></div>
    <div class="toolbar"><div class="discovery-filters"><div class="tabs status-tabs"><button class="tab active" data-market-status="active">Live</button><button class="tab" data-market-status="resolved">Resolved</button></div><div class="tabs category-tabs">${data.categories.map((c,i) => `<button class="tab ${i===0?'active':''}" data-category="${esc(c)}">${esc(c)}</button>`).join('')}</div></div><label class="search"><input id="market-search" placeholder="Search markets"></label></div>
    <section class="market-grid" id="market-grid">${data.markets.length ? data.markets.map(marketCard).join('') : '<div class="empty"><strong>No markets yet.</strong><button class="primary" data-create>Open the first market <span>→</span></button></div>'}</section>
  </div>`;
  let activeCategory = 'All';
  let activeStatus = 'active';
  async function filter() {
    const q = document.querySelector('#market-search').value;
    const d = await api(`/api/markets?q=${encodeURIComponent(q)}&category=${encodeURIComponent(activeCategory)}&status=${activeStatus}`);
    document.querySelector('#market-grid').innerHTML = d.markets.length ? d.markets.map(marketCard).join('') : `<div class="empty">${activeStatus === 'resolved' ? 'No resolved markets found.' : 'No live markets found.'}</div>`;
  }
  let debounce;
  document.querySelector('#market-search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(filter, 180); });
  document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
    activeCategory = button.dataset.category;
    document.querySelectorAll('[data-category]').forEach(b => b.classList.toggle('active', b === button)); filter();
  }));
  document.querySelectorAll('[data-market-status]').forEach(button => button.addEventListener('click', () => {
    activeStatus = button.dataset.marketStatus;
    activeCategory = 'All';
    document.querySelectorAll('[data-market-status]').forEach(b => b.classList.toggle('active', b === button));
    document.querySelectorAll('[data-category]').forEach(b => b.classList.toggle('active', b.dataset.category === 'All'));
    filter();
  }));
}

async function trending() {
  const data = await api('/api/markets?sort=trending&status=active');
  app.innerHTML = `<div class="page">
    <section class="listing-hero"><h1>Trending</h1><button class="primary" data-create>Create market <span>＋</span></button></section>
    <div class="section-head"><h2>Most active</h2></div>
    <section class="market-grid">${data.markets.length ? data.markets.map(m => marketCard(m).replace('<div class="card-bottom">', `<div class="trend-count">${m.recentTrades} trade${m.recentTrades === 1 ? '' : 's'} this week</div><div class="card-bottom">`)).join('') : '<div class="empty"><strong>Nothing is trending yet.</strong><button class="primary" data-create>Create market <span>→</span></button></div>'}</section>
  </div>`;
}

async function searchPage() {
  app.innerHTML = `<div class="page search-page"><section class="listing-hero"><h1>Search</h1></section>
    <label class="search-big"><span>⌕</span><input id="global-search" autofocus autocomplete="off" placeholder="Search markets or traders"></label>
    <div id="search-results"></div>
  </div>`;
  const input = document.querySelector('#global-search');
  const results = document.querySelector('#search-results');
  let debounce;
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    results.innerHTML = `<div class="search-section"><div class="section-head"><h2>Markets</h2></div><section class="market-grid">${data.markets.length ? data.markets.map(marketCard).join('') : '<div class="empty">No matching markets.</div>'}</section></div>
      <div class="search-section"><div class="section-head"><h2>Traders</h2></div><div class="people-results">${data.users.length ? data.users.map(u => `<a class="person-result" href="/profile/${encodeURIComponent(u.username)}" data-link><img class="person-avatar" src="${esc(u.avatarUrl)}" alt=""><span><strong>${esc(u.username)}</strong></span><span>◈ ${money(u.cash)}</span></a>`).join('') : '<div class="empty">No matching traders.</div>'}</div></div>`;
  };
  input.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 180); });
}

const chartDurations = { '1H': 3600000, '6H': 6 * 3600000, '1D': 86400000, '1W': 7 * 86400000, '1M': 30 * 86400000 };
const chartRanges = ['1H', '6H', '1D', '1W', '1M', 'ALL'];

function chartWindow(history, options, range) {
  const end = Date.now();
  const realTimes = history.map(point => new Date(point.createdAt).getTime()).filter(Number.isFinite);
  const earliest = realTimes.length ? Math.min(...realTimes) : end;
  const start = range === 'ALL' ? earliest : end - chartDurations[range];
  const series = options.map(option => {
    const all = history.filter(point => point.outcome === option.id).map(point => ({ ...point, time: new Date(point.createdAt).getTime() })).filter(point => Number.isFinite(point.time)).sort((a,b)=>a.time-b.time);
    const prior = [...all].reverse().find(point => point.time <= start);
    const visible = all.filter(point => point.time > start && point.time <= end);
    const points = [...(prior ? [{ ...prior, time: start }] : []), ...visible];
    if (points.length && points.at(-1).time < end) points.push({ ...points.at(-1), time: end });
    return { option, points };
  });
  return { start, end: Math.max(end, start + 1), series };
}

function chart(history, options) {
  if (!history.length) return '<div class="chart-empty">No price history yet.</div>';
  const width = 800, height = 210, pad = 8;
  const windowed = chartWindow(history, options, chartRange);
  const x = time => pad + (time - windowed.start) * (width - pad * 2) / (windowed.end - windowed.start);
  const lines = windowed.series.map(({ points },index) => {
    const path = points.map(point=>`${x(point.time)},${height-pad-point.probability*(height-pad*2)}`).join(' ');
    return path ? `<polyline class="chart-line option-line-${index%6}" points="${path}"/>` : '';
  }).join('');
  return `<div class="chart-ranges" aria-label="Chart time range">${chartRanges.map(range=>`<button class="${chartRange===range?'active':''}" data-chart-range="${range}" aria-pressed="${chartRange===range}">${range}</button>`).join('')}</div>
    <div class="chart-canvas"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Market price history">
      ${[.25,.5,.75].map(y=>`<line class="chart-grid" x1="0" x2="${width}" y1="${height-y*height}" y2="${height-y*height}"/>`).join('')}
      ${lines}<line class="chart-crosshair" x1="0" x2="0" y1="0" y2="${height}" hidden/></svg><div class="chart-tooltip" hidden></div></div>
    <div class="chart-legend">${options.map((option,index)=>`<span class="option-color-${index%6}"><i></i>${esc(option.label)} ${pct(option.probability)}</span>`).join('')}</div>`;
}

function bindChart(history, options) {
  const wrap = document.querySelector('.chart-wrap');
  const canvas = wrap?.querySelector('.chart-canvas');
  const svg = wrap?.querySelector('.chart-svg');
  const tooltip = wrap?.querySelector('.chart-tooltip');
  const crosshair = wrap?.querySelector('.chart-crosshair');
  if (!canvas || !svg || !tooltip || !crosshair) return;
  const windowed = chartWindow(history, options, chartRange);
  const interpolate = (points, time) => {
    if (!points.length) return null;
    if (time <= points[0].time) return points[0].probability;
    for (let index = 1; index < points.length; index += 1) {
      if (time <= points[index].time) {
        const before = points[index - 1], after = points[index];
        const progress = (time - before.time) / Math.max(1, after.time - before.time);
        return before.probability + (after.probability - before.probability) * progress;
      }
    }
    return points.at(-1).probability;
  };
  const move = event => {
    const rect = svg.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const time = windowed.start + ratio * (windowed.end - windowed.start);
    const svgX = ratio * 800;
    crosshair.setAttribute('x1', svgX); crosshair.setAttribute('x2', svgX); crosshair.hidden = false;
    const when = new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }).format(new Date(time));
    const ranked = windowed.series.map(({ option, points },index) => ({ option, index, value:interpolate(points,time) }))
      .filter(row=>row.value!==null).sort((a,b)=>b.value-a.value);
    tooltip.innerHTML = `<strong>${when}</strong>${ranked.map(({ option, index, value }) => `<span class="option-color-${index%6}"><i></i>${esc(option.label)} <b>${pct(value)}</b></span>`).join('')}`;
    tooltip.hidden = false;
    const canvasRect = canvas.getBoundingClientRect();
    const left = clamp(event.clientX - canvasRect.left - tooltip.offsetWidth / 2, 8, canvas.clientWidth - tooltip.offsetWidth - 8);
    const top = clamp(event.clientY - canvasRect.top - tooltip.offsetHeight - 16, 8, canvas.clientHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', event => { svg.setPointerCapture?.(event.pointerId); move(event); });
  svg.addEventListener('pointerleave', () => { tooltip.hidden = true; crosshair.hidden = true; });
  svg.addEventListener('pointerup', event => { svg.releasePointerCapture?.(event.pointerId); });
}

function marketChartMarkup(market, history) {
  return `<div class="chart-header"><strong><span>${pct(market.leadingOption?.probability || 0)}</span><b>${esc(market.leadingOption?.label || '')}</b></strong></div>${chart(history,market.options)}`;
}

function bindMarketChart(slug, history, options) {
  document.querySelectorAll('[data-chart-range]').forEach(button=>button.addEventListener('click',()=>{
    chartRange=button.dataset.chartRange;
    marketPage(slug);
  }));
  bindChart(history,options);
}

async function marketPage(slug) {
  clearInterval(marketRefreshTimer);
  const { market, history, trades } = await api(`/api/markets/${encodeURIComponent(slug)}`);
  if (!market.options.some(option=>option.id===tradeState.outcome)) tradeState.outcome = market.options[0]?.id;
  const selected = market.options.find(option=>option.id===tradeState.outcome) || market.options[0];
  const selectedIndex = market.options.findIndex(option=>option.id===selected?.id);
  const currentShares = selected?.shares || 0;
  const resolvedOption = market.options.find(option=>option.id===market.resolution);
  app.innerHTML = `<div class="page market-page"><a href="/" data-link class="back">← Markets</a>
    <div class="market-layout"><section>
      <div class="market-summary"><span class="market-category">${esc(market.category)}${market.status !== 'OPEN' ? ` · ${esc(market.status)}` : ''}</span><h1 class="market-title">${esc(market.question)}</h1>
      <div class="market-stats"><span>◈ <strong>${money(market.volume)}</strong> volume</span><span>${market.status === 'OPEN' ? `${relative(market.closesAt)} · ` : ''}${date(market.closesAt)}</span><span>By <a href="/profile/${encodeURIComponent(market.creator)}" data-link><strong>${esc(market.creator)}</strong></a></span></div></div>
      <div class="chart-wrap multi-chart">${marketChartMarkup(market,history)}</div>
      <section class="rules"><h2>Rules</h2><p>${esc(market.description)}</p><div class="resolution-source">${market.status === 'RESOLVED' && market.oracleLabel ? `Resolved by ${esc(market.oracleLabel)}` : 'Resolved by mysterious forces'}</div></section>
      <section class="activity"><h2>Activity</h2>${trades.length ? trades.map(t=>`<div class="activity-row"><div><a href="/profile/${encodeURIComponent(t.username)}" data-link><strong>${esc(t.username)}</strong></a> <span>${t.action === 'BUY' ? 'bought' : 'sold'} ${money(t.shares)} ${esc(t.outcomeLabel || t.outcome)}</span></div><span class="yes-text">◈ ${money(t.amount)}</span><span>${date(t.createdAt)}</span></div>`).join('') : '<div class="activity-row"><span>No trades yet.</span></div>'}</section>
    </section>
    <aside>${market.status === 'OPEN' ? `<div class="trade-panel">
      <div class="trade-tabs"><button class="pill-button ${tradeState.action==='BUY'?'active':''}" data-action="BUY">Buy</button><button class="pill-button ${tradeState.action==='SELL'?'active':''}" data-action="SELL">Sell</button></div>
      <div class="outcome-list">${market.options.map((option,index)=>`<button class="outcome option-color-${index%6} ${tradeState.outcome===option.id?'active':''}" data-outcome="${esc(option.id)}"><span>${esc(option.label)}</span><strong>${pct(option.probability)}</strong></button>`).join('')}</div>
      <div class="amount-label"><span>${tradeState.action==='BUY'?'Amount':'Shares'}</span><span>${me ? (tradeState.action==='BUY' ? `◈ ${money(me.balance)} available` : `${money(currentShares)} owned`) : 'Sign in required'}</span></div>
      <div class="amount-box"><input id="trade-amount" type="number" min="1" step="1" value="25"><span>${tradeState.action==='BUY'?'DGC':'SHARES'}</span></div>
      <div class="quick-amounts">${tradeState.action==='BUY' ? [10,25,50,100].map(n=>`<button data-quick="${n}">+${n}</button>`).join('') : `<button data-quick="${currentShares/4}">25%</button><button data-quick="${currentShares/2}">50%</button><button data-quick="${currentShares}">MAX</button>`}</div>
      <div class="estimate"><div><span>Market price</span><strong>${pct(selected?.probability || 0)}</strong></div><div class="to-win"><span>${tradeState.action==='BUY'?'To win':'You receive'}</span><strong id="trade-quote">—</strong></div>${me ? `<div><span>Your position</span><strong>${money(currentShares)} shares</strong></div>` : ''}</div>
      <button class="primary wide" id="trade-submit">${me ? `${tradeState.action==='BUY'?'Buy':'Sell'} ${esc(selected?.label || '')}` : 'Sign in to trade'} <span>→</span></button>
      ${market.marketType==='MULTIPLE'?`<form class="add-option" id="add-option-form"><div><input maxlength="50" required placeholder="Add an outcome"><button class="secondary">Add for 100 DGC</button></div></form>`:''}
    </div>` : `<div class="resolved-banner">${market.status === 'RESOLVED' ? `RESOLVED ${esc(resolvedOption?.label || market.resolution)}${market.oracleLabel ? ` BY ${esc(market.oracleLabel).toUpperCase()}` : ''}` : 'TRADING CLOSED'}</div>`}</aside></div></div>`;
  bindMarketChart(slug,history,market.options);
  marketRefreshTimer=setInterval(async()=>{
    if(document.hidden || decodeURIComponent(location.pathname)!==`/market/${slug}`) return;
    try {
      const fresh=await api(`/api/markets/${encodeURIComponent(slug)}`);
      const wrap=document.querySelector('.chart-wrap');
      if(!wrap) return;
      wrap.innerHTML=marketChartMarkup(fresh.market,fresh.history);
      bindMarketChart(slug,fresh.history,fresh.market.options);
    } catch (_) {}
  },5000);
  document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{tradeState.action=b.dataset.action;marketPage(slug)}));
  document.querySelectorAll('[data-outcome]').forEach(b=>b.addEventListener('click',()=>{tradeState.outcome=b.dataset.outcome;marketPage(slug)}));
  const tradeAmount=document.querySelector('#trade-amount');
  const quoteOutput=document.querySelector('#trade-quote');
  let quoteTimer; let quoteSequence=0;
  const updateQuote=()=>{
    clearTimeout(quoteTimer);
    const amount=Number(tradeAmount?.value); const sequence=++quoteSequence;
    if(!(amount>0)){if(quoteOutput)quoteOutput.textContent='—';return}
    if(quoteOutput)quoteOutput.textContent='…';
    quoteTimer=setTimeout(async()=>{
      try{
        const params=new URLSearchParams({outcome:tradeState.outcome,action:tradeState.action,amount:String(amount)});
        const quote=await api(`/api/markets/${encodeURIComponent(slug)}/quote?${params}`);
        if(sequence!==quoteSequence||!quoteOutput)return;
        quoteOutput.textContent=`◈ ${money(tradeState.action==='BUY'?quote.toWin:quote.cash)} DGC`;
      }catch(_){if(sequence===quoteSequence&&quoteOutput)quoteOutput.textContent='—'}
    },120);
  };
  tradeAmount?.addEventListener('input',updateQuote);
  document.querySelectorAll('[data-quick]').forEach(b=>b.addEventListener('click',()=>{tradeAmount.value=Math.max(0,Number(b.dataset.quick).toFixed(2));updateQuote()}));
  updateQuote();
  document.querySelector('#trade-submit')?.addEventListener('click', async () => {
    if (!me) return loginDialog.showModal();
    const button = document.querySelector('#trade-submit'); button.disabled = true;
    try {
      const result = await api(`/api/markets/${encodeURIComponent(slug)}/trade`, { method:'POST', body:JSON.stringify({ ...tradeState, amount:Number(document.querySelector('#trade-amount').value) }) });
      me = result.user; updateAccount(); toast(`${result.trade.action} ${result.trade.outcomeLabel}: ${money(result.trade.shares)} shares`); await marketPage(slug);
    } catch(e) { toast(e.message); button.disabled=false; }
  });
  document.querySelector('#add-option-form')?.addEventListener('submit',async event=>{
    event.preventDefault(); if(!me) return loginDialog.showModal();
    const button=event.currentTarget.querySelector('button'); button.disabled=true;
    try { const result=await api(`/api/markets/${encodeURIComponent(slug)}/options`,{method:'POST',body:JSON.stringify({label:event.currentTarget.querySelector('input').value})}); me=result.user; updateAccount(); tradeState.outcome=result.option.id; toast(`Added ${result.option.label}.`); await marketPage(slug); }
    catch(e){toast(e.message);button.disabled=false}
  });
}

async function leaderboard() {
  const { users } = await api('/api/leaderboard');
  app.innerHTML = `<div class="page leaderboard"><section class="leaderboard-hero"><h1>Leaderboard</h1></section><div class="rank-table"><div class="rank-row header"><span>#</span><span>Trader</span><span class="money">Net assets</span><span class="money optional-money">Positions</span><span class="money optional-money">Cash</span></div>${users.length ? users.map(u=>`<div class="rank-row"><span class="rank">${String(u.rank).padStart(2,'0')}</span><a class="trader-cell" href="/profile/${encodeURIComponent(u.username)}" data-link><img src="${esc(u.avatarUrl)}" alt=""><span>${esc(u.username)}</span></a><strong class="money">◈ ${money(u.netAssets)}</strong><span class="money optional-money">${money(u.tiedUp)}</span><span class="money optional-money">${money(u.cash)}</span></div>`).join('') : '<div class="empty">No traders yet.</div>'}</div></div>`;
}

async function profile(username) {
  const data = await api(`/api/profile/${encodeURIComponent(username)}`);
  const value = data.portfolioCashoutValue;
  const mine = me?.id === data.user.id;
  app.innerHTML = `<div class="page"><section class="profile-hero profile-heading"><img class="profile-avatar" src="${esc(data.user.avatarUrl)}" alt="${esc(data.user.username)}"><div><h1>${esc(data.user.username)}</h1>${mine ? '<button class="secondary" data-edit-profile>Edit profile</button>' : ''}</div></section>
    <div class="profile-stats"><div class="profile-stat"><span>Cash</span><strong>◈ ${money(data.user.balance)}</strong></div><div class="profile-stat"><span>Positions</span><strong>◈ ${money(value)}</strong></div><div class="profile-stat"><span>Markets</span><strong>${data.created.length}</strong></div></div>
    <div class="profile-grid"><section class="list"><h2>Positions</h2>${data.positions.length?data.positions.map(p=>`<a class="list-item" href="/market/${encodeURIComponent(p.slug)}" data-link><strong>${esc(p.question)}</strong><span class="yes-text">${esc(p.outcomeLabel || p.outcome)} · ${money(p.shares)} SHARES · ${esc(p.status)}</span></a>`).join(''):'<p class="market-description">No positions yet.</p>'}</section>
    <section class="list"><h2>Recent trades</h2>${data.trades.length?data.trades.slice(0,10).map(t=>`<a class="list-item" href="/market/${encodeURIComponent(t.slug)}" data-link><strong>${esc(t.question)}</strong><span>${t.action === 'BUY' ? 'Bought' : 'Sold'} ${money(t.shares)} ${esc(t.outcomeLabel || t.outcome)} · ◈ ${money(t.amount)}</span></a>`).join(''):'<p class="market-description">No trades yet.</p>'}</section></div>
    <section class="created-markets"><div class="section-head"><h2>Markets created</h2><span>${data.created.length}</span></div><div class="market-grid">${data.created.length ? data.created.map(marketCard).join('') : '<div class="empty">No markets created yet.</div>'}</div></section></div>`;
}

async function organizer() {
  const [{ markets }, staff, auditData] = await Promise.all([api('/api/markets'), api('/api/staff'), me.role==='ADMIN' ? api('/api/audit') : Promise.resolve({events:[]})]);
  app.innerHTML = `<div class="page staff-page"><section class="leaderboard-hero"><h1>Market resolution</h1><span>${esc(staff.role)}</span></section>
    <label class="oracle-picker"><span>Resolver identity</span><select id="true-resolver">${staff.resolvers.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')}</select></label>
    <section>${markets.length ? markets.map(m=>`<div class="organizer-market"><div><strong>${esc(m.question)}</strong><p>${esc(m.status)} · ${m.marketType==='MULTIPLE'?`${m.options.length} choices`:'Yes / No'} · ${date(m.closesAt)}</p></div><div class="organizer-actions">${m.status==='RESOLVED'?`<span class="yes-text">${esc(m.options.find(o=>o.id===m.resolution)?.label || m.resolution)} · ${esc(m.oracleLabel)}</span>`:m.options.map((option,index)=>`<button class="secondary option-color-${index%6}" data-resolve="${esc(option.id)}" data-label="${esc(option.label)}" data-slug="${esc(m.slug)}">${esc(option.label)}</button>`).join('')}${staff.role==='ADMIN'?`<button class="danger-button" data-delete-market data-slug="${esc(m.slug)}">Delete</button>`:''}</div></div>`).join('') : '<div class="empty">No markets to manage.</div>'}</section></div>`;
  if(staff.canManageRoles) app.insertAdjacentHTML('beforeend', `<div class="page staff-page"><section class="leaderboard-hero"><h1>Permissions</h1></section><label class="staff-search search-big"><span>⌕</span><input id="staff-search" placeholder="Search traders"></label><div id="staff-list">${staff.users.map(u=>`<div class="staff-row" data-staff-name="${esc(u.username.toLowerCase())}"><div><strong>${esc(u.username)}</strong><p>${esc(u.role)}</p></div>${u.role==='ADMIN'?'<span>Admin</span>':`<select data-role data-user="${esc(u.id)}"><option value="USER" ${u.role==='USER'?'selected':''}>User</option><option value="MODERATOR" ${u.role==='MODERATOR'?'selected':''}>Moderator</option></select>`}</div>`).join('')}</div></div>
    <div class="page staff-page"><section class="leaderboard-hero"><h1>Audit ledger</h1><strong>House ◈ ${money(auditData.houseBalance)}</strong></section><div class="audit-list">${auditData.events.length ? auditData.events.map(event=>`<div class="audit-row"><span>${date(event.createdAt)}</span><strong>${esc(event.type)}</strong><span>${esc(event.actor?.username || event.user?.username || 'system')}</span><span>${event.amount===undefined?'':`${event.amount>0?'+':''}${money(event.amount)} DGC`}</span><small>${esc(event.market?.question || event.details?.question || event.details?.label || event.targetUser?.username || '')}</small></div>`).join('') : '<div class="empty">No audit events yet.</div>'}</div></div>`);
  document.querySelectorAll('[data-resolve]').forEach(button=>button.addEventListener('click',async()=>{
    if(!confirm(`Resolve this market as “${button.dataset.label}”? This immediately pays winners.`)) return;
    button.disabled=true;
    try { const trueResolver=document.querySelector('#true-resolver').value; await api(`/api/markets/${encodeURIComponent(button.dataset.slug)}/resolve`,{method:'POST',body:JSON.stringify({resolution:button.dataset.resolve,trueResolver})});toast(`Resolved as ${button.dataset.label} by ${trueResolver}.`);organizer(); }
    catch(e){toast(e.message);button.disabled=false}
  }));
  document.querySelectorAll('[data-delete-market]').forEach(button=>button.addEventListener('click',async()=>{
    if(!confirm('Delete this market? Remaining position cost basis will be refunded to every trader. This cannot be undone.')) return;
    button.disabled=true; try{const result=await api(`/api/markets/${encodeURIComponent(button.dataset.slug)}`,{method:'DELETE'});toast(`Market deleted · ${money(result.refundedAmount)} DGC refunded.`);organizer()}catch(e){toast(e.message);button.disabled=false}
  }));
  document.querySelectorAll('[data-role]').forEach(select=>select.addEventListener('change',async()=>{try{await api(`/api/staff/${encodeURIComponent(select.dataset.user)}`,{method:'POST',body:JSON.stringify({role:select.value})});toast('Permission updated.')}catch(e){toast(e.message);organizer()}}));
  document.querySelector('#staff-search')?.addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();document.querySelectorAll('[data-staff-name]').forEach(row=>row.hidden=!row.dataset.staffName.includes(q))});
}

async function route() {
  clearInterval(marketRefreshTimer);
  window.scrollTo(0,0); app.innerHTML='<div class="loading-page"><span></span></div>';
  const path = decodeURIComponent(location.pathname);
  try {
    if (path === '/') await home();
    else if (path === '/trending') await trending();
    else if (path === '/search') await searchPage();
    else if (path === '/leaderboard') await leaderboard();
    else if (path === '/organizer') await organizer();
    else if (path.startsWith('/market/')) await marketPage(path.slice(8));
    else if (path.startsWith('/profile/')) await profile(path.slice(9));
    else { app.innerHTML='<div class="page"><div class="empty">That prediction does not exist. Yet.</div></div>'; }
    const activePath = path.startsWith('/market/') ? '/' : path;
    document.querySelectorAll('.desktop-nav a,.mobile-nav a').forEach(link => {
      const current = link.getAttribute('href') === activePath;
      link.classList.toggle('current', current);
      if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    app.focus({ preventScroll:true });
  } catch(e) { app.innerHTML=`<div class="page"><div class="empty">${esc(e.message)}</div></div>`; }
}

document.addEventListener('click', event => {
  if (event.target.matches('dialog[open]')) event.target.close();
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) closeButton.closest('dialog')?.close();
  const link = event.target.closest('[data-link]');
  if (link && link.origin === location.origin) { event.preventDefault(); navigate(link.pathname); }
  if (event.target.closest('[data-login]')) loginDialog.showModal();
  if (event.target.closest('[data-create]')) me ? createDialog.showModal() : loginDialog.showModal();
  if (event.target.closest('[data-edit-profile]') && me) {
    pendingAvatarData = undefined;
    document.querySelector('#profile-username').value = me.username;
    document.querySelector('#avatar-file').value = '';
    document.querySelector('#avatar-preview').src = me.avatarUrl;
    profileDialog.querySelector('[data-error]').textContent = '';
    profileDialog.showModal();
  }
  if (event.target.closest('[data-logout]')) api('/api/logout',{method:'POST'}).then(()=>{me=null;updateAccount();navigate('/')});
});
window.addEventListener('popstate', route);

let pendingAvatarData;

function readAvatar(file) {
  if (!file.type.match(/^image\/(png|jpeg|webp)$/) || file.size > 8_000_000) throw new Error('Choose a PNG, JPEG, or WebP image under 8 MB.');
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const size = Math.min(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
      canvas.getContext('2d').drawImage(image, (image.naturalWidth-size)/2, (image.naturalHeight-size)/2, size, size, 0, 0, 256, 256);
      URL.revokeObjectURL(url); resolve(canvas.toDataURL('image/webp', .82));
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
    image.src = url;
  });
}

document.querySelector('#avatar-file').addEventListener('change', async event => {
  const error = profileDialog.querySelector('[data-error]'); error.textContent = '';
  try {
    if (!event.target.files[0]) return;
    pendingAvatarData = await readAvatar(event.target.files[0]);
    document.querySelector('#avatar-preview').src = pendingAvatarData;
  } catch (e) { error.textContent = e.message; event.target.value = ''; }
});

document.querySelector('#reset-avatar').addEventListener('click', () => {
  pendingAvatarData = null;
  document.querySelector('#avatar-file').value = '';
  document.querySelector('#avatar-preview').src = `${me.avatarUrl.split('?')[0]}?default=1`;
});

document.querySelector('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const error = form.querySelector('[data-error]'); error.textContent = '';
  const button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const payload = { username: document.querySelector('#profile-username').value };
    if (pendingAvatarData !== undefined) payload.avatarData = pendingAvatarData;
    const result = await api('/api/me/profile', { method:'PATCH', body:JSON.stringify(payload) });
    me = result.user; updateAccount(); profileDialog.close(); toast('Profile updated.'); navigate(`/profile/${encodeURIComponent(me.username)}`);
  } catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
});

const marketTypeInput = document.querySelector('#market-type');
const marketOptionsInput = document.querySelector('#market-options');
const binaryOpening = document.querySelector('#binary-opening');
const multipleOpening = document.querySelector('#multiple-opening');
const closeMonth = document.querySelector('#close-month');
const closeDay = document.querySelector('#close-day');
const closeYear = document.querySelector('#close-year');
const closeHour = document.querySelector('#close-hour');
const closeMinute = document.querySelector('#close-minute');
const closesAt = document.querySelector('#closes-at');

const pad2 = value => String(value).padStart(2, '0');

function syncClosePicker() {
  const previousDay = Number(closeDay.value || 1);
  const days = new Date(Number(closeYear.value), Number(closeMonth.value) + 1, 0).getDate();
  closeDay.innerHTML = Array.from({ length: days }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('');
  closeDay.value = String(Math.min(previousDay, days));
  closesAt.value = `${closeYear.value}-${pad2(Number(closeMonth.value) + 1)}-${pad2(closeDay.value)}T${pad2(closeHour.value)}:${pad2(closeMinute.value)}`;
}

function setDefaultCloseTime() {
  const target = new Date(Date.now() + 7 * 86400000);
  target.setMinutes(Math.ceil(target.getMinutes() / 15) * 15, 0, 0);
  closeMonth.value = String(target.getMonth());
  closeYear.value = String(target.getFullYear());
  syncClosePicker();
  closeDay.value = String(target.getDate());
  closeHour.value = String(target.getHours());
  closeMinute.value = String(target.getMinutes());
  syncClosePicker();
}

const monthNames = new Intl.DateTimeFormat(undefined, { month: 'short' });
closeMonth.innerHTML = Array.from({ length: 12 }, (_, month) => `<option value="${month}">${monthNames.format(new Date(2024, month, 1))}</option>`).join('');
const currentYear = new Date().getFullYear();
closeYear.innerHTML = Array.from({ length: 6 }, (_, index) => `<option>${currentYear + index}</option>`).join('');
closeHour.innerHTML = Array.from({ length: 24 }, (_, hour) => `<option value="${hour}">${pad2(hour)}</option>`).join('');
closeMinute.innerHTML = [0, 15, 30, 45].map(minute => `<option value="${minute}">${pad2(minute)}</option>`).join('');
[closeMonth, closeYear].forEach(select => select.addEventListener('change', syncClosePicker));
[closeDay, closeHour, closeMinute].forEach(select => select.addEventListener('change', () => {
  closesAt.value = `${closeYear.value}-${pad2(Number(closeMonth.value) + 1)}-${pad2(closeDay.value)}T${pad2(closeHour.value)}:${pad2(closeMinute.value)}`;
}));
setDefaultCloseTime();

function renderOpeningOptions() {
  const labels = marketOptionsInput.value.split('\n').map(value => value.trim()).filter(Boolean).slice(0, 10);
  document.querySelector('#multi-option-picks').innerHTML = labels.map((label, index) => `<label><input type="radio" name="openingOutcome" value="${esc(label)}" ${index === 0 ? 'required' : ''}><span>${esc(label)}</span></label>`).join('');
}

marketTypeInput.addEventListener('change', () => {
  const multiple = marketTypeInput.value === 'MULTIPLE';
  binaryOpening.hidden = multiple; multipleOpening.hidden = !multiple;
  marketOptionsInput.disabled = !multiple;
  binaryOpening.querySelectorAll('input').forEach(input => input.disabled = multiple);
  multipleOpening.querySelectorAll('input').forEach(input => input.disabled = !multiple);
  if (multiple) renderOpeningOptions();
});
marketOptionsInput.addEventListener('input', renderOpeningOptions);

document.querySelector('#create-form').addEventListener('submit', async event => {
  event.preventDefault(); const form=event.currentTarget; const error=form.querySelector('[data-error]'); error.textContent='';
  try { const values=Object.fromEntries(new FormData(form)); values.closesAt=new Date(values.closesAt).toISOString(); if(values.marketType==='MULTIPLE') values.options=marketOptionsInput.value.split('\n').map(value=>value.trim()).filter(Boolean); const {market}=await api('/api/markets',{method:'POST',body:JSON.stringify(values)}); createDialog.close(); form.reset(); setDefaultCloseTime(); marketTypeInput.dispatchEvent(new Event('change')); toast('Market published.'); navigate(`/market/${market.slug}`); }
  catch(e){error.textContent=e.message}
});

try { me=(await api('/api/me')).user; } catch { me=null; }
updateAccount(); route();
