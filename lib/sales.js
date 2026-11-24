// Private, owner-entered sales and payments already received.
// This module never charges, refunds, files, or writes to another business system.
import {createHash} from 'node:crypto';
import {AppError,PREFIX,authorize,endpoint,id,input,now,only,read,redis,withLock} from './core.js';

const TIMEZONE='America/Chicago';
export const salesBusinesses=Object.freeze([
  {id:'conestoga',name:'Colo Distillery LLC'},
  {id:'doc_jaks',name:"Doc Jak's"},
]);
const CHANNELS=new Set(['retail','wholesale','event','website','other']);
const CATEGORIES=new Set(['spirits','food','swag','music','books','bundles','other']);
const UNITS=new Set(['each','bottle','case','gallon','liter','pound','kilogram','service']);
const METHODS=new Set(['cash','card','bank','check','other']);
const MAX_CENTS=99999999999n;
const QUANTITY_SCALE=1000000n;
const MAX_ITEMS=100,MAX_PAYMENTS=200,MAX_HISTORY=500,MAX_PAGE=50;
const MAX_RESPONSE_BYTES=3*1024*1024;
const RECORD_ID=/^[a-f0-9]{36}$/;
const REQUEST_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const CONNECTIONS=Object.freeze({inventory:false,accounting:false,reports:false});
const moneyText=cents=>(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const saleKey=(businessId,saleId)=>'sale:'+businessId+':'+saleId;
const indexKey=businessId=>PREFIX+'sales:'+businessId;

function text(value,max,label){
  if(value==null)return '';
  if(typeof value!=='string'||value.length>max)throw new AppError(label+' must be text, no more than '+max+' characters.');
  return value.trim();
}
function object(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Enter '+label+'.');
  return value;
}
function business(value){
  if(!salesBusinesses.some(item=>item.id===value))throw new AppError('Choose Colo Distillery LLC or Doc Jak\'s.');
  return value;
}
function requestId(value){
  if(typeof value!=='string'||!REQUEST_ID.test(value))throw new AppError('A valid request ID is required. Keep the same ID when retrying an unchanged request.');
  return value;
}
function choice(value,allowed,label){
  const selected=text(value,40,label);
  if(selected&&!allowed.has(selected))throw new AppError('Choose a supported '+label.toLowerCase()+'.');
  return selected;
}
function date(value,label){
  const result=text(value,10,label);
  if(!result)return '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||result<'1900-01-01'||result>'2200-12-31'||
    !Number.isFinite(Date.parse(result+'T12:00:00Z'))||new Date(result+'T12:00:00Z').toISOString().slice(0,10)!==result)
    throw new AppError('Enter a real calendar date for '+label.toLowerCase()+'.');
  return result;
}
function centralToday(){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date()).map(part=>[part.type,part.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function pastDate(value,label){
  if(!value)throw new AppError('Enter '+label.toLowerCase()+'.');
  if(value>centralToday())throw new AppError(label+' cannot be in the future (Central time).');
}
function money(value,label){
  const raw=text(value,20,label);
  if(!raw)return {text:'',cents:null};
  if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw))throw new AppError(label+' must be an amount from 0 to 999999999.99, with at most two decimal places and no currency symbols or commas.');
  const [whole,fraction='']=raw.split('.');
  const cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  return {text:moneyText(cents),cents};
}
function quantity(value){
  const raw=text(value,24,'Quantity');
  if(!raw)return {text:'',scaled:null};
  if(!/^\d{1,9}(?:\.\d{1,6})?$/.test(raw))throw new AppError('Quantity must be positive, no more than 999999999.999999, and use at most six decimal places.');
  const [whole,fraction='']=raw.split('.');
  const scaled=BigInt(whole)*QUANTITY_SCALE+BigInt(fraction.padEnd(6,'0'));
  if(scaled<=0n)throw new AppError('Quantity must be greater than zero. Leave an unknown draft quantity blank.');
  const tail=fraction.replace(/0+$/,'');
  return {text:whole.replace(/^0+(?=\d)/,'')+(tail?'.'+tail:''),scaled};
}
function bounded(cents,label){
  if(cents<0n||cents>MAX_CENTS)throw new AppError(label+' must be between 0 and 999999999.99.');
  return Number(cents);
}
function normalizePayment(value={},strict=false){
  object(value,'payment details');
  if(Object.keys(value).some(key=>!['amount','method','date','reference','notes'].includes(key)))
    throw new AppError('Use only the payment amount, method, date, reference and notes.');
  const payment={amount:money(value.amount,'Payment amount').text,method:choice(value.method,METHODS,'Payment method'),
    date:date(value.date,'Payment date'),reference:text(value.reference,200,'Payment reference'),notes:text(value.notes,2000,'Payment notes')};
  if(strict){
    if(!payment.amount||money(payment.amount,'Payment amount').cents<=0n)throw new AppError('Enter a payment greater than zero. Leave initial payment details blank when no payment was received.');
    if(!payment.method)throw new AppError('Choose the received payment method.');
    pastDate(payment.date,'Payment date');
  }
  return payment;
}
function normalizedItem(value){
  object(value,'an item line');
  const qty=quantity(value.quantity),price=money(value.unitPrice,'Unit price');
  const line=qty.scaled===null||price.cents===null?null:(qty.scaled*price.cents+QUANTITY_SCALE/2n)/QUANTITY_SCALE;
  return {description:text(value.description,300,'Item description'),sku:text(value.sku,100,'SKU'),
    productId:text(value.productId,100,'Product reference'),batchReference:text(value.batchReference,100,'Batch reference'),
    category:choice(value.category,CATEGORIES,'Item category'),quantity:qty.text,unit:choice(value.unit,UNITS,'Unit'),
    unitPrice:price.text,lineTotalCents:line===null?null:bounded(line,'Line total')};
}
export function normalizeSale(value,businessId){
  object(value,'sale details');
  business(businessId);
  if(value.businessId!=null&&value.businessId!==businessId)throw new AppError('A sale cannot be moved to another business.',409);
  const customer=value.customer==null?{}:object(value.customer,'customer details');
  const customerEmail=text(customer.email,254,'Customer email');
  if(customerEmail&&!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(customerEmail))throw new AppError('Enter one valid customer email address, or leave it blank.');
  if(value.items!=null&&!Array.isArray(value.items))throw new AppError('Sale items must be a list.');
  const rawItems=value.items||[];
  if(rawItems.length>MAX_ITEMS)throw new AppError('Use no more than '+MAX_ITEMS+' item lines per sale.');
  const items=rawItems.map(normalizedItem);
  const discount=money(value.discountAmount,'Discount'),tax=money(value.taxAmount,'Tax amount'),shipping=money(value.shippingAmount,'Shipping amount');
  const sale={businessId,soldOn:date(value.soldOn,'Sale date'),dueDate:date(value.dueDate,'Payment due date'),
    channel:choice(value.channel,CHANNELS,'Sales channel'),location:text(value.location,200,'Location'),
    sourceReference:text(value.sourceReference,200,'Source reference'),
    customer:{name:text(customer.name,200,'Customer name'),email:customerEmail},notes:text(value.notes,4000,'Sale notes'),
    items,discountAmount:discount.text,taxAmount:tax.text,shippingAmount:shipping.text,
    initialPayment:normalizePayment(value.initialPayment==null?{}:value.initialPayment)};
  return {...sale,...saleTotals(sale,[])};
}
function saleTotals(sale,payments){
  const subtotal=sale.items.length&&sale.items.every(item=>item.lineTotalCents!==null)
    ?sale.items.reduce((sum,item)=>sum+BigInt(item.lineTotalCents),0n):null;
  const discount=money(sale.discountAmount,'Discount').cents,tax=money(sale.taxAmount,'Tax amount').cents,
    shipping=money(sale.shippingAmount,'Shipping amount').cents;
  if(subtotal!==null)bounded(subtotal,'Subtotal');
  if(subtotal!==null&&discount!==null&&discount>subtotal)throw new AppError('The discount cannot exceed the subtotal.');
  const total=[subtotal,discount,tax,shipping].every(value=>value!==null)?subtotal-discount+tax+shipping:null;
  if(total!==null)bounded(total,'Sale total');
  const paid=payments.reduce((sum,payment)=>sum+BigInt(payment.amountCents),0n);
  bounded(paid,'Recorded payments');
  if(total!==null&&paid>total)throw new AppError('The payment exceeds the remaining sale balance.');
  const balance=total===null?null:total-paid;
  return {totals:{subtotalCents:subtotal===null?null:Number(subtotal),discountCents:discount===null?null:Number(discount),
    taxCents:tax===null?null:Number(tax),shippingCents:shipping===null?null:Number(shipping),totalCents:total===null?null:Number(total),
    paidCents:Number(paid),balanceCents:balance===null?null:Number(balance)},
    paymentStatus:balance===0n?'paid':paid>0n?'partial':'unpaid'};
}
function requireRecordable(sale){
  pastDate(sale.soldOn,'Sale date');
  if(!sale.channel)throw new AppError('Choose a sales channel before recording the sale.');
  if(!sale.items.length)throw new AppError('Add at least one item before recording the sale.');
  const incomplete=sale.items.find(item=>!item.description||!item.quantity||!item.unitPrice||!item.unit||!item.category);
  if(incomplete)throw new AppError('Complete each item description, quantity, unit, category and unit price.');
  if(!sale.discountAmount||!sale.taxAmount||!sale.shippingAmount)
    throw new AppError('Enter explicit discount, tax and shipping amounts, including 0 where appropriate.');
  if(sale.totals.totalCents===null)throw new AppError('Complete the sale amounts before recording.');
  if(Object.values(sale.initialPayment).some(Boolean))normalizePayment(sale.initialPayment,true);
}
function revision(sale,expected){
  if(!Number.isSafeInteger(expected)||sale.revision!==expected)throw new AppError('This sale changed in another window. Reload it before continuing.',409);
}
function event(sale,user,type,message){
  if((sale.history||[]).length>=MAX_HISTORY)
    throw new AppError('This sale\'s audit history is full. No change was saved; all existing history is preserved.');
  sale.history=[{at:now(),type,user,message},...(sale.history||[])];
}
function publicSale(sale){return sale;}
async function getSale(businessId,saleId){
  if(typeof saleId!=='string'||!RECORD_ID.test(saleId))throw new AppError('Choose a saved sale.');
  const sale=await read(saleKey(businessId,saleId));
  if(!sale||sale.businessId!==businessId)throw new AppError('This sale was not found for the selected business.',404);
  return sale;
}
function stamp(sale){sale.revision=(sale.revision||0)+1;sale.updatedAt=now();return sale;}
async function persist(sale){
  const expectedRevision=sale.revision;
  stamp(sale);
  const script='local previous=redis.call("get",KEYS[1]); if not previous then return "!missing" end; '+
    'local saved=cjson.decode(previous); if saved.revision~=tonumber(ARGV[4]) then return "!revision" end; '+
    'redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],"NX",ARGV[2],ARGV[3]); return 1';
  const result=await redis('EVAL',script,2,PREFIX+saleKey(sale.businessId,sale.id),indexKey(sale.businessId),
    JSON.stringify(sale),Date.now(),sale.id,String(expectedRevision));
  if(result==='!missing')throw new AppError('The saved sale is no longer available. Reload its history.',404);
  if(result==='!revision')throw new AppError('This sale changed while the update was being saved. Reload it before continuing.',409);
  return sale;
}
async function createSale(details,token,user){
  const businessId=details.businessId,hash=digest(details),requestKey='sales-create:'+businessId+':'+token;
  // Serialize the small creation transaction per business so numbering,
  // idempotency, record and index can commit together without JSON round trips.
  return withLock('sales-create:'+businessId,async()=>{
    const previous=await read(requestKey);
    if(previous){
      if(previous.hash!==hash)throw new AppError('That create request ID was already used with different sale details.',409);
      return getSale(businessId,previous.saleId);
    }
    const counterKey=PREFIX+'sales-number:'+businessId;
    const previousNumber=await redis('GET',counterKey)||'0';
    if(!/^\d{1,9}$/.test(String(previousNumber)))throw new AppError('The sale numbering settings need repair.',503);
    const next=Number(previousNumber)+1;
    if(next>999999999)throw new AppError('The sale numbering limit has been reached.',503);
    const sale={...details,id:id(),number:(businessId==='conestoga'?'CD':'DJ')+'-'+String(next).padStart(6,'0'),
      createRequestId:token,revision:0,status:'draft',createdAt:now(),updatedAt:now(),createdBy:user,
      recordedAt:null,voidedAt:null,voidReason:'',payments:[],history:[]};
    event(sale,user,'created','Created sales draft');stamp(sale);
    const script=[
      'local previous=redis.call("get",KEYS[3])',
      'if previous then local p=cjson.decode(previous); if p.hash~=ARGV[4] then return "!conflict" end; return p.saleId end',
      'if tostring(redis.call("get",KEYS[4]) or "0")~=ARGV[5] then return "!sequence" end',
      'redis.call("set",KEYS[1],ARGV[1])',
      'redis.call("zadd",KEYS[2],"NX",ARGV[2],ARGV[3])',
      'redis.call("set",KEYS[3],ARGV[6])',
      'redis.call("set",KEYS[4],ARGV[7])',
      'return ARGV[3]',
    ].join('\n');
    const savedId=await redis('EVAL',script,4,PREFIX+saleKey(businessId,sale.id),indexKey(businessId),PREFIX+requestKey,counterKey,
      JSON.stringify(sale),Date.now(),sale.id,hash,String(previousNumber),JSON.stringify({saleId:sale.id,hash}),String(next));
    if(savedId==='!conflict')throw new AppError('That create request ID was already used with different sale details.',409);
    if(savedId==='!sequence')throw new AppError('Another sale was created. Retry this unchanged draft with the same request ID.',409);
    if(savedId!==sale.id)return getSale(businessId,savedId);
    return sale;
  });
}
function receivedPayment(payment,token,user){
  return {id:id(),requestId:token,...payment,amountCents:Number(money(payment.amount,'Payment amount').cents),
    recordedAt:now(),recordedBy:user};
}
function samePayment(saved,incoming){
  return ['amount','method','date','reference','notes'].every(key=>saved[key]===incoming[key]);
}
function answer(res,sale){return res.json({success:true,sale:publicSale(sale)});}

