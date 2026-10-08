const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function developersPage({app,api,me,toast}){
  const data=me?await api('/api/developer/tokens'):{tokens:[]};
  app.innerHTML=`<div class="page wallet-page"><h1>Build with Data(g)Market</h1><p>Public data. Your account, with your permission.</p>
    <div class="wallet-columns"><section class="wallet-panel"><h2>Public API</h2><p>No login required. All endpoints are read-only.</p><div class="developer-endpoints">
    <code>GET /api/v1/markets</code><code>GET /api/v1/markets/{slug}</code><code>GET /api/v1/markets/{slug}/history</code><code>GET /api/v1/stats</code><code>GET /api/v1/leaderboard</code><code>GET /api/v1/profiles/{username}</code></div>
    <p>Markets: q, status (all / active / resolved), sort (newest / trending). Markets and history: limit (1–100, default 50), offset (default 0). History is oldest first. Probabilities are 0–1; amounts are DGC.</p>
    <pre>curl https://datamarket.nahi.online/api/v1/stats</pre><p><a href="/api/v1/openapi.json">OpenAPI specification ↗</a></p>
    <p>List results include items, total, limit and offset inside markets or history. Leaderboard returns the top 50. Market details include the latest 30 trades.</p>
    </section><section class="wallet-panel"><h2>MCP</h2><label>Streamable HTTP endpoint<input readonly value="https://datamarket.nahi.online/mcp"></label>
    <p>Connect without authentication for public tools. For your own data, configure an Authorization header using a token below.</p>
    <pre>Authorization: Bearer YOUR_TOKEN</pre>
    <p>Public tools: list_markets, get_market, get_history, get_stats, get_leaderboard, get_profile.</p>
    <p>Personal tools: get_my_account (account:read), get_my_wallet (wallet:read).</p>
    <p>Supports MCP 2025-06-18 and 2025-03-26. Stateless JSON responses; no standalone SSE stream. Send Accept: application/json, text/event-stream.</p>
    <p>This uses manually configured bearer tokens, not automatic OAuth discovery. Use an MCP client that supports custom Authorization headers. Telegram sign-in happens here on the website.</p></section></div>
    <section class="wallet-panel developer-access"><h2>Your API access</h2><p>Tokens cannot trade, send DGC, grant rewards, change permissions or moderate markets. Never put a personal token in public frontend code.</p>
    ${me?`<form id="token-form"><label>Client name<input name="name" required maxlength="60" placeholder="My market assistant"></label><label>Expires in<select name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><label class="token-scope"><input type="checkbox" name="account" checked> Read my account and positions</label><label class="token-scope"><input type="checkbox" name="wallet"> Read my wallet activity (including private payment notes)</label><p class="form-error"></p><button class="primary">Create token</button></form><div id="new-token" hidden></div>
    <div class="token-list">${data.tokens.map(t=>`<div class="wallet-history-row"><div><strong>${esc(t.name)}</strong><span>${esc(t.prefix)}… · ${esc(t.scopes.join(', '))}</span><span>Expires ${new Date(t.expires_at).toLocaleDateString()} · ${t.last_used_at?'Last used '+new Date(t.last_used_at).toLocaleString():'Never used'}</span></div>${t.revoked_at?'<span>Revoked</span>':Date.parse(t.expires_at)<Date.now()?'<span>Expired</span>':`<button class="secondary" data-revoke="${esc(t.id)}">Revoke</button>`}</div>`).join('')||'<p>No tokens yet.</p>'}</div>`:'<button class="primary" data-login>Sign in with Telegram</button>'}
    <h3>Personal REST endpoints</h3><pre>GET /api/v1/me
GET /api/v1/me/wallet?limit=50&amp;offset=0
Authorization: Bearer YOUR_TOKEN</pre><p>Only your token’s owner is returned. Tokens expire, can be revoked immediately, and are stored as hashes. Public requests ignore website sessions.</p>
    <p>Rate limits: 120 requests/minute per token and 1,000/minute per server connection address (shared behind the proxy). HTTP 429 includes Retry-After. Errors return an error string; MCP tool errors return isError. No trading or admin API is exposed.</p></section></div>`;
  document.querySelector('#token-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('button');button.disabled=true;form.querySelector('.form-error').textContent='';
    try{
      const scopes=[];if(form.elements.account.checked)scopes.push('account:read');if(form.elements.wallet.checked)scopes.push('wallet:read');
      const result=await api('/api/developer/tokens',{method:'POST',body:JSON.stringify({name:form.elements.name.value,days:Number(form.elements.days.value),scopes})});
      await developersPage({app,api,me,toast});
      const output=document.querySelector('#new-token');output.hidden=false;
      output.innerHTML=`<h3>Copy your token now</h3><p>This is the only time it is shown. Treat it as a password.</p><input class="token-secret" readonly aria-label="New API token" value="${esc(result.token)}"><button class="secondary" id="copy-token">Copy token</button><button class="secondary" id="hide-token">Hide</button>`;
      document.querySelector('#copy-token').onclick=async()=>{try{await navigator.clipboard.writeText(result.token);toast('Token copied');}catch{output.querySelector('input').select();}};
      document.querySelector('#hide-token').onclick=()=>{output.replaceChildren();output.hidden=true;};
    }catch(error){form.querySelector('.form-error').textContent=error.message;button.disabled=false;}
  });
  document.querySelectorAll('[data-revoke]').forEach(button=>button.onclick=async()=>{
    if(!confirm('Revoke this token? Connected clients will lose access immediately.'))return;
    button.disabled=true;try{await api('/api/developer/tokens/'+button.dataset.revoke,{method:'DELETE',body:'{}'});toast('Token revoked');await developersPage({app,api,me,toast});}catch(e){toast(e.message);button.disabled=false;}
  });
}
