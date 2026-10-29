import { AppError, PREFIX, config, connection, env, read, redis, write, authorize, endpoint, only, now } from './core.js';
import { REPORT_VERSION, metricNumber, insightValue, reportPeriod, inPeriod, summarizePosts } from './report-metrics.js';
import { resolveReportWindow } from './report-window.js';

const MAX_RECORDS = 1000;
const MAX_POSTS = 60;
const cache = new Map();
const pending = new Map();
const METRICS = {
  facebook: { views: 'post_media_view', reach: 'post_total_media_view_unique', clicks: 'post_clicks_by_type' },
  instagram: { views: 'views', reach: 'reach', shares: 'shares', saves: 'saved' }
};

// Only fixed provider URLs are used. Error messages never contain access tokens.
export async function metaRead(path, token, params = {}) {
  if (!token) throw new AppError('Meta account is not connected.', 409);
  const version = config().version;
  if (!/^v\d+\.\d+$/.test(version)) throw new AppError('Meta API version is invalid.', 503);
  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let response, data;
  try {
    response = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(9000) });
    data = await response.json();
  } catch { throw new AppError('Meta could not be reached. Measurement unavailable.', 502); }
  if (!response.ok || data.error) {
    const code = Number(data.error?.code);
    const subcode = Number(data.error?.error_subcode);
    const category = code === 190 ? 'Meta authorization has expired' : [10, 200].includes(code)
      ? 'Meta permission is missing for this measurement' : code === 100
      ? 'Meta did not accept this measurement or object' : 'Meta did not return this measurement';
    throw new AppError(category + (Number.isFinite(code) ? ` (code ${code}${subcode ? ', subcode ' + subcode : ''}).` : '.'), 502);
  }
  return data;
}

function publicPost(record, platform) {
  const result = record.results?.[platform];
  return {
    recordId: record.id, title: String(record.title || 'Untitled post').slice(0, 140),
    campaign: ['BBQ', 'MUSIC', 'BOOK'].includes(record.campaign) ? record.campaign : 'UNASSIGNED',
    platform, postId: String(result.postId), publishedAt: result.publishedAt || null,
    permalink: result.url || null, source: platform === 'x' ? 'owner_entered' : 'DJOMS',
    manualMetrics: platform === 'x' ? result.metrics || {} : undefined,
    manualCheckedAt: platform === 'x' ? result.metricsUpdatedAt || null : undefined
  };
}

export async function knownRecords() {
  const [ids, total] = await Promise.all([
    redis('ZREVRANGE', PREFIX + 'records', 0, MAX_RECORDS - 1),
    redis('ZCARD', PREFIX + 'records')
  ]);
  const raw = ids.length ? await redis('MGET', ...ids.map(id => PREFIX + 'record:' + id)) : [];
  const records = [];
  let unreadable = 0;
  for (const value of raw) {
    if (!value) continue;
    try { records.push(JSON.parse(value)); } catch { unreadable++; }
  }
  return { records, total: Number(total), limited: Number(total) > MAX_RECORDS, unreadable };
}

async function accountPosts(platform, accountId, token, period) {
  if (!accountId) return { items: [], complete: false, error: 'Account identity is unavailable.' };
  const items = [];
  let after;
  const base = platform === 'facebook' ? {
    fields: 'id,message,created_time,permalink_url', since: Math.floor(Date.parse(period.start) / 1000),
    until: Math.floor(Date.parse(period.asOf) / 1000), limit: 100
  } : { fields: 'id,caption,timestamp,permalink,media_type', limit: 100 };
  try {
    for (let page = 0; page < 3; page++) {
      const data = await metaRead(`${encodeURIComponent(accountId)}/${platform === 'facebook' ? 'published_posts' : 'media'}`, token, { ...base, ...(after ? { after } : {}) });
      if (!Array.isArray(data.data)) throw new AppError('Meta omitted the published-post list.', 502);
      for (const post of data.data) {
        const publishedAt = post.created_time || post.timestamp;
        if (!inPeriod(publishedAt, period)) continue;
        items.push({ platform, postId: String(post.id), publishedAt,
          title: String(post.message || post.caption || 'Post outside DJOMS').slice(0, 140),
          campaign: 'UNASSIGNED', recordId: null, permalink: post.permalink_url || post.permalink || null,
          source: 'Meta account', mediaType: post.media_type || null });
      }
      if (!data.paging?.next) return { items, complete: true };
      if (platform === 'instagram' && data.data.length && data.data.every(p => Date.parse(p.timestamp) < Date.parse(period.start))) {
        return { items, complete: true };
      }
      after = data.paging?.cursors?.after;
      if (!after) return { items, complete: false, error: 'Meta returned more posts without a usable cursor.' };
    }
    return { items, complete: false, error: 'Account-post scan reached its 300-post safety limit.' };
  } catch (error) {
    return { items, complete: false, error: error.message };
  }
}

