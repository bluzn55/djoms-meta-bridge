/* DOC JAKS · Owner-only Friends & Supporters tracking.
   Each real friend's organic Facebook post receives a distinct DOCJAKS.COM
   UTM link. Reporting counts Wix website sessions actually carrying that
   UTM campaign ID. Never infer Facebook post impressions, purchasers, or
   conversions from tagged sessions. No mock statistics are returned.
*/
import {AppError,endpoint,only,authorize,input,read,write,withLock,now,unseal} from './core.js';
import {resolveReportWindow,shiftDay} from './report-window.js';

const STORE='friend-supporters-v1';
const MODEL_SLUG='traffic';
const ROOT='https://www.docjaks.com/';
const TAG_PREFIX='docjaks_friend_';
const MAX=60;
const ZONE='America/Chicago';
const URL='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const QUERY=URL+'/query-data';
const valid=value=>Number.isSafeInteger(value)&&value>=0;
const cleanName=value=>typeof value==='string'?
  value.trim().replace(/\s+/g,' ').slice(0,70):'';
const slugify=value=>String(value||'').normalize('NFKD')
  .toLowerCase().replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,42);
const numeric=value=>{
  const n=value?.numericValue;
  const v=typeof n==='number'?n:typeof n==='string'&&n.trim()?Number(n):null;
  return valid(v)?v:null;
};
const namesafe=name=>name.length>=2&&name.length<=70;
const dayOf=iso=>{
  const values=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
  return values.year+'-'+values.month+'-'+values.day;
};
function localMidnight(day){
  const [y,m,d]=day.split('-').map(Number);
  const target=Date.UTC(y,m-1,d),parts=new Intl.DateTimeFormat('en-US',{
    timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  let epoch=target;
  for(let tries=0;tries<4;tries++){
    const observed=Object.fromEntries(parts.formatToParts(new Date(epoch))
      .filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const actual=Date.UTC(+observed.year,+observed.month-1,+observed.day,
      +observed.hour,+observed.minute,+observed.second);
    epoch-=actual-target;
  }
  return new Date(epoch).toISOString();
}
export const supporterUrl=slug=>{
  const url=new URL(ROOT);
  url.searchParams.set('utm_source','facebook');
  url.searchParams.set('utm_medium','social');
  url.searchParams.set('utm_campaign','docjaks_friends_'+slug);
  url.searchParams.set('utm_id',TAG_PREFIX+slug);
  url.searchParams.set('utm_content',slug);
  return url.toString();
};
async function registry(){
  const saved=await read(STORE);
  return Array.isArray(saved)?saved.filter(item=>
    typeof item.slug==='string'&&/^[a-z0-9][a-z0-9-]{0,41}$/.test(item.slug)&&
    typeof item.name==='string'):[];
}
async function initializeRegistry(){
  const existing=await read(STORE);
  if(Array.isArray(existing))return registry();
  return withLock(STORE,async()=>{
    const previous=await read(STORE);
    if(Array.isArray(previous))return registry();
    // Mark is the real Facebook supporter whose draft was prepared earlier.
    // His stats are not seeded: no posts have gone out, and all counts N/A.
    const starter=[{name:'Mark',slug:'mark',createdAt:now(),postedAt:null}];
    await write(STORE,starter);
    return starter;
  }).catch(async error=>{
    if(error.status===409)return registry();
    throw error;
  });
}
async function wixToken(){
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed)throw new Error('Wix website analytics is not connected.');
  const credentials=unseal(saved.sealed);
  if(!credentials?.clientId||!credentials?.clientSecret)
    throw new Error('Wix website authentication needs attention.');
  const response=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      grant_type:'client_credentials',client_id:credentials.clientId,
      client_secret:credentials.clientSecret
    }),signal:AbortSignal.timeout(18000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)
    throw new Error('The saved Wix connection could not authorize campaign reporting.');
  return data.access_token;
}
async function wixRequest(token,url,body=null){
  let response;
  try{
    response=await fetch(url,{method:body?'POST':'GET',
      headers:{Authorization:token,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(25000)});
  }catch{throw new Error('Wix Analytics could not be reached for supporters.');}
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error('Wix Analytics declined supporter campaign reporting ('+response.status+').');
  return data;
}
async function trafficModel(token){
  const data=await wixRequest(token,URL);
  const model=(data.semanticModels||[]).find(m=>m.slug===MODEL_SLUG);
  if(!model?.id)throw new Error('Wix Analytics traffic reporting model is unavailable.');
  return model.id;
}
function parseRows(data){
  if(!Array.isArray(data?.results))throw new Error('Wix did not return valid campaign rows.');
  if(!data?.pagingMetadata||!valid(data.pagingMetadata.count))
    throw new Error('Wix did not confirm campaign report coverage.');
  const rows=new Map();
  for(const item of data.results){
    const campaign=item.fields?.['traffic.utm_campaign_id']?.stringValue;
    if(typeof campaign!=='string'||!campaign.startsWith(TAG_PREFIX))continue;
    const slug=campaign.slice(TAG_PREFIX.length);
    if(!/^[a-z0-9][a-z0-9-]{0,41}$/.test(slug))
      throw new Error('Wix returned an unrecognized campaign identifier.');
    const visits=numeric(item.fields?.['traffic.sessions_count']);
    const visitors=numeric(item.fields?.['traffic.visitors_count']);
    const views=numeric(item.fields?.['traffic.views_count']);
    if(visits===null||visitors===null||views===null)
      throw new Error('Wix campaign session metrics were incomplete.');
    if(rows.has(slug))throw new Error('Wix returned duplicate campaign identifiers.');
    rows.set(slug,{visits,visitors,views});
  }
  return rows;
}
async function wixPeriod(token,modelId,start,end){
  const result=new Map(),limit=500;
  for(let offset=0;offset<5000;offset+=limit){
    const response=await wixRequest(token,QUERY,{
      semanticModelId:modelId,
      interval:{start:localMidnight(start),end:localMidnight(end),timezone:ZONE},
      fields:['traffic.utm_campaign_id','traffic.sessions_count',
        'traffic.visitors_count','traffic.views_count'],
      filters:[{field:'traffic.utm_campaign_id',condition:'START_WITH',
        prefix:'IS',values:[TAG_PREFIX]}],
      paging:{limit,offset},formattingEnabled:false,totalsIncluded:false
    });
    const entries=parseRows(response);
    for(const [slug,value] of entries){
      if(result.has(slug))throw new Error('Wix returned a repeated supporter campaign.');
      result.set(slug,value);
    }
    const count=response?.pagingMetadata?.count;
    if(count<limit)return result;
  }
  throw new Error('Wix campaign query reached its page limit; incomplete counts are hidden.');
}
async function measurements(period){
  try{
    const token=await wixToken(),model=await trafficModel(token);
    const prevStart=shiftDay(period.start,-period.days);
    const [current,previous]=await Promise.all([
      wixPeriod(token,model,period.start,period.end),
      wixPeriod(token,model,prevStart,period.start)
    ]);
    return {status:'reported',current,previous,error:null,
      note:'Wix Analytics UTM campaign-ID attribution; date-scoped site sessions. Reports may lag. No Facebook personal-post impressions, checkout attribution or individual identities.'};
  }catch(error){
    return {status:'unavailable',current:new Map(),previous:new Map(),
      error:String(error?.message||'Wix Analytics has not returned supporter visits.').slice(0,180),
      note:'No supporter counts have been invented. Wix campaign report unavailable.'};
  }
}
function output(supporters,period,report){
  const rows=supporters.map(item=>{
    const current=report.status==='reported'?report.current.get(item.slug):null;
    const previous=report.status==='reported'?report.previous.get(item.slug):null;
    // Only treat lack of a campaign row as a measured zero AFTER the owner
    // marks the post as published. Before sharing, show N/A, never a made-up zero.
    const published=Boolean(item.postedAt);
    const dataReady=published&&report.status==='reported';
    return {
      name:item.name,slug:item.slug,link:supporterUrl(item.slug),
      postedAt:item.postedAt||null,createdAt:item.createdAt,
      visits:dataReady?(current?.visits??0):null,
      lastVisits:dataReady?(previous?.visits??0):null,
      visitors:dataReady?(current?.visitors??0):null,
      pageViews:dataReady?(current?.views??0):null,
      manualFacebook:item.manualFacebook||null,
      metricStatus:!published?'not-posted':dataReady?'reported':'unavailable'
    };
  });
  return {
    status:report.status,
    source:'Wix Analytics · UTM campaign ID · traffic.sessions_count',
    range:period,rows,
    measuredTaggedVisits:report.status==='reported'?
      rows.reduce((n,r)=>n+(typeof r.visits==='number'?r.visits:0),0):null,
    note:report.note,
    ...(report.error?{error:report.error}:{}),
    caveat:'These visits are already included in Wix Website Visits. Tagged links attribute traffic to a supporter, not necessarily to Facebook itself. Visitor counts across links must not be summed as unique people. Post reach, likes and shares on friends’ own Facebook accounts are not automatically accessible.'
  };
}
export const friendSupportersEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST','PATCH','DELETE']);await authorize(req);
  res.setHeader('Cache-Control','private, no-store');
  if(req.method==='GET'){
    const window=resolveReportWindow(req.query||{});
    const supporters=await initializeRegistry();
    const source=await measurements(window);
    return res.json(output(supporters,window,source));
  }
  const payload=input(req);
  if(req.method==='POST'){
    const name=cleanName(payload.name);
    if(!namesafe(name))throw new AppError('Enter the friend’s name (2–70 characters).');
    return withLock(STORE,async()=>{
      const rows=await initializeRegistry();
      if(rows.length>=MAX)throw new AppError('The supporters list is full (60).');
      const base=slugify(name);
      if(!base)throw new AppError('Please use a name with letters or numbers.');
      const normalized=name.toLocaleLowerCase('en-US');
      if(rows.some(x=>x.name.toLocaleLowerCase('en-US')===normalized))
        throw new AppError('That friend already has a link.',409);
      let slug=base,idx=2;
      while(rows.some(x=>x.slug===slug)){slug=base.slice(0,37)+'-'+idx++;}
      const added={slug,name,createdAt:now(),postedAt:null};
      const updated=[...rows,added];
      await write(STORE,updated);
      return res.json({saved:true,friend:{...added,link:supporterUrl(slug)}});
    });
  }
  const slug=String(payload.slug||'');
  if(!/^[a-z0-9][a-z0-9-]{0,41}$/.test(slug))
    throw new AppError('Select a saved friend to update.');
  return withLock(STORE,async()=>{
    const rows=await registry();
    const idx=rows.findIndex(x=>x.slug===slug);
    if(idx===-1)throw new AppError('Friend not found.',404);
    if(req.method==='DELETE'){
      await write(STORE,rows.filter(x=>x.slug!==slug));
      return res.json({removed:true,slug});
    }
    const val=payload.posted;
    if(typeof val!=='boolean')throw new AppError('Choose whether the friend has posted.');
    const updated=rows.slice();
    updated[idx]={...rows[idx],postedAt:val?(rows[idx].postedAt||now()):null};
    await write(STORE,updated);
    return res.json({updated:true,friend:{...updated[idx],link:supporterUrl(slug)}});
  });
});
