import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEndpoint,PREFIX} from '../lib/core.js';
import {salesEndpoint,normalizeSale} from '../lib/sales.js';

const ORIGIN='https://sales.example.test';
const PASSWORD='synthetic-sales-test-password';
const ENV_KEYS=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL','KV_REST_API_TOKEN','DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD','DJOMS_OWNER_NAME'];
const exampleSale=()=>({businessId:'conestoga',soldOn:'2026-01-15',dueDate:'',channel:'retail',location:'',sourceReference:'',
  customer:{name:'',email:''},notes:'',items:[{description:'Synthetic test item',sku:'',productId:'',batchReference:'',
    category:'spirits',quantity:'1',unit:'bottle',unitPrice:'10.00'}],discountAmount:'0',taxAmount:'0',shippingAmount:'0',
  initialPayment:{amount:'',method:'',date:'',reference:'',notes:''}});
const payment=amount=>({amount,method:'cash',date:'2026-01-15',reference:'synthetic-reference',notes:''});
function response(){return {statusCode:200,headers:{},body:null,
  setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(value){this.statusCode=value;return this;},
  json(value){this.body=value;return this;}};}

async function harness(run){
  const originalFetch=globalThis.fetch;
  const originalEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  const storage=new Map(),indexes=new Map(),requests=[];
  let lostCreate=false,lostUpdate=false,concurrentUpdate=false,sequence=0;
  try{
    Object.assign(process.env,{PUBLIC_BASE_URL:ORIGIN,UPSTASH_REDIS_REST_URL:'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN:'synthetic-redis-token',DJOMS_SESSION_SECRET:'synthetic-sales-secret-at-least-32-characters',
      DJOMS_ADMIN_PASSWORD:PASSWORD,DJOMS_OWNER_NAME:'Test Owner'});
    delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://redis.example.test','Tests block every live service and payment-provider request');
      const [command,...args]=JSON.parse(options.body);requests.push({command,args});
      let result;
      if(command==='GET')result=storage.get(args[0])??null;
      else if(command==='MGET')result=args.map(key=>storage.get(key)??null);
      else if(command==='SET'){
        const [key,value,...flags]=args;
        if(flags.includes('NX')&&storage.has(key))result=null;
        else{storage.set(key,value);result='OK';}
      }else if(command==='DEL')result=args.reduce((sum,key)=>sum+(storage.delete(key)?1:0),0);
      else if(command==='ZREVRANGE'){
        const [key,start,end]=args;
        result=[...(indexes.get(key)||new Map())].sort((a,b)=>b[1]-a[1]||b[0].localeCompare(a[0]))
          .map(([id])=>id).slice(Number(start),Number(end)+1);
      }else if(command==='EVAL'){
        const [script,count,...rest]=args,keys=rest.slice(0,count),values=rest.slice(count);
        if(script.includes('local previous=redis.call("get",KEYS[3])')){
          const [record,score,id,hash,previousNumber,mapping,nextNumber,legacyHash,version2Hash]=values;
          const previous=storage.get(keys[2]);
          if(previous){
            const saved=JSON.parse(previous);result=[hash,legacyHash,version2Hash].includes(saved.hash)?saved.saleId:'!conflict';
          }else if((storage.get(keys[3])||'0')!==previousNumber)result='!sequence';
          else{
            storage.set(keys[0],record);storage.set(keys[2],mapping);storage.set(keys[3],nextNumber);
            const index=indexes.get(keys[1])||new Map();if(!index.has(id))index.set(id,Number(score));indexes.set(keys[1],index);
            result=id;
            if(lostCreate){lostCreate=false;throw new Error('Synthetic lost create response after atomic commit');}
          }
        }else if(script.includes('saved.revision~=tonumber(ARGV[4])')){
          const [record,score,id,expectedRevision]=values;
          if(concurrentUpdate){
            concurrentUpdate=false;
            const concurrent=JSON.parse(storage.get(keys[0]));concurrent.revision++;concurrent.notes='Saved concurrently';
            storage.set(keys[0],JSON.stringify(concurrent));
          }
          const previous=storage.get(keys[0]);
          if(!previous)result='!missing';
          else if(JSON.parse(previous).revision!==Number(expectedRevision))result='!revision';
          else{
            storage.set(keys[0],record);
            const index=indexes.get(keys[1])||new Map();if(!index.has(id))index.set(id,Number(score));indexes.set(keys[1],index);
            result=1;
            if(lostUpdate){lostUpdate=false;throw new Error('Synthetic lost update response after atomic commit');}
          }
        }else if(script.includes('redis.call("del",KEYS[1])'))result=storage.get(keys[0])===values[0]?(storage.delete(keys[0])?1:0):0;
        else if(script.includes('redis.call("incr",KEYS[1])'))result=1; // First allowed owner login attempt.
        else throw new Error('Unexpected Lua script in isolated test store');
      }else throw new Error('Unexpected Redis command '+command);
      return {ok:true,status:200,json:async()=>({result})};
    };
    const signIn=response();
    await sessionEndpoint({method:'POST',query:{},body:{password:PASSWORD},
      headers:{origin:ORIGIN,'content-type':'application/json'}},signIn);
    assert.equal(signIn.statusCode,200);
    const cookie=signIn.headers['set-cookie'].split(';')[0],csrf=signIn.body.csrf;
    const request=async(body={},options={})=>{
      const res=response(),headers={origin:ORIGIN,'content-type':'application/json',cookie,'x-djoms-csrf':csrf,...options.headers};
      if(options.anonymous)delete headers.cookie;
      await salesEndpoint({method:options.method||'POST',query:{businessId:'conestoga',...options.query},body,headers},res);
      return res;
    };
    const create=async(details=exampleSale(),token='test-create-'+String(++sequence).padStart(5,'0'))=>{
      const res=await request({action:'save',businessId:details.businessId,requestId:token,sale:details});
      assert.equal(res.statusCode,200,res.body?.error);return res.body.sale;
    };
    const action=(kind,sale,extra={})=>request({action:kind,businessId:sale.businessId,id:sale.id,expectedRevision:sale.revision,...extra});
    const record=async(details=exampleSale())=>{
      const res=await action('record',await create(details));assert.equal(res.statusCode,200,res.body?.error);return res.body.sale;
    };
    const stored=sale=>JSON.parse(storage.get(PREFIX+'sale:'+sale.businessId+':'+sale.id));
    await run({request,create,action,record,stored,storage,indexes,requests,
      loseCreate:()=>{lostCreate=true;},loseUpdate:()=>{lostUpdate=true;},concurrentUpdate:()=>{concurrentUpdate=true;}});
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(originalEnv)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

test('sale arithmetic uses per-line half-up cents and never invents blank draft amounts',()=>{
  const details=exampleSale();
  details.items=[{...details.items[0],quantity:'0.5',unitPrice:'0.01'},{...details.items[0],quantity:'0.5',unitPrice:'0.01'}];
  const sale=normalizeSale(details,'conestoga');
  assert.deepEqual(sale.items.map(item=>item.lineTotalCents),[1,1]);assert.equal(sale.totals.subtotalCents,2);
  const exact=normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],quantity:'0.333333',unitPrice:'3.00'}]},'conestoga');
  assert.equal(exact.totals.totalCents,100);
  const blank=normalizeSale({...exampleSale(),taxAmount:''},'conestoga');
  assert.equal(blank.totals.taxCents,null);assert.equal(blank.totals.totalCents,null);assert.equal(blank.totals.balanceCents,null);
  assert.equal(blank.totals.paidCents,0);
  const unknownLine=normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],unitPrice:''}]},'conestoga');
  assert.equal(unknownLine.items[0].lineTotalCents,null);assert.equal(unknownLine.totals.subtotalCents,null);
  for(const value of ['1e2','1,000','$1','-1','1.234','1000000000'])
    assert.throws(()=>normalizeSale({...exampleSale(),taxAmount:value},'conestoga'),/Tax amount/);
  assert.throws(()=>normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],quantity:'0'}]},'conestoga'),/greater than zero/);
  assert.throws(()=>normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],quantity:'0.1234567'}]},'conestoga'),/six decimal/);
  assert.throws(()=>normalizeSale({...exampleSale(),discountAmount:'10.01'},'conestoga'),/discount cannot exceed/);
  assert.throws(()=>normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],quantity:'2',unitPrice:'999999999.99'}]},'conestoga'),/Line total/);
  assert.throws(()=>normalizeSale({...exampleSale(),items:Array.from({length:101},()=>exampleSale().items[0])},'conestoga'),/100 item lines/);
});

