// DJOMS · Google Business Profile Maps impressions, owner-only/read-only.
// These are Maps profile appearances, NOT site sessions or Search Console ranks.
import { authorize, endpoint, only, now } from './core.js';
import { resolveReportWindow, centralDay, shiftDay, daysBetween } from './report-window.js';
import { googleConnection } from './local.js';

const MAPS_DESKTOP='BUSINESS_IMPRESSIONS_DESKTOP_MAPS';
const MAPS_MOBILE='BUSINESS_IMPRESSIONS_MOBILE_MAPS';
const metrics=()=>({impressions:null});
const comparison=()=>({status:'unavailable',appearances:{previous:null,current:null}});
const empty=(range,status,message,extra={})=>({
  connected:false,status,message,range,checkedAt:now(),
  metrics:metrics(),comparison:comparison(),...extra
});
const asNumber=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>=0?n:null;
};
const dateKey=date=>{
  if(!date||!Number.isInteger(Number(date.year))||
      !Number.isInteger(Number(date.month))||!Number.isInteger(Number(date.day)))return null;
  const dateText=String(date.year).padStart(4,'0')+'-'+String(date.month).padStart(2,'0')+
    '-'+String(date.day).padStart(2,'0');
  return Number.isFinite(Date.parse(dateText+'T12:00:00Z'))?dateText:null;
};
// Only return a total when BOTH Maps metrics are present and every
// returned value is valid. Google documents an omitted value as zero.
export function summarizeMapsDailyReport(data,start,end){
  const groups=Array.isArray(data?.multiDailyMetricTimeSeries)?
    data.multiDailyMetricTimeSeries:[];
  const entries=groups.flatMap(group=>Array.isArray(group?.dailyMetricTimeSeries)?
    group.dailyMetricTimeSeries:[]);
  const sumMetric=name=>{
    const matches=entries.filter(row=>row?.dailyMetric===name);
    if(matches.length!==1||!Array.isArray(matches[0].timeSeries?.datedValues))return null;
    let total=0;
    const seen=new Set();
    for(const row of matches[0].timeSeries.datedValues){
      const day=dateKey(row?.date);
      if(!day||day<start||day>end||seen.has(day))return null;
      seen.add(day);
      const value=row.value===undefined?0:asNumber(row.value);
      if(value===null)return null;
      total+=value;
      if(!Number.isSafeInteger(total))return null;
    }
    return total;
  };
  const desktop=sumMetric(MAPS_DESKTOP),mobile=sumMetric(MAPS_MOBILE);
  return desktop===null||mobile===null?null:desktop+mobile;
}
async function fetchMapsDaily(accessToken,location,start,end){
  const url=new URL('https://businessprofileperformance.googleapis.com/v1/'+
    location+':fetchMultiDailyMetricsTimeSeries');
  for(const metric of [MAPS_DESKTOP,MAPS_MOBILE])url.searchParams.append('dailyMetrics',metric);
  for(const [label,day] of [['start_date',start],['end_date',end]]){
    const [year,month,date]=day.split('-');
    url.searchParams.set('daily_range.'+label+'.year',String(Number(year)));
    url.searchParams.set('daily_range.'+label+'.month',String(Number(month)));
    url.searchParams.set('daily_range.'+label+'.day',String(Number(date)));
  }
  let response;
  try{
    response=await fetch(url.toString(),{
      headers:{Authorization:'Bearer '+accessToken,Accept:'application/json'},
      signal:AbortSignal.timeout(16000)
    });
  }catch{
    throw new Error('Google Maps performance could not be reached.');
  }
  if(!response.ok){
    if(response.status===401)throw new Error('Google Business Profile authorization must be renewed.');
    if(response.status===403)throw new Error('The Google Business Profile Performance API needs permission or an approved API quota.');
    if(response.status===429)throw new Error('Google Maps reporting limit reached. Try another reporting period.');
    throw new Error('Google Maps performance data is currently unavailable.');
  }
  const body=await response.json().catch(()=>null);
  if(!body)throw new Error('Google Maps did not return a readable report.');
  return summarizeMapsDailyReport(body,start,end);
}
export async function mapsPerformanceReport(range){
  let profile;
  try{profile=await googleConnection();}
  catch(error){return empty(range,'reconnect',String(error?.message||'Reconnect Google Business Profile.'));}
  if(!profile)return empty(range,'not-connected','Connect Google Business Profile to track Maps appearances.');
  const location=String(profile.locationName||'');
  if(!/^locations\/\d+$/.test(location))
    return empty(range,'needs-location','Select the Doc Jaks Google Business Profile location in Reviews & Local.');
  // Avoid presenting unfinished today as a verified Maps reporting day.
  const yesterday=shiftDay(centralDay(),-1);
  const end=range.endInclusive<yesterday?range.endInclusive:yesterday;
  if(range.start>end)
    return empty(range,'delayed','Today has not finished reporting Google Maps performance.');
  const days=daysBetween(range.start,shiftDay(end,1));
  const priorEnd=shiftDay(range.start,-1);
  const priorStart=shiftDay(range.start,-days);
  const scope={reportedThrough:end,
    currentRange:{start:range.start,end},
    previousRange:{start:priorStart,end:priorEnd},
    source:'Google Business Profile Performance API',
    definition:'Daily desktop+mobile Maps profile impressions; not unique people or website sessions.'};
  const [present,previous]=await Promise.allSettled([
    fetchMapsDaily(profile.accessToken,location,range.start,end),
    fetchMapsDaily(profile.accessToken,location,priorStart,priorEnd)
  ]);
  if(present.status!=='fulfilled'){
    return empty(range,'unavailable',String(present.reason?.message||'Google Maps appearances not available.'),scope);
  }
  const current=present.value;
  if(current===null)
    return empty(range,'unavailable','Google Maps did not provide both desktop and mobile impression series.',scope);
  const earlier=previous.status==='fulfilled'?previous.value:null;
  return {
    ...empty(range,'connected','Google Maps profile appearance reporting is connected.',scope),
    connected:true,status:'connected',
    metrics:{impressions:current},
    comparison:{
      status:earlier===null?'unavailable':'reported',
      appearances:{previous:earlier,current}
    }
  };
}
export const mapsPerformanceEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);await authorize(req);
  const range=resolveReportWindow(req.query||{});
  res.setHeader('Cache-Control','no-store');
  return res.json(await mapsPerformanceReport(range));
});