export const salesEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const businessId=business(req.query?.businessId);
    const raw=req.query?.cursor??'0';
    const cursor=typeof raw==='string'&&/^(?:0|[1-9]\d*)$/.test(raw)?Number(raw):NaN;
    if(!Number.isSafeInteger(cursor)||cursor<0||cursor>Number.MAX_SAFE_INTEGER-MAX_PAGE)throw new AppError('The sales history cursor must be a nonnegative whole number.');
    const ids=await redis('ZREVRANGE',indexKey(businessId),cursor,cursor+MAX_PAGE);
    const selected=ids.slice(0,MAX_PAGE);
    const values=selected.length?await redis('MGET',...selected.map(saleId=>PREFIX+saleKey(businessId,saleId))):[];
    const metadata={businesses:salesBusinesses,businessId,timezone:TIMEZONE,connections:CONNECTIONS};
    let used=Buffer.byteLength(JSON.stringify({sales:[],...metadata,nextCursor:String(Number.MAX_SAFE_INTEGER)}),'utf8');
    const sales=[];let consumed=0;
    for(let i=0;i<selected.length;i++){
      if(!values[i])throw new AppError('A saved sale is missing from its history index. The history could not be loaded completely.',503);
      const sale=JSON.parse(values[i]);
      if(sale.businessId!==businessId||sale.id!==selected[i])throw new AppError('The sales history contains an inconsistent record. The history could not be loaded completely.',503);
      const size=Buffer.byteLength(JSON.stringify(sale),'utf8')+1;
      if(used+size>MAX_RESPONSE_BYTES){
        if(!sales.length)throw new AppError('This sale is too large for one response. Its data has not been removed.',503);
        break;
      }
      sales.push(publicSale(sale));used+=size;consumed++;
    }
    return res.json({sales,...metadata,nextCursor:consumed<ids.length?String(cursor+consumed):null});
  }
  const b=input(req),businessId=business(b.businessId);
  if(b.action==='save'&&!b.id){
    const token=requestId(b.requestId),details=normalizeSale(b.sale,businessId);
    return answer(res,await createSale(details,token,session.name));
  }
  if(!['save','record','recordPayment','void'].includes(b.action))throw new AppError('Choose a supported sales action.');
  if(typeof b.id!=='string'||!RECORD_ID.test(b.id))throw new AppError('Choose a saved sale.');
  return withLock('sale:'+businessId+':'+b.id,async()=>{
    const sale=await getSale(businessId,b.id);
    let payment,token;
    if(b.action==='recordPayment'){
      token=requestId(b.requestId);payment=normalizePayment(b.payment,true);
      const previous=sale.payments.find(item=>item.requestId===token);
      if(previous){
        if(!samePayment(previous,payment))throw new AppError('That payment request ID was already used with different details.',409);
        // An unchanged retry is a read of its prior result, even if a later
        // payment has advanced the sale revision. It never appends again.
        return answer(res,sale);
      }
    }
    revision(sale,b.expectedRevision);
    if(b.action==='save'){
      if(sale.status!=='draft')throw new AppError('Only drafts can be edited. Recorded sales keep their original financial values.',409);
      Object.assign(sale,normalizeSale(b.sale,businessId));
      event(sale,session.name,'saved','Updated sales draft');
    }else if(b.action==='record'){
      if(sale.status!=='draft')throw new AppError('This sale has already been recorded or voided. Reload its saved status.',409);
      const normalized=normalizeSale(sale,businessId);
      requireRecordable(normalized);
      Object.assign(sale,normalized);
      if(Object.values(sale.initialPayment).some(Boolean)){
        const initial=normalizePayment(sale.initialPayment,true);
        const entry=receivedPayment(initial,'initial-'+sale.id,session.name);
        sale.payments=[entry];
        Object.assign(sale,saleTotals(sale,sale.payments));
        event(sale,session.name,'payment','Recorded initial received payment of $'+entry.amount+'. No charge was processed.');
      }
      sale.status='recorded';sale.recordedAt=now();
      event(sale,session.name,'recorded','Recorded the saved sale and its financial values');
    }else if(b.action==='recordPayment'){
      if(sale.status!=='recorded')throw new AppError('Record the sale before adding a received payment.',409);
      if(sale.payments.length>=MAX_PAYMENTS)throw new AppError('This sale has reached its '+MAX_PAYMENTS+'-payment limit. No additional payment was recorded.');
      const entry=receivedPayment(payment,token,session.name);
      const payments=[...sale.payments,entry];
      const totals=saleTotals(sale,payments);
      sale.payments=payments;Object.assign(sale,totals);
      event(sale,session.name,'payment','Recorded received payment of $'+entry.amount+'. No charge was processed.');
    }else if(b.action==='void'){
      if(!['draft','recorded'].includes(sale.status))throw new AppError('This sale is already voided.',409);
      if(sale.payments.length)throw new AppError('A sale with received payments cannot be voided here. Refund processing is outside this page.',409);
      const reason=text(b.reason,2000,'Void reason');
      if(!reason)throw new AppError('Enter why this sale is being voided.');
      sale.status='voided';sale.voidedAt=now();sale.voidReason=reason;
      event(sale,session.name,'voided','Voided without deleting the original sale. Reason: '+reason);
    }
    return answer(res,await persist(sale));
  });
});