test('sales are owner-only, CSRF-protected and strictly scoped to one business',()=>harness(async h=>{
  assert.equal((await h.request({}, {method:'GET',anonymous:true})).statusCode,401);
  const body={action:'save',businessId:'conestoga',requestId:'test-create-private',sale:exampleSale()};
  assert.equal((await h.request(body,{headers:{'x-djoms-csrf':'wrong'}})).statusCode,403);
  assert.equal((await h.request(body,{headers:{origin:'https://other.example.test'}})).statusCode,403);
  const before=[...h.storage.entries()];
  const empty=await h.request({}, {method:'GET'});
  assert.deepEqual(empty.body.sales,[]);assert.deepEqual(empty.body.connections,{inventory:false,accounting:false,reports:false});
  assert.deepEqual([...h.storage.entries()],before,'GET never seeds data');
  assert.equal((await h.request({}, {method:'GET',query:{businessId:'unknown'}})).statusCode,400);
  const sale=await h.create();
  assert.equal((await h.request({}, {method:'GET',query:{businessId:'doc_jaks'}})).body.sales.length,0);
  assert.equal((await h.action('record',sale,{businessId:'doc_jaks'})).statusCode,404);
  assert.equal((await h.action('save',sale,{sale:{...exampleSale(),businessId:'doc_jaks'}})).statusCode,409);
  assert.equal(h.stored(sale).businessId,'conestoga');
}));

