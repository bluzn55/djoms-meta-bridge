/* DOC JAKS · Outlaw Radio 5150 · owner-recorded Radio.co evidence.
   No automatic listener API is available through the current connection.
   Only anonymous aggregates and approximate live-place observations are kept.
   No IPs, listener IDs, names, addresses or precise coordinates. */
import {AppError,authorize,only,endpoint,input,read,write,withLock,id,now} from './core.js';
import {resolveReportWindow,centralDay} from './report-window.js';

const LOCATION_KEY='radio:audience:live-place-observations:v1';
const OVERVIEW_KEY='radio:audience:overview:v1:';
const MAX_SNAPSHOTS=120;
const validNumber=n=>Number.isSafeInteger(n)&&n>=0;
const safeNumber=(n,label,max=1000000)=>{
  if(!validNumber(n)||n>max)throw new AppError(label+' must be a valid whole number.');
  return n;
};
const optionalNumber=(n,label,max=1000000)=>
  n===null||n===undefined||n===''?null:safeNumber(n,label,max);
const locationText=(s,label,max=75,required=true)=>{
  if(s===null||s===undefined){if(!required)return '';throw new AppError('Enter a '+label+'.');}
  if(typeof s!=='string')throw new AppError('Invalid '+label+'.');
  const trimmed=s.trim();
  if(required&&!trimmed)throw new AppError('Enter a '+label+'.');
  if(trimmed.length>max||/[<>\\\x00-\x1f\x7f]/u.test(trimmed)||
    /\b(?:https?:|www\.|@)\b/i.test(trimmed))throw new AppError('Invalid '+label+'.');
  return trimmed;
};
const safeDay=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&
  new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;

function chicagoDay(iso){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date(iso)).filter(p=>p.type!=='literal')
    .map(p=>[p.type,p.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function overviewKey(start,endInclusive){
  if(!safeDay(start)||!safeDay(endInclusive)||endInclusive<start)
    throw new AppError('Choose valid Radio.co Overview dates.');
  return OVERVIEW_KEY+start+':'+endInclusive;
}
export function cleanOverview(body){
  const start=body.start,endInclusive=body.endInclusive;
  if(!safeDay(start)||!safeDay(endInclusive))throw new AppError('Choose valid UTC date labels.');
  const window=resolveReportWindow({range:'custom',start,end:endInclusive});
  if(window.days>60)throw new AppError('Use a Radio.co Overview window of up to 60 days.');
  if(body.sourceConfirmed!==true)throw new AppError('Confirm the figures came from Radio.co Overview.');
  const totalConnections=safeNumber(body.totalConnections,'Total stream connections');
  const uniqueListeners=safeNumber(body.uniqueListeners,'Unique listeners');
  if(uniqueListeners>totalConnections)throw new AppError('Unique listeners cannot exceed total connections.');
  const averageSeconds=optionalNumber(body.averageSeconds,'Average listening seconds',86400);
  const peakConnections=optionalNumber(body.peakConnections,'Peak simultaneous connections',1000000);
  if(peakConnections!==null&&peakConnections>totalConnections)
    throw new AppError('Peak connections cannot exceed total connections.');
  if(totalConnections===0&&(averageSeconds!==null&&averageSeconds>0||peakConnections!==null&&peakConnections>0))
    throw new AppError('Listening averages and peaks must be zero or blank when there are no connections.');
  return {
    station:'Outlaw Radio 5150',start,endInclusive,
    timezone:'UTC calendar labels',
    totalConnections,uniqueListeners,averageSeconds,peakConnections,
    source:'Owner-entered · Radio.co Statistics Overview',
    capturedAt:now(),manual:true,
    note:'A verified screenshot/manual transcription of Radio.co Overview, not a live API connection. The selected period and observation timestamp are preserved.'
  };
}
export function cleanLiveLocation(body){
  if(body.sourceConfirmed!==true)
    throw new AppError('Confirm that the location came from the Radio.co Real Time map.');
  const country=locationText(body.country,'country',70);
  const city=locationText(body.city,'city or town',75,false);
  const region=locationText(body.region,'region or state',65,false);
  const connections=safeNumber(body.connections,'Simultaneous live connections',5000);
  if(connections<1)throw new AppError('Enter at least one observed connection.');
  const capturedAt=now();
  return {
    id:id(),station:'Outlaw Radio 5150',country,city,region,
    connections,capturedAt,observedDay:chicagoDay(capturedAt),
    source:'Owner-recorded · Radio.co Real Time map',
    cityVerified:!!city,manual:true,
    note:'Point-in-time live connection observation. This does not establish historical audience totals, unique listeners or precise personal locations.'
  };
}
export const radioAudienceEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  await authorize(req);
  res.setHeader('Cache-Control','private, no-store');
  if(req.method==='GET'){
    const period=resolveReportWindow(req.query||{});
    const overview=await read(overviewKey(period.start,period.endInclusive));
    const saved=await read(LOCATION_KEY);
    const observations=(Array.isArray(saved)?saved:[])
      .filter(row=>row?.observedDay>=period.start&&
        row?.observedDay<=period.endInclusive&&row.source&&row.country)
      .slice(0,50);
    return res.json({
      status:'reported',station:'Outlaw Radio 5150',
      source:'Owner-recorded Radio.co evidence; no live listener API connected',
      range:{start:period.start,end:period.end,endInclusive:period.endInclusive,
        selection:period.range,timezone:'America/Chicago',days:period.days},
      overview:overview||null,liveLocations:observations,
      locationCoverage:observations.length?'owner-recorded snapshots':'not_observed',
      locationNote:'Radio.co Real Time may reveal an approximate city/town. This report does not infer cities from stream country totals or Wix website traffic.',
      privacy:'No IPs, listener identifiers, addresses or map coordinates are stored.'
    });
  }
  const body=input(req);
  if(body.kind==='overview'){
    const entry=cleanOverview(body);
    return withLock('radio-audience-overview:'+entry.start+':'+entry.endInclusive,async()=>{
      const key=overviewKey(entry.start,entry.endInclusive);
      const original=await read(key);
      if(original&&body.replaceExisting!==true)
        throw new AppError('A Radio.co Overview snapshot already exists for these dates. Confirm replacement.',409);
      await write(key,entry);
      return res.json({status:'saved',kind:'overview',entry,replaced:!!original});
    });
  }
  if(body.kind==='live-location'){
    const entry=cleanLiveLocation(body);
    return withLock('radio-audience-live-places',async()=>{
      const list=await read(LOCATION_KEY);
      const rows=Array.isArray(list)?list:[];
      // Owner may press twice; avoid duplicate snapshots within one minute
      // with identical location and connection count.
      const repeat=rows.find(row=>row.country===entry.country&&
        row.city===entry.city&&row.region===entry.region&&
        row.connections===entry.connections&&
        Date.parse(entry.capturedAt)-Date.parse(row.capturedAt)<60000);
      if(repeat)return res.json({status:'already_recorded',kind:'live-location',entry:repeat});
      const next=[entry,...rows].slice(0,MAX_SNAPSHOTS);
      await write(LOCATION_KEY,next);
      return res.json({status:'saved',kind:'live-location',entry});
    });
  }
  throw new AppError('Choose Radio.co Overview or Live Town/City observation.');
});