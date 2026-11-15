/* Doc Jaks owner login security-event feed.
   Authenticated, aggregate counters from the actual DJOMS server sign-in gate.
   They show rejected sign-in attempts, NOT Wix firewall actions or proof of a breach. */
import { AppError, PREFIX, redis, authorize, endpoint, only } from './core.js';
import { resolveReportWindow, shiftDay } from './report-window.js';

const READ_EVENTS=[
  'local failed=0; local lockouts=0; local lastFailed=""; local lastLockout=""',
  'for _,key in ipairs(KEYS) do',
  '  local values=redis.call("HMGET",key,"failed","lockouts","lastFailureAt","lastLockoutAt")',
  '  failed=failed+tonumber(values[1] or "0")',
  '  lockouts=lockouts+tonumber(values[2] or "0")',
  '  if values[3] and values[3]>lastFailed then lastFailed=values[3] end',
  '  if values[4] and values[4]>lastLockout then lastLockout=values[4] end',
  'end',
  'return cjson.encode({failed=failed,lockouts=lockouts,lastFailed=lastFailed,lastLockout=lastLockout})'
].join('\n');

function nonNegative(n){
  return Number.isSafeInteger(n)&&n>=0?n:null;
}
export function summarizeOwnerLoginEvidence(raw,period){
  const failed=nonNegative(Number(raw?.failed));
  const lockouts=nonNegative(Number(raw?.lockouts));
  if(failed===null||lockouts===null)
    throw new AppError('Owner login safety totals could not be verified.',503);
  const validStamp=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))?s:null;
  return {
    status:'connected',
    source:'DJOMS server sign-in rejection counters',
    range:{start:period.start,endInclusive:period.endInclusive,selection:period.range},
    failedAdminLogins:failed,
    rateLimitLockouts:lockouts,
    lastFailureAt:validStamp(raw.lastFailed),
    lastLockoutAt:validStamp(raw.lastLockout),
    blockedRequests:null,
    failedWixLogins:null,
    confirmedAttack:null,
    note:'Counts observed rejected owner sign-ins and lockout windows from the DJOMS server. '+
      'One lockout is counted for a 10-minute lockout window, not for every blocked request. '+
      'Neither failed passwords nor rate limiting proves a website attack or unauthorized access. '+
      'No Wix-hosting firewall or Vercel DDoS evidence is connected.'
  };
}
export async function readOwnerLoginEvidence(period){
  if(!period?.start||!period?.endInclusive||!Number.isSafeInteger(period.days)||
      period.days<1||period.days>30)
    throw new AppError('Login-security history supports up to 30 calendar days.',400);
  const keys=[];
  for(let n=0;n<period.days;n++){
    const day=shiftDay(period.start,n);
    keys.push(PREFIX+'security:owner-login:'+day);
  }
  const raw=await redis('EVAL',READ_EVENTS,keys.length,...keys);
  const values=typeof raw==='string'?JSON.parse(raw):raw;
  return summarizeOwnerLoginEvidence(values,period);
}
export const securityEventsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const range=String(req.query?.range||'today');
  if(!['today','7d','30d'].includes(range))
    throw new AppError('Choose Today, 7 days, or 30 days.',400);
  const period=resolveReportWindow({range});
  const securityProof=await readOwnerLoginEvidence(period);
  res.setHeader('Cache-Control','private, no-store');
  res.json({checkedAt:new Date().toISOString(),securityProof});
});
