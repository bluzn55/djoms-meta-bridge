// Owner-only report preparation, review and submission history.
// Recurrence labels describe the user's plan; legal deadlines are never inferred.
import {createHash} from 'node:crypto';
import {AppError, PREFIX, id, now, env, redis, read, withLock, authorize,
  endpoint, input, only} from './core.js';

const TIMEZONE='America/Chicago';
const INDEX=PREFIX+'report-filings:index';
const FREQUENCIES=new Set(['monthly','every_two_months','twice_monthly','yearly','one_time']);
const JURISDICTIONS=new Set(['city','parish','state','federal','unassigned']);
const METHODS=new Set(['email','portal','manual','unconfigured']);
const EDITABLE=new Set(['draft','ready','approved','failed']);
const MAX_REPORTS=500;
const MAX_FIELDS=60;
const ID=/^[a-f0-9]{36}$/;
const EMAIL=/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function text(value,max,label){
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max)throw new AppError(label+' must be text, no more than '+max+' characters.');
  return value.trim();
}
function date(value,label,required=false){
  const result=text(value,10,label);
  if(!result&&!required)return '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||result<'1900-01-01'||result>'2200-12-31'||
    Number.isNaN(Date.parse(result+'T12:00:00Z'))||
    new Date(result+'T12:00:00Z').toISOString().slice(0,10)!==result)
    throw new AppError('Enter a valid '+label.toLowerCase()+'.');
  return result;
}
function email(value,label){
  const result=text(value,254,label);
  if(result&&!EMAIL.test(result))throw new AppError('Enter one valid '+label.toLowerCase()+'.');
  return result;
}
function portal(value){
  const result=text(value,2000,'Portal address');
  if(!result)return '';
  let url;
  try{url=new URL(result);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password)
    throw new AppError('Use a complete HTTPS portal address without a username or password.');
  return url.toString();
}
export function normalizeFiling(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Enter the report details.');
  const name=text(value.name,180,'Report name');
  if(!name)throw new AppError('Give this report a name.');
  const jurisdiction=text(value.jurisdiction,20,'Jurisdiction')||'unassigned';
  if(!JURISDICTIONS.has(jurisdiction))throw new AppError('Choose City, Parish, State or Federal, or leave the draft unassigned.');
  const frequency=value.frequency||'monthly';
  if(!FREQUENCIES.has(frequency))throw new AppError('Choose a report frequency.');
  const deliveryMethod=value.deliveryMethod||'unconfigured';
  if(!METHODS.has(deliveryMethod))throw new AppError('Choose email, portal, manual or not configured.');
  const periodStart=date(value.periodStart,'Period start');
  const periodEnd=date(value.periodEnd,'Period end');
  if(periodStart&&periodEnd&&periodEnd<periodStart)throw new AppError('The reporting period must end on or after its start.');
  if(value.fields!=null&&!Array.isArray(value.fields))throw new AppError('Report fields must be a list.');
  const rawFields=value.fields||[];
  if(rawFields.length>MAX_FIELDS)throw new AppError('Use no more than '+MAX_FIELDS+' fields per report.');
  const fields=rawFields.map(field=>{
    if(!field||typeof field!=='object'||Array.isArray(field))throw new AppError('Enter a valid report field.');
    const label=text(field.label,180,'Field label');
    if(!label)throw new AppError('Give each report field a label.');
    if(field.required!=null&&typeof field.required!=='boolean')throw new AppError('Choose whether the field is required.');
    return {label,value:text(field.value,8000,'Field value'),required:field.required===true};
  });
  const subject=text(value.subject,240,'Email subject');
  if(/[\r\n]/.test(subject))throw new AppError('The email subject must fit on one line.');
  return {name,jurisdiction,frequency,periodStart,periodEnd,dueDate:date(value.dueDate,'Due date'),
    recipientName:text(value.recipientName,180,'Recipient name'),deliveryMethod,
    recipientEmail:email(value.recipientEmail,'recipient email address'),portalUrl:portal(value.portalUrl),
    subject,notes:text(value.notes,16000,'Notes'),fields};
}
function requireReady(report){
  if(!JURISDICTIONS.has(report.jurisdiction)||report.jurisdiction==='unassigned')
    throw new AppError('Choose City, Parish, State or Federal before reviewing or approving this report.');
  date(report.periodStart,'Period start',true);
  date(report.periodEnd,'Period end',true);
  date(report.dueDate,'Due date',true);
  if(report.deliveryMethod==='unconfigured')throw new AppError('Choose how this report will be submitted before review.');
  if(report.deliveryMethod==='email'){
    if(!report.recipientEmail)throw new AppError('Enter the recipient email address.');
    if(!report.subject)throw new AppError('Enter the email subject.');
  }
  if(report.deliveryMethod==='portal'&&!report.portalUrl)throw new AppError('Enter the submission portal address.');
  if(report.deliveryMethod==='manual'&&!report.recipientName)throw new AppError('Enter where this report will be submitted.');
  const missing=report.fields.filter(field=>field.required&&!field.value);
  if(missing.length)throw new AppError('Complete the required field: '+missing[0].label+'.');
  if(!report.notes&&!report.fields.some(field=>field.value))throw new AppError('Enter the report information before review.');
}
function sender(){
  const from=String(env().DJOMS_EMAIL_FROM||'').trim();
  if(!from||from.length>320||/[\r\n]/.test(from))return null;
  const bracket=from.match(/^[^<>]+<([^<>]+)>$/);
  return EMAIL.test(bracket?bracket[1]:from)?from:null;
}
function deliverySettings(){
  return {emailConfigured:!!(String(env().RESEND_API_KEY||'').trim()&&sender())};
}
export function filingEmailPreview(report){
  const body=[
    'Doc Jaks report',
    'Report: '+report.name,
    'Reporting period: '+(report.periodStart||'[Not entered]')+' through '+(report.periodEnd||'[Not entered]'),
    'Due date: '+(report.dueDate||'[Not entered]'),
    'Recipient: '+(report.recipientName||report.recipientEmail||'[Not entered]'),
    '',
    ...report.fields.map(field=>field.label+': '+(field.value||'[Not entered]')),
    ...(report.notes?['','Notes:',report.notes]:[]),
  ].join('\n');
  return {from:sender(),to:report.recipientEmail||'',subject:report.subject||'',text:body};
}
function contentHash(report){
  return createHash('sha256').update(JSON.stringify(normalizeFiling(report))).digest('hex');
}
function publicReport(report){
  return {...report,jurisdiction:report.jurisdiction||'unassigned',
    emailPreview:report.approval?.emailPreview||report.reviewedEmailPreview||filingEmailPreview(report)};
}
function event(report,user,type,message,extra={}){
  report.history=[{at:now(),user,type,message,revision:report.revision+1,...extra},...(report.history||[])].slice(0,200);
}
async function persist(report,nextKey=null){
  report.updatedAt=now();
  report.revision=(report.revision||0)+1;
  const script='redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],ARGV[2],ARGV[3]); '+
    (nextKey?'redis.call("set",KEYS[3],ARGV[3]); ':'')+'return 1';
  const keys=[PREFIX+'report-filing:'+report.id,INDEX,...(nextKey?[PREFIX+nextKey]:[])];
  await redis('EVAL',script,keys.length,...keys,JSON.stringify(report),Date.now(),report.id);
  return report;
}
async function getReport(reportId){
  if(typeof reportId!=='string'||!ID.test(reportId))throw new AppError('Choose a saved report.');
  const report=await read('report-filing:'+reportId);
  if(!report)throw new AppError('This report could not be found. Refresh the page.',404);
  return report;
}
function checkRevision(report,expected){
  if(!Number.isSafeInteger(expected)||expected!==report.revision)
    throw new AppError('This report changed in another window. Reload it before continuing.',409);
}
function requireEditable(report){
  if(!EDITABLE.has(report.status))throw new AppError('Check the submission result before making changes. Use a new period for a report already submitted.',409);
}
function fresh(details,user){
  const report={...details,id:id(),revision:0,status:'draft',createdAt:now(),updatedAt:now(),
    approval:null,reviewedEmailPreview:null,receipt:null,deliveryResult:null,history:[]};
  event(report,user,'created','Created report draft');
  return report;
}
function approve(report,user){
  report.approval={approvedBy:user,approvedAt:now(),revision:report.revision+1,
    contentHash:contentHash(report),snapshot:normalizeFiling(report),
    emailPreview:report.reviewedEmailPreview||filingEmailPreview(report)};
  report.status='approved';
  event(report,user,'approved','Approved this exact report and destination',{contentHash:report.approval.contentHash});
}
function responseBody(report,extra={}){
  return {success:true,report:publicReport(report),delivery:deliverySettings(),timezone:TIMEZONE,...extra};
}
async function sendApproved(report,user){
  if(report.status!=='approved'||!report.approval||report.approval.contentHash!==contentHash(report))
    throw new AppError('The approved report changed. Review it again before sending.',409);
  if(!deliverySettings().emailConfigured)throw new AppError('Email sending is not connected. The report has not been sent.',503);
  const preview=report.approval.emailPreview;
  if(!preview||JSON.stringify(preview)!==JSON.stringify(filingEmailPreview(report)))
    throw new AppError('Email sender settings changed. Review the report again before sending.',409);
  const deliveryHash=createHash('sha256').update(JSON.stringify(preview)).digest('hex');
  const idempotencyKey='report-filing/'+report.id+'/'+deliveryHash;
  report.status='sending';
  report.deliveryResult={provider:'resend',attemptedAt:now(),idempotencyKey,
    approvalHash:report.approval.contentHash,providerId:null,sentAt:null,error:null};
  event(report,user,'sending','Started the approved email submission');
  // Persist the attempt before contacting the provider. An interrupted write or
  // uncertain provider response must never trigger a second automatic send.
  await persist(report);
  let result,data,sendError=null,uncertain=false;
  try{
    result=await fetch('https://api.resend.com/emails',{
      method:'POST',headers:{Authorization:'Bearer '+env().RESEND_API_KEY,
        'Content-Type':'application/json','Idempotency-Key':idempotencyKey},
      body:JSON.stringify({from:preview.from,to:[preview.to],subject:preview.subject,text:preview.text}),
      signal:AbortSignal.timeout(10000),
    });
    data=await result.json();
    if(!result.ok){
      uncertain=result.status>=500||result.status===408||result.status===409;
      sendError=uncertain?'The email service did not confirm the result. Check the receiving inbox or provider before recording the outcome.':
        'The email service rejected this submission. Check the delivery settings and recipient, then review the report again.';
    }else if(typeof data?.id!=='string'||!data.id.trim()||data.id.length>200){
      uncertain=true;
      sendError='The email service returned no confirmation ID. Check the receiving inbox or provider before recording the outcome.';
    }
  }catch{
    uncertain=true;
    sendError='The email result could not be confirmed. Check the receiving inbox or provider before recording the outcome. Do not send a duplicate.';
  }
  if(sendError){
    report.status=uncertain?'uncertain':'failed';
    report.deliveryResult.error=sendError;
    event(report,'DJOMS',report.status,sendError);
    await persist(report);
    return {report,error:sendError};
  }
  report.status='sent';
  report.deliveryResult.providerId=data.id;
  report.deliveryResult.sentAt=now();
  report.receipt={source:'email',reference:data.id,submittedAt:report.deliveryResult.sentAt,
    recordedAt:now(),notes:'The email provider accepted this message. This is not confirmation that a filing was accepted by the recipient.'};
  event(report,'DJOMS','sent','Email provider confirmed submission',{providerId:data.id});
  await persist(report);
  return {report};
}
function centralToday(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function receiptDate(value){
  const raw=text(value,40,'Submission date');
  if(/^\d{4}-\d{2}-\d{2}$/.test(raw)){
    date(raw,'Submission date',true);
    if(raw>centralToday())throw new AppError('Enter the actual submission date, not a future date.');
    return raw;
  }
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)||!Number.isFinite(Date.parse(raw)))
    throw new AppError('Enter the actual submission date.');
  date(raw.slice(0,10),'Submission date',true);
  if(Date.parse(raw)>Date.now())throw new AppError('Enter the actual submission date, not a future date.');
  return new Date(raw).toISOString();
}

