const link=document.querySelector('#event-reward');
const canvas=document.querySelector('#reward-qr');
const status=document.querySelector('#reward-status');
const name=document.querySelector('#reward-name');
const amount=document.querySelector('#reward-amount');
let busy=false,expires=0;
function clear(message){canvas.hidden=true;link.href='/events';status.textContent=message;name.textContent='Participation rewards';amount.textContent='';expires=0;}
async function refreshReward(){
  if(busy)return;
  busy=true;
  try{
    const params=new URLSearchParams(location.search);
    const response=await fetch('/api/events/display'+(params.has('event')?'?event='+encodeURIComponent(params.get('event')):''),{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(response.status===401){clear('Sign in through Events as event staff, then return here.');return;}
    if(!response.ok)throw new Error();
    const data=await response.json();
    if(!data.event){clear('No open reward event assigned to you.');return;}
    if(!data.available){clear('Rewards currently unavailable. Contact the event desk.');name.textContent=data.event.name;return;}
    const url=new URL('/events',location.origin);url.searchParams.set('reward',data.token);
    await window.DgcQR.toCanvas(canvas,url.href,{width:256,margin:4,errorCorrectionLevel:'M'});
    expires=Math.min(Date.parse(data.expiresAt),Date.parse(data.event.endsAt));
    link.href=url.href;canvas.hidden=false;status.textContent='Scan to claim your event reward';name.textContent=data.event.name;
    amount.textContent='+'+Number(data.event.reward).toLocaleString(undefined,{maximumFractionDigits:2})+' DGC';
  }catch{clear('Reconnecting to event rewards…');}finally{busy=false;}
}
setInterval(refreshReward,10000);
setInterval(()=>{if(expires && Date.now()>=expires)clear('Refreshing event reward…');},1000);
window.addEventListener('online',refreshReward);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshReward();});
refreshReward();
