/* Doc Jaks · one recorded website arrival, one first page, one source group.
   Platform views, post clicks, stream connections, and independent arrival
   events are never added to the Wix session total. */
import {PREFIX,redis,read,unseal,authorize,only,endpoint,now} from './core.js';
import {resolveReportWindow,REPORT_TZ} from './report-window.js';
import {postTrackingId} from './post-referrals.js';
import {acquisitionGroup} from './acquisition-groups.js';

// Contracts and these exact site-specific fields were checked against the
// Semantic Model API and the site's returned traffic schema on 2026-11-16.
// https://dev.wix.com/docs/api-reference/business-management/analytics/semantic-models/query-semantic-model-data
const MODELS='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const FIELD={path:'traffic.page_url_from',category:'traffic.referrer_category_name',source:'traffic.referrer_source_name',tag:'traffic.utm_campaign_id',visits:'traffic.sessions_count',first:'traffic.landing_page_flag'};
export const ARRIVAL_BATCH=500,ARRIVAL_LIMIT=5000;
const PLATFORMS=['facebook','instagram','x','youtube'];
const GROUPS=[['search','Search'],['olr5150','OLR5150 social posts'],['docjaks','Other Doc Jaks social posts'],['social_unclassified','Unclassified social'],['other','Direct / other sources']];
const good=value=>Number.isSafeInteger(value)&&value>=0;
const number=cell=>good(cell?.numericValue)?cell.numericValue:null;
const string=cell=>typeof cell?.stringValue==='string'?cell.stringValue:null;
const cleanText=(value,length=180)=>typeof value==='string'?value.slice(0,length):'';

