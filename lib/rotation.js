import { AppError, PREFIX, env, config, redis, read, write, withLock, authorize, endpoint, input, only, equal, now } from './core.js';
import { scheduleRotationPost, cancelRotationPost } from './records.js';

const KEY='social-rotation';
const ZONE='America/Chicago';
const ORDER=['BBQ','MUSIC','BOOK'];
const DAY=86400000;
function qstashBase(){return (env().QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/,'');}
async function registerRefillSchedule(){
  if(!env().QSTASH_TOKEN || !env().DJOMS_JOB_SECRET || env().DJOMS_JOB_SECRET.length<32)
    throw new AppError('Automatic scheduler setup is incomplete. Check the QStash connection.',503);
  const url=qstashBase()+'/v2/schedules/'+config().origin+'/api/meta/rotation-cron';
  let response,data;
  try{
    response=await fetch(url,{
      method:'POST',
      headers:{
        Authorization:'Bearer '+env().QSTASH_TOKEN,
        'Content-Type':'application/json',
        'Upstash-Cron':'0 0 * * *',
        'Upstash-Method':'POST',
        'Upstash-Forward-Authorization':'Bearer '+env().DJOMS_JOB_SECRET,
        'Upstash-Schedule-Id':'docjaks-social-rotation-daily',
        'Upstash-Retries':'3',
        'Upstash-Timeout':'30s',
        'Upstash-Redact-Fields':'header[Authorization]'
      },
      body:'{}',
      signal:AbortSignal.timeout(12000)
    });
    data=await response.json();
  }catch{throw new AppError('Could not register the daily QStash rotation check. Nothing was activated.',503);}
  if(!response.ok || !data?.scheduleId)
    throw new AppError('QStash did not confirm the daily rotation schedule. Nothing was activated.',503);
  return data.scheduleId;
}
async function removeRefillSchedule(scheduleId){
  if(!scheduleId)return;
  const url=qstashBase()+'/v2/schedules/'+encodeURIComponent(scheduleId);
  try{
    const response=await fetch(url,{
      method:'DELETE',
      headers:{Authorization:'Bearer '+env().QSTASH_TOKEN},
      signal:AbortSignal.timeout(10000)
    });
    if(!response.ok && response.status!==404)throw new Error('QStash did not remove the daily check.');
  }catch{throw new AppError('Could not stop the daily QStash schedule. Please check QStash schedules.',503);}
}

