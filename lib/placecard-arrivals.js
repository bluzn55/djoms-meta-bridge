/* DOC JAKS · Independently verified consented SM Welcome arrivals.
   One anonymous page arrival per 30-minute browser session and saved placecard.
   Only day-level counters are retained. Never collect IP, user-agent, referrer
   URLs, names, emails, or persistent browser identifiers here. */
import {PREFIX, redis, read} from './core.js';
import {centralDay,shiftDay,daysBetween} from './report-window.js';

const TRACKING=/^docjaks_post_([a-f0-9]{32,48})_(facebook|instagram|x|youtube)$/;
const CAMPAIGNS={BBQ:'food',SOSS:'food',MUSIC:'music',BOOK:'book'};
const TTL=180*24*3600;
const DEDUPE=1800;
const INGEST_SCRIPT=[
  "if redis.call('SET',KEYS[1],'1','NX','EX',ARGV[2]) then",
  "  redis.call('HINCRBY',KEYS[2],ARGV[1],1)",
  "  redis.call('EXPIRE',KEYS[2],ARGV[3])",
  "  return 1",
  "end",
  "return 0"
].join('\n');
const REPORT_SCRIPT=[
  "local counts={}",
  "for _,key in ipairs(KEYS) do",
  "  local rows=redis.call('HGETALL',key)",
  "  for i=1,#rows,2 do",
  "    local id=rows[i]; local n=tonumber(rows[i+1]) or 0",
  "    counts[id]=(counts[id] or 0)+n",
  "  end",
  "end",
  "return cjson.encode(counts)"
].join('\n');

export function parsePlacecardTag(value){
  if(typeof value!=='string')return null;
  const match=TRACKING.exec(value);
  if(!match)return null;
  const raw=match[1];
  const recordId=raw.length===32?
    raw.slice(0,8)+'-'+raw.slice(8,12)+'-'+raw.slice(12,16)+'-'+
    raw.slice(16,20)+'-'+raw.slice(20):raw;
  return {trackingId:value,recordId,platform:match[2]};
}

export async function recordPlacecardArrival(body,sessionId){
  // Run only for consented view events emitted from SM Welcome.
  if(body?.event!=='view'||body?.path!=='/sm-welcome')return false;
  const tag=parsePlacecardTag(body?.trackingId);
  if(!tag||body.source!==tag.platform)return false;
  const record=await read('record:'+tag.recordId);
  if(!record||!Object.hasOwn(CAMPAIGNS,record.campaign)||
    String(record.id||'').replace(/-/g,'').toLowerCase()!==
    tag.trackingId.slice('docjaks_post_'.length,-('_'+tag.platform).length)||
    body.campaign!=='docjaks_'+CAMPAIGNS[record.campaign])return false;
  const today=centralDay();
  const dedupe=PREFIX+'pc-arrival:seen:'+tag.trackingId+':'+sessionId;
  const bucket=PREFIX+'pc-arrival:day:'+today;
  const added=await redis('EVAL',INGEST_SCRIPT,2,
    dedupe,bucket,tag.trackingId,String(DEDUPE),String(TTL));
  return Number(added)===1;
}

export async function placecardArrivalTotals(window){
  if(!window||!window.start||!window.end||
    !Number.isInteger(daysBetween(window.start,window.end))||
    daysBetween(window.start,window.end)<1||
    daysBetween(window.start,window.end)>366)
    throw new Error('Invalid placecard reporting dates.');
  const keys=[];
  for(let day=window.start;day<window.end;day=shiftDay(day,1))
    keys.push(PREFIX+'pc-arrival:day:'+day);
  const response=await redis('EVAL',REPORT_SCRIPT,keys.length,...keys);
  const data=JSON.parse(response||'{}');
  const result=new Map();
  for(const [key,value] of Object.entries(data)){
    if(!parsePlacecardTag(key)||!Number.isSafeInteger(value)||value<0)
      throw new Error('Unrecognized placecard arrivals report.');
    result.set(key,value);
  }
  return result;
}
