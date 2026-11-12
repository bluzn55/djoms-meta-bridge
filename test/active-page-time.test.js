import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeActivePageTime} from '../lib/visitor-intelligence.js';

const record=(id,activeSeconds,pages)=>[
 id,
 [id,'2026-11-12T10:00:00Z','2026-11-12T10:01:00Z','/','/','direct','',String(pages.length),String(activeSeconds)],
 ['2026-11-12T10:00:00Z','2026-11-12T10:01:00Z','1',String(pages.length),String(activeSeconds),'direct','/'],
 pages.map(([path,seconds])=>[path,'2026-11-12T10:00:00Z',String(seconds)])
];

test('Active page durations derive only from measured consented events, not Wix averages',()=>{
 const input=[
  record('a',75,[['/the-wooden-token',75]]),
  record('b',45,[['/',15],['/outlaw-radio-5150',30]]),
  record('c',0,[['/sm-welcome',0]])
 ];
 const result=summarizeActivePageTime(input,3,false,true);
 assert.equal(result.status,'reported');
 assert.equal(result.trackedSessions,3);
 assert.equal(result.sampledSessions,3);
 assert.equal(result.sessionsWithRecordedTime,2);
 assert.equal(result.sessionsWith30PlusSeconds,2);
 assert.equal(result.onePageSessionsWith30PlusSeconds,1);
 assert.equal(result.totalRecordedActiveSeconds,120);
 assert.equal(result.withoutRecordedSeconds,1);
 assert.equal(result.trackedPageOpens,4);
 assert.equal(result.pageOpensWith30PlusSeconds,2);
 assert.equal(result.pages.find(x=>x.path==='/the-wooden-token').totalRecordedActiveSeconds,75);
 assert.equal(result.pages.find(x=>x.path==='/outlaw-radio-5150').opensWith30PlusSeconds,1);
 assert.equal(JSON.stringify(result).includes('"a"'),false);
});

test('No tracker evidence does not report the number zero as a confirmed duration',()=>{
 const result=summarizeActivePageTime([],0,false,false);
 assert.equal(result.status,'not_started');
 assert.equal(result.totalRecordedActiveSeconds,null);
 assert.equal(result.sessionsWith30PlusSeconds,null);
 assert.equal(result.trackedPageOpens,null);
});

test('Wide time range cannot claim complete coverage when sampled sessions are truncated',()=>{
 const result=summarizeActivePageTime([record('a',32,[['/sm-welcome',32]])],900,true,true);
 assert.equal(result.status,'partial');
 assert.equal(result.trackedSessions,null);
 assert.equal(result.sampledSessions,1);
 assert.equal(result.sessionsWith30PlusSeconds,1);
});

test('Missing page records are explicitly partial and not invented',()=>{
 const row=record('a',120,[['/',12]]);
 row[1][7]='3';
 const result=summarizeActivePageTime([row],1,false,true);
 assert.equal(result.pageDetailsPartial,true);
 assert.equal(result.status,'partial');
 assert.equal(result.trackedPageOpens,1);
 assert.equal(result.totalRecordedActiveSeconds,120);
});


test('Aggregated page-time report accepts expected storefront paths but rejects arbitrary brace paths',()=>{
  const report=summarizeActivePageTime([
    record('a',40,[['/the-wooden-token',40]]),
    record('b',40,[['/name{not-a-page}',40]])
  ],2,false,true);
  assert.equal(report.sampledSessions,2);
  assert.equal(report.totalRecordedActiveSeconds,80);
  assert.equal(report.trackedPageOpens,1);
  assert.equal(report.pathsSeen,1);
  assert.equal(report.pages[0].path,'/the-wooden-token');
});
