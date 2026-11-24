import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEndpoint,PREFIX} from '../lib/core.js';
import {salesProductsEndpoint,normalizeSalesProduct} from '../lib/sales-products.js';

const ORIGIN='https://product-sales.example.test',PASSWORD='synthetic-product-test-password';
const ENV_KEYS=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN','KV_REST_API_URL','KV_REST_API_TOKEN',
  'DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD','DJOMS_OWNER_NAME'];
const exampleProduct=()=>({division:'food',name:'Synthetic sauce',sku:'TEST-SAUCE',packageLabel:'12 oz bottle',unit:'bottle',
  defaultPrice:'',bottleSizeMl:'',bottlesPerUnit:'',proof:'',active:true});
function response(){return {statusCode:200,headers:{},body:null,setHeader(key,value){this.headers[key.toLowerCase()]=value;},
  status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};}
async function harness(run){
  const originalFetch=globalThis.fetch,originalEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  const storage=new Map(),indexes=new Map(),requests=[];let loseSave=false,race=null,sequence=0;
  try{
    Object.assign(process.env,{PUBLIC_BASE_URL:ORIGIN,UPSTASH_REDIS_REST_URL:'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN:'synthetic-redis-token',DJOMS_SESSION_SECRET:'synthetic-product-secret-at-least-32-characters',
      DJOMS_ADMIN_PASSWORD:PASSWORD,DJOMS_OWNER_NAME:'Test Owner'});
    delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://redis.example.test','Only the isolated synthetic Redis store is allowed');
      const [command,...args]=JSON.parse(options.body);requests.push({command,args});let result;
      if(command==='GET')result=storage.get(args[0])??null;
      else if(command==='MGET')result=args.map(key=>storage.get(key)??null);
      else if(command==='ZRANGE')result=[...(indexes.get(args[0])||new Map()).keys()].slice(Number(args[1]),Number(args[2])+1);
      else if(command==='SET'){
        const [key,value,...flags]=args;
        if(flags.includes('NX')&&storage.has(key))result=null;else{storage.set(key,value);result='OK';}
      }else if(command==='DEL')result=args.reduce((sum,key)=>sum+(storage.delete(key)?1:0),0);
      else if(command==='EVAL'){
        const [script,count,...rest]=args,keys=rest.slice(0,count),values=rest.slice(count);
        if(script.includes('local request=redis.call("get",KEYS[4])')){
          if(race){const update=race;race=null;update({keys,values,storage,indexes});}
          const [record,summary,mapping,hash,expectedRevision,score,id,limit]=values,priorRequest=storage.get(keys[3]);
          const index=indexes.get(keys[2])||new Map();
          if(priorRequest)result=JSON.parse(priorRequest).hash===hash?'!replay':'!conflict';
          else if((storage.has(keys[0])?JSON.parse(storage.get(keys[0])).revision:0)!==Number(expectedRevision))result='!revision';
          else if(!storage.has(keys[0])&&index.size>=Number(limit))result='!limit';
          else{
            storage.set(keys[0],record);storage.set(keys[1],summary);storage.set(keys[3],mapping);
            if(!index.has(id))index.set(id,Number(score));indexes.set(keys[2],index);result='!saved';
            if(loseSave){loseSave=false;throw new Error('Synthetic response lost after atomic product write');}
          }
        }else if(script.includes('redis.call("del",KEYS[1])'))result=storage.get(keys[0])===values[0]?(storage.delete(keys[0])?1:0):0;
        else if(script.includes('redis.call("incr",KEYS[1])'))result=1;
        else throw new Error('Unexpected Lua script in isolated catalog store');
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
      await salesProductsEndpoint({method:options.method||'POST',query:{businessId:'conestoga',...options.query},body,headers},res);return res;
    };
    const body=(product=exampleProduct(),extra={})=>({action:'save',businessId:'conestoga',expectedRevision:0,
      requestId:'test-product-save-'+String(++sequence).padStart(5,'0'),product,...extra});
    const save=async(product=exampleProduct(),extra={})=>{
      const res=await request(body(product,extra));assert.equal(res.statusCode,200,res.body?.error);return res.body.product;
    };
    const stored=(businessId,id)=>JSON.parse(storage.get(PREFIX+'sales-product:'+businessId+':'+id));
    await run({request,body,save,stored,storage,indexes,requests,loseSave:()=>{loseSave=true;},race:update=>{race=update;}});
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
}

test('product normalization keeps Food package labels separate from Alcohol defaults and preserves unknown prices',()=>{
  const food=normalizeSalesProduct(exampleProduct(),'conestoga');
  assert.equal(food.packageLabel,'12 oz bottle');assert.equal(food.defaultPrice,'');assert.equal(food.bottleSizeMl,'');assert.equal(food.proof,'');
  assert.equal(Object.hasOwn(food,'volumeMl'),false);assert.equal(Object.hasOwn(food,'proofGallonsMicros'),false);
  const alcohol=normalizeSalesProduct({...exampleProduct(),division:'alcohol',defaultPrice:'0012.3',bottleSizeMl:'0750',proof:'080.500'},'conestoga');
  assert.equal(alcohol.defaultPrice,'12.30');assert.equal(alcohol.bottleSizeMl,'750');assert.equal(alcohol.proof,'80.5');
  for(const [division,unit] of [['food','bottle'],['alcohol','bottle'],['swag','each'],['events','service'],['catering','service']])
    assert.equal(normalizeSalesProduct({...exampleProduct(),division,unit:''},'conestoga').unit,unit);
  assert.equal(normalizeSalesProduct({...exampleProduct(),defaultPrice:'0'},'conestoga').defaultPrice,'0.00');
  for(const changed of [{name:''},{division:''},{division:'unknown'},{defaultPrice:'1.234'},{defaultPrice:'-1'},{defaultPrice:'$12'},
    {bottleSizeMl:'354'},{proof:'80'},{active:'false'},{unit:'bottle',bottlesPerUnit:'12'},{packageLabel:'x'.repeat(121)}])
    assert.throws(()=>normalizeSalesProduct({...exampleProduct(),...changed},'conestoga'));
  for(const changed of [{proof:'200.001'},{proof:'0'},{proof:'80.1234'},{bottleSizeMl:'750.5'},{bottleSizeMl:'100001'},{unit:'case',bottlesPerUnit:'1001'}])
    assert.throws(()=>normalizeSalesProduct({...exampleProduct(),division:'alcohol',...changed},'conestoga'));
  assert.throws(()=>normalizeSalesProduct({...exampleProduct(),businessId:'doc_jaks'},'conestoga'),/another business/);
});

test('catalog reads are owner-only, contain two no-write Food starters, and keep business scope explicit',()=>harness(async h=>{
  assert.equal((await h.request({}, {method:'GET',anonymous:true})).statusCode,401);
  assert.equal((await h.request(h.body(),{headers:{'x-djoms-csrf':'wrong'}})).statusCode,403);
  assert.equal((await h.request(h.body(),{headers:{origin:'https://other.example.test'}})).statusCode,403);
  const before=[...h.storage.entries()];h.requests.length=0;
  for(const businessId of ['conestoga','doc_jaks']){
    const list=await h.request({}, {method:'GET',query:{businessId}});
    assert.equal(list.statusCode,200);assert.equal(list.body.businessId,businessId);
    assert.deepEqual(list.body.products.map(product=>product.name),['Boss Soss','Sweet Bayou']);
    for(const product of list.body.products){
      assert.equal(product.businessId,businessId);assert.equal(product.revision,0);assert.equal(product.division,'food');
      assert.equal(product.defaultPrice,'');assert.equal(product.packageLabel,'12 oz bottle');assert.equal(product.historyCount,0);
      assert.equal(Object.hasOwn(product,'history'),false);
    }
  }
  assert.deepEqual([...h.storage.entries()],before);assert.equal(h.indexes.size,0);
  assert.ok(h.requests.every(item=>['GET','ZRANGE'].includes(item.command)));
  const starter=await h.request({}, {method:'GET',query:{id:'starter_food_boss_soss'}});
  assert.deepEqual(starter.body.product.history,[]);
  assert.equal((await h.request({}, {method:'GET',query:{id:'a'.repeat(36)}})).statusCode,404);
  assert.equal((await h.request({}, {method:'GET',query:{businessId:'other'}})).statusCode,400);
  assert.equal((await h.request({}, {method:'DELETE'})).statusCode,405);
}));

test('catalog revisions and archive preserve actor history and historical sale snapshots',()=>harness(async h=>{
  const first=await h.save({...exampleProduct(),defaultPrice:'12'});
  assert.equal(first.revision,1);assert.equal(first.createdBy,'Test Owner');assert.equal(first.history[0].before,null);
  assert.equal(first.createRequestId,first.history[0].requestId);assert.equal(first.lastRequestId,first.createRequestId);
  const saleKey=PREFIX+'sale:conestoga:synthetic-snapshot';
  const snapshot=JSON.stringify({items:[{productId:first.id,description:first.name,unitPrice:first.defaultPrice,packageLabel:first.packageLabel}]});
  h.storage.set(saleKey,snapshot);
  const second=await h.save({...exampleProduct(),name:'Synthetic sauce revised',defaultPrice:'13',active:false},{id:first.id,expectedRevision:1});
  assert.equal(second.revision,2);assert.equal(second.history.length,2);assert.equal(second.history[0].type,'archived');
  assert.equal(second.history[0].before.defaultPrice,'12.00');assert.equal(second.history[0].after.defaultPrice,'13.00');
  assert.equal(second.createRequestId,first.createRequestId);assert.notEqual(second.lastRequestId,first.lastRequestId);
  assert.equal(h.storage.get(saleKey),snapshot,'Catalog changes cannot modify a saved sale snapshot');
  assert.equal((await h.request(h.body(exampleProduct(),{id:first.id,expectedRevision:1}))).statusCode,409);
  assert.equal((await h.request(h.body(exampleProduct(),{id:first.id,businessId:'doc_jaks',expectedRevision:2}))).statusCode,404);
  assert.equal((await h.request({}, {method:'GET',query:{businessId:'doc_jaks',id:first.id}})).statusCode,404);
  h.requests.length=0;
  const list=await h.request({}, {method:'GET'}),saved=list.body.products.find(product=>product.id===first.id);
  assert.equal(saved.active,false);assert.equal(saved.historyCount,2);assert.equal(Object.hasOwn(saved,'history'),false);
  assert.ok(!h.requests.some(item=>item.command==='GET'&&item.args[0].startsWith(PREFIX+'sales-product:')));
  assert.ok(h.requests.find(item=>item.command==='MGET').args.every(key=>key.startsWith(PREFIX+'sales-product-summary:')));
  const full=await h.request({}, {method:'GET',query:{id:first.id}});assert.deepEqual(full.body.product,second);
  const restored=await h.save({...exampleProduct(),active:true},{id:first.id,expectedRevision:2});assert.equal(restored.history[0].type,'restored');
}));

test('starter edits merge once per business without reviving archived starter choices',()=>harness(async h=>{
  const saved=await h.save({...exampleProduct(),name:'Boss Soss',defaultPrice:'9.5',active:false},{id:'starter_food_boss_soss'});
  assert.equal(saved.revision,1);assert.equal(saved.history[0].before.defaultPrice,'');
  const list=await h.request({}, {method:'GET'});assert.equal(list.body.products.length,2);
  const starter=list.body.products.find(product=>product.id===saved.id);assert.equal(starter.active,false);assert.equal(starter.defaultPrice,'9.50');
  const other=await h.request({}, {method:'GET',query:{businessId:'doc_jaks',id:saved.id}});
  assert.equal(other.body.product.revision,0);assert.equal(other.body.product.defaultPrice,'');assert.equal(other.body.product.active,true);
  assert.equal((await h.request(h.body({...exampleProduct(),division:'swag'},{id:'starter_food_sweet_bayou'}))).statusCode,400);
}));

test('lost product saves replay atomically without duplicates and survive later revisions',()=>harness(async h=>{
  const body=h.body({...exampleProduct(),defaultPrice:'10.5'},{requestId:'test-product-lost-response'});
  h.loseSave();assert.equal((await h.request(body)).statusCode,503);
  const retry=await h.request({...body,product:{...body.product,defaultPrice:'10.50'}});assert.equal(retry.statusCode,200);
  const first=retry.body.product;assert.equal(first.history.length,1);assert.equal(h.indexes.get(PREFIX+'sales-products:conestoga').size,1);
  assert.equal(JSON.parse(h.storage.get(PREFIX+'sales-product-summary:conestoga:'+first.id)).revision,1);
  const later=await h.save({...exampleProduct(),defaultPrice:'11'},{id:first.id,expectedRevision:1});
  assert.deepEqual((await h.request(body)).body.product,later);
  assert.equal((await h.request({...body,product:{...body.product,defaultPrice:'12'}})).statusCode,409);
  assert.equal((await h.request({...body,id:first.id})).statusCode,409);
  const other=await h.request({...body,businessId:'doc_jaks'});assert.equal(other.statusCode,200);assert.notEqual(other.body.product.id,first.id);
}));

test('atomic product revision and catalog limits protect concurrent saves and preserve full histories',()=>harness(async h=>{
  const first=await h.save();
  h.race(({keys,storage})=>{
    const other=JSON.parse(storage.get(keys[0]));other.revision++;other.name='Concurrent name';storage.set(keys[0],JSON.stringify(other));
  });
  assert.equal((await h.request(h.body({...exampleProduct(),name:'Stale name'},{id:first.id,expectedRevision:1}))).statusCode,409);
  assert.equal(h.stored('conestoga',first.id).name,'Concurrent name');
  const capped={...first,revision:100,history:Array.from({length:100},(_,index)=>({...first.history[0],revision:100-index,requestId:'synthetic-history-'+index}))};
  h.storage.set(PREFIX+'sales-product:conestoga:'+first.id,JSON.stringify(capped));
  const cap=await h.request(h.body(exampleProduct(),{id:first.id,expectedRevision:100}));assert.equal(cap.statusCode,400);assert.match(cap.body.error,/history is full/);
  assert.deepEqual(h.stored('conestoga',first.id),capped);
  const index=h.indexes.get(PREFIX+'sales-products:conestoga');
  while(index.size<500)index.set('synthetic-index-'+index.size,index.size);
  const before=[...h.storage.entries()];
  const limit=await h.request(h.body());assert.equal(limit.statusCode,400);assert.match(limit.body.error,/500 saved-product/);
  assert.deepEqual([...h.storage.entries()],before,'Rejected creation changes neither records, summaries nor request mappings');
  assert.equal(index.size,500);
}));
