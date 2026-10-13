import { AppError, PREFIX, id, now, env, config, redis, read, write, withLock, authorize, endpoint, input, only, checkConnection, connection, graph, mediaKey, equal } from './core.js';
import { xAutoSettings, xComposeCampaignText, xPublishCampaignImage } from './x.js';

export const campaigns = [
  { id: 'BBQ', title: 'This Ain’t Regular BBQ' },
  { id: 'BOOK', title: 'The Wooden Token' },
  { id: 'SOSS', title: 'Boss Soss Launch' },
  { id: 'KREWE', title: 'Pit Krewe' },
  { id: 'MUSIC', title: 'Music' },
];
const oldTitles = ['This Ain’t Regular BBQ','Smoke Tells the Story','Every Fire Has a Purpose','Built by Fire','The Bark Matters','No Shortcuts','Boss Soss','Sweet Bayou Soss','Meet the Pit','Awaiting Review','Family at the Table','The Four Fs','Smokehouse Standard','Bigger Than Life','Awaiting Conversion'];
const lockedStates = ['scheduled', 'queueing', 'publishing', 'published', 'partial', 'uncertain'];
export function addHistory(record, user, message) {
  record.history = [{ at: now(), user, message }, ...(record.history || [])].slice(0, 200);
}
export async function saveRecord(record) {
  record.updatedAt = now(); record.revision = (record.revision || 0) + 1;
  await redis('EVAL', 'redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],ARGV[2],ARGV[3]); return 1', 2, PREFIX + 'record:' + record.id, PREFIX + 'records', JSON.stringify(record), Date.now(), record.id);
  return record;
}
export async function getRecord(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{36}$/.test(value)) throw new AppError('Choose a saved post first.');
  const record = await read('record:' + value);
  if (!record) throw new AppError('That post could not be found.', 404);
  return record;
}
function revision(record, expected) {
  if (record.revision !== expected) throw new AppError('This post changed in another window. Reload it before continuing.', 409);
}
function draft(title, campaign, user) {
  const record = { id: id(), title, campaign, caption: '', link: '', imageId: null, targets: ['facebook'], status: 'draft', results: {}, revision: 0, history: [], createdAt: now() };
  addHistory(record, user, 'Created draft'); return record;
}
async function initialize(user) {
  return withLock('initialize', async () => {
    if (await read('initialized')) return;
    // A checkpoint per title makes interrupted initialization safe to resume.
    for (let i = 0; i < oldTitles.length; i++) {
      if (await read('imported:' + i)) continue;
      const r = draft(oldTitles[i], 'BBQ', user);
      r.id = ('0'.repeat(35) + (i + 1).toString(16)).slice(-36);
      if (!await read('record:' + r.id)) {
        addHistory(r, 'DJOMS', 'Imported the title from the previous page. Caption and artwork still need adding.');
        await saveRecord(r);
      }
      await write('imported:' + i, true);
    }
    await write('initialized', true);
  });
}
function cleaned(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(`${name} must be text and no more than ${max} characters.`);
  return value.trim();
}
function safeLink(value) {
  if (!value) return '';
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password) return u.toString(); } catch {}
  throw new AppError('Use a complete HTTPS link.');
}
async function validateRecord(record, online = false) {
  if (!record.caption && !record.link && !record.imageId) throw new AppError('Add a caption, a link, or a photo before approving this post.');
  if (!record.targets.length) throw new AppError('Choose Facebook, Instagram, or both.');
  if (record.targets.includes('instagram')) {
    if (!record.imageId) throw new AppError('Add a photo for Instagram.');
    if ((record.caption + (record.link ? '\n\n' + record.link : '')).length > 2200) throw new AppError('Instagram captions and links must total no more than 2,200 characters.');
  }
  if (record.imageId && !await read('media:' + record.imageId)) throw new AppError('The saved photo is missing. Upload it again.');
  if (online) {
    const status = await checkConnection(true);
    for (const target of record.targets) {
      if (!['facebook','instagram'].includes(target)) continue;
      if (!status[target]?.canPublish) throw new AppError(status[target]?.message || 'Check the account connection.');
    }
    return status;
  }
}
async function queue(record) {
  if (!env().QSTASH_TOKEN || !env().DJOMS_JOB_SECRET || env().DJOMS_JOB_SECRET.length < 32) throw new AppError('Scheduling is not connected yet. Finish the scheduler setup first.', 503);
  const destination = config().origin + '/api/meta/jobs';
  const schedulerUrl = (env().QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');
  let response, data;
  try {
    response = await fetch(schedulerUrl + '/v2/publish/' + destination, {
      method: 'POST', headers: { Authorization: `Bearer ${env().QSTASH_TOKEN}`, 'Content-Type': 'application/json', 'Upstash-Forward-Authorization': `Bearer ${env().DJOMS_JOB_SECRET}`, 'Upstash-Not-Before': String(Math.floor(new Date(record.scheduledAt).getTime() / 1000)), 'Upstash-Retries': '5', 'Upstash-Deduplication-Id': record.scheduleToken },
      body: JSON.stringify({ id: record.id, scheduleToken: record.scheduleToken }), signal: AbortSignal.timeout(8000),
    });
    data = await response.json();
  } catch { throw new AppError('The scheduler did not confirm this post. It has been paused; you can schedule it again.', 502); }
  if (!response.ok || typeof data.messageId !== 'string') throw new AppError('The scheduler rejected this time or request. Check its setup and allowed scheduling window.', 502);
  return data.messageId;
}
function mediaUrl(value) { return `${config().origin}/api/meta/media?id=${encodeURIComponent(value)}&key=${encodeURIComponent(mediaKey(value))}`; }
export function publicRecord(r) {
  const imageVariants = {};
  for (const [name, imageId] of Object.entries(r.imageVariants || {})) {
    if (imageId) imageVariants[name] = mediaUrl(imageId);
  }
  return { ...r, imageUrl: r.imageId ? mediaUrl(r.imageId) : null, imageVariantIds: { ...(r.imageVariants || {}) }, imageVariants };
}

function publicInboxItem(item) {
  return { ...item, imageUrl: item.imageId ? mediaUrl(item.imageId) : null };
}
async function listInbox() {
  const ids = await redis('ZREVRANGE', PREFIX + 'media-inbox', 0, 499);
  const values = ids.length ? await redis('MGET', ...ids.map(x => PREFIX + 'media-inbox:' + x)) : [];
  return values.filter(Boolean).map(v => publicInboxItem(JSON.parse(v)));
}
async function saveInboxItem(item) {
  await redis('EVAL', 'redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],ARGV[2],ARGV[3]); return 1',
    2, PREFIX + 'media-inbox:' + item.id, PREFIX + 'media-inbox', JSON.stringify(item), Date.now(), item.id);
  return item;
}
async function removeInboxItem(itemId) {
  await redis('EVAL', 'redis.call("del",KEYS[1]); redis.call("zrem",KEYS[2],ARGV[1]); return 1',
    2, PREFIX + 'media-inbox:' + itemId, PREFIX + 'media-inbox', itemId);
}
export const recordsEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET', 'POST']); const session = await authorize(req);
  if (req.method === 'GET') {
    const ids = await redis('ZREVRANGE', PREFIX + 'records', 0, 499);
    const values = ids.length ? await redis('MGET', ...ids.map(x => PREFIX + 'record:' + x)) : [];
    return res.json({ records: values.filter(Boolean).map(v => publicRecord(JSON.parse(v))), campaigns, limited: ids.length === 500 });
  }
  const b = input(req);
  if (b.action === 'initialize') { await initialize(session.name); return res.json({ success: true }); }
  if (b.action === 'mediaInboxList') {
    return res.json({ items: await listInbox() });
  }
  if (b.action === 'mediaInboxAdd') {
    const filename = cleaned(b.filename || 'Campaign image', 180, 'File name') || 'Campaign image';
    if (typeof b.imageId !== 'string' || !/^[a-f0-9]{36}$/.test(b.imageId) || !await read('media:' + b.imageId)) throw new AppError('Upload the image before adding it to the Media Inbox.');
    const item = { id:id(), filename, imageId:b.imageId, createdAt:now(), uploadedBy:session.name };
    await saveInboxItem(item);
    return res.json({ item: publicInboxItem(item) });
  }
  if (b.action === 'mediaInboxSave') {
    if (typeof b.itemId !== 'string' || !/^[a-f0-9]{36}$/.test(b.itemId)) throw new AppError('Choose a Media Inbox picture first.');
    const saved = await withLock('media-inbox:' + b.itemId, async () => {
      const item = await read('media-inbox:' + b.itemId);
      if (!item) throw new AppError('This Media Inbox picture was not found. Refresh to check its status.', 404);
      const title = cleaned(b.title || '', 120, 'Post title');
      if (!title) throw new AppError('Give this post a title.');
      if (!campaigns.some(c => c.id === b.campaign)) throw new AppError('Choose a valid campaign.');
      if (!Array.isArray(b.targets) || b.targets.some(t => !['facebook','instagram','x','youtube'].includes(t))) throw new AppError('Choose supported social platforms.');
      item.title = title;
      item.campaign = b.campaign;
      item.caption = cleaned(b.caption || '', 10000, 'Caption');
      item.link = safeLink(cleaned(b.link || '', 2000, 'Link'));
      item.targets = [...new Set(b.targets)];
      item.usePicture = b.usePicture !== false;
      item.updatedAt = now();
      item.savedBy = session.name;
      // Preserve its place in the inbox while persisting fields, instead of
      // moving the item to the top of the list on every automatic save.
      await redis('SET', PREFIX + 'media-inbox:' + item.id, JSON.stringify(item));
      return item;
    });
    return res.json({ item: publicInboxItem(saved) });
  }
  if (b.action === 'mediaInboxDelete') {
    if (typeof b.itemId !== 'string' || !/^[a-f0-9]{36}$/.test(b.itemId)) throw new AppError('Choose a Media Inbox item.');
    await removeInboxItem(b.itemId);
    return res.json({ success:true });
  }
  if (b.action === 'fillMissingBookLinks') {
    // Explicit owner action from the Content Library. Do not touch Music, BBQ,
    // existing links, approved/scheduled posts, or records with delivery results.
    const link = safeLink('https://www.docjaks.com');
    const ids = await redis('ZREVRANGE', PREFIX + 'records', 0, 499);
    let updated = 0;
    for (let i = 0; i < ids.length; i += 5) {
      const results = await Promise.all(ids.slice(i, i + 5).map(recordId =>
        withLock('record:' + recordId, async () => {
          const r = await read('record:' + recordId);
          if (!r || r.campaign !== 'BOOK' || r.status !== 'draft'
              || String(r.link || '').trim() || r.scheduleToken) return false;
          const sent = Object.values(r.results || {}).some(p =>
            p && (p.postId || ['published', 'sending', 'uncertain', 'processing'].includes(p.status)));
          if (sent) return false;
          r.link = link;
          addHistory(r, session.name, 'Added missing Book Campaign website link');
          await saveRecord(r);
          return true;
        })
      ));
      updated += results.filter(Boolean).length;
    }
    return res.json({ success: true, updated, link });
  }
  if (b.action === 'create') {
    const c = campaigns.some(c => c.id === b.campaign) ? b.campaign : 'BBQ';
    const r = draft(cleaned(b.title || 'New post', 120, 'Title') || 'New post', c, session.name);
    await saveRecord(r); return res.json({ record: publicRecord(r) });
  }
  const result = await withLock('record:' + b.id, async () => {
    const r = await getRecord(b.id); revision(r, b.revision);
    // Never allow deletion of published, scheduled, or actively publishing records.
    if (b.action === 'deleteDraft') {
      const sent = Object.values(r.results || {}).some(p => p && (p.postId || ['published', 'sending', 'uncertain', 'processing'].includes(p.status)));
      if (r.status !== 'draft' || sent || r.scheduleToken) throw new AppError('Only unsent drafts can be deleted. Published and scheduled posts are protected.', 409);
      await redis('EVAL', 'redis.call("del",KEYS[1]); redis.call("zrem",KEYS[2],ARGV[1]); return 1',
        2, PREFIX + 'record:' + r.id, PREFIX + 'records', r.id);
      return { deletedId: r.id };
    }
    if (b.action === 'recordManualX') {
      if (!r.targets.includes('x')) throw new AppError('Select X on this campaign post before recording an X publication.');
      const value=String(b.url || '').trim();
      let url;
      try { url=new URL(value); } catch { throw new AppError('Copy the full link to your published X post, not the X home page.'); }
      if (url.protocol!=='https:' || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname.toLowerCase()))
        throw new AppError('Use the HTTPS link from a published X post.');
      const found=/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/([0-9]{12,25})\/?$/.exec(url.pathname);
      if (!found) throw new AppError('That does not look like a post link. On X, open your post, select Share, then Copy link.');
      const prior=r.results?.x || {};
      if (prior.status==='published' && prior.source!=='manual')
        throw new AppError('DJOMS already records this post as automatically published to X.');
      if (['sending','uncertain','preparing'].includes(prior.status))
        throw new AppError('X publishing is awaiting confirmation. Check its result before recording a different post.');
      if(prior.status==='published' && prior.source==='manual' && prior.postId!==found[1])
        throw new AppError('An X post is already linked. Remove the existing manual link before linking a different one.');
      r.results={...(r.results || {}),x:{
        status:'published',source:'manual',postId:found[1],
        url:'https://x.com/i/web/status/'+found[1],
        publishedAt:prior.source==='manual' && prior.publishedAt ? prior.publishedAt : now(),
        metrics:prior.source==='manual' ? (prior.metrics || {}) : {},
        metricsUpdatedAt:prior.source==='manual' ? (prior.metricsUpdatedAt || null) : null,
        error:null,note:'Published directly on X; recorded manually in DJOMS.'
      }};
      addHistory(r,session.name,'Confirmed a manual X post: '+found[1]);
      return saveRecord(r);
    }
    if (b.action === 'updateManualXMetrics') {
      const p=r.results?.x;
      if(!p || p.status!=='published' || !p.postId)
        throw new AppError('Link or confirm the X post before entering its statistics.');
      if(!b.metrics || typeof b.metrics!=='object' || Array.isArray(b.metrics))
        throw new AppError('Enter the X statistics to save.');
      const fields=['views','likes','replies','reposts','bookmarks','linkClicks'];
      const metrics={};
      for(const field of fields){
        const raw=b.metrics[field];
        if(raw===undefined || raw===null || raw==='') {metrics[field]=null;continue;}
        if(!/^\d{1,12}$/.test(String(raw)) || Number(raw)>100000000000)
          throw new AppError('Enter a nonnegative whole number for '+field+', or leave it blank.');
        metrics[field]=Number(raw);
      }
      p.metrics=metrics;
      p.metricsUpdatedAt=now();
      addHistory(r,session.name,'Updated manually entered X engagement statistics');
      return saveRecord(r);
    }
    if (b.action === 'clearManualX') {
      const p=r.results?.x;
      if(p?.source!=='manual' || p.status!=='published')
        throw new AppError('Only manually entered X post links can be removed here.');
      r.results.x={status:'prepared',error:null,
        note:'Manual X post link cleared by owner. This does not remove the post from X.'};
      addHistory(r,session.name,'Cleared previously linked manual X post '+p.postId);
      return saveRecord(r);
    }
    if (b.action === 'duplicate') {
      const copy = draft(r.title + ' — copy', r.campaign, session.name);
      copy.caption = r.caption; copy.link = r.link; copy.imageId = r.imageId; copy.imageVariants = { ...(r.imageVariants || {}) }; copy.targets = [...r.targets];
      return saveRecord(copy);
    }
    if (b.action === 'save') {
      if (lockedStates.includes(r.status)) throw new AppError('Pause a scheduled post before editing. For a post already sent, make a copy.', 409);
      r.title = cleaned(b.title, 120, 'Title'); if (!r.title) throw new AppError('Give this post a title.');
      r.caption = cleaned(b.caption, 10000, 'Caption'); r.link = safeLink(cleaned(b.link || '', 2000, 'Link'));
      if (!campaigns.some(c => c.id === b.campaign)) throw new AppError('Choose a campaign.');
      r.campaign = b.campaign;
      if (!Array.isArray(b.targets) || b.targets.some(t => !['facebook','instagram','x','youtube'].includes(t))) throw new AppError('Choose a supported platform.');
      r.targets = [...new Set(b.targets)];
      if (b.imageId && !/^[a-f0-9]{36}$/.test(b.imageId)) throw new AppError('Choose an uploaded image.');
      r.imageId = b.imageId || null;
      if (r.imageId && !await read('media:' + r.imageId)) throw new AppError('Upload the photo again before saving.');
      const variants = {};
      if (b.imageVariants && typeof b.imageVariants === 'object' && !Array.isArray(b.imageVariants)) {
        for (const [name, imageId] of Object.entries(b.imageVariants)) {
          if (!['facebook','instagram','x','youtube','shorts'].includes(name)) continue;
          if (typeof imageId !== 'string' || !/^[a-f0-9]{36}$/.test(imageId) || !await read('media:' + imageId)) throw new AppError('One of the formatted campaign images is missing. Rebuild the image formats.');
          variants[name] = imageId;
        }
      }
      r.imageVariants = variants;
      r.status = 'draft'; r.approvedBy = null; r.results = {}; r.scheduledAt = null; r.scheduleToken = null;
      addHistory(r, session.name, 'Saved changes · returned to draft');
    } else if (b.action === 'approve') {
      if (!['draft', 'paused', 'failed', 'approved'].includes(r.status)) throw new AppError('This post cannot be approved in its current state.', 409);
      await validateRecord(r); r.status = 'approved'; r.approvedBy = session.name;
      addHistory(r, session.name, 'Approved this saved version');
    } else if (b.action === 'pause' || b.action === 'draft') {
      if (['publishing', 'published', 'partial', 'uncertain'].includes(r.status)) throw new AppError('Check the posting result first. Make a copy to edit a sent post.', 409);
      r.status = b.action === 'pause' ? 'paused' : 'draft'; r.scheduleToken = null; r.scheduledAt = null; r.approvedBy = null;
      addHistory(r, session.name, b.action === 'pause' ? 'Paused post · scheduled delivery cancelled' : 'Returned to draft');
    } else if (b.action === 'schedule') {
      if (r.status !== 'approved') throw new AppError('Approve the saved post before scheduling it.');
      const time = new Date(b.scheduledAt).getTime();
      if (!Number.isFinite(time) || time < Date.now() + 120000) throw new AppError('Choose a time at least two minutes from now.');
      if (time > Date.now() + 7 * 24 * 60 * 60 * 1000) throw new AppError('The free scheduler supports dates up to seven days ahead. Keep this post approved and schedule it closer to its posting date.');
      await validateRecord(r, true);
      r.scheduledAt = new Date(time).toISOString(); r.timeZone = cleaned(b.timeZone || 'UTC', 80, 'Time zone');
      r.scheduleToken = id(); r.status = 'queueing'; await saveRecord(r);
      try { r.queueId = await queue(r); r.status = 'scheduled'; addHistory(r, session.name, 'Scheduled for ' + r.scheduledAt + ' · ' + r.timeZone); }
      catch (e) { r.status = 'paused'; r.scheduleToken = null; r.lastError = e.message; addHistory(r, 'DJOMS', e.message); await saveRecord(r); throw e; }
    } else if (b.action === 'resolve') {
      const p = r.results[b.platform];
      if (!p || !['uncertain','sending'].includes(p.status)) throw new AppError('There is no uncertain result to resolve for that platform.');
      if (b.outcome === 'posted') {
        const postId = cleaned(b.postId || '', 100, 'Post ID');
        if (!/^[\d_]+$/.test(postId)) throw new AppError('Enter the post ID from the account to confirm the result.');
        const c = await connection(); const found = await graph(postId, c.pageToken, { fields: b.platform === 'facebook' ? 'id,from' : 'id,owner' });
        const expected = b.platform === 'facebook' ? c.pageId : (await checkConnection(true)).instagram.id;
        const ownerId = b.platform === 'facebook' ? found.from?.id : found.owner?.id;
        if (String(ownerId) !== String(expected)) throw new AppError('That post does not belong to the selected account.');
        p.status = 'published'; p.postId = found.id; p.error = null;
      } else if (b.outcome === 'not-posted' && b.confirmed === true) { p.status = 'failed'; p.error = 'Owner checked the account and confirmed no post was created.'; }
      else throw new AppError('Check the account and confirm the result first.');
      addHistory(r, session.name, 'Checked ' + b.platform + ' result: ' + b.outcome);
      summarize(r);
    } else throw new AppError('That action is not supported.');
    return saveRecord(r);
  });
  if (result.deletedId) return res.json({ success: true, deletedId: result.deletedId });
  res.json({ record: publicRecord(result) });
});

