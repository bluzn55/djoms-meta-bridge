import { AppError, PREFIX, authorize, endpoint, only, input, read, write, redis, now, seal, unseal } from './core.js';
import { resolveReportWindow } from './report-window.js';

const SITE_ID = '6e5a4b9f-f175-4869-83d5-fecdaf5ad976';
const BLOG_APP_ID = '14bcded7-0066-7c35-14d7-466cb3f09103';
const CONNECTION_KEY = 'wix-blog-connection';

function clean(value, max, label) {
  if (typeof value !== 'string') throw new AppError(label + ' is required.');
  const text = value.trim();
  if (!text || text.length > max) throw new AppError(label + ' is not valid.');
  return text;
}

async function savedConnection() {
  const saved = await read(CONNECTION_KEY);
  if (!saved?.sealed) return null;
  try {
    const value = unseal(saved.sealed);
    if (!value?.clientId || !value?.clientSecret) return null;
    return value;
  } catch {
    return null;
  }
}

async function accessToken(connection) {
  let response, data;
  try {
    response = await fetch('https://www.wixapis.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: connection.clientId,
        client_secret: connection.clientSecret
      }),
      signal: AbortSignal.timeout(20000)
    });
    data = await response.json();
  } catch {
    throw new AppError('Wix authorization could not be reached. Try again in a moment.', 503);
  }
  if (!response.ok || !data?.access_token) {
    throw new AppError('Wix Blog authorization needs attention. Check the Headless client ID, secret, and permissions.', 409);
  }
  return data.access_token;
}

async function wixRequest(token, url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new AppError('Wix could not be reached. Try again in a moment.', 503);
  }
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const message = data?.message || data?.details?.applicationError?.description || data?.error || 'Wix rejected the Blog connection.';
    if (response.status === 401 || response.status === 403) throw new AppError('Wix Blog authorization needs attention. Check the Headless client credentials.', 409);
    throw new AppError(message, response.status);
  }
  return data;
}

async function queryPosts(token) {
  const data = await wixRequest(token, 'https://www.wixapis.com/v3/posts/query', {
    method: 'POST',
    body: { query: { cursorPaging: { limit: 100 } } }
  });
  return data.posts || [];
}

async function queryComments(token, referenceId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const query = {
      filter: { resourceId: referenceId },
      cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) }
    };
    const data = await wixRequest(token, 'https://www.wixapis.com/comments/v1/comments/query-cursor', {
      method: 'POST',
      body: { appId: BLOG_APP_ID, query }
    });
    out.push(...(data.comments || []));
    cursor = data.pagingMetadata?.cursors?.next || null;
    if (!cursor) break;
  }
  return out;
}

function richText(content) {
  const pieces = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TEXT' && typeof node.textData?.text === 'string') pieces.push(node.textData.text);
    for (const child of node.nodes || []) walk(child);
  }
  for (const node of content?.richContent?.nodes || []) walk(node);
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

function createdAt(comment) {
  return comment.commentDate || comment.createdDate || comment.updatedDate || null;
}