test('create idempotency, record and business numbering commit together even when a response is lost',()=>harness(async h=>{
  const token='test-create-idempotent',body={action:'save',businessId:'conestoga',requestId:token,sale:exampleSale()};
  h.loseCreate();
  assert.equal((await h.request(body)).statusCode,503);
  const retry=await h.request(body);
  assert.equal(retry.statusCode,200);assert.equal(retry.body.sale.number,'CD-000001');
  assert.equal(retry.body.sale.createRequestId,token);
  assert.equal((await h.request(body)).body.sale.id,retry.body.sale.id);
  assert.equal((await h.request({...body,sale:{...exampleSale(),notes:'Changed payload'}})).statusCode,409);
  assert.equal((await h.request({}, {method:'GET'})).body.sales.length,1);
  const next=await h.create();assert.equal(next.number,'CD-000002');
  const separate=await h.create({...exampleSale(),businessId:'doc_jaks'},token);
  assert.equal(separate.number,'DJ-000001');
  assert.ok(Array.isArray(retry.body.sale.payments)&&Array.isArray(retry.body.sale.history));
}));

test('recording validates exact draft data and initial payment without treating drafts as receipts',()=>harness(async h=>{
  const draft=await h.create({...exampleSale(),initialPayment:payment('4')});
  assert.equal(draft.totals.paidCents,0);assert.equal(draft.payments.length,0);
  const done=await h.action('record',draft);
  assert.equal(done.statusCode,200);assert.equal(done.body.sale.status,'recorded');
  assert.equal(done.body.sale.totals.paidCents,400);assert.equal(done.body.sale.totals.balanceCents,600);
  assert.equal(done.body.sale.payments.length,1);assert.equal(done.body.sale.paymentStatus,'partial');
  assert.equal((await h.action('record',draft)).statusCode,409);
  assert.equal((await h.action('save',done.body.sale,{sale:{...exampleSale(),taxAmount:'2'}})).statusCode,409);
  const over=await h.create({...exampleSale(),initialPayment:payment('10.01')});
  assert.equal((await h.action('record',over)).statusCode,400);
  assert.equal(h.stored(over).status,'draft');assert.deepEqual(h.stored(over).payments,[]);
  const taxUnknown=await h.create({...exampleSale(),taxAmount:''});
  assert.equal((await h.action('record',taxUnknown)).statusCode,400);
  const future=await h.create({...exampleSale(),soldOn:'2199-01-01'});
  assert.equal((await h.action('record',future)).statusCode,400);
  const incomplete=await h.create({...exampleSale(),initialPayment:{amount:'',method:'cash',date:'',reference:'',notes:''}});
  assert.equal((await h.action('record',incomplete)).statusCode,400);
  assert.throws(()=>normalizeSale({...exampleSale(),soldOn:'2026-02-30'},'conestoga'),/real calendar date/);
}));

