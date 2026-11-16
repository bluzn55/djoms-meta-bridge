import test from 'node:test';
import assert from 'node:assert/strict';
import {acquisitionGroup,parseAcquisitionGroup} from '../lib/acquisition-groups.js';
import {postTrackingId,postTrackingUrl} from '../lib/post-referrals.js';
import {recordsEndpoint} from '../lib/records.js';
import {sessionEndpoint,PREFIX} from '../lib/core.js';

test('promotion groups never infer radio from Music, page destinations, or old post copy',()=>{
  const post={id:'a'.repeat(36),campaign:'MUSIC',title:'Outlaw Radio 5150',link:'https://www.docjaks.com/outlaw-radio-5150'};
  assert.equal(acquisitionGroup(post),null);
  for(const platform of ['facebook','instagram','x','youtube']){
    const id=postTrackingId(post,platform),url=postTrackingUrl(post,platform);
    for(const group of ['olr5150','docjaks',null]){
      const classified={...post,acquisitionGroup:group};
      assert.equal(postTrackingId(classified,platform),id);
      assert.equal(postTrackingUrl(classified,platform),url,'Reclassification must preserve already-shared links');
    }
  }
  assert.throws(()=>parseAcquisitionGroup('MUSIC'));
  assert.throws(()=>parseAcquisitionGroup({group:'olr5150'}));
});

test('owner can classify published or scheduled records without changing delivery, with auth and revision checks',async()=>{
  const origin='https://command.example.test',password='test-only-password-long-enough';
  const keys=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','KV_REST_API_URL','KV_REST_API_TOKEN','DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD','DJOMS_OWNER_NAME'];
  const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const originalFetch=globalThis.fetch,storage=new Map();
  const response=()=>({headers:{},statusCode:200,body:null,setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
  const request=(body,cookie='',csrf='')=>({method:'POST',query:{},body,headers:{origin,'content-type':'application/json',cookie,'x-djoms-csrf':csrf}});
  try{
    Object.assign(process.env,{PUBLIC_BASE_URL:origin,UPSTASH_REDIS_REST_URL:'https://group-test-redis.invalid',UPSTASH_REDIS_REST_TOKEN:'synthetic-only',DJOMS_SESSION_SECRET:'synthetic-secret-for-group-tests-only-32',DJOMS_ADMIN_PASSWORD:password,DJOMS_OWNER_NAME:'Test owner'});
    delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch=async(url,options)=>{
      assert.equal(String(url),'https://group-test-redis.invalid','Classification must not contact a publishing service');
      const [cmd,...args]=JSON.parse(options.body);let result;
      if(cmd==='GET')result=storage.get(args[0])??null;
      else if(cmd==='SET'){if(args.includes('NX')&&storage.has(args[0]))result=null;else{storage.set(args[0],args[1]);result='OK';}}
      else if(cmd==='DEL'){result=storage.delete(args[0])?1:0;}
      else if(cmd==='EVAL'){
        const [script,numKeys,...values]=args;
        if(numKeys===2&&script.includes('zadd')){storage.set(values[0],values[2]);result=1;}
        else if(script.includes('redis.call("get"')){result=storage.delete(values[0])?1:0;}
        else if(script.includes('login')||script.includes('incr'))result=1;
        else throw new Error('Unexpected Redis script');
      }else throw new Error('Unexpected Redis command '+cmd);
      return {ok:true,json:async()=>({result})};
    };
    const login=response();await sessionEndpoint(request({password}),login);
    assert.equal(login.statusCode,200);
    const cookie=login.headers['set-cookie'].split(';')[0],csrf=login.body.csrf;
    const record={id:'a'.repeat(36),title:'Published promotion',campaign:'MUSIC',caption:'Saved public caption',link:'https://www.docjaks.com/sm-welcome',imageId:null,targets:['facebook'],status:'published',results:{facebook:{status:'published',postId:'123_456',publishedAt:'2026-11-01T12:00:00Z',trackingUrl:'https://www.docjaks.com/sm-welcome?utm_id=saved_original'}},revision:7,history:[],approvedBy:'Test owner',scheduledAt:'2026-11-01T12:00:00Z',scheduleToken:'original-schedule-token',createdAt:'2026-10-01T12:00:00Z',updatedAt:'2026-11-01T12:00:00Z'};
    const key=PREFIX+'record:'+record.id;storage.set(key,JSON.stringify(record));
    const body={action:'classifyAcquisition',id:record.id,revision:7,acquisitionGroup:'olr5150'};
    for(const [req,status] of [[request(body),401],[request(body,cookie,'wrong'),403],[request({...body,revision:6},cookie,csrf),409],[request({...body,acquisitionGroup:'music'},cookie,csrf),400]]){
      const res=response();await recordsEndpoint(req,res);assert.equal(res.statusCode,status);assert.deepEqual(JSON.parse(storage.get(key)),record);
    }
    const res=response();await recordsEndpoint(request(body,cookie,csrf),res);
    assert.equal(res.statusCode,200);assert.equal(res.body.record.acquisitionGroup,'olr5150');assert.equal(res.body.record.revision,8);
    const classified=JSON.parse(storage.get(key));
    for(const field of ['title','campaign','caption','link','imageId','targets','status','results','approvedBy','scheduledAt','scheduleToken','createdAt'])assert.deepEqual(classified[field],record[field],field+' must remain unchanged');
    assert.match(classified.history[0].message,/OLR5150 social post/);
    const noOp=response();await recordsEndpoint(request({...body,revision:8},cookie,csrf),noOp);
    assert.equal(noOp.body.record.revision,8,'Repeated selection must not rewrite the record');
    const edit=response();await recordsEndpoint(request({action:'save',id:record.id,revision:8},cookie,csrf),edit);assert.equal(edit.statusCode,409,'Published content remains locked');
    classified.status='scheduled';storage.set(key,JSON.stringify(classified));
    const scheduled=response();await recordsEndpoint(request({...body,revision:8,acquisitionGroup:'docjaks'},cookie,csrf),scheduled);
    assert.equal(scheduled.statusCode,200);assert.equal(scheduled.body.record.status,'scheduled');assert.equal(scheduled.body.record.scheduleToken,record.scheduleToken);assert.equal(scheduled.body.record.acquisitionGroup,'docjaks');
    const duplicate=response();await recordsEndpoint(request({action:'duplicate',id:record.id,revision:9},cookie,csrf),duplicate);
    assert.equal(duplicate.statusCode,200);assert.equal(duplicate.body.record.acquisitionGroup,'docjaks');assert.notEqual(duplicate.body.record.id,record.id);assert.equal(duplicate.body.record.status,'draft');
    const clear=response();await recordsEndpoint(request({...body,revision:9,acquisitionGroup:null},cookie,csrf),clear);
    assert.equal(clear.statusCode,200);assert.equal(clear.body.record.acquisitionGroup,null);assert.equal(clear.body.record.status,'scheduled');
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