function postUrl(post) {
  const base = post.url?.base || 'https://www.docjaks.com';
  const path = post.url?.path || (post.slug ? '/post/' + encodeURIComponent(post.slug) : '');
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

async function ownReply(id) {
  return !!(id && await read('wix-blog-own-reply:' + id));
}

async function normalizePostThreads(post, comments) {
  const byId = new Map(comments.map(c => [c.id, c]));
  const rootFor = comment => {
    let current = comment;
    const seen = new Set();
    while (current?.parentComment?.id && !seen.has(current.parentComment.id)) {
      seen.add(current.parentComment.id);
      const parent = byId.get(current.parentComment.id);
      if (!parent) return current.parentComment.id;
      current = parent;
    }
    return current?.id || comment.id;
  };

  const groups = new Map();
  for (const comment of comments) {
    const rootId = rootFor(comment);
    if (!groups.has(rootId)) groups.set(rootId, []);
    groups.get(rootId).push(comment);
  }

  const items = [];
  for (const [rootId, thread] of groups) {
    const external = [];
    for (const comment of thread) {
      const isPostAuthor = !!(post.memberId && comment.author?.identity?.memberId === post.memberId);
      const isCommandReply = await ownReply(comment.id);
      if (!isPostAuthor && !isCommandReply) external.push(comment);
    }
    if (!external.length) continue;
    external.sort((a, b) => Date.parse(createdAt(a) || 0) - Date.parse(createdAt(b) || 0));
    const latest = external.at(-1);
    const state = await read('wix-blog-thread:' + rootId);
    const latestTime = Date.parse(createdAt(latest) || 0);
    const handledTime = Date.parse(state?.handledAt || 0);
    const handled = Number.isFinite(handledTime) && handledTime >= latestTime;
    const authorName = latest.author?.authorName || (latest.author?.identity?.memberId ? 'Blog member' : 'Blog reader');

    items.push({
      platform: 'blog',
      id: rootId,
      parentId: latest.id,
      referenceId: post.referenceId || post.id,
      postId: post.id,
      postTitle: post.title || 'From Doc\'s Porch',
      author: authorName,
      text: richText(latest.content) || 'New Blog comment',
      publishedAt: createdAt(latest),
      handled,
      handledAt: handled ? state.handledAt : null,
      openUrl: postUrl(post)
    });
  }
  return items;
}

async function loadBlogComments(connection) {
  const token = await accessToken(connection);
  const posts = await queryPosts(token);
  const items = [];
  for (const post of posts) {
    const referenceId = post.referenceId || post.id;
    if (!referenceId || post.commentingEnabled === false) continue;
    const comments = await queryComments(token, referenceId);
    items.push(...await normalizePostThreads({ ...post, referenceId }, comments));
  }
  items.sort((a,b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  return items;
}

async function createReply(connection, referenceId, parentId, message) {
  const token = await accessToken(connection);
  const idPart = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const stamp = now();
  const body = {
    comment: {
      appId: BLOG_APP_ID,
      contextId: referenceId,
      resourceId: referenceId,
      content: {
        richContent: {
          nodes: [{
            type: 'PARAGRAPH',
            id: idPart(),
            nodes: [{
              type: 'TEXT',
              id: idPart(),
              textData: { text: message, decorations: [] }
            }],
            paragraphData: {}
          }],
          metadata: { version: 1, createdTimestamp: stamp, updatedTimestamp: stamp, id: idPart() }
        }
      },
      parentComment: { id: parentId }
    }
  };
  return wixRequest(token, 'https://www.wixapis.com/comments/v1/comments', { method:'POST', body });
}


function wixLocalDate(date, timeZone='America/Chicago') {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function addLocalDays(ymd, days) {
  const [year,month,day]=ymd.split('-').map(Number);
  const date=new Date(Date.UTC(year,month-1,day+days));
  return date.toISOString().slice(0,10);
}
function localMidnightUtc(ymd, timeZone='America/Chicago') {
  const [year,month,day]=ymd.split('-').map(Number);
  const target=Date.UTC(year,month-1,day,0,0,0);
  let guess=target;
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
      timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).formatToParts(new Date(guess)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    const localAsUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
    guess-=localAsUtc-target;
  }
  return new Date(guess).toISOString();
}
function analyticsTotal(data, type) {
  const row=(data?.data||[]).find(x=>x.type===type);
  return row && Number.isFinite(Number(row.total)) ? Number(row.total) : 0;
}
function semanticNumber(value) {
  const raw=value?.numericValue;
  if(raw===null||raw===undefined||raw==='')return null;
  const n=Number(raw);
  return Number.isFinite(n)&&n>=0?n:null;
}
function semanticString(value) {
  return typeof value?.stringValue==='string'?value.stringValue:null;
}
const WIX_RANGE_DAYS = Object.freeze({today:1, '7d':7, '30d':30, '365d':365});
// Comparison windows are consecutive equal-length periods in Central time.
// An unfinished current day is labelled partial; missing data is not zero.
export function wixVisitorComparison(currentVisitors, previousVisitors, range, currentStart, previousStart,customDays=null) {
  const length=WIX_RANGE_DAYS[range]||customDays;
  const base={
    metric:'visitors',
    unit:'distinct visitors reported by Wix',
    selection:range,
    days:length,
    current:{start:currentStart,end:addLocalDays(currentStart,length-1)},
    previous:{start:previousStart,end:addLocalDays(currentStart,-1)},
    currentVisitors:Number.isFinite(currentVisitors)&&currentVisitors>=0?currentVisitors:null,
    previousVisitors:Number.isFinite(previousVisitors)&&previousVisitors>=0?previousVisitors:null,
    currentPeriodIncludesToday:true,
    todayIsPartial:range==='today',
    percentChange:null,
    direction:'unavailable',
    note:range==='today'?'Today is incomplete; yesterday is a full day.':range==='custom'?'User-selected inclusive date range compared with preceding matching dates.':'Equal-length consecutive periods, including today so far.'
  };
  if(base.currentVisitors===null||base.previousVisitors===null) return base;
  if(base.previousVisitors===0){
    return {...base,direction:base.currentVisitors>0?'new':'no-baseline'};
  }
  const change=(base.currentVisitors-base.previousVisitors)/base.previousVisitors*100;
  if(!Number.isFinite(change))return base;
  const rounded=Math.round(change*10)/10;
  return {...base,percentChange:rounded,direction:rounded>0?'up':rounded<0?'down':'flat'};
}

export function wixValueComparison(metric, currentValue, previousValue, lowerIsBetter=false) {
  const valid=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const current=valid(currentValue)?currentValue:null;
  const previous=valid(previousValue)?previousValue:null;
  const result={metric,current,previous,percentChange:null,direction:'unavailable',lowerIsBetter};
  if(current===null||previous===null)return result;
  if(previous===0)return {...result,direction:current>0?'new':'no-baseline'};
  const percent=Math.round(((current-previous)/previous)*1000)/10;
  if(!Number.isFinite(percent))return result;
  return {...result,percentChange:percent,direction:percent>0?'up':percent<0?'down':'flat'};
}

function verifiedSummaryTotal(summary,type) {
  const row=(summary?.data||[]).find(entry=>entry?.type===type);
  if(!row||row.total===null||row.total===undefined||row.total==='')return null;
  const total=Number(row.total);
  return Number.isFinite(total)&&total>=0?total:null;
}


const WIX_RANGE_LABELS = Object.freeze({today:'Today', '7d':'Last 7 days', '30d':'Last 30 days', '365d':'Last 365 days', custom:'Custom dates'});

export async function wixSiteStatus(range='7d',customWindow={}) {
  const requestWindow=(range==='custom' && customWindow?.range==='custom' && customWindow.start && customWindow.end && Number.isInteger(customWindow.days))
    ? customWindow : resolveReportWindow(range==='custom'?{range,...customWindow}:{range});
  const connection=await savedConnection();
  if(!connection) return {connected:false,setup:true,message:'Connect Wix website data.'};
  const timeZone='America/Chicago';
  try {
    const token=await accessToken(connection);
    const today=wixLocalDate(new Date(),timeZone);
    const start=requestWindow.start;
    const end=requestWindow.end;

    const summaryUrl=new URL('https://www.wixapis.com/analytics-ng/v2/site-analytics/data');
    summaryUrl.searchParams.set('dateRange.startDate',start);
    summaryUrl.searchParams.set('dateRange.endDate',end);
    summaryUrl.searchParams.set('timeZone',timeZone);
    ['TOTAL_SESSIONS','TOTAL_UNIQUE_VISITORS','CLICKS_TO_CONTACT','TOTAL_FORMS_SUBMITTED','TOTAL_ORDERS','TOTAL_SALES']
      .forEach(type=>summaryUrl.searchParams.append('measurementTypes',type));
    // Fetch only the previous period's unique visitor total, never guessed by
    // adding daily or weekly visitors (which would double-count returnees).
    const previousStart=addLocalDays(start,-requestWindow.days);
    const previousUrl=new URL('https://www.wixapis.com/analytics-ng/v2/site-analytics/data');
    previousUrl.searchParams.set('dateRange.startDate',previousStart);
    previousUrl.searchParams.set('dateRange.endDate',start);
    previousUrl.searchParams.set('timeZone',timeZone);
    ['TOTAL_SESSIONS','TOTAL_UNIQUE_VISITORS','CLICKS_TO_CONTACT','TOTAL_FORMS_SUBMITTED']
      .forEach(type=>previousUrl.searchParams.append('measurementTypes',type));
    const previousSummaryJob=wixRequest(token,previousUrl.toString()).catch(()=>null);
    const summary=await wixRequest(token,summaryUrl.toString());

    let pageViews=null,topPage=null,topPageViews=null,partial=false;
    let topPages=[],previousTopPages=[],weekly=[],trafficSources=[],trafficSourcesComplete=false;
    let trafficSourcesPrevious=[],trafficSourcesPreviousComplete=false;
    let devices=[],visitorTypes=[],geography=[],landingPages=[],exitPages=[];
    let pagesPerSession=null,avgTimeSeconds=null,bounceRate=null;
    // Owner chart is optional; never change the six existing Wix KPI values.
    let missionTrend={status:'unavailable',granularity:requestWindow.days>45?'week':'day',points:[],note:'Dated Wix activity unavailable.'};
    // Keep prior values separate: missing permissions or measurements must
    // show a dash rather than silently making the previous period zero.
    let priorPageViews=null,priorAvgTimeSeconds=null,priorBounceRate=null,priorPagesPerSession=null;
    let priorReturningVisitors=null,priorSessions=null;
    try {
      const models=await wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models');
      const traffic=(models.semanticModels||[]).find(x=>x.slug==='traffic');
      if(traffic?.id){
        const currentInterval={start:localMidnightUtc(start,timeZone),end:localMidnightUtc(end,timeZone),timezone:timeZone};
        const trendStart=range==='7d'?addLocalDays(today,-27):start;
        const trendInterval={start:localMidnightUtc(trendStart,timeZone),end:localMidnightUtc(end,timeZone),timezone:timeZone};
        const previousInterval={start:localMidnightUtc(previousStart,timeZone),end:localMidnightUtc(start,timeZone),timezone:timeZone};
        const query=(interval,fields,extra={})=>wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data',{
          method:'POST',
          body:{semanticModelId:traffic.id,interval,fields,formattingEnabled:true,...extra}
        });

        const graphGranularity=requestWindow.days>45?'WEEK':'DAY';
        const graphFilter={filters:[{field:'timeframeGranularity',condition:'EQUAL',prefix:'IS',values:[graphGranularity]}],sort:{fieldName:'traffic.created_timeframe',order:'ASC',nullsLast:true},paging:{limit:graphGranularity==='WEEK'?72:370,offset:0}};
        const [pagesData,engagementData,weeklyData,sourcesData,devicesData,visitorData,geoData,landingData,exitData,priorEngagementData,priorVisitorData,graphTotals,graphVisitors,priorSourcesData,priorPagesData]=await Promise.all([
          query(currentInterval,
            ['traffic.page_url_from','traffic.views_count','traffic.visitors_count','traffic.sessions_count','traffic.page_time_seconds_avg','traffic.page_bounce_ratio'],
            {sort:{fieldName:'traffic.views_count',order:'DESC',nullsLast:true},paging:{limit:12,offset:0}}
          ),
          query(currentInterval,
            ['traffic.sessions_count','traffic.visitors_count','traffic.views_count','traffic.site_time_seconds_avg','traffic.pages_per_session_avg','traffic.site_bounce_ratio'],
            {paging:{limit:1,offset:0},totalsIncluded:true}
          ),
          query(trendInterval,
            ['traffic.created_timeframe','traffic.sessions_count','traffic.visitors_count','traffic.views_count','traffic.site_time_seconds_avg','traffic.pages_per_session_avg','traffic.site_bounce_ratio'],
            {filters:[{field:'timeframeGranularity',condition:'EQUAL',prefix:'IS',values:['WEEK']}],sort:{fieldName:'traffic.created_timeframe',order:'ASC',nullsLast:true},paging:{limit:range==='365d'?60:10,offset:0}}
          ),
          query(currentInterval,
            ['traffic.referrer_category_name','traffic.referrer_source_name','traffic.sessions_count'],
            {sort:{fieldName:'traffic.sessions_count',order:'DESC',nullsLast:true},paging:{limit:100,offset:0}}
          ),
          query(currentInterval,
            ['traffic.device_type','traffic.sessions_count'],
            {sort:{fieldName:'traffic.sessions_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ),
          query(currentInterval,
            ['traffic.visitor_type','traffic.visitors_count'],
            {sort:{fieldName:'traffic.visitors_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ),
          query(currentInterval,
            ['traffic.city','traffic.region','traffic.country_name','traffic.visitors_count'],
            {sort:{fieldName:'traffic.visitors_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ),
          query(currentInterval,
            ['traffic.page_url_from','traffic.sessions_count'],
            {filters:[{field:'traffic.landing_page_flag',condition:'EQUAL',prefix:'IS',values:['true']}],sort:{fieldName:'traffic.sessions_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ),
          query(currentInterval,
            ['traffic.page_url_from','traffic.sessions_count'],
            {filters:[{field:'traffic.last_page_in_session_flag',condition:'EQUAL',prefix:'IS',values:['true']}],sort:{fieldName:'traffic.sessions_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ),
          // Prior-period analytics are optional for each trend, not for the
          // primary report. A failed comparison must not hide live results.
          query(previousInterval,
            ['traffic.sessions_count','traffic.visitors_count','traffic.views_count','traffic.site_time_seconds_avg','traffic.pages_per_session_avg','traffic.site_bounce_ratio'],
            {paging:{limit:1,offset:0},totalsIncluded:true}
          ).catch(()=>null),
          query(previousInterval,
            ['traffic.visitor_type','traffic.visitors_count'],
            {sort:{fieldName:'traffic.visitors_count',order:'DESC',nullsLast:true},paging:{limit:10,offset:0}}
          ).catch(()=>null),
          // The chart uses separately reported DAY/WEEK buckets, not period totals.
          query(currentInterval,
            ['traffic.created_timeframe','traffic.visitors_count','traffic.views_count','traffic.site_time_seconds_avg','traffic.site_bounce_ratio'],graphFilter
          ).catch(()=>null),
          query(currentInterval,
            ['traffic.created_timeframe','traffic.visitor_type','traffic.visitors_count'],graphFilter
          ).catch(()=>null),
          // Optional preceding-period source and page metrics. Current Wix
          // analytics must remain available even when these calls fail.
          query(previousInterval,
            ['traffic.referrer_category_name','traffic.referrer_source_name','traffic.sessions_count'],
            {sort:{fieldName:'traffic.sessions_count',order:'DESC',nullsLast:true},paging:{limit:100,offset:0}}
          ).catch(()=>null),
          query(previousInterval,
            ['traffic.page_url_from','traffic.views_count','traffic.visitors_count','traffic.sessions_count','traffic.page_time_seconds_avg','traffic.page_bounce_ratio'],
            {sort:{fieldName:'traffic.views_count',order:'DESC',nullsLast:true},paging:{limit:12,offset:0}}
          ).catch(()=>null)
        ]);

        topPages=(pagesData?.results||[]).map(row=>({
          path:semanticString(row.fields?.['traffic.page_url_from']),
          views:semanticNumber(row.fields?.['traffic.views_count']),
          visitors:semanticNumber(row.fields?.['traffic.visitors_count']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count']),
          avgTimeSeconds:semanticNumber(row.fields?.['traffic.page_time_seconds_avg']),
          bounceRate:semanticNumber(row.fields?.['traffic.page_bounce_ratio'])
        })).filter(x=>x.path);
        topPage=topPages[0]?.path||null;
        topPageViews=topPages[0]?.views??null;
        previousTopPages=(priorPagesData?.results||[]).map(row=>({
          path:semanticString(row.fields?.['traffic.page_url_from']),
          views:semanticNumber(row.fields?.['traffic.views_count']),
          avgTimeSeconds:semanticNumber(row.fields?.['traffic.page_time_seconds_avg']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(row=>row.path);

        const engagement=engagementData?.results?.[0]?.fields||engagementData?.totals?.fields||{};
        const totals=engagementData?.totals?.fields||{};
        pageViews=semanticNumber(totals['traffic.views_count']);
        pagesPerSession=semanticNumber(engagement['traffic.pages_per_session_avg']) ?? semanticNumber(totals['traffic.pages_per_session_avg']);
        avgTimeSeconds=semanticNumber(engagement['traffic.site_time_seconds_avg']) ?? semanticNumber(totals['traffic.site_time_seconds_avg']);
        bounceRate=semanticNumber(engagement['traffic.site_bounce_ratio']) ?? semanticNumber(totals['traffic.site_bounce_ratio']);

        const priorEngagement=priorEngagementData?.results?.[0]?.fields||priorEngagementData?.totals?.fields||{};
        const priorTotals=priorEngagementData?.totals?.fields||{};
        priorPageViews=semanticNumber(priorTotals['traffic.views_count']);
        priorAvgTimeSeconds=semanticNumber(priorEngagement['traffic.site_time_seconds_avg'])
          ?? semanticNumber(priorTotals['traffic.site_time_seconds_avg']);
        priorBounceRate=semanticNumber(priorEngagement['traffic.site_bounce_ratio'])
          ?? semanticNumber(priorTotals['traffic.site_bounce_ratio']);
        priorSessions=semanticNumber(priorEngagement['traffic.sessions_count'])
          ?? semanticNumber(priorTotals['traffic.sessions_count']);
        priorPagesPerSession=semanticNumber(priorEngagement['traffic.pages_per_session_avg'])
          ?? semanticNumber(priorTotals['traffic.pages_per_session_avg']);
        const priorReturnRow=(priorVisitorData?.results||[]).find(row=>
          semanticString(row.fields?.['traffic.visitor_type'])==='returning_visitor');
        priorReturningVisitors=priorReturnRow
          ? semanticNumber(priorReturnRow.fields?.['traffic.visitors_count']):null;

        // Do not sum distinct visitors or average bounce/time across dates.
        // Each point is an independent time bucket returned by Wix.
        if(Array.isArray(graphTotals?.results)) {
          const dates=new Map(),seen=new Set();
          let trustworthy=true;
          for(const row of graphTotals.results) {
            const fields=row?.fields||{};
            const stamp=fields['traffic.created_timeframe']?.timestampValue;
            if(!stamp||!Number.isFinite(Date.parse(stamp))) {trustworthy=false;break;}
            const bucketDate=wixLocalDate(new Date(stamp),timeZone);
            if(seen.has(bucketDate)){trustworthy=false;break;}
            seen.add(bucketDate);
            dates.set(bucketDate,{
              date:bucketDate,
              visitors:semanticNumber(fields['traffic.visitors_count']),
              pageViews:semanticNumber(fields['traffic.views_count']),
              avgStaySeconds:semanticNumber(fields['traffic.site_time_seconds_avg']),
              bounceRate:semanticNumber(fields['traffic.site_bounce_ratio']),
              returningVisitors:null,
              contactActions:null
            });
          }
          if(Array.isArray(graphVisitors?.results)&&trustworthy) {
            const returned=new Map();
            for(const row of graphVisitors.results){
              const fields=row?.fields||{};
              const stamp=fields['traffic.created_timeframe']?.timestampValue;
              const visitorType=semanticString(fields['traffic.visitor_type']);
              const value=semanticNumber(fields['traffic.visitors_count']);
              if(!stamp||!Number.isFinite(Date.parse(stamp))||!visitorType){trustworthy=false;break;}
              if(visitorType!=='returning_visitor')continue;
              const bucket=wixLocalDate(new Date(stamp),timeZone);
              if(returned.has(bucket)){trustworthy=false;break;}
              returned.set(bucket,value);
            }
            if(trustworthy)for(const [bucket,value] of returned) {
              if(dates.has(bucket))dates.get(bucket).returningVisitors=value;
            }
          }
          if(trustworthy) {
            const points=[...dates.values()].sort((a,b)=>a.date.localeCompare(b.date));
            missionTrend={
              status:points.length>1?'reported':'insufficient',
              granularity:graphGranularity.toLowerCase(),points,
              note:'Wix date-bucket measurements. Daily/weekly distinct visitors cannot be summed into period-unique visitors. Contact Actions has no verified dated series.'
            };
          }
        }

        weekly=(weeklyData?.results||[]).map(row=>({
          start:row.fields?.['traffic.created_timeframe']?.timestampValue||null,
          label:row.fields?.['traffic.created_timeframe']?.formattedValue||'',
          sessions:semanticNumber(row.fields?.['traffic.sessions_count']),
          visitors:semanticNumber(row.fields?.['traffic.visitors_count']),
          views:semanticNumber(row.fields?.['traffic.views_count']),
          avgTimeSeconds:semanticNumber(row.fields?.['traffic.site_time_seconds_avg']),
          pagesPerSession:semanticNumber(row.fields?.['traffic.pages_per_session_avg']),
          bounceRate:semanticNumber(row.fields?.['traffic.site_bounce_ratio'])
        })).filter(x=>x.start);

        trafficSources=(sourcesData?.results||[]).map(row=>({
          category:semanticString(row.fields?.['traffic.referrer_category_name']),
          source:semanticString(row.fields?.['traffic.referrer_source_name']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(x=>x.category||x.source);
        // An absent platform means zero only when Wix returned the complete
        // grouped session report. Otherwise treat absence as unknown (N/A).
        trafficSourcesComplete=Array.isArray(sourcesData?.results)&&
          sourcesData.results.length<100&&
          sourcesData?.pagingMetadata?.hasNext!==true&&
          trafficSources.every(row=>row.sessions!==null);
        trafficSourcesPrevious=(priorSourcesData?.results||[]).map(row=>({
          category:semanticString(row.fields?.['traffic.referrer_category_name']),
          source:semanticString(row.fields?.['traffic.referrer_source_name']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(row=>row.category||row.source);
        trafficSourcesPreviousComplete=Array.isArray(priorSourcesData?.results)&&
          priorSourcesData.results.length<100&&
          priorSourcesData?.pagingMetadata?.hasNext!==true&&
          trafficSourcesPrevious.every(row=>row.sessions!==null);

        devices=(devicesData?.results||[]).map(row=>({
          device:semanticString(row.fields?.['traffic.device_type']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(x=>x.device);

        visitorTypes=(visitorData?.results||[]).map(row=>({
          type:semanticString(row.fields?.['traffic.visitor_type']),
          visitors:semanticNumber(row.fields?.['traffic.visitors_count'])
        })).filter(x=>x.type);

        geography=(geoData?.results||[]).map(row=>({
          city:semanticString(row.fields?.['traffic.city']),
          region:semanticString(row.fields?.['traffic.region']),
          country:semanticString(row.fields?.['traffic.country_name']),
          visitors:semanticNumber(row.fields?.['traffic.visitors_count'])
        })).filter(x=>x.city||x.region||x.country);

        landingPages=(landingData?.results||[]).map(row=>({
          path:semanticString(row.fields?.['traffic.page_url_from']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(x=>x.path);

        exitPages=(exitData?.results||[]).map(row=>({
          path:semanticString(row.fields?.['traffic.page_url_from']),
          sessions:semanticNumber(row.fields?.['traffic.sessions_count'])
        })).filter(x=>x.path);
      } else partial=true;
    } catch { partial=true; }

    const priorSummary=await previousSummaryJob;
    const visitorComparison=wixVisitorComparison(
      verifiedSummaryTotal(summary,'TOTAL_UNIQUE_VISITORS'),
      verifiedSummaryTotal(priorSummary,'TOTAL_UNIQUE_VISITORS'),
      range,start,previousStart,requestWindow.days
    );
    const strictActions=report=>{
      const clicks=verifiedSummaryTotal(report,'CLICKS_TO_CONTACT');
      const forms=verifiedSummaryTotal(report,'TOTAL_FORMS_SUBMITTED');
      return clicks===null||forms===null?null:clicks+forms;
    };
    const returning=visitorTypes.find(row=>row.type==='returning_visitor')?.visitors??null;
    const metricComparisons={
      visitors:visitorComparison,
      sessions:wixValueComparison('sessions',analyticsTotal(summary,'TOTAL_SESSIONS'),
        verifiedSummaryTotal(priorSummary,'TOTAL_SESSIONS')??priorSessions),
      clicksToContact:wixValueComparison('clicksToContact',
        verifiedSummaryTotal(summary,'CLICKS_TO_CONTACT'),
        verifiedSummaryTotal(priorSummary,'CLICKS_TO_CONTACT')),
      formsSubmitted:wixValueComparison('formsSubmitted',
        verifiedSummaryTotal(summary,'TOTAL_FORMS_SUBMITTED'),
        verifiedSummaryTotal(priorSummary,'TOTAL_FORMS_SUBMITTED')),
      returningVisitors:wixValueComparison('returningVisitors',returning,priorReturningVisitors),
      pageViews:wixValueComparison('pageViews',pageViews,priorPageViews),
      avgTimeSeconds:wixValueComparison('avgTimeSeconds',avgTimeSeconds,priorAvgTimeSeconds),
      bounceRate:wixValueComparison('bounceRate',bounceRate,priorBounceRate,true),
      pagesPerSession:wixValueComparison('pagesPerSession',pagesPerSession,priorPagesPerSession),
      contactActions:wixValueComparison('contactActions',strictActions(summary),strictActions(priorSummary))
    };

    return {
      connected:true,
      partial,
      checkedAt:now(),
      range:{start,end,selection:range,timeZone,days:requestWindow.days,includesToday:requestWindow.includesToday},
      visitorComparison,
      metricComparisons,
      sessions:analyticsTotal(summary,'TOTAL_SESSIONS'),
      visitors:analyticsTotal(summary,'TOTAL_UNIQUE_VISITORS'),
      contactClicks:analyticsTotal(summary,'CLICKS_TO_CONTACT'),
      formsSubmitted:analyticsTotal(summary,'TOTAL_FORMS_SUBMITTED'),
      orders:analyticsTotal(summary,'TOTAL_ORDERS'),
      sales:analyticsTotal(summary,'TOTAL_SALES'),
      pageViews,
      topPage,
      topPageViews,
      pagesPerSession,
      avgTimeSeconds,
      bounceRate,
      topPages,
      previousTopPages,
      weekly,
      missionTrend,
      trafficSources,
      trafficSourcesComplete,
      trafficSourcesPrevious,
      trafficSourcesPreviousComplete,
      devices,
      visitorTypes,
      geography,
      landingPages,
      exitPages,
      message:partial?'Connected · Wix analytics live · some detail pending · '+WIX_RANGE_LABELS[range]:'Connected · Wix analytics live · '+WIX_RANGE_LABELS[range]
    };
  } catch(error) {
    const message=String(error?.message||'Wix website analytics could not be reached.').replace(/Wix Blog/gi,'Wix website');
    return {connected:false,setup:false,message};
  }
}

// Owner-only Wix reporting with explicit, bounded periods. No cached 7-day values
// are substituted when a different range is requested.
export const wixWebsiteRangeEndpoint = endpoint(async(req,res)=>{
  only(req,res,['GET']); await authorize(req);
  const request=resolveReportWindow(req.query||{});
  res.setHeader('Cache-Control','no-store');
  return res.json(await wixSiteStatus(request.range,request));
});



/*
 * Read-only owner dashboard: newest published From Doc's Porch article and
 * two explicitly approved + published Ember Hall CMS stories.
 * Source is always Wix. No private drafts or unapproved submissions escape.
 */
const LATEST_EMBER_COLLECTION = 'EmberHallPosts';
function storyTimestamp(value) {
  const input=value && typeof value==='object' ? value.$date : value;
  const parsed=typeof input==='string' ? Date.parse(input) : NaN;
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function storyText(value,max=260) {
  return typeof value==='string'?value.replace(/[\x00-\x1F\x7F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
}

const STORY_NEW_WINDOW_MS=7*86400000;
function storyRecentlyPublished(when){
  const timestamp=Date.parse(storyTimestamp(when)||'');
  const age=Date.now()-timestamp;
  return Number.isFinite(age)&&age>=0&&age<STORY_NEW_WINDOW_MS;
}
async function latestPorchArticle(token) {
  const report=await wixRequest(token,'https://www.wixapis.com/v3/posts/query',{
    method:'POST',
    body:{fieldsets:['URL','METRICS'],query:{
      cursorPaging:{limit:100},
      sort:[{fieldName:'firstPublishedDate',order:'DESC'}]
    }}
  });
  if(!Array.isArray(report.posts))throw new AppError('Wix Blog did not return a post list.',502);
  const posts=report.posts.filter(p=>p&&typeof p.title==='string'&&storyTimestamp(p.firstPublishedDate))
    .sort((a,b)=>Date.parse(b.firstPublishedDate)-Date.parse(a.firstPublishedDate));
  const row=posts[0];
  if(!row)return null;
  const path=typeof row.url?.path==='string'?row.url.path:'';
  const base=typeof row.url?.base==='string'?row.url.base:'';
  let url=null;
  if(path.startsWith('/post/')&&(base==='https://www.docjaks.com'||base==='https://docjaks.com')) {
    url=new URL(path,base).toString();
  }
  const views=row.metrics?.views;
  return {
    title:storyText(row.title,180),
    excerpt:storyText(row.excerpt,400),
    publishedAt:storyTimestamp(row.firstPublishedDate),
    isNew:storyRecentlyPublished(row.firstPublishedDate),
    views:Number.isSafeInteger(views)&&views>=0?views:null,
    viewsPeriod:'Lifetime',
    url
  };
}
async function latestEmberHallViewCounts(token,posts){
  const candidates=posts.filter(p=>typeof p.pagePath==='string');
  const urls=[...new Set(candidates.map(p=>p.pagePath))];
  if(!urls.length)return new Map();
  const models=await wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models');
  const id=models.semanticModels?.find(m=>m.slug==='traffic')?.id;
  if(!id)throw new AppError('Wix page analytics is not available.',503);
  const today=wixLocalDate(new Date());
  const interval={
    start:localMidnightUtc(addLocalDays(today,-364)),
    end:localMidnightUtc(addLocalDays(today,1)),
    timezone:'America/Chicago'
  };
  const result=await wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data',{
    method:'POST',
    body:{
      semanticModelId:id,interval,
      fields:['traffic.page_url_from','traffic.views_count'],
      filters:[{field:'traffic.page_url_from',condition:'EQUAL',prefix:'IS',values:urls}],
      paging:{limit:100,offset:0},
      totalsIncluded:true
    }
  });
  if(!Array.isArray(result?.results))throw new AppError('Wix did not return usable page-view details.',502);
  const counts=new Map();
  for(const row of result.results) {
    const page=semanticString(row.fields?.['traffic.page_url_from']);
    const count=semanticNumber(row.fields?.['traffic.views_count']);
    if(urls.includes(page)&&count!==null)counts.set(page,count);
  }
  // Wix can omit pages from its result when no tracking row exists.
  // An omitted page is N/A, not evidence a person never opened the story.
  return counts;
}
async function latestEmberHallPosts(token) {
  const report=await wixRequest(token,'https://www.wixapis.com/wix-data/v2/items/query',{
    method:'POST',
    body:{dataCollectionId:LATEST_EMBER_COLLECTION,query:{
      filter:{approved:true},
      sort:[{fieldName:'_publishDate',order:'DESC'}],
      paging:{limit:100}
    }}
  });
  if(!Array.isArray(report.dataItems))throw new AppError('Wix Ember Hall did not return a collection item list.',502);
  const recent=report.dataItems
    .filter(item=>item?.data?.approved===true&&item.data._publishStatus==='PUBLISHED'
      &&typeof item.data.title==='string'&&storyTimestamp(item.data._publishDate))
    .sort((a,b)=>Date.parse(storyTimestamp(b.data._publishDate))-Date.parse(storyTimestamp(a.data._publishDate)))
    .slice(0,2)
    .map(item=>{
      const slug=item.data['link-emberhallposts-title'];
      const pagePath=typeof slug==='string'&&/^\/emberhallposts\/[a-z0-9-]+\/?$/.test(slug)
        ?slug.replace(/\/$/,''):null;
      return {
        title:storyText(item.data.title,180),
        excerpt:storyText(item.data.description,340),
        author:storyText(item.data.authorName,90)||'Not provided',
        category:storyText(item.data.stream,75)||'Ember Hall',
        publishedAt:storyTimestamp(item.data._publishDate),
        isNew:storyRecentlyPublished(item.data._publishDate),
        pagePath,
        url:pagePath?'https://www.docjaks.com'+pagePath:'https://www.docjaks.com/ember-hall'
      };
    });
  let pageCounts=null;
  try{pageCounts=await latestEmberHallViewCounts(token,recent);}
  catch(_){/* No individual views is N/A. Do not suppress approved posts. */}
  return recent.map(({pagePath,...item})=>({
    ...item,
    views:pageCounts?.get(pagePath)??null,
    viewsPeriod:'Last 365 days'
  }));
}
async function emberHallApprovalSummary(token){
  const report=await wixRequest(token,'https://www.wixapis.com/wix-data/v2/items/query',{
    method:'POST',
    body:{dataCollectionId:LATEST_EMBER_COLLECTION,query:{
      sort:[{fieldName:'_createdDate',order:'DESC'}],
      paging:{limit:100}
    }}
  });
  if(!Array.isArray(report.dataItems))throw new AppError('Wix did not return pending Ember Hall items.',502);
  const complete=report.dataItems.length<100&&report.pagingMetadata?.hasNext!==true;
  const pending=report.dataItems.filter(row=>row?.data&&row.data.approved!==true
    &&typeof row.data.title==='string');
  return {
    awaitingApproval:complete?pending.length:null,
    newSubmissions7d:complete?report.dataItems.filter(row=>
      row?.data&&storyRecentlyPublished(row.data._createdDate)).length:null
  };
}

export const wixLatestStoriesEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  res.setHeader('Cache-Control','no-store');
  const checkedAt=now();
  const saved=await savedConnection();
  if(!saved)return res.json({
    checkedAt,blog:{status:'not-connected',post:null},
    emberHall:{status:'not-connected',posts:[]}
  });
  let token;
  try{token=await accessToken(saved);}
  catch{return res.json({
    checkedAt,blog:{status:'needs-authorization',post:null},
    emberHall:{status:'needs-authorization',posts:[]}
  });}
  const [blog,emberHall,approval]=await Promise.allSettled([
    latestPorchArticle(token),latestEmberHallPosts(token),emberHallApprovalSummary(token)
  ]);
  return res.json({
    checkedAt,
    blog:blog.status==='fulfilled'
      ?{status:'connected',post:blog.value}
      :{status:'unavailable',post:null},
    emberHall:emberHall.status==='fulfilled'
      ?{status:'connected',posts:emberHall.value,
        awaitingApproval:approval.status==='fulfilled'?approval.value.awaitingApproval:null,
        newSubmissions7d:approval.status==='fulfilled'?approval.value.newSubmissions7d:null}
      :{status:'unavailable',posts:[],message:'Confirm CMS data-item read access for the connected Wix Headless client.'}
  });
});

export const wixBlogCommentsEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET','POST']);
  const session = await authorize(req);

  if (req.method === 'GET') {
    const connection = await savedConnection();
    if (!connection) return res.json({ connected:false, items:[], checkedAt:now(), message:'Connect Wix Blog.' });
    try {
      const items = await loadBlogComments(connection);
      return res.json({ connected:true, items, checkedAt:now(), siteId:SITE_ID, message:'Wix Blog connected.' });
    } catch (error) {
      return res.json({ connected:false, items:[], checkedAt:now(), message:error.message || 'Wix Blog needs attention.' });
    }
  }

  const body = input(req);
  if (body.action === 'configure') {
    const clientId = clean(body.clientId, 500, 'Wix Headless client ID');
    const clientSecret = clean(body.clientSecret, 5000, 'Wix Headless client secret');
    const candidate = { clientId, clientSecret };
    const token = await accessToken(candidate);
    await queryPosts(token);
    await write(CONNECTION_KEY, { sealed: seal({ ...candidate, connectedAt:now() }), connectedAt:now() });
    return res.json({ success:true, connected:true, message:'Wix Blog connected.' });
  }

  if (body.action === 'disconnect') {
    await redis('DEL', PREFIX + CONNECTION_KEY);
    return res.json({ success:true, connected:false });
  }

  const connection = await savedConnection();
  if (!connection) throw new AppError('Connect Wix Blog first.', 409);

  const rootId = clean(body.commentId || '', 200, 'Comment ID');
  if (body.action === 'handled') {
    if (body.handled === false) await redis('DEL', PREFIX + 'wix-blog-thread:' + rootId);
    else await write('wix-blog-thread:' + rootId, { handledAt:now(), handledBy:session.name, reason:'manual' });
    return res.json({ success:true });
  }

  if (body.action === 'reply') {
    const referenceId = clean(body.referenceId || '', 128, 'Blog reference ID');
    const parentId = clean(body.parentId || rootId, 200, 'Parent comment ID');
    const message = clean(body.message || '', 8000, 'Reply');
    const created = await createReply(connection, referenceId, parentId, message);
    if (created.comment?.id) await write('wix-blog-own-reply:' + created.comment.id, { at:now(), by:session.name }, 60 * 60 * 24 * 365);
    await write('wix-blog-thread:' + rootId, { handledAt:now(), handledBy:session.name, reason:'replied' });
    return res.json({ success:true, commentId:created.comment?.id || null });
  }

  throw new AppError('That Wix Blog action is not supported.');
});
