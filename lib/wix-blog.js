import { AppError, PREFIX, authorize, endpoint, only, input, read, write, redis, now, seal, unseal } from './core.js';

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
  const n=Number(value?.numericValue);
  return Number.isFinite(n)?n:null;
}
function semanticString(value) {
  return typeof value?.stringValue==='string'?value.stringValue:null;
}
export async function wixSiteStatus() {
  const connection=await savedConnection();
  if(!connection) return {connected:false,setup:true,message:'Connect Wix website data.'};
  const timeZone='America/Chicago';
  try {
    const token=await accessToken(connection);
    const today=wixLocalDate(new Date(),timeZone);
    const start=addLocalDays(today,-6);
    const end=addLocalDays(today,1);

    const summaryUrl=new URL('https://www.wixapis.com/analytics-ng/v2/site-analytics/data');
    summaryUrl.searchParams.set('dateRange.startDate',start);
    summaryUrl.searchParams.set('dateRange.endDate',end);
    summaryUrl.searchParams.set('timeZone',timeZone);
    ['TOTAL_SESSIONS','TOTAL_UNIQUE_VISITORS','CLICKS_TO_CONTACT','TOTAL_FORMS_SUBMITTED','TOTAL_ORDERS','TOTAL_SALES']
      .forEach(type=>summaryUrl.searchParams.append('measurementTypes',type));
    const summary=await wixRequest(token,summaryUrl.toString());

    let pageViews=null,topPage=null,topPageViews=null,partial=false;
    try {
      const models=await wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models');
      const traffic=(models.semanticModels||[]).find(x=>x.slug==='traffic');
      if(traffic?.id){
        const trafficData=await wixRequest(token,'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models/query-data',{
          method:'POST',
          body:{
            semanticModelId:traffic.id,
            interval:{start:localMidnightUtc(start,timeZone),end:localMidnightUtc(end,timeZone),timezone:timeZone},
            fields:['traffic.page_url_from','traffic.views_count'],
            sort:{fieldName:'traffic.views_count',order:'DESC',nullsLast:true},
            paging:{limit:5,offset:0},
            formattingEnabled:true,
            totalsIncluded:true
          }
        });
        pageViews=semanticNumber(trafficData?.totals?.fields?.['traffic.views_count']);
        const first=trafficData?.results?.[0]?.fields||{};
        topPage=semanticString(first['traffic.page_url_from']);
        topPageViews=semanticNumber(first['traffic.views_count']);
      } else partial=true;
    } catch { partial=true; }

    return {
      connected:true,
      partial,
      checkedAt:now(),
      range:{start,end},
      sessions:analyticsTotal(summary,'TOTAL_SESSIONS'),
      visitors:analyticsTotal(summary,'TOTAL_UNIQUE_VISITORS'),
      contactClicks:analyticsTotal(summary,'CLICKS_TO_CONTACT'),
      formsSubmitted:analyticsTotal(summary,'TOTAL_FORMS_SUBMITTED'),
      orders:analyticsTotal(summary,'TOTAL_ORDERS'),
      sales:analyticsTotal(summary,'TOTAL_SALES'),
      pageViews,
      topPage,
      topPageViews,
      message:partial?'Connected · Wix analytics live · page detail pending':'Connected · Wix analytics live · Last 7 days'
    };
  } catch(error) {
    const message=String(error?.message||'Wix website analytics could not be reached.').replace(/Wix Blog/gi,'Wix website');
    return {connected:false,setup:false,message};
  }
}

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
