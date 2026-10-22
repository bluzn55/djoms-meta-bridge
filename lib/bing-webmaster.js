// DJOMS · Owner-only read-only Bing Webmaster search-performance report.
// Uses the supported Bing Webmaster JSON/HTTP API, NEVER the retired SOAP/POX endpoints.
// Bing includes Web, Chat, Images, News and other search verticals in site traffic totals.
// No API keys, auth tokens, or raw request URLs are returned to the browser.
import { env, authorize, endpoint, only, now, read, write, redis, PREFIX, seal, unseal, input, AppError } from './core.js';
import { resolveReportWindow, shiftDay, centralDay, daysBetween } from './report-window.js';

const BASE='https://ssl.bing.com/webmaster/api.svc/json/';
const DOMAIN=new Set(['docjaks.com','www.docjaks.com']);
const KEY_STORAGE='bing-webmaster-api-key';
async function savedKey(){
  const stored=await read(KEY_STORAGE);
  if(stored){
    const value=unseal(stored);
    if(typeof value?.key==='string'&&value.key)return value.key;
  }
  return String(env().BING_WEBMASTER_API_KEY||'').trim();
}
const nullMetrics=()=>({impressions:null,clicks:null,ctr:null,position:null});
const emptyComparison=()=>({status:'unavailable',impressions:{previous:null,current:null},
  clicks:{previous:null,current:null},ctr:{previous:null,current:null}});