/** Queue one previously approved post for the rolling 90-day rotation.
 * This shares exactly the same validation, state, token and QStash delivery
 * mechanism used by the single-post scheduler. It never publishes directly.
 */
export async function scheduleRotationPost(recordId, scheduledAt, timeZone='America/Chicago') {
  return withLock('record:' + recordId, async () => {
    const r=await getRecord(recordId);
    if (r.status === 'published') return { status:'published', record:r };
    if (r.status === 'scheduled' && r.scheduledAt === scheduledAt && r.scheduleToken) {
      return { status:'scheduled', record:r };
    }
    if (r.status !== 'approved') throw new AppError('Post "' + r.title + '" is no longer approved (' + r.status + '). Check it before scheduling.');
    const time=Date.parse(scheduledAt);
    if (!Number.isFinite(time) || time < Date.now() + 120000) throw new AppError('Posting time for "' + r.title + '" is too close or has passed.');
    if (time > Date.now() + 7*24*60*60*1000) throw new AppError('Posting time exceeds the current seven-day delivery window.');
    await validateRecord(r,true);
    r.scheduledAt = new Date(time).toISOString();
    r.timeZone = cleaned(timeZone,80,'Time zone');
    r.scheduleToken = id(); r.status='queueing';
    await saveRecord(r);
    try {
      r.queueId = await queue(r);
      r.status='scheduled';
      addHistory(r,'DJOMS 90-day rotation','Scheduled automatically for '+r.scheduledAt+' · '+r.timeZone);
      await saveRecord(r);
      return { status:'scheduled',record:r };
    } catch(e) {
      r.status='paused'; r.scheduleToken=null; r.lastError=e.message;
      addHistory(r,'DJOMS 90-day rotation','Scheduling failed: '+e.message);
      await saveRecord(r);
      throw e;
    }
  });
}

