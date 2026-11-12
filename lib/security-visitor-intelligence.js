/* DOC JAKS · owner-only Visitor Intelligence.
 * Distinct Wix sessions, not persons. No member identities, raw session IDs,
 * or page-level private browsing traces are returned or persisted by this module.
 */
import {isIP} from 'node:net';

const cell=(row,name)=>row?.fields?.[name]||{};
const str=(row,name)=>typeof cell(row,name).stringValue==='string'?
  cell(row,name).stringValue.trim():'';
const int=(row,name)=>{
  const n=cell(row,name).numericValue;
  return Number.isSafeInteger(n)&&n>=0?n:null;
};
const average=(row,name)=>{
  const n=cell(row,name).numericValue;
  return typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=86400?n:null;
};
const isAddress=value=>typeof value==='string'&&value.length<=64&&isIP(value)!==0;

export function summarizeSecurityVisitors(rows,flaggedIds,history,partial=false) {
  const data=Array.isArray(rows)?rows:[];
  const suspects=flaggedIds instanceof Set?flaggedIds:new Set();
  const sessions=new Map();
  let ungroupableRows=0,memberSignalMissingRows=0,visitorTypeMissingRows=0;
  for(const row of data) {
    const sid=str(row,'traffic.bsi');
    const stamp=cell(row,'traffic.created_date').timestampValue;
    if(!sid||sid.length>250||!Number.isFinite(Date.parse(stamp||''))||
      int(row,'traffic.sessions_count')!==1){
      ungroupableRows++;continue;
    }
    let session=sessions.get(sid);
    if(!session){
      session={member:null,visitorType:null,engaged:false,ip:null,
        conflictingIPs:false,paths:new Set(),source:'Unknown',
        recordedAt:stamp,stayMeasured:false,reportedStay:null,location:'Unknown'};
      sessions.set(sid,session);
    }
    if(stamp<session.recordedAt)session.recordedAt=stamp;
    const location=[
      str(row,'traffic.city').slice(0,70),
      str(row,'traffic.region').slice(0,40),
      str(row,'traffic.country_name').slice(0,70)
    ].filter(Boolean).join(', ');
    if(location&&session.location==='Unknown')session.location=location;
    const member=str(row,'traffic.member_flag').toLowerCase();
    if(member==='true')session.member=true;
    else if(member==='false'&&session.member!==true)session.member=false;
    else if(member!=='true'&&member!=='false')memberSignalMissingRows++;
    const type=str(row,'traffic.visitor_type');
    if(type==='returning_visitor')session.visitorType='returning';
    else if(type==='first_time_visitor'&&session.visitorType!=='returning')session.visitorType='new';
    else if(type!=='first_time_visitor'&&type!=='returning_visitor')visitorTypeMissingRows++;
    const ip=str(row,'traffic.ip_address');
    if(isAddress(ip)){
      if(session.ip===null)session.ip=ip;
      else if(session.ip!==ip)session.conflictingIPs=true;
    }
    const page=str(row,'traffic.page_url_from');
    if(/^\/[^\s?#]*$/.test(page))session.paths.add(page);
    const stay=average(row,'traffic.site_time_seconds_avg');
    if(stay!==null){
      session.stayMeasured=true;
      session.reportedStay=session.reportedStay===null?stay:
        Math.max(session.reportedStay,stay);
    }
    const views=int(row,'traffic.views_count');
    if(session.paths.size>=2 || (stay!==null&&stay>=30) ||
      (views!==null&&views>=2))session.engaged=true;
    const ref=str(row,'traffic.referrer_category_name');
    if(ref&&session.source==='Unknown')session.source=ref.slice(0,60);
  }
  const totals={
    reviewedSessions:0,signedInMemberSessions:0,notSignedInSessions:0,
    memberStatusUnknown:0,returningBrowserSessions:0,newBrowserSessions:0,
    visitorTypeUnknown:0,crawlerLikeSessions:0,engagedLookingSessions:0,
    unclearSessions:0,memberAndSweepOverlap:0
  };
  const networks=new Map(),sources=new Map();
  const unclear={
    reasons:{onePageNoMeasuredTime:0,onePageShortMeasuredTime:0,
      pageUnreported:0,otherInsufficientEvidence:0},
    newBrowserSessions:0,returningBrowserSessions:0,visitorTypeUnknown:0,
    signedInMemberSessions:0,notSignedInSessions:0,memberStatusUnknown:0,
    pages:new Map(),sources:new Map(),records:[]
  };
  for(const [sid,s] of sessions) {
    const crawlerLike=suspects.has(sid);
    totals.reviewedSessions++;
    if(s.member===true)totals.signedInMemberSessions++;
    else if(s.member===false)totals.notSignedInSessions++;
    else totals.memberStatusUnknown++;
    if(s.visitorType==='returning')totals.returningBrowserSessions++;
    else if(s.visitorType==='new')totals.newBrowserSessions++;
    else totals.visitorTypeUnknown++;
    if(crawlerLike){
      totals.crawlerLikeSessions++;
      if(s.member===true)totals.memberAndSweepOverlap++;
    }else if(s.engaged)totals.engagedLookingSessions++;
    else {
      totals.unclearSessions++;
      // An unclear session may be a real reader. Lack of measured stay
      // is never interpreted as a zero-second session or a bot.
      const reason=s.paths.size===0?'pageUnreported':
        s.paths.size===1&&!s.stayMeasured?'onePageNoMeasuredTime':
        s.paths.size===1&&s.reportedStay!==null&&s.reportedStay<30?
          'onePageShortMeasuredTime':'otherInsufficientEvidence';
      unclear.reasons[reason]++;
      if(s.visitorType==='returning')unclear.returningBrowserSessions++;
      else if(s.visitorType==='new')unclear.newBrowserSessions++;
      else unclear.visitorTypeUnknown++;
      if(s.member===true)unclear.signedInMemberSessions++;
      else if(s.member===false)unclear.notSignedInSessions++;
      else unclear.memberStatusUnknown++;
      const path=[...s.paths][0]||'Unavailable';
      unclear.pages.set(path,(unclear.pages.get(path)||0)+1);
      unclear.sources.set(s.source,(unclear.sources.get(s.source)||0)+1);
      unclear.records.push({
        recordedAt:s.recordedAt,ipAddress:s.conflictingIPs?null:s.ip,
        location:s.location,
        page:path,source:s.source,
        browserType:s.visitorType||'unknown',
        memberStatus:s.member===true?'signed-in':
          s.member===false?'not-signed-in':'unknown',
        why:reason,
        wixAverageSeconds:s.reportedStay
      });
    }
    if(s.ip&&!s.conflictingIPs) {
      let n=networks.get(s.ip);
      if(!n){
        n={ipAddress:s.ip,recordedSessions:0,signedInMemberSessions:0,
          returningBrowserSessions:0,crawlerLikeSessions:0,engagedLookingSessions:0};
        networks.set(s.ip,n);
      }
      n.recordedSessions++;
      if(s.member===true)n.signedInMemberSessions++;
      if(s.visitorType==='returning')n.returningBrowserSessions++;
      if(crawlerLike)n.crawlerLikeSessions++;
      else if(s.engaged)n.engagedLookingSessions++;
    }
    let src=sources.get(s.source);
    if(!src){
      src={source:s.source,sessions:0,signedInMemberSessions:0,crawlerLikeSessions:0};
      sources.set(s.source,src);
    }
    src.sessions++;
    if(s.member===true)src.signedInMemberSessions++;
    if(crawlerLike)src.crawlerLikeSessions++;
  }
  const known=history?.status==='saved'&&Array.isArray(history.networks);
  const previous=new Map(known?history.networks.map(row=>[row.ipAddress,row]):[]);
  const networkRows=[...networks.values()].map(row=>({
    ...row,
    previouslySeenIP:previous.get(row.ipAddress)?.previouslySeenInRecords===true
  })).sort((a,b)=>b.recordedSessions-a.recordedSessions||a.ipAddress.localeCompare(b.ipAddress));
  return {
    status:partial||ungroupableRows>0?'partial':'reported',
    ...totals,sourceRows:data.length,ungroupableRows,memberSignalMissingRows,
    visitorTypeMissingRows,networkCount:networks.size,
    networkRows:networkRows.slice(0,25),
    networkRowsShown:Math.min(networkRows.length,25),
    sources:[...sources.values()].sort((a,b)=>b.sessions-a.sessions).slice(0,8),
    previouslySeenIPCount:known?
      networkRows.filter(n=>n.previouslySeenIP).length:null,
    historicalIPStatus:known?'available':'unavailable',
    verifiedCrawlerCount:null,
    unclearDetail:{
      total:totals.unclearSessions,
      reasons:unclear.reasons,
      returningBrowserSessions:unclear.returningBrowserSessions,
      newBrowserSessions:unclear.newBrowserSessions,
      visitorTypeUnknown:unclear.visitorTypeUnknown,
      signedInMemberSessions:unclear.signedInMemberSessions,
      notSignedInSessions:unclear.notSignedInSessions,
      memberStatusUnknown:unclear.memberStatusUnknown,
      topPages:[...unclear.pages].map(([path,sessions])=>({path,sessions}))
        .sort((a,b)=>b.sessions-a.sessions).slice(0,20),
      sources:[...unclear.sources].map(([source,sessions])=>({source,sessions}))
        .sort((a,b)=>b.sessions-a.sessions).slice(0,12),
      sessionsShown:Math.min(unclear.records.length,150),
      sessionRows:unclear.records
        .sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)).slice(0,150),
      partial:partial||ungroupableRows>0,
      note:'Unclear sessions did not meet the engagement or page-sweep rules. Not measured means Wix returned no usable session-time value, not zero time. Session records are owner-only and limited to 150 examples; raw Wix session IDs are not returned. IPs and locations may identify shared networks rather than individual visitors. Date/time is a Wix record timestamp; any Wix average is not individual dwell time.'
    },
    note:'These are distinct Wix sessions, not unique people. Signed-in status comes from Wix member_flag and does not establish a Pit Krewe rewards tier or Facebook follow. Returning-browser is Wix visitor_type, not cross-device identity. Engagement requires 2+ pages, at least 2 recorded views, or measured site time of 30+ seconds; it does not prove a human. Crawler-like means flagged page-sweep behavior, not a verified malicious actor. Member and new/returning counts overlap the separate behavior breakdown. IPs can be shared or change. Historical IP comparisons use only captured records. No blocking or modification of Wix metrics occurs. Unclear now includes an evidence-only breakdown; no previously unclear sessions are silently reclassified as bots or people.'
  };
}