const empty=(range,status,message,extra={})=>({
  connected:false,status,message,range,checkedAt:now(),
  metrics:nullMetrics(),comparison:emptyComparison(),...extra
});
const count=value=>{
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>=0?n:null;
};
function siteMatch(url) {
  try{
    const site=new URL(String(url||''));
    return (site.protocol==='https:'||site.protocol==='http:')&&
      DOMAIN.has(site.hostname.toLowerCase())&&
      (site.pathname==='/'||site.pathname==='')&&!site.search&&!site.hash;
  }catch{return false;}
}
export function parseBingDay(value) {
  if(typeof value!=='string')return null;
  const direct=value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
  if(direct){
    const millis=Date.parse(direct[1]+'T12:00:00Z');
    return Number.isFinite(millis)&&new Date(millis).toISOString().startsWith(direct[1])?
      direct[1]:null;
  }
  const legacy=value.match(/^\/Date\((-?\d{10,16})(?:[+-]\d{4})?\)\/$/);
  if(!legacy)return null;
  const millis=Number(legacy[1]);
  if(!Number.isSafeInteger(millis))return null;
  const iso=new Date(millis);
  return Number.isFinite(iso.getTime())?iso.toISOString().slice(0,10):null;
}
export function parseBingTraffic(rows) {
  if(!Array.isArray(rows))return null;
  const dates=new Map();
  for(const row of rows){
    const date=parseBingDay(row?.Date);
    const clicks=count(row?.Clicks),impressions=count(row?.Impressions);
    if(!date||clicks===null||impressions===null||dates.has(date))return null;
    dates.set(date,{clicks,impressions});
  }
  return dates;
}
// Every selected Bing reporting day must exist. Missing rows are unknown,
// not assumed zero, because the API does not guarantee empty-day coverage.
export function summarizeBingPeriod(dates,start,end) {
  if(!(dates instanceof Map)||!start||!end||end<start)return null;
  let impressions=0,clicks=0;
  for(let day=start;day<=end;day=shiftDay(day,1)){
    const item=dates.get(day);
    if(!item)return null;
    impressions+=item.impressions;clicks+=item.clicks;
    if(!Number.isSafeInteger(impressions)||!Number.isSafeInteger(clicks))return null;
  }
  return {impressions,clicks,ctr:impressions>0?clicks/impressions:null,position:null};
}
async function bingRequest(method,apiKey,siteUrl='') {
  const url=new URL(BASE+method);
  url.searchParams.set('apikey',apiKey);
  if(siteUrl)url.searchParams.set('siteUrl',siteUrl);
  let response;
  try{
    response=await fetch(url.toString(),{
      headers:{Accept:'application/json'},signal:AbortSignal.timeout(17000)
    });
  }catch{
    throw Error('Bing Webmaster reporting could not be reached.');
  }
  if(!response.ok){
    if([401,403].includes(response.status))
      throw Error('Bing Webmaster API key is invalid or lacks verified-site access.');
    if(response.status===429)
      throw Error('Bing Webmaster reporting limit reached.');
    throw Error('Bing Webmaster did not provide its report.');
  }
  const payload=await response.json().catch(()=>null);
  if(!payload||!Array.isArray(payload.d))
    throw Error('Bing Webmaster returned an unavailable or unrecognized report.');
  return payload.d;
}
export async function bingWebmasterReport(range) {
  // The key must be set in the backend project environment, never in client code.
  let apiKey;
  try{apiKey=await savedKey();}
  catch{return empty(range,'needs-attention','The encrypted Bing connection could not be loaded.');}
  if(!apiKey)return empty(range,'needs-setup',
    'Open the secure Bing connection form in Search & Discovery, then save your Bing Webmaster API key.');
  try{
    const sites=await bingRequest('GetUserSites',apiKey);
    const site=sites.filter(s=>siteMatch(s?.Url)&&
      (s?.IsVerified===true||s?.IsVerified===1||s?.IsVerified==='true'))
      .sort((a,b)=>String(b.Url).startsWith('https://docjaks.com')-
                      String(a.Url).startsWith('https://docjaks.com'))[0];
    if(!site)return empty(range,'needs-site',
      'Verify DOCJAKS.COM in Bing Webmaster Tools, or import it from Google Search Console.');
    const trafficRows=await bingRequest('GetRankAndTrafficStats',apiKey,site.Url);
    if(trafficRows.length===0)return empty(range,'not-reported',
      'Bing has not supplied daily search traffic for this site yet.',
      {site:site.Url});
    const dates=parseBingTraffic(trafficRows);
    if(!dates)return empty(range,'unavailable',
      'Bing returned missing or duplicate daily values; no totals have been assumed.');
    const yesterday=shiftDay(centralDay(),-1);
    const reported=[...dates.keys()].filter(day=>day<=yesterday).sort();
    const latest=reported.at(-1)||null;
    if(!latest||latest<range.start)
      return empty(range,'not-reported','Bing has no final reported days in the selected period.',
        {site:site.Url,reportedThrough:latest});
    const finish=range.endInclusive<latest?range.endInclusive:latest;
    const days=daysBetween(range.start,shiftDay(finish,1));
    const prevEnd=shiftDay(range.start,-1);
    const prevStart=shiftDay(range.start,-days);
    const scope={site:site.Url,reportedThrough:finish,
      currentRange:{start:range.start,end:finish},
      previousRange:{start:prevStart,end:prevEnd},
      definition:'All Bing Webmaster search verticals, including Web and Chat; not site visits.'};
    const current=summarizeBingPeriod(dates,range.start,finish);
    if(!current)return empty(range,'incomplete',
      'Bing did not return every day of this window. Missing dates remain N/A.',scope);
    const previous=summarizeBingPeriod(dates,prevStart,prevEnd);
    const paired=(field)=>({current:current[field],previous:previous?.[field]??null});
    return {
      ...empty(range,'connected',
        'Bing Webmaster daily impressions and clicks verified for the reported dates.',scope),
      connected:true,status:'connected',metrics:current,
      comparison:{
        status:previous?'reported':'unavailable',
        impressions:paired('impressions'),clicks:paired('clicks'),ctr:paired('ctr'),
        position:{current:null,previous:null}
      }
    };
  }catch(error) {
    return empty(range,'needs-attention',
      String(error?.message||'Bing Webmaster could not provide verified data.'));
  }
}
export const bingStatusEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);await authorize(req);
  const range=resolveReportWindow(req.query||{});
  res.setHeader('Cache-Control','no-store');
  return res.json(await bingWebmasterReport(range));
});

/* The owner pastes a Bing-generated key directly into their signed-in
   Command Center. Owner origin and CSRF are checked by authorize().
   Only an encrypted copy is saved. No credential appears in the response. */
export const bingKeyEndpoint=endpoint(async(req,res)=>{
  only(req,res,['POST','DELETE']);await authorize(req);
  if(req.method==='DELETE'){
    await redis('DEL',PREFIX+KEY_STORAGE);
    return res.json({success:true,configured:Boolean(env().BING_WEBMASTER_API_KEY)});
  }
  const body=input(req),key=String(body?.apiKey||'').trim();
  if(!/^[A-Za-z0-9_-]{12,256}$/.test(key))
    throw new AppError('Enter the Bing Webmaster API key from Settings → API Access.',400);
  let sites;
  try{sites=await bingRequest('GetUserSites',key);}
  catch(error){throw new AppError(error?.message||'Bing could not verify that API key.',400);}
  const verified=sites.some(site=>siteMatch(site?.Url)&&
    (site?.IsVerified===true||site?.IsVerified===1||site?.IsVerified==='true'));
  await write(KEY_STORAGE,seal({key,connectedAt:now()}));
  return res.json({success:true,saved:true,verified,
    message:verified?'Bing key saved. Search reporting is ready to check.':
      'Bing key saved, but DOCJAKS.COM still needs verification in Bing Webmaster Tools.'});
});