/** Invalidates queued delivery tokens, so even an outstanding QStash callback
 * cannot publish a post after the rotation is paused.
 */
export async function cancelRotationPost(recordId) {
  return withLock('record:' + recordId,async()=>{
    const r=await getRecord(recordId);
    if (!['scheduled','queueing'].includes(r.status)) return false;
    r.status='paused'; r.scheduleToken=null; r.scheduledAt=null; r.queueId=null; r.approvedBy=null;
    addHistory(r,'DJOMS 90-day rotation','Rotation paused; previously queued delivery cancelled');
    await saveRecord(r);
    return true;
  });
}
function summarize(r) {
  const deliveryTargets = r.targets.filter(t => ['facebook','instagram'].includes(t));
  if (!deliveryTargets.length) { r.status = 'approved'; return; }
  const states = deliveryTargets.map(t => r.results[t]?.status || 'pending');
  r.status = states.every(s => s === 'published') ? 'published' : states.some(s => ['sending', 'uncertain'].includes(s)) ? 'uncertain' : states.some(s => s === 'published') ? 'partial' : states.some(s => s === 'processing') ? 'processing' : 'failed';
}
async function sendPlatform(r, platform, c, status) {
  const prior = r.results[platform];
  if (prior?.status === 'published') return;
  if (['sending','uncertain'].includes(prior?.status)) { prior.status = 'uncertain'; prior.error = 'The previous attempt was not confirmed. Check the account before retrying.'; return; }
  let p = r.results[platform] = { ...prior, status: 'preparing', error: null };
  try {
    if (!status[platform]?.canPublish) throw new AppError(status[platform]?.message || 'Check this account connection.');
    const caption = r.caption + (r.link ? (r.caption ? '\n\n' : '') + r.link : '');
    if (platform === 'facebook') {
      p.status = 'sending'; await saveRecord(r);
      const data = r.imageId
        ? await graph(encodeURIComponent(c.pageId) + '/photos', c.pageToken, { url: mediaUrl(r.imageId), caption, published: true }, 'POST', true)
        : await graph(encodeURIComponent(c.pageId) + '/feed', c.pageToken, { message: r.caption, ...(r.link ? { link: r.link } : {}) }, 'POST', true);
      if (!data.id && !data.post_id) throw new AppError('Facebook did not return a post ID. Check the Page before retrying.', 502, true);
      p.postId = data.post_id || data.id; p.status = 'published'; p.publishedAt = now();
    } else {
      if (!p.containerId) {
        const container = await graph(encodeURIComponent(status.instagram.id) + '/media', c.pageToken, { image_url: mediaUrl(r.imageId), caption }, 'POST');
        if (!container.id) throw new AppError('Instagram did not accept the photo.');
        p.containerId = container.id; p.status = 'processing'; await saveRecord(r);
      }
      const container = await graph(encodeURIComponent(p.containerId), c.pageToken, { fields: 'status_code' });
      if (container.status_code === 'IN_PROGRESS') { p.status = 'processing'; await saveRecord(r); return; }
      if (container.status_code === 'PUBLISHED') throw new AppError('Instagram reports that this photo was published. Confirm its post ID before continuing.', 409, true);
      if (container.status_code !== 'FINISHED') { p.containerId = null; throw new AppError('Instagram could not prepare the photo. Upload a new photo or retry.'); }
      p.status = 'sending'; await saveRecord(r);
      const data = await graph(encodeURIComponent(status.instagram.id) + '/media_publish', c.pageToken, { creation_id: p.containerId }, 'POST', true);
      if (!data.id) throw new AppError('Instagram did not return a post ID. Check the account before retrying.', 502, true);
      p.postId = data.id; p.status = 'published'; p.publishedAt = now();
    }
    addHistory(r, 'DJOMS', 'Published to ' + platform + ' · Post ID ' + p.postId);
  } catch (e) {
    p.status = e.uncertain || !(e instanceof AppError) ? 'uncertain' : 'failed';
    p.error = e instanceof AppError ? e.message : 'Posting result could not be confirmed. Check the account before retrying.';
    addHistory(r, 'DJOMS', platform + ': ' + p.error);
  }
  await saveRecord(r);
}
export async function publishRecord(recordId, user, expectedRevision, scheduleToken) {
  return withLock('record:' + recordId, async () => {
    const r = await getRecord(recordId);
    if (scheduleToken) {
      if (r.scheduleToken !== scheduleToken || !['scheduled','processing','partial','publishing'].includes(r.status)) return r;
      if (Date.parse(r.scheduledAt) > Date.now()) throw new AppError('This scheduled time has not arrived yet.', 429);
    } else {
      revision(r, expectedRevision);
      const interrupted = r.status === 'publishing' && Date.now() - Date.parse(r.updatedAt) > 180000;
      if ((!['approved','failed','partial','processing','uncertain'].includes(r.status) && !interrupted) || !r.approvedBy) throw new AppError('Approve this saved post before publishing, or wait for the current attempt to finish.');
    }
    await validateRecord(r);
    const c = await connection(); if (!c) throw new AppError('Connect Facebook first.');
    const status = await checkConnection(true);
    r.status = 'publishing'; addHistory(r, user, scheduleToken ? 'Scheduled publishing started' : 'Publishing started'); await saveRecord(r);
    for (const platform of r.targets.filter(p => ['facebook','instagram'].includes(p))) await sendPlatform(r, platform, c, status);
    for (const platform of r.targets.filter(p => !['facebook','instagram'].includes(p))) {
      // Do not erase a confirmed or uncertain X delivery on later retries.
      if (!r.results[platform] || r.results[platform].status === 'prepared') {
        r.results[platform] = { status:'prepared', error:null, note: platform === 'x'
          ? 'X caption and image prepared. Automatic delivery only runs when the owner enables it in the 90-Day Rotation.'
          : 'YouTube title, description, thumbnail and Shorts cover prepared for the video workflow.' };
      }
    }
    summarize(r); await saveRecord(r);
    return r;
  });
}
export const publishEndpoint = endpoint(async (req, res) => {
  only(req, res, ['POST']); const s = await authorize(req); const b = input(req);
  const r = await publishRecord(b.id, s.name, b.revision);
  res.json({ success: r.status === 'published', record: publicRecord(r) });
});

