import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEndpoint,PREFIX} from '../lib/core.js';
import {salesDaysEndpoint,normalizeSalesDay} from '../lib/sales-days.js';

const ORIGIN='https://daily-sales.example.test';
const PASSWORD='synthetic-daily-sales-test-password';
const ENV_KEYS=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL','KV_REST_API_TOKEN','DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD','DJOMS_OWNER_NAME'];
const exampleDay=()=>({date:'2024-02-15',visitors:'',tastings:'',cocktails:'',tipsAmount:'',notes:''});
function response(){return {statusCode:200,headers:{},body:null,
  setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(value){this.statusCode=value;return this;},
  json(value){this.body=value;return this;}};}
async function harness(run){
  const originalFetch=globalThis.fetch,originalEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  const storage=new Map(),requests=[];let loseSave=false,race=null,sequence=0;
  try{
    Object.assign(process.env,{PUBLIC_BASE_URL:ORIGIN,UPSTASH_REDIS_REST_URL:'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN:'synthetic-redis-token',DJOMS_SESSION_SECRET:'synthetic-daily-sales-secret-at-least-32-characters',
      DJOMS_ADMIN_PASSWORD:PASSWORD,DJOMS_OWNER_NAME:'Test Owner'});
    delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://redis.example.test','Tests block all live storage, payment, report and other service requests');
      const [command,...args]=JSON.parse(options.body);requests.push({command,args});let result;
      if(command==='GET')result=storage.get(args[0])??null;
      else if(command==='MGET')result=args.map(key=>storage.get(key)??null);
      else if(command==='SET'){
        const [key,value,...flags]=args;
        if(flags.includes('NX')&&storage.has(key))result=null;
        else{storage.set(key,value);result='OK';}
      }else if(command==='DEL')result=args.reduce((sum,key)=>sum+(storage.delete(key)?1:0),0);
      else if(command==='EVAL'){
        const [script,count,...rest]=args,keys=rest.slice(0,count),values=rest.slice(count);
        if(script.includes('local request=redis.call("get",KEYS[3])')){
          if(race){const update=race;race=null;update({keys,values,storage});}
          const [record,summary,mapping,hash,expectedRevision]=values,priorRequest=storage.get(keys[2]);
          if(priorRequest)result=JSON.parse(priorRequest).hash===hash?'!replay':'!conflict';
          else if((storage.has(keys[0])?JSON.parse(storage.get(keys[0])).revision:0)!==Number(expectedRevision))result='!revision';
          else{
            storage.set(keys[0],record);storage.set(keys[1],summary);storage.set(keys[2],mapping);result='!saved';
            if(loseSave){loseSave=false;throw new Error('Synthetic lost response after atomic daily save');}
          }
        }else if(script.includes('redis.call("del",KEYS[1])'))result=storage.get(keys[0])===values[0]?(storage.delete(keys[0])?1:0):0;
        else if(script.includes('redis.call("incr",KEYS[1])'))result=1;
        else throw new Error('Unexpected Lua script in isolated daily store');
      }else throw new Error('Unexpected Redis command '+command);
      return {ok:true,status:200,json:async()=>({result})};
    };
    const signIn=response();
    await sessionEndpoint({method:'POST',query:{},body:{password:PASSWORD},headers:{origin:ORIGIN,'content-type':'application/json'}},signIn);
    assert.equal(signIn.statusCode,200);
    const cookie=signIn.headers['set-cookie'].split(';')[0],csrf=signIn.body.csrf;
    const request=async(body={},options={})=>{
      const res=response(),headers={origin:ORIGIN,'content-type':'application/json',cookie,'x-djoms-csrf':csrf,...options.headers};
      if(options.anonymous)delete headers.cookie;
      await salesDaysEndpoint({method:options.method||'POST',query:{businessId:'conestoga',...options.query},body,headers},res);return res;
    };
    const body=(day=exampleDay(),extra={})=>({action:'save',businessId:'conestoga',expectedRevision:0,
      requestId:'test-daily-save-'+String(++sequence).padStart(5,'0'),day,...extra});
    const save=async(day=exampleDay(),extra={})=>{
      const res=await request(body(day,extra));assert.equal(res.statusCode,200,res.body?.error);return res.body.day;
    };
    const stored=(businessId,selected)=>JSON.parse(storage.get(PREFIX+'sales-day:'+businessId+':'+selected));
    await run({request,body,save,stored,storage,requests,loseSave:()=>{loseSave=true;},race:update=>{race=update;}});
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}

