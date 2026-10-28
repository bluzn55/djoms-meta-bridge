/* DOC JAKS · Per-placecard, per-platform website attribution.
   Saved placecards receive distinct tagged links for each social channel.
   Wix confirms website visits; social services confirm post activity.
   Never claim that all post-day traffic came from a social post. */
import {AppError, PREFIX, redis, read, unseal, authorize, only, endpoint, now} from './core.js';
import {resolveReportWindow} from './report-window.js';

const BASE = 'https://www.docjaks.com/';
const PREFIX_ID = 'docjaks_post_';
const ZONE = 'America/Chicago';
const QUERY = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data';
const MODELS = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const CAMPAIGNS = {BBQ:'food', SOSS:'food', MUSIC:'music', BOOK:'book'};
// The shared social welcome is the first stop for Food, Music and Book.
// It carries the Pit Krewe Founding 100 CTA, then links to each category.
const SOCIAL_LANDING = '/post/welcome-to-doc-jaks-smokehouse';
const PLATFORMS = ['facebook','instagram','x','youtube'];
const good = value => Number.isSafeInteger(value) && value >= 0;

export function postTrackingId(record,platform) {
  if (!Object.hasOwn(CAMPAIGNS,record?.campaign) || !PLATFORMS.includes(platform)) return null;
  const id = String(record?.id||'').replace(/-/g,'').toLowerCase();
  if (!/^[a-f0-9]{32,48}$/.test(id)) return null;
  return PREFIX_ID + id + '_' + platform;
}

export function postTrackingUrl(record,platform) {
  const id=postTrackingId(record,platform);
  if (!id) return null;
  // The welcome page is the first stop for every social placecard, including
  // cards previously linked to external destinations. Visitors can then
  // choose Book, Music, Radio, Soss or the main Pit Krewe sign-up CTA.
  const url=new URL(SOCIAL_LANDING,BASE);
  url.searchParams.set('utm_source',platform);
  url.searchParams.set('utm_medium','social');
  url.searchParams.set('utm_campaign','docjaks_'+CAMPAIGNS[record.campaign]);
  url.searchParams.set('utm_id',id);
  url.searchParams.set('utm_content',CAMPAIGNS[record.campaign]);
  return url.toString();
}

// All platform copy buttons use the same shared welcome destination,
// while their card and platform UTM identifiers remain distinct.
export function placecardShareTrackingUrl(record,platform) {
  return postTrackingUrl(record,platform);
}

