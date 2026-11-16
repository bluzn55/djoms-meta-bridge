import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWebsiteArrivalGroups,collectArrivalRows,readWixArrivalData,ARRIVAL_BATCH} from '../lib/website-arrival-groups.js';
import {postTrackingId} from '../lib/post-referrals.js';

const window={start:'2026-11-09',end:'2026-11-16',endInclusive:'2026-11-15'};
const radio={id:'a'.repeat(36),campaign:'MUSIC',acquisitionGroup:'olr5150',title:'Outlaw Radio show'};
const book={id:'b'.repeat(36),campaign:'BOOK',acquisitionGroup:'docjaks',title:'The Wooden Token'};
const music={id:'c'.repeat(36),campaign:'MUSIC',title:'Music post without a source label'};
const row=(path,visits,category='direct',source='direct',trackingId='_')=>({path,visits,category,source,trackingId});
const wixRow=r=>({fields:{
  'traffic.page_url_from':{stringValue:r.path},
  'traffic.referrer_category_name':{stringValue:r.category},
  'traffic.referrer_source_name':{stringValue:r.source},
  'traffic.utm_campaign_id':{stringValue:r.trackingId},
  'traffic.sessions_count':{numericValue:r.visits}
}});

test('one arrival belongs to one group; visiting radio does not identify a radio promotion',()=>{
  const rows=[
    row('/outlaw-radio-5150',3,'organic_search','Google'),
    row('/sm-welcome',4,'social','Facebook',postTrackingId(radio,'facebook')),
    row('/outlaw-radio-5150',5,'social','Instagram',postTrackingId(book,'instagram')),
    row('/sm-welcome',2,'social','Facebook'),
    row('/outlaw-radio-5150',6),
    row('/sm-welcome',1,'social','Facebook',postTrackingId(music,'facebook'))
  ];
  const result=buildWebsiteArrivalGroups({rows,totalVisits:21,queriedLandingVisits:21,complete:true,records:[radio,book,music],window});
  assert.equal(result.complete,true);
  assert.equal(result.totalVisits,21);
  assert.equal(result.entryPageCount,2);
  assert.deepEqual(result.groups.map(g=>[g.id,g.visits]),[['search',3],['olr5150',4],['docjaks',5],['social_unclassified',3],['other',6]]);
  assert.equal(result.groups.reduce((sum,g)=>sum+g.visits,0),21);
  const olr=result.groups.find(g=>g.id==='olr5150');
  assert.deepEqual(olr.landingPages,[{path:'/sm-welcome',visits:4}]);
  assert.deepEqual(olr.platforms,[{platform:'facebook',visits:4,landingPages:[{path:'/sm-welcome',visits:4}]}]);
  assert.equal(olr.posts[0].recordId,radio.id);
  assert.equal(olr.posts[0].trackingId,postTrackingId(radio,'facebook'));
  assert.equal(result.groups.find(g=>g.id==='docjaks').landingPages[0].path,'/outlaw-radio-5150');
});

test('old unclassified or missing posts are not inferred from Music, page title, or destination',()=>{
  const unknown=postTrackingId({...radio,id:'d'.repeat(36)},'youtube');
  const result=buildWebsiteArrivalGroups({rows:[row('/outlaw-radio-5150',2,'social','Facebook',postTrackingId(music,'facebook')),row('/outlaw-radio-5150',3,'social','YouTube',unknown)],totalVisits:5,complete:true,records:[music],window});
  assert.equal(result.groups.find(g=>g.id==='olr5150').visits,0);
  assert.equal(result.groups.find(g=>g.id==='docjaks').visits,0);
  assert.equal(result.groups.find(g=>g.id==='social_unclassified').visits,5);
  assert.equal(result.groups.find(g=>g.id==='social_unclassified').posts.find(p=>p.trackingId===unknown).recordId,null);
});

test('same first page is counted once across URL variants and source groups',()=>{
  const result=buildWebsiteArrivalGroups({rows:[row('/sm-welcome?utm_source=facebook',2,'social','Facebook'),row('https://www.docjaks.com/sm-welcome/',3),row('/unreached',0)],totalVisits:5,complete:true,window});
  assert.equal(result.entryPageCount,1);
  assert.deepEqual(result.landingPages,[{path:'/sm-welcome',visits:5}]);
  assert.equal(result.groups.reduce((sum,g)=>sum+g.entryPageCount,0),2);
});

test('incomplete or unreconciled reports retain evidence without certifying totals',()=>{
  for(const options of [{complete:false,totalVisits:10},{complete:true,totalVisits:10},{complete:true,totalVisits:4,queriedLandingVisits:5}]){
    const result=buildWebsiteArrivalGroups({rows:[row('/',4)],...options,window});
    assert.equal(result.status,'partial');
    assert.equal(result.complete,false);
    assert.equal(result.entryPageCount,null);
    assert.ok(result.groups.every(g=>g.visits===null));
    assert.deepEqual(result.landingPages,[{path:'/',visits:4}]);
  }
  assert.equal(buildWebsiteArrivalGroups({rows:[row('https://outside.example/',4)],totalVisits:4,complete:true,window}).complete,false);
});

