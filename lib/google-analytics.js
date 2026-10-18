// DJOMS read-only Google Analytics 4 reports for the owner's verified DOCJAKS.COM.
// OAuth deliberately reuses the existing Google Search Console callback URL registered
// in Google Cloud. The "ga-" state prefix routes consent here without touching SEO tokens.
import { AppError, PREFIX, env, config, authorize, endpoint, only, read, write, redis, seal, unseal, now, id } from './core.js';
import { resolveReportWindow } from './report-window.js';

const PROPERTY_ID='559458653';
const STORE='ga4-readonly';
const SCOPE='https://www.googleapis.com/auth/analytics.readonly';
const GOOGLE_AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const ANALYTICS_DATA='https://analyticsdata.googleapis.com/v1beta/properties/'+PROPERTY_ID+':runReport';

const emptyMetrics=()=>({
  activeUsers:null,sessions:null,engagementRate:null,averageSessionDuration:null
});
const num=value=>{
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
  if(typeof value==='string'&&value.trim()!==''){
    const number=Number(value);
    return Number.isFinite(number)&&number>=0?number:null;
  }
  return null;
};
const emptyReport=(range,status,message,extra={})=>({
  connected:false,status,message,propertyId:PROPERTY_ID,range,
  checkedAt:now(),metrics:emptyMetrics(),channels:[],...extra
});

function credentials(){
  const clientId=env().GOOGLE_BUSINESS_CLIENT_ID||env().YOUTUBE_CLIENT_ID;
  const clientSecret=env().GOOGLE_BUSINESS_CLIENT_SECRET||env().YOUTUBE_CLIENT_SECRET;
  if(!clientId||!clientSecret)
    throw new AppError('Google sign-in credentials are not set up for Social Command.',503);
  return {clientId,clientSecret};
}
const callbackUri=()=>config().origin+'/api/meta/seo-callback';

async function token(parameters){
  const {clientId,clientSecret}=credentials();
  let response,data;
  try{
    response=await fetch(GOOGLE_TOKEN,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({...parameters,client_id:clientId,client_secret:clientSecret}),
      signal:AbortSignal.timeout(16000)
    });
    data=await response.json().catch(()=>({}));
  }catch{
    throw new AppError('Google Analytics authorization could not be reached.',502);
  }
  if(!response.ok||!data.access_token)
    throw new AppError('Google Analytics authorization was not completed. Connect it again.',409);
  return data;
}

async function connection(){
  const saved=await read(STORE);
  if(!saved)return null;
  let value=unseal(saved);
  if(value.propertyId!==PROPERTY_ID)throw new AppError('Reconnect the correct Google Analytics property.',409);
  if(!value.expiresAt||value.expiresAt<Date.now()+60000){
    if(!value.refreshToken)throw new AppError('Reconnect Google Analytics in Social Command.',401);
    const newToken=await token({grant_type:'refresh_token',refresh_token:value.refreshToken});
    value={...value,accessToken:newToken.access_token,
      refreshToken:newToken.refresh_token||value.refreshToken,
      expiresAt:Date.now()+Math.max(60,Number(newToken.expires_in||3600))*1000};
    await write(STORE,seal(value));
  }
  return value;
}

async function runReport(accessToken,request){
  let response,data;
  try{
    response=await fetch(ANALYTICS_DATA,{
      method:'POST',
      headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},
      body:JSON.stringify(request),
      signal:AbortSignal.timeout(18000)
    });
    data=await response.json().catch(()=>({}));
  }catch{
    throw new AppError('Google Analytics did not respond. Try refreshing the report later.',502);
  }
  if(!response.ok){
    const reason=String(data?.error?.message||'');
    const detail=Array.isArray(data?.error?.details)?data.error.details:[];
    const disabled=detail.some(item=>item?.reason==='SERVICE_DISABLED')||
      /has not been used|not enabled|is disabled|API has not been used/i.test(reason);
    if(disabled)throw new AppError('Enable Google Analytics Data API in the Google Cloud project for Social Command.',424);
    if(response.status===401)throw new AppError('Reconnect Google Analytics in Social Command.',401);
    if(response.status===403)throw new AppError('The Google Analytics Data API is not enabled or this account lacks access to the DOCJAKS.COM property.',403);
    if(response.status===429)throw new AppError('Google Analytics reporting limit reached. Try again later.',429);
    throw new AppError('Google Analytics could not return the selected report.',502);
  }
  return data||{};
}

