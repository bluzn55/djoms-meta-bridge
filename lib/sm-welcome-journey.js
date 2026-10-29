/* Doc Jaks SM Welcome: verified native Wix button clicks plus
 * privacy-conscious, consented per-placecard button-click attribution.
 * Native Wix totals and this first-party source are NOT added together.
 * Never infer distinct people, a destination page load, or a purchase.
 */
import {AppError,PREFIX,redis,read,unseal,authorize,endpoint,only,now} from './core.js';
import {resolveReportWindow,centralDay,shiftDay,daysBetween} from './report-window.js';
import {midnight} from './report-metrics.js';
import {parsePlacecardTag} from './placecard-arrivals.js';

const ORIGINS=new Set(['https://www.docjaks.com','https://docjaks.com']);
const ACTIONS=Object.freeze({
  'music':'Music',
  'emberhold-library':'Emberhold Library',
  'my-krewe':'My Krewe',
  'outlaw-entertainment':'Outlaw Entertainment',
  'pit-krewe':'Pit Krewe',
  'sosses':'Sosses'
});
const CAMPAIGNS=Object.freeze({BBQ:'food',SOSS:'food',MUSIC:'music',BOOK:'book'});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=PREFIX+'sm-next:v1:';
const DAY_TTL=180*24*3600;
const EVAL_RECORD=[
  "if redis.call('SET',KEYS[1],'1','NX','EX',900) then",
  "  redis.call('HINCRBY',KEYS[2],ARGV[1],1)",
  "  redis.call('EXPIRE',KEYS[2],ARGV[2])",
  "  redis.call('SET',KEYS[3],ARGV[3],'NX')",
  "  return 1",
  "end",
  "return 0"
].join('\n');
const EVAL_TOTAL=[
  "local counts={}",
  "for _,key in ipairs(KEYS) do",
  "  local rows=redis.call('HGETALL',key)",
  "  for i=1,#rows,2 do",
  "    local label=rows[i]",
  "    local n=tonumber(rows[i+1]) or 0",
  "    counts[label]=(counts[label] or 0)+n",
  "  end",
  "end",
  "return cjson.encode(counts)"
].join('\n');

