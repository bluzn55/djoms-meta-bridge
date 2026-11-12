/* Doc Jaks · owner-only IP observation history.
 * Saves a bounded, encrypted record of individual Wix session IDs by network.
 * "Seen before" means within captured Wix evidence, never all-time certainty.
 * No raw browsing pages or unverified aggregated sessions are retained here.
 */
import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {config,read,write,seal,unseal,withLock} from './core.js';
import {quietPeriodReturns} from './security-evidence.js';

const KEY='security:ip-visits:v1';
const RETAIN_DAYS=365;
const MAX_EVENTS=16000;
const MAX_NETWORKS_SHOWN=600;
const validIP=ip=>typeof ip==='string' && ip.length<=64 && isIP(ip)!==0;

function hash(value) {
  const secret=config().secret;
  if(typeof secret!=='string'||secret.length<32)
    throw new Error('IP history fingerprint key is unavailable.');
  return createHmac('sha256',secret).update(value).digest('hex');
}

function unpack(stored) {
  if(!stored)return {events:[],addresses:{}};
  if(stored.version!==1||typeof stored.sealed!=='string')
    throw new Error('Existing IP visit history could not be verified; it was left unchanged.');
  const data=unseal(stored.sealed);
  if(!data||!Array.isArray(data.events)||!data.addresses||
      typeof data.addresses!=='object'||Array.isArray(data.addresses))
    throw new Error('Saved IP history is invalid; it was left unchanged.');
  return data;
}

export function extractVisits(rows) {
  const found=[];
  for(const row of Array.isArray(rows)?rows:[]) {
    const f=row?.fields||{};
    const ip=f['traffic.ip_address']?.stringValue;
    const sessionId=f['traffic.bsi']?.stringValue;
    const stamp=f['traffic.created_date']?.timestampValue;
    const sessions=f['traffic.sessions_count']?.numericValue;
    if(!validIP(ip)||!sessionId||sessionId.length>250||
       !Number.isFinite(Date.parse(stamp||''))||sessions!==1)continue;
    const city=String(f['traffic.city']?.stringValue||'').slice(0,70);
    const region=String(f['traffic.region']?.stringValue||'').slice(0,40);
    const country=String(f['traffic.country_name']?.stringValue||'').slice(0,70);
    found.push({ip,sessionId,at:stamp,location:[city,region,country].filter(Boolean).join(', ')});
  }
  return found;
}

export async function recordVisitHistory(rows,partial=false) {
  const observations=extractVisits(rows);
  return withLock(KEY,async()=>{
    const previous=unpack(await read(KEY));
    const cutoff=Date.now()-RETAIN_DAYS*86400000;
    const events=previous.events.filter(e=>
      Number.isFinite(Date.parse(e?.at))&&Date.parse(e.at)>=cutoff&&
      typeof e.networkId==='string'&&typeof e.id==='string');
    const addresses={...previous.addresses};
    const known=new Set(events.map(e=>e.id));
    let newSessionsSaved=0;
    for(const visit of observations) {
      if(Date.parse(visit.at)<cutoff)continue;
      const networkId=hash('network:'+visit.ip).slice(0,24);
      const id=hash('session:'+visit.ip+':'+visit.sessionId).slice(0,40);
      if(known.has(id))continue;
      events.push({
        id,networkId,at:visit.at,
        location:visit.location.slice(0,150)
      });
      addresses[networkId]=visit.ip;
      known.add(id);newSessionsSaved++;
    }
    events.sort((a,b)=>b.at.localeCompare(a.at));
    const trimmed=events.length>MAX_EVENTS;
    const retained=events.slice(0,MAX_EVENTS);
    const active=new Set(retained.map(e=>e.networkId));
    const keptAddresses={};
    for(const networkId of active) {
      const address=addresses[networkId];
      if(validIP(address))keptAddresses[networkId]=address;
    }
    if(newSessionsSaved || retained.length!==previous.events.length ||
       Object.keys(keptAddresses).length!==Object.keys(previous.addresses).length) {
      await write(KEY,{version:1,sealed:seal({events:retained,addresses:keptAddresses})});
    }
    const groups=new Map();
    for(const event of retained) {
      if(!keptAddresses[event.networkId])continue;
      let g=groups.get(event.networkId);
      if(!g) {
        g={networkId:event.networkId,ipAddress:keptAddresses[event.networkId],
          firstObservedAt:event.at,lastObservedAt:event.at,recordedSessions:0,
          locations:new Set(),events:[]};
        groups.set(event.networkId,g);
      }
      g.recordedSessions++;
      if(event.at<g.firstObservedAt)g.firstObservedAt=event.at;
      if(event.at>g.lastObservedAt)g.lastObservedAt=event.at;
      if(event.location)g.locations.add(event.location);
      g.events.push({firstAt:event.at,lastAt:event.at});
    }
    const networks=[...groups.values()].map(g=>{
      const returns=quietPeriodReturns(g.events);
      return {
        networkId:g.networkId,
        ipAddress:g.ipAddress,
        firstObservedAt:g.firstObservedAt,
        lastObservedAt:g.lastObservedAt,
        recordedSessions:g.recordedSessions,
        previouslySeenInRecords:g.recordedSessions>1,
        locations:[...g.locations].slice(0,8),
        latestReturn:returns.at(-1)||null,
        quietPeriodReturns:returns.length,
        longestQuietGapDays:returns.reduce((m,r)=>Math.max(m,r.gapDays),0)
      };
    }).sort((a,b)=>b.lastObservedAt.localeCompare(a.lastObservedAt));
    return {
      status:'saved',
      newSessionsSaved,
      recordedSessions:retained.length,
      networkCount:networks.length,
      networksShown:Math.min(networks.length,MAX_NETWORKS_SHOWN),
      networks:networks.slice(0,MAX_NETWORKS_SHOWN),
      retainedDays:RETAIN_DAYS,
      maxSessionRecords:MAX_EVENTS,
      truncated:trimmed,
      wixRowsReviewed:Array.isArray(rows)?rows.length:0,
      wixRowsWithUsableSessionEvidence:observations.length,
      wixSourcePartial:partial,
      earliestCapturedVisit:retained.length?retained[retained.length-1].at:null,
      note:'Seen before = more than one distinct Wix session from an IP in available encrypted records. It does not prove one human returned. Data is added when the signed-in owner runs Website Security. Records are retained for up to one year and capped at 16,000 sessions. Older/uncaptured visits may exist. Gaps of 7/30/90 days compare recorded sessions only.'
    };
  });
}
