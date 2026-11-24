import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEndpoint,PREFIX} from '../lib/core.js';
import {reportFilingsEndpoint,normalizeFiling} from '../lib/report-filings.js';
import {reportTemplates,normalizeTemplateData} from '../lib/report-template-engine.js';

const ORIGIN='https://command.example.test';
const PASSWORD='this-is-only-a-test-password';
const ENV_KEYS=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL','KV_REST_API_TOKEN','DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD',
  'DJOMS_OWNER_NAME','RESEND_API_KEY','DJOMS_EMAIL_FROM'];
const validReport=()=>({name:'Example monthly report',businessId:'conestoga',jurisdiction:'state',frequency:'monthly',
  periodStart:'2026-01-01',periodEnd:'2026-01-31',dueDate:'2026-02-15',
  recipientName:'Example receiving office',deliveryMethod:'email',recipientEmail:'reports@example.test',
  portalUrl:'',subject:'Example report — January 2026',notes:'Owner-entered information.',
  fields:[{label:'Units',value:'0',required:true},{label:'Optional notes',value:'',required:false}]});
function response(){return {statusCode:200,headers:{},body:null,
  setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(n){this.statusCode=n;return this;},
  json(value){this.body=value;return this;}};}

async function harness(run){
  const saved=Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]]));
  const previousFetch=globalThis.fetch;
  const storage=new Map(),sets=new Map(),providerCalls=[];
  let mode='success',failFinalSave=false;
  try{
    Object.assign(process.env,{PUBLIC_BASE_URL:ORIGIN,
      UPSTASH_REDIS_REST_URL:'https://redis.example.test',UPSTASH_REDIS_REST_TOKEN:'synthetic-redis-token',
      DJOMS_SESSION_SECRET:'test-only-secret-of-at-least-32-characters',DJOMS_ADMIN_PASSWORD:PASSWORD,
      DJOMS_OWNER_NAME:'Test Owner',RESEND_API_KEY:'synthetic-email-token',
      DJOMS_EMAIL_FROM:'Test Reports <reports@example.test>'});
    delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;
    globalThis.fetch=async(url,options)=>{
      if(url==='https://api.resend.com/emails'){
        providerCalls.push({body:JSON.parse(options.body),headers:options.headers});
        if(mode==='timeout')throw new Error('Synthetic timeout');
        if(mode==='success')return {ok:true,status:200,json:async()=>({id:'email-test-123'})};
        if(mode==='no-id')return {ok:true,status:200,json:async()=>({})};
        const status=Number(mode);
        return {ok:false,status,json:async()=>({message:'Synthetic provider response'})};
      }
      assert.equal(url,'https://redis.example.test','No live external requests are permitted in these tests');
      const [command,...args]=JSON.parse(options.body);
      let result;
      if(command==='GET')result=storage.get(args[0])??null;
      else if(command==='MGET')result=args.map(k=>storage.get(k)??null);
      else if(command==='SET'){
        const [key,value,...flags]=args;
        if(flags.includes('NX')&&storage.has(key))result=null;
        else{storage.set(key,value);result='OK';}
      }else if(command==='DEL')result=args.reduce((count,key)=>count+(storage.delete(key)?1:0),0);
      else if(command==='ZREVRANGE'){
        const [key,start,end]=args;
        result=[...(sets.get(key)||new Map())].sort((a,b)=>b[1]-a[1]).map(([id])=>id)
          .slice(Number(start),Number(end)+1);
      }else if(command==='EVAL'){
        const [script,count,...rest]=args;
        const keys=rest.slice(0,count),values=rest.slice(count);
        if(script.includes('redis.call("zadd"')){
          const [json,score,id]=values;
          const record=JSON.parse(json);
          if(failFinalSave&&record.status==='sent')return {ok:false,json:async()=>({error:'Synthetic storage failure'})};
          storage.set(keys[0],json);
          const index=sets.get(keys[1])||new Map();
          if(!script.includes('"NX"')||!index.has(id))index.set(id,Number(score));
          sets.set(keys[1],index);
          if(count===3)storage.set(keys[2],id);
          result=1;
        }else if(script.includes('redis.call("del",KEYS[1])')){
          result=storage.get(keys[0])===values[0]?(storage.delete(keys[0])?1:0):0;
        }else result=1; // First allowed sign-in attempt.
      }else throw new Error('Unexpected Redis command '+command);
      return {ok:true,status:200,json:async()=>({result})};
    };
    const signed=response();
    await sessionEndpoint({method:'POST',query:{},headers:{origin:ORIGIN,'content-type':'application/json'},
      body:{password:PASSWORD}},signed);
    assert.equal(signed.statusCode,200);
    const cookie=signed.headers['set-cookie'].split(';')[0],csrf=signed.body.csrf;
    const request=async(body={},options={})=>{
      const res=response();
      const headers={origin:ORIGIN,'content-type':'application/json',cookie,'x-djoms-csrf':csrf,...options.headers};
      if(options.anonymous)delete headers.cookie;
      await reportFilingsEndpoint({method:options.method||'POST',query:{action:'report-filings',...options.query},body,headers},res);
      return res;
    };
    const create=async(details=validReport())=>{
      const res=await request({action:'save',report:details});
      assert.equal(res.statusCode,200,res.body?.error);return res.body.report;
    };
    const action=async(kind,report,extra={})=>request({action:kind,id:report.id,expectedRevision:report.revision,...extra});
    const ready=async(details=validReport())=>{
      const res=await action('review',await create(details));
      assert.equal(res.statusCode,200,res.body?.error);return res.body.report;
    };
    await run({request,create,action,ready,storage,sets,providerCalls,setMode:value=>{mode=value;},
      failFinalSave:()=>{failFinalSave=true;}});
  }finally{
    globalThis.fetch=previousFetch;
    for(const [key,value] of Object.entries(saved)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
}

test('private report data requires owner session and writes require CSRF and origin',()=>harness(async h=>{
  assert.equal((await h.request({}, {method:'GET',anonymous:true})).statusCode,401);
  assert.equal((await h.request({action:'save',report:validReport()}, {headers:{'x-djoms-csrf':'incorrect'}})).statusCode,403);
  assert.equal((await h.request({action:'save',report:validReport()}, {headers:{origin:'https://other.example.test'}})).statusCode,403);
  const list=await h.request({}, {method:'GET'});
  assert.deepEqual(list.body.reports,[]);
  assert.deepEqual(h.providerCalls,[]);
}));

test('template and business registry reads create no reports or profiles',()=>harness(async h=>{
  const before=[...h.storage.entries()];
  const result=await h.request({}, {method:'GET'});
  assert.deepEqual(result.body.reports,[]);
  assert.deepEqual(result.body.templates.map(template=>template.id),['ttb_excise','ttb_production','ttb_storage','ttb_processing']);
  assert.deepEqual(result.body.businessProfiles.map(profile=>profile.id),['conestoga','doc_jaks']);
  assert.ok(result.body.businessProfiles.every(profile=>profile.revision===0&&Object.values(profile.values).every(value=>value==='')));
  assert.deepEqual([...h.storage.entries()],before,'Reading the registry never seeds data');
}));

test('form values use exact arithmetic, never turn blanks into zero, and cannot forge totals or signatures',()=>{
  const template=reportTemplates.find(template=>template.id==='ttb_excise');
  const values=Object.fromEntries(template.fields.filter(field=>field.type==='money'&&!field.calculation).map(field=>[field.id,'0']));
  values.tax_distilled_spirits='100.10';values.tax_wine='0.20';values.amount_payment='100.30';
  values.total_tax_liability='999.99';
  const exact=normalizeTemplateData(template.id,values);
  assert.equal(exact.values.total_tax_liability,'100.30');assert.equal(exact.values.amount_to_pay,'100.30');
  assert.equal(exact.checks.find(check=>check.id==='payment_matches_return').status,'pass');
  delete values.tax_beer;
  const missing=normalizeTemplateData(template.id,values);
  assert.equal(missing.values.total_tax_liability,'');assert.equal(missing.values.amount_to_pay,'');
  assert.equal(missing.checks.find(check=>check.id==='payment_matches_return').status,'pending');
  assert.throws(()=>normalizeTemplateData(template.id,{unknown_field:'1'}),/unknown form field/);
  assert.throws(()=>normalizeTemplateData(template.id,{signature:'A typed signature'}),/completed manually/);
  assert.throws(()=>normalizeTemplateData(template.id,{tax_distilled_spirits:'1.234'}),/at most 2 decimal/);
  const integerField=reportTemplates.flatMap(template=>template.fields.map(field=>({template,field}))).find(item=>item.field.integer&&!item.field.calculation);
  assert.ok(integerField,'At least one provided form requires whole-gallon inputs');
  assert.throws(()=>normalizeTemplateData(integerField.template.id,{[integerField.field.id]:'1.5'}),/whole number/);
});

test('template reports bind business and data; unresolved business or schedule cannot be approved',()=>harness(async h=>{
  const details={...validReport(),jurisdiction:'federal',templateId:'ttb_excise',frequency:'unspecified',
    templateValues:{tax_distilled_spirits:'12.30'},targetDate:'2026-02-10'};
  let report=await h.create(details);
  assert.equal(report.templateValues.tax_distilled_spirits,'12.30');
  assert.equal((await h.action('review',report)).statusCode,400,'Excise cadence requires confirmation');
  const legacyEdit=validReport();delete legacyEdit.businessId;delete legacyEdit.jurisdiction;
  report=(await h.action('save',report,{report:legacyEdit})).body.report;
  assert.equal(report.businessId,'conestoga');assert.equal(report.templateId,'ttb_excise');
  assert.equal(report.templateValues.tax_distilled_spirits,'12.30');assert.equal(report.targetDate,'2026-02-10');
  assert.equal((await h.action('save',report,{report:{...details,businessId:'doc_jaks'}})).statusCode,409);
  const unassigned=validReport();delete unassigned.businessId;
  const unassignedReport=await h.create(unassigned);
  assert.equal(unassignedReport.businessId,'unassigned');
  assert.match(unassignedReport.emailPreview.text,/^Report submission\n/);
  assert.equal((await h.action('review',unassignedReport)).statusCode,400);
  assert.throws(()=>normalizeFiling({...details,jurisdiction:'state'}),/Federal/);
  assert.throws(()=>normalizeFiling({...details,templateId:'unknown'}),/supported report form/);
}));

test('operations dates follow the selected full month; excise dates remain explicit',()=>{
  const template=reportTemplates.find(template=>template.id==='ttb_production');
  const report=normalizeFiling({...validReport(),jurisdiction:'federal',templateId:template.id,templateValues:{},
    periodStart:'2026-12-01',periodEnd:'2026-12-31',dueDate:'',targetDate:''});
  assert.equal(report.targetDate,'2027-01-05');assert.equal(report.dueDate,'2027-01-15');
  assert.equal(report.frequency,'monthly');
  const monthField=template.fields.find(field=>field.periodKey==='monthYear');
  if(monthField){
    assert.equal(report.templateValues[monthField.id],'December 2026');
    const cleared=normalizeFiling({...report,periodStart:'',periodEnd:''});
    assert.equal(cleared.templateValues[monthField.id],'','Clearing the period clears stale derived month text');
    const incomplete=normalizeFiling({...report,periodEnd:''});
    assert.equal(incomplete.templateValues[monthField.id],'','An incomplete period cannot retain a stale month');
  }
  assert.throws(()=>normalizeFiling({...report,periodStart:'2026-12-15'}),/complete calendar month/);
  const excise=normalizeFiling({...validReport(),jurisdiction:'federal',templateId:'ttb_excise',templateValues:{},
    frequency:'unspecified',dueDate:'',targetDate:''});
  assert.equal(excise.dueDate,'');assert.equal(excise.targetDate,'');assert.equal(excise.frequency,'unspecified');
});

test('private business profiles use revision guards and only prefill their own new drafts',()=>harness(async h=>{
  const profile={legalName:'Example Conestoga Legal Name',displayName:'Example Conestoga',
    address:'123 Example Lane\nExample City, CO 00000',ein:'12-3456789',plantNumber:'DSP-EX-00001'};
  const save=await h.request({action:'saveBusinessProfile',businessId:'conestoga',expectedRevision:0,profile});
  assert.equal(save.statusCode,200);assert.equal(save.body.businessProfile.revision,1);
  assert.equal((await h.request({action:'saveBusinessProfile',businessId:'conestoga',expectedRevision:0,profile})).statusCode,409);
  const list=await h.request({}, {method:'GET'});
  assert.equal(list.body.businessProfiles.find(item=>item.id==='conestoga').values.ein,profile.ein);
  assert.equal(list.body.businessProfiles.find(item=>item.id==='doc_jaks').values.ein,'');
  const details={...validReport(),jurisdiction:'federal',templateId:'ttb_excise',frequency:'unspecified',templateValues:{tax_distilled_spirits:'10'}};
  const report=await h.create(details);
  assert.equal(report.templateValues.employer_identification_number,profile.ein);
  assert.match(report.templateValues.taxpayer_name_address,/Example Conestoga Legal Name/);
  const separate=await h.create({...details,businessId:'doc_jaks'});
  assert.equal(separate.templateValues.employer_identification_number,'');
  assert.equal(separate.templateValues.taxpayer_name_address,'');
  const next=await h.action('nextPeriod',report,{report:{periodStart:'2026-02-01',periodEnd:'2026-02-28',dueDate:'2026-03-15'}});
  assert.equal(next.statusCode,200,next.body?.error);
  assert.equal(next.body.report.businessId,'conestoga');assert.equal(next.body.report.templateId,'ttb_excise');
  assert.equal(next.body.report.templateValues.tax_distilled_spirits,'');
  assert.equal(next.body.report.templateValues.employer_identification_number,profile.ein);
  assert.equal(next.body.report.templateValues.signature,'');assert.equal(next.body.report.amountDue,'');
  assert.equal(h.providerCalls.length,0);
}));

test('report history paginates beyond 500 records and rejects malformed cursors',()=>harness(async h=>{
  const index=new Map();
  for(let i=0;i<501;i++){
    const id=(i+1).toString(16).padStart(36,'0');
    const report={...validReport(),id,revision:1,status:'filed',history:i>=451?[{message:'x'.repeat(95000)}]:[],
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
    index.set(id,i);h.storage.set(PREFIX+'report-filing:'+id,JSON.stringify(report));
  }
  h.sets.set(PREFIX+'report-filings:index',index);
  const first=await h.request({}, {method:'GET'});
  assert.equal(first.statusCode,200);assert.ok(first.body.reports.length>0&&first.body.reports.length<50,'Large history entries respect the response byte budget');
  assert.ok(Buffer.byteLength(JSON.stringify(first.body),'utf8')<=3*1024*1024);
  const all=[...first.body.reports];
  let page=first;
  while(page.body.nextCursor!==null){
    assert.equal(page.body.limited,true);
    page=await h.request({}, {method:'GET',query:{cursor:page.body.nextCursor}});
    assert.equal(page.statusCode,200);assert.ok(page.body.reports.length<=50);
    assert.ok(Buffer.byteLength(JSON.stringify(page.body),'utf8')<=3*1024*1024);
    all.push(...page.body.reports);
  }
  assert.equal(page.body.limited,false);
  assert.ok(all.some(report=>report.id==='1'.padStart(36,'0')),'The oldest report remains accessible');
  assert.equal(new Set(all.map(report=>report.id)).size,501);
  for(const cursor of ['-1','1.5','1e2','00','',String(Number.MAX_SAFE_INTEGER),['0','500']])
    assert.equal((await h.request({}, {method:'GET',query:{cursor}})).statusCode,400);
  assert.equal(h.providerCalls.length,0);
}));

test('editing an unread report between history pages cannot move it ahead of the cursor',()=>harness(async h=>{
  const index=new Map();
  for(let i=0;i<81;i++){
    const id=(i+1).toString(16).padStart(36,'0');
    const report={...validReport(),id,revision:1,status:'draft',history:[],
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
    index.set(id,i);h.storage.set(PREFIX+'report-filing:'+id,JSON.stringify(report));
  }
  h.sets.set(PREFIX+'report-filings:index',index);
  const first=await h.request({}, {method:'GET'});
  assert.equal(first.body.reports.length,50);assert.equal(first.body.nextCursor,'50');
  const unreadId='1'.padStart(36,'0');
  assert.ok(!first.body.reports.some(report=>report.id===unreadId));
  const unread=JSON.parse(h.storage.get(PREFIX+'report-filing:'+unreadId));
  const saved=await h.action('save',unread,{report:{...validReport(),name:'Edited in another window'}});
  assert.equal(saved.statusCode,200,saved.body?.error);
  assert.equal(index.get(unreadId),0,'Updates preserve the original index score');
  const rest=await h.request({}, {method:'GET',query:{cursor:first.body.nextCursor}});
  assert.equal(rest.body.nextCursor,null);assert.equal(rest.body.limited,false);
  assert.equal(rest.body.reports.find(report=>report.id===unreadId)?.name,'Edited in another window');
  assert.equal(new Set([...first.body.reports,...rest.body.reports].map(report=>report.id)).size,81);
}));

test('draft approval is refused; exact revision is required and edits clear approval',()=>harness(async h=>{
  let report=await h.create();
  assert.equal((await h.action('approve',report)).statusCode,409);
  const stale=report;
  report=(await h.action('review',report)).body.report;
  assert.equal((await h.action('save',stale,{report:validReport()})).statusCode,409);
  report=(await h.action('approve',report)).body.report;
  assert.equal(report.status,'approved');
  assert.equal(report.approval.revision,report.revision);
  assert.equal(report.approval.snapshot.recipientEmail,'reports@example.test');
  assert.equal(report.approval.snapshot.jurisdiction,'state');
  assert.equal(h.providerCalls.length,0,'Approval alone never sends');
  report=(await h.action('save',report,{report:{...validReport(),fields:[{label:'Units',value:'8',required:true}]}})).body.report;
  assert.equal(report.status,'draft');assert.equal(report.approval,null);assert.equal(report.reviewedEmailPreview,null);
  assert.equal((await h.action('approveSend',report)).statusCode,409);
  assert.equal(h.providerCalls.length,0);
}));

test('missing required values remain missing and incomplete reports cannot become ready',()=>harness(async h=>{
  const report=await h.create({...validReport(),fields:[{label:'Units',value:'',required:true}]});
  assert.equal(report.fields[0].value,'');
  assert.match(report.emailPreview.text,/Units: \[Not entered\]/);
  assert.equal((await h.action('review',report)).statusCode,400);
  assert.throws(()=>normalizeFiling({...validReport(),periodEnd:'2026-02-30'}),/valid period end/);
  assert.throws(()=>normalizeFiling({...validReport(),recipientEmail:'one@example.test,two@example.test'}),/one valid/);
}));

test('jurisdiction stays unassigned for legacy reports and is required before review',()=>harness(async h=>{
  const legacy=validReport();delete legacy.jurisdiction;
  const normalized=normalizeFiling(legacy);
  assert.equal(normalized.jurisdiction,'unassigned');
  assert.deepEqual(normalized.fields,legacy.fields,'Adding classification preserves entered report values');
  assert.equal(normalizeFiling({...legacy,jurisdiction:''}).jurisdiction,'unassigned');
  assert.throws(()=>normalizeFiling({...legacy,jurisdiction:'county'}),/Choose City, Parish, State or Federal/);
  const report=await h.create(legacy);
  assert.equal(report.jurisdiction,'unassigned');
  assert.equal((await h.action('review',report)).statusCode,400);
  const storedKey=PREFIX+'report-filing:'+report.id;
  const stored=JSON.parse(h.storage.get(storedKey));delete stored.jurisdiction;
  h.storage.set(storedKey,JSON.stringify(stored));
  const listing=await h.request({}, {method:'GET'});
  assert.equal(listing.body.reports[0].jurisdiction,'unassigned');
  assert.equal(Object.hasOwn(JSON.parse(h.storage.get(storedKey)),'jurisdiction'),false,'Reading legacy records does not migrate them');
  let selected=await h.create(validReport());
  selected=(await h.action('save',selected,{report:legacy})).body.report;
  assert.equal(selected.jurisdiction,'state','An older open page omitting classification preserves the existing selection');
  selected=(await h.action('save',selected,{report:{...legacy,jurisdiction:''}})).body.report;
  assert.equal(selected.jurisdiction,'unassigned','An explicit empty selection still resets the draft classification');
}));

test('amount due preserves blank versus zero, validates exact cents and protects approval',()=>harness(async h=>{
  const normalize=value=>normalizeFiling({...validReport(),amountDue:value}).amountDue;
  assert.equal(normalize(undefined),'');assert.equal(normalize(''),'');
  assert.equal(normalize('0'),'0.00');assert.equal(normalize('123'),'123.00');
  assert.equal(normalize('123.4'),'123.40');assert.equal(normalize('123.45'),'123.45');
  assert.equal(normalize('999999999.99'),'999999999.99');
  for(const value of ['-1','1e3','1,000.00','$1.00','1.234','1000000000','NaN','Infinity'])
    assert.throws(()=>normalize(value),/Enter an amount/);
  const blank=await h.create();
  assert.equal(blank.amountDue,'');assert.doesNotMatch(blank.emailPreview.text,/Amount due:/);
  const storedKey=PREFIX+'report-filing:'+blank.id;
  const stored=JSON.parse(h.storage.get(storedKey));delete stored.amountDue;
  h.storage.set(storedKey,JSON.stringify(stored));
  assert.equal((await h.request({}, {method:'GET'})).body.reports[0].amountDue,'');
  assert.equal(Object.hasOwn(JSON.parse(h.storage.get(storedKey)),'amountDue'),false);
  const zero=await h.create({...validReport(),amountDue:'0'});
  assert.match(zero.emailPreview.text,/Amount due: \$0\.00/);
  let report=(await h.action('approve',await h.ready({...validReport(),amountDue:'123.45'}))).body.report;
  const approvedHash=report.approval.contentHash;
  assert.equal(report.approval.snapshot.amountDue,'123.45');
  assert.match(report.emailPreview.text,/Amount due: \$123\.45/);
  report=(await h.action('save',report,{report:validReport()})).body.report;
  assert.equal(report.amountDue,'123.45','An older page omitting amount due preserves the saved amount');
  report=(await h.action('save',report,{report:{...validReport(),amountDue:'123.46'}})).body.report;
  assert.equal(report.status,'draft');assert.equal(report.approval,null);
  report=(await h.action('review',report)).body.report;
  report=(await h.action('approve',report)).body.report;
  assert.notEqual(report.approval.contentHash,approvedHash,'The approval hash binds the exact amount');
  report=(await h.action('save',report,{report:{...validReport(),amountDue:''}})).body.report;
  assert.equal(report.amountDue,'');assert.doesNotMatch(report.emailPreview.text,/Amount due:/);
  assert.equal(h.providerCalls.length,0);
}));

test('Approve and send transmits exactly the reviewed preview once and keeps provider receipt',()=>harness(async h=>{
  const report=await h.ready();
  const preview=report.emailPreview;
  assert.match(preview.text,/^Colo Distillery LLC report\n/);
  const sent=await h.action('approveSend',report);
  assert.equal(sent.statusCode,200,sent.body?.error);
  assert.equal(sent.body.report.status,'sent');
  assert.equal(sent.body.report.receipt.reference,'email-test-123');
  assert.equal(h.providerCalls.length,1);
  assert.deepEqual(h.providerCalls[0].body,{from:preview.from,to:[preview.to],subject:preview.subject,text:preview.text});
  assert.match(h.providerCalls[0].headers['Idempotency-Key'],/^report-filing\/[a-f0-9]{36}\/[a-f0-9]{64}$/);
  assert.equal((await h.action('approveSend',report)).statusCode,409,'Duplicate old click is rejected');
  assert.equal((await h.action('approveSend',sent.body.report)).statusCode,409,'Sent version cannot be sent again');
  assert.equal((await h.action('save',sent.body.report,{report:validReport()})).statusCode,409);
  await h.request({}, {method:'GET'});
  assert.equal(h.providerCalls.length,1,'GET cannot send');
}));

test('a sender change after review requires another review; missing email setup never sends',()=>harness(async h=>{
  let report=await h.ready();
  process.env.DJOMS_EMAIL_FROM='Changed Sender <changed@example.test>';
  assert.equal((await h.action('approveSend',report)).statusCode,409);
  assert.equal(h.providerCalls.length,0);
  report=(await h.action('review',report)).body.report;
  assert.match(report.emailPreview.from,/Changed Sender/);
  delete process.env.RESEND_API_KEY;
  assert.equal((await h.action('approveSend',report)).statusCode,503);
  assert.equal(h.providerCalls.length,0);
}));

test('uncertain sends and idempotency conflicts fail closed without replay',async t=>{
  for(const outcome of ['timeout','no-id','408','409','500'])await t.test(outcome,()=>harness(async h=>{
    h.setMode(outcome);
    const report=await h.ready();
    const failed=await h.action('approveSend',report);
    assert.equal(failed.statusCode,502);
    assert.equal(failed.body.success,false);
    assert.equal(failed.body.report.status,'uncertain');
    assert.equal(failed.body.report.receipt,null);
    assert.equal((await h.action('approveSend',failed.body.report)).statusCode,409);
    assert.equal((await h.action('save',failed.body.report,{report:validReport()})).statusCode,409);
    assert.equal(h.providerCalls.length,1);
  }));
});

test('a provider rejection is saved as failed and requires a fresh review',()=>harness(async h=>{
  h.setMode('422');
  const failed=await h.action('approveSend',await h.ready());
  assert.equal(failed.statusCode,502);assert.equal(failed.body.report.status,'failed');
  assert.equal((await h.action('approveSend',failed.body.report)).statusCode,409);
  assert.equal(h.providerCalls.length,1);
}));

test('lost final persistence after provider acceptance cannot replay the send',()=>harness(async h=>{
  h.failFinalSave();
  const attempt=await h.action('approveSend',await h.ready());
  assert.equal(attempt.statusCode,503);
  const saved=(await h.request({}, {method:'GET'})).body.reports[0];
  assert.equal(saved.status,'sending');
  assert.equal((await h.action('approveSend',saved)).statusCode,409);
  assert.equal(h.providerCalls.length,1);
}));

test('next period requires entered dates, clears values and never carries approval or duplicate periods',()=>harness(async h=>{
  const report=(await h.action('approve',await h.ready({...validReport(),amountDue:'250.50'}))).body.report;
  assert.equal((await h.action('nextPeriod',report)).statusCode,400);
  const dates={periodStart:'2026-02-01',periodEnd:'2026-02-28',dueDate:'2026-03-18'};
  const first=await h.action('nextPeriod',report,{report:dates});
  assert.equal(first.statusCode,200,first.body?.error);
  const next=first.body.report;
  assert.equal(next.status,'draft');assert.equal(next.approval,null);assert.equal(next.receipt,null);
  assert.equal(next.notes,'');assert.equal(next.subject,'');assert.equal(next.dueDate,dates.dueDate);
  assert.equal(next.fields[0].value,'');assert.equal(next.fields[0].required,true);
  assert.equal(next.previousReportId,report.id);
  assert.equal(next.jurisdiction,report.jurisdiction);
  assert.equal(next.amountDue,'','A new period never carries forward the prior amount due');
  const duplicate=await h.action('nextPeriod',report,{report:dates});
  assert.equal(duplicate.body.report.id,next.id);
  assert.equal((await h.request({}, {method:'GET'})).body.reports.length,2);
  assert.equal(h.providerCalls.length,0);
}));

test('manual receipt records actual date and reference without sending email',()=>harness(async h=>{
  const report=await h.ready({...validReport(),deliveryMethod:'portal',portalUrl:'https://portal.example.test/filing'});
  assert.equal((await h.action('recordReceipt',report,{receipt:{reference:'',submittedAt:'2026-02-15'}})).statusCode,400);
  assert.equal((await h.action('recordReceipt',report,{receipt:{reference:'Example-confirmation',submittedAt:'2199-01-01'}})).statusCode,400);
  assert.equal((await h.action('recordReceipt',report,{receipt:{reference:'Example-confirmation',submittedAt:'2026-02-15T09:00'}})).statusCode,400);
  const filed=await h.action('recordReceipt',report,{receipt:{reference:'Example-confirmation',submittedAt:'2026-02-15',notes:'Owner confirmed in portal.'}});
  assert.equal(filed.statusCode,200,filed.body?.error);assert.equal(filed.body.report.status,'filed');
  assert.equal(filed.body.report.receipt.recordedBy,'Test Owner');
  assert.equal(filed.body.report.receipt.submittedAt,'2026-02-15');
  assert.equal(h.providerCalls.length,0);
  assert.equal((await h.action('save',filed.body.report,{report:validReport()})).statusCode,409);
}));
