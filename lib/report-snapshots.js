// DOC JAKS · Owner-only saved snapshots for four-report mini trend lines.
// A snapshot represents actual source-reported totals captured on a Central
// calendar day. It is NOT a daily increment, a fabricated full history,
// or proof that business changes caused any observed movement.
import {AppError, endpoint, only, authorize, input, read, write, withLock, now} from './core.js';
import {centralDay, resolveReportWindow} from './report-window.js';

const KEY='report-total-snapshots-v1';
const RANGES=new Set(['today','7d','30d','365d']);
const METRICS=new Set([
  'searchAppearances','combinedCtr','googlePosition','googleAppearances',
  'searchClicks','websiteVisits','websiteVisitors','returningVisitors',
  'pageViews','averageStay','bounceRate','pagesPerVisit',
  'radioConnections','radioListeningSeconds','radioPageViews','musicPageViews',
  'webSalesCents','paidOrders',
  'facebookViews','instagramViews','facebookLikes','instagramLikes',
  'inquiries','fileDownloads','pitKreweSignups','uniqueRadioListeners'
]);
const FRACTIONS=new Set(['combinedCtr','bounceRate']);
const validAmount=(key,n)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e12&&
  (!FRACTIONS.has(key)||n<=1);
const latest=async()=>{
  const data=await read(KEY);
  return data?.version===1&&Array.isArray(data.rows)?data.rows:[];
};
const filtered=(rows,range)=>rows.filter(row=>row?.range===range&&
  /^\d{4}-\d{2}-\d{2}$/.test(row.day||'')&&row.values&&
  typeof row.values==='object').sort((a,b)=>a.day.localeCompare(b.day)).slice(-4);

export const reportSnapshotsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  await authorize(req);
  if(req.method==='GET'){
    const range=String(req.query?.range||'');
    if(!RANGES.has(range))throw new AppError('Choose Day, Week, Month or Year to see report history.');
    return res.json({status:'reported',range,rows:filtered(await latest(),range),
      note:'Central-day snapshots of selected reporting-window totals; not daily incremental counts.'});
  }
  const payload=input(req);
  const range=String(payload.range||'');
  if(!RANGES.has(range))throw new AppError('Snapshots require Day, Week, Month or Year.');
  // Prevent old/custom windows being relabelled as the current rolling report.
  const expected=resolveReportWindow({range});
  if(payload.start!==expected.start||payload.end!==expected.end)
    throw new AppError('Reporting dates changed. Refresh the Command Center and try again.');
  const incoming=payload.values;
  if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))
    throw new AppError('There are no verified report totals to save.');
  const entries=Object.entries(incoming);
  if(entries.length>METRICS.size||entries.some(([key,value])=>
    !METRICS.has(key)||!validAmount(key,value)))
    throw new AppError('The report contains an invalid total.');
  if(!entries.length)throw new AppError('Wait until at least one report source is verified.');
  const reported=Object.fromEntries(entries);
  const today=centralDay();
  return withLock(KEY,async()=>{
    const records=await latest();
    const old=records.find(row=>row.range===range&&row.day===today);
    const entry={
      range,day:today,rangeStart:expected.start,rangeEnd:expected.endInclusive,
      recordedAt:now(),values:{...(old?.values||{}),...reported}
    };
    const keep=records.filter(row=>!(row.range===range&&row.day===today));
    keep.push(entry);
    keep.sort((a,b)=>a.day.localeCompare(b.day)||a.range.localeCompare(b.range));
    // Keep 45 dates for each preset, far more than the four shown on screen.
    const pruned=[...RANGES].flatMap(k=>keep.filter(row=>row.range===k).slice(-45));
    await write(KEY,{version:1,rows:pruned});
    return res.json({status:'saved',range,rows:filtered(pruned,range),
      note:'Verified-source values supplied by the signed-in owner dashboard. Missing values are never changed into zero.'});
  });
});
