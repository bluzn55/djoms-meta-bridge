import { AppError, PREFIX, env, config, redis, read, write, seal, unseal, authorize, endpoint, only, input, id, now } from './core.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels';

function required() {
  if (!env().YOUTUBE_CLIENT_ID || !env().YOUTUBE_CLIENT_SECRET) {
    throw new AppError('Add the YouTube Client ID and Client Secret before connecting.', 503);
  }
}
async function tokenRequest(params) {
  required();
  let response, data;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json();
  } catch {
    throw new AppError('Google could not be reached. Try again shortly.', 502);
  }
  if (!response.ok || data.error) {
    throw new AppError(data.error_description || data.error || 'Google did not complete the YouTube authorization.', 502);
  }
  return data;
}
async function youtubeApi(url, accessToken) {
  let response, data;
  try {
    response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + accessToken },
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json();
  } catch {
    throw new AppError('YouTube could not be reached. Try again shortly.', 502);
  }
  if (!response.ok || data.error) {
    throw new AppError(data.error?.message || 'YouTube could not complete the request.', 502);
  }
  return data;
}
async function savedConnection() {
  const saved = await read('youtube-connection');
  return saved ? unseal(saved) : null;
}
async function saveConnection(value) {
  await write('youtube-connection', seal(value));
  await redis('DEL', PREFIX + 'youtube-status');
}
async function refresh(c) {
  if (!c?.refreshToken) throw new AppError('Reconnect YouTube to continue.', 401);
  const token = await tokenRequest({
    client_id: env().YOUTUBE_CLIENT_ID,
    client_secret: env().YOUTUBE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: c.refreshToken
  });
  const next = {
    ...c,
    accessToken: token.access_token,
    expiresAt: Date.now() + (Number(token.expires_in || 3600) * 1000),
    refreshedAt: now()
  };
  await saveConnection(next);
  return next;
}
export async function youtubeConnection() {
  let c = await savedConnection();
  if (c && c.expiresAt && c.expiresAt < Date.now() + 60000) c = await refresh(c);
  return c;
}
export async function youtubeStatus(force = false) {
  if (!force) {
    const cached = await read('youtube-status');
    if (cached) return cached;
  }
  const out = { connected:false, canPublish:false, name:null, id:null, message:'Connect your YouTube channel.' };
  try {
    const c = await youtubeConnection();
    if (!c) return out;
    const url = new URL(CHANNEL_URL);
    url.search = new URLSearchParams({ part:'id,snippet', mine:'true', maxResults:'1' }).toString();
    const data = await youtubeApi(url, c.accessToken);
    const channel = data.items?.[0];
    if (!channel?.id) throw new AppError('No YouTube channel was found for this Google account.');
    out.connected = true;
    out.canPublish = true;
    out.name = channel.snippet?.title || 'YouTube';
    out.id = channel.id;
    out.message = 'Connected · upload permission ready';
    await write('youtube-status', out, 45);
    return out;
  } catch (e) {
    out.message = e.message || 'Reconnect YouTube.';
    await write('youtube-status', out, 30);
    return out;
  }
}
export const youtubeConnectEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  const session = await authorize(req);
  required();
  const state = id();
  await write('youtube-oauth:' + state, { sessionId: session.id }, 600);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env().YOUTUBE_CLIENT_ID,
    redirect_uri: config().origin + '/api/youtube/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload',
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  }).toString();
  res.redirect(302, url.toString());
});
export const youtubeCallbackEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  const session = await authorize(req);
  const state = req.query?.state;
  if (typeof state !== 'string' || !/^[a-f0-9]{36}$/.test(state)) {
    throw new AppError('The YouTube login request could not be verified. Start Connect YouTube again.', 403);
  }
  const raw = await redis('GETDEL', PREFIX + 'youtube-oauth:' + state);
  if (!raw) throw new AppError('The YouTube login request expired. Start Connect YouTube again.', 403);
  const saved = JSON.parse(raw);
  if (saved.sessionId !== session.id) throw new AppError('The YouTube login request does not match this signed-in session.', 403);
  if (req.query?.error) return res.redirect(303, config().origin + '/?youtubeconnection=cancelled');
  if (typeof req.query?.code !== 'string') throw new AppError('Google did not return an authorization code.');
  const token = await tokenRequest({
    client_id: env().YOUTUBE_CLIENT_ID,
    client_secret: env().YOUTUBE_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: config().origin + '/api/youtube/callback'
  });
  if (!token.access_token) throw new AppError('Google did not return a YouTube access token.');
  await saveConnection({
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresAt: Date.now() + (Number(token.expires_in || 3600) * 1000),
    connectedAt: now()
  });
  res.redirect(303, config().origin + '/?youtubeconnection=saved');
});
export const youtubeStatusEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  await authorize(req);
  res.json(await youtubeStatus(req.query?.refresh === '1'));
});


