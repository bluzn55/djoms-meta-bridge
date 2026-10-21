// DJOMS read-only Google Analytics 4 reports for the owner's verified DOCJAKS.COM.
// OAuth deliberately reuses the existing Google Search Console callback URL registered
// in Google Cloud. The "ga-" state prefix routes consent here without touching SEO tokens.
import { AppError, PREFIX, env, config, authorize, endpoint, only, read, write, redis, seal, unseal, now, id } from './core.js';
import { resolveReportWindow, shiftDay } from './report-window.js';

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
  checkedAt:now(),metrics:emptyMetrics(),channels:[],sourceDetails:{status:'unavailable',rows:[]},
  actions:{status:'unavailable',counts:null,radioLinkClicks:null,radioLinkStatus:'unavailable',topOutboundDomains:[],
    downloadFiles:{status:'unavailable',rows:[],subtotal:null},
    eventPages:{status:'unavailable',rows:[]},radioLinks:{status:'unavailable',rows:[]}},...extra
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

async function runReport(accessToken,request,timeoutMs=18000){
  let response,data;
  try{
    response=await fetch(ANALYTICS_DATA,{
      method:'POST',
      headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},
      body:JSON.stringify(request),
      signal:AbortSignal.timeout(timeoutMs)
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
  const previousPeriod={startDate:shiftDay(range.start,-range.days),endDate:shiftDay(range.start,-1)};
  const measures=['activeUsers','sessions','engagementRate','averageSessionDuration'];
  const totalRequest={
    dateRanges:[period],metrics:measures.map(name=>({name})),limit:'1'
  };
  const channelRequest={
    dateRanges:[period],metrics:[{name:'sessions'}],
    dimensions:[{name:'sessionDefaultChannelGroup'}],limit:'20',
    orderBys:[{metric:{metricName:'sessions'},desc:true}]
  };
  // Source+medium tells Facebook apart from Instagram and distinguishes
  // Google organic search from paid ads. This is an optional read-only report.
  const sourceRequest={
    dateRanges:[period],dimensions:[{name:'sessionSourceMedium'}],
    metrics:[{name:'sessions'}],limit:'200',
    orderBys:[{metric:{metricName:'sessions'},desc:true}]
  };
  // Events are not visitors, conversions or radio listening. These remain
  // separate measured event counts, and are unavailable when Google can't report.
  const eventRequest={
    dateRanges:[period],dimensions:[{name:'eventName'}],
    metrics:[{name:'eventCount'}],limit:'100'
  };
  // Optional owner-only drilldowns. These dimensions are standard GA4 Data API
  // dimensions populated by enhanced measurement, not custom dimensions.
  // Every query uses the same selected reporting dates as the event totals.
  const downloadRequest={
    dateRanges:[period],
    dimensions:[{name:'fileName'},{name:'fileExtension'},{name:'linkUrl'}],
    metrics:[{name:'eventCount'}],limit:'100',
    dimensionFilter:{filter:{fieldName:'eventName',
      stringFilter:{matchType:'EXACT',value:'file_download'}}},
    orderBys:[{metric:{metricName:'eventCount'},desc:true}]
  };
  const actionPageRequest={
    dateRanges:[period],
    dimensions:[{name:'eventName'},{name:'pagePath'}],
    metrics:[{name:'eventCount'}],limit:'100',
    dimensionFilter:{filter:{fieldName:'eventName',
      inListFilter:{values:['form_submit','sign_up'],caseSensitive:true}}},
    orderBys:[{metric:{metricName:'eventCount'},desc:true}]
  };
  const radioUrlRequest={
    dateRanges:[period],
    dimensions:[{name:'linkDomain'},{name:'linkUrl'}],
    metrics:[{name:'eventCount'}],limit:'200',
    dimensionFilter:{filter:{fieldName:'eventName',
      stringFilter:{matchType:'EXACT',value:'click'}}},
    orderBys:[{metric:{metricName:'eventCount'},desc:true}]
  };
  const outboundRequest={
    dateRanges:[period],dimensions:[{name:'linkDomain'}],
    metrics:[{name:'eventCount'}],limit:'100',
    dimensionFilter:{filter:{fieldName:'eventName',
      stringFilter:{matchType:'EXACT',value:'click',caseSensitive:false}}}
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
    // Optional reports: their failure cannot erase verified session metrics.
    const [sourceResult,eventsResult,linksResult,downloadsResult,pagesResult,radioUrlsResult,previousEventsResult]=await Promise.allSettled([
      runReport(authorized.accessToken,sourceRequest,14000),
      runReport(authorized.accessToken,eventRequest,6500),
      runReport(authorized.accessToken,outboundRequest,6500),
      runReport(authorized.accessToken,downloadRequest,6500),
      runReport(authorized.accessToken,actionPageRequest,6500),
      runReport(authorized.accessToken,radioUrlRequest,6500),
      runReport(authorized.accessToken,{...eventRequest,dateRanges:[previousPeriod]},6500)
    ]);
    let sourceDetails={status:'unavailable',rows:[]};
    if(sourceResult.status==='fulfilled'){
      const payload=sourceResult.value;
      const entries=Array.isArray(payload.rows)?payload.rows:[];
      const complete=typeof payload.rowCount==='number'?payload.rowCount<=entries.length:
        entries.length<200;
      const parsed=entries.map(row=>({
        sourceMedium:String(row.dimensionValues?.[0]?.value||'').slice(0,120),
        sessions:num(row.metricValues?.[0]?.value)
      })).filter(row=>row.sourceMedium&&row.sessions!==null);
      if(complete&&parsed.length===entries.length)
        sourceDetails={status:'reported',rows:parsed};
    }
    let actionEvents=null,outboundDomains=null;
    if(eventsResult.status==='fulfilled'){
      const rows=eventsResult.value;
      const values=Array.isArray(rows.rows)?rows.rows:[];
      const complete=typeof rows.rowCount==='number'&&rows.rowCount>values.length?false:true;
      if(complete){
        actionEvents=Object.fromEntries(values
          .map(row=>[String(row.dimensionValues?.[0]?.value||'').slice(0,75),
            num(row.metricValues?.[0]?.value)])
          .filter(([name,value])=>name&&value!==null));
      }
    }
    if(linksResult.status==='fulfilled'){
      const rows=linksResult.value;
      const values=Array.isArray(rows.rows)?rows.rows:[];
      const complete=typeof rows.rowCount==='number'&&rows.rowCount>values.length?false:true;
      if(complete){
        outboundDomains=values.map(row=>({
          domain:String(row.dimensionValues?.[0]?.value||'').toLowerCase().slice(0,110),
          clicks:num(row.metricValues?.[0]?.value)
        })).filter(row=>row.domain&&row.clicks!==null);
      }
    }
    const counted=(name)=>actionEvents===null?null:actionEvents[name]??0;
    let priorEvents=null;
    if(previousEventsResult.status==='fulfilled'){
      const data=previousEventsResult.value,rows=Array.isArray(data.rows)?data.rows:[];
      if(typeof data.rowCount!=='number'||data.rowCount<=rows.length){
        const entries=rows.map(row=>[String(row.dimensionValues?.[0]?.value||'').slice(0,75),num(row.metricValues?.[0]?.value)]);
        if(entries.every(([name,value])=>name&&value!==null))priorEvents=Object.fromEntries(entries);
      }
    }
    const priorCount=name=>priorEvents===null?null:priorEvents[name]??0;
    const evidenceRows=(result,max)=>{
      if(result.status!=='fulfilled')return null;
      const report=result.value;
      const rows=Array.isArray(report?.rows)?report.rows:[];
      const complete=typeof report?.rowCount==='number'
        ?report.rowCount<=rows.length:rows.length<max;
      return complete?rows:null;
    };
    const safeValue=(row,column,max=500)=>
      String(row?.dimensionValues?.[column]?.value||'').slice(0,max);
    let downloadFiles={status:'unavailable',rows:[],subtotal:null};
    const fileRows=evidenceRows(downloadsResult,100);
    if(fileRows!==null){
      const rows=fileRows.map(row=>({
        fileName:safeValue(row,0,240),
        extension:safeValue(row,1,24),
        linkUrl:safeValue(row,2,900),
        events:num(row.metricValues?.[0]?.value)
      })).filter(item=>item.events!==null);
      if(rows.length===fileRows.length){
        const subtotal=rows.reduce((total,row)=>total+row.events,0);
        downloadFiles={status:counted('file_download')===subtotal?'reported':'mismatch',
          rows,subtotal};
      }
    }
    let eventPages={status:'unavailable',rows:[]};
    const pageRows=evidenceRows(pagesResult,100);
    if(pageRows!==null){
      const rows=pageRows.map(row=>({
        eventName:safeValue(row,0,40),
        pagePath:safeValue(row,1,320),
        events:num(row.metricValues?.[0]?.value)
      })).filter(item=>['form_submit','sign_up'].includes(item.eventName)&&item.events!==null);
      if(rows.length===pageRows.length){
        const complete=['form_submit','sign_up'].every(name=>
          rows.filter(row=>row.eventName===name).reduce((sum,row)=>sum+row.events,0)===counted(name));
        eventPages={status:complete?'reported':'mismatch',rows};
      }
    }
    // A click on a radio-related external domain is NOT a confirmed listener.
    const radioDomains=new Set(['radio.co','stream.radio.co','player.radio.co',
      'outlawradio5150.com','www.outlawradio5150.com']);
    const linkClicks=outboundDomains===null?null:outboundDomains
      .filter(item=>radioDomains.has(item.domain))
      .reduce((total,item)=>total+item.clicks,0);
    let radioLinks={status:'unavailable',rows:[]};
    const radioRows=evidenceRows(radioUrlsResult,200);
    if(radioRows!==null){
      const rows=radioRows.map(row=>({
        domain:safeValue(row,0,110).toLowerCase(),
        linkUrl:safeValue(row,1,900),
        clicks:num(row.metricValues?.[0]?.value)
      })).filter(row=>radioDomains.has(row.domain)&&row.clicks!==null);
      const subtotal=rows.reduce((sum,row)=>sum+row.clicks,0);
      radioLinks={status:linkClicks===subtotal?'reported':'mismatch',rows};
    }
    const actions={
      downloadFiles,eventPages,radioLinks,
      comparison:{status:priorEvents===null||actionEvents===null?'unavailable':'reported',
        previousRange:{start:previousPeriod.startDate,end:previousPeriod.endDate},
        currentRange:{start:range.start,end:range.endInclusive},
        counts:{fileDownload:{previous:priorCount('file_download'),current:counted('file_download')},
          formSubmit:{previous:priorCount('form_submit'),current:counted('form_submit')},
          signUp:{previous:priorCount('sign_up'),current:counted('sign_up')},
          generateLead:{previous:priorCount('generate_lead'),current:counted('generate_lead')},
          addToCart:{previous:priorCount('add_to_cart'),current:counted('add_to_cart')},
          beginCheckout:{previous:priorCount('begin_checkout'),current:counted('begin_checkout')}}},
      status:actionEvents===null?'unavailable':'reported',
      counts:{
        purchase:counted('purchase'),
        signUp:counted('sign_up'),
        formSubmit:counted('form_submit'),
        generateLead:counted('generate_lead'),
        addToCart:counted('add_to_cart'),
        beginCheckout:counted('begin_checkout'),
        fileDownload:counted('file_download'),
        outboundClick:counted('click')
      },
      radioLinkClicks:linkClicks,
      radioLinkStatus:outboundDomains===null?'unavailable':'reported',
      topOutboundDomains:outboundDomains===null?[]:outboundDomains
        .sort((a,b)=>b.clicks-a.clicks).slice(0,6),
      note:'GA4 counts tracked events, not unique visitors. Radio-related outbound links are clicks, not listening sessions. Wix store payments and membership status must be verified separately.'
    };
    return {...emptyReport(range,'connected',
      metrics.sessions===0?'Google Analytics is connected. No sessions reported for these dates yet.':
      'Google Analytics traffic data is connected.'),
      connected:true,metrics,channels:groups,sourceDetails,actions
    };
  }catch(error){
    const status=error.status===424?'enable-api':error.status===401?'reconnect':'needs-attention';
    return emptyReport(range,status,error.message);
  }
}
// Read-only GA4 installation check. Verified Wix Marketing Tags currently lists
// the single enabled native Google Analytics tag G-F8YLY9PXBL. Its value was
// checked directly with Wix on Oct 19, 2026. This reports an exact identity
// match, NOT proof that every visitor consented or sent a page_view event.
const KNOWN_WIX_GA4_ID='G-F8YLY9PXBL';
export const ga4VerifyEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  let saved;
  try{saved=await connection();}
  catch(error) {
    return res.json({status:'unavailable',propertyId:PROPERTY_ID,
      wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',
      message:'Google Analytics authorization needs attention. '+String(error.message||'')});
  }
  if(!saved)return res.json({status:'unavailable',propertyId:PROPERTY_ID,
    wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',
    message:'Connect Google Analytics to check its web data stream.'});
  try{
    // Google Analytics Admin API, with existing analytics.readonly scope.
    const url='https://analyticsadmin.googleapis.com/v1beta/properties/'+PROPERTY_ID+'/dataStreams?pageSize=200';
    const response=await fetch(url,{method:'GET',
      headers:{Authorization:'Bearer '+saved.accessToken,Accept:'application/json'},
      signal:AbortSignal.timeout(12000)});
    if(!response.ok){
      return res.json({status:'unavailable',propertyId:PROPERTY_ID,
        wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',
        message:response.status===403?'Google Analytics Admin API permission or enablement is needed to verify the stream.':
          response.status===401?'Reconnect Google Analytics to verify its stream.':
          'Google Analytics web stream verification is currently unavailable.'});
    }
    const data=await response.json().catch(()=>({}));
    const streams=(Array.isArray(data.dataStreams)?data.dataStreams:[])
      .filter(entry=>entry?.webStreamData&&typeof entry.webStreamData.measurementId==='string')
      .map(entry=>({
        measurementId:String(entry.webStreamData.measurementId).slice(0,40),
        defaultUri:String(entry.webStreamData.defaultUri||'').slice(0,200)
      }));
    if(data.nextPageToken)return res.json({status:'unavailable',propertyId:PROPERTY_ID,
      wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',
      message:'Google Analytics has additional streams that were not checked.'});
    const matched=streams.some(item=>item.measurementId===KNOWN_WIX_GA4_ID);
    return res.json({status:matched?'matched':'mismatch',propertyId:PROPERTY_ID,
      wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',streams,
      message:matched?
        'The GA4 property queried by Social Command contains the Wix-installed measurement ID. This confirms configuration identity, not complete event collection.':
        'The Wix measurement ID does not match any web stream in the GA4 property queried by Social Command. Verify the correct GA4 property or data stream.'});
  }catch {
    return res.json({status:'unavailable',propertyId:PROPERTY_ID,
      wixMeasurementId:KNOWN_WIX_GA4_ID,wixTagCheckedAt:'2026-10-19',
      message:'Google Analytics Admin API did not respond in time. Existing traffic reports remain unchanged.'});
  }
});

export const ga4StatusEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const range=resolveReportWindow(req.query||{});
  res.json(await ga4Report(range));
});
