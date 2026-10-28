/* Radio.co listener intelligence: owner-only, imported aggregates.
   Store no IP addresses, names, listener IDs, or individual connection histories. */
import {createHash} from 'node:crypto';
import {AppError,authorize,endpoint,input,only,redis,withLock,PREFIX} from './core.js';
import {resolveReportWindow,shiftDay,daysBetween} from './report-window.js';
import {buildRadioReport} from './radio-report.js';
const P='radio-intel:v1:';
const key=(type,d)=>P+type+':'+d;
function fail(msg){throw new AppError(msg,400);}
function num(v,name){
  const n=Number(v);
  if(typeof v!=='string'||v.trim()===''||!Number.isFinite(n)||n<0||n>1e8)fail('Invalid '+name+'.');
  return n;
}
function whole(v,name){const n=num(v,name);if(!Number.isSafeInteger(n))fail('Invalid whole-number '+name+'.');return n;}
function csvRows(csv){
  if(typeof csv!=='string'||!csv.trim()||Buffer.byteLength(csv,'utf8')>350000)
    fail('Choose a Radio.co CSV under 350 KB.');
  const rows=[];let fields=[],field='',quoted=false;
  for(let i=0;i<csv.length;i++){
    const c=csv[i];
    if(c==='"'){if(quoted&&csv[i+1]==='"'){field+='"';i++;}
      else if(quoted)quoted=false;else if(!field)quoted=true;else fail('Invalid CSV quotes.');}
    else if(!quoted&&c===','){fields.push(field);field='';}
    else if(!quoted&&(c==='\r'||c==='\n')){
      fields.push(field);field='';if(fields.some(x=>x.trim()))rows.push(fields);fields=[];
      if(c==='\r'&&csv[i+1]==='\n')i++;
    }else field+=c;
    if(rows.length>2501||field.length>10000)fail('CSV is too large.');
  }
  if(quoted)fail('CSV quote is not closed.');
  fields.push(field);if(fields.some(x=>x.trim()))rows.push(fields);
  if(rows.length<2)fail('CSV has no data.');
  const h=rows.shift().map(x=>x.replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''));
  if(h.length>90||h.some(x=>!x)||new Set(h).size!==h.length)fail('CSV columns are invalid.');
  return {h,items:rows.map(r=>{
    if(r.length!==h.length)fail('CSV row has unexpected column count.');
    return Object.fromEntries(h.map((c,i)=>[c,r[i].trim()]));
  })};
}
function iso(value){
  const s=String(value||'').trim();
  if(/^\d{4}-\d\d-\d\d$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s)
    return s+'T00:00:00.000Z';
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s)
    ||!Number.isFinite(Date.parse(s)))fail('Radio.co CSV date is not ISO format.');
  return new Date(s).toISOString();
}
function seconds(x){
  const s=String(x||'').trim();
  if(/^\d{1,5}:\d\d:\d\d$/.test(s)){
    const [h,m,n]=s.split(':').map(Number);if(m>=60||n>=60)fail('Bad hh:mm:ss value.');
    return h*3600+m*60+n;
  }
  return num(s,'listening duration');
}
function segment(r,prefix){
  const result={};
  for(const [k,v] of Object.entries(r))if(k.startsWith(prefix)){
    const label=k.slice(prefix.length).replace(/_/g,' ').slice(0,70);
    const amount=whole(v,k);
    if(label&&amount>0)result[label]=amount;
  }
  return result;
}
export function parseRadioCsv(kind,csv,filename){
  if(!['overview','ttsl'].includes(kind))fail('Use Overview or TTSL.');
  const name=String(filename||'').split(/[\/\\]/).at(-1);
  if(!/^[A-Za-z0-9_(). \-]{3,130}\.csv$/i.test(name))fail('Choose a downloaded Radio.co CSV.');
  const {h,items}=csvRows(csv),dateField=['epoch','date','day','listening_date'].find(x=>h.includes(x));
  if(!dateField)fail('CSV needs an epoch or date column.');
  const parsed=items.map(r=>{
    const stamp=iso(r[dateField]),date=stamp.slice(0,10);
    if(kind==='overview'){
      if(!['total_listeners','unique_listeners','peak_listeners','ttsl'].every(k=>h.includes(k)))
        fail('Not a Radio.co Overview export.');
      const connections=whole(r.total_listeners,'total listeners'),
        dailyUnique=whole(r.unique_listeners,'daily unique'),peak=whole(r.peak_listeners,'peak');
      if(dailyUnique>connections||peak>connections)fail('Listener totals disagree for '+date+'.');
      return {date,stamp,connections,dailyUnique,peak,listeningSeconds:seconds(r.ttsl),
        averageSeconds:h.includes('avg_duration')?num(r.avg_duration,'average duration'):null,
        countries:segment(r,'regions_'),devices:segment(r,'devices_'),clients:segment(r,'clients_')};
    }
    const col=['time_spent_listening_hh_mm_ss','time_spent_listening','total_listening_time',
      'listening_time','total_listening','listening_duration','duration','ttsl','seconds']
      .find(k=>h.includes(k));
    if(!col)fail('TTSL CSV format not yet recognized. Send the exported file for review.');
    return {date,listeningSeconds:seconds(r[col])};
  });
  const days=[...new Set(parsed.map(x=>x.date))].sort();
  if(days.some(d=>d<'2020-01-01'||d>shiftDay(new Date().toISOString().slice(0,10),1)))
    fail('Dates outside the supported report window.');
  if(new Set(parsed.map(x=>x.stamp||x.date)).size!==parsed.length)fail('CSV has duplicate timestamps.');
  const hourly=kind==='overview'&&(parsed.length!==days.length||
    parsed.some(x=>!x.stamp.endsWith('T00:00:00.000Z')));
  if(hourly&&days.length!==1)fail('Hourly data must be downloaded for one day at a time.');
  const source={kind,filename:name,grain:hourly?'hour':'day',
    sha256:createHash('sha256').update(csv).digest('hex'),importedAt:new Date().toISOString()};
  const changes=hourly?[{name:key('hour',days[0]),
    value:{date:days[0],source,rows:parsed.sort((a,b)=>a.stamp.localeCompare(b.stamp))}}]:
    parsed.map(x=>({name:key(kind,x.date),value:{...x,source}}));
  return {source,changes,days,count:parsed.length};
}
function json(s){try{return s?JSON.parse(s):null;}catch{return null;}}
function legacyDays(){
  const report=buildRadioReport(),m=new Map();
  for(const source of [...(report.archivedImports||[]),report])
    for(const r of source.rows||[])m.set(r.date,{
      date:r.date,connections:r.connections,dailyUnique:r.dailyUnique,
      peak:r.peak,listeningSeconds:r.ttslRaw,averageSeconds:r.averageDurationRaw,
      countries:r.countries,devices:r.devices,clients:r.clients,
      source:{kind:'overview',filename:source.sourceFile,legacy:true}});
  return m;
}
function summary(rows,count){
  const over=rows.filter(r=>r.overview).map(r=>r.overview);
  const withTime=rows.filter(r=>r.overview||r.ttsl);
  const sum=list=>list.reduce((v,n)=>v+n,0);
  const dim=name=>{
    const result={};
    for(const row of over)for(const [k,v] of Object.entries(row[name]||{}))
      result[k]=(result[k]||0)+v;
    return result;
  };
  return {connections:over.length?sum(over.map(r=>r.connections)):null,
    listeningSeconds:withTime.length?sum(withTime.map(r=>r.ttsl?.listeningSeconds??r.overview.listeningSeconds)):null,
    peak:over.length?Math.max(...over.map(r=>r.peak)):null,
    overviewDays:over.length,listeningDays:withTime.length,requestedDays:count,
    overviewComplete:over.length===count,listeningComplete:withTime.length===count,
    uniqueListeners:null,newListeners:null,returningListeners:null,
    countries:dim('countries'),devices:dim('devices'),clients:dim('clients')};
}
export const radioIntelligenceEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);await authorize(req);
  if(req.method==='POST'){
    const b=input(req),parsed=parseRadioCsv(b.kind,b.csv,b.filename);
    return withLock('radio-intel-import',async()=>{
      const saved=await redis('MGET',...parsed.changes.map(x=>PREFIX+x.name));
      const changes=[],conflicts=[];
      const clean=x=>{const {source,...rest}=x;return JSON.stringify(rest);};
      parsed.changes.forEach((x,i)=>{
        const existing=json(saved[i]);
        if(existing&&clean(existing)!==clean(x.value))conflicts.push(x.value.date);
        if(!existing||clean(existing)!==clean(x.value))changes.push(x);
      });
      if(conflicts.length&&b.replaceConflicts!==true)return res.json({
        status:'review_required',dates:conflicts.slice(0,30),conflictCount:conflicts.length,
        note:'Nothing changed. Confirm before replacing existing dates.'});
      const meta={...parsed.source,firstDate:parsed.days[0],
        lastDate:parsed.days.at(-1),rows:parsed.count};
      const args=changes.flatMap(x=>[PREFIX+x.name,JSON.stringify(x.value)]);
      args.push(PREFIX+P+'last:'+b.kind,JSON.stringify(meta));
      await redis('MSET',...args);
      res.json({status:'saved',meta,days:parsed.days.length,
        changed:changes.length,replaced:conflicts.length});
    });
  }
  const window=resolveReportWindow(req.query||{}),n=daysBetween(window.start,window.end),start=shiftDay(window.start,-n);
  const days=[];
  for(let day=start;day<window.end;day=shiftDay(day,1))days.push(day);
  const data=await redis('MGET',...days.flatMap(d=>[PREFIX+key('overview',d),PREFIX+key('ttsl',d)]));
  const legacy=legacyDays(),rows=days.map((date,i)=>({
    date,overview:json(data[i*2])||legacy.get(date)||null,ttsl:json(data[i*2+1])}));
  const selected=rows.filter(r=>r.date>=window.start);
  const hours=selected.slice(-31).map(x=>PREFIX+key('hour',x.date));
  const hourData=hours.length?await redis('MGET',...hours):[];
  const metadata=await redis('MGET',PREFIX+P+'last:overview',PREFIX+P+'last:ttsl');
  res.json({status:'reported',automaticSync:false,station:'Outlaw Radio 5150',
    range:{start:window.start,end:window.end,endInclusive:window.endInclusive,
      timezone:'America/Chicago',sourceDailyTimezone:'UTC'},
    summary:summary(selected,n),previous:summary(rows.filter(r=>r.date<window.start),n),
    rows:selected.filter(r=>r.overview||r.ttsl).map(r=>({
      date:r.date,connections:r.overview?.connections??null,
      dailyUnique:r.overview?.dailyUnique??null,peak:r.overview?.peak??null,
      listeningSeconds:r.ttsl?.listeningSeconds??r.overview?.listeningSeconds??null,
      averageSeconds:r.overview?.averageSeconds??null,
      countries:r.overview?.countries||{},devices:r.overview?.devices||{},clients:r.overview?.clients||{},
      source:r.overview?.source?.filename||r.ttsl?.source?.filename||null,
      durationConflict:!!(r.ttsl&&r.overview&&r.ttsl.listeningSeconds!==r.overview.listeningSeconds)
    })),
    hourly:hourData.flatMap(x=>json(x)?.rows||[]).sort((a,b)=>a.stamp.localeCompare(b.stamp)).slice(0,400),
    lastImports:{overview:json(metadata[0]),ttsl:json(metadata[1])},
    notes:[
      'CSV import is manual. No live Radio.co listener API is connected.',
      'Daily buckets from multi-day Radio.co exports are UTC, not Central time.',
      'Daily unique listeners cannot be added to get period unique listeners.',
      'New vs returning people are unavailable from aggregate station exports.',
      'Country, device, and client totals represent connections, not individuals.',
      'Hourly records describe time buckets, not individual listening sessions.',
      'Historical files are not added together on overlapping dates.'
    ]});
});
