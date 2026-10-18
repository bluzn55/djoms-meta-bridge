// Read-only Google Search Console integration. The owner must authorize
// the verified DOCJAKS.COM property before any search metrics can appear.
import { AppError, PREFIX, env, config, authorize, endpoint, only, read, write, redis, seal, unseal, now, id } from './core.js';
import { resolveReportWindow, centralDay, shiftDay } from './report-window.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const STORE = 'search-console-readonly';
const SEARCH_CONSOLE = 'https://www.googleapis.com/webmasters/v3/sites';
const ALLOWED = new Set(['sc-domain:docjaks.com','https://docjaks.com/','https://www.docjaks.com/']);

function googleCredentials() {
  const clientId=env().GOOGLE_BUSINESS_CLIENT_ID||env().YOUTUBE_CLIENT_ID;
  const clientSecret=env().GOOGLE_BUSINESS_CLIENT_SECRET||env().YOUTUBE_CLIENT_SECRET;
  if(!clientId||!clientSecret)throw new AppError('Google OAuth credentials have not been configured for Search Console.',503);
  return {clientId,clientSecret};
}
async function fetchToken(parameters) {
  const {clientId,clientSecret}=googleCredentials();
  let response,data;
  try{
    response=await fetch(GOOGLE_TOKEN,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({...parameters,client_id:clientId,client_secret:clientSecret}),
      signal:AbortSignal.timeout(16000)
    });
    data=await response.json();
  }catch {throw new AppError('Could not reach Google authorization.',502);}
  if(!response.ok||!data?.access_token)throw new AppError('Google Search Console authorization was not completed.',409);
  return data;
}
async function googleRequest(url,accessToken,body) {
  let response, data;
  try {
    response=await fetch(url,{
      method:body?'POST':'GET',
      headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:AbortSignal.timeout(16000)
    });
    data=await response.json().catch(()=>({}));
  }catch {throw new AppError('Google Search Console did not respond.',502);}
  if(!response.ok)throw new AppError(response.status===403?'Google Search Console access or API permission is missing.':
    response.status===401?'Reconnect Google Search Console.':'Google Search Console did not return its report.',502);
  return data||{};
}
async function stored() {
  const sealed=await read(STORE);
  if(!sealed)return null;
  let value=unseal(sealed);
  if(value.expiresAt && value.expiresAt<Date.now()+60000) {
    if(!value.refreshToken)throw new AppError('Reconnect Google Search Console.',401);
    const token=await fetchToken({grant_type:'refresh_token',refresh_token:value.refreshToken});
    value={...value,accessToken:token.access_token,
      refreshToken:token.refresh_token||value.refreshToken,
      expiresAt:Date.now()+Number(token.expires_in||3600)*1000};
    await write(STORE,seal(value));
  }
  return value;
}
export const seoConnectEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  const owner=await authorize(req);
  const {clientId}=googleCredentials();
  const state=id();
  await write('seo-oauth:'+state,{sessionId:owner.id},600);
  const redirectUri=config().origin+'/api/meta/seo-callback';
  const url=new URL(GOOGLE_AUTH);
  url.search=new URLSearchParams({
    client_id:clientId,redirect_uri:redirectUri,response_type:'code',
    scope:SCOPE,access_type:'offline',include_granted_scopes:'true',prompt:'consent',state
  }).toString();
  res.redirect(302,url.toString());
});
export const seoCallbackEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  const owner=await authorize(req);
  const state=String(req.query?.state||'');
  if (/^ga-[a-f0-9]{36}$/.test(state)) {
    const { handleGa4Callback }=await import('./google-analytics.js');
    return handleGa4Callback(req,res);
  }
  if(!/^[a-f0-9]{36}$/.test(state))throw new AppError('Search Console sign-in request cannot be verified.',403);
  const raw=await redis('GETDEL',PREFIX+'seo-oauth:'+state);
  if(!raw||JSON.parse(raw).sessionId!==owner.id)throw new AppError('Search Console sign-in expired.',403);
  if(req.query?.error)return res.redirect(303,config().origin+'/?seo=cancelled');
  if(typeof req.query?.code!=='string')throw new AppError('Google did not send an authorization code.');
  const response=await fetchToken({
    grant_type:'authorization_code',code:req.query.code,
    redirect_uri:config().origin+'/api/meta/seo-callback'
  });
  const entries=await googleRequest(SEARCH_CONSOLE,response.access_token);
  const verified=(Array.isArray(entries.siteEntry)?entries.siteEntry:[])
    .filter(entry=>ALLOWED.has(entry.siteUrl)&&entry.permissionLevel!=='siteUnverifiedUser')
    .map(entry=>entry.siteUrl);
  const property=verified.includes('sc-domain:docjaks.com')?'sc-domain:docjaks.com':
    verified.includes('https://www.docjaks.com/')?'https://www.docjaks.com/':
    verified.includes('https://docjaks.com/')?'https://docjaks.com/':null;
  const prior=await read(STORE).catch(()=>null);
  const previous=prior?unseal(prior):{};
  await write(STORE,seal({
    accessToken:response.access_token,
    refreshToken:response.refresh_token||previous.refreshToken||null,
    expiresAt:Date.now()+Number(response.expires_in||3600)*1000,
    property,connectedAt:now()
  }));
  return res.redirect(303,config().origin+'/?seo='+(property?'connected':'verify'));
});
const nullMetrics=()=>({clicks:null,impressions:null,ctr:null,position:null});
const noData=(window,status,message,extra={})=>({
  connected:false,status,message,range:window,checkedAt:now(),
  metrics:nullMetrics(),topQueries:[],topPages:[],
  indexing:{available:false,message:'Review indexing issues directly in Google Search Console.',
    url:'https://search.google.com/search-console'},...extra
});
const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
export async function searchConsoleReport(window) {
  let connection;
  try{connection=await stored();}
  catch(error){return noData(window,'reconnect',error.message);}
  if(!connection)return noData(window,'not-connected','Connect Google Search Console to see actual SEO data.');
  if(!ALLOWED.has(connection.property))return noData(window,'verify','Verify the DOCJAKS.COM property in Google Search Console.');
  const earliest=shiftDay(centralDay(),-2);
  const last=window.endInclusive<earliest?window.endInclusive:earliest;
  const basic={property:connection.property,reportedThrough:last};
  if(window.start>last)return noData(window,'delayed','Google search data usually arrives about two days later.',
    {...basic,connected:true});
  const url=SEARCH_CONSOLE+'/'+encodeURIComponent(connection.property)+'/searchAnalytics/query';
  const requestBase={startDate:window.start,endDate:last,type:'web',dataState:'final'};
  try{
    const [summary,queries,pages]=await Promise.all([
      googleRequest(url,connection.accessToken,{...requestBase,dimensions:[],rowLimit:1}),
      googleRequest(url,connection.accessToken,{...requestBase,dimensions:['query'],rowLimit:5}),
      googleRequest(url,connection.accessToken,{...requestBase,dimensions:['page'],rowLimit:5})
    ]);
    const raw=summary?.rows?.[0]||{};
    const items=source=>Array.isArray(source?.rows)?source.rows:[];
    return {...noData(window,'connected','Google Search Console connected. Recent search numbers can be delayed.',basic),
      connected:true,metrics:{
        clicks:numeric(raw.clicks),impressions:numeric(raw.impressions),
        ctr:numeric(raw.ctr),position:numeric(raw.position)
      },
      topQueries:items(queries).map(r=>({
        query:String(r.keys?.[0]||''),clicks:numeric(r.clicks),
        impressions:numeric(r.impressions),ctr:numeric(r.ctr),position:numeric(r.position)
      })),
      topPages:items(pages).map(r=>({
        page:String(r.keys?.[0]||''),clicks:numeric(r.clicks),
        impressions:numeric(r.impressions),ctr:numeric(r.ctr),position:numeric(r.position)
      }))
    };
  }catch(error) {
    return noData(window,'needs-attention',error.message,basic);
  }
}
export const seoStatusEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);await authorize(req);
  const window=resolveReportWindow(req.query||{});
  res.json(await searchConsoleReport(window));
});
