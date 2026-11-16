import test from 'node:test';
import assert from 'node:assert/strict';
import {collectWixPageRows,entryPageCoverage,WIX_PAGE_BATCH,WIX_PAGE_LIMIT} from '../lib/wix-page-report.js';

const page=n=>({path:'/page-'+String(n).padStart(4,'0')});

test('all reported pages remain available past the old 12/10 row limits',async()=>{
  const rows=Array.from({length:537},(_,i)=>page(i)),offsets=[];
  const report=await collectWixPageRows(async({limit,offset})=>{
    offsets.push(offset);
    const results=rows.slice(offset,offset+limit);
    return {results,pagingMetadata:{count:results.length,offset}};
  },row=>row.path);
  assert.equal(report.complete,true);
  assert.equal(report.results.length,537);
  assert.deepEqual(offsets,[0,WIX_PAGE_BATCH]);
  assert.equal(report.results.at(-1).path,rows.at(-1).path);
});

test('a failed later page preserves measured rows but cannot become a full count',async()=>{
  const report=await collectWixPageRows(async({offset})=>{
    if(offset)throw new Error('Provider unavailable');
    return {results:Array.from({length:WIX_PAGE_BATCH},(_,i)=>page(i)),pagingMetadata:{offset:0,count:WIX_PAGE_BATCH}};
  },row=>row.path);
  assert.equal(report.results.length,WIX_PAGE_BATCH);
  assert.equal(report.complete,false);
  assert.equal(entryPageCoverage(report.results.map(r=>({...r,sessions:1})),report.complete,WIX_PAGE_BATCH).count,null);
});

test('the safety cap and inconsistent paging never certify completeness',async()=>{
  let requests=0;
  const capped=await collectWixPageRows(async({limit,offset})=>{
    requests++;
    return {results:Array.from({length:limit},(_,i)=>page(offset+i)),pagingMetadata:{offset,count:limit}};
  },row=>row.path);
  assert.equal(capped.complete,false);
  assert.equal(capped.results.length,WIX_PAGE_LIMIT);
  assert.equal(requests,WIX_PAGE_LIMIT/WIX_PAGE_BATCH);
  const duplicate=await collectWixPageRows(async()=>({results:[page(1),page(1)]}),row=>row.path);
  assert.equal(duplicate.complete,false);
  const mismatched=await collectWixPageRows(async()=>({results:[page(1)],pagingMetadata:{count:2,offset:0}}),row=>row.path);
  assert.equal(mismatched.complete,false);
});

test('entry pages count distinct website paths only after session reconciliation',()=>{
  const rows=[
    {path:'https://www.docjaks.com/outlaw-radio-5150?utm_source=radio',sessions:4},
    {path:'/outlaw-radio-5150/',sessions:2},
    {path:'/the-wooden-token',sessions:3},
    {path:'/',sessions:1},
    {path:'/not-reached',sessions:0}
  ];
  const verified=entryPageCoverage(rows,true,10);
  assert.equal(verified.status,'reported');
  assert.equal(verified.count,3);
  assert.equal(verified.landingSessions,10);
  const pending=entryPageCoverage(rows,true,11);
  assert.equal(pending.status,'pending');
  assert.equal(pending.count,null);
  assert.equal(pending.reportedDistinctPages,3);
  assert.equal(entryPageCoverage(rows,false,10).count,null);
});

test('measured empty traffic is zero; missing or malformed reports remain unknown',async()=>{
  const empty=await collectWixPageRows(async()=>({results:[],pagingMetadata:{count:0,offset:0}}),row=>row.path);
  assert.equal(empty.complete,true);
  assert.equal(entryPageCoverage([],true,0).count,0);
  const missing=await collectWixPageRows(async()=>({}),row=>row.path);
  assert.equal(missing.complete,false);
  assert.equal(entryPageCoverage([],false,0).count,null);
  assert.equal(entryPageCoverage([],false,0).reportedDistinctPages,null);
  assert.equal(entryPageCoverage([{path:'/',sessions:null}],true,0).count,null);
  assert.equal(entryPageCoverage([{path:'https://other.example/',sessions:1}],true,1).count,null);
});