test('daily metrics preserve unknown versus zero and reject invalid dates, counts, money and identity changes',()=>{
  const blank=normalizeSalesDay(exampleDay(),'conestoga');
  assert.deepEqual([blank.visitors,blank.tastings,blank.cocktails,blank.tipsAmount,blank.tipsCents],['','','','',null]);
  const zero=normalizeSalesDay({...exampleDay(),visitors:'000',tastings:'0',cocktails:'0',tipsAmount:'0'},'conestoga');
  assert.deepEqual([zero.visitors,zero.tastings,zero.cocktails,zero.tipsAmount,zero.tipsCents],['0','0','0','0.00',0]);
  const exact=normalizeSalesDay({...exampleDay(),visitors:'1000000',tipsAmount:'12.3'},'conestoga');
  assert.equal(exact.visitors,'1000000');assert.equal(exact.tipsCents,1230);assert.equal(exact.tipsAmount,'12.30');
  for(const value of ['-1','1.5','1e2','1,000','1000001',1])
    assert.throws(()=>normalizeSalesDay({...exampleDay(),visitors:value},'conestoga'),/Visitors/);
  for(const value of ['-1','1.234','1e2','1,000','$5','1000000000'])
    assert.throws(()=>normalizeSalesDay({...exampleDay(),tipsAmount:value},'conestoga'),/Tips/);
  for(const selected of ['2024-02-30','2023-02-29','2024-00-01','2199-01-01',''])
    assert.throws(()=>normalizeSalesDay({...exampleDay(),date:selected},'conestoga'),/calendar date|future/);
  assert.throws(()=>normalizeSalesDay({...exampleDay(),notes:'x'.repeat(2001)},'conestoga'),/2000/);
  assert.throws(()=>normalizeSalesDay({...exampleDay(),businessId:'doc_jaks'},'conestoga'),/another business/);
  assert.throws(()=>normalizeSalesDay({...exampleDay(),id:'2024-02-16'},'conestoga'),/another date/);
});

test('daily reads are owner-only, business-scoped, read-only and bounded to real calendar months',()=>harness(async h=>{
  assert.equal((await h.request({}, {method:'GET',query:{month:'2024-02'},anonymous:true})).statusCode,401);
  assert.equal((await h.request(h.body(),{headers:{'x-djoms-csrf':'wrong'}})).statusCode,403);
  assert.equal((await h.request(h.body(),{headers:{origin:'https://other.example.test'}})).statusCode,403);
  const before=[...h.storage.entries()];h.requests.length=0;
  const empty=await h.request({}, {method:'GET',query:{month:'2024-02'}});
  assert.equal(empty.statusCode,200);assert.deepEqual(empty.body.days,[]);assert.equal(empty.body.timezone,'America/Chicago');
  assert.deepEqual([...h.storage.entries()],before);
  const read=h.requests.find(item=>item.command==='MGET');assert.equal(read.args.length,29);
  assert.ok(read.args.every(key=>key.startsWith(PREFIX+'sales-day-summary:conestoga:2024-02-')));
  assert.equal((await h.request({}, {method:'GET',query:{date:'2024-02-29'}})).body.day,null);
  for(const query of [{},{month:'2024-13'},{month:'2024-2'},{month:['2024-02']},{month:'2024-02',date:'2024-02-15'},
    {date:'2023-02-29'},{date:'2024-02-30'},{businessId:'other',month:'2024-02'}])
    assert.equal((await h.request({}, {method:'GET',query})).statusCode,400);
  await h.save({...exampleDay(),visitors:'4',tipsAmount:'1.25'});
  const other=await h.request({}, {method:'GET',query:{businessId:'doc_jaks',month:'2024-02'}});assert.deepEqual(other.body.days,[]);
  await h.save({...exampleDay(),visitors:'9'},{businessId:'doc_jaks'});
  assert.equal(h.stored('conestoga','2024-02-15').visitors,'4');assert.equal(h.stored('doc_jaks','2024-02-15').visitors,'9');
}));