test('received payments are append-only, bounded and idempotent before stale revision rejection',()=>harness(async h=>{
  const sale=await h.record();
  const body={action:'recordPayment',businessId:sale.businessId,id:sale.id,expectedRevision:sale.revision,
    requestId:'test-payment-first',payment:payment('4')};
  h.loseUpdate();assert.equal((await h.request(body)).statusCode,503);
  const retry=await h.request(body);assert.equal(retry.statusCode,200);
  assert.equal(retry.body.sale.payments.length,1);assert.equal(retry.body.sale.totals.paidCents,400);
  const second=await h.action('recordPayment',retry.body.sale,{requestId:'test-payment-second',payment:payment('6')});
  assert.equal(second.statusCode,200);assert.equal(second.body.sale.paymentStatus,'paid');
  assert.equal(second.body.sale.totals.balanceCents,0);assert.equal(second.body.sale.payments.length,2);
  const oldRetry=await h.request(body);assert.equal(oldRetry.statusCode,200);assert.equal(oldRetry.body.sale.payments.length,2);
  assert.equal((await h.request({...body,payment:payment('5')})).statusCode,409);
  assert.equal((await h.action('recordPayment',second.body.sale,{requestId:'test-payment-over',payment:payment('0.01')})).statusCode,400);
  assert.equal((await h.action('recordPayment',second.body.sale,{requestId:'test-payment-future',payment:{...payment('1'),date:'2199-01-01'}})).statusCode,400);
  assert.equal((await h.action('recordPayment',second.body.sale,{requestId:'test-payment-zero',payment:payment('0')})).statusCode,400);
  assert.equal((await h.action('void',second.body.sale,{reason:'Attempted paid-sale void'})).statusCode,409);
  assert.equal(h.stored(sale).payments.length,2);
  assert.equal(h.stored(sale).totals.totalCents,1000);
}));

test('unpaid and zero-total sales can be voided without deleting values or audit history',()=>harness(async h=>{
  const sale=await h.record();
  const original=JSON.parse(JSON.stringify(sale));
  assert.equal((await h.action('void',sale,{reason:''})).statusCode,400);
  const result=await h.action('void',sale,{reason:'Synthetic entry entered in error'});
  assert.equal(result.statusCode,200);assert.equal(result.body.sale.status,'voided');
  assert.deepEqual(result.body.sale.items,original.items);assert.deepEqual(result.body.sale.totals,original.totals);
  assert.equal(result.body.sale.history[0].type,'voided');assert.deepEqual(result.body.sale.history.slice(1),original.history);
  assert.equal((await h.action('recordPayment',result.body.sale,{requestId:'test-payment-voided',payment:payment('1')})).statusCode,409);
  assert.equal((await h.action('save',result.body.sale,{sale:exampleSale()})).statusCode,409);
  const zero=await h.record({...exampleSale(),items:[{...exampleSale().items[0],unitPrice:'0'}]});
  assert.equal(zero.paymentStatus,'paid');assert.equal(zero.totals.totalCents,0);assert.deepEqual(zero.payments,[]);
  assert.equal((await h.action('void',zero,{reason:'Cancel synthetic zero-total sale'})).statusCode,200);
}));

test('audit and payment caps reject mutations while preserving all existing entries',()=>harness(async h=>{
  const sale=await h.create();
  const capped=h.stored(sale);capped.history=Array.from({length:500},(_,i)=>({at:'2026-01-15T00:00:00Z',type:'saved',user:'Test Owner',message:'Synthetic audit '+i}));
  const key=PREFIX+'sale:'+sale.businessId+':'+sale.id;h.storage.set(key,JSON.stringify(capped));
  assert.equal((await h.action('save',capped,{sale:{...exampleSale(),notes:'Would change'}})).statusCode,400);
  assert.deepEqual(h.stored(capped),capped);
  const paid=await h.record();
  const stored=h.stored(paid);
  stored.payments=Array.from({length:200},(_,i)=>({id:String(i),requestId:'synthetic-payment-'+i,...payment('0.01'),amountCents:1,recordedAt:'2026-01-15T00:00:00Z',recordedBy:'Test Owner'}));
  stored.totals.paidCents=200;stored.totals.balanceCents=800;stored.paymentStatus='partial';
  h.storage.set(PREFIX+'sale:'+paid.businessId+':'+paid.id,JSON.stringify(stored));
  assert.equal((await h.action('recordPayment',stored,{requestId:'test-payment-limit',payment:payment('0.01')})).statusCode,400);
  assert.equal(h.stored(stored).payments.length,200);
}));

test('atomic revision compare preserves a concurrent update even if the prior lock lease were lost',()=>harness(async h=>{
  const sale=await h.create();
  h.concurrentUpdate();
  const update=await h.action('save',sale,{sale:{...exampleSale(),notes:'Stale change'}});
  assert.equal(update.statusCode,409);
  assert.equal(h.stored(sale).notes,'Saved concurrently');assert.equal(h.stored(sale).revision,sale.revision+1);
}));