export function cleanSmClick(body){
  if(!body||typeof body!=='object'||Array.isArray(body)||
    body.type!=='docjaks:sm-next'||body.version!==1||
    body.event!=='click'||body.path!=='/sm-welcome')
    throw new AppError('Invalid SM Welcome event.',400);
  const tag=parsePlacecardTag(body.trackingId);
  if(!tag||body.source!==tag.platform||
    typeof body.campaign!=='string'||!/^docjaks_(food|music|book)$/.test(body.campaign)||
    !Object.hasOwn(ACTIONS,body.target)||
    !UUID.test(body.eventId||''))
    throw new AppError('Unrecognized tracked placecard or destination.',400);
  return {
    tag,
    campaign:body.campaign,
    target:body.target,
    eventId:String(body.eventId).toLowerCase()
  };
}
async function recordAction(body){
  const event=cleanSmClick(body);
  const record=await read('record:'+event.tag.recordId);
  if(!record||!Object.hasOwn(CAMPAIGNS,record.campaign)||
    String(record.id||'').replace(/-/g,'').toLowerCase()!==
      event.tag.trackingId.slice('docjaks_post_'.length,-('_'+event.tag.platform).length)||
    event.campaign!=='docjaks_'+CAMPAIGNS[record.campaign])
    throw new AppError('This placecard link is not active.',400);
  const day=centralDay(),iso=now();
  const seen=KEY+'once:'+event.eventId;
  const bucket=KEY+'day:'+day;
  const field=event.tag.trackingId+'|'+event.target;
  const added=await redis('EVAL',EVAL_RECORD,3,
    seen,bucket,KEY+'started',field,String(DAY_TTL),iso);
  return Number(added)===1;
}
function cors(req,res){
  const origin=String(req.headers.origin||'');
  if(!ORIGINS.has(origin))return false;
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Max-Age','3600');
  res.setHeader('Vary','Origin');
  return true;
}
function isBot(req){
  return /(?:\bbot\b|spider|crawler|facebookexternalhit|googlebot|bingbot|headlesschrome|lighthouse)/i
    .test(String(req.headers['user-agent']||''));
}
export async function aggregateSmActions(period){
  if(!period||!Number.isInteger(daysBetween(period.start,period.end))||
    daysBetween(period.start,period.end)<1||daysBetween(period.start,period.end)>366)
    throw new AppError('Choose a valid reporting period.');
  const keys=[];
  for(let day=period.start;day<period.end;day=shiftDay(day,1))
    keys.push(KEY+'day:'+day);
  const raw=await redis('EVAL',EVAL_TOTAL,keys.length,...keys);
  const values=JSON.parse(raw||'{}');
  const totals=Object.fromEntries(Object.keys(ACTIONS).map(id=>[id,0]));
  const grouped=new Map();
  for(const [label,value] of Object.entries(values)){
    const delimiter=label.lastIndexOf('|');
    if(delimiter<0||!Number.isSafeInteger(value)||value<0)
      throw new AppError('Unrecognized SM action totals.',502);
    const trackingId=label.slice(0,delimiter);
    const target=label.slice(delimiter+1);
    const tag=parsePlacecardTag(trackingId);
    if(!tag||!Object.hasOwn(ACTIONS,target))
      throw new AppError('Unrecognized SM action label.',502);
    totals[target]+=value;
    let row=grouped.get(trackingId);
    if(!row){row={trackingId,platform:tag.platform,recordId:tag.recordId,actions:{},clicks:0};grouped.set(trackingId,row);}
    row.actions[target]=value;
    row.clicks+=value;
  }
  const started=await redis('GET',KEY+'started');
  const cards=[...grouped.values()].sort((a,b)=>b.clicks-a.clicks);
  const identified=await Promise.all(cards.slice(0,80).map(async row=>{
    const record=await read('record:'+row.recordId).catch(()=>null);
    return {
      platform:row.platform,
      campaign:Object.hasOwn(CAMPAIGNS,record?.campaign)?record.campaign:'UNKNOWN',
      placecard:record?String(record.title||'Placecard').slice(0,110):'Unmatched placecard',
      trackingId:row.trackingId,
      clicks:row.clicks,
      actions:row.actions
    };
  }));
  const eligible=!!started&&period.end>started.slice(0,10);
  return {
    status:eligible?'reported':'not_started',
    trackingSince:started||null,
    totalClicks:eligible?cards.reduce((sum,row)=>sum+row.clicks,0):null,
    byDestination:eligible?totals:null,
    cards:eligible?identified:[],
    partial:cards.length>80,
    note:'Only clicks sent by the installed analytics-consented SM Welcome tracker are attributed to a particular placecard. Click events are not unique people, confirmed destination visits or sales. Data begins at installation and does not backfill old Wix events.'
  };
}

