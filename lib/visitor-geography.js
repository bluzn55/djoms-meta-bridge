/* DOC JAKS · Worldwide Visitor Intelligence
   Owner-only Wix geographic analytics. Read-only. Raw IPs and analytics
   identifiers never leave this function, reach the browser or get stored.
   IP groups can be shared by many people; do not label them persons. */
import {AppError,authorize,only,endpoint,read,unseal,now} from './core.js';
import {resolveReportWindow,REPORT_TZ} from './report-window.js';

const URL='https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data';
const MODEL='cad7fd34-2c8b-4dda-8296-3f9d47fb484d';
const PAGE_LIMIT=250,MAX_ROWS=1500;
const number=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const avg=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<86400?
  Math.round(value*10)/10:null;
const c=(row,key)=>row?.fields?.[key]||{};
const str=(row,key,max=150)=>typeof c(row,key).stringValue==='string'?
  c(row,key).stringValue.trim().slice(0,max):'';
const n=(row,key)=>number(c(row,key).numericValue);
const a=(row,key)=>avg(c(row,key).numericValue);
const timestamp=(row,key)=>{
  const value=c(row,key).timestampValue;
  return typeof value==='string'&&Number.isFinite(Date.parse(value))?
    new Date(value).toISOString():null;
};
const text=(value,max=100)=>{
  if(typeof value!=='string'||value.trim().length>max||
    /[\x00-\x1f\x7f<>]/.test(value))throw new AppError('Invalid visitor location selection.');
  return value.trim();
};
const day=(stamp)=>{
  if(!stamp)return null;
  const d=new Date(stamp);
  if(!Number.isFinite(d.getTime()))return null;
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(d).map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
};
const centralMidnight=ymd=>{
  const [year,month,date]=ymd.split('-').map(Number);
  const target=Date.UTC(year,month-1,date);
  const format=new Intl.DateTimeFormat('en-US',{
    timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  let guess=target;
  for(let i=0;i<4;i++){
    const fields=Object.fromEntries(format.formatToParts(new Date(guess))
      .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const seen=Date.UTC(+fields.year,+fields.month-1,+fields.day,
      +fields.hour,+fields.minute,+fields.second);
    guess-=seen-target;
  }
  return new Date(guess).toISOString();
};
async function wixToken(){
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed)throw new Error('Wix analytics connection is not available.');
  const credentials=unseal(saved.sealed);
  if(!credentials?.clientId||!credentials?.clientSecret)
    throw new Error('Wix analytics connection needs attention.');
  const result=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',
      client_id:credentials.clientId,client_secret:credentials.clientSecret}),
    signal:AbortSignal.timeout(20000)
  });
  const data=await result.json().catch(()=>({}));
  if(!result.ok||!data.access_token)
    throw new Error('Wix did not authorize the visitor geography report.');
  return data.access_token;
}
async function wixQuery(token,interval,fields,filters=[],limit=MAX_ROWS){
  const rows=[];
  let truncated=false;
  for(let offset=0;offset<limit;offset+=PAGE_LIMIT){
    const response=await fetch(URL,{
      method:'POST',
      headers:{Authorization:token,'Content-Type':'application/json'},
      body:JSON.stringify({
        semanticModelId:MODEL,interval,fields,filters,
        paging:{limit:Math.min(PAGE_LIMIT,limit-offset),offset}
      }),
      signal:AbortSignal.timeout(35000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error('Wix geography data unavailable ('+response.status+').');
    if(!Array.isArray(data.results)||!number(data.pagingMetadata?.count))
      throw new Error('Wix could not confirm the geographic report coverage.');
    rows.push(...data.results);
    if(data.results.length<PAGE_LIMIT){return {rows,truncated:false};}
    if(offset+PAGE_LIMIT>=limit){truncated=true;break;}
  }
  return {rows,truncated};
}
function sum(rows,key){
  let total=0;
  for(const row of rows){
    const value=n(row,key);
    if(value===null)return null;
    total+=value;
  }
  return total;
}
function buildCountries(rows){
  return rows.map(row=>({
    country:str(row,'traffic.country_name',90)||'Unknown',
    visitors:n(row,'traffic.visitors_count'),
    visits:n(row,'traffic.sessions_count'),
    views:n(row,'traffic.views_count')
  })).filter(row=>row.country!=='Unknown')
    .sort((x,y)=>(y.visitors??0)-(x.visitors??0)||x.country.localeCompare(y.country));
}
function buildLocations(rows){
  return rows.map(row=>({
    country:str(row,'traffic.country_name',90)||'Unknown',
    city:str(row,'traffic.city',90),
    region:str(row,'traffic.region',90),
    visitors:n(row,'traffic.visitors_count'),
    visits:n(row,'traffic.sessions_count'),
    views:n(row,'traffic.views_count'),
    avgStaySeconds:a(row,'traffic.site_time_seconds_avg')
  })).filter(row=>row.country!=='Unknown')
    .sort((x,y)=>(y.visitors??0)-(x.visitors??0)||
      x.country.localeCompare(y.country)||x.city.localeCompare(y.city));
}
const geographicFilters=({country,city,region})=>{
  const filters=[{field:'traffic.country_name',prefix:'IS',condition:'EQUAL',values:[country]}];
  if(city)filters.push({field:'traffic.city',prefix:'IS',condition:'EQUAL',values:[city]});
  if(region)filters.push({field:'traffic.region',prefix:'IS',condition:'EQUAL',values:[region]});
  return filters;
};
function buildSummary(rows,part){
  const total=rows[0];
  return {
    visitors:total?n(total,'traffic.visitors_count'):part?null:0,
    visits:total?n(total,'traffic.sessions_count'):part?null:0,
    views:total?n(total,'traffic.views_count'):part?null:0,
    avgStaySeconds:total?a(total,'traffic.site_time_seconds_avg'):null
  };
}
const networkMetrics=(rows,partial)=>{
  if(!rows||partial)return {status:'partial',networks:null,sharedNetworks:null,largestNetworkVisits:null};
  const groups=new Map();
  for(const row of rows){
    const ip=str(row,'traffic.ip_address',100);
    const visits=n(row,'traffic.sessions_count');
    if(!ip||visits===null)continue;
    groups.set(ip,(groups.get(ip)||0)+visits);
  }
  const ordered=[...groups.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const labels=new Map(ordered.map(([ip],index)=>[ip,'Network '+(index+1)]));
  return {status:'reported',networks:ordered.length,
    sharedNetworks:ordered.filter(([,count])=>count>1).length,
    largestNetworkVisits:ordered.length?ordered[0][1]:0,labels,
    visitsWithNetwork:ordered.reduce((sum,[,count])=>sum+count,0)};
};
const buildTimeline=(rows,networks)=>{
  const entries=rows.map(row=>{
    const at=timestamp(row,'traffic.created_date');
    const path=str(row,'traffic.page_url_from',230);
    const visits=n(row,'traffic.sessions_count');
    const views=n(row,'traffic.views_count');
    if(!at||!path||!path.startsWith('/'))return null;
    const ip=str(row,'traffic.ip_address',100);
    return {
      at,path,visits,views,
      source:str(row,'traffic.referrer_source_name',65)||'Not reported',
      device:str(row,'traffic.device_type',45)||'Not reported',
      visitorType:str(row,'traffic.visitor_type',35)||'Not reported',
      pageAvgSeconds:a(row,'traffic.page_time_seconds_avg'),
      network:networks?.labels?.get(ip)||null,
      // One analytic row with multiple sessions is not one identifiable visitor.
      evidence:visits===1&&views===1?'single-page-observation':'grouped-observation'
    };
  }).filter(Boolean).sort((a,b)=>b.at.localeCompare(a.at));
  return entries;
};

export const visitorGeographyEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const query=req.query||{};
  const period=resolveReportWindow(query);
  const mode=String(query.mode||'overview');
  if(!['overview','detail'].includes(mode))
    throw new AppError('Choose a valid Worldwide Visitors report.');
  const location=mode==='detail'?{
    country:text(query.country,90),
    city:query.city?text(query.city,90):'',
    region:query.region?text(query.region,90):''
  }:null;
  if(mode==='detail'&&!location.country)throw new AppError('Choose a country to inspect.');
  const range={start:period.start,end:period.end,
    endInclusive:period.endInclusive,selection:period.range,days:period.days};
  res.setHeader('Cache-Control','private, no-store');
  try{
    const token=await wixToken();
    const interval={start:centralMidnight(period.start),
      end:centralMidnight(period.end),timezone:REPORT_TZ};
    if(mode==='overview'){
      const names=['traffic.country_name','traffic.visitors_count',
        'traffic.sessions_count','traffic.views_count'];
      const cities=['traffic.country_name','traffic.city','traffic.region',
        'traffic.visitors_count','traffic.sessions_count','traffic.views_count',
        'traffic.site_time_seconds_avg'];
      const [countryData,cityData]=await Promise.all([
        wixQuery(token,interval,names),wixQuery(token,interval,cities)
      ]);
      return res.json({
        status:countryData.truncated||cityData.truncated?'partial':'reported',
        checkedAt:now(),range,countries:buildCountries(countryData.rows),
        locations:buildLocations(cityData.rows),
        coverage:{partial:countryData.truncated||cityData.truncated,
          countryRows:countryData.rows.length,cityRows:cityData.rows.length},
        source:'Wix · all traffic sources, not only social media',
        note:'A location is an approximate geolocation. People can appear in more than one city; location visitor counts should not be summed to compute sitewide unique visitors. No IP addresses or identifiers are revealed.'
      });
    }
    const filters=geographicFilters(location);
    const specs=[
      ['summary',['traffic.visitors_count','traffic.sessions_count',
        'traffic.views_count','traffic.site_time_seconds_avg']],
      ['pages',['traffic.page_url_from','traffic.visitors_count','traffic.views_count',
        'traffic.page_time_seconds_avg']],
      ['sources',['traffic.referrer_category_name','traffic.referrer_source_name',
        'traffic.sessions_count','traffic.visitors_count']],
      ['days',['traffic.created_timeframe','traffic.sessions_count',
        'traffic.visitors_count','traffic.views_count']],
      ['visitorTypes',['traffic.visitor_type','traffic.sessions_count','traffic.visitors_count']],
      ['networks',['traffic.ip_address','traffic.sessions_count']],
      ['timeline',['traffic.created_date','traffic.page_url_from','traffic.sessions_count',
        'traffic.views_count','traffic.referrer_source_name','traffic.device_type',
        'traffic.visitor_type','traffic.page_time_seconds_avg','traffic.ip_address']]
    ];
    const results=await Promise.allSettled(specs.map(([,fields])=>
      wixQuery(token,interval,fields,filters)));
    const byName=new Map();
    const issues=[];
    for(let i=0;i<specs.length;i++){
      const name=specs[i][0],result=results[i];
      if(result.status==='fulfilled')byName.set(name,result.value);
      else{
        byName.set(name,null);
        issues.push(name+' unavailable');
      }
    }
    const get=name=>byName.get(name);
    const network=networkMetrics(get('networks')?.rows,get('networks')?.truncated||!get('networks'));
    const pages=get('pages')?.rows?.map(row=>({
      path:str(row,'traffic.page_url_from',230),
      visitors:n(row,'traffic.visitors_count'),
      views:n(row,'traffic.views_count'),
      avgSeconds:a(row,'traffic.page_time_seconds_avg')
    })).filter(row=>row.path&&row.path.startsWith('/'))
      .sort((a,b)=>(b.views??0)-(a.views??0)||a.path.localeCompare(b.path))||[];
    const sources=get('sources')?.rows?.map(row=>({
      category:str(row,'traffic.referrer_category_name',65)||'Unknown',
      source:str(row,'traffic.referrer_source_name',90)||'Unknown',
      visits:n(row,'traffic.sessions_count'),
      visitors:n(row,'traffic.visitors_count')
    })).sort((a,b)=>(b.visits??0)-(a.visits??0))||[];
    const days=get('days')?.rows?.map(row=>({
      day:day(timestamp(row,'traffic.created_timeframe')),
      visits:n(row,'traffic.sessions_count'),
      visitors:n(row,'traffic.visitors_count'),
      views:n(row,'traffic.views_count')
    })).filter(x=>x.day).sort((a,b)=>b.day.localeCompare(a.day))||[];
    const types=get('visitorTypes')?.rows?.map(row=>({
      type:str(row,'traffic.visitor_type',50),
      visitors:n(row,'traffic.visitors_count'),
      visits:n(row,'traffic.sessions_count')
    }))||[];
    const summary=buildSummary(get('summary')?.rows||[],!get('summary'));
    const truncated=[...byName.values()].some(value=>value?.truncated);
    if(!get('summary'))issues.push('location totals unavailable');
    if(!get('networks'))issues.push('network grouping unavailable');
    return res.json({
      status:issues.length||truncated?'partial':'reported',
      checkedAt:now(),range,location,summary,
      pages,sources,days,visitorTypes:types,
      network:{networks:network.networks,sharedNetworks:network.sharedNetworks,
        largestNetworkVisits:network.largestNetworkVisits,
        visitsWithNetwork:network.visitsWithNetwork??null,status:network.status},
      timeline:buildTimeline(get('timeline')?.rows||[],network),
      coverage:{
        partial:truncated||!!issues.length,
        issues,
        pages:get('pages')?get('pages').truncated?'partial':'reported':'unavailable',
        sources:get('sources')?get('sources').truncated?'partial':'reported':'unavailable',
        days:get('days')?get('days').truncated?'partial':'reported':'unavailable',
        networks:network.status,
        timeline:get('timeline')?get('timeline').truncated?'partial':'reported':'unavailable'
      },
      source:'Wix website analytics · read-only geographic engagement',
      note:'Wix country and city are approximate, not home addresses. IPs are used transiently to count shared network groups but are never returned or retained. A network can belong to multiple people, or a VPN/bot; it cannot prove the same person. Wix new/returning is a reported browser classification, not identity. Timestamps are recorded analytic events; rows with multiple sessions are grouped, not individual timelines. Wix average page time is an average, not exact time spent by a person. Unknown time stays N/A.'
    });
  }catch(error){
    return res.json({
      status:'unavailable',checkedAt:now(),range,
      ...(location?{location}:{countries:[],locations:[]}),
      error:String(error?.message||'Wix geography report could not be verified.').slice(0,180)
    });
  }
});