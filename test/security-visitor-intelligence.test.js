import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeSecurityVisitors} from '../lib/security-visitor-intelligence.js';

function row({sid,ip='192.0.2.1',member='false',type='first_time_visitor',
  views=1,stay=null,path='/',source='direct',date='2026-11-11T18:00:00Z'}){
  const fields={
    'traffic.bsi':{stringValue:sid},
    'traffic.ip_address':{stringValue:ip},
    'traffic.created_date':{timestampValue:date},
    'traffic.sessions_count':{numericValue:1},
    'traffic.views_count':{numericValue:views},
    'traffic.page_url_from':{stringValue:path},
    'traffic.referrer_category_name':{stringValue:source}
  };
  if(member!==null)fields['traffic.member_flag']={stringValue:member};
  if(type!==null)fields['traffic.visitor_type']={stringValue:type};
  if(stay!==null)fields['traffic.site_time_seconds_avg']={numericValue:stay};
  return {fields};
}

test('Sessions distinguish signed-in members from crawler-like and engaged behavior',()=>{
  const rows=[
    row({sid:'member',member:'true',type:'returning_visitor',stay:45}),
    row({sid:'reader',path:'/',ip:'192.0.2.1'}),
    row({sid:'reader',path:'/blog',ip:'192.0.2.1'}),
    row({sid:'crawler1',ip:'198.51.100.2'}),
    row({sid:'crawler2',ip:'198.51.100.2'}),
    row({sid:'unknown',ip:'203.0.113.9',member:null,type:null}),
    row({sid:'member-flag',ip:'203.0.113.6',member:'true',views:1})
  ];
  const historical={status:'saved',networks:[
    {ipAddress:'192.0.2.1',previouslySeenInRecords:true,recordedVisitDays:4}
  ]};
  const data=summarizeSecurityVisitors(
    rows,new Set(['crawler1','crawler2','member-flag']),historical,false);
  assert.equal(data.reviewedSessions,6);
  assert.equal(data.signedInMemberSessions,2);
  assert.equal(data.notSignedInSessions,3);
  assert.equal(data.memberStatusUnknown,1);
  assert.equal(data.returningBrowserSessions,1);
  assert.equal(data.crawlerLikeSessions,3);
  assert.equal(data.engagedLookingSessions,2);
  assert.equal(data.unclearSessions,1);
  assert.equal(data.memberAndSweepOverlap,1);
  assert.equal(data.previouslySeenIPCount,1);
  assert.equal(data.networkRows.find(x=>x.ipAddress==='192.0.2.1').recordedSessions,2);
  assert.equal(data.verifiedCrawlerCount,null);
  assert.equal(JSON.stringify(data).includes('crawler1'),false);
  assert.equal(JSON.stringify(data).includes('member-flag'),false);
});

test('Shared network can mix member and nonmember sessions without being called one person',()=>{
  const data=summarizeSecurityVisitors([
    row({sid:'a',ip:'192.0.2.55',member:'true'}),
    row({sid:'b',ip:'192.0.2.55',member:'false'})
  ],new Set(),{status:'unavailable'},false);
  assert.equal(data.networkCount,1);
  assert.equal(data.networkRows[0].recordedSessions,2);
  assert.equal(data.networkRows[0].signedInMemberSessions,1);
  assert.equal(data.previouslySeenIPCount,null);
  assert.equal(data.historicalIPStatus,'unavailable');
});

test('Invalid session and unknown member fields do not become fake zeroes',()=>{
  const bad=row({sid:'invalid',member:'true'});
  bad.fields['traffic.sessions_count']={numericValue:4};
  const data=summarizeSecurityVisitors([
    row({sid:'good',member:null,type:null}),
    bad
  ],new Set(),null,false);
  assert.equal(data.status,'partial');
  assert.equal(data.reviewedSessions,1);
  assert.equal(data.memberStatusUnknown,1);
  assert.equal(data.visitorTypeUnknown,1);
  assert.equal(data.ungroupableRows,1);
});