function centralMidnight(day) {
  const [y,m,d]=day.split('-').map(Number),target=Date.UTC(y,m-1,d);
  const parser = new Intl.DateTimeFormat('en-US',{
    timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  let guess=target;
  for(let i=0;i<4;i++){
    const parts=Object.fromEntries(parser.formatToParts(new Date(guess))
      .filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const seen=Date.UTC(+parts.year,+parts.month-1,+parts.day,
      +parts.hour,+parts.minute,+parts.second);
    guess-=seen-target;
  }
  return new Date(guess).toISOString();
}

async function wixToken() {
  const saved=await read('wix-blog-connection');
  if(!saved?.sealed) throw new Error('Connect Wix Analytics to retrieve tagged website visits.');
  const credentials=unseal(saved.sealed);
  if(!credentials?.clientId || !credentials?.clientSecret) throw new Error('Wix Headless connection needs attention.');
  const response=await fetch('https://www.wixapis.com/oauth2/token',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      grant_type:'client_credentials',
      client_id:credentials.clientId,
      client_secret:credentials.clientSecret
    }),
    signal:AbortSignal.timeout(20000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok || !data.access_token) throw new Error('Wix would not authorize visitor attribution.');
  return data.access_token;
}

async function wixRead(url,token,body=null) {
  const response=await fetch(url,{
    method:body?'POST':'GET',
    headers:{Authorization:token,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(25000)
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error('Wix campaign analytics unavailable ('+response.status+').');
  return data;
}
function numeric(value) {
  const raw=value?.numericValue;
  return good(raw)?raw:null;
}
async function wixTaggedVisits(window) {
  const token=await wixToken();
  const list=await wixRead(MODELS,token);
  const model=(list.semanticModels||[]).find(m=>m.slug==='traffic');
  if(!model?.id) throw new Error('Wix traffic report unavailable.');
  const result=new Map(),limit=100;
  for(let offset=0;offset<3000;offset+=limit){
    const data=await wixRead(QUERY,token,{
      semanticModelId:model.id,
      interval:{
        start:centralMidnight(window.start),
        end:centralMidnight(window.end),
        timezone:ZONE
      },
      fields:['traffic.utm_campaign_id','traffic.sessions_count',
        'traffic.visitors_count','traffic.views_count'],
      filters:[{field:'traffic.utm_campaign_id',condition:'START_WITH',
        prefix:'IS',values:[PREFIX_ID]}],
      paging:{limit,offset}
    });
    if(!Array.isArray(data.results) || !good(data.pagingMetadata?.count))
      throw new Error('Wix did not confirm campaign report coverage.');
    for(const row of data.results){
      const id=row?.fields?.['traffic.utm_campaign_id']?.stringValue;
      if(typeof id!=='string' || !/^docjaks_post_[a-f0-9]{32,48}_(facebook|instagram|x|youtube)$/.test(id))
        throw new Error('Unrecognized Wix post tracking identifier.');
      const sessions=numeric(row.fields?.['traffic.sessions_count']);
      const visitors=numeric(row.fields?.['traffic.visitors_count']);
      const pageViews=numeric(row.fields?.['traffic.views_count']);
      if([sessions,visitors,pageViews].some(x=>x===null)||result.has(id))
        throw new Error('Wix post tracking metrics were incomplete.');
      result.set(id,{visits:sessions,visitors,pageViews});
    }
    if(data.pagingMetadata.count<limit)return result;
  }
  throw new Error('Campaign report is too large to verify completely.');
}

async function trackableRecords() {
  const keys=await redis('ZREVRANGE', PREFIX+'records',0,499);
  const raw=keys.length?await redis('MGET',...keys.map(id=>PREFIX+'record:'+id)):[];
  const records=[];
  for(const value of raw) {
    if(!value)continue;
    try {
      const r=JSON.parse(value);
      if(!Object.hasOwn(CAMPAIGNS,r.campaign)) continue;
      if(PLATFORMS.some(p=>postTrackingId(r,p)))records.push(r);
    }catch{
      throw new Error('Some saved posting records could not be read.');
    }
  }
  return records;
}

// Only display a 1–15 placecard number when it is explicit in the post
// title. The actual stable identity is the uploaded picture's image ID.
function numberedPlacecard(record) {
  const patterns={
    BBQ:/\bBBQ[\s#_-]*0*(\d{1,2})(?!\d)/i,
    SOSS:/\b(?:BBQ|SOSS)[\s#_-]*0*(\d{1,2})(?!\d)/i,
    MUSIC:/\bMU[\s#_-]*0*(\d{1,2})(?!\d)/i,
    BOOK:/\bBK[\s#_-]*0*(\d{1,2})(?!\d)/i
  };
  const title=String(record?.title||'');
  const match=title.match(patterns[record.campaign]);
  const number=Number(match?.[1]||0);
  return number>=1&&number<=15?number:null;
}

export const postReferralsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  const window=resolveReportWindow(req.query||{});
  const records=await trackableRecords();
  let stats=new Map(),error=null;
  try { stats=await wixTaggedVisits(window); }
  catch(e) { error=String(e?.message||'Wix campaign reports are unavailable.').slice(0,180); }
  const rows=[];
  for(const record of records)for(const platform of PLATFORMS){
    const publication=record.results?.[platform]||{};
    const published=publication.status==='published' &&
      !!publication.postId && !!publication.publishedAt;
    const id=postTrackingId(record,platform);
    const autoLink=postTrackingUrl(record,platform);
    const link=placecardShareTrackingUrl(record,platform);
    const counts=id?stats.get(id):null;
    // A copied link may drive traffic before an in-app publish is recorded.
    // Include only real Wix-tagged visits or confirmed publications.
    if(!published && !counts)continue;
    // Use the actual originally posted link for historical publications,
    // even when today's default category landing page later changes.
    const publishedUrl=typeof publication.trackingUrl==='string'?
      publication.trackingUrl:null;
    let publishedWithTag=false;
    if(publishedUrl && id){
      try {
        const sent=new URL(publishedUrl);
        publishedWithTag=sent.protocol==='https:' &&
          ['docjaks.com','www.docjaks.com'].includes(sent.hostname.toLowerCase()) &&
          sent.searchParams.get('utm_id')===id;
      }catch{}
    }
    // An older untagged post must not be assigned an invented zero.
    const reportable=!error && (publishedWithTag || !!counts);
    rows.push({
      recordId:String(record.id),platform,
      campaign:record.campaign,
      postTitle:String(record.title||'Untitled post').slice(0,130),
      // An identical picture used in multiple posts keeps the SAME
      // placecardImageId, while each publication/platform keeps its own link.
      placecardImageId:typeof record.imageId==='string'&&/^[a-f0-9]{36}$/.test(record.imageId)?
        record.imageId:null,
      placecardName:String(record.placecardName||record.title||'Untitled placecard').slice(0,180),
      placecardNumber:numberedPlacecard(record),
      publishedAt:published?publication.publishedAt:null,
      trackingUrl:publishedUrl||link,
      publishedWithTag,
      taggedVisits:reportable?(counts?.visits??0):null,
      taggedVisitors:reportable?(counts?.visitors??0):null,
      taggedPageViews:reportable?(counts?.pageViews??0):null,
      metricStatus:error?'unavailable':(!autoLink&&published&&!counts)?'other-destination':
        reportable?'reported':'link-not-yet-used'
    });
  }
  res.setHeader('Cache-Control','private, no-store');
  return res.json({
    status:error?'unavailable':'reported',
    checkedAt:now(),range:{start:window.start,end:window.end},
    rows,note:'Tagged website sessions only; already included in total Wix Website Visits. Copied tracking links may be counted before DJOMS confirms a social publication. Historical untagged posts cannot be retrospectively credited.',
    ...(error?{error}:{})
  });
});