test('bounded sales pagination keeps all history and stable positions across edits',()=>harness(async h=>{
  const index=new Map(),base=normalizeSale(exampleSale(),'conestoga');
  for(let i=0;i<81;i++){
    const id=(i+1).toString(16).padStart(36,'0');
    const sale={...base,id,number:'CD-TEST-'+i,createRequestId:'synthetic-create-'+i,revision:1,status:'draft',
      createdAt:'2026-01-15T00:00:00Z',updatedAt:'2026-01-15T00:00:00Z',createdBy:'Test Owner',recordedAt:null,voidedAt:null,
      payments:[],history:i>=31?[{type:'saved',message:'x'.repeat(95000)}]:[]};
    index.set(id,i);h.storage.set(PREFIX+'sale:conestoga:'+id,JSON.stringify(sale));
  }
  h.indexes.set(PREFIX+'sales:conestoga',index);
  const first=await h.request({}, {method:'GET'});
  assert.equal(first.statusCode,200);assert.ok(first.body.sales.length>0&&first.body.sales.length<50);
  assert.ok(Buffer.byteLength(JSON.stringify(first.body),'utf8')<=3*1024*1024);
  const unreadId='1'.padStart(36,'0'),unread=JSON.parse(h.storage.get(PREFIX+'sale:conestoga:'+unreadId));
  const edit=await h.action('save',unread,{sale:{...exampleSale(),notes:'Edited during pagination'}});
  assert.equal(edit.statusCode,200);assert.equal(index.get(unreadId),0);
  const all=[...first.body.sales];let cursor=first.body.nextCursor;
  while(cursor!==null){
    const page=await h.request({}, {method:'GET',query:{cursor}});
    assert.equal(page.statusCode,200);assert.ok(page.body.sales.length<=50);
    assert.ok(Buffer.byteLength(JSON.stringify(page.body),'utf8')<=3*1024*1024);
    all.push(...page.body.sales);cursor=page.body.nextCursor;
  }
  assert.equal(new Set(all.map(sale=>sale.id)).size,81);
  assert.equal(all.find(sale=>sale.id===unreadId).notes,'Edited during pagination');
  for(const cursor of ['-1','1.5','1e2','',String(Number.MAX_SAFE_INTEGER),['0','50']])
    assert.equal((await h.request({}, {method:'GET',query:{cursor}})).statusCode,400);
  const missingId='f'.repeat(36);index.set(missingId,100);
  assert.equal((await h.request({}, {method:'GET'})).statusCode,503,'Missing indexed records are never silently skipped');
}));

test('classified bottles and explicit packs use exact TTB volume math without assuming proof or usage',()=>{
  const line=overrides=>normalizeSale({...exampleSale(),items:[{...exampleSale().items[0],purpose:'bottle_sale',bottleSizeMl:'750',proof:'80',...overrides}]},'conestoga').items[0];
  const bottle=line({});
  assert.equal(bottle.bottleCount,1);assert.equal(bottle.volumeMl,750);
  assert.equal(bottle.wineGallonsMicros,198129);assert.equal(bottle.proofGallonsMicros,158503);
  const pack=line({unit:'case',quantity:'3',bottlesPerUnit:'003',bottleSizeMl:'0150'});
  assert.equal(pack.bottlesPerUnit,'3');assert.equal(pack.bottleSizeMl,'150');
  assert.equal(pack.bottleCount,9);assert.equal(pack.volumeMl,1350);
  assert.equal(pack.wineGallonsMicros,356631);assert.equal(pack.proofGallonsMicros,285305);
  const loose=line({quantity:'9',bottleSizeMl:'150'});
  assert.equal(loose.wineGallonsMicros,356632);assert.equal(loose.proofGallonsMicros,285306,'Loose bottles retain the factor until final line rounding');
  const decimal=line({bottleSizeMl:'1000',proof:'080.125'});
  assert.equal(decimal.proof,'80.125');assert.equal(decimal.proofGallonsMicros,211668);
  assert.equal(line({bottleSizeMl:'350'}).volumeMl,350,'Custom size never changes to a preset');
  const unknownProof=line({proof:''});
  assert.equal(unknownProof.volumeMl,750);assert.equal(unknownProof.wineGallonsMicros,198129);assert.equal(unknownProof.proofGallonsMicros,null);
  for(const overrides of [{purpose:''},{purpose:'tasting'},{purpose:'cocktail'},{purpose:'sample'},{purpose:'other'},
    {category:'food'},{unit:'each'},{quantity:''},{quantity:'1.5'},{bottleSizeMl:''},{unit:'case',bottlesPerUnit:''}]){
    const item=line(overrides);
    assert.deepEqual([item.bottleCount,item.volumeMl,item.wineGallonsMicros,item.proofGallonsMicros],[null,null,null,null]);
  }
  const forged=line({bottleCount:9999,volumeMl:123,wineGallonsMicros:1,proofGallonsMicros:1});
  assert.deepEqual([forged.bottleCount,forged.volumeMl,forged.proofGallonsMicros],[1,750,158503]);
  for(const value of ['0','-1','1.5','1e2','100001'])assert.throws(()=>line({bottleSizeMl:value}),/Bottle size/);
  for(const value of ['0','-1','1.5','1001'])assert.throws(()=>line({unit:'case',bottlesPerUnit:value}),/Bottles per case/);
  for(const value of ['0','200.001','-1','80.0001','1e2'])assert.throws(()=>line({proof:value}),/U.S. proof/);
  assert.throws(()=>line({bottlesPerUnit:'3'}),/exactly one bottle/);
  assert.throws(()=>line({purpose:'unknown'}),/purpose/);
  assert.throws(()=>line({unitPrice:'0',quantity:'999999999',unit:'case',bottlesPerUnit:'1000',bottleSizeMl:'100000'}),/too large to save exactly/);
  assert.throws(()=>line({unitPrice:'0',quantity:'200000000',bottleSizeMl:'100000',proof:'200'}),/too large to save exactly/,'Proof gallon micro-units are also bounded');
});