test('Conflicting IP on the same session is never attributed to one network',()=>{
  const data=summarizeSecurityVisitors([
    row({sid:'same',ip:'192.0.2.1',member:'true'}),
    row({sid:'same',ip:'198.51.100.5',member:'true'})
  ],new Set(),null,false);
  assert.equal(data.reviewedSessions,1);
  assert.equal(data.networkCount,0);
  assert.equal(data.signedInMemberSessions,1);
});

test('Partial Wix evidence stays explicitly partial',()=>{
  const data=summarizeSecurityVisitors([
    row({sid:'real',views:2})
  ],new Set(),null,true);
  assert.equal(data.status,'partial');
  assert.equal(data.engagedLookingSessions,1);
  assert.equal(data.unclearSessions,0);
});


test('Unclear reasons preserve genuine single-page visits when Wix time is unmeasured',()=>{
  const result=summarizeSecurityVisitors([
    row({sid:'reader-a',ip:'192.0.2.1',path:'/the-wooden-token',source:'direct',
      member:'false',type:'returning_visitor'}),
    row({sid:'reader-b',ip:'192.0.2.2',path:'/outlaw-radio-5150',stay:12,
      member:'true',source:'social'}),
    row({sid:'reader-c',ip:'192.0.2.3',path:'',source:'organic_search'}),
    row({sid:'engaged-d',ip:'192.0.2.4',path:'/the-pit',stay:35}),
    row({sid:'crawler-e',ip:'192.0.2.5',path:'/sm-welcome'})
  ],new Set(['crawler-e']),null,false);
  const u=result.unclearDetail;
  assert.equal(result.unclearSessions,3);
  assert.equal(u.total,3);
  assert.equal(u.reasons.onePageNoMeasuredTime,1);
  assert.equal(u.reasons.onePageShortMeasuredTime,1);
  assert.equal(u.reasons.pageUnreported,1);
  assert.equal(u.reasons.otherInsufficientEvidence,0);
  assert.equal(u.returningBrowserSessions,1);
  assert.equal(u.signedInMemberSessions,1);
  assert.equal(u.sessionsShown,3);
  assert.ok(u.topPages.some(r=>r.path==='/the-wooden-token'&&r.sessions===1));
  assert.ok(u.sources.some(r=>r.source==='social'&&r.sessions===1));
  assert.ok(u.sessionRows.some(r=>r.page==='/outlaw-radio-5150'&&r.wixAverageSeconds===12));
  assert.ok(u.sessionRows.some(r=>r.page==='/the-wooden-token'&&r.wixAverageSeconds===null));
  assert.equal(JSON.stringify(result).includes('reader-a'),false);
  assert.equal(JSON.stringify(result).includes('crawler-e'),false);
});

test('Unclear session examples are capped without silently reducing counts',()=>{
  const rows=Array.from({length:173},(_,i)=>row({
    sid:'unclassified_'+i,source:i%2?'direct':'organic_search',
    path:i%3?'/outlaw-radio-5150':'/the-wooden-token'
  }));
  const report=summarizeSecurityVisitors(rows,new Set(),null,false);
  assert.equal(report.unclearSessions,173);
  assert.equal(report.unclearDetail.total,173);
  assert.equal(report.unclearDetail.sessionsShown,150);
  assert.equal(report.unclearDetail.sessionRows.length,150);
  assert.equal(report.unclearDetail.reasons.onePageNoMeasuredTime,173);
});

test('Unclear evidence marks truncated source data as partial',()=>{
  const report=summarizeSecurityVisitors([
    row({sid:'quiet',source:'direct'})
  ],new Set(),null,true);
  assert.equal(report.status,'partial');
  assert.equal(report.unclearDetail.partial,true);
  assert.equal(report.unclearDetail.total,1);
});
