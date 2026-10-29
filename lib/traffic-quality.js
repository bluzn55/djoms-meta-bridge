/* DOC JAKS · Traffic Quality. Behavioral classification, not bot proof.
   Wix totals are immutable source measures. Identifiers remain server-side
   and are used only during this request; never return raw addresses or IDs. */
import {AppError,authorize,only,endpoint,read,unseal,now} from './core.js';
import {resolveReportWindow,REPORT_TZ} from './report-window.js';

const QUERY='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data';
const MODEL='cad7fd34-2c8b-4dda-8296-3f9d47fb484d';
const MAX=2500,STEP=250,WINDOW=180000,GAP=75000;
const S_FIELDS=['traffic.bsi','traffic.sessions_count','traffic.views_count',
  'traffic.site_time_seconds_avg'];
const E_FIELDS=['traffic.bsi','traffic.ip_address','traffic.created_date',
  'traffic.page_url_from','traffic.country_name','traffic.city','traffic.region',
  'traffic.device_type','traffic.browser_family_name','traffic.os_name',
  'traffic.referrer_category_name','traffic.last_page_in_session_flag',
  'traffic.sessions_count','traffic.views_count'];
const cell=(r,k)=>r?.fields?.[k]||{};
const str=(r,k,max=150)=>typeof cell(r,k).stringValue==='string'?
  cell(r,k).stringValue.trim().slice(0,max):'';
