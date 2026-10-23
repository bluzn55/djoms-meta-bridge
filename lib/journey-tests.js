// Doc Jaks · owner-only visitor journey change tests.
// The baseline is the owner's recorded verified snapshot for a specific
// reporting window. The comparison is a trend, never proof of causation.
import {AppError,endpoint,only,authorize,input,read,write,withLock,id,now} from './core.js';

const KEY='visitor-journey-tests-v1';
const RANGE_DAYS={today:1,'7d':7,'30d':30};
const VALID_METRICS=new Set(['searchCtr','searchClicks','siteVisitors','siteBounceRate','sitePageViews','formSubmissions','fileDownloads','paidOrders','grossSalesCents']);
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'));
const dayDiff=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000);
const safeNote=value=>typeof value==='string'?value.trim().replace(/\s+/g,' '):'';
const stored=async()=>{const rows=await read(KEY);return Array.isArray(rows)?rows:[];};
export const journeyTestsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST','DELETE']);await authorize(req);
  if(req.method==='GET')return res.json({tests:await stored()});
  const p=input(req);
  if(req.method==='POST'){
    const note=safeNote(p.note),range=String(p.range||''),metric=String(p.metric||'');
    const baseline=p.baseline;
    const days=RANGE_DAYS[range];
    if(note.length<5||note.length>180)throw new AppError('Describe the change in 5 to 180 characters.');
    if(!VALID_METRICS.has(metric)||!days)throw new AppError('Select an available measured goal and Day, Week, or Month.');
    if(!validDay(p.start)||!validDay(p.endInclusive)||dayDiff(p.start,p.endInclusive)!==days-1)
      throw new AppError('The baseline dates must be one complete matching reporting window.');
    if(typeof baseline!=='number'||!Number.isFinite(baseline)||baseline<0||baseline>1e12)
      throw new AppError('The baseline must come from an available verified report.');
    return withLock(KEY,async()=>{
      const previous=await stored();
      const entry={id:id(),note,metric,range,days,baseline,
        baselineStart:p.start,baselineEnd:p.endInclusive,createdAt:now()};
      const tests=[entry,...previous].slice(0,35);
      await write(KEY,tests);
      return res.json({saved:true,tests});
    });
  }
  if(typeof p.id!=='string'||!/^[a-f0-9]{36}$/.test(p.id))throw new AppError('Select a saved change to remove.');
  return withLock(KEY,async()=>{
    const previous=await stored();
    if(!previous.some(t=>t.id===p.id))throw new AppError('The recorded change could not be found.',404);
    const tests=previous.filter(t=>t.id!==p.id);
    await write(KEY,tests);
    return res.json({removed:true,tests});
  });
});
