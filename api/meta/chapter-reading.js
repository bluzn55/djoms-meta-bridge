// Doc Jaks: anonymous first-chapter reading telemetry.
// Only totals are stored. Do not confuse session counts with unique people.
// Daily buckets use America/Chicago and are attributed to session start day.
const ALLOWED_POST_ORIGINS = new Set(['https://www.docjaks.com','https://docjaks.com']);
const ALLOWED_GET_ORIGINS = new Set([...ALLOWED_POST_ORIGINS,'https://djoms-social-command.vercel.app']);
const VALID_EVENTS = new Set(['open','start','heartbeat','progress','end-reached','finish','unfinish','pause','resume','leave']);
const PREFIX = 'djoms:chapter-reader:v1:';
const LUA = String.raw`
local session=KEYS[1]
local daily=KEYS[2]
local totals=KEYS[3]
local now=tonumber(ARGV[1])
local claimed=tonumber(ARGV[2]) or 0
local progress=tonumber(ARGV[3]) or 0
local markedStart=tonumber(ARGV[4]) or 0
local markedFinish=tonumber(ARGV[5]) or 0
local markedEnd=tonumber(ARGV[6]) or 0
local exists=redis.call('EXISTS',session)
local prevSec=tonumber(redis.call('HGET',session,'sec') or '0')
local prevPct=tonumber(redis.call('HGET',session,'pct') or '0')
local prevStart=tonumber(redis.call('HGET',session,'started') or '0')
local prevFinish=tonumber(redis.call('HGET',session,'finished') or '0')
local prevEnd=tonumber(redis.call('HGET',session,'endReached') or '0')
local prev30=tonumber(redis.call('HGET',session,'read30') or '0')
local prev60=tonumber(redis.call('HGET',session,'read60') or '0')
local prev180=tonumber(redis.call('HGET',session,'read180') or '0')
local prevAt=tonumber(redis.call('HGET',session,'lastAt') or tostring(now))
local firstAt=tonumber(redis.call('HGET',session,'firstAt') or tostring(now))
local oldDay=redis.call('HGET',session,'bucket')
if exists==1 and oldDay~=ARGV[7] then return {err='session_day_conflict'} end
local sec=prevSec
if exists==1 and (markedStart==1 or prevStart==1) then
  local elapsed=math.max(0,math.floor((now-prevAt)/1000))
  local lifetime=math.max(0,math.floor((now-firstAt)/1000))
  sec=math.max(prevSec, math.min(14400,claimed,prevSec+elapsed+3,lifetime+3))
end
local pct=math.max(prevPct,math.min(100,progress))
local started=math.max(prevStart,markedStart)
local finished=math.max(prevFinish,markedFinish)
local endReached=math.max(prevEnd,markedEnd)
local read30=sec>=30 and 1 or prev30
local read60=sec>=60 and 1 or prev60
local read180=sec>=180 and 1 or prev180
if exists==0 then
  redis.call('HINCRBY',daily,'opens',1)
  redis.call('HINCRBY',totals,'opens',1)
end
local counters={daily,totals}
for i=1,2 do
  local dest=counters[i]
  if started>prevStart then redis.call('HINCRBY',dest,'readingSessions',1) end
  if finished>prevFinish then redis.call('HINCRBY',dest,'finished',1) end
  if endReached>prevEnd then redis.call('HINCRBY',dest,'endReached',1) end
  if read30>prev30 then redis.call('HINCRBY',dest,'read30',1) end
  if read60>prev60 then redis.call('HINCRBY',dest,'read60',1) end
  if read180>prev180 then redis.call('HINCRBY',dest,'read180',1) end
  if sec>prevSec then redis.call('HINCRBY',dest,'activeSeconds',sec-prevSec) end
  if pct>prevPct then redis.call('HINCRBY',dest,'progressPoints',pct-prevPct) end
end
redis.call('HSET',session,'sec',sec,'pct',pct,'started',started,'finished',finished,'endReached',endReached,'read30',read30,'read60',read60,'read180',read180,'firstAt',firstAt,'lastAt',now,'bucket',ARGV[7])
redis.call('EXPIRE',session,7776000)
redis.call('EXPIRE',daily,34560000)
return {sec,pct,started,finished,endReached}
`;
function respond(res, status, data) {
  res.status(status).setHeader('Cache-Control','no-store').setHeader('X-Content-Type-Options','nosniff').json(data);
}
function chiDate(d) {
  const parts = new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(d);
  const item = type => parts.find(x=>x.type===type)?.value;
  return item('year')+'-'+item('month')+'-'+item('day');
}
function dayBefore(s, n) {
  const d = new Date(s+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()-n);
  return d.toISOString().slice(0,10);
}
function dateRange(q) {
  const today=chiDate(new Date());
  const n = ({today:1,'7d':7,'30d':30,'365d':365})[q.range]||7;
  const start=typeof q.start==='string'?q.start:dayBefore(today,n-1);
  const end=typeof q.end==='string'?q.end:today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
    || start>end || end>today || start<'2026-10-20'
    || (Date.parse(end)-Date.parse(start))/86400000>365) return null;
  const days=[];
  for(let d=start;d<=end;d=dayBefore(d,-1))days.push(d);
  return {start,end,days};
}
function asHash(raw){
  if(Array.isArray(raw)){const out={};for(let i=0;i<raw.length;i+=2)out[raw[i]]=raw[i+1];return out;}
  return raw&&typeof raw==='object'?raw:{};
}
function asNumber(x){const n=Number(x);return Number.isSafeInteger(n)&&n>=0?n:0;}
async function redis(command, pipeline=false) {
  const url=process.env.KV_REST_API_URL;
  const token=process.env.KV_REST_API_TOKEN;
  if(!url||!token)throw new Error('KV_NOT_CONFIGURED');
  const response=await fetch(url.replace(/\/$/,'')+(pipeline?'/pipeline':''),{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify(command),signal:AbortSignal.timeout(12000)
  });
  const output=await response.json().catch(()=>null);
  if(!response.ok || !output || (!pipeline && output.error)) throw new Error('KV_UNAVAILABLE');
  return output;
}
export default async function handler(req,res){
  const origin=String(req.headers.origin||'').replace(/\/$/,'');
  const method=req.method;
  const allowed=method==='GET'?ALLOWED_GET_ORIGINS:ALLOWED_POST_ORIGINS;
  if(origin && allowed.has(origin)){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
  }
  if(method==='OPTIONS')return respond(res,origin&&ALLOWED_POST_ORIGINS.has(origin)?204:403,{});
  if(method==='POST'){
    if(!origin||!ALLOWED_POST_ORIGINS.has(origin))return respond(res,403,{ok:false,error:'origin_not_allowed'});
    let p;try{p=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch(_){return respond(res,400,{ok:false,error:'invalid_json'});}
    if(!p||p.type!=='docjaks:chapter-reader'||p.version!==1
      ||p.book!=='the-wooden-token'||p.chapter!==1
      ||typeof p.sessionId!=='string'||!/^[a-zA-Z0-9-]{8,90}$/.test(p.sessionId)
      ||!VALID_EVENTS.has(p.event)
      ||!Number.isInteger(p.activeSeconds)||p.activeSeconds<0||p.activeSeconds>14400
      ||!Number.isInteger(p.furthestPercent)||p.furthestPercent<0||p.furthestPercent>100
      ||typeof p.started!=='boolean'||typeof p.finished!=='boolean'||typeof p.reachedEnd!=='boolean')
      return respond(res,400,{ok:false,error:'invalid_reading_event'});
    try {
      const now=Date.now(),day=chiDate(new Date(now));
      const event=await redis(['EVAL',LUA,'3',PREFIX+'session:'+p.sessionId,
        PREFIX+'day:'+day,PREFIX+'all',String(now),String(p.activeSeconds),
        String(p.furthestPercent),(p.started?'1':'0'),
        (p.finished?'1':'0'),(p.reachedEnd?'1':'0'),day]);
      return respond(res,200,{ok:true,tracked:event.result!==null});
    }catch(err){
      return respond(res,503,{ok:false,error:'reading_tracking_temporarily_unavailable'});
    }
  }
  if(method==='GET'){
    if(origin && !ALLOWED_GET_ORIGINS.has(origin))return respond(res,403,{connected:false,error:'origin_not_allowed'});
    const range=dateRange(req.query||{});
    if(!range)return respond(res,400,{connected:false,error:'invalid_date_range'});
    try{
      const tasks=range.days.map(d=>['HGETALL',PREFIX+'day:'+d]);
      const response=await redis(tasks,true);
      if(!Array.isArray(response)||response.length!==range.days.length)
        throw new Error('INVALID_KV_RESPONSE');
      const daily=range.days.map((day,i)=>{
        const h=asHash(response[i]?.result);
        const fields=['opens','readingSessions','finished','endReached','read30','read60','read180','activeSeconds','progressPoints'];
        const row={date:day};
        for(const field of fields)row[field]=asNumber(h[field]);
        return row;
      });
      const sum=k=>daily.reduce((n,r)=>n+r[k],0);
      const readingSessions=sum('readingSessions');
      const activeSeconds=sum('activeSeconds');
      return respond(res,200,{
        connected:true,source:'Doc Jaks Chapter One Reader',mode:'active-reading-sessions',
        range:{start:range.start,end:range.end},openSessions:sum('opens'),readingSessions,
        activeSeconds,avgActiveSeconds:readingSessions?Math.round(activeSeconds/readingSessions):0,
        read30:sum('read30'),read60:sum('read60'),read180:sum('read180'),
        endReached:sum('endReached'),finished:sum('finished'),
        avgFurthestPercent:readingSessions?Math.round(sum('progressPoints')/readingSessions):0,
        daily,checkedAt:new Date().toISOString(),
        caveat:'Anonymous client-measured activity. Sessions are not unique people; reaching the end is not proof of reading every paragraph.'
      });
    }catch(err){
      return respond(res,503,{connected:false,error:'reading_metrics_temporarily_unavailable'});
    }
  }
  return respond(res,405,{error:'method_not_allowed'});
}
