/* DOC JAKS · Website Security Watch.
   Owner-only, read-only behavioral evidence from Wix analytics.
   A rapid page sweep is a REVIEW SIGNAL, never proof of hacking.
   No IPs, visitor IDs, exact referrer URLs or raw sessions are retained. */
import {AppError,authorize,only,endpoint,read,unseal,now} from './core.js';
import {resolveReportWindow,REPORT_TZ} from './report-window.js';

const QUERY='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data';
const MODEL='cad7fd34-2c8b-4dda-8296-3f9d47fb484d';
const FIELDS=[
  'traffic.created_date','traffic.city','traffic.region','traffic.country_name',
  'traffic.device_type','traffic.browser_family_name','traffic.os_name',
  'traffic.page_url_from','traffic.last_page_in_session_flag',
  'traffic.referrer_category_name','traffic.sessions_count','traffic.views_count'
];
const MAX_ROWS=2500,PAGE_SIZE=500,MAX_BURST_MS=180000,MAX_GAP_MS=75000;
const clean=(v,max=100)=>typeof v==='string'?v.trim().slice(0,max):'';
const cell=(r,k)=>r?.fields?.[k]||{};
const field=(r,k,max=100)=>clean(cell(r,k).stringValue,max);
const count=(r,k)=>{
  const value=cell(r,k).numericValue;
  return Number.isSafeInteger(value)&&value>=0?value:null;
};
const centralMidnight=day=>{
  const [y,m,d]=day.split('-').map(Number),target=Date.UTC(y,m-1,d);
  const parser=new Intl.DateTimeFormat('en-US',{
    timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  let guess=target;
  for(let i=0;i<4;i++){
    const parts=Object.fromEntries(parser.formatToParts(new Date(guess))
      .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const observed=Date.UTC(+parts.year,+parts.month-1,+parts.day,
      +parts.hour,+parts.minute,+parts.second);
    guess-=observed-target;
  }
  return new Date(guess).toISOString();
};

async function wixToken(){
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed)throw new Error('Wix site analytics is not connected.');
  const creds=unseal(saved.sealed);
  if(!creds?.clientId||!creds?.clientSecret)
    throw new Error('Wix analytics needs reconnection.');
  const response=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      grant_type:'client_credentials',
      client_id:creds.clientId,
      client_secret:creds.clientSecret
    }),
    signal:AbortSignal.timeout(20000)
  });
  const json=await response.json().catch(()=>({}));
  if(!response.ok||!json.access_token)
    throw new Error('Wix could not authorize the security analytics report.');
  return json.access_token;
}
async function querySessions(period){
  const token=await wixToken(),rows=[];
  const interval={
    start:centralMidnight(period.start),
    end:centralMidnight(period.end),
    timezone:REPORT_TZ
  };
  let partial=false;
  for(let offset=0;offset<MAX_ROWS;offset+=PAGE_SIZE){
    const response=await fetch(QUERY,{
      method:'POST',
      headers:{Authorization:token,'Content-Type':'application/json'},
      body:JSON.stringify({
        semanticModelId:MODEL,interval,fields:FIELDS,
        paging:{limit:PAGE_SIZE,offset}
      }),
      signal:AbortSignal.timeout(30000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error('Wix traffic report could not be loaded ('+response.status+').');
    if(!Array.isArray(data.results)||
      !Number.isSafeInteger(data.pagingMetadata?.count))
      throw new Error('Wix did not confirm security report coverage.');
    rows.push(...data.results);
    if(data.results.length<PAGE_SIZE)break;
    if(offset+PAGE_SIZE>=MAX_ROWS)partial=true;
  }
  return {rows,partial};
}
const observation=row=>{
  const time=Date.parse(cell(row,'traffic.created_date').timestampValue||'');
  const sessions=count(row,'traffic.sessions_count');
  const views=count(row,'traffic.views_count');
  const path=field(row,'traffic.page_url_from',230);
  const exit=cell(row,'traffic.last_page_in_session_flag').booleanValue;
  // Individual page observations only; aggregated rows cannot establish
  // precise inter-request timing or one-page behavior.
  if(!Number.isFinite(time)||sessions!==1||views!==1||
    !/^\/[^\s?#]*$/.test(path)||exit!==true)return null;
  return {
    time,path,city:field(row,'traffic.city',70)||'Unknown city',
    region:field(row,'traffic.region',40),
    country:field(row,'traffic.country_name',70)||'Unknown country',
    browser:field(row,'traffic.browser_family_name',55)||'Unknown browser',
    os:field(row,'traffic.os_name',55)||'Unknown OS',
    device:field(row,'traffic.device_type',45)||'Unknown device',
    source:field(row,'traffic.referrer_category_name',55)||'Unclassified'
  };
};
function detect(rows){
  const buckets=new Map();
  let eligible=0,skipped=0;
  for(const row of rows){
    const r=observation(row);
    if(!r){skipped++;continue;}
    eligible++;
    // A shared city/browser does not identify an individual or single IP.
    const key=[r.city,r.region,r.country,r.browser,r.os,r.device,r.source].join('\u001f');
    if(!buckets.has(key))buckets.set(key,[]);
    buckets.get(key).push(r);
  }
  const candidates=[];
  for(const entries of buckets.values()){
    entries.sort((a,b)=>a.time-b.time);
    let batch=[];
    const push=()=>{
      if(batch.length<8)return;
      const unique=new Set(batch.map(x=>x.path));
      if(unique.size<8)return;
      const first=batch[0],last=batch[batch.length-1];
      const priority=batch.length>=15&&unique.size>=15?'priority':'review';
      candidates.push({
        priority,start:new Date(first.time).toISOString(),
        end:new Date(last.time).toISOString(),
        location:[first.city,first.region,first.country].filter(Boolean).join(', '),
        signature:[first.device,first.os,first.browser].join(' · '),
        source:first.source,
        visitEvents:batch.length,uniquePages:unique.size,
        durationSeconds:Math.max(0,Math.round((last.time-first.time)/1000)),
        samplePaths:[...unique].slice(0,12),
        reason:'Multiple different public pages opened rapidly from the same approximate location and browser group, with one page per recorded session.'
      });
    };
    for(const r of entries){
      const last=batch[batch.length-1];
      if(batch.length&&(r.time-batch[0].time>MAX_BURST_MS||
        r.time-last.time>MAX_GAP_MS)){
        push();batch=[];
      }
      batch.push(r);
    }
    push();
  }
  candidates.sort((a,b)=>b.start.localeCompare(a.start));
  return {
    alerts:candidates.slice(0,40),
    totalPatterns:candidates.length,
    priorityPatterns:candidates.filter(x=>x.priority==='priority').length,
    flaggedVisitEvents:candidates.reduce((sum,x)=>sum+x.visitEvents,0),
    eligibleSinglePageObservations:eligible,
    observationsNotEvaluated:skipped
  };
}
export const securityWatchEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const selection=String(req.query?.range||'7d');
  if(!['today','7d','30d'].includes(selection))
    throw new AppError('Choose Today, 7 days, or 30 days for Website Security.');
  const period=resolveReportWindow({range:selection});
  res.setHeader('Cache-Control','private, no-store');
  try{
    const {rows,partial}=await querySessions(period);
    const result=detect(rows);
    return res.json({
      status:partial?'partial':'reported',
      checkedAt:now(),
      range:{start:period.start,end:period.end,endInclusive:period.endInclusive,timezone:REPORT_TZ,selection},
      source:'Wix traffic analytics · read-only behavioral review',
      coverage:{analyzedRows:rows.length,partial,limit:MAX_ROWS},
      ...result,
      securityProof:{
        blockedRequests:null,failedWixLogins:null,failedAdminLogins:null,
        status:'not_connected',reason:'No verified firewall or authentication-event feed connected.'
      },
      note:'A flagged pattern is NOT proof of malicious access. It may be a legitimate crawler or shared network. Wix city and browser groups are not unique IPs or people. This report cannot see requests Wix did not record. Raw Wix visit totals are left unchanged.'
    });
  }catch(error){
    return res.json({
      status:'unavailable',checkedAt:now(),
      range:{start:period.start,end:period.end,endInclusive:period.endInclusive,timezone:REPORT_TZ,selection},
      source:'Wix traffic analytics',coverage:{analyzedRows:null,partial:true,limit:MAX_ROWS},
      totalPatterns:null,priorityPatterns:null,flaggedVisitEvents:null,
      eligibleSinglePageObservations:null,observationsNotEvaluated:null,
      alerts:[],
      securityProof:{blockedRequests:null,failedWixLogins:null,failedAdminLogins:null,status:'not_connected'},
      error:String(error?.message||'Wix analytics unavailable').slice(0,160)
    });
  }
});