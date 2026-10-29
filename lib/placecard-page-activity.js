/* Aggregate, analytics-consented website engagement by exact social link.
 * No browser, visitor or session identifier is stored in this report.
 * Clicks are not visitors; measurable active seconds are not elapsed time.
 */
import {AppError,PREFIX,redis,read,authorize,endpoint,only} from './core.js';
import {resolveReportWindow,centralDay,shiftDay} from './report-window.js';
import {parsePlacecardTag} from './placecard-arrivals.js';
import {postTrackingId} from './post-referrals.js';

const ROOT=PREFIX+'social-card-pages:v1:';
const TTL=180*86400;
const DOMAINS=new Set(['https://www.docjaks.com','https://docjaks.com']);
const PAGE=/^\/[a-zA-Z0-9\-._~!$&'()+,;=:@/%]{0,179}$/;
const EVENT=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EVAL_SAVE=[
  "if redis.call('SET',KEYS[1],'1','NX','EX',ARGV[3]) then",
  "  redis.call('HINCRBY',KEYS[2],ARGV[1],tonumber(ARGV[2]))",
  "  redis.call('EXPIRE',KEYS[2],ARGV[3])",
  "  redis.call('SET',KEYS[3],ARGV[4],'NX')",
  "  return 1",
  "end",
  "return 0"
].join('\n');
const EVAL_GET=[
  "local all={}",
  "for _,key in ipairs(KEYS) do",
  "  local items=redis.call('HGETALL',key)",
  "  for i=1,#items,2 do",
  "    local f=items[i]",
  "    all[f]=(all[f] or 0)+(tonumber(items[i+1]) or 0)",
  "  end",
  "end",
  "return cjson.encode(all)"
].join('\n');

export function validCardActivity(data){
  if(!data||data.type!=='docjaks:card-page'||data.version!==1||
    !['view','active'].includes(data.event)||!PAGE.test(data.path||'')||
    !EVENT.test(data.eventId||''))throw new AppError('Invalid analytics event.',400);
  const tag=parsePlacecardTag(data.trackingId);
  if(!tag||tag.platform!==data.source)
    throw new AppError('Invalid placecard link.',400);
  const seconds=data.event==='active'?data.seconds:0;
  if(!Number.isInteger(seconds)||seconds<0||seconds>120||
    (data.event==='active'&&seconds===0))
    throw new AppError('Invalid measured activity.',400);
  return {tag,event:data.event,path:data.path,
    seconds,eventId:data.eventId.toLowerCase()};
}
async function recordActivity(data){
  const parsed=validCardActivity(data);
  const record=await read('record:'+parsed.tag.recordId);
  if(!record||postTrackingId(record,parsed.tag.platform)!==parsed.tag.trackingId)
    throw new AppError('Unrecognized saved placecard.',400);
  const stamp=new Date().toISOString();
  const field=parsed.path+'|'+(parsed.event==='view'?'views':'seconds');
  const amount=parsed.event==='view'?1:parsed.seconds;
  const stored=await redis('EVAL',EVAL_SAVE,3,
    ROOT+'nonce:'+parsed.eventId,
    ROOT+'day:'+centralDay()+':'+parsed.tag.trackingId,
    ROOT+'started',
    field,String(amount),String(TTL),stamp);
  return Number(stored)===1;
}
export function summarizeCardActivity(fields,enabled){
  const pages=new Map();
  for(const [field,value] of Object.entries(fields||{})){
    const at=field.lastIndexOf('|');
    if(at<0||!Number.isSafeInteger(value)||value<0)continue;
    const path=field.slice(0,at),kind=field.slice(at+1);
    if(!PAGE.test(path)||!['views','seconds'].includes(kind))continue;
    const row=pages.get(path)||{path,views:0,measuredActiveSeconds:0};
    if(kind==='views')row.views+=value;
    else row.measuredActiveSeconds+=value;
    pages.set(path,row);
  }
  const rows=[...pages.values()].sort((a,b)=>b.views-a.views||a.path.localeCompare(b.path));
  return {
    status:enabled?'reported':'not_started',
    pages:rows.slice(0,80).map(x=>({
      path:x.path,
      pageViews:x.views,
      measuredActiveSeconds:x.measuredActiveSeconds>0?x.measuredActiveSeconds:null
    })),
    totalPageOpens:enabled?rows.reduce((s,p)=>s+p.views,0):null,
    hasOtherPages:enabled?rows.some(p=>p.path!=='/sm-welcome'&&p.views>0):null,
    matchedPages:enabled?rows.length:null,
    partial:rows.length>80,
    note:'Aggregate page opens and visible-tab active time from analytics-consented visits using this exact placecard link. Time is measured only while the page is visible; this is not a per-person trail and is not full elapsed visit duration. No earlier events can be retroactively matched.'
  };
}
const cors=(req,res)=>{
  const origin=String(req.headers.origin||'');
  if(!DOMAINS.has(origin))return false;
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Vary','Origin');
  return true;
};
export const placecardPageActivityEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST','OPTIONS']);
  if(req.method!=='GET'){
    if(!cors(req,res))throw new AppError('Unrecognized website origin.',403);
    if(req.method==='OPTIONS'){res.status(204).end();return;}
    if(req.headers['sec-gpc']==='1'||req.headers.dnt==='1'||
      /\bbot\b|crawler|spider|headlesschrome|lighthouse/i.test(String(req.headers['user-agent']||'')))
      return res.json({ok:true,ignored:true});
    if(Number(req.headers['content-length']||0)>3000)
      throw new AppError('Event too large.',413);
    let payload;
    try{payload=typeof req.body==='string'?JSON.parse(req.body):req.body;}
    catch{throw new AppError('Invalid event.',400);}
    const recorded=await recordActivity(payload);
    return res.json({ok:true,recorded});
  }
  await authorize(req);
  const period=resolveReportWindow(req.query||{});
  const tag=parsePlacecardTag(req.query?.trackingId);
  if(!tag)throw new AppError('Select a saved placecard link.',400);
  const record=await read('record:'+tag.recordId);
  if(!record||postTrackingId(record,tag.platform)!==tag.trackingId)
    throw new AppError('Placecard link is unavailable.',404);
  const keys=[];
  for(let day=period.start;day<period.end;day=shiftDay(day,1))
    keys.push(ROOT+'day:'+day+':'+tag.trackingId);
  const raw=await redis('EVAL',EVAL_GET,keys.length,...keys);
  const since=await redis('GET',ROOT+'started');
  res.setHeader('Cache-Control','private, no-store');
  return res.json({
    ...summarizeCardActivity(JSON.parse(raw||'{}'),!!since),
    trackingSince:since||null,
    range:{start:period.start,end:period.end,endInclusive:period.endInclusive},
    card:{campaign:record.campaign,platform:tag.platform,
      title:String(record.title||'Placecard').slice(0,130)},
    privacy:'Aggregated paths and activity durations only; no individual visitor or browsing-session identifiers in this report.'
  });
});