test('recorded bottle sales require whole quantities, sizes, explicit packs and proof while legacy lines stay usable',()=>harness(async h=>{
  const classified=overrides=>({...exampleSale(),items:[{...exampleSale().items[0],purpose:'bottle_sale',bottleSizeMl:'750',proof:'80',...overrides}]});
  for(const overrides of [{quantity:'1.5'},{bottleSizeMl:''},{unit:'case',bottlesPerUnit:''},{proof:''}]){
    const draft=await h.create(classified(overrides));
    assert.equal((await h.action('record',draft)).statusCode,400);assert.equal(h.stored(draft).status,'draft');
  }
  const recorded=await h.record(classified({unit:'case',bottlesPerUnit:'3'}));
  assert.equal(recorded.items[0].bottleCount,3);assert.equal(recorded.items[0].volumeMl,2250);
  const original=JSON.parse(JSON.stringify(recorded.items));
  assert.equal((await h.action('save',recorded,{sale:classified({proof:'90'})})).statusCode,409);
  assert.deepEqual(h.stored(recorded).items,original);
  const legacy=await h.record();assert.equal(legacy.items[0].purpose,'');assert.equal(legacy.items[0].proofGallonsMicros,null);
  const draft=await h.create(classified({}));
  const staleClient={...exampleSale(),items:[{...exampleSale().items[0],quantity:'2'}]};
  const saved=await h.action('save',draft,{sale:staleClient});
  assert.equal(saved.statusCode,200);assert.equal(saved.body.sale.items[0].proof,'80');
  assert.equal(saved.body.sale.items[0].bottleSizeMl,'750');assert.equal(saved.body.sale.items[0].bottleCount,2);
  assert.equal((await h.action('save',saved.body.sale,{sale:{...staleClient,items:[{...staleClient.items[0],description:'Another item'}]}})).statusCode,409);
  const cleared=await h.action('save',saved.body.sale,{sale:classified({purpose:'',bottleSizeMl:'',bottlesPerUnit:'',proof:''})});
  assert.equal(cleared.statusCode,200);assert.equal(cleared.body.sale.items[0].bottleCount,null);
}));

