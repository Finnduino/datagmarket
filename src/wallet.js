import { randomUUID, randomBytes } from 'node:crypto';

export function createWallet({db, json, body, requireUser, audit, houseEntry}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dgc_events (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, reward REAL NOT NULL, entry_cost REAL NOT NULL,
      budget REAL NOT NULL, spent REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_permissions (
      event_id TEXT NOT NULL REFERENCES dgc_events(id), user_id TEXT NOT NULL REFERENCES users(id),
      can_grant INTEGER NOT NULL DEFAULT 0, can_redeem INTEGER NOT NULL DEFAULT 0,
      grant_limit REAL NOT NULL DEFAULT 0, granted REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(event_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
      amount REAL NOT NULL, note TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(sender_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS event_claims (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES dgc_events(id), user_id TEXT NOT NULL REFERENCES users(id),
      staff_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(event_id,user_id,kind)
    );
    CREATE TABLE IF NOT EXISTS entry_tokens (
      token TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES dgc_events(id), user_id TEXT NOT NULL REFERENCES users(id),
      amount REAL NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, claim_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON wallet_transfers(recipient_id,created_at);
  `);
  const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
  const amount = (value,allowZero=false) => {
    if(typeof value!=='number' || !Number.isFinite(value) || value < (allowZero?0:0.01) || value>1000000 || Math.abs(value*100-Math.round(value*100))>1e-6) fail('Use a DGC amount with at most two decimal places (maximum 1,000,000).');
    return Math.round(value*100)/100;
  };
  const tx = fn => {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  const ledger = (user,kind,value,at) => db.prepare('INSERT INTO ledger(id,user_id,kind,amount,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),user,kind,value,at);
  const person = id => {const u=db.prepare('SELECT id,username,balance FROM users WHERE id=?').get(String(id||''));if(!u)fail('Trader not found.',404);return u;};
  const event = id => {const e=db.prepare('SELECT * FROM dgc_events WHERE id=?').get(id);if(!e)fail('Event not found.',404);return e;};
  const open = e => {if(!e.active || Date.now()<Date.parse(e.starts_at) || Date.now()>Date.parse(e.ends_at))fail('This event is not currently open.');};
  const permission = (u,e,kind) => {
    const p=db.prepare('SELECT * FROM event_permissions WHERE event_id=? AND user_id=?').get(e.id,u.id);
    if(u.role!=='ADMIN' && !p?.[kind==='GRANT'?'can_grant':'can_redeem'])fail('You do not have this event permission.',403);
    return p;
  };
  const admin = u => {if(u.role!=='ADMIN')fail('Admin permission required.',403);};
  const credit = (id,value) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(value,id);
  const debit = (id,value) => {if(!db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(value,id,value).changes)fail('Not enough DGC.');};

  return async (req,res,url) => {
    if(!url.pathname.startsWith('/api/wallet') && !url.pathname.startsWith('/api/events'))return false;
    const u=requireUser(req,res);if(!u)return true;
    try {
      if(req.method!=='GET' && (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json') || req.headers['sec-fetch-site']==='cross-site'))fail('Use a same-site JSON request.',403);
      const path=url.pathname;
      let result;
      if(req.method==='GET' && path==='/api/wallet') {
        result={user:person(u.id),transfers:db.prepare(`SELECT t.*,s.username sender,r.username recipient FROM wallet_transfers t JOIN users s ON s.id=t.sender_id JOIN users r ON r.id=t.recipient_id WHERE sender_id=? OR recipient_id=? ORDER BY created_at DESC LIMIT 100`).all(u.id,u.id),claims:db.prepare(`SELECT c.*,e.name event_name,s.username staff FROM event_claims c JOIN dgc_events e ON e.id=c.event_id JOIN users s ON s.id=c.staff_id WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 100`).all(u.id)};
      } else if(req.method==='GET' && path==='/api/wallet/people') {
        const q=String(url.searchParams.get('q')||'').trim();
        result={users:q.length<2?[]:db.prepare('SELECT id,username FROM users WHERE instr(lower(username),lower(?))>0 ORDER BY username LIMIT 20').all(q)};
      } else if(req.method==='GET' && path==='/api/wallet/person') {
        const p=person(url.searchParams.get('id'));result={id:p.id,username:p.username};
      } else if(req.method==='POST' && path==='/api/wallet/send') {
        const input=await body(req);const value=amount(input.amount);const key=String(input.requestKey||'');
        if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))fail('Missing payment reference.');
        const note=String(input.note||'').trim();if(note.length>140)fail('Keep the note under 140 characters.');
        result=tx(()=>{
          const old=db.prepare('SELECT * FROM wallet_transfers WHERE sender_id=? AND request_key=?').get(u.id,key);
          if(old){if(old.recipient_id!==input.recipientId || old.amount!==value || old.note!==note)fail('Payment reference already used.');return {transfer:old,balance:person(u.id).balance};}
          const recipient=person(input.recipientId);if(recipient.id===u.id)fail('Choose another trader.');
          debit(u.id,value);credit(recipient.id,value);
          const id=randomUUID(),at=new Date().toISOString();
          db.prepare('INSERT INTO wallet_transfers VALUES(?,?,?,?,?,?,?)').run(id,u.id,recipient.id,value,note,key,at);
          ledger(u.id,'TRANSFER_OUT',-value,at);ledger(recipient.id,'TRANSFER_IN',value,at);
          audit('WALLET_TRANSFER',{actorUserId:u.id,targetUserId:recipient.id,details:{transferId:id,amount:value,note},createdAt:at});
          return {transfer:{id,amount:value},balance:person(u.id).balance};
        });
      } else if(req.method==='GET' && path==='/api/events') {
        result={events:db.prepare(`SELECT e.*,p.can_grant,p.can_redeem,p.grant_limit,p.granted,
          EXISTS(SELECT 1 FROM event_claims c WHERE c.event_id=e.id AND c.user_id=? AND kind='GRANT') rewarded,
          EXISTS(SELECT 1 FROM event_claims c WHERE c.event_id=e.id AND c.user_id=? AND kind='REDEEM') redeemed
          FROM dgc_events e LEFT JOIN event_permissions p ON p.event_id=e.id AND p.user_id=? ORDER BY e.starts_at DESC`).all(u.id,u.id,u.id)};
      } else if(req.method==='POST' && path==='/api/events') {
        admin(u);const input=await body(req);
        const name=String(input.name||'').trim(),description=String(input.description||'').trim();
        if(!name || name.length>100 || description.length>1000)fail('Add an event name (up to 100 characters).');
        const starts=new Date(input.startsAt),ends=new Date(input.endsAt);
        if(!Number.isFinite(+starts)||!Number.isFinite(+ends)||ends<=starts)fail('Choose a valid event window.');
        const reward=amount(input.reward,true),entry=amount(input.entryCost,true),budget=amount(input.budget,true);
        if(reward>budget)fail('Budget must cover at least one reward.');
        result=tx(()=>{
          const at=new Date().toISOString(),id=input.id?String(input.id):randomUUID();
          const before=input.id?event(id):null;
          if(before && budget<before.spent)fail('Budget cannot be less than rewards already issued.');
          if(before)db.prepare('UPDATE dgc_events SET name=?,description=?,starts_at=?,ends_at=?,reward=?,entry_cost=?,budget=?,active=? WHERE id=?').run(name,description,starts.toISOString(),ends.toISOString(),reward,entry,budget,input.active===false?0:1,id);
          else db.prepare('INSERT INTO dgc_events(id,name,description,starts_at,ends_at,reward,entry_cost,budget,active,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,name,description,starts.toISOString(),ends.toISOString(),reward,entry,budget,input.active===false?0:1,u.id,at);
          audit('EVENT_CONFIGURE',{actorUserId:u.id,details:{eventId:id,before,after:event(id)}});return {event:event(id)};
        });
      } else {
        const match=path.match(/^\/api\/events\/([^/]+)\/(staff|grant|entry-token|entry-preview|checkin|history)$/);
        if(!match)fail('Not found.',404);
        const [,id,action]=match;
        if(req.method==='GET' && action==='staff') {
          admin(u);event(id);result={staff:db.prepare('SELECT p.*,u.username FROM event_permissions p JOIN users u ON u.id=p.user_id WHERE event_id=?').all(id)};
        } else if(req.method==='POST' && action==='staff') {
          admin(u);const input=await body(req);const limit=amount(input.limit,true);
          result=tx(()=>{event(id);person(input.userId);const before=db.prepare('SELECT * FROM event_permissions WHERE event_id=? AND user_id=?').get(id,input.userId);
            if(limit<(before?.granted||0))fail('Limit cannot be below the amount already granted.');
            db.prepare(`INSERT INTO event_permissions(event_id,user_id,can_grant,can_redeem,grant_limit) VALUES(?,?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET can_grant=excluded.can_grant,can_redeem=excluded.can_redeem,grant_limit=excluded.grant_limit`).run(id,input.userId,input.canGrant===true?1:0,input.canRedeem===true?1:0,limit);
            audit('EVENT_PERMISSION',{actorUserId:u.id,targetUserId:input.userId,details:{eventId:id,before,canGrant:input.canGrant===true,canRedeem:input.canRedeem===true,limit}});return {ok:true};});
        } else if(req.method==='GET' && action==='history') {
          const e=event(id),p=db.prepare('SELECT * FROM event_permissions WHERE event_id=? AND user_id=?').get(id,u.id);
          if(u.role!=='ADMIN' && !p?.can_grant && !p?.can_redeem)fail('Event staff permission required.',403);
          result={claims:db.prepare('SELECT c.*,u.username,s.username staff FROM event_claims c JOIN users u ON u.id=c.user_id JOIN users s ON s.id=c.staff_id WHERE event_id=? ORDER BY created_at DESC LIMIT 100').all(e.id)};
        } else if(req.method==='POST' && action==='grant') {
          const input=await body(req);
          result=tx(()=>{const e=event(id);open(e);const p=permission(u,e,'GRANT');const target=person(input.userId);
            if(target.id===u.id && u.role!=='ADMIN')fail('Another event staff member must issue your reward.');
            const old=db.prepare("SELECT * FROM event_claims WHERE event_id=? AND user_id=? AND kind='GRANT'").get(id,target.id);
            if(old)return {claim:old,alreadyProcessed:true};
            if(e.reward<=0)fail('Rewards are disabled for this event.');
            if(e.spent+e.reward>e.budget+1e-8)fail('Event reward budget exhausted.');
            if(u.role!=='ADMIN' && p.granted+e.reward>p.grant_limit+1e-8)fail('Your event grant allowance is exhausted.');
            if(db.prepare("SELECT balance FROM system_accounts WHERE name='HOUSE'").get().balance<e.reward)fail('House treasury has insufficient DGC.');
            const claimId=randomUUID(),at=new Date().toISOString();
            credit(target.id,e.reward);houseEntry('EVENT_REWARD',-e.reward,null,{eventId:id,claimId,userId:target.id},at);ledger(target.id,'EVENT_REWARD',e.reward,at);
            db.prepare('UPDATE dgc_events SET spent=ROUND(spent+?,2) WHERE id=?').run(e.reward,id);
            if(p)db.prepare('UPDATE event_permissions SET granted=ROUND(granted+?,2) WHERE event_id=? AND user_id=?').run(e.reward,id,u.id);
            db.prepare('INSERT INTO event_claims VALUES(?,?,?,?,?,?,?)').run(claimId,id,target.id,u.id,'GRANT',e.reward,at);
            audit('EVENT_REWARD',{actorUserId:u.id,targetUserId:target.id,details:{eventId:id,event:e.name,claimId,amount:e.reward},createdAt:at});return {claim:{id:claimId,amount:e.reward}};
          });
        } else if(req.method==='POST' && action==='entry-token') {
          result=tx(()=>{const e=event(id);open(e);if(e.entry_cost<=0)fail('DGC entry is disabled for this event.');
            if(person(u.id).balance<e.entry_cost)fail('Not enough DGC.');
            if(db.prepare("SELECT id FROM event_claims WHERE event_id=? AND user_id=? AND kind='REDEEM'").get(id,u.id))fail('You are already checked in.');
            db.prepare('DELETE FROM entry_tokens WHERE expires_at<? OR (event_id=? AND user_id=? AND used_at IS NULL)').run(new Date().toISOString(),id,u.id);
            const token=randomBytes(24).toString('hex'),expiresAt=new Date(Date.now()+5*60000).toISOString();
            db.prepare('INSERT INTO entry_tokens(token,event_id,user_id,amount,expires_at) VALUES(?,?,?,?,?)').run(token,id,u.id,e.entry_cost,expiresAt);
            return {token,expiresAt,amount:e.entry_cost};});
        } else if(req.method==='POST' && action==='entry-preview') {
          const input=await body(req),e=event(id);permission(u,e,'REDEEM');
          const token=db.prepare('SELECT * FROM entry_tokens WHERE token=? AND event_id=?').get(String(input.token||''),id);
          if(!token)fail('Invalid entry QR code.');
          if(token.used_at)fail('Already checked in — do not admit twice.');
          open(e);
          if(Date.parse(token.expires_at)<Date.now())fail('Entry QR expired. Ask the attendee to generate another.');
          if(token.amount!==e.entry_cost)fail('Entry price changed. Ask the attendee to generate another QR.');
          result={username:person(token.user_id).username,amount:token.amount};
        } else if(req.method==='POST' && action==='checkin') {
          const input=await body(req);
          result=tx(()=>{const e=event(id);open(e);permission(u,e,'REDEEM');
            const token=db.prepare('SELECT * FROM entry_tokens WHERE token=? AND event_id=?').get(String(input.token||''),id);
            if(!token)fail('Invalid entry QR code.');
            if(token.used_at)return {alreadyProcessed:true,claim:{id:token.claim_id}};
            if(Date.parse(token.expires_at)<Date.now())fail('Entry QR expired. Ask the attendee to generate another.');
            if(token.amount!==e.entry_cost)fail('Entry price changed. Ask the attendee to generate another QR.');
            if(db.prepare("SELECT id FROM event_claims WHERE event_id=? AND user_id=? AND kind='REDEEM'").get(id,token.user_id))fail('Attendee already checked in.');
            debit(token.user_id,e.entry_cost);const claimId=randomUUID(),at=new Date().toISOString();
            houseEntry('EVENT_ENTRY',e.entry_cost,null,{eventId:id,claimId,userId:token.user_id},at);ledger(token.user_id,'EVENT_ENTRY',-e.entry_cost,at);
            db.prepare('INSERT INTO event_claims VALUES(?,?,?,?,?,?,?)').run(claimId,id,token.user_id,u.id,'REDEEM',e.entry_cost,at);
            db.prepare('UPDATE entry_tokens SET used_at=?,claim_id=? WHERE token=?').run(at,claimId,token.token);
            audit('EVENT_ENTRY',{actorUserId:u.id,targetUserId:token.user_id,details:{eventId:id,event:e.name,claimId,amount:e.entry_cost},createdAt:at});return {claim:{id:claimId,amount:e.entry_cost},username:person(token.user_id).username};
          });
        } else fail('Not found.',404);
      }
      json(res,200,result);
    }catch(e){json(res,e.status||400,{error:e.message});}
    return true;
  };
}
