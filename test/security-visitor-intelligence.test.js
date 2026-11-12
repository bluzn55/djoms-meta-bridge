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