export async function measurePost(post, token, refresh = false, request = metaRead) {
  const cacheKey = `verified-post:${REPORT_VERSION}:${post.platform}:${post.postId}`;
  if (!refresh && request === metaRead) {
    const saved = await read(cacheKey).catch(() => null);
    if (saved && Date.now() - Date.parse(saved.checkedAt) < 5 * 60 * 1000) return { ...saved, ...post };
  }
  const row = { ...post, views: null, reach: null, reactions: null, comments: null, shares: null, saves: null,
    clicks: null, engagementRate: null, checkedAt: now(), warnings: [], metricSources: {} };
  const { platform, postId } = post;
  const basicFields = platform === 'facebook'
    ? 'id,created_time,permalink_url,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares'
    : 'id,timestamp,permalink,like_count,comments_count,media_type';
  const tasks = [{ key: 'basic', params: { fields: basicFields } }];
  for (const [key, metric] of Object.entries(METRICS[platform])) tasks.push({ key, metric, params: { metric } });
  const results = await Promise.allSettled(tasks.map(task => request(
    encodeURIComponent(postId) + (task.metric ? '/insights' : ''), token, task.params
  )));
  results.forEach((result, index) => {
    const task = tasks[index];
    if (result.status === 'rejected') { row.warnings.push(`${task.key}: ${result.reason.message}`); return; }
    const data = result.value;
    if (task.key === 'basic') {
      if (String(data.id || '') !== postId) { row.warnings.push('Basic post data did not match the requested post.'); return; }
      row.permalink = data.permalink_url || data.permalink || row.permalink;
      row.publishedAt = data.created_time || data.timestamp || row.publishedAt;
      row.reactions = metricNumber(platform === 'facebook' ? data.reactions?.summary?.total_count : data.like_count);
      row.comments = metricNumber(platform === 'facebook' ? data.comments?.summary?.total_count : data.comments_count);
      if (platform === 'facebook') row.shares = metricNumber(data.shares?.count);
      row.mediaType = data.media_type || row.mediaType || null;
      row.metricSources.reactions = platform === 'facebook' ? 'reactions.summary.total_count' : 'like_count';
      row.metricSources.comments = platform === 'facebook' ? 'comments.summary.total_count' : 'comments_count';
      return;
    }
    const value = insightValue(data, task.metric);
    if (task.key === 'clicks') {
      // A missing link-click category is not assumed to be zero.
      const clicks = value && typeof value === 'object' && !Array.isArray(value)
        ? value['link clicks'] ?? value.link_clicks ?? value.linkClicks : undefined;
      row.clicks = metricNumber(clicks);
    } else row[task.key] = metricNumber(value);
    row.metricSources[task.key] = task.metric;
    if (row[task.key] === null) row.warnings.push(`${task.key}: Meta did not supply a numeric measurement.`);
  });
  row.status = row.warnings.length ? 'partial' : 'available';
  if (['views', 'reach', 'reactions', 'comments', 'shares', 'saves', 'clicks'].every(key => row[key] === null)) row.status = 'unavailable';
  row.checkedAt = now();
  if (request === metaRead) await write(cacheKey, row, 900).catch(() => {});
  return row;
}

/* Exposure growth is only valid on the SAME post IDs measured at two
 * different checks. Comparing posts published in separate weeks is NOT a
 * time trend. Missing insights and newly published posts are excluded.
 * This is a count of displays/plays, never unique people or a read.
 */