test('unchanged v1 and v2 create retries survive new metadata but changed classification or package conflicts',()=>harness(async h=>{
  const token='test-create-before-upgrade',sale=await h.create(exampleSale(),token);
  // Captured from the actual v1 normalized synthetic fixture, before new fields existed.
  const hash='d0e842c4d89e6f54fb3031ad933441e175b9c99166a089857cb35afb66785cfa';
  h.storage.set(PREFIX+'sales-create:conestoga:'+token,JSON.stringify({saleId:sale.id,hash}));
  const body={action:'save',businessId:'conestoga',requestId:token,sale:exampleSale()};
  const retry=await h.request(body);assert.equal(retry.statusCode,200);assert.equal(retry.body.sale.id,sale.id);
  assert.equal((await h.request({...body,sale:{...exampleSale(),items:[{...exampleSale().items[0],purpose:'bottle_sale'}]}})).statusCode,409);
  const classified={...exampleSale(),items:[{...exampleSale().items[0],purpose:'bottle_sale',bottleSizeMl:'350',proof:'80',quantity:'2'}]};
  const v2Token='test-create-version-two',v2=await h.create(classified,v2Token);
  // Captured from the v2 fixture including size/proof and exact converted amounts.
  h.storage.set(PREFIX+'sales-create:conestoga:'+v2Token,JSON.stringify({saleId:v2.id,hash:'909747650135304aedccd098ff03e30e5c1dde8947fcee726da78656a267df7b'}));
  const v2Body={action:'save',businessId:'conestoga',requestId:v2Token,sale:classified};
  const v2Retry=await h.request(v2Body);assert.equal(v2Retry.statusCode,200);assert.equal(v2Retry.body.sale.id,v2.id);
  for(const update of [{division:'alcohol'},{outlet:'event'},{customer:{companyName:'Synthetic company'}},
    {items:[{...classified.items[0],packageLabel:'Synthetic package'}]},{items:[{...classified.items[0],proof:'90'}]}])
    assert.equal((await h.request({...v2Body,sale:{...classified,...update}})).statusCode,409);
  assert.equal((await h.request({}, {method:'GET'})).body.sales.length,2);
}));

test('master section, outlet and company fields normalize without converting Food package labels',()=>{
  const raw={...exampleSale(),division:'food',outlet:'farmers_market',customer:{name:'',email:'',companyName:' Synthetic company ',
    contactName:' Test contact ',phone:' +1 555 0100 ',address:' First line\nSecond line '},
    items:[{...exampleSale().items[0],category:'food',packageLabel:' 12 oz bottle '}]};
  const sale=normalizeSale(raw,'conestoga');
  assert.equal(sale.division,'food');assert.equal(sale.outlet,'farmers_market');
  assert.deepEqual(sale.customer,{name:'',email:'',companyName:'Synthetic company',contactName:'Test contact',phone:'+1 555 0100',address:'First line\nSecond line'});
  assert.equal(sale.items[0].packageLabel,'12 oz bottle');assert.equal(sale.items[0].bottleSizeMl,'');
  assert.deepEqual([sale.items[0].bottleCount,sale.items[0].volumeMl,sale.items[0].wineGallonsMicros,sale.items[0].proofGallonsMicros],[null,null,null,null]);
  const legacy=normalizeSale(exampleSale(),'conestoga');
  assert.equal(legacy.division,'');assert.equal(legacy.outlet,'');assert.equal(legacy.customer.companyName,'');assert.equal(legacy.items[0].packageLabel,'');
  for(const division of ['food','alcohol','swag','events','catering'])assert.equal(normalizeSale({...raw,division},'conestoga').division,division);
  for(const outlet of ['online','farmers_market','event','catering','in_store','other'])assert.equal(normalizeSale({...raw,outlet},'conestoga').outlet,outlet);
  assert.throws(()=>normalizeSale({...raw,division:'spirits'},'conestoga'),/sales section/);
  assert.throws(()=>normalizeSale({...raw,outlet:'unknown'},'conestoga'),/selling outlet/);
  for(const [field,limit] of [['companyName',200],['contactName',200],['phone',80],['address',1000]])
    assert.throws(()=>normalizeSale({...raw,customer:{...raw.customer,[field]:'x'.repeat(limit+1)}},'conestoga'),/no more than/);
  assert.throws(()=>normalizeSale({...raw,items:[{...raw.items[0],packageLabel:'x'.repeat(121)}]},'conestoga'),/Package label/);
  const catering=normalizeSale({...exampleSale(),division:'catering',outlet:'event',items:[{...exampleSale().items[0],purpose:'bottle_sale',bottleSizeMl:'750',proof:'80'}]},'conestoga');
  assert.equal(catering.items[0].proofGallonsMicros,158503,'Alcohol line volume follows its saved facts even in another primary section');
});