test('verified zero differs from unavailable reporting',()=>{
  const zero=buildWebsiteArrivalGroups({rows:[],totalVisits:0,queriedLandingVisits:0,complete:true,window});
  assert.equal(zero.status,'reported');
  assert.equal(zero.entryPageCount,0);
  assert.ok(zero.groups.every(g=>g.visits===0));
  const unavailable=buildWebsiteArrivalGroups({window});
  assert.equal(unavailable.status,'unavailable');
  assert.equal(unavailable.totalVisits,null);
  assert.ok(unavailable.groups.every(g=>g.visits===null));
});

test('incomplete saved labels leave tagged group totals unknown, while untagged reports remain reportable',()=>{
  const tagged=buildWebsiteArrivalGroups({rows:[row('/sm-welcome',3,'social','Facebook',postTrackingId(radio,'facebook'))],totalVisits:3,queriedLandingVisits:3,complete:true,recordLookupComplete:false,records:[],window});
  assert.equal(tagged.status,'partial');
  assert.equal(tagged.complete,false);
  assert.equal(tagged.totalVisits,3);
  assert.deepEqual(tagged.landingPages,[{path:'/sm-welcome',visits:3}]);
  assert.ok(tagged.groups.every(g=>g.visits===null));
  assert.match(tagged.coverage.reason,/Saved post labels could not be read completely/);
  assert.equal(tagged.coverage.recordLookupComplete,false);
  const untagged=buildWebsiteArrivalGroups({rows:[row('/',2,'organic_search','Google'),row('/sm-welcome',1)],totalVisits:3,complete:true,recordLookupComplete:false,records:[],window});
  assert.equal(untagged.status,'reported');
  assert.equal(untagged.complete,true);
  assert.equal(untagged.groups.find(g=>g.id==='search').visits,2);
  assert.equal(untagged.groups.find(g=>g.id==='other').visits,1);
});

test('all first-page source rows are paged; duplicates, omitted fields, and changing totals fail closed',async()=>{
  const source=Array.from({length:ARRIVAL_BATCH+3},(_,i)=>wixRow(row('/page-'+i,1)));
  const offsets=[];
  const complete=await collectArrivalRows(async({limit,offset})=>{
    offsets.push(offset);const results=source.slice(offset,offset+limit);
    return {results,pagingMetadata:{count:results.length,offset},totals:{fields:{'traffic.sessions_count':{numericValue:source.length}}}};
  });
  assert.equal(complete.complete,true);
  assert.equal(complete.rows.length,source.length);
  assert.deepEqual(offsets,[0,ARRIVAL_BATCH]);
  const repeated=await collectArrivalRows(async()=>({results:[source[0],source[0]],pagingMetadata:{count:2,offset:0}}));
  assert.equal(repeated.complete,false);
  const missing=structuredClone(source[0]);delete missing.fields['traffic.utm_campaign_id'];
  assert.equal((await collectArrivalRows(async()=>({results:[missing],pagingMetadata:{count:1,offset:0}}))).complete,false);
  const changing=await collectArrivalRows(async({limit,offset})=>({results:source.slice(offset,offset+limit),pagingMetadata:{count:source.slice(offset,offset+limit).length,offset},totals:{fields:{'traffic.sessions_count':{numericValue:source.length+(offset?1:0)}}}}));
  assert.equal(changing.complete,false);
  const failure=await collectArrivalRows(async({limit,offset})=>{if(offset)throw new Error('Provider failed');return {results:source.slice(0,limit),pagingMetadata:{count:limit,offset}};});
  assert.equal(failure.complete,false);
  assert.equal(failure.rows.length,ARRIVAL_BATCH);
});

test('live report queries first pages only, and the Central interval remains aligned across DST',async()=>{
  const fields=['traffic.page_url_from','traffic.referrer_category_name','traffic.referrer_source_name','traffic.utm_campaign_id','traffic.sessions_count','traffic.landing_page_flag'];
  const requests=[];
  const request=async(url,body)=>{
    if(url.endsWith('/semantic-models'))return {semanticModels:[{slug:'traffic',id:'verified-traffic-model'}]};
    if(url.endsWith('/verified-traffic-model'))return {semanticModel:{dimensions:fields.map(name=>({name,dependencies:[],type:name==='traffic.landing_page_flag'?'BOOLEAN':'STRING',sortable:true,filters:{conditions:['EQUAL'],prefixes:['IS']}}))}};
    requests.push(body);
    const firstOnly=body.filters?.some(f=>f.field==='traffic.landing_page_flag'&&f.condition==='EQUAL'&&f.prefix==='IS'&&f.values[0]==='true');
    if(body.fields.length===1)return {results:[{fields:{'traffic.sessions_count':{numericValue:2}}}],totals:{fields:{'traffic.sessions_count':{numericValue:2}}}};
    const results=firstOnly?[wixRow(row('/first',2))]:[wixRow(row('/first',2)),wixRow(row('/later-radio-page',2))];
    return {results,pagingMetadata:{count:results.length,offset:0},totals:{fields:{'traffic.sessions_count':{numericValue:firstOnly?2:4}}}};
  };
  const result=await readWixArrivalData({start:'2026-10-31',end:'2026-11-03'},request);
  assert.deepEqual(result.rows.map(r=>r.path),['/first']);
  assert.equal(result.totalVisits,2);
  assert.ok(requests.every(r=>r.interval.start==='2026-10-31T05:00:00.000Z'&&r.interval.end==='2026-11-03T06:00:00.000Z'&&r.interval.timezone==='America/Chicago'));
  assert.equal(requests.find(r=>r.fields.length===1).paging,undefined);
});