function cleanVideoText(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(label + ' is too long.');
  return value.trim();
}
async function videoInboxList() {
  const ids = await redis('ZREVRANGE', PREFIX + 'video-inbox', 0, 199);
  const values = ids.length ? await redis('MGET', ...ids.map(x => PREFIX + 'video-inbox:' + x)) : [];
  return values.filter(Boolean).map(v => JSON.parse(v));
}
async function saveVideoInboxItem(item) {
  item.updatedAt = now();
  await redis('EVAL', 'redis.call("set",KEYS[1],ARGV[1]); redis.call("zadd",KEYS[2],ARGV[2],ARGV[3]); return 1',
    2, PREFIX + 'video-inbox:' + item.id, PREFIX + 'video-inbox', JSON.stringify(item), Date.now(), item.id);
  return item;
}
async function removeVideoInboxItem(itemId) {
  await redis('EVAL', 'redis.call("del",KEYS[1]); redis.call("zrem",KEYS[2],ARGV[1]); return 1',
    2, PREFIX + 'video-inbox:' + itemId, PREFIX + 'video-inbox', itemId);
}
async function youtubeWrite(url, accessToken, method, body) {
  let response, data;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization:'Bearer ' + accessToken, ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? { body:JSON.stringify(body) } : {}),
      signal:AbortSignal.timeout(15000)
    });
    data = response.status === 204 ? null : await response.json().catch(() => null);
  } catch {
    throw new AppError('YouTube could not be reached. Try again shortly.', 502);
  }
  if (!response.ok || data?.error) throw new AppError(data?.error?.message || 'YouTube could not complete the video request.', 502);
  return data;
}
export const youtubeVideoListEndpoint = endpoint(async (req,res) => {
  only(req,res,['GET']);
  await authorize(req);
  res.json({ items:await videoInboxList() });
});
export const youtubeVideoInitEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  await authorize(req);
  const b=input(req);
  const filename=cleanVideoText(b.filename || 'Video',180,'File name') || 'Video';
  const mime=cleanVideoText(b.mimeType || '',100,'Video type');
  const size=Number(b.size);
  if (!/^video\//.test(mime)) throw new AppError('Choose a video file.');
  if (!Number.isFinite(size) || size <= 0 || size > 8 * 1024 * 1024 * 1024) throw new AppError('Choose a video smaller than 8 GB.');
  const c=await youtubeConnection();
  if (!c) throw new AppError('Connect YouTube first.');
  const title=filename.replace(/\.[^.]+$/,'').slice(0,100) || 'Doc Jaks video';
  const url='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
  let response;
  try {
    response=await fetch(url,{
      method:'POST',
      headers:{
        Authorization:'Bearer ' + c.accessToken,
        'Content-Type':'application/json; charset=UTF-8',
        'X-Upload-Content-Length':String(size),
        'X-Upload-Content-Type':mime
      },
      body:JSON.stringify({
        snippet:{title,description:'Uploaded to Doc Jaks Social Command Video Inbox. Private until reviewed.',categoryId:'22'},
        status:{privacyStatus:'private'}
      }),
      signal:AbortSignal.timeout(15000)
    });
  } catch {
    throw new AppError('YouTube could not start the video upload.',502);
  }
  if (!response.ok) {
    const data=await response.json().catch(()=>null);
    throw new AppError(data?.error?.message || 'YouTube rejected the video upload request.',502);
  }
  const uploadUrl=response.headers.get('location');
  if (!uploadUrl) throw new AppError('YouTube did not return an upload address.',502);
  res.json({ uploadUrl });
});
export const youtubeVideoRegisterEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  const session=await authorize(req);
  const b=input(req);
  const youtubeId=cleanVideoText(b.youtubeId || '',100,'YouTube video ID');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) throw new AppError('YouTube did not return a valid video ID.');
  const item={
    id:id(), youtubeId,
    filename:cleanVideoText(b.filename || 'Video',180,'File name') || 'Video',
    campaign:'BBQ',
    title:cleanVideoText(b.title || b.filename || 'Video',120,'Title').replace(/\.[^.]+$/,'').slice(0,120),
    description:'',
    link:'',
    categoryId:'22',
    targets:['youtube'],
    width:Number(b.width)||null, height:Number(b.height)||null, duration:Number(b.duration)||null,
    uploadedAt:now(), uploadedBy:session.name, status:'private'
  };
  await saveVideoInboxItem(item);
  res.json({ item });
});
export const youtubeVideoSaveEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  await authorize(req);
  const b=input(req);
  if (typeof b.itemId !== 'string' || !/^[a-f0-9]{36}$/.test(b.itemId)) throw new AppError('Choose a video.');
  const raw=await read('video-inbox:' + b.itemId);
  if (!raw) throw new AppError('That video could not be found.',404);
  const item=raw;
  item.campaign=cleanVideoText(b.campaign || item.campaign || 'BBQ',40,'Campaign');
  item.title=cleanVideoText(b.title || item.title || 'Video',100,'YouTube title') || 'Doc Jaks video';
  item.description=cleanVideoText(b.description || '',5000,'YouTube description');
  item.link=cleanVideoText(b.link || '',2000,'Link');
  item.categoryId=['10','22','24','26'].includes(String(b.categoryId)) ? String(b.categoryId) : '22';
  item.targets=Array.isArray(b.targets) ? [...new Set(b.targets.filter(x=>['facebook','instagram','x','youtube'].includes(x)))] : ['youtube'];
  const c=await youtubeConnection();
  if (!c) throw new AppError('Connect YouTube first.');
  const description=item.description + (item.link ? (item.description ? '\n\n' : '') + item.link : '');
  await youtubeWrite('https://www.googleapis.com/youtube/v3/videos?part=snippet',c.accessToken,'PUT',{
    id:item.youtubeId,
    snippet:{title:item.title,description,categoryId:item.categoryId}
  });
  await saveVideoInboxItem(item);
  res.json({item});
});
export const youtubeVideoDeleteEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  await authorize(req);
  const b=input(req);
  if (typeof b.itemId !== 'string' || !/^[a-f0-9]{36}$/.test(b.itemId)) throw new AppError('Choose a video.');
  const item=await read('video-inbox:' + b.itemId);
  if (!item) throw new AppError('That video could not be found.',404);
  const c=await youtubeConnection();
  if (!c) throw new AppError('Connect YouTube first.');
  await youtubeWrite('https://www.googleapis.com/youtube/v3/videos?id=' + encodeURIComponent(item.youtubeId),c.accessToken,'DELETE');
  await removeVideoInboxItem(item.id);
  res.json({success:true});
});
