import { endpoint, authorize, only, input, read, write, now, AppError } from './core.js';

// Signed-in owner-only results. Never store raw provider responses or credentials.
const KEY='maintenance:back-office';
const STATES=new Set(['green','yellow','red','unverified']);
const LABELS={
  gsc:'Google Search Console',
  bing:'Bing Webmaster',
  ga4:'Google Analytics data',
  'ga4-tag':'Wix / GA4 measurement ID',
  facebook:'Facebook connection',
  instagram:'Instagram connection',
  x:'X connection',
  youtube:'YouTube connection',
  gbp:'Google Business Profile',
  yelp:'Yelp reporting connection',
  tripadvisor:'Tripadvisor reporting connection',
  wix:'Wix website reporting',
  radio:'Outlaw Radio 5150 broadcast'
};

function sanitizeRow(row) {
  const id=String(row?.id||'');
  if(!Object.prototype.hasOwnProperty.call(LABELS,id))
    throw new AppError('The connection-check data contains an unknown service.',400);
  const state=String(row?.state||'unverified');
  if(!STATES.has(state))throw new AppError('Connection state is invalid.',400);
  const message=typeof row.message==='string'?row.message.trim().slice(0,300):'No detail supplied.';
  return {id,label:LABELS[id],state,message};
}
export const maintenanceHealthEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  await authorize(req);
  if(req.method==='GET'){
    const saved=await read(KEY);
    return res.json(saved && Array.isArray(saved.history)?saved:{latest:null,history:[]});
  }
  const data=input(req);
  if(!Array.isArray(data.rows)||data.rows.length<1||data.rows.length>30)
    throw new AppError('Enter 1 to 30 verified connection results.',400);
  const unique=new Set();
  const rows=data.rows.map(sanitizeRow);
  for(const row of rows){
    if(unique.has(row.id))throw new AppError('Duplicate connection check.',400);
    unique.add(row.id);
  }
  const previous=await read(KEY)||{latest:null,history:[]};
  const report={checkedAt:now(),source:'owner-authenticated-read-only-check',
    rows,summary:{
      green:rows.filter(x=>x.state==='green').length,
      yellow:rows.filter(x=>x.state==='yellow').length,
      red:rows.filter(x=>x.state==='red').length,
      unverified:rows.filter(x=>x.state==='unverified').length
    }};
  const history=[report,...(Array.isArray(previous.history)?previous.history:[])].slice(0,120);
  await write(KEY,{version:1,latest:report,history});
  return res.json({success:true,report});
});