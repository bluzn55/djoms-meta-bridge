// One authoritative DJOMS reporting window, resolved in America/Chicago.
// End is exclusive. Custom selections are inclusive calendar dates from UI.
// No report may silently substitute a seven-day window for an unsupported range.
import { AppError } from './core.js';

export const REPORT_TZ = 'America/Chicago';
export const PERIOD_DAYS = Object.freeze({today:1,'7d':7,'30d':30,'365d':365});
export const MAX_CUSTOM_DAYS = 366;

export function centralDay(at=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
    timeZone:REPORT_TZ,year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(at).map(p=>[p.type,p.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}

export function shiftDay(day,offset) {
  const date=new Date(day+'T12:00:00Z');
  date.setUTCDate(date.getUTCDate()+offset);
  return date.toISOString().slice(0,10);
}

export function calendarDay(day) {
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  const d=new Date(day+'T12:00:00Z');
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===day;
}

export function daysBetween(start,endExclusive) {
  return Math.round((Date.parse(endExclusive+'T12:00:00Z')-Date.parse(start+'T12:00:00Z'))/86400000);
}

export function resolveReportWindow(query={},today=centralDay()) {
  const range=String(query.range||'').trim();
  const explicit=range==='custom';
  if(explicit) {
    const start=query.start,end=query.end;
    if(!calendarDay(start)||!calendarDay(end)||start>end)
      throw new AppError('Choose a valid start and end date.',400);
    if(end>today)throw new AppError('End date cannot be later than today.',400);
    const endExclusive=shiftDay(end,1);
    const days=daysBetween(start,endExclusive);
    if(days<1||days>MAX_CUSTOM_DAYS)
      throw new AppError('Choose a range of 1 to 366 days.',400);
    return {range:'custom',start,end:endExclusive,endInclusive:end,days,timezone:REPORT_TZ,includesToday:end===today};
  }
  const legacy=String(query.days||'');
  const days=Object.hasOwn(PERIOD_DAYS,range)?PERIOD_DAYS[range]
    : !range && ['7','28'].includes(legacy)?Number(legacy)
    : !range&&!legacy?7:null;
  if(days===null)throw new AppError('Choose Day, Week, Month, Year, or Custom.',400);
  const start=shiftDay(today,1-days),end=shiftDay(today,1);
  return {range:range|| (days===28?'28d':'7d'),start,end,endInclusive:today,days,timezone:REPORT_TZ,includesToday:true};
}
