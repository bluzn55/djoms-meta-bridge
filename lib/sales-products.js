// Reusable owner-entered product choices. A choice is not inventory or a sale.
// Sale lines keep their own snapshots; catalog edits never rewrite sale records.
import {createHash} from 'node:crypto';
import {AppError,PREFIX,authorize,endpoint,id,input,now,only,read,redis,withLock} from './core.js';
import {salesBusinesses} from './sales.js';

const DIVISIONS=new Set(['food','alcohol','swag','events','catering']);
const UNITS=new Set(['each','bottle','case','gallon','liter','pound','kilogram','service']);
const REQUEST_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const RECORD_ID=/^[a-f0-9]{36}$/;
const MAX_PRODUCTS=500,MAX_HISTORY=100;
const DEFAULT_UNITS={food:'bottle',alcohol:'bottle',swag:'each',events:'service',catering:'service'};
const STARTERS=Object.freeze([
  {id:'starter_food_boss_soss',name:'Boss Soss'},
  {id:'starter_food_sweet_bayou',name:'Sweet Bayou'},
]);
const recordKey=(businessId,productId)=>'sales-product:'+businessId+':'+productId;
const summaryKey=(businessId,productId)=>'sales-product-summary:'+businessId+':'+productId;
const indexKey=businessId=>PREFIX+'sales-products:'+businessId;
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
function productId(value){
  if(typeof value!=='string'||(!RECORD_ID.test(value)&&!STARTERS.some(item=>item.id===value)))
    throw new AppError('Choose a saved product.');
  return value;
}
function positiveInteger(value,max,label){
  const raw=text(value,12,label);
  if(!raw)return '';
  if(!/^\d+$/.test(raw)||BigInt(raw)<1n||BigInt(raw)>BigInt(max))
    throw new AppError(label+' must be a positive whole number, no more than '+max+'.');
  return BigInt(raw).toString();
}
function price(value){
  const raw=text(value,20,'Default price');
  if(!raw)return '';
  if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw))
    throw new AppError('Default price must be from 0 to 999999999.99 with at most two decimals, or blank if unknown.');
  const [whole,fraction='']=raw.split('.');
  return BigInt(whole).toString()+'.'+fraction.padEnd(2,'0');
}
function proof(value){
  const raw=text(value,12,'U.S. proof');
  if(!raw)return '';
  if(!/^\d{1,3}(?:\.\d{1,3})?$/.test(raw))throw new AppError('U.S. proof must be greater than 0, no more than 200, and use at most three decimals.');
  const [whole,fraction='']=raw.split('.'),scaled=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
  if(scaled<=0n||scaled>200000n)throw new AppError('U.S. proof must be greater than 0 and no more than 200.');
  const tail=fraction.replace(/0+$/,'');
  return BigInt(whole).toString()+(tail?'.'+tail:'');
}
export function normalizeSalesProduct(value,businessId){
  business(businessId);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('Enter product details.');
  if(value.businessId!=null&&value.businessId!==businessId)throw new AppError('A product cannot be moved to another business.',409);
  const division=text(value.division,40,'Product section');
  if(!DIVISIONS.has(division))throw new AppError('Choose Food, Alcohol, Swag, Events or Catering.');
  const name=text(value.name,300,'Product name');
  if(!name)throw new AppError('Enter a product or service name.');
  const unit=text(value.unit,40,'Unit')||DEFAULT_UNITS[division];
  if(!UNITS.has(unit))throw new AppError('Choose a supported product unit.');
  if(value.active!=null&&typeof value.active!=='boolean')throw new AppError('Product active status must be true or false.');
  const result={businessId,division,name,sku:text(value.sku,100,'SKU'),packageLabel:text(value.packageLabel,120,'Package or service size'),
    unit,defaultPrice:price(value.defaultPrice),bottleSizeMl:positiveInteger(value.bottleSizeMl,100000,'Bottle size in mL'),
    bottlesPerUnit:positiveInteger(value.bottlesPerUnit,1000,'Bottles per case or pack'),proof:proof(value.proof),active:value.active!==false};
  if(division!=='alcohol'&&(result.bottleSizeMl||result.proof))
    throw new AppError('Use the package label for this product. Bottle volume and proof belong to Alcohol products.');
  if(unit==='bottle'&&result.bottlesPerUnit&&result.bottlesPerUnit!=='1')
    throw new AppError('A bottle unit contains one bottle. Choose case for a case or pack.');
  return result;
}
function values(product){
  return Object.fromEntries(['division','name','sku','packageLabel','unit','defaultPrice','bottleSizeMl','bottlesPerUnit','proof','active'].map(key=>[key,product[key]]));
}
function summary(product){
  return {id:product.id,businessId:product.businessId,revision:product.revision,...values(product),
    createdAt:product.createdAt,updatedAt:product.updatedAt,createdBy:product.createdBy,updatedBy:product.updatedBy,
    createRequestId:product.createRequestId,lastRequestId:product.lastRequestId,historyCount:product.history.length};
}
function starter(businessId,selected){
  const item=STARTERS.find(value=>value.id===selected);
  return item?{...item,businessId,revision:0,division:'food',sku:'',packageLabel:'12 oz bottle',unit:'bottle',defaultPrice:'',
    bottleSizeMl:'',bottlesPerUnit:'',proof:'',active:true,createdAt:null,updatedAt:null,createdBy:null,updatedBy:null,
    createRequestId:null,lastRequestId:null,history:[]}:null;
}
function checkStored(value,businessId,selected,full=true){
  if(!value||typeof value!=='object'||value.businessId!==businessId||value.id!==selected||
    !Number.isSafeInteger(value.revision)||value.revision<1||!DIVISIONS.has(value.division)||typeof value.active!=='boolean'||
    (full?(!Array.isArray(value.history)||value.history.length<1||value.history.length>MAX_HISTORY):
      (!Number.isInteger(value.historyCount)||value.historyCount<1||value.historyCount>MAX_HISTORY)))
    throw new AppError('A saved product is inconsistent. Its data has not been changed; reload after the product is checked.',503);
  return value;
}
async function getSaved(businessId,selected){
  const saved=await read(recordKey(businessId,selected));
  return saved?checkStored(saved,businessId,selected):null;
}
function conflict(){throw new AppError('That product request ID was already used with different details. Retry the original request or use a new ID for a new edit.',409);}
async function replay(mapping,hash,businessId){
  if(mapping.hash!==hash)conflict();
  const saved=await getSaved(businessId,productId(mapping.id));
  if(!saved)throw new AppError('The saved result for this product request is unavailable. No product was created.',503);
  return saved;
}
async function saveProduct(details,requestedId,expectedRevision,token,user){
  const businessId=details.businessId,hash=digest({id:requestedId||'',product:details});
  const requestKey='sales-product-request:'+businessId+':'+token;
  return withLock('sales-products:'+businessId,async()=>{
    const priorRequest=await read(requestKey);
    if(priorRequest)return replay(priorRequest,hash,businessId);
    const selected=requestedId||id(),previous=await getSaved(businessId,selected),initial=starter(businessId,selected);
    if(requestedId&&!previous&&!initial)throw new AppError('This saved product was not found for the selected business.',404);
    if(initial&&details.division!=='food')throw new AppError('These starter products belong in Food. Add a separate product for another section.');
    const revision=previous?.revision||0;
    if(revision!==expectedRevision)throw new AppError('This product changed in another window. Reload it before saving.',409);
    if((previous?.history.length||0)>=MAX_HISTORY)
      throw new AppError('This product\'s audit history is full. No change was saved; all existing history is preserved.');
    const at=now(),nextRevision=revision+1;
    const event={at,type:!previous?'created':previous.active&&!details.active?'archived':!previous.active&&details.active?'restored':'updated',
      user,requestId:token,revision:nextRevision,before:previous?values(previous):initial?values(initial):null,after:values(details)};
    const product={...details,id:selected,revision:nextRevision,createdAt:previous?.createdAt||at,updatedAt:at,
      createdBy:previous?.createdBy||user,updatedBy:user,createRequestId:previous?.createRequestId||token,lastRequestId:token,
      history:[event,...(previous?.history||[])]};
    const script=[
      'local request=redis.call("get",KEYS[4])',
      'if request then local p=cjson.decode(request); if p.hash~=ARGV[4] then return "!conflict" end; return "!replay" end',
      'local previous=redis.call("get",KEYS[1]); local revision=0',
      'if previous then local p=cjson.decode(previous); revision=p.revision end',
      'if revision~=tonumber(ARGV[5]) then return "!revision" end',
      'if not previous and redis.call("zcard",KEYS[3])>=tonumber(ARGV[8]) then return "!limit" end',
      'redis.call("set",KEYS[1],ARGV[1])',
      'redis.call("set",KEYS[2],ARGV[2])',
      'redis.call("zadd",KEYS[3],"NX",ARGV[6],ARGV[7])',
      'redis.call("set",KEYS[4],ARGV[3])',
      'return "!saved"',
    ].join('\n');
    const result=await redis('EVAL',script,4,PREFIX+recordKey(businessId,selected),PREFIX+summaryKey(businessId,selected),indexKey(businessId),PREFIX+requestKey,
      JSON.stringify(product),JSON.stringify(summary(product)),JSON.stringify({hash,id:selected,revision:nextRevision}),
      hash,String(expectedRevision),String(Date.parse(product.createdAt)),selected,String(MAX_PRODUCTS));
    if(result==='!conflict')conflict();
    if(result==='!revision')throw new AppError('This product changed while it was being saved. Reload it before saving.',409);
    if(result==='!limit')throw new AppError('This business has reached the 500 saved-product limit. Existing products and their histories are preserved.');
    if(result==='!replay'){
      const savedRequest=await read(requestKey);
      if(!savedRequest)throw new AppError('The previous product save could not be confirmed. Retry the same request.',503);
      return replay(savedRequest,hash,businessId);
    }
    if(result!=='!saved')throw new AppError('The product save could not be confirmed. Retry the same request.',503);
    return product;
  });
}