export function samePostExposure(currentPosts, previousSnapshot, platform, checkedAt, window) {
  const empty={
    status:'unavailable',measuredPosts:0,
    previousViews:null,currentViews:null,change:null,
    previousCheckedAt:null,currentCheckedAt:checkedAt,
    note:'No comparable saved check of the same posts.'
  };
  const prior=previousSnapshot;
  if(!prior||prior.version!==REPORT_VERSION||
    prior.period?.startDate!==window.startDate||
    prior.period?.endDate!==window.endDate||
    !Array.isArray(prior.posts)||!Array.isArray(currentPosts))return empty;
  const before=Date.parse(prior.checkedAt||'');
  const after=Date.parse(checkedAt||'');
  if(!Number.isFinite(before)||!Number.isFinite(after)||before>=after)
    return empty;
  const priorById=new Map(prior.posts.filter(post=>post?.platform===platform&&
    post?.postId&&metricNumber(post.views)!==null)
    .map(post=>[String(post.postId),post]));
  const pairs=currentPosts.filter(post=>post?.platform===platform&&
    post?.postId&&metricNumber(post.views)!==null&&
    priorById.has(String(post.postId)));
  if(!pairs.length)return empty;
  const previousViews=pairs.reduce((sum,post)=>
    sum+metricNumber(priorById.get(String(post.postId)).views),0);
  const currentViews=pairs.reduce((sum,post)=>sum+metricNumber(post.views),0);
  return {
    status:'reported',
    measuredPosts:pairs.length,
    previousViews,currentViews,change:currentViews-previousViews,
    previousCheckedAt:prior.checkedAt,currentCheckedAt:checkedAt,
    note:'Only posts with measured views in both checks are included. This is increased display/play count, not distinct people or full reads.'
  };
}

function manualX(post) {
  const metric = key => metricNumber(post.manualMetrics?.[key]);
  const { manualMetrics, manualCheckedAt, ...safe } = post;
  return { ...safe, views: metric('views'), reach: null, reactions: metric('likes'), comments: metric('replies'),
    shares: metric('reposts'), saves: metric('bookmarks'), clicks: metric('linkClicks'),
    checkedAt: manualCheckedAt, status: manualCheckedAt ? 'manual_snapshot' : 'not_entered',
    warnings: ['X statistics are owner-entered snapshots, not a live X analytics feed. No paid X analytics requests are made.'] };
}

