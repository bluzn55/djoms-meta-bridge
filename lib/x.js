import { createHash, randomBytes } from 'node:crypto';
import { AppError, PREFIX, env, config, redis, read, write, seal, unseal, authorize, endpoint, only, id, now } from './core.js';

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_URL = 'https://api.x.com/2';

function required() {
  if (!env().X_CLIENT_ID || !env().X_CLIENT_SECRET) throw new AppError('Add the X Client ID and Client Secret before connecting.', 503);
}
function challenge(value) {
  return createHash('sha256').update(value).digest('base64url');
}
async function tokenRequest(params) {
  required();
  let response, data;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(env().X_CLIENT_ID + ':' + env().X_CLIENT_SECRET).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json();
  } catch {
    throw new AppError('X could not be reached. Try again shortly.', 502);
  }
  if (!response.ok || data.error) throw new AppError(data.error_description || data.error || 'X did not complete the authorization.', 502);
  return data;
}
async function api(path, accessToken, options = {}) {
  let response, data;
  try {
    response = await fetch(API_URL + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + accessToken,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(10000)
    });
    data = await response.json();
  } catch {
    throw new AppError('X could not be reached. Try again shortly.', 502);
  }
  if (!response.ok || data.errors || data.error) {
    throw new AppError(data.detail || data.title || data.error_description || data.error || 'X could not complete the request.', 502);
  }
  return data;
}
async function connection() {
  const saved = await read('x-connection');
  return saved ? unseal(saved) : null;
}
async function saveConnection(value) {
  await write('x-connection', seal(value));
  await redis('DEL', PREFIX + 'x-status');
}
async function refresh(c) {
  if (!c?.refreshToken) throw new AppError('Reconnect X to continue.', 401);
  const token = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: c.refreshToken,
    client_id: env().X_CLIENT_ID
  });
  const next = {
    ...c,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || c.refreshToken,
    expiresAt: Date.now() + (Number(token.expires_in || 7200) * 1000),
    refreshedAt: now()
  };
  await saveConnection(next);
  return next;
}
export async function xConnection() {
  let c = await connection();
  if (c && c.expiresAt && c.expiresAt < Date.now() + 60000) c = await refresh(c);
  return c;
}
export async function xStatus(force = false) {
  if (!force) {
    const cached = await read('x-status');
    if (cached) return cached;
  }
  const out = { connected: false, canPublish: false, name: null, username: null, message: 'Connect your X account.' };
  try {
    const c = await xConnection();
    if (!c) return out;
    const me = await api('/users/me?user.fields=id,name,username', c.accessToken);
    if (!me.data?.id) throw new AppError('X did not return the connected account.');
    out.connected = true;
    out.canPublish = true;
    out.name = '@' + me.data.username;
    out.username = me.data.username;
    out.id = me.data.id;
    out.message = 'Connected · posting permission verified';
    await write('x-status', out, 45);
    return out;
  } catch (e) {
    out.message = e.message || 'Reconnect X.';
    await write('x-status', out, 30);
    return out;
  }
}
export async function xPost(text) {
  const c = await xConnection();
  if (!c) throw new AppError('Connect X first.');
  const data = await api('/tweets', c.accessToken, { method: 'POST', body: JSON.stringify({ text }) });
  if (!data.data?.id) throw new AppError('X did not return a post ID. Check the account before retrying.', 502, true);
  return data.data;
}
export const xConnectEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  const session = await authorize(req);
  required();
  const state = id();
  const verifier = randomBytes(48).toString('base64url');
  await write('x-oauth:' + state, { sessionId: session.id, verifier }, 600);
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env().X_CLIENT_ID,
    redirect_uri: config().origin + '/api/x/callback',
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256'
  }).toString();
  res.redirect(302, url.toString());
});
export const xCallbackEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  const session = await authorize(req);
  const state = req.query?.state;
  if (typeof state !== 'string' || !/^[a-f0-9]{36}$/.test(state)) throw new AppError('The X login request could not be verified. Start Connect X again.', 403);
  const raw = await redis('GETDEL', PREFIX + 'x-oauth:' + state);
  if (!raw) throw new AppError('The X login request expired. Start Connect X again.', 403);
  const saved = JSON.parse(raw);
  if (saved.sessionId !== session.id) throw new AppError('The X login request does not match this signed-in session.', 403);
  if (req.query?.error) return res.redirect(303, config().origin + '/?xconnection=cancelled');
  if (typeof req.query?.code !== 'string') throw new AppError('X did not return an authorization code.');
  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code: req.query.code,
    redirect_uri: config().origin + '/api/x/callback',
    code_verifier: saved.verifier,
    client_id: env().X_CLIENT_ID
  });
  if (!token.access_token) throw new AppError('X did not return an access token.');
  const value = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    expiresAt: Date.now() + (Number(token.expires_in || 7200) * 1000),
    connectedAt: now()
  };
  await saveConnection(value);
  res.redirect(303, config().origin + '/?xconnection=saved');
});
export const xStatusEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  await authorize(req);
  res.json(await xStatus(req.query?.refresh === '1'));
});
export const xPostEndpoint = endpoint(async (req, res) => {
  only(req, res, ['POST']);
  await authorize(req);
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const text = String(body?.text || '').trim();
  if (!text || text.length > 280) throw new AppError('X posts must contain 1 to 280 characters.');
  const post = await xPost(text);
  res.json({ success: true, post });
});
