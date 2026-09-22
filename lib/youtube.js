import { AppError, PREFIX, env, config, redis, read, write, seal, unseal, authorize, endpoint, only, id, now } from './core.js';

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
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
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