function insightMap(data = []) {
  const out = {};
  for (const item of data || []) {
    const value = item?.values?.at?.(-1)?.value ?? item?.value;
    if (value !== undefined) out[item.name] = value;
  }
  return out;
}
function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
async function metaPostPerformance(record, platform, c, status) {
  const result = record.results?.[platform];
  const postId = result?.postId;
  if (!postId || result.status !== 'published') return null;
  const cacheKey = 'analytics-current:' + record.id + ':' + platform;
  const cached = await read(cacheKey);
  if (cached && Date.now() - Date.parse(cached.checkedAt || 0) < 15 * 60 * 1000) return cached;
  let basic = {}, insights = {};
  if (platform === 'facebook') {
    try {
      basic = await graph(encodeURIComponent(postId), c.pageToken, { fields:'id,created_time,permalink_url,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares' });
    } catch {}
    try {
      const response = await graph(encodeURIComponent(postId) + '/insights', c.pageToken, { metric:'post_impressions_unique,post_engaged_users,post_clicks,post_clicks_by_type' });
      insights = insightMap(response.data);
    } catch {}
    const reach = numeric(insights.post_impressions_unique);
    const engaged = numeric(insights.post_engaged_users);
    const clickTypes = insights.post_clicks_by_type && typeof insights.post_clicks_by_type === 'object' ? insights.post_clicks_by_type : {};
    const linkClicks = numeric(clickTypes['link clicks'] ?? clickTypes.link_clicks ?? clickTypes.linkClicks);
    const clicks = linkClicks || null;
    const row = {
      recordId:record.id, title:record.title, campaign:record.campaign, platform, postId,
      publishedAt:result.publishedAt || basic.created_time || record.updatedAt,
      permalink:basic.permalink_url || null,
      reactions:numeric(basic.reactions?.summary?.total_count),
      comments:numeric(basic.comments?.summary?.total_count),
      shares:numeric(basic.shares?.count),
      reach, clicks,
      engagementRate:reach > 0 ? ((engaged || numeric(basic.reactions?.summary?.total_count) + numeric(basic.comments?.summary?.total_count) + numeric(basic.shares?.count)) / reach * 100) : null,
      checkedAt:now()
    };
    await write(cacheKey,row,3600);
    return row;
  }
  if (platform === 'instagram') {
    try {
      basic = await graph(encodeURIComponent(postId), c.pageToken, { fields:'id,timestamp,permalink,like_count,comments_count,media_type' });
    } catch {}
    const metricSets = [
      'reach,saved,shares,total_interactions,views',
      'reach,saved,shares,total_interactions',
      'reach,saved'
    ];
    for (const metric of metricSets) {
      try { const response = await graph(encodeURIComponent(postId) + '/insights', c.pageToken, { metric }); insights = insightMap(response.data); break; } catch {}
    }
    const reach = numeric(insights.reach);
    const interactions = numeric(insights.total_interactions) || numeric(basic.like_count) + numeric(basic.comments_count) + numeric(insights.shares) + numeric(insights.saved);
    const row = {
      recordId:record.id, title:record.title, campaign:record.campaign, platform, postId,
      publishedAt:result.publishedAt || basic.timestamp || record.updatedAt,
      permalink:basic.permalink || null,
      reactions:numeric(basic.like_count),
      comments:numeric(basic.comments_count),
      shares:numeric(insights.shares),
      saves:numeric(insights.saved),
      reach,
      views:numeric(insights.views),
      clicks:null,
      engagementRate:reach > 0 ? interactions / reach * 100 : null,
      checkedAt:now()
    };
    await write(cacheKey,row,3600);
    return row;
  }
  return null;
}
function rangeDays(value) {
  if (value === 'today') return 1;
  if (value === '30d') return 30;
  if (value === '365d') return 365;
  return 7;
}
export const analyticsEndpoint = endpoint(async (req,res) => {
  only(req,res,['GET']); await authorize(req);
  const range = ['today','7d','30d','365d'].includes(req.query?.range) ? req.query.range : '7d';
  const days = rangeDays(range), cutoff = Date.now() - days * 86400000;
  const ids = await redis('ZREVRANGE', PREFIX + 'records', 0, 199);
  const values = ids.length ? await redis('MGET', ...ids.map(x => PREFIX + 'record:' + x)) : [];
  const records = values.filter(Boolean).map(v => JSON.parse(v)).filter(r => {
    const when = Date.parse(r.updatedAt || r.createdAt || 0);
    return when >= cutoff || Object.values(r.results || {}).some(x => x?.status === 'published' && Date.parse(x.publishedAt || 0) >= cutoff);
  });
  const c = await connection();
  const status = c ? await checkConnection(false) : null;
  const jobs = [];
  if (c && status) {
    for (const record of records) {
      for (const platform of ['facebook','instagram']) {
        if (record.results?.[platform]?.status === 'published') jobs.push(() => metaPostPerformance(record,platform,c,status));
      }
    }
  }
  const posts = [];
  for (let i=0;i<jobs.length;i+=4) {
    const batch = await Promise.all(jobs.slice(i,i+4).map(fn => fn().catch(()=>null)));
    posts.push(...batch.filter(Boolean));
  }
  const platforms = {};
  for (const platform of ['facebook','instagram','x','youtube']) {
    const list = posts.filter(p => p.platform === platform);
    const sum = key => list.reduce((n,p)=>n+numeric(p[key]),0);
    const reach = sum('reach') || sum('views');
    const interactions = sum('reactions') + sum('comments') + sum('shares') + sum('saves');
    const top = [...list].sort((a,b)=>(numeric(b.clicks)+numeric(b.shares)*3+numeric(b.comments)*2+numeric(b.reactions))-(numeric(a.clicks)+numeric(a.shares)*3+numeric(a.comments)*2+numeric(a.reactions)))[0] || null;
    platforms[platform] = {
      posts:list.length,
      engagementRate:reach > 0 ? interactions/reach*100 : null,
      clicks:sum('clicks'),
      shares:sum('shares'),
      reach,
      topPost:top ? { recordId:top.recordId,title:top.title,campaign:top.campaign,permalink:top.permalink,reach:top.reach,clicks:top.clicks,shares:top.shares,comments:top.comments,reactions:top.reactions } : null
    };
  }
  const dayKey = new Date().toISOString().slice(0,10);
  await write('analytics-snapshot:' + dayKey,{platforms,checkedAt:now()},86400*370);
  const history = [];
  const historyDays = Math.min(days,365);
  for (let offset=historyDays-1; offset>=0; offset--) {
    const d = new Date(Date.now() - offset*86400000).toISOString().slice(0,10);
    const snap = await read('analytics-snapshot:' + d);
    if (snap) history.push({ date:d, platforms:snap.platforms || {} });
  }
  res.json({ range, checkedAt:now(), platforms, posts, history });
});