const BASE='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const CLICK_MODEL='0ddc1712-68b1-4fbf-9db4-223bd9124d19';
const FIELDS=[
  'clicks.page_url_from_click',
  'clicks.element_linked_to_details',
  'clicks.clicks_count'
];
function safeText(value){
  return typeof value==='string'
    ?value.replace(/[<>\u0000-\u001f\u007f]/g,'').split('?')[0].trim().slice(0,90)
    :'';
}
async function wixClicks(period){
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed)return {status:'unavailable',error:'Wix reporting connection unavailable.'};
  const secret=unseal(saved.sealed);
  if(!secret.clientId||!secret.clientSecret)
    return {status:'unavailable',error:'Wix credentials incomplete.'};
  const tokenRes=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',client_id:secret.clientId,client_secret:secret.clientSecret}),
    signal:AbortSignal.timeout(12000)
  });
  const token=await tokenRes.json().catch(()=>({}));
  if(!tokenRes.ok||!token.access_token)
    return {status:'unavailable',error:'Wix analytics access not granted.'};
  async function wixRead(endpoint,body){
    const response=await fetch(endpoint,{
      method:body?'POST':'GET',
      headers:{Authorization:token.access_token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(20000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error('Wix click analytics is temporarily unavailable.');
    return data;
  }
  const schema=(await wixRead(BASE+'/'+CLICK_MODEL)).semanticModel;
  if(!schema)throw new Error('Wix click schema could not be verified.');
  const available=[...(schema.measures||[]),...(schema.dimensions||[])];
  if(FIELDS.some(name=>!available.some(f=>f.name===name&&
    !(f.dependencies||[]).length)))
    throw new Error('Wix click fields need review.');
  const rows=[];let complete=false;
  for(let offset=0;offset<3000;offset+=200){
    const data=await wixRead(BASE+'/query-data',{
      semanticModelId:CLICK_MODEL,
      interval:{start:midnight(period.start),end:midnight(period.end),timezone:'America/Chicago'},
      fields:FIELDS,
      filters:[{field:'clicks.page_url_from_click',condition:'EQUAL',prefix:'IS',values:['/sm-welcome']}],
      paging:{limit:200,offset}
    });
    if(!Array.isArray(data.results))throw new Error('Wix returned no usable click results.');
    rows.push(...data.results);
    if(data.results.length<200){complete=true;break;}
  }
  if(!complete)return {status:'partial',clicks:null,rows:[],error:'Wix click inventory reached its reporting limit.'};
  const destinations=new Map(),unresolved=[];
  let total=0;
  for(const row of rows){
    const cells=row?.fields||{};
    const value=cells['clicks.clicks_count']?.numericValue;
    if(!Number.isSafeInteger(value)||value<0)
      return {status:'partial',clicks:null,rows:[],error:'Wix returned an incomplete click count.'};
    const label=safeText(cells['clicks.element_linked_to_details']?.stringValue)||'Unspecified button';
    destinations.set(label,(destinations.get(label)||0)+value);
    total+=value;
  }
  return {
    status:'reported',
    clicks:total,
    rows:[...destinations].map(([destination,clicks])=>({destination,clicks}))
      .sort((a,b)=>b.clicks-a.clicks||a.destination.localeCompare(b.destination)),
    source:'Wix native button-click analytics',
    note:'All measured clicks on the SM Welcome page, including direct visits and owner testing. These are not attributed to a particular placecard; do not add them to per-card click counts.'
  };
}
const cache=new Map();
export const smWelcomeJourneyEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST','OPTIONS']);
  if(req.method!=='GET'){
    if(!cors(req,res))throw new AppError('Unknown website origin.',403);
    if(req.method==='OPTIONS'){res.status(204).end();return;}
    if(isBot(req)||req.headers['sec-gpc']==='1'||req.headers.dnt==='1')
      return res.json({ok:true,ignored:true});
    if(Number(req.headers['content-length']||0)>4096)
      throw new AppError('Event body too large.',413);
    let body;
    try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}
    catch{throw new AppError('Unrecognized event body.',400);}
    const added=await recordAction(body);
    return res.json({ok:true,recorded:added});
  }
  await authorize(req);
  const period=resolveReportWindow(req.query||{});
  const key=period.start+'|'+period.end;
  const prior=cache.get(key);
  if(req.query?.refresh!=='1'&&prior&&prior.expires>Date.now())
    return res.json({...prior.value,cached:true});
  const [first,second]=await Promise.allSettled([
    wixClicks(period),
    aggregateSmActions(period)
  ]);
  const native=first.status==='fulfilled'?first.value:{
    status:'unavailable',clicks:null,rows:[],
    error:'Wix click data could not be read.'
  };
  const tracked=second.status==='fulfilled'?second.value:{
    status:'unavailable',totalClicks:null,byDestination:null,cards:[],
    error:'Placecard-action counters could not be read.'
  };
  const result={
    status:'reported',checkedAt:now(),
    range:{start:period.start,end:period.end,endInclusive:period.endInclusive},
    wix:native,tracked,
    privacy:'Counts only. No visitor names, addresses, emails, IPs or persistent identifiers are returned.',
    caveat:'Native Wix click counts and independently tagged click counts are overlapping sources, never additive.'
  };
  if(cache.size>12)cache.clear();
  cache.set(key,{value:result,expires:Date.now()+90000});
  return res.json({...result,cached:false});
});