test('classified retail and wholesale recording require outlet or company while legacy channels stay compatible',()=>harness(async h=>{
  const retail=await h.create({...exampleSale(),division:'food'});
  const blockedRetail=await h.action('record',retail);assert.equal(blockedRetail.statusCode,400);assert.match(blockedRetail.body.error,/outlet/);
  assert.equal(h.stored(retail).status,'draft');
  const wholesale=await h.create({...exampleSale(),division:'food',channel:'wholesale'});
  const blockedWholesale=await h.action('record',wholesale);assert.equal(blockedWholesale.statusCode,400);assert.match(blockedWholesale.body.error,/company name/);
  assert.equal(h.stored(wholesale).status,'draft');
  const recordedRetail=await h.record({...exampleSale(),division:'food',outlet:'event',items:[{...exampleSale().items[0],category:'food',packageLabel:'12 oz bottle'}]});
  assert.equal(recordedRetail.division,'food');assert.equal(recordedRetail.outlet,'event');
  const recordedWholesale=await h.record({...exampleSale(),division:'swag',channel:'wholesale',customer:{name:'',email:'',companyName:'Synthetic wholesale company',contactName:'Test contact',phone:'555-0100',address:'Synthetic address'}});
  assert.equal(recordedWholesale.customer.companyName,'Synthetic wholesale company');assert.equal(recordedWholesale.customer.contactName,'Test contact');
  assert.equal((await h.action('save',recordedWholesale,{sale:{...exampleSale(),customer:{companyName:'Changed'}}})).statusCode,409);
  for(const channel of ['retail','wholesale','event','website','other'])assert.equal((await h.record({...exampleSale(),channel})).channel,channel);
}));

test('older draft clients preserve omitted master and package fields while explicit blanks clear them',()=>harness(async h=>{
  const raw={...exampleSale(),division:'food',outlet:'farmers_market',customer:{name:'',email:'',companyName:'Synthetic company',contactName:'Test contact',phone:'555-0100',address:'Synthetic address'},
    items:[{...exampleSale().items[0],category:'food',packageLabel:'12 oz bottle'}]};
  const created=await h.create(raw);
  const oldClient={...exampleSale(),notes:'Synthetic edit from prior view',items:[{...exampleSale().items[0],category:'food',quantity:'2'}]};
  const changed=await h.action('save',created,{sale:oldClient});assert.equal(changed.statusCode,200);
  const saved=changed.body.sale;assert.equal(saved.division,'food');assert.equal(saved.outlet,'farmers_market');assert.deepEqual(saved.customer,raw.customer);
  assert.equal(saved.items[0].packageLabel,'12 oz bottle');assert.equal(saved.items[0].quantity,'2');assert.equal(saved.items[0].volumeMl,null);
  assert.equal((await h.action('save',saved,{sale:{...oldClient,items:[{...oldClient.items[0],description:'Different item'}]}})).statusCode,409);
  const reset={...oldClient,division:'',outlet:'',customer:{name:'',email:'',companyName:'',contactName:'',phone:'',address:''},
    items:[{...oldClient.items[0],packageLabel:'',purpose:'',bottleSizeMl:'',bottlesPerUnit:'',proof:''}]};
  const cleared=await h.action('save',saved,{sale:reset});assert.equal(cleared.statusCode,200);
  assert.equal(cleared.body.sale.division,'');assert.equal(cleared.body.sale.outlet,'');assert.equal(cleared.body.sale.customer.companyName,'');assert.equal(cleared.body.sale.items[0].packageLabel,'');
}));

test('stale clients cannot reattach different sizes or proof when otherwise identical item rows are reordered',()=>harness(async h=>{
  const base={...exampleSale().items[0],purpose:'bottle_sale',bottlesPerUnit:''};
  const raw={...exampleSale(),items:[{...base,quantity:'1',bottleSizeMl:'350',proof:'80',packageLabel:'Synthetic small package'},
    {...base,quantity:'2',bottleSizeMl:'750',proof:'90',packageLabel:'Synthetic large package'}]};
  const saved=await h.create(raw),before=h.stored(saved);
  const oldRows=[...raw.items].reverse().map(({purpose,bottleSizeMl,bottlesPerUnit,proof,packageLabel,...item})=>item);
  const rejected=await h.action('save',saved,{sale:{...raw,items:oldRows}});
  assert.equal(rejected.statusCode,409);assert.match(rejected.body.error,/Reload/);
  assert.deepEqual(h.stored(saved),before,'Ambiguous legacy saves preserve the complete draft and revision');
  const current=await h.action('save',saved,{sale:{...saved,items:[...saved.items].reverse()}});
  assert.equal(current.statusCode,200,'A current client sending explicit metadata can reorder the lines');
  assert.deepEqual(current.body.sale.items.map(item=>[item.quantity,item.bottleSizeMl,item.proof,item.packageLabel]),
    [['2','750','90','Synthetic large package'],['1','350','80','Synthetic small package']]);
  assert.deepEqual(current.body.sale.items.map(item=>item.bottleCount),[2,1]);
}));