test('one day per date has revision-guarded edits and full actor, request and before/after history',()=>harness(async h=>{
  const first=await h.save({...exampleDay(),visitors:'5',tipsAmount:'1.10'});
  assert.equal(first.id,'2024-02-15');assert.equal(first.revision,1);assert.equal(first.history.length,1);
  assert.equal(first.createdBy,'Test Owner');assert.equal(first.history[0].before,null);
  assert.equal(first.history[0].after.visitors,'5');assert.ok(first.history[0].requestId);
  assert.equal((await h.request(h.body({...exampleDay(),visitors:'6'}))).statusCode,409,'A second create cannot overwrite a date');
  const second=await h.save({...exampleDay(),visitors:'7',tipsAmount:'0',notes:'Synthetic count corrected'},{expectedRevision:1});
  assert.equal(second.revision,2);assert.equal(second.history.length,2);assert.equal(second.createdAt,first.createdAt);
  assert.equal(second.history[0].before.visitors,'5');assert.equal(second.history[0].after.visitors,'7');
  assert.equal(second.history[0].before.tipsCents,110);assert.equal(second.history[0].after.tipsCents,0);
  assert.deepEqual(second.history[1],first.history[0]);
  assert.equal((await h.request(h.body({...exampleDay(),visitors:'8'},{expectedRevision:1}))).statusCode,409);
  assert.equal((await h.request(h.body({...exampleDay(),date:'2024-02-16'},{expectedRevision:2}))).statusCode,409);
  const full=await h.request({}, {method:'GET',query:{date:'2024-02-15'}});assert.deepEqual(full.body.day,second);
  const list=await h.request({}, {method:'GET',query:{month:'2024-02'}});
  assert.equal(list.body.days.length,1);assert.equal(list.body.days[0].historyCount,2);
  assert.equal(Object.hasOwn(list.body.days[0],'history'),false);assert.equal(list.body.days[0].tipsCents,0);
  assert.equal(Object.hasOwn(list.body.days[0],'salesAmount'),false,'No duplicate manual dollar-sales metric');
  assert.ok(![...h.storage.keys()].some(key=>/^djoms:v2:(sale:|sales:|report:)/.test(key)),'Daily activity never writes sale or report ledgers');
}));

test('daily record, summary and request mapping commit together; unchanged retries survive later revisions',()=>harness(async h=>{
  const body=h.body({...exampleDay(),visitors:'005',tipsAmount:'2.5'},{requestId:'test-daily-lost-response'});
  h.loseSave();assert.equal((await h.request(body)).statusCode,503);
  const retry=await h.request({...body,day:{...body.day,visitors:'5',tipsAmount:'2.50'}});
  assert.equal(retry.statusCode,200);assert.equal(retry.body.day.revision,1);assert.equal(retry.body.day.history.length,1);
  const summary=JSON.parse(h.storage.get(PREFIX+'sales-day-summary:conestoga:2024-02-15'));
  assert.equal(summary.revision,1);assert.equal(summary.visitors,'5');assert.equal(summary.historyCount,1);
  const later=await h.save({...exampleDay(),visitors:'6'},{expectedRevision:1});
  const oldRetry=await h.request(body);assert.equal(oldRetry.statusCode,200);assert.deepEqual(oldRetry.body.day,later);
  assert.equal((await h.request({...body,day:{...body.day,visitors:'7'}})).statusCode,409);
  assert.equal((await h.request({...body,day:{...body.day,date:'2024-02-16'}})).statusCode,409);
  assert.equal(h.stored('conestoga','2024-02-15').history.length,2);
  assert.equal(h.storage.has(PREFIX+'sales-day:conestoga:2024-02-16'),false);
  const other=await h.request({...body,businessId:'doc_jaks'});assert.equal(other.statusCode,200,'Request scope is per business');
}));