export const ga4ConnectEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  const owner=await authorize(req);
  const {clientId}=credentials();
  const state='ga-'+id();
  await write('ga-oauth:'+state,{sessionId:owner.id,propertyId:PROPERTY_ID},600);
  const url=new URL(GOOGLE_AUTH);
  url.search=new URLSearchParams({
    client_id:clientId,redirect_uri:callbackUri(),response_type:'code',
    scope:SCOPE,access_type:'offline',include_granted_scopes:'true',
    prompt:'consent',state
  }).toString();
  res.redirect(302,url.toString());
});

// Called only for OAuth states beginning ga- inside the existing Google callback.
// Token and property never go to the browser; the owner session and one-time state are required.
export async function handleGa4Callback(req,res){
  only(req,res,['GET']);
  const owner=await authorize(req);
  const state=String(req.query?.state||'');
  if(!/^ga-[a-f0-9]{36}$/.test(state))
    throw new AppError('Google Analytics sign-in state is invalid.',403);
  const raw=await redis('GETDEL',PREFIX+'ga-oauth:'+state);
  let expected;
  try{expected=raw?JSON.parse(raw):null;}catch{expected=null;}
  if(!expected||expected.sessionId!==owner.id||expected.propertyId!==PROPERTY_ID)
    throw new AppError('Google Analytics sign-in expired. Try connecting again.',403);
  if(req.query?.error)return res.redirect(303,config().origin+'/?ga4=cancelled');
  if(typeof req.query?.code!=='string')
    throw new AppError('Google did not return an Analytics authorization code.',400);
  const authorized=await token({
    grant_type:'authorization_code',code:req.query.code,redirect_uri:callbackUri()
  });
  const previousSealed=await read(STORE);
  const prior=previousSealed?unseal(previousSealed):{};
  await write(STORE,seal({
    accessToken:authorized.access_token,
    refreshToken:authorized.refresh_token||prior.refreshToken||null,
    expiresAt:Date.now()+Math.max(60,Number(authorized.expires_in||3600))*1000,
    propertyId:PROPERTY_ID,connectedAt:now()
  }));
  return res.redirect(303,config().origin+'/?ga4=authorized');
}

async function ga4Report(range){
  let authorized;
  try{authorized=await connection();}
  catch(error){
    return emptyReport(range,'reconnect',error.message);
  }
  if(!authorized)
    return emptyReport(range,'not-connected','Authorize read-only Google Analytics access in Social Command.');
  const period={startDate:range.start,endDate:range.endInclusive};
  const measures=['activeUsers','sessions','engagementRate','averageSessionDuration'];
  const totalRequest={
    dateRanges:[period],metrics:measures.map(name=>({name})),limit:'1'
  };
  const channelRequest={
    dateRanges:[period],metrics:[{name:'sessions'}],
    dimensions:[{name:'sessionDefaultChannelGroup'}],limit:'20',
    orderBys:[{metric:{metricName:'sessions'},desc:true}]
  };
  try{
    const [summary,channels]=await Promise.all([
      runReport(authorized.accessToken,totalRequest),
      runReport(authorized.accessToken,channelRequest)
    ]);
    const values=summary.rows?.[0]?.metricValues||[];
    const hasRows=Array.isArray(summary.rows)&&summary.rows.length>0;
    const metrics={
      activeUsers:hasRows?num(values[0]?.value):0,
      sessions:hasRows?num(values[1]?.value):0,
      engagementRate:hasRows?num(values[2]?.value):null,
      averageSessionDuration:hasRows?num(values[3]?.value):null
    };
    const groups=(Array.isArray(channels.rows)?channels.rows:[]).map(row=>({
      name:String(row.dimensionValues?.[0]?.value||'Unassigned').slice(0,90),
      sessions:num(row.metricValues?.[0]?.value)
    })).filter(row=>row.sessions!==null).slice(0,8);
    return {...emptyReport(range,'connected',
      metrics.sessions===0?'Google Analytics is connected. No sessions reported for these dates yet.':
      'Google Analytics traffic data is connected.'),
      connected:true,metrics,channels:groups
    };
  }catch(error){
    const status=error.status===424?'enable-api':error.status===401?'reconnect':'needs-attention';
    return emptyReport(range,status,error.message);
  }
}
export const ga4StatusEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const range=resolveReportWindow(req.query||{});
  res.json(await ga4Report(range));
});