/* One 90-day sequence: 45 posts, BBQ → Music → Book, every 2 local calendar days.
 * QStash's free 7-day delay is respected: only the NEXT post is scheduled.
 * Following a confirmed successful delivery, the scheduler queues the next one.
 */
const ROTATION_KEY = 'rotation:90-day:v1';
const ROTATION_ZONE = 'America/Chicago';
const ROTATION_CAMPAIGNS = ['BBQ','MUSIC','BOOK'];
const ROTATION_LENGTH = 45;
const ROTATION_GAP_DAYS = 2;
const ROTATION_WINDOW_MS = 7 * 86400000;
function rotationPostNumber(record) {
  const title = String(record.title || '');
  const prefixed = title.match(/\b(?:BK|MU|BBQ)[\s_-]*0*(\d{1,2})(?=\D|$)/i);
  const bare = record.campaign === 'BBQ' ? title.match(/^\s*0*(\d{1,2})(?=\D|$)/) : null;
  const count = Number((prefixed || bare)?.[1] || 0);
  return count >= 1 && count <= 15 ? count : null;
}
function zoneOffsetAt(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone:ROTATION_ZONE, timeZoneName:'shortOffset' }).formatToParts(new Date(timestamp));
  const zone = parts.find(p => p.type === 'timeZoneName')?.value || '';
  const m = zone.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) throw new AppError('Cannot calculate the local posting time. Contact support.');
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}
function rotationTime(startLocal, index) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startLocal || '');
  if (!m) throw new AppError('Choose a complete start date and time.');
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const local = Date.UTC(year, month - 1, day + ROTATION_GAP_DAYS * index, hour, minute);
  if (!Number.isFinite(local) || hour > 23 || minute > 59
      || new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0,10) !== startLocal.slice(0,10))
    throw new AppError('Choose a valid local date and time.');
  let utc = local;
  for (let i=0;i<3;i++) utc = local - zoneOffsetAt(utc) * 60000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:ROTATION_ZONE, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(utc));
  const val = key => Number(parts.find(x => x.type === key)?.value);
  const wanted = new Date(local);
  if (val('year') !== wanted.getUTCFullYear() || val('month') !== wanted.getUTCMonth()+1
      || val('day') !== wanted.getUTCDate() || val('hour') !== hour || val('minute') !== minute)
    throw new AppError('This posting time crosses a daylight-saving clock change. Choose another time.');
  return new Date(utc).toISOString();
}
async function rotationCandidates() {
  const ids = await redis('ZREVRANGE', PREFIX + 'records', 0, 499);
  const raw = ids.length ? await redis('MGET', ...ids.map(x => PREFIX + 'record:' + x)) : [];
  const eligible = raw.filter(Boolean).map(JSON.parse)
    .filter(x => ROTATION_CAMPAIGNS.includes(x.campaign) && x.status === 'approved');
  const byName = new Map();
  for (const r of eligible) {
    const num=rotationPostNumber(r);
    if (!num) continue;
    const key = r.campaign + ':' + num;
    if (!byName.has(key)) byName.set(key,[]);
    byName.get(key).push(r);
  }
  const ordered=[];
  for (let num=1;num<=15;num++) {
    for (const campaign of ROTATION_CAMPAIGNS) {
      const matches=byName.get(campaign + ':' + num) || [];
      if (matches.length !== 1) {
        const label = campaign === 'BOOK' ? 'Book' : campaign === 'MUSIC' ? 'Music' : 'BBQ';
        throw new AppError('Rotation needs one approved ' + label + ' post numbered ' + num +
          ', but found ' + matches.length + '. Check its title and Approved status before starting.');
      }
      ordered.push(matches[0]);
    }
  }
  return ordered;
}
async function rotationEntries(startLocal, checkPosts=true) {
  const ordered=await rotationCandidates();
  if (checkPosts) {
    for (const r of ordered) {
      try { await validateRecord(r); }
      catch(e) { throw new AppError('Post "' + r.title + '" needs attention: ' + e.message); }
    }
  }
  const entries = ordered.map((r,i) => ({
    recordId:r.id, campaign:r.campaign, title:r.title,
    number:Math.floor(i/3)+1, at:rotationTime(startLocal,i), state:'waiting'
  }));
  const first=Date.parse(entries[0].at);
  if (first < Date.now() + 5 * 60000)
    throw new AppError('Choose a posting time at least five minutes from now.');
  if (first > Date.now() + ROTATION_WINDOW_MS - 60000)
    throw new AppError('The first post must be within the next seven days.');
  return entries;
}
function rotationPublic(plan) {
  if (!plan) return null;
  const { id, state, startLocal, timezone, nextIndex, entries, lastError, createdAt, updatedAt } = plan;
  return { id,state,startLocal,timezone,nextIndex,entries,lastError,createdAt,updatedAt };
}
async function scheduleRotationEntry(plan, index) {
  const entry=plan.entries[index];
  if (!entry) throw new AppError('The next rotation post could not be located.');
  const when=Date.parse(entry.at);
  if (when < Date.now() + 120000 || when > Date.now() + ROTATION_WINDOW_MS)
    throw new AppError('The next planned post time is outside the two-minute to seven-day scheduling window.');
  return withLock('record:' + entry.recordId,async()=>{
    const r=await getRecord(entry.recordId);
    if (r.status === 'scheduled' && r.rotationId === plan.id &&
        r.scheduledAt === entry.at && r.scheduleToken) return r;
    if (r.status !== 'approved')
      throw new AppError('Post "' + r.title + '" is not approved or was already scheduled.');
    await validateRecord(r,true);
    r.scheduledAt=entry.at; r.timeZone=ROTATION_ZONE;
    r.scheduleToken=id();r.rotationId=plan.id;r.status='queueing';
    addHistory(r,'DJOMS','Rotation queued for ' + entry.at);
    await saveRecord(r);
    try {
      r.queueId=await queue(r);
      r.status='scheduled';
      await saveRecord(r);
    } catch(error) {
      r.status='paused';r.scheduleToken=null;r.queueId=null;
      addHistory(r,'DJOMS','Rotation scheduler did not confirm: ' + error.message);
      await saveRecord(r);
      throw error;
    }
    return r;
  });
}
async function advanceRotationAfterJob(r) {
  const peek=await read(ROTATION_KEY);
  if (!peek || peek.state !== 'active' || peek.entries?.[peek.nextIndex]?.recordId !== r.id) return;
  return withLock('campaign-rotation',async()=>{
    const plan=await read(ROTATION_KEY);
    if (!plan || plan.state !== 'active' || plan.entries?.[plan.nextIndex]?.recordId !== r.id) return;
    if (r.status === 'processing') return;
    const current=plan.nextIndex;
    if (r.status !== 'published') {
      plan.state='needs_attention';
      plan.lastError='Post "' + r.title + '" finished with status "' + r.status +
        '". Resolve this before the rotation continues.';
      plan.updatedAt=now();
      await write(ROTATION_KEY,plan);
      return;
    }
    plan.entries[current].state='published';
    plan.entries[current].publishedAt=now();
    plan.lastError=null;
    if (current + 1 >= ROTATION_LENGTH) {
      plan.state='completed';plan.nextIndex=ROTATION_LENGTH;
    } else {
      try {
        await scheduleRotationEntry(plan,current+1);
        plan.entries[current+1].state='scheduled';
        plan.nextIndex=current+1;
      } catch (e) {
        plan.state='needs_attention';
        plan.nextIndex=current+1;
        plan.lastError='Could not schedule "' + plan.entries[current+1].title + '": ' + e.message;
      }
    }
    plan.updatedAt=now();
    await write(ROTATION_KEY,plan);
  });
}
export const rotationEndpoint = endpoint(async (req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET') {
    const plan=await read(ROTATION_KEY);
    const ids=await redis('ZREVRANGE', PREFIX + 'records',0,499);
    const raw=ids.length ? await redis('MGET',...ids.map(x=>PREFIX+'record:'+x)) : [];
    const recs=raw.filter(Boolean).map(JSON.parse);
    const approved={};
    for(const campaign of ROTATION_CAMPAIGNS)
      approved[campaign]=recs.filter(r=>r.campaign===campaign && r.status==='approved').length;
    return res.json({plan:rotationPublic(plan),approved,timezone:ROTATION_ZONE});
  }
  const b=input(req);
  if(b.action==='preview') {
    const entries=await rotationEntries(String(b.startLocal||''));
    return res.json({entries,timezone:ROTATION_ZONE});
  }
  if(b.action==='activate') {
    return withLock('campaign-rotation',async()=>{
      const previous=await read(ROTATION_KEY);
      if(previous && !['completed','setup_failed'].includes(previous.state))
        throw new AppError('A posting rotation already exists. Check its status before creating another.',409);
      const startLocal=String(b.startLocal||'');
      const entries=await rotationEntries(startLocal);
      if (!env().QSTASH_TOKEN || !env().DJOMS_JOB_SECRET || env().DJOMS_JOB_SECRET.length < 32)
        throw new AppError('The scheduler is not connected. Finish its setup before activating.',503);
      const plan={ id:id(), state:'starting', startLocal, timezone:ROTATION_ZONE,
        nextIndex:0, entries, createdAt:now(),updatedAt:now(),lastError:null };
      await write(ROTATION_KEY,plan);
      try {
        await scheduleRotationEntry(plan,0);
        plan.state='active';plan.entries[0].state='scheduled';
      } catch(e) {
        plan.state='setup_failed';plan.lastError=e.message;
        plan.updatedAt=now();
        await write(ROTATION_KEY,plan);
        throw e;
      }
      plan.updatedAt=now();
      await write(ROTATION_KEY,plan);
      return res.json({plan:rotationPublic(plan)});
    });
  }
  if(b.action==='pause') {
    return withLock('campaign-rotation',async()=>{
      const plan=await read(ROTATION_KEY);
      if(!plan || plan.state!=='active') throw new AppError('There is no active rotation to pause.');
      const entry=plan.entries[plan.nextIndex];
      if(entry?.state==='scheduled') {
        await withLock('record:'+entry.recordId,async()=>{
          const r=await getRecord(entry.recordId);
          if(r.status === 'scheduled' && r.rotationId === plan.id) {
            r.status='paused';r.scheduleToken=null;r.queueId=null;
            addHistory(r,session.name,'Paused the 90-day rotation before posting');
            await saveRecord(r);
          } else if(['queueing','publishing','processing'].includes(r.status)) {
            throw new AppError('This post is already being sent. Wait until it finishes before pausing.',409);
          }
        });
      }
      plan.state='paused';plan.updatedAt=now();
      plan.entries[plan.nextIndex].state='paused';
      await write(ROTATION_KEY,plan);
      return res.json({plan:rotationPublic(plan)});
    });
  }
  throw new AppError('That rotation action is not supported.');
});