async function build(range, refresh, selectedWindow=null) {
  const period = reportPeriod(range,new Date(),selectedWindow);
  const data = await knownRecords();
  const warnings = [];
  if (data.limited || data.unreadable) warnings.push('The saved-post inventory is incomplete. Counts are for returned records only.');
  const indexed = new Map();
  for (const record of data.records) {
    for (const platform of ['facebook', 'instagram', 'x']) {
      const result = record.results?.[platform];
      if (result?.status !== 'published' || !result.postId) continue;
      const post = publicPost(record, platform);
      // Never use updatedAt to pull an older edited post into a recent period.
      if (inPeriod(post.publishedAt, period)) indexed.set(`${platform}:${post.postId}`, post);
      else if (!post.publishedAt) warnings.push(`${platform}: A saved post has no verified publication date and was excluded.`);
    }
  }
  let c = null;
  try { c = await connection(); } catch { warnings.push('The saved Meta connection could not be read.'); }
  const accounts = { facebook: { connected: false }, instagram: { connected: false } };
  const discovery = {};
  if (c?.pageId && c.pageToken) {
    try {
      const page = await metaRead(encodeURIComponent(c.pageId), c.pageToken,
        { fields: 'id,name,followers_count,instagram_business_account{id,username,followers_count}' });
      if (String(page.id) !== String(c.pageId)) throw new AppError('The Meta page identity did not match.', 409);
      accounts.facebook = { connected: true, id: page.id, name: page.name, followers: metricNumber(page.followers_count) };
      const ig = page.instagram_business_account;
      if (ig?.id) accounts.instagram = { connected: true, id: ig.id, name: ig.username ? '@' + ig.username : 'Instagram', followers: metricNumber(ig.followers_count) };
    } catch (error) { warnings.push(error.message); }
    const lists = await Promise.all(['facebook', 'instagram'].map(platform => accountPosts(platform,
      accounts[platform].id || (platform === 'facebook' ? c.pageId : null), c.pageToken, period)));
    ['facebook', 'instagram'].forEach((platform, index) => {
      discovery[platform] = { complete: lists[index].complete, error: lists[index].error || null };
      for (const post of lists[index].items) {
        const key = `${platform}:${post.postId}`;
        indexed.set(key, { ...post, ...(indexed.get(key) || {}) });
      }
      if (lists[index].error) warnings.push(`${platform} post inventory: ${lists[index].error}`);
    });
  } else warnings.push('Meta is not connected. Account measurements are unavailable.');
  const selected = [...indexed.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const candidates = selected.filter(post => post.platform !== 'x');
  const posts = selected.filter(post => post.platform === 'x').map(manualX);
  const deadline = Date.now() + 60000;
  let measured = 0;
  for (let index = 0; index < Math.min(candidates.length, MAX_POSTS); index += 4) {
    if (Date.now() >= deadline) break;
    const batch = candidates.slice(index, Math.min(index + 4, MAX_POSTS));
    const result = await Promise.all(batch.map(post => measurePost(post, c?.pageToken, refresh).catch(error => ({
      ...post, status: 'unavailable', checkedAt: now(), warnings: [error.message], views: null, reach: null,
      reactions: null, comments: null, shares: null, saves: null, clicks: null
    }))));
    posts.push(...result);
    measured += batch.length;
  }
  if (measured < candidates.length) {
    warnings.push(`Measured ${measured} of ${candidates.length} discovered Meta posts. Remaining posts are marked unavailable, not zero.`);
    posts.push(...candidates.slice(measured).map(post => ({ ...post, status: 'not_measured', checkedAt: null,
      warnings: ['Reporting safety limit reached.'], views: null, reach: null, reactions: null,
      comments: null, shares: null, saves: null, clicks: null })));
  }
  const platforms = {};
  for (const platform of ['facebook', 'instagram', 'x', 'youtube']) {
    const list = posts.filter(post => post.platform === platform);
    platforms[platform] = { ...summarizePosts(list, platform), account: accounts[platform] || null,
      inventory: discovery[platform] || { complete: false },
      status: platform === 'x' ? (list.length ? 'manual_snapshots' : 'not_entered') : platform === 'youtube'
        ? 'separate_report' : !c ? 'not_connected' : list.some(post => post.status === 'unavailable' || post.status === 'not_measured')
        ? 'partial' : list.some(post => post.status === 'partial') ? 'partial' : list.length ? 'available' : 'no_posts_returned' };
  }
  const campaigns = ['BBQ', 'MUSIC', 'BOOK'].map(campaign => ({
    campaign, platforms: Object.fromEntries(['facebook', 'instagram', 'x'].map(platform => [platform,
      summarizePosts(posts.filter(post => post.campaign === campaign && post.platform === platform), platform)]))
  }));
  const checkedAt=now();
  const result = {
    version: REPORT_VERSION, range, period, checkedAt, platforms, posts, campaigns, warnings,
    history: [], historyNote: 'Old snapshots mixed date ranges and missing values, so they are not used as a trend.',
    scope: 'Current lifetime performance of posts published within the selected dates, including discoverable posts outside DJOMS. Not account-wide unique audience.',
    operation: { scheduledPosts: data.records.filter(record => record.status === 'scheduled').length,
      failedPosts: data.records.filter(record => ['failed', 'partial', 'uncertain'].includes(record.status)).length },
    coverage: { savedRecords: data.records.length, totalSavedRecords: data.total,
      recordInventoryComplete: !data.limited && data.unreadable === 0, metaPostsDiscovered: candidates.length, metaPostsMeasured: measured }
  };
  // Recheck the same IDs before overwriting the saved snapshot. Compare
  // as-of-now post views to the previous check, not the previous publish cohort.
  const snapshotKey=`verified-analytics:${REPORT_VERSION}:${range}:${period.startDate}:${period.endDate}`;
  const previousSnapshot=await read(snapshotKey).catch(()=>null);
  for(const platform of ['facebook','instagram'])
    result.platforms[platform].exposureTrend=
      samePostExposure(posts,previousSnapshot,platform,checkedAt,period);
  await write(snapshotKey,result,86400*370).catch(()=>{});
  return result;
}

export async function collectAnalytics(range = '7d', refresh = false, selectedWindow = null) {
  const period=reportPeriod(range,new Date(),selectedWindow);
  const key=range+':'+period.startDate+':'+period.endDate;
  const cached=cache.get(key);
  if (!refresh && cached && cached.until>Date.now())return {...cached.value,cached:true};
  if(pending.has(key))return pending.get(key);
  const job=build(range,refresh,selectedWindow).then(value=>{
    cache.set(key,{value,until:Date.now()+60000});
    return {...value,cached:false};
  }).finally(()=>pending.delete(key));
  pending.set(key,job);
  return job;
}

export const verifiedAnalyticsEndpoint = endpoint(async(req,res)=>{
  only(req,res,['GET']); await authorize(req);
  const requestWindow=resolveReportWindow(req.query||{});
  res.json(await collectAnalytics(requestWindow.range,req.query?.refresh==='1',requestWindow));
});