export const salesProductsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const businessId=business(req.query?.businessId);
    if(req.query?.id!==undefined){
      const selected=productId(req.query.id),product=await getSaved(businessId,selected)||starter(businessId,selected);
      if(!product)throw new AppError('This product was not found for the selected business.',404);
      return res.json({product});
    }
    const ids=await redis('ZRANGE',indexKey(businessId),0,MAX_PRODUCTS);
    if(!Array.isArray(ids)||ids.length>MAX_PRODUCTS||new Set(ids).size!==ids.length)
      throw new AppError('The product list could not be loaded completely.',503);
    ids.forEach(productId);
    const entries=ids.length?await redis('MGET',...ids.map(selected=>PREFIX+summaryKey(businessId,selected))):[];
    if(!Array.isArray(entries)||entries.length!==ids.length)throw new AppError('The product list could not be loaded completely.',503);
    const products=new Map(STARTERS.map(item=>[item.id,summary(starter(businessId,item.id))]));
    entries.forEach((entry,index)=>{
      let saved;try{saved=JSON.parse(entry);}catch{throw new AppError('A product summary could not be read. The product list is incomplete.',503);}
      const checked=checkStored(saved,businessId,ids[index],false);
      const {history,...compact}=checked;products.set(checked.id,compact);
    });
    return res.json({businessId,products:[...products.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))});
  }
  const b=input(req),businessId=business(b.businessId);
  if(b.action!=='save')throw new AppError('Choose the save action for products.');
  if(typeof b.requestId!=='string'||!REQUEST_ID.test(b.requestId))
    throw new AppError('A valid request ID is required. Keep the same ID when retrying an unchanged product save.');
  if(!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision<0)
    throw new AppError('Use revision 0 for a new product, or the exact saved revision when editing.');
  const selected=b.id==null?'':productId(b.id),details=normalizeSalesProduct(b.product,businessId);
  if(b.product.id!=null&&b.product.id!==selected)throw new AppError('A saved product ID cannot be changed.',409);
  return res.json({success:true,product:await saveProduct(details,selected,b.expectedRevision,b.requestId,session.name)});
});