function normalizedPath(raw){
  if(typeof raw!=='string'||!/^(?:\/|https?:\/\/)/i.test(raw))return null;
  try{
    const url=new URL(raw,'https://www.docjaks.com');
    if(!['http:','https:'].includes(url.protocol)||!['docjaks.com','www.docjaks.com'].includes(url.hostname.toLowerCase()))return null;
    return url.pathname.replace(/\/$/,'')||'/';
  }catch{return null;}
}
function sourcePlatform(source){
  let value=String(source||'').trim().toLowerCase();
  try{if(/^https?:\/\//.test(value))value=new URL(value).hostname;}catch{}
  value=value.replace(/\/$/,'');
  if(['facebook','fb'].includes(value)||/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(value))return 'facebook';
  if(value==='instagram'||/(^|\.)instagram\.com$/.test(value))return 'instagram';
  if(['x','twitter'].includes(value)||/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(value))return 'x';
  if(value==='youtube'||/(^|\.)(youtube\.com|youtu\.be)$/.test(value))return 'youtube';
  return null;
}
function trackingIdentity(tag){
  const match=typeof tag==='string'&&tag.match(/^docjaks_post_([a-f0-9]{32,48})_(facebook|instagram|x|youtube)$/);
  return match?{trackingId:tag,platform:match[2]}:null;
}
function recordIndex(records){
  const map=new Map();
  for(const record of records||[])for(const platform of PLATFORMS){
    const trackingId=postTrackingId(record,platform);
    if(!trackingId)continue;
    // Conflicting saved identities cannot be assigned to either promotion.
    const entry={recordId:String(record.id),title:cleanText(record.title||'Untitled post'),platform,acquisitionGroup:acquisitionGroup(record)};
    if(map.has(trackingId))map.set(trackingId,null);else map.set(trackingId,entry);
  }
  return map;
}
function classify(row,index){
  const tagged=trackingIdentity(row.trackingId),post=tagged?index.get(tagged.trackingId):null;
  if(tagged)return {group:post?.acquisitionGroup||'social_unclassified',platform:tagged.platform,post:post||null};
  const category=String(row.category||'').trim().toLowerCase().replace(/[ -]+/g,'_');
  if(['organic_search','paid_search','search'].includes(category))return {group:'search',platform:null,post:null};
  const platform=sourcePlatform(row.source);
  if(['social','organic_social','paid_social','wix_fb_ads'].includes(category)||platform)return {group:'social_unclassified',platform:platform||'other',post:null};
  return {group:'other',platform:null,post:null};
}
function addPage(map,path,visits){map.set(path,(map.get(path)||0)+visits);}
function pagesFrom(map){return [...map].map(([path,visits])=>({path,visits})).filter(p=>p.visits>0).sort((a,b)=>b.visits-a.visits||a.path.localeCompare(b.path));}
function addBreakdown(map,key,base,path,visits){
  const item=map.get(key)||{...base,visits:0,pages:new Map()};
  item.visits+=visits;addPage(item.pages,path,visits);map.set(key,item);
}
function breakdownFrom(map){return [...map.values()].map(({pages,...row})=>({...row,landingPages:pagesFrom(pages)})).sort((a,b)=>b.visits-a.visits||String(a.platform||a.title||'').localeCompare(String(b.platform||b.title||'')));}

// Pure aggregation is exported so source separation, first-page counts, and
// reconciliation can be tested without credentials or live analytics access.
export function buildWebsiteArrivalGroups({rows=[],totalVisits=null,queriedLandingVisits=null,complete=false,reason=null,records=[],recordLookupComplete=true,window={}}={}){
  const index=recordIndex(records),allPages=new Map();
  const buckets=new Map(GROUPS.map(([id,label])=>[id,{id,label,reportedVisits:0,pages:new Map(),platforms:new Map(),posts:new Map(),sources:new Map()}]));
  let landingVisits=0,validRows=true;
  const mapped=[];
  for(const input of rows){
    const path=normalizedPath(input?.path),visits=input?.visits;
    if(!path||!good(visits)){validRows=false;continue;}
    const row={path,visits,source:cleanText(input.source),category:cleanText(input.category),trackingId:cleanText(input.trackingId,200)};
    const assigned=classify(row,index),bucket=buckets.get(assigned.group);
    landingVisits+=visits;bucket.reportedVisits+=visits;addPage(allPages,path,visits);addPage(bucket.pages,path,visits);
    addBreakdown(bucket.sources,JSON.stringify([row.source,row.category]),{source:row.source||'Unspecified',category:row.category||'Unspecified'},path,visits);
    if(assigned.platform)addBreakdown(bucket.platforms,assigned.platform,{platform:assigned.platform},path,visits);
    if(trackingIdentity(row.trackingId))addBreakdown(bucket.posts,row.trackingId,{recordId:assigned.post?.recordId||null,trackingId:row.trackingId,platform:assigned.platform,title:assigned.post?.title||'Unclassified tagged post',acquisitionGroup:assigned.post?.acquisitionGroup||null},path,visits);
    mapped.push({...row,group:assigned.group,platform:assigned.platform,recordId:assigned.post?.recordId||null});
  }
  if(!good(landingVisits))validRows=false;
  const total=good(totalVisits)?totalVisits:null;
  const queried=good(queriedLandingVisits)?queriedLandingVisits:null;
  // Missing saved labels cannot turn measured tagged arrivals into a claimed
  // zero for either named promotion group. Untagged reports need no labels.
  const labelsNeeded=mapped.some(row=>trackingIdentity(row.trackingId));
  const labelsComplete=!labelsNeeded||recordLookupComplete===true;
  const reconciled=complete===true&&validRows&&labelsComplete&&total!==null&&landingVisits===total&&(queried===null||queried===landingVisits);
  const status=reconciled?'reported':mapped.length||total!==null?'partial':'unavailable';
  const coverageReason=reconciled?null:reason||(!validRows?'Some first-page rows contained unreported or invalid measurements.':!complete?'Wix has not returned every first-page row.':!labelsComplete?'Saved post labels could not be read completely. Tagged arrivals cannot yet be separated reliably into OLR5150 and other Doc Jaks posts.':total===null?'The full Wix session total is unavailable.':'First-page source totals do not yet reconcile with the full Wix session total.');
  const groups=[...buckets.values()].map(({pages,platforms,posts,sources,...group})=>({...group,visits:reconciled?group.reportedVisits:null,entryPageCount:reconciled?pagesFrom(pages).length:null,landingPages:pagesFrom(pages),platforms:breakdownFrom(platforms),posts:breakdownFrom(posts),sources:breakdownFrom(sources)}));
  return {
    version:1,status,complete:reconciled,checkedAt:now(),
    range:{start:window.start||null,end:window.end||null,endInclusive:window.endInclusive||null,timezone:REPORT_TZ},
    totalVisits:total,entryPageCount:reconciled?pagesFrom(allPages).length:null,landingPages:pagesFrom(allPages),groups,
    coverage:{reconciled,rowCount:mapped.length,landingVisits:validRows?landingVisits:null,queriedLandingVisits:queried,reason:coverageReason,recordLookupComplete:recordLookupComplete===true,unclassifiedSocialVisits:reconciled?buckets.get('social_unclassified').reportedVisits:null},
    note:'Wix sessions are grouped by the first page opened. Every recorded arrival belongs to one group. OLR5150 and other Doc Jaks post groups use the saved post label and tracking ID; tagged-link tests or shares can be included. Untagged social visits remain unclassified. Direct and other sources remain in the total. Later page views, social clicks, and listening events are not extra arrivals. The same starting page can appear in more than one group, so page counts do not add across groups.'
  };
}

function centralMidnight(day){
  const [year,month,date]=day.split('-').map(Number),target=Date.UTC(year,month-1,date);
  const parser=new Intl.DateTimeFormat('en-US',{timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  let guess=target;
  for(let i=0;i<4;i++){
    const parts=Object.fromEntries(parser.formatToParts(new Date(guess)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    guess-=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second)-target;
  }
  return new Date(guess).toISOString();
}
function validateSchema(schema){
  const fields=[...(schema?.measures||[]),...(schema?.dimensions||[]),...(schema?.parameters||[])];
  for(const name of Object.values(FIELD)){
    const field=fields.find(f=>f.name===name);
    if(!field||field.dependencies?.length)throw new Error('Wix first-page reporting fields are unavailable or have changed.');
  }
  const first=fields.find(f=>f.name===FIELD.first),path=fields.find(f=>f.name===FIELD.path);
  if(first.type!=='BOOLEAN'||!first.filters?.conditions?.includes('EQUAL')||!first.filters?.prefixes?.includes('IS')||path.sortable!==true)
    throw new Error('Wix no longer confirms the required first-page filter and ordering.');
}
function rowKey(row){
  const f=row?.fields;
  if(!f||![FIELD.path,FIELD.category,FIELD.source,FIELD.tag,FIELD.visits].every(name=>Object.hasOwn(f,name))||typeof string(f[FIELD.path])!=='string'||number(f[FIELD.visits])===null)return null;
  return JSON.stringify([FIELD.path,FIELD.category,FIELD.source,FIELD.tag].map(name=>string(f[name])));
}
export async function collectArrivalRows(load){
  const rows=[],seen=new Set();let queriedLandingVisits=null;
  const partial=reason=>({rows,complete:false,reason,queriedLandingVisits});
  for(let offset=0;offset<ARRIVAL_LIMIT;offset+=ARRIVAL_BATCH){
    let data;
    try{data=await load({limit:ARRIVAL_BATCH,offset});}catch{return partial('Wix could not return every first-page source row.');}
    if(!Array.isArray(data?.results)||!good(data?.pagingMetadata?.count)||data.pagingMetadata.count!==data.results.length||data.results.length>ARRIVAL_BATCH||(data.pagingMetadata.offset!==undefined&&data.pagingMetadata.offset!==offset)||(offset>0&&data.pagingMetadata.offset!==offset))return partial('Wix first-page pagination did not match the requested report.');
    const total=number(data.totals?.fields?.[FIELD.visits]);
    if(offset===0)queriedLandingVisits=total;
    else if(total!==queriedLandingVisits)return partial('Wix first-page totals changed while paging through the report.');
    for(const row of data.results){
      const key=rowKey(row);
      if(!key||seen.has(key))return partial('Wix returned a missing or repeated first-page source row.');
      seen.add(key);const f=row.fields;
      rows.push({path:string(f[FIELD.path]),visits:number(f[FIELD.visits]),category:string(f[FIELD.category]),source:string(f[FIELD.source]),trackingId:string(f[FIELD.tag])});
    }
    if(data.results.length<ARRIVAL_BATCH)return {rows,complete:true,reason:null,queriedLandingVisits};
  }
  return partial('The first-page report reached its 5,000-row safety limit; additional rows may exist.');
}

export async function readWixArrivalData(window,request){
  const listed=await request(MODELS),model=(listed.semanticModels||[]).find(m=>m.slug==='traffic');
  if(!model?.id)throw new Error('Wix traffic reporting is unavailable.');
  const schema=await request(MODELS+'/'+encodeURIComponent(model.id));validateSchema(schema.semanticModel);
  const interval={start:centralMidnight(window.start),end:centralMidnight(window.end),timezone:REPORT_TZ};
  const query=body=>request(MODELS+'/query-data',{semanticModelId:model.id,interval,...body});
  const [totals,entries]=await Promise.allSettled([
    // No paging on the undimensioned aggregate; a limit can undercount Wix.
    query({fields:[FIELD.visits],totalsIncluded:true}),
    collectArrivalRows(paging=>query({fields:[FIELD.path,FIELD.category,FIELD.source,FIELD.tag,FIELD.visits],filters:[{field:FIELD.first,condition:'EQUAL',prefix:'IS',values:['true']}],sort:{fieldName:FIELD.path,order:'ASC'},paging,totalsIncluded:true}))
  ]);
  let totalVisits=null;
  if(totals.status==='fulfilled'){
    totalVisits=number(totals.value.totals?.fields?.[FIELD.visits]);
    if(totalVisits===null&&totals.value.results?.length===1)totalVisits=number(totals.value.results[0]?.fields?.[FIELD.visits]);
  }
  const entryReport=entries.status==='fulfilled'?entries.value:{rows:[],complete:false,reason:'Wix first-page source reporting is unavailable.',queriedLandingVisits:null};
  return {...entryReport,totalVisits};
}

async function wixReader(){
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed)throw new Error('Connect Wix Analytics to retrieve first-page arrivals.');
  const credentials=unseal(saved.sealed);
  if(!credentials?.clientId||!credentials?.clientSecret)throw new Error('The saved Wix connection needs attention.');
  const response=await fetch('https://www.wixapis.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:credentials.clientId,client_secret:credentials.clientSecret}),signal:AbortSignal.timeout(20000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error('Wix would not authorize first-page reporting.');
  const token=data.access_token;
  return async(url,body=null)=>{
    const result=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
    const report=await result.json().catch(()=>({}));
    if(!result.ok)throw new Error('Wix first-page analytics unavailable ('+result.status+').');
    return report;
  };
}
async function savedPostLabels(){
  const records=[];
  for(let offset=0;offset<5000;offset+=500){
    const keys=await redis('ZREVRANGE',PREFIX+'records',offset,offset+499);
    if(!Array.isArray(keys))throw new Error('Saved post labels could not be read.');
    const values=keys.length?await redis('MGET',...keys.map(id=>PREFIX+'record:'+id)):[];
    for(const value of values){if(value)records.push(JSON.parse(value));}
    if(keys.length<500)return {records,complete:true};
  }
  return {records,complete:false};
}
export const websiteArrivalGroupsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);await authorize(req);
  const window=resolveReportWindow(req.query||{});
  const jobs=await Promise.allSettled([wixReader().then(request=>readWixArrivalData(window,request)),savedPostLabels()]);
  const data=jobs[0].status==='fulfilled'?jobs[0].value:{rows:[],complete:false,totalVisits:null,reason:'A complete Wix first-page source report is not available for these dates.'};
  const labels=jobs[1].status==='fulfilled'?jobs[1].value:{records:[],complete:false};
  const report=buildWebsiteArrivalGroups({...data,records:labels.records,recordLookupComplete:labels.complete,window});
  res.setHeader('Cache-Control','private, no-store');
  return res.json(report);
});