/** X is a separately paid, owner-enabled sidecar for the 90-day rotation.
 * It never delays or changes the Facebook/Instagram publication status.
 * Each post records success or uncertainty, avoiding duplicate paid posts.
 */
async function sendOptionalRotationX(recordId) {
  const settings=await xAutoSettings();
  if(!settings.enabled) return {status:'disabled'};
  return withLock('record:' + recordId,async()=>{
    const r=await getRecord(recordId);
    if(r.status!=='published' || !r.rotationId || !r.targets.includes('x'))
      return {status:'not_eligible'};
    const prior=r.results?.x || {};
    if(['published','sending','uncertain','failed','preparing'].includes(prior.status))
      return {status:prior.status};
    const imageId=r.imageVariants?.x || r.imageId;
    r.results.x={
      ...prior,status:'preparing',error:null,attemptedAt:now(),
      note:'Uploading the campaign image to X'
    };
    await saveRecord(r);
    try {
      const caption=xComposeCampaignText(r);
      const media=await read('media:' + imageId);
      if(!media?.base64)throw new AppError('The X campaign photo is missing. Review this post.');
      const posted=await xPublishCampaignImage(media.base64,caption,async()=>{
        r.results.x.status='sending';
        r.results.x.note='Sent to X; waiting for post confirmation';
        await saveRecord(r);
      });
      r.results.x={
        status:'published',postId:posted.postId,mediaId:posted.mediaId,
        publishedAt:now(),text:posted.text,
        url:'https://x.com/i/web/status/'+posted.postId,error:null
      };
      addHistory(r,'DJOMS','X automatically published · post ID '+posted.postId);
    } catch(error) {
      const ambiguous=error.uncertain || !(error instanceof AppError);
      r.results.x={
        status:ambiguous?'uncertain':'failed',
        attemptedAt:now(),
        error:ambiguous
          ? 'X did not confirm publication. Check your X profile before retrying; this may already have posted.'
          : error.message,
        note:'Facebook and Instagram are unaffected'
      };
      addHistory(r,'DJOMS','X automatic post '+r.results.x.status+': '+r.results.x.error);
    }
    await saveRecord(r);
    return {status:r.results.x.status};
  });
}