const count=(r,k)=>{
  const v=cell(r,k).numericValue;
  return Number.isSafeInteger(v)&&v>=0?v:null;
};
const avg=(r,k)=>{
  const v=cell(r,k).numericValue;
  return typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<86400?v:null;
};
function centralMidnight(day){
  const [y,m,d]=day.split('-').map(Number),target=Date.UTC(y,m-1,d);
  const p=new Intl.DateTimeFormat('en-US',{
    timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  let guess=target;
  for(let i=0;i<4;i++){
    const parts=Object.fromEntries(p.formatToParts(new Date(guess))
      .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const seen=Date.UTC(+parts.year,+parts.month-1,+parts.day,
      +parts.hour,+parts.minute,+parts.second);
    guess-=seen-target;
  }
  return new Date(guess).toISOString();
}
async function token(){
  const connected=await read('wix-blog-connection');
  if(!connected?.sealed)throw new Error('Wix analytics is not connected.');
  const c=unseal(connected.sealed);
  if(!c?.clientId||!c?.clientSecret)throw new Error('Wix connection needs attention.');
  const response=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',
      client_id:c.clientId,client_secret:c.clientSecret}),
    signal:AbortSignal.timeout(20000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error('Wix did not authorize traffic quality.');
  return data.access_token;
}
async function query(token,interval,fields,max=MAX){
  const rows=[];let partial=false;
  for(let offset=0;offset<max;offset+=STEP){
    const limit=Math.min(STEP,max-offset);
    const response=await fetch(QUERY,{
      method:'POST',
      headers:{Authorization:token,'Content-Type':'application/json'},
      body:JSON.stringify({
        semanticModelId:MODEL,interval,fields,paging:{limit,offset}
      }),
      signal:AbortSignal.timeout(30000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error('Wix traffic quality report unavailable ('+response.status+').');
    if(!Array.isArray(data.results)||
      !Number.isSafeInteger(data.pagingMetadata?.count))
      throw new Error('Wix traffic coverage was not verified.');
    rows.push(...data.results);
    if(data.results.length<limit)return {rows,partial:false};
    if(offset+limit===max)partial=true;
  }
  return {rows,partial};
}
// Equivalent to the published Security Watch burst rule, but a network
// match is required before using the stronger "likely automated" label.
export function classifyTrafficQuality(sessionRows,eventRows,reportedSessions,partial=false){
  const sessions=new Map(),observations=new Map(), groups=new Map();
  let malformed=0;
  for(const row of sessionRows){
    const sid=str(row,'traffic.bsi',180);
    const visits=count(row,'traffic.sessions_count');
    const views=count(row,'traffic.views_count');
    if(!sid||visits!==1||views===null){malformed++;continue;}
    if(sessions.has(sid)){malformed++;continue;}
    sessions.set(sid,{sid,views,stay:avg(row,'traffic.site_time_seconds_avg'),
      events:[],country:'',city:'',region:'',quality:'unclassified'});
  }
  for(const row of eventRows){
    const sid=str(row,'traffic.bsi',180),s=sessions.get(sid);
    if(!s)continue;
    const stamp=cell(row,'traffic.created_date').timestampValue||
      cell(row,'traffic.created_date').stringValue;
    const timestamp=Date.parse(stamp||'');
    const path=str(row,'traffic.page_url_from',230);
    const ip=str(row,'traffic.ip_address',150);
    const country=str(row,'traffic.country_name',90);
    const city=str(row,'traffic.city',90),region=str(row,'traffic.region',90);
    if(!s.country){s.country=country;s.city=city;s.region=region;}
    const e={sid,timestamp,path,ip,country,city,region,
      device:str(row,'traffic.device_type',45),
      browser:str(row,'traffic.browser_family_name',65),
      os:str(row,'traffic.os_name',65),
      source:str(row,'traffic.referrer_category_name',65),
      end:cell(row,'traffic.last_page_in_session_flag').booleanValue===true,
      sessions:count(row,'traffic.sessions_count'),
      views:count(row,'traffic.views_count')};
    s.events.push(e);
  }
  const known=[];
  for(const s of sessions.values()){
    if(s.views!==1||s.events.length!==1)continue;
    const e=s.events[0];
    if(!e.ip||!Number.isFinite(e.timestamp)||
      !/^\/[^\s?#]*$/.test(e.path)||!e.end||
      e.sessions!==1||e.views!==1)continue;
    const key=[e.ip,e.country,e.city,e.region,e.device,e.browser,e.os,e.source].join('\u001f');
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(e);
  }
  const flagged=new Set();
  for(const entries of groups.values()){
    entries.sort((a,b)=>a.timestamp-b.timestamp);
    let batch=[];
    const close=()=>{
      const paths=new Set(batch.map(e=>e.path));
      if(batch.length<8||paths.size<8)return;
      for(const entry of batch)flagged.add(entry.sid);
      const first=batch[0],last=batch[batch.length-1];
      known.push({
        country:first.country||'Unknown',city:first.city||'',
        region:first.region||'',visits:batch.length,pages:paths.size,
        durationSeconds:Math.round((last.timestamp-first.timestamp)/1000),
        start:new Date(first.timestamp).toISOString(),
        end:new Date(last.timestamp).toISOString(),
        source:first.source||'Not reported',
        samplePaths:[...paths].slice(0,6),
        explanation:'Rapid sequence of distinct public pages from a shared network and browser profile; every visit was a single-page session.'
      });
    };
    for(const e of entries){
      const last=batch[batch.length-1];
      if(batch.length&&(e.timestamp-batch[0].timestamp>WINDOW||
        e.timestamp-last.timestamp>GAP)){close();batch=[];}
      batch.push(e);
    }
    close();
  }
  let automated=0,engaged=0,undetermined=0;
  const byCountry=new Map(),byLocation=new Map();
  const bucket=(map,key,fields)=>{
    let item=map.get(key);
    if(!item){item={...fields,total:0,automated:0,engaged:0,undetermined:0};map.set(key,item);}
    return item;
  };
  for(const s of sessions.values()){
    // Engaged-looking is NOT equivalent to a verified human being.
    // An actual multi-page session or measured time >= 30s is required.
    s.quality=flagged.has(s.sid)?'automated':
      s.views>=2||s.stay!==null&&s.stay>=30?'engaged':'undetermined';
    if(s.quality==='automated')automated++;
    else if(s.quality==='engaged')engaged++;
    else undetermined++;
    const country=s.country||'Unknown';
    const cc=bucket(byCountry,country,{country});
    const city=s.city||'',region=s.region||'';
    const ll=bucket(byLocation,[country,city,region].join('\u001f'),
      {country,city,region});
    for(const b of [cc,ll]){b.total++;b[s.quality]++;}
  }
  const reconciled=!partial&&malformed===0&&Number.isSafeInteger(reportedSessions)&&
    sessions.size===reportedSessions;
  // Always distinguish coverage failures from real zero traffic.
  return {
    status:reconciled?'reported':'partial',
    totalWixSessions:Number.isSafeInteger(reportedSessions)?reportedSessions:null,
    likelyAutomated:automated,
    engagedLooking:engaged,
    unclassified:reconciled?undetermined:null,
    reviewedSessions:sessions.size,reconciled,
    coverage:{sessionRows:sessionRows.length,eventRows:eventRows.length,malformed,
      truncated:partial,missingFromSample:reportedSessions===null?null:
        Math.max(0,reportedSessions-sessions.size)},
    byCountry:[...byCountry.values()].sort((a,b)=>b.total-a.total),
    byLocation:[...byLocation.values()].sort((a,b)=>b.total-a.total),
    patterns:known.sort((a,b)=>b.start.localeCompare(a.start)).slice(0,50),
    patternCount:known.length,
    warning:reconciled?null:
      'Wix sample is incomplete. Classified figures are lower bounds; unclassified and adjusted totals are N/A.'
  };
}
export const trafficQualityEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const period=resolveReportWindow(req.query||{});
  res.setHeader('Cache-Control','private, no-store');
  const range={start:period.start,end:period.end,
    endInclusive:period.endInclusive,selection:period.range,days:period.days};
  try{
    const auth=await token();
    const interval={start:centralMidnight(period.start),
      end:centralMidnight(period.end),timezone:REPORT_TZ};
    const [baseline,sessions,events]=await Promise.all([
      query(auth,interval,['traffic.sessions_count'],5),
      query(auth,interval,S_FIELDS),
      query(auth,interval,E_FIELDS)
    ]);
    const total=baseline.rows.length===1?
      count(baseline.rows[0],'traffic.sessions_count'):
      baseline.rows.length===0?0:null;
    const result=classifyTrafficQuality(sessions.rows,events.rows,total,
      sessions.partial||events.partial||baseline.partial);
    return res.json({...result,checkedAt:now(),range,
      source:'Wix Analytics · heuristic traffic quality · not a firewall feed',
      note:'Original Wix visits are unchanged. Likely automated means strong crawler-like evidence, not confirmed bots or attacks. Engaged-looking means 2+ pages in a session or Wix-measured stay of at least 30s; bots can also qualify. Unclassified does not mean human or malicious. Identifiers are used only in memory and never returned or retained. Do not subtract these figures from Wix visitor counts or claim they are unique people.'});
  }catch(e){
    return res.json({status:'unavailable',checkedAt:now(),range,
      totalWixSessions:null,likelyAutomated:null,engagedLooking:null,
      unclassified:null,byCountry:[],byLocation:[],patterns:[],
      patternCount:null,
      error:String(e?.message||'Wix traffic quality not available.').slice(0,180)});
  }
});