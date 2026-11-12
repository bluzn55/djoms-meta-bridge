import test from 'node:test';
import assert from 'node:assert/strict';
import {extractVisits} from '../lib/security-visit-history.js';
import {quietPeriodReturns} from '../lib/security-evidence.js';

function event(ip,sid,time,extra={}) {
  return {fields:{
    'traffic.ip_address':{stringValue:ip},
    'traffic.bsi':{stringValue:sid},
    'traffic.created_date':{timestampValue:time},
    'traffic.sessions_count':{numericValue:1},
    'traffic.city':{stringValue:'Phoenix'},
    ...extra
  }};
}
test('Historical IP recorder accepts verified individual sessions only',()=>{
  const good=event('192.0.2.40','abc','2026-11-11T14:00:00Z');
  const goodV6=event('2001:db8::1','xyz','2026-11-11T14:00:00Z');
  const rows=[
    good,goodV6,
    event('not-a-network','bad','2026-11-11T14:00:00Z'),
    event('192.0.2.40','', '2026-11-11T14:00:00Z'),
    event('192.0.2.40','bad','wrong'),
    event('192.0.2.40','aggregate','2026-11-11T14:00:00Z',{
      'traffic.sessions_count':{numericValue:4}
    })
  ];
  const visits=extractVisits(rows);
  assert.equal(visits.length,2);
  assert.deepEqual(visits.map(v=>v.ip),['192.0.2.40','2001:db8::1']);
  assert.equal(visits[0].location,'Phoenix');
});

test('Same-day bursts are not mistaken for returning-after-dormancy',()=>{
  const list=[
    {firstAt:'2026-11-11T17:00:00Z',lastAt:'2026-11-11T17:00:00Z'},
    {firstAt:'2026-11-11T17:00:03Z',lastAt:'2026-11-11T17:00:03Z'}
  ];
  assert.deepEqual(quietPeriodReturns(list),[]);
});

test('Seven, thirty and ninety day dormant-return tiers are separate',()=>{
  const returns=quietPeriodReturns([
    {firstAt:'2025-12-01T00:00:00Z',lastAt:'2025-12-01T00:00:00Z'},
    {firstAt:'2026-03-15T00:00:00Z',lastAt:'2026-03-15T00:00:00Z'},
    {firstAt:'2026-04-20T00:00:00Z',lastAt:'2026-04-20T00:00:00Z'},
    {firstAt:'2026-04-29T00:00:00Z',lastAt:'2026-04-29T00:00:00Z'}
  ]);
  assert.deepEqual(returns.map(x=>x.threshold),['90+','30+','7+']);
  assert.ok(returns[0].gapDays>=90);
});
