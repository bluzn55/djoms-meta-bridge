// Owner-entered daily activity. Tips stay separate from sales and payments.
// No imports, report submissions, stock movements, or payment operations occur here.
import {createHash} from 'node:crypto';
import {AppError,PREFIX,authorize,endpoint,input,now,only,read,redis,withLock} from './core.js';
import {salesBusinesses} from './sales.js';

const TIMEZONE='America/Chicago';
const MAX_HISTORY=200;
const REQUEST_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const dayKey=(businessId,date)=>'sales-day:'+businessId+':'+date;
const summaryKey=(businessId,date)=>'sales-day-summary:'+businessId+':'+date;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function text(value,max,label){
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max)throw new AppError(label+' must be text, no more than '+max+' characters.');
  return value.trim();
}
function business(value){
  if(!salesBusinesses.some(item=>item.id===value))throw new AppError('Choose Colo Distillery LLC or Doc Jak\'s.');
  return value;
}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2200-12-31'||
    !Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)
    throw new AppError('Choose a real calendar date for the daily entry.');
  return value;
}
function monthDates(value){
  if(typeof value!=='string'||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)||value<'1900-01'||value>'2200-12')
    throw new AppError('Choose a calendar month in YYYY-MM format.');
  const [year,month]=value.split('-').map(Number),length=new Date(Date.UTC(year,month,0)).getUTCDate();
  return Array.from({length},(_,index)=>value+'-'+String(index+1).padStart(2,'0'));
}
function centralToday(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date()).map(part=>[part.type,part.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function count(value,label){
  const raw=text(value,12,label);
  if(!raw)return '';
  if(!/^\d+$/.test(raw)||BigInt(raw)>1000000n)throw new AppError(label+' must be a whole number from 0 to 1000000, or blank if unknown.');
  return BigInt(raw).toString();
}
function tips(value){
  const raw=text(value,20,'Tips amount');
  if(!raw)return {tipsAmount:'',tipsCents:null};
  if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw))
    throw new AppError('Tips must be an amount from 0 to 999999999.99, with at most two decimal places and no currency symbols or commas.');
  const [whole,fraction='']=raw.split('.'),cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return {tipsAmount:(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0'),tipsCents:Number(cents)};
}
export function normalizeSalesDay(value,businessId){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Enter the daily activity details.');
  business(businessId);
  if(value.businessId!=null&&value.businessId!==businessId)throw new AppError('A daily entry cannot be moved to another business.',409);
  const selected=date(value.date);
  if(value.id!=null&&value.id!==selected)throw new AppError('A saved daily entry cannot be moved to another date.',409);
  if(selected>centralToday())throw new AppError('The daily entry date cannot be in the future (Central time).');
  return {id:selected,businessId,date:selected,visitors:count(value.visitors,'Visitors'),tastings:count(value.tastings,'Tastings'),
    cocktails:count(value.cocktails,'Cocktails'),...tips(value.tipsAmount),notes:text(value.notes,2000,'Daily notes')};
}
function metrics(day){
  return {visitors:day.visitors,tastings:day.tastings,cocktails:day.cocktails,tipsAmount:day.tipsAmount,tipsCents:day.tipsCents,notes:day.notes};
}
function summary(day){
  return {id:day.id,businessId:day.businessId,date:day.date,revision:day.revision,...metrics(day),
    createdAt:day.createdAt,updatedAt:day.updatedAt,createdBy:day.createdBy,updatedBy:day.updatedBy,historyCount:day.history.length};
}
function checkStored(value,businessId,selected,full=true){
  if(!value||typeof value!=='object'||value.businessId!==businessId||value.date!==selected||value.id!==selected||
    !Number.isSafeInteger(value.revision)||value.revision<1||
    (full?(!Array.isArray(value.history)||value.history.length>MAX_HISTORY):(!Number.isInteger(value.historyCount)||value.historyCount<1||value.historyCount>MAX_HISTORY)))
    throw new AppError('A daily entry is inconsistent. Its data has not been changed; reload after the saved entry is checked.',503);
  return value;
}
async function getDay(businessId,selected){
  const saved=await read(dayKey(businessId,selected));
  return saved?checkStored(saved,businessId,selected):null;
}
function conflict(){throw new AppError('That daily request ID was already used with different details. Retry the original request or use a new ID for a new edit.',409);}
async function replay(previous,hash,businessId,selected){
  if(previous.hash!==hash||previous.date!==selected)conflict();
  const saved=await getDay(businessId,selected);
  if(!saved)throw new AppError('The saved result for this daily request is unavailable. No new entry was created.',503);
  return saved;
}
async function saveDay(details,expectedRevision,token,user){
  const {businessId,date:selected}=details,hash=digest(details),requestKey='sales-day-request:'+businessId+':'+token;
  return withLock(dayKey(businessId,selected),async()=>{
    const priorRequest=await read(requestKey);
    if(priorRequest)return replay(priorRequest,hash,businessId,selected);
    const previous=await getDay(businessId,selected),revision=previous?.revision||0;
    if(revision!==expectedRevision)throw new AppError('This daily entry changed in another window. Reload the day before saving.',409);
    if((previous?.history.length||0)>=MAX_HISTORY)
      throw new AppError('This day\'s audit history is full. No change was saved; all existing history is preserved.');
    const at=now(),nextRevision=revision+1;
    const event={at,type:previous?'updated':'created',user,requestId:token,revision:nextRevision,
      before:previous?metrics(previous):null,after:metrics(details)};
    const day={...details,revision:nextRevision,createdAt:previous?.createdAt||at,updatedAt:at,
      createdBy:previous?.createdBy||user,updatedBy:user,history:[event,...(previous?.history||[])]};
    const script=[
      'local request=redis.call("get",KEYS[3])',
      'if request then local p=cjson.decode(request); if p.hash~=ARGV[4] then return "!conflict" end; return "!replay" end',
      'local previous=redis.call("get",KEYS[1]); local revision=0',
      'if previous then local p=cjson.decode(previous); revision=p.revision end',
      'if revision~=tonumber(ARGV[5]) then return "!revision" end',
      'redis.call("set",KEYS[1],ARGV[1])',
      'redis.call("set",KEYS[2],ARGV[2])',
      'redis.call("set",KEYS[3],ARGV[3])',
      'return "!saved"',
    ].join('\n');
    const result=await redis('EVAL',script,3,PREFIX+dayKey(businessId,selected),PREFIX+summaryKey(businessId,selected),PREFIX+requestKey,
      JSON.stringify(day),JSON.stringify(summary(day)),JSON.stringify({hash,date:selected,revision:nextRevision}),hash,String(expectedRevision));
    if(result==='!conflict')conflict();
    if(result==='!revision')throw new AppError('This daily entry changed while it was being saved. Reload the day before saving.',409);
    if(result==='!replay'){
      const savedRequest=await read(requestKey);
      if(!savedRequest)throw new AppError('The previous daily save could not be confirmed. Retry the same request.',503);
      return replay(savedRequest,hash,businessId,selected);
    }
    if(result!=='!saved')throw new AppError('The daily save could not be confirmed. Retry the same request.',503);
    return day;
  });
}

export const salesDaysEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const businessId=business(req.query?.businessId),hasDate=req.query?.date!==undefined,hasMonth=req.query?.month!==undefined;
    if(hasDate===hasMonth)throw new AppError('Choose either one daily date or one calendar month.');
    if(hasDate)return res.json({day:await getDay(businessId,date(req.query.date))});
    const month=req.query.month,dates=monthDates(month),keys=dates.map(selected=>PREFIX+summaryKey(businessId,selected));
    const values=await redis('MGET',...keys);
    if(!Array.isArray(values)||values.length!==dates.length)throw new AppError('The monthly daily entries could not be loaded completely.',503);
    const days=[];
    for(let i=0;i<dates.length;i++){
      if(values[i]===null||values[i]===undefined)continue;
      let saved;try{saved=JSON.parse(values[i]);}catch{throw new AppError('A daily summary could not be read. The month could not be loaded completely.',503);}
      checkStored(saved,businessId,dates[i],false);
      // Only current summary keys are read. Full audit histories never enter a month response.
      const {history,...safe}=saved;days.push(safe);
    }
    return res.json({businessId,month,timezone:TIMEZONE,days});
  }
  const b=input(req),businessId=business(b.businessId);
  if(b.action!=='save')throw new AppError('Choose the save action for daily activity.');
  if(typeof b.requestId!=='string'||!REQUEST_ID.test(b.requestId))
    throw new AppError('A valid request ID is required. Keep the same ID when retrying an unchanged daily save.');
  if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0)
    throw new AppError('Use revision 0 for a new day, or the exact saved revision when editing.');
  const details=normalizeSalesDay(b.day,businessId);
  return res.json({success:true,day:await saveDay(details,b.expectedRevision,b.requestId,session.name)});
});
