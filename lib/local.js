import { AppError, PREFIX, env, config, redis, read, write, seal, unseal, authorize, endpoint, only, id, now } from './core.js';

const GOOGLE_AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN='https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE='https://www.googleapis.com/auth/business.manage';

function googleClient() {
  const clientId = env().GOOGLE_BUSINESS_CLIENT_ID || env().YOUTUBE_CLIENT_ID;
  const clientSecret = env().GOOGLE_BUSINESS_CLIENT_SECRET || env().YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new AppError('Add Google Business Profile OAuth credentials before connecting.',503);
  return {clientId,clientSecret};
}
async function googleToken(params) {
  const {clientId,clientSecret}=googleClient();
  let response,data;
  try {
    response=await fetch(GOOGLE_TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:clientId,client_secret:clientSecret}),signal:AbortSignal.timeout(12000)});
    data=await response.json();
  } catch { throw new AppError('Google Business Profile could not be reached.',502); }
  if(!response.ok || data.error) throw new AppError(data.error_description || data.error || 'Google Business Profile authorization failed.',502);
  return data;
}
async function googleConnection() {
  let saved=await read('local-google-connection');
  if(!saved) return null;
  saved=unseal(saved);
  if(saved.expiresAt && saved.expiresAt < Date.now()+60000) {
    if(!saved.refreshToken) throw new AppError('Reconnect Google Business Profile.',401);
    const token=await googleToken({grant_type:'refresh_token',refresh_token:saved.refreshToken});
    saved={...saved,accessToken:token.access_token,refreshToken:token.refresh_token || saved.refreshToken,expiresAt:Date.now()+Number(token.expires_in||3600)*1000,refreshedAt:now()};
    await write('local-google-connection',seal(saved));
  }
  return saved;
}
async function googleApi(url,accessToken,options={}) {
  let response,data;
  try {
    response=await fetch(url,{...options,headers:{Authorization:'Bearer '+accessToken,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(12000)});
    data=response.status===204?null:await response.json().catch(()=>null);
  } catch { throw new AppError('Google Business Profile could not be reached.',502); }
  if(!response.ok || data?.error) throw new AppError(data?.error?.message || 'Google Business Profile could not complete the request.',502);
  return data;
}
async function googleAccounts(accessToken) {
  const data=await googleApi('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20',accessToken);
  return data.accounts || [];
}
async function googleLocations(accessToken,accountName) {
  const url='https://mybusinessbusinessinformation.googleapis.com/v1/'+encodeURI(accountName)+'/locations?readMask=name,title,storeCode,websiteUri,phoneNumbers,categories,metadata&pageSize=100';
  const data=await googleApi(url,accessToken);
  return data.locations || [];
}
async function discoverGoogle(saved) {
  const accounts=await googleAccounts(saved.accessToken);
  const locations=[];
  for(const account of accounts.slice(0,20)) {
    try {
      const rows=await googleLocations(saved.accessToken,account.name);
      for(const location of rows) locations.push({accountName:account.name,accountLabel:account.accountName || account.name,...location});
    } catch {}
  }
  return {accounts,locations};
}
function reviewRating(review) {
  const map={ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5};
  return map[review?.starRating] || Number(review?.rating) || null;
}
async function googleReviews(saved) {
  if(!saved.accountName || !saved.locationName) return {reviews:[],averageRating:null,totalReviewCount:null,needsLocation:true};
  const parent=saved.accountName+'/'+saved.locationName;
  const url='https://mybusiness.googleapis.com/v4/'+parent+'/reviews?pageSize=50&orderBy=updateTime%20desc';
  const data=await googleApi(url,saved.accessToken);
  return {
    reviews:(data.reviews||[]).map(r=>({
      id:r.reviewId || r.name,
      name:r.name,
      author:r.reviewer?.displayName || 'Google user',
      rating:reviewRating(r),
      comment:r.comment || '',
      createTime:r.createTime || null,
      updateTime:r.updateTime || null,
      reply:r.reviewReply?.comment || null,
      replyTime:r.reviewReply?.updateTime || null
    })),
    averageRating:Number(data.averageRating)||null,
    totalReviewCount:Number(data.totalReviewCount)||0,
    needsLocation:false
  };
}
export const localGoogleConnectEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']); const session=await authorize(req); const {clientId}=googleClient();
  const state=id(); await write('local-google-oauth:'+state,{sessionId:session.id},600);
  const url=new URL(GOOGLE_AUTH);
  url.search=new URLSearchParams({
    client_id:clientId,
    redirect_uri:config().origin+'/api/meta/local-google-callback',
    response_type:'code',
    scope:GOOGLE_SCOPE,
    access_type:'offline',
    include_granted_scopes:'true',
    prompt:'consent',
    state
  }).toString();
  res.redirect(302,url.toString());
});
export const localGoogleCallbackEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']); const session=await authorize(req);
  const state=String(req.query?.state||'');
  if(!/^[a-f0-9]{36}$/.test(state)) throw new AppError('The Google Business Profile login request could not be verified.',403);
  const raw=await redis('GETDEL',PREFIX+'local-google-oauth:'+state);
  if(!raw || JSON.parse(raw).sessionId!==session.id) throw new AppError('The Google Business Profile login request expired.',403);
  if(req.query?.error) return res.redirect(303,config().origin+'/?localgoogle=cancelled');
  if(typeof req.query?.code!=='string') throw new AppError('Google did not return an authorization code.');
  const token=await googleToken({grant_type:'authorization_code',code:req.query.code,redirect_uri:config().origin+'/api/meta/local-google-callback'});
  let saved={accessToken:token.access_token,refreshToken:token.refresh_token||null,expiresAt:Date.now()+Number(token.expires_in||3600)*1000,connectedAt:now()};
  const found=await discoverGoogle(saved);
  if(found.locations.length===1) {
    saved.accountName=found.locations[0].accountName;
    saved.locationName=found.locations[0].name;
    saved.locationTitle=found.locations[0].title || found.locations[0].name;
  }
  await write('local-google-connection',seal(saved));
  await redis('DEL',PREFIX+'local-status');
  res.redirect(303,config().origin+'/?localgoogle=saved');
});
export const localGoogleSelectEndpoint=endpoint(async(req,res)=>{
  only(req,res,['POST']); await authorize(req);
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const saved=await googleConnection();
  if(!saved) throw new AppError('Connect Google Business Profile first.');
  const found=await discoverGoogle(saved);
  const selected=found.locations.find(x=>x.accountName===body?.accountName && x.name===body?.locationName);
  if(!selected) throw new AppError('Choose one of the Google Business Profile locations shown.');
  const next={...saved,accountName:selected.accountName,locationName:selected.name,locationTitle:selected.title||selected.name};
  await write('local-google-connection',seal(next));
  await redis('DEL',PREFIX+'local-status');
  res.json({success:true,location:{accountName:next.accountName,locationName:next.locationName,title:next.locationTitle}});
});
export const localGoogleReplyEndpoint=endpoint(async(req,res)=>{
  only(req,res,['POST']); await authorize(req);
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  const saved=await googleConnection();
  if(!saved?.accountName || !saved?.locationName) throw new AppError('Choose the Google Business Profile location first.');
  const reviewName=String(body?.reviewName||'');
  const comment=String(body?.comment||'').trim();
  if(!reviewName || !comment || comment.length>4096) throw new AppError('Choose a review and write a reply.');
  const prefix=saved.accountName+'/'+saved.locationName+'/reviews/';
  const reviewId=reviewName.includes('/reviews/')?reviewName.split('/reviews/').pop():reviewName;
  const url='https://mybusiness.googleapis.com/v4/'+prefix+encodeURIComponent(reviewId)+'/reply';
  await googleApi(url,saved.accessToken,{method:'PUT',body:JSON.stringify({comment})});
  res.json({success:true});
});
async function yelpData() {
  const key=env().YELP_API_KEY, business=env().YELP_BUSINESS_ID;
  if(!key || !business) return {connected:false,setup:true,message:'Add Yelp API key and business ID.'};
  const headers={Authorization:'Bearer '+key,Accept:'application/json'};
  let details,reviews;
  try {
    const d=await fetch('https://api.yelp.com/v3/businesses/'+encodeURIComponent(business),{headers,signal:AbortSignal.timeout(10000)});
    details=await d.json(); if(!d.ok) throw new Error(details?.error?.description||'Yelp business lookup failed.');
    const r=await fetch('https://api.yelp.com/v3/businesses/'+encodeURIComponent(business)+'/reviews?limit=20&sort_by=yelp_sort',{headers,signal:AbortSignal.timeout(10000)});
    reviews=await r.json(); if(!r.ok) reviews={reviews:[],warning:reviews?.error?.description||'Review access requires an eligible Yelp plan.'};
  } catch(e) { return {connected:false,message:e.message||'Yelp could not be reached.'}; }
  return {connected:true,name:details.name,rating:Number(details.rating)||null,totalReviewCount:Number(details.review_count)||0,url:details.url||null,reviews:(reviews.reviews||[]).map(x=>({id:x.id,author:x.user?.name||'Yelp user',rating:Number(x.rating)||null,comment:x.text||'',createTime:x.time_created||null,url:x.url||null})),warning:reviews.warning||null};
}
async function tripadvisorData() {
  const key=env().TRIPADVISOR_API_KEY, locationId=env().TRIPADVISOR_LOCATION_ID;
  if(!key || !locationId) return {connected:false,setup:true,message:'Add Tripadvisor API key and location ID.'};
  try {
    const detailUrl='https://api.content.tripadvisor.com/api/v1/location/'+encodeURIComponent(locationId)+'/details?key='+encodeURIComponent(key)+'&language=en&currency=USD';
    const reviewUrl='https://api.content.tripadvisor.com/api/v1/location/'+encodeURIComponent(locationId)+'/reviews?key='+encodeURIComponent(key)+'&language=en&limit=5';
    const [dr,rr]=await Promise.all([fetch(detailUrl,{signal:AbortSignal.timeout(10000)}),fetch(reviewUrl,{signal:AbortSignal.timeout(10000)})]);
    const details=await dr.json(), reviews=await rr.json();
    if(!dr.ok) throw new Error(details?.message||'Tripadvisor location lookup failed.');
    return {connected:true,name:details.name||'Tripadvisor',rating:Number(details.rating)||null,totalReviewCount:Number(details.num_reviews)||0,url:details.web_url||null,reviews:rr.ok?(reviews.data||[]).map(x=>({id:String(x.id||''),author:x.user?.username||x.user?.display_name||'Tripadvisor user',rating:Number(x.rating)||null,comment:x.text||x.review_text||'',createTime:x.published_date||x.publish_date||null,url:x.url||null,reply:x.owner_response?.text||null})):[],warning:rr.ok?null:'Tripadvisor review access is not enabled for this API plan.'};
  } catch(e) { return {connected:false,message:e.message||'Tripadvisor could not be reached.'}; }
}
export const localStatusEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']); await authorize(req);
  let google={connected:false,setup:true,message:'Connect Google Business Profile.'};
  try {
    const saved=await googleConnection();
    if(saved) {
      const found=(!saved.accountName||!saved.locationName)?await discoverGoogle(saved):null;
      const review=await googleReviews(saved);
      google={
        connected:true,
        setup:false,
        name:saved.locationTitle||'Google Business Profile',
        accountName:saved.accountName||null,
        locationName:saved.locationName||null,
        locations:found?.locations?.map(x=>({accountName:x.accountName,locationName:x.name,title:x.title||x.name}))||[],
        needsLocation:review.needsLocation,
        rating:review.averageRating,
        totalReviewCount:review.totalReviewCount,
        reviews:review.reviews,
        unanswered:review.reviews.filter(x=>!x.reply).length,
        message:review.needsLocation?'Choose which Google Business Profile location to monitor.':'Connected · reviews ready'
      };
    }
  } catch(e) { google={connected:false,message:e.message||'Reconnect Google Business Profile.'}; }
  const [yelp,tripadvisor]=await Promise.all([yelpData(),tripadvisorData()]);
  res.json({checkedAt:now(),google,yelp,tripadvisor,facebook:{connected:false,setup:true,message:'Facebook Reviews/Recommendations integration will use Meta where supported.'}});
});
