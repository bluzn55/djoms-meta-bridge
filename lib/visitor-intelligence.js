/* DOC JAKS · privacy-conscious returning browser telemetry.
   Optional Wix ANALYTICS embed. No IP, emails, names, phone numbers, or
   full referral URLs are ever stored. Owner report requires DJOMS login.
   Do not compare these consent-dependent browser IDs with Wix people. */
import { AppError, PREFIX, redis, authorize, endpoint, only } from './core.js';
import { resolveReportWindow, shiftDay, centralDay } from './report-window.js';
import { recordPlacecardArrival } from './placecard-arrivals.js';

const P = PREFIX + 'aud:v1:';
const TTL = 180 * 24 * 60 * 60;
const MAX_SESSION_ROWS = 600;
const ORIGINS = new Set(['https://www.docjaks.com', 'https://docjaks.com']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PATH = /^\/[a-zA-Z0-9\-._~!$&'()+,;=:@/%]{0,179}$/;
const EVAL_INGEST = [
  "local vid=ARGV[1]; local sid=ARGV[2]; local pid=ARGV[3]",
  "local now=ARGV[4]; local iso=ARGV[5]; local path=ARGV[6]",
  "local source=ARGV[7]; local campaign=ARGV[8]; local referrer=ARGV[9]",
  "local seconds=tonumber(ARGV[10]); local kind=ARGV[11]; local ttl=tonumber(ARGV[12])",
  "if redis.call('EXISTS',KEYS[2])==1 and redis.call('HGET',KEYS[2],'visitorId')~=vid then return {err='session_conflict'} end",
  "if kind=='view' then",
  "  if redis.call('EXISTS',KEYS[2])==0 then",
  "    redis.call('HSET',KEYS[2],'visitorId',vid,'firstAt',iso,'lastAt',iso,'entryPage',path,'lastPage',path,'source',source,'campaign',campaign,'referrer',referrer,'views',0,'activeSeconds',0)",
  "    redis.call('HINCRBY',KEYS[1],'sessions',1)",
  "    redis.call('HSETNX',KEYS[1],'firstAt',iso)",
  "    redis.call('HSET',KEYS[1],'lastSource',source,'lastEntryPage',path)",
  "    redis.call('ZADD',KEYS[5],now,sid)",
  "  end",
  "  if tonumber(redis.call('HGET',KEYS[2],'views') or '0')>=200 then return {err='session_view_limit'} end",
  "  if redis.call('HSETNX',KEYS[3],'path',path)==1 then",
  "    redis.call('HSET',KEYS[3],'at',iso,'activeSeconds',0,'visitorId',vid,'sessionId',sid)",
  "    redis.call('HINCRBY',KEYS[1],'views',1)",
  "    redis.call('HINCRBY',KEYS[2],'views',1)",
  "    redis.call('LPUSH',KEYS[6],pid)",
  "    redis.call('LTRIM',KEYS[6],0,39)",
  "  end",
  "  redis.call('HSET',KEYS[1],'lastAt',iso,'lastPath',path)",
  "  redis.call('HSET',KEYS[2],'lastAt',iso,'lastPage',path)",
  "  redis.call('ZADD',KEYS[4],now,vid)",
  "  redis.call('SET',KEYS[7],iso,'NX')",
  "elseif kind=='engagement' then",
  "  if redis.call('HGET',KEYS[3],'visitorId')~=vid or redis.call('HGET',KEYS[3],'sessionId')~=sid then return {err='unknown_page_view'} end",
  "  local prior=tonumber(redis.call('HGET',KEYS[3],'activeSeconds') or '0')",
  "  local increase=math.max(0,math.min(3600,seconds)-prior)",
  "  if increase>0 then",
  "    redis.call('HSET',KEYS[3],'activeSeconds',math.min(3600,seconds))",
  "    redis.call('HINCRBY',KEYS[1],'activeSeconds',increase)",
  "    redis.call('HINCRBY',KEYS[2],'activeSeconds',increase)",
  "  end",
  "else return {err='invalid_event'} end",
  "redis.call('EXPIRE',KEYS[1],ttl)",
  "redis.call('EXPIRE',KEYS[2],ttl)",
  "redis.call('EXPIRE',KEYS[3],ttl)",
  "redis.call('EXPIRE',KEYS[6],ttl)",
  "return 1"
].join('\n');

const EVAL_REPORT = [
  "local total=redis.call('ZCOUNT',KEYS[1],ARGV[1],ARGV[2])",
  "local ids=redis.call('ZREVRANGEBYSCORE',KEYS[1],ARGV[2],ARGV[1],'LIMIT',0,tonumber(ARGV[3]))",
  "local rows={}",
  "for _,sid in ipairs(ids) do",
  "  local s=redis.call('HMGET',ARGV[4]..sid,'visitorId','firstAt','lastAt','entryPage','lastPage','source','campaign','views','activeSeconds')",
  "  if s[1] then",
  "    local v=redis.call('HMGET',ARGV[5]..s[1],'firstAt','lastAt','sessions','views','activeSeconds','lastSource','lastEntryPage')",
  "    local pageIds=redis.call('LRANGE',ARGV[6]..sid,0,19)",
  "    local pages={}",
  "    for _,pid in ipairs(pageIds) do",
  "      local p=redis.call('HMGET',ARGV[7]..pid,'path','at','activeSeconds')",
  "      if p[1] then table.insert(pages,p) end",
  "    end",
  "    table.insert(rows,{sid,s,v,pages})",
  "  end",
  "end",
  "return cjson.encode({total=total,rows=rows})"
].join('\n');

function cleanText(value,max=65) {
  return typeof value==='string' ? value.replace(/[\x00-\x1f\x7f<>]/g,'').trim().slice(0,max) : '';
}
function asNumber(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n>=0 ? n : 0;
}
function msCentral(day) {
  // At 06:00 UTC, Chicago is still before its 02:00 DST transition.
  const d = new Date(day+'T06:00:00.000Z');
  const zone = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',timeZoneName:'shortOffset'})
    .formatToParts(d).find(p=>p.type==='timeZoneName')?.value || 'GMT-6';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zone);
  if(!m) throw new AppError('Central reporting timezone is unavailable.',503);
  const mins = (m[1]==='-'?-1:1) * (Number(m[2])*60 + Number(m[3]||0));
  return Date.parse(day+'T00:00:00Z') - mins*60000;
}
function isBot(req) {
  return /(?:\bbot\b|spider|crawler|facebookexternalhit|googlebot|bingbot|headlesschrome|lighthouse)/i
    .test(String(req.headers['user-agent']||''));
}
function handleCors(req,res) {
  const origin=String(req.headers.origin||'');
  if (!ORIGINS.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Max-Age','3600');
  res.setHeader('Vary','Origin');
  return true;
}
export const visitorEventEndpoint=endpoint(async(req,res)=>{
  only(req,res,['POST','OPTIONS']);
  if (!handleCors(req,res)) throw new AppError('Unrecognized website origin.',403);
  if(req.method==='OPTIONS') {res.status(204).end();return;}
  if(isBot(req)){res.json({ok:true,ignored:true});return;}
  const length=Number(req.headers['content-length']||0);
  if(length>4096)throw new AppError('Event body is too large.',413);
  const body=typeof req.body==='string' ? JSON.parse(req.body) : req.body;
  if(!body||body.type!=='docjaks:visitor-intel'||body.version!==1
    ||!UUID.test(String(body.visitorId||''))||!UUID.test(String(body.sessionId||''))
    ||!UUID.test(String(body.pageId||''))||!['view','engagement'].includes(body.event)
    ||typeof body.path!=='string'||!PATH.test(body.path)
    ||!Number.isInteger(body.activeSeconds)||body.activeSeconds<0||body.activeSeconds>3600)
    throw new AppError('Invalid anonymous site event.',400);
  const origin=String(req.headers.origin);
  const vid=body.visitorId.toLowerCase(),sid=body.sessionId.toLowerCase(),pid=body.pageId.toLowerCase();
  const source=cleanText(body.source)||'Direct / Unknown';
  const campaign=cleanText(body.campaign)||'';
  const referrer=cleanText(body.referrer,100);
  const now=Date.now(),iso=new Date(now).toISOString();
  await redis('EVAL',EVAL_INGEST,7,
    P+'visitor:'+vid,P+'session:'+sid,P+'page:'+pid,P+'visitors',P+'sessions',P+'pages:'+sid,P+'started',
    vid,sid,pid,String(now),iso,body.path,source,campaign,referrer,
    String(body.activeSeconds),body.event,String(TTL));
  // The existing Wix ANALYTICS-consented tracker supplies the optional
  // UTM placecard ID. Retain only aggregated arrival counts, separately
  // from Wix visits and anonymous returning-browser intelligence.
  const placecardRecorded=await recordPlacecardArrival(body,sid);
  res.json({ok:true,placecardRecorded});
});

export const visitorIntelligenceEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const period=resolveReportWindow(req.query || {});
  const min=msCentral(period.start),max=msCentral(period.end)-1;
  const raw=await redis('EVAL',EVAL_REPORT,1,P+'sessions',String(min),String(max),
    String(MAX_SESSION_ROWS+1),P+'session:',P+'visitor:',P+'pages:',P+'page:');
  const content=JSON.parse(raw||'{}');
  const total=asNumber(content.total);
  const rows=Array.isArray(content.rows)?content.rows:[];
  const partial=total>MAX_SESSION_ROWS;
  const seen=new Map();
  for(const [sid,s,v,rawPages] of rows.slice(0,MAX_SESSION_ROWS)){
    if(!Array.isArray(s)||typeof s[0]!=='string'||!Array.isArray(v))continue;
    const vid=s[0];
    const label='Visitor #'+vid.slice(0,8).toUpperCase();
    if(!seen.has(vid)){
      seen.set(vid,{
        label,firstSeen:v[0]||null,lastSeen:v[1]||null,
        lifetimeSessions:asNumber(v[2]),lifetimeViews:asNumber(v[3]),
        lifetimeActiveSeconds:asNumber(v[4]),
        lastSource:v[5]||'Direct / Unknown',lastEntryPage:v[6]||null,
        sessions:[]
      });
    }
    const visitor=seen.get(vid);
    if(visitor.sessions.length < 15) visitor.sessions.push({
      startedAt:s[1]||null,lastSeen:s[2]||null,
      entryPage:s[3]||null,lastPage:s[4]||null,
      source:s[5]||'Direct / Unknown',campaign:s[6]||'',
      views:asNumber(s[7]),activeSeconds:asNumber(s[8]),
      pages:Array.isArray(rawPages)?rawPages.reverse().map(p=>({
        path:p[0]||'/',at:p[1]||null,activeSeconds:asNumber(p[2])
      })):[]
    });
  }
  const all=[...seen.values()];
  all.sort((a,b)=>b.lifetimeSessions-a.lifetimeSessions ||
    String(b.lastSeen||'').localeCompare(String(a.lastSeen||'')));
  const started=await redis('GET',P+'started');
  const cutoff=shiftDay(centralDay(),-180);
  const partialCoverage=period.start<cutoff ||
    !!(started&&period.start<started.slice(0,10));
  res.json({
    status:started?'reported':'not_started',source:'DJOMS anonymous browser tracker',
    checkedAt:new Date().toISOString(),trackingSince:started||null,
    range:{start:period.start,endInclusive:period.endInclusive},
    retentionDays:180,partial,partialCoverage,
    trackedBrowsers:partial?null:seen.size,
    trackedSessions:partial?null:total,
    repeatBrowsers:partial?null:all.filter(v=>v.lifetimeSessions>=2).length,
    visitors:all.slice(0,100),
    caveat:'Anonymous, analytics-consented browser IDs only. Tracking begins after installation. These counts cannot be added to or equated with Wix unique visitors.'
  });
});