const formatter=new Intl.DateTimeFormat('en-US',{
  timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
});
function zonedParts(ms) {
  return Object.fromEntries(formatter.formatToParts(new Date(ms))
    .filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
function instantForWall(wall) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) throw new AppError('Choose the date and time for the first post.');
  const [year,month,day,hour,minute]=wall.match(/\d+/g).map(Number);
  const naive=Date.UTC(year,month-1,day,hour,minute);
  const valid=new Date(naive);
  if (valid.getUTCFullYear()!==year || valid.getUTCMonth()!==month-1 ||
      valid.getUTCDate()!==day || valid.getUTCHours()!==hour || valid.getUTCMinutes()!==minute)
    throw new AppError('The selected posting date or time is invalid.');
  let epoch=naive;
  for(let j=0;j<5;j++){
    const p=zonedParts(epoch);
    const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    const next=naive-(represented-epoch);
    if(Math.abs(next-epoch)<1000){epoch=next;break;}
    epoch=next;
  }
  const found=zonedParts(epoch);
  if(found.year!==year||found.month!==month||found.day!==day||found.hour!==hour||found.minute!==minute)
    throw new AppError('That clock time does not exist in the chosen time zone because of daylight-saving time.');
  return new Date(epoch).toISOString();
}
function ordinal(r){
  const match=String(r.title||'').trim().match(/^(?:(?:BBQ|BOOK|BK|MU|MUSIC)[\s_-]*)?0*(\d{1,2})(?=\D|$)/i);
  return match ? Number(match[1]) : NaN;
}
function publicPlan(plan){
  if(!plan)return null;
  const entries=plan.items.map(item=>({...item,at:item.scheduledAt}));
  const nextIndex=entries.findIndex(e=>e.state==='planned'||e.state==='scheduled');
  return {...plan,state:plan.status,entries,nextIndex:nextIndex>=0?nextIndex:entries.length};
}
async function approvedCounts(){
  const ids=await redis('ZREVRANGE',PREFIX+'records',0,499);
  const values=ids.length?await redis('MGET',...ids.map(x=>PREFIX+'record:'+x)):[];
  const counts={BBQ:0,MUSIC:0,BOOK:0};
  for(const v of values){
    if(!v)continue;
    const r=JSON.parse(v);
    if(r.status==='approved'&&Object.prototype.hasOwnProperty.call(counts,r.campaign))counts[r.campaign]++;
  }
  return counts;
}
async function approvedRoster(){
  const ids=await redis('ZREVRANGE', PREFIX+'records', 0, 499);
  const values=ids.length ? await redis('MGET',...ids.map(x=>PREFIX+'record:'+x)):[];
  const posts=values.filter(Boolean).map(v=>JSON.parse(v));
  const groups={};
  for(const c of ORDER){
    const selected=posts.filter(r=>r.campaign===c && r.status==='approved');
    if(selected.length!==15) throw new AppError('Expected 15 approved '+c+' posts but found '+selected.length+'. Review Content Library before starting.');
    const seen=new Set();
    for(const r of selected){
      const n=ordinal(r);
      if(!Number.isInteger(n)||n<1||n>15||seen.has(n))
        throw new AppError('Check the numbering of '+c+' post "'+r.title+'". Each campaign needs unique numbers 1 through 15.');
      seen.add(n);
      if(!r.imageId||!String(r.caption||'').trim())
        throw new AppError('Add the photo and caption to "'+r.title+'" before starting.');
      if(!r.targets?.some(t=>t==='facebook'||t==='instagram'))
        throw new AppError('Select Facebook or Instagram for "'+r.title+'".');
      if(r.targets.includes('instagram') && ((r.caption||'')+(r.link?'\n\n'+r.link:'')).length>2200)
        throw new AppError('Instagram caption is too long on "'+r.title+'".');
    }
    groups[c]=selected.sort((a,b)=>ordinal(a)-ordinal(b));
  }
  return groups;
}
async function makePlan(startLocal){
  const first=instantForWall(startLocal);
  if(Date.parse(first)<Date.now()+10*60000)
    throw new AppError('Choose a posting time at least ten minutes from now so the first post can be queued safely.');
  if(Date.parse(first)>Date.now()+30*DAY)
    throw new AppError('Choose a start date within the next 30 days.');
  const [y,m,d,hh,mm]=startLocal.match(/\d+/g).map(Number);
  const roster=await approvedRoster();
  const items=[];
  for(let i=0;i<15;i++)for(let j=0;j<3;j++){
    const category=ORDER[j];
    const wallDay=new Date(Date.UTC(y,m-1,d+(i*3+j)*2,hh,mm));
    const local=wallDay.toISOString().slice(0,16);
    const r=roster[category][i];
    items.push({
      n:items.length+1, campaign:category, ordinal:i+1,
      recordId:r.id, title:r.title, local,
      scheduledAt:instantForWall(local),state:'planned'
    });
  }
  return { version:1, active:false, status:'preview',
    startLocal, timeZone:ZONE, cadenceDays:2, createdAt:now(),
    lastCheckedAt:null, lastError:null, items };
}
async function fillWindow(plan){
  if(!plan.active) return plan;
  const high=Date.now()+6*DAY;
  let processed=0;
  for(const item of plan.items){
    if(item.state!=='planned')continue;
    const at=Date.parse(item.scheduledAt);
    if(at>high)break;
    if(at<Date.now()+120000){
      item.state='missed';
      plan.active=false;plan.status='needs_attention';
      plan.lastError='Post '+item.n+' ('+item.title+') missed its scheduling window. Paused to prevent sending out of order.';
      break;
    }
    try{
      const result=await scheduleRotationPost(item.recordId,item.scheduledAt,ZONE);
      item.state=result.status==='published'?'published':'scheduled';
      item.error=null;
      processed++;
    }catch(e){
      item.state='needs_attention';item.error=e.message;
      plan.active=false;plan.status='needs_attention';
      plan.lastError='Post '+item.n+' ('+item.title+'): '+e.message;
      break;
    }
  }
  plan.lastCheckedAt=now();
  plan.lastFilledCount=processed;
  if(plan.active && plan.items.every(x=>x.state==='scheduled'||x.state==='published')){
    // After all posts are queued, the one-time QStash deliveries continue
    // without needing a daily refill.
    plan.active=false;plan.status='all_queued';
  }
  await write(KEY,plan);
  return plan;
}
export const rotationEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET') return res.json({plan:publicPlan(await read(KEY)),approved:await approvedCounts()});
  const b=input(req);
  if(b.action==='preview'){
    const plan=publicPlan(await makePlan(b.startLocal));
    return res.json({plan,entries:plan.entries});
  }
  if(b.action==='activate'){
    const plan=await withLock('rotation-fill',async()=>{
      const old=await read(KEY);
      if(old?.active) throw new AppError('A rotation is already active. Pause it before starting a new one.',409);
      const fresh=await makePlan(b.startLocal);
      fresh.dailyScheduleId=await registerRefillSchedule();
      fresh.status='active';fresh.active=true;fresh.startedBy=session.name;
      await write(KEY,fresh);
      const queued=await fillWindow(fresh);
      if(!queued.active && queued.dailyScheduleId){
        await removeRefillSchedule(queued.dailyScheduleId);
        queued.dailyScheduleId=null;
        await write(KEY,queued);
      }
      return queued;
    });
    return res.json({plan:publicPlan(plan)});
  }
  if(b.action==='pause'){
    const plan=await withLock('rotation-fill',async()=>{
      const p=await read(KEY);
      if(!p)throw new AppError('No rotation is configured.');
      p.active=false;p.status='paused';p.lastError=null;
      if(p.dailyScheduleId){
        await removeRefillSchedule(p.dailyScheduleId);
        p.dailyScheduleId=null;
      }
      let cancelled=0;
      for(const item of p.items){
        if(item.state==='scheduled'){
          if(await cancelRotationPost(item.recordId)) {item.state='cancelled';cancelled++;}
        }
      }
      p.cancelledCount=cancelled;p.lastCheckedAt=now();
      await write(KEY,p);
      return p;
    });
    return res.json({plan:publicPlan(plan)});
  }
  throw new AppError('Unrecognized rotation action.');
});
export const rotationCronEndpoint=endpoint(async(req,res)=>{
  only(req,res,['POST']);
  const secret=env().DJOMS_JOB_SECRET;
  if(!secret || secret.length<32 || !equal(req.headers.authorization,'Bearer '+secret))
    throw new AppError('Unauthorized daily scheduler invocation.',401);
  const plan=await withLock('rotation-fill',async()=>{
    const p=await read(KEY);
    if(!p?.active)return p||null;
    const updated=await fillWindow(p);
    if(!updated.active && updated.dailyScheduleId){
      await removeRefillSchedule(updated.dailyScheduleId);
      updated.dailyScheduleId=null;
      await write(KEY,updated);
    }
    return updated;
  });
  return res.json({ok:true,active:!!plan?.active,status:plan?.status||'not_configured',
    checkedAt:plan?.lastCheckedAt||now(),error:plan?.lastError||null});
});
