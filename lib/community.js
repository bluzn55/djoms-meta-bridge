import { AppError, PREFIX, authorize, endpoint, only, input, redis, read, write, id, now, config, equal } from './core.js';

const TOPICS = ['General','BBQ','Recipes','Music','Books','Pit Krewe','Events'];
const ALLOWED_MEDIA_HOSTS = new Set(['static.wixstatic.com','video.wixstatic.com','www.docjaks.com','docjaks.com']);
const PUBLIC_ORIGINS = new Set(['https://www.docjaks.com','https://docjaks.com']);

function clean(value,max,label){
  if(typeof value!=='string' || value.length>max) throw new AppError(label+' is too long.');
  return value.trim();
}
function validEmail(value){
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}
function publicOrigin(req){
  const origin=String(req.headers.origin||'');
  if(!PUBLIC_ORIGINS.has(origin)) throw new AppError('Open this form from DocJaks.com.',403);
  return origin;
}
function setCors(req,res){
  const origin=String(req.headers.origin||'');
  if(PUBLIC_ORIGINS.has(origin)){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
  }
}
function media(value,type){
  if(!value) return null;
  let u;
  try{ u=new URL(value); }catch{ throw new AppError('That media link is not valid.'); }
  if(u.protocol!=='https:' || !ALLOWED_MEDIA_HOSTS.has(u.hostname)) throw new AppError('Uploads must come from Doc Jaks/Wix media storage.');
  if(!['image','video'].includes(type)) throw new AppError('Choose an image or video.');
  return {url:u.toString(),type};
}
async function save(item){
  item.updatedAt=now();
  await redis('EVAL','redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],ARGV[2],ARGV[3]); return 1',
    2,PREFIX+'community:'+item.id,PREFIX+'community-index',JSON.stringify(item),Date.now(),item.id);
  return item;
}
async function listAll(limit=300){
  const ids=await redis('ZREVRANGE',PREFIX+'community-index',0,limit-1);
  const vals=ids.length?await redis('MGET',...ids.map(x=>PREFIX+'community:'+x)):[];
  return vals.filter(Boolean).map(v=>JSON.parse(v));
}
function publicItem(x){
  return {
    id:x.id,parentId:x.parentId||null,topic:x.topic,displayName:x.displayName,text:x.text,
    media:x.media||null,createdAt:x.createdAt,approvedAt:x.approvedAt||null,reply:x.reply||null,
    replyAt:x.replyAt||null
  };
}
async function rateLimit(req){
  const ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim().slice(0,80);
  const key=PREFIX+'community-rate:'+ip;
  const n=await redis('EVAL','local n=redis.call("incr",KEYS[1]); if n==1 then redis.call("expire",KEYS[1],600) end; return n',1,key);
  if(n>8) throw new AppError('Too many submissions. Please wait a few minutes and try again.',429);
}

export const communityPublicEndpoint=endpoint(async(req,res)=>{
  setCors(req,res);
  if(req.method==='OPTIONS'){
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    return res.status(204).end();
  }
  only(req,res,['GET','POST']);
  if(req.method==='GET'){
    const items=(await listAll()).filter(x=>x.status==='approved').map(publicItem);
    return res.json({items});
  }
  publicOrigin(req);
  await rateLimit(req);
  const b=input(req);
  const displayName=clean(b.displayName||'',80,'Name');
  const email=clean(b.email||'',254,'Email').toLowerCase();
  const text=clean(b.text||'',4000,'Post');
  if(!displayName) throw new AppError('Enter your name or display name.');
  if(!email || !validEmail(email)) throw new AppError('Enter a valid email address.');
  if(!text && !b.mediaUrl) throw new AppError('Write something or add a photo/video.');
  const topic=TOPICS.includes(b.topic)?b.topic:'General';
  const parentId=typeof b.parentId==='string' && /^[a-f0-9]{36}$/.test(b.parentId)?b.parentId:null;
  if(parentId){
    const parent=await read('community:'+parentId);
    if(!parent || parent.status!=='approved') throw new AppError('That discussion is not available.');
  }
  const item={
    id:id(),parentId,topic,displayName,email,text,
    media:media(clean(b.mediaUrl||'',2000,'Media URL'),clean(b.mediaType||'',20,'Media type')),
    status:'pending',createdAt:now(),source:'website'
  };
  await save(item);
  res.json({success:true,message:'Thanks. Your post is waiting for Doc Jaks approval.'});
});

export const communityModerationEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const items=await listAll();
    return res.json({items,checkedAt:now()});
  }
  const b=input(req);
  const itemId=clean(b.itemId||'',80,'Community post ID');
  if(!/^[a-f0-9]{36}$/.test(itemId)) throw new AppError('Choose a community post.');
  const item=await read('community:'+itemId);
  if(!item) throw new AppError('That community post could not be found.',404);
  if(b.action==='approve'){
    item.status='approved'; item.approvedAt=now(); item.approvedBy=session.name;
  }else if(b.action==='reject'){
    item.status='rejected'; item.rejectedAt=now(); item.rejectedBy=session.name;
  }else if(b.action==='handled'){
    item.handled=b.handled!==false; item.handledAt=item.handled?now():null; item.handledBy=item.handled?session.name:null;
  }else if(b.action==='reply'){
    const reply=clean(b.reply||'',4000,'Reply');
    if(!reply) throw new AppError('Write a reply first.');
    item.reply=reply; item.replyAt=now(); item.replyBy=session.name; item.handled=true; item.handledAt=now();
  }else throw new AppError('That moderation action is not supported.');
  await save(item);
  res.json({success:true,item});
});