test('atomic daily revision checks protect against a lost lock lease and concurrent date creation',()=>harness(async h=>{
  const day=await h.save({...exampleDay(),visitors:'1'});
  h.race(({keys,storage})=>{
    const other=JSON.parse(storage.get(keys[0]));other.revision++;other.visitors='11';
    storage.set(keys[0],JSON.stringify(other));const summary=JSON.parse(storage.get(keys[1]));summary.revision++;summary.visitors='11';storage.set(keys[1],JSON.stringify(summary));
  });
  const stale=await h.request(h.body({...exampleDay(),visitors:'2'},{expectedRevision:day.revision}));
  assert.equal(stale.statusCode,409);assert.equal(h.stored('conestoga',day.date).visitors,'11');
  h.race(({keys,values,storage})=>{
    const concurrent=JSON.parse(values[0]);concurrent.visitors='22';concurrent.history[0].after.visitors='22';
    storage.set(keys[0],JSON.stringify(concurrent));const summary=JSON.parse(values[1]);summary.visitors='22';storage.set(keys[1],JSON.stringify(summary));
  });
  const competing=await h.request(h.body({...exampleDay(),date:'2024-02-16',visitors:'3'}));
  assert.equal(competing.statusCode,409);assert.equal(h.stored('conestoga','2024-02-16').visitors,'22');
  const currentSummary=JSON.parse(h.storage.get(PREFIX+'sales-day-summary:conestoga:2024-02-16'));assert.equal(currentSummary.visitors,'22');
}));

test('daily history caps preserve every event, and month reads never load full histories or adjacent months',()=>harness(async h=>{
  const first=await h.save({...exampleDay(),visitors:'0'});
  const capped={...first,revision:200,history:Array.from({length:200},(_,index)=>({...first.history[0],requestId:'synthetic-history-'+index,revision:200-index}))};
  h.storage.set(PREFIX+'sales-day:conestoga:'+first.date,JSON.stringify(capped));
  const summary=JSON.parse(h.storage.get(PREFIX+'sales-day-summary:conestoga:'+first.date));summary.revision=200;summary.historyCount=200;
  h.storage.set(PREFIX+'sales-day-summary:conestoga:'+first.date,JSON.stringify(summary));
  const result=await h.request(h.body({...exampleDay(),visitors:'1'},{expectedRevision:200}));
  assert.equal(result.statusCode,400);assert.match(result.body.error,/history is full/);assert.deepEqual(h.stored('conestoga',first.date),capped);
  await h.save({...exampleDay(),date:'2024-02-01',visitors:'1'});await h.save({...exampleDay(),date:'2024-02-16',visitors:'2'});
  await h.save({...exampleDay(),date:'2024-02-29',visitors:'3'});await h.save({...exampleDay(),date:'2024-03-01',visitors:'4'});
  h.requests.length=0;
  const month=await h.request({}, {method:'GET',query:{month:'2024-02'}});
  assert.equal(month.statusCode,200);assert.deepEqual(month.body.days.map(day=>day.date),['2024-02-01','2024-02-15','2024-02-16','2024-02-29']);
  assert.equal(month.body.days.find(day=>day.date===first.date).historyCount,200);
  assert.equal(h.requests.filter(item=>item.command==='MGET').length,1);
  assert.ok(!h.requests.some(item=>item.command==='GET'&&item.args[0].startsWith(PREFIX+'sales-day:')));
  h.requests.length=0;await h.request({}, {method:'GET',query:{month:'2023-02'}});
  assert.equal(h.requests.find(item=>item.command==='MGET').args.length,28);
  h.requests.length=0;await h.request({}, {method:'GET',query:{month:'2024-03'}});
  assert.equal(h.requests.find(item=>item.command==='MGET').args.length,31);
}));