export const reportFilingsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const ids=await redis('ZREVRANGE',INDEX,0,MAX_REPORTS);
    const selected=ids.slice(0,MAX_REPORTS);
    const values=selected.length?await redis('MGET',...selected.map(value=>PREFIX+'report-filing:'+value)):[];
    const reports=values.filter(Boolean).map(value=>publicReport(JSON.parse(value)));
    reports.sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999')||b.updatedAt.localeCompare(a.updatedAt));
    return res.json({reports,delivery:deliverySettings(),timezone:TIMEZONE,limited:ids.length>MAX_REPORTS});
  }
  const b=input(req);
  const action=b.action;
  if(action==='save'&&!b.id){
    const report=fresh(normalizeFiling(b.report),session.name);
    await persist(report);
    return res.json(responseBody(report));
  }
  if(!['save','review','approve','approveSend','recordReceipt','nextPeriod'].includes(action))
    throw new AppError('Choose a supported report action.');
  if(typeof b.id!=='string'||!ID.test(b.id))throw new AppError('Choose a saved report.');
  return withLock('report-filing:'+b.id,async()=>{
    const report=await getReport(b.id);
    checkRevision(report,b.expectedRevision);
    if(action==='save'){
      requireEditable(report);
      const details=b.report&&typeof b.report==='object'&&!Array.isArray(b.report)&&!Object.hasOwn(b.report,'jurisdiction')
        ?{...b.report,jurisdiction:report.jurisdiction}:b.report;
      Object.assign(report,normalizeFiling(details));
      report.status='draft';report.approval=null;report.reviewedEmailPreview=null;
      event(report,session.name,'saved','Saved changes; previous approval cleared');
      await persist(report);
    }else if(action==='review'){
      requireEditable(report);requireReady(report);
      report.status='ready';report.approval=null;
      report.reviewedEmailPreview=filingEmailPreview(report);
      event(report,session.name,'reviewed','Prepared this saved report for approval');
      await persist(report);
    }else if(action==='approve'||action==='approveSend'){
      if(report.status!=='ready')throw new AppError('Review this saved report before approving it.',409);
      requireReady(report);
      if(action==='approveSend'){
        if(report.deliveryMethod!=='email')throw new AppError('Automatic sending is available only for an email report.');
        if(!deliverySettings().emailConfigured)throw new AppError('Email sending is not connected. The report has not been sent.',503);
        if(!report.reviewedEmailPreview||JSON.stringify(report.reviewedEmailPreview)!==JSON.stringify(filingEmailPreview(report)))
          throw new AppError('Email sender settings changed. Review the report again before sending.',409);
      }
      approve(report,session.name);
      await persist(report);
      if(action==='approveSend'){
        const result=await sendApproved(report,session.name);
        if(result.error)return res.status(502).json(responseBody(report,{success:false,error:result.error}));
      }
    }else if(action==='recordReceipt'){
      const abandonedSend=report.status==='sending'&&Date.now()-Date.parse(report.deliveryResult?.attemptedAt||'')>180000;
      if(!['ready','approved','sent','failed','uncertain'].includes(report.status)&&!abandonedSend)
        throw new AppError('Review the report or check its submission result before recording a receipt.',409);
      const receipt=b.receipt;
      if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new AppError('Enter the submission receipt.');
      const reference=text(receipt.reference,300,'Confirmation number or reference');
      if(!reference)throw new AppError('Enter the confirmation number or receipt reference.');
      report.receipt={source:'owner',reference,submittedAt:receiptDate(receipt.submittedAt),
        notes:text(receipt.notes,4000,'Receipt notes'),recordedAt:now(),recordedBy:session.name};
      report.status='filed';
      event(report,session.name,'receipt','Recorded submission confirmation',{reference});
      await persist(report);
    }else if(action==='nextPeriod'){
      const dates=b.report||{};
      const periodStart=date(dates.periodStart,'Next period start',true);
      const periodEnd=date(dates.periodEnd,'Next period end',true);
      const dueDate=date(dates.dueDate,'Next due date',true);
      if(periodEnd<periodStart)throw new AppError('The next reporting period must end on or after its start.');
      if(report.periodEnd&&periodStart<=report.periodEnd)throw new AppError('The next period must start after the current period ends.');
      // These are explicitly entered dates, not an inferred legal deadline.
      const nextKey='report-filing-next:'+report.id+':'+periodStart+':'+periodEnd+':'+dueDate;
      const existing=await redis('GET',PREFIX+nextKey);
      if(existing)return res.json(responseBody(await getReport(existing)));
      const next=fresh(normalizeFiling({...report,periodStart,periodEnd,dueDate,notes:'',
        subject:'',fields:report.fields.map(field=>({...field,value:''}))}),session.name);
      next.previousReportId=report.id;
      event(next,session.name,'period','Created a new period with user-entered dates; values cleared');
      await persist(next,nextKey);
      return res.json(responseBody(next));
    }
    return res.json(responseBody(report));
  });
});
