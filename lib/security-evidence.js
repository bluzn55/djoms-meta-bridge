/* DOC JAKS / owner-only security evidence history.
 * This is a record of suspected automated public-page sweeps, NOT a threat feed.
 * The database stores encrypted IP evidence. No raw addresses are written to git/logs.
 * Records are collected when the owner generates a report, not continuously.
 */
import {createHmac} from 'node:crypto';
import {isIP} from 'node:net';
import {config,read,write,seal,unseal,withLock} from './core.js';

const KEY='security:sweep-evidence:v1';
const RETENTION_MS=365*86400000;
const MAX_RECORDS=1600;
const validIP=value=>typeof value==='string' &&
  value.length<=64 && isIP(value)!==0;

function fingerprint(value) {
  const secret=config().secret;
  if(!secret || secret.length<32)throw new Error('Evidence encryption is not configured.');
  return createHmac('sha256',secret).update(value).digest('hex');
}

export function routeSequence(timeline) {
  const sequence=[];
  for(const event of Array.isArray(timeline)?timeline:[]) {
    const path=event?.path;
    if(typeof path!=='string'||!/^\/[^\s?#]*$/.test(path))continue;
    if(sequence[sequence.length-1]!==path)sequence.push(path.slice(0,230));
    if(sequence.length>=50)break;
  }
  return sequence;
}

export function sequenceSimilarity(a,b) {
  if(!Array.isArray(a)||!Array.isArray(b)||!a.length||!b.length)return 0;
  const dp=new Array(b.length+1).fill(0);
  for(const x of a) {
    let prev=0;
    for(let j=1;j<=b.length;j++) {
      const old=dp[j];
      dp[j]=x===b[j-1]?prev+1:Math.max(dp[j],dp[j-1]);
      prev=old;
    }
  }
  return Math.round(100*dp[b.length]/Math.max(a.length,b.length));
}

function parseRecordStore(saved) {
  if(!saved)return [];
  if(saved.version!==1||typeof saved.sealed!=='string')
    throw new Error('Saved security history needs repair. Existing records were not overwritten.');
  const content=unseal(saved.sealed);
  if(!content||!Array.isArray(content.records))
    throw new Error('Saved security history could not be verified.');
  return content.records;
}

function publicNetwork(network) {
  return {
    networkId:network.networkId,
    ipAddress:network.ipAddress,
    firstSeen:network.firstSeen,
    lastSeen:network.lastSeen,
    observedSweeps:network.observedSweeps,
    flaggedVisitEvents:network.flaggedVisitEvents,
    cities:[...network.cities].slice(0,8),
    routeVariants:network.sequences.length
  };
}
export function compareSweeps(alerts) {
  const comparison=[];
  for(let i=0;i<alerts.length;i++) {
    const a=alerts[i],seqA=routeSequence(a.timeline);
    if(seqA.length<8)continue;
    for(let j=i+1;j<alerts.length;j++) {
      const b=alerts[j],seqB=routeSequence(b.timeline);
      if(seqB.length<8)continue;
      const score=sequenceSimilarity(seqA,seqB);
      if(score<75)continue;
      comparison.push({
        firstIndex:i+1,secondIndex:j+1,score,
        differentNetworks:!!a.ipAddress && !!b.ipAddress && a.ipAddress!==b.ipAddress
      });
    }
  }
  return comparison.slice(0,45);
}

/* Called only after the owner-session check on the main report endpoint.
 * Raw IPs leave this module only inside that authenticated response.
 */
export async function recordSweeps(alerts) {
  return withLock(KEY,async()=>{
    const saved=await read(KEY);
    const previous=parseRecordStore(saved);
    const cutoff=Date.now()-RETENTION_MS;
    const kept=previous.filter(x=>Number.isFinite(Date.parse(x.firstAt)) &&
      Date.parse(x.firstAt)>=cutoff);
    const known=new Set(kept.map(x=>x.id));
    let added=0;
    for(const alert of alerts) {
      const ip=alert?.ipAddress;
      if(!validIP(ip)||!Number.isFinite(Date.parse(alert.start)))continue;
      const sequence=routeSequence(alert.timeline);
      if(sequence.length<8)continue;
      const networkId=fingerprint('network:'+ip).slice(0,24);
      const id=fingerprint('sweep:'+ip+'|'+alert.start).slice(0,32);
      if(known.has(id))continue;
      kept.push({
        id, networkId, ipCipher:seal(ip),
        firstAt:alert.start,lastAt:alert.end||alert.start,
        location:String(alert.location||'').slice(0,150),
        source:String(alert.source||'').slice(0,70),
        visitEvents:alert.visitEvents,
        distinctSessions:alert.distinctSessions,
        uniquePages:alert.uniquePages,
        repeatedPairs:alert.repeatedPairs,
        sequence
      });
      known.add(id);added++;
    }
    kept.sort((a,b)=>String(b.firstAt).localeCompare(String(a.firstAt)));
    const records=kept.slice(0,MAX_RECORDS);
    if(added||records.length!==previous.length) {
      await write(KEY,{version:1,sealed:seal({records})});
    }
    const networks=new Map();
    for(const r of records) {
      let network=networks.get(r.networkId);
      if(!network) {
        const ipAddress=unseal(r.ipCipher);
        if(!validIP(ipAddress))continue;
        network={
          networkId:r.networkId,ipAddress,firstSeen:r.firstAt,
          lastSeen:r.lastAt,observedSweeps:0,flaggedVisitEvents:0,
          cities:new Set(),sequences:[]
        };
        networks.set(r.networkId,network);
      }
      network.observedSweeps++;
      network.flaggedVisitEvents+=Number.isSafeInteger(r.visitEvents)?r.visitEvents:0;
      if(r.firstAt<network.firstSeen)network.firstSeen=r.firstAt;
      if(r.lastAt>network.lastSeen)network.lastSeen=r.lastAt;
      if(r.location)network.cities.add(r.location);
      if(!network.sequences.some(s=>sequenceSimilarity(s,r.sequence)===100))
        network.sequences.push(r.sequence);
    }
    const sortedNetworks=[...networks.values()].sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen));
    const recent=records.slice(0,100).map(r=>({
      firstAt:r.firstAt,lastAt:r.lastAt,
      ipAddress:unseal(r.ipCipher),networkId:r.networkId,
      location:r.location,source:r.source,
      visitEvents:r.visitEvents,distinctSessions:r.distinctSessions,
      uniquePages:r.uniquePages,repeatedPairs:r.repeatedPairs,sequence:r.sequence
    }));
    return {
      status:'saved',
      retainedDays:365,maxRecords:MAX_RECORDS,
      newSweepsSaved:added,totalSweepsStored:records.length,
      networkCount:networks.size,
      networks:sortedNetworks.slice(0,100).map(publicNetwork),
      latest:recent,
      note:'Only detected public-page sweeps are retained. A repeated IP or matching route does not identify a person or prove an attack. History is accumulated when the signed-in owner opens or refreshes this report; it is not yet a continuous log. Records are encrypted and kept for up to one year (maximum 1,600 patterns).'
    };
  });
}