export const jobsEndpoint = endpoint(async (req, res) => {
  only(req, res, ['POST']);
  if (!env().DJOMS_JOB_SECRET || env().DJOMS_JOB_SECRET.length < 32 || !equal(req.headers.authorization, 'Bearer ' + env().DJOMS_JOB_SECRET)) throw new AppError('Unauthorized scheduler request.', 401);
  const b = input(req);
  if (typeof b.scheduleToken !== 'string' || !/^[a-f0-9]{36}$/.test(b.scheduleToken)) throw new AppError('Invalid scheduled request.');
  const r = await publishRecord(b.id, 'DJOMS Scheduler', undefined, b.scheduleToken);
  // Retry only when Instagram is still preparing. Published platform results are retained.
  if (r.targets.some(t => r.results[t]?.status === 'processing')) return res.status(503).json({ success: false, status: 'processing' });
  await advanceRotationAfterJob(r);
  // X auto-posting requires explicit, separately billed owner consent and
  // applies only to 90-day rotation records. It cannot block the main rotation.
  let xDelivery=null;
  if(r.status==='published' && r.rotationId && r.targets.includes('x')) {
    try { xDelivery=await sendOptionalRotationX(r.id); }
    catch(error) { xDelivery={status:'needs_attention'}; }
  }
  res.json({ success: true, status: r.status, xDelivery:xDelivery?.status || 'disabled' });
});
function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b.at(-2) !== 0xff || b.at(-1) !== 0xd9) return null;
  for (let p = 2; p + 8 < b.length;) {
    if (b[p++] !== 0xff) return null;
    while (b[p] === 0xff) p++;
    const marker = b[p++];
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = b.readUInt16BE(p); if (len < 2 || p + len > b.length) return null;
    if ([0xc0,0xc1,0xc2].includes(marker)) return { height: b.readUInt16BE(p + 3), width: b.readUInt16BE(p + 5) };
    p += len;
  }
  return null;
}
export const mediaEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET','POST']);
  if (req.method === 'GET') {
    const imageId = req.query?.id;
    if (typeof imageId !== 'string' || !/^[a-f0-9]{36}$/.test(imageId) || !equal(req.query?.key, mediaKey(imageId))) throw new AppError('Image not found.', 404);
    const m = await read('media:' + imageId); if (!m) throw new AppError('Image not found.', 404);
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control','public, max-age=3600');
    return res.send(Buffer.from(m.base64, 'base64'));
  }
  await authorize(req); const b = input(req);
  if (typeof b.base64 !== 'string' || b.base64.length > 2600000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.base64)) throw new AppError('Choose a campaign image smaller than about 2 MB.');
  const bytes = Buffer.from(b.base64, 'base64'), size = jpegSize(bytes);
  if (!size || bytes.length > 1900000 || size.width < 320 || size.height < 320 || size.width > 1920 || size.height > 1920) throw new AppError('Upload a JPEG between 320 and 1920 pixels on each side.');
  const imageId = id(); await write('media:' + imageId, { base64: b.base64, ...size, createdAt: now() });
  res.json({ imageId, imageUrl: mediaUrl(imageId) });
});
