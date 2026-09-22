import { AppError, PREFIX, id, now, env, config, redis, read, write, withLock, authorize, endpoint, input, only, checkConnection, connection, graph, mediaKey, equal } from './core.js';

export const campaigns = [
  { id: 'BBQ', title: 'This Ain’t Regular BBQ' },
  { id: 'BOOK', title: 'The Wooden Token' },
  { id: 'SOSS', title: 'Boss Soss Launch' },
  { id: 'KREWE', title: 'Pit Krewe' },
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
  if (b.action === 'mediaInboxDelete') {
    if (typeof b.itemId !== 'string' || !/^[a-f0-9]{36}$/.test(b.itemId)) throw new AppError('Choose a Media Inbox item.');
    await removeInboxItem(b.itemId);
    return res.json({ success:true });
  }
  if (b.action === 'create') {
    const c = campaigns.some(c => c.id === b.campaign) ? b.campaign : 'BBQ';
    const r = draft(cleaned(b.title || 'New post', 120, 'Title') || 'New post', c, session.name);
    await saveRecord(r); return res.json({ record: publicRecord(r) });
  }
  const result = await withLock('record:' + b.id, async () => {
    const r = await getRecord(b.id); revision(r, b.revision);
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
  res.json({ record: publicRecord(result) });
});
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
      r.results[platform] = { status:'prepared', error:null, note: platform === 'x' ? 'X campaign version prepared; direct image publishing will be enabled in the next delivery step.' : 'YouTube title, description, thumbnail and Shorts cover prepared for the video workflow.' };
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
export const jobsEndpoint = endpoint(async (req, res) => {
  only(req, res, ['POST']);
  if (!env().DJOMS_JOB_SECRET || env().DJOMS_JOB_SECRET.length < 32 || !equal(req.headers.authorization, 'Bearer ' + env().DJOMS_JOB_SECRET)) throw new AppError('Unauthorized scheduler request.', 401);
  const b = input(req);
  if (typeof b.scheduleToken !== 'string' || !/^[a-f0-9]{36}$/.test(b.scheduleToken)) throw new AppError('Invalid scheduled request.');
  const r = await publishRecord(b.id, 'DJOMS Scheduler', undefined, b.scheduleToken);
  // Retry only when Instagram is still preparing. Published platform results are retained.
  if (r.targets.some(t => r.results[t]?.status === 'processing')) return res.status(503).json({ success: false, status: 'processing' });
  res.json({ success: true, status: r.status });
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
