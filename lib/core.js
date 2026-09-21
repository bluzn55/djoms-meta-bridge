import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const derivePassword = promisify(scrypt);

export const PREFIX = 'djoms:v2:';
export class AppError extends Error {
  constructor(message, status = 400, uncertain = false) { super(message); this.status = status; this.uncertain = uncertain; }
}
export const id = () => randomBytes(18).toString('hex');
export const env = () => process.env;
export const now = () => new Date().toISOString();
export function equal(a, b) {
  return timingSafeEqual(createHash('sha256').update(String(a || '')).digest(), createHash('sha256').update(String(b || '')).digest());
}
export function config() {
  const e = env();
  return {
    origin: (e.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    storeUrl: e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL,
    storeToken: e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN,
    secret: e.DJOMS_SESSION_SECRET,
    password: String(e.DJOMS_ADMIN_PASSWORD || '').trim(),
    version: e.META_GRAPH_VERSION || 'v26.0',
  };
}
export function requireConfig() {
  const c = config();
  if (!c.secret || c.secret.length < 32 || !c.password || c.password.length < 16 || !c.storeUrl || !c.storeToken || !c.origin) {
    throw new AppError('Command Center setup is incomplete. Finish the server settings first.', 503);
  }
  let url;
  try { url = new URL(c.origin); } catch { throw new AppError('The Command Center address needs correcting.', 503); }
  if (url.protocol !== 'https:' || url.origin !== c.origin) throw new AppError('PUBLIC_BASE_URL must be the HTTPS Command Center origin, with no path.', 503);
  return c;
}
export async function redis(...command) {
  const c = config();
  if (!c.storeUrl || !c.storeToken) throw new AppError('Server storage is not connected yet.', 503);
  let response, data;
  try {
    response = await fetch(c.storeUrl, { method: 'POST', headers: { Authorization: `Bearer ${c.storeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(8000) });
    data = await response.json();
  } catch { throw new AppError('Server storage could not be reached. Your changes were not confirmed saved.', 503); }
  if (!response.ok || data.error) throw new AppError('Server storage rejected the request. Check its connection.', 503);
  return data.result;
}
export async function read(key) {
  const raw = await redis('GET', PREFIX + key);
  return raw ? JSON.parse(raw) : null;
}
export async function write(key, value, ttl) {
  const args = ['SET', PREFIX + key, JSON.stringify(value)];
  if (ttl) args.push('EX', ttl);
  return redis(...args);
}
export async function withLock(key, work) {
  const token = id(), name = PREFIX + 'lock:' + key;
  if (!await redis('SET', name, token, 'NX', 'EX', 180)) throw new AppError('This item is being updated. Wait a moment and try again.', 409);
  try { return await work(); }
  finally { await redis('EVAL', 'if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end', 1, name, token).catch(() => {}); }
}
function key() {
  if (!config().secret) throw new AppError('The server encryption key is missing.', 503);
  return createHash('sha256').update(config().secret).digest();
}
export function seal(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url');
}
export function unseal(value) {
  try {
    const b = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
  } catch { throw new AppError('Saved connection could not be opened. Connect Facebook again.', 409); }
}
function sign(value) { return createHmac('sha256', key()).update(value).digest('base64url'); }
const COOKIE = '__Host-djoms-session';
const SHORT_SESSION_SECONDS = 43200;
const REMEMBER_SESSION_SECONDS = 60 * 60 * 24 * 30;
export function cookie(res, value, age = SHORT_SESSION_SECONDS) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);
}
export function checkOrigin(req) {
  if (!req.headers.origin || req.headers.origin !== requireConfig().origin) throw new AppError('Open this action from your Command Center.', 403);
}
export async function getSession(req, optional = false) {
  const raw = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (raw) {
    const [sid, signature] = raw.split('.');
    if (/^[a-f0-9]{36}$/.test(sid) && equal(sign('session:' + sid), signature)) {
      const s = await read('session:' + sid);
      if (s && s.expiresAt > Date.now() && equal(s.passwordVersion, (await ownerCredential()).version)) return s;
    }
  }
  if (optional) return null;
  throw new AppError('Sign in to your Command Center first.', 401);
}
export async function authorize(req) {
  requireConfig();
  const s = await getSession(req);
  if (!['GET', 'HEAD'].includes(req.method)) {
    checkOrigin(req);
    if (!equal(req.headers['x-djoms-csrf'], s.csrf)) throw new AppError('Your session changed. Reload the page and try again.', 403);
  }
  return s;
}
export function input(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (type !== 'application/json') throw new AppError('Send this action as JSON.', 415);
  let value;
  try { value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw new AppError('The request could not be read.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('The request could not be read.');
  return value;
}
export function only(req, res, methods) {
  if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new AppError('This action does not support that request method.', 405); }
}
export function endpoint(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try { await fn(req, res); }
    catch (e) { res.status(e instanceof AppError ? e.status : 500).json({ success: false, error: e instanceof AppError ? e.message : 'The request could not be completed. Reload and check the saved result before trying again.' }); }
  };
}
export const sessionEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET', 'POST', 'DELETE']);
  requireConfig();
  if (req.method === 'GET') {
    const s = await getSession(req, true);
    return res.json({ authenticated: !!s, user: s?.name || null, csrf: s?.csrf || null });
  }
  if (req.method === 'DELETE') {
    const s = await authorize(req);
    await redis('DEL', PREFIX + 'session:' + s.id);
    cookie(res, '', 0);
    return res.json({ success: true });
  }
  checkOrigin(req);
  const b = input(req);
  if (typeof b.password !== 'string' || b.password.length > 256) throw new AppError('Enter your Command Center password.', 401);
  b.password = b.password.trim();
  const bucket = PREFIX + 'login-attempts';
  const tries = await redis('EVAL', 'local n=redis.call("incr",KEYS[1]); if n==1 then redis.call("expire",KEYS[1],600) end; return n', 1, bucket);
  if (tries > 15) throw new AppError('Too many sign-in attempts. Please try again in 10 minutes.', 429);
  const credential = await ownerCredential();
  if (!await matchesPassword(b.password, credential)) throw new AppError('That password did not match.', 401);
  await redis('DEL', bucket);
  const sessionSeconds = b.remember === true ? REMEMBER_SESSION_SECONDS : SHORT_SESSION_SECONDS;
  const s = { id: id(), name: env().DJOMS_OWNER_NAME || 'Jay Lockwood', csrf: id(), expiresAt: Date.now() + sessionSeconds * 1000, passwordVersion: credential.version };
  await write('session:' + s.id, s, sessionSeconds);
  cookie(res, s.id + '.' + sign('session:' + s.id), sessionSeconds);
  res.json({ authenticated: true, user: s.name, csrf: s.csrf });
});

// The environment password bootstraps existing installations. After a reset,
// the salted hash in durable storage is authoritative. A deliberate change to
// DJOMS_ADMIN_PASSWORD starts a new bootstrap generation for owner recovery.
const CREDENTIAL_KEY = PREFIX + 'owner-credential';
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const digest = value => createHash('sha256').update(value).digest('hex');
async function ownerCredential() {
  const raw = await redis('GET', CREDENTIAL_KEY);
  const saved = raw ? JSON.parse(raw) : null;
  const bootstrap = sign('bootstrap:' + config().password);
  if (saved && equal(saved.bootstrap, bootstrap)) {
    if (saved.algorithm !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(saved.salt) || !/^[a-f0-9]{128}$/.test(saved.hash) || !/^[a-f0-9]{36}$/.test(saved.generation)) {
      throw new AppError('The saved sign-in settings need repair.', 503);
    }
    return { raw, saved, bootstrap, version: sign('credential:' + bootstrap + ':' + saved.generation) };
  }
  return { raw, saved: null, bootstrap, version: sign(config().password) };
}
async function matchesPassword(password, credential) {
  // The server-configured admin password is always a valid owner recovery path.
  // This prevents a stale durable credential from locking the owner out.
  if (equal(password, config().password)) return true;
  if (!credential.saved) return false;
  const bytes = await derivePassword(password, credential.saved.salt, 64, SCRYPT_OPTIONS);
  return equal(bytes.toString('hex'), credential.saved.hash);
}
function recoverySettings() {
  const email = (env().DJOMS_RECOVERY_EMAIL || '').trim().toLowerCase();
  const from = (env().DJOMS_EMAIL_FROM || '').trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) || email.length > 254 || !from || /[\r\n]/.test(from) || !env().RESEND_API_KEY) {
    throw new AppError('Password recovery is not set up yet. The owner needs to connect the recovery email service.', 503);
  }
  return { email, from, fingerprint: sign('recovery-email:' + email) };
}
async function sendRecoveryEmail(settings, subject, text) {
  let response, data;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: settings.from, to: [settings.email], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    data = await response.json();
  } catch { throw new AppError('The reset email could not be confirmed. If it arrives, use its link; otherwise wait a minute and try again.', 503); }
  if (!response.ok || !data.id) throw new AppError('The email service could not send the message. The owner needs to check the email setup.', 503);
}
const INVALID_RESET = 'This reset link has expired or was already used. Request a new link.';
export const passwordEndpoint = endpoint(async (req, res) => {
  only(req, res, ['POST']);
  requireConfig(); checkOrigin(req);
  const b = input(req);
  const settings = recoverySettings();
  // Only the server-configured owner inbox can receive mail. Client-supplied
  // recipients are never accepted. This release has one owner account.
  if (b.action === 'request') {
    const allowed = await redis('EVAL', `
      if redis.call('exists',KEYS[1]) == 1 then return 0 end
      local n=tonumber(redis.call('get',KEYS[2]) or '0')
      if n>=3 then return 0 end
      redis.call('set',KEYS[1],'1','EX',60)
      redis.call('incr',KEYS[2])
      if n==0 then redis.call('expire',KEYS[2],3600) end
      return 1`, 2, PREFIX + 'reset-cooldown', PREFIX + 'reset-hour');
    if (!allowed) throw new AppError('Please wait before requesting another link. You can request one per minute, up to three per hour.', 429);
    const credential = await ownerCredential();
    const token = randomBytes(32).toString('hex');
    await write('password-reset:' + digest(token), {
      passwordVersion: credential.version, recoveryEmail: settings.fingerprint, expiresAt: Date.now() + 900000,
    }, 900);
    const link = config().origin + '/#reset-password=' + token;
    await sendRecoveryEmail(settings, 'Reset your Doc Jaks Command Center password',
      `Someone requested a password reset for your Doc Jaks Social Command Center.\n\nChoose a new password using this link within 15 minutes:\n${link}\n\nThe link works once. Your current password stays the same until you save a new one.\n\nIf you did not request this, you can ignore this email.\n\nDoc Jaks`);
    return res.json({ success: true, message: 'A reset link has been sent to the recovery email saved for this Command Center. Check your inbox and spam folder. The link expires in 15 minutes.' });
  }
  if (b.action !== 'reset') throw new AppError('Choose a password recovery action.');
  if (typeof b.token !== 'string' || !/^[a-f0-9]{64}$/.test(b.token)) throw new AppError(INVALID_RESET);
  if (typeof b.password !== 'string' || b.password.length < 16 || b.password.length > 256) throw new AppError('Use a password between 16 and 256 characters. A phrase of several words is fine.');
  if (b.password !== b.confirmPassword) throw new AppError('The two new passwords do not match.');
  const tokenKey = PREFIX + 'password-reset:' + digest(b.token);
  const raw = await redis('GET', tokenKey);
  if (!raw) throw new AppError(INVALID_RESET);
  const reset = JSON.parse(raw), credential = await ownerCredential();
  if (reset.expiresAt <= Date.now() || !equal(reset.passwordVersion, credential.version) || !equal(reset.recoveryEmail, settings.fingerprint)) throw new AppError(INVALID_RESET);
  const salt = randomBytes(16).toString('hex');
  const bytes = await derivePassword(b.password, salt, 64, SCRYPT_OPTIONS);
  const saved = { algorithm: 'scrypt-v1', salt, hash: bytes.toString('hex'), generation: id(), bootstrap: credential.bootstrap, changedAt: now() };
  // Consume and change the credential together, only if neither changed while
  // hashing. This prevents replays and concurrent reset requests overwriting
  // each other. Other outstanding links fail their passwordVersion check.
  const changed = await redis('EVAL', `
    if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end
    if (redis.call('get',KEYS[2]) or '') ~= ARGV[2] then return 0 end
    redis.call('set',KEYS[2],ARGV[3])
    redis.call('del',KEYS[1],KEYS[3])
    return 1`, 3, tokenKey, CREDENTIAL_KEY, PREFIX + 'login-attempts', raw, credential.raw || '', JSON.stringify(saved));
  if (!changed) throw new AppError(INVALID_RESET);
  cookie(res, '', 0);
  // A notification failure must never roll back a completed password change.
  await sendRecoveryEmail(settings, 'Your Doc Jaks Command Center password changed',
    `Your Doc Jaks Social Command Center password was changed. Existing sessions have been signed out.\n\nIf you did not make this change, open ${config().origin} and use Forgot password? to recover access.\n\nDoc Jaks`).catch(() => {});
  return res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
});
export function mediaKey(value) { return sign('media:' + value); }

export async function graph(path, token, params = {}, method = 'GET', isPublishing = false) {
  const c = config();
  if (!/^v\d+\.\d+$/.test(c.version)) throw new AppError('The Meta API version needs correcting.', 503);
  const url = new URL(`https://graph.facebook.com/${c.version}/${path}`);
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v != null) body.set(k, String(v)); });
  const headers = { Authorization: `Bearer ${token}` };
  if (method === 'GET') url.search = body.toString();
  else headers['Content-Type'] = 'application/x-www-form-urlencoded';
  let response, data;
  try {
    response = await fetch(url, { method, headers, ...(method === 'GET' ? {} : { body }), signal: AbortSignal.timeout(10000) });
    data = await response.json();
  } catch { throw new AppError(isPublishing ? 'Meta did not confirm the result. Check the account before retrying.' : 'Meta could not be reached. Try again shortly.', 502, isPublishing); }
  if (!response.ok || data.error) {
    const code = data.error?.code;
    const friendly = code === 190 ? 'The Meta connection expired. Connect Facebook again.' : [10, 200].includes(code) ? 'Meta has not granted the required posting permission. Reconnect and check the selected accounts.' : code === 100 ? 'Meta rejected part of this post or account request. Check the selected account, caption, and photo.' : 'Meta could not complete the request. Check the account connection and post details.';
    throw new AppError(friendly + (Number.isInteger(code) ? ` (Meta code ${code})` : ''), 502, isPublishing && response.status >= 500);
  }
  return data;
}
export async function connection() {
  const value = await read('connection');
  if (value) return unseal(value);
  if (env().META_PAGE_ID && env().META_PAGE_ACCESS_TOKEN) return { pageId: env().META_PAGE_ID, pageToken: env().META_PAGE_ACCESS_TOKEN, pageName: env().META_PAGE_NAME, source: 'existing-settings' };
  return null;
}
export async function checkConnection(force = false) {
  if (!force) { const cached = await read('connection-status'); if (cached) return cached; }
  const c = await connection();
  const out = { checkedAt: now(), facebook: { connected: false, canPublish: false, message: 'Connect your Facebook Page.' }, instagram: { connected: false, canPublish: false, message: 'Connect the Instagram account linked to your Facebook Page.' }, scheduler: !!(env().QSTASH_TOKEN && env().DJOMS_JOB_SECRET?.length >= 32) };
  if (!c) return out;
  let scopes = null;
  try {
    const debug = await graph('debug_token', `${env().META_APP_ID}|${env().META_APP_SECRET}`, { input_token: c.pageToken });
    if (!debug.data?.is_valid || String(debug.data.app_id) !== String(env().META_APP_ID) || (debug.data.expires_at && debug.data.expires_at * 1000 <= Date.now()) || (debug.data.data_access_expires_at && debug.data.data_access_expires_at * 1000 <= Date.now())) throw new AppError('The Meta connection expired or belongs to a different app. Connect Facebook again.', 401);
    scopes = debug.data.scopes || [];
  } catch (e) { out.facebook.message = e.message; out.instagram.message = 'Reconnect Facebook to check Instagram.'; await write('connection-status', out, 30); return out; }
  try {
    const page = await graph(encodeURIComponent(c.pageId), c.pageToken, { fields: 'id,name' });
    if (String(page.id) !== String(c.pageId)) throw new AppError('The saved token does not match your Facebook Page.');
    out.facebook = { connected: true, canPublish: scopes.includes('pages_manage_posts'), name: page.name, id: page.id, message: scopes.includes('pages_manage_posts') ? 'Connected · posting permission verified' : 'Connected · posting permission is missing' };
  } catch (e) { out.facebook.message = e.message; await write('connection-status', out, 30); return out; }
  try {
    const page = await graph(encodeURIComponent(c.pageId), c.pageToken, { fields: 'instagram_business_account' });
    const igId = page.instagram_business_account?.id;
    if (!igId) throw new AppError('No professional Instagram account is linked to this Facebook Page.');
    const ig = await graph(encodeURIComponent(igId), c.pageToken, { fields: 'id,username' });
    const canPublish = ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement'].every(s => scopes.includes(s));
    out.instagram = { connected: true, canPublish, id: ig.id, name: '@' + ig.username, message: canPublish ? 'Connected · posting permission verified' : 'Connected · Instagram posting permission is missing' };
  } catch (e) { out.instagram.message = e.message; }
  await write('connection-status', out, 45);
  return out;
}
export const statusEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); await authorize(req);
  const status = await checkConnection(req.query?.refresh === '1');
  res.json({ ...status, connected: status.facebook.connected, pageName: status.facebook.name || null });
});
export const connectEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); const session = await authorize(req);
  if (!env().META_APP_ID || !env().META_APP_SECRET || !env().META_PAGE_ID) throw new AppError('Add the Meta app and Facebook Page settings before connecting.', 503);
  const state = id();
  await write('oauth:' + state, { sessionId: session.id }, 600);
  const required = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
  const scopes = [...new Set([...required, ...(env().META_SCOPES || '').split(',').map(s => s.trim()).filter(Boolean)])];
  const url = new URL(`https://www.facebook.com/${config().version}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: env().META_APP_ID, redirect_uri: config().origin + '/api/meta/callback', scope: scopes.join(','), response_type: 'code', state, auth_type: 'rerequest' }).toString();
  res.redirect(302, url.toString());
});
export const callbackEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); const session = await authorize(req);
  const state = req.query?.state;
  if (typeof state !== 'string' || !/^[a-f0-9]{36}$/.test(state)) throw new AppError('The login request could not be verified. Start Connect Facebook again.', 403);
  const saved = await redis('GETDEL', PREFIX + 'oauth:' + state);
  if (!saved || JSON.parse(saved).sessionId !== session.id) throw new AppError('The login request expired. Start Connect Facebook again.', 403);
  if (req.query?.error) return res.redirect(303, config().origin + '/?connection=cancelled');
  if (typeof req.query?.code !== 'string') throw new AppError('Meta did not return an authorization code.');
  const token = await graph('oauth/access_token', `${env().META_APP_ID}|${env().META_APP_SECRET}`, { client_id: env().META_APP_ID, client_secret: env().META_APP_SECRET, redirect_uri: config().origin + '/api/meta/callback', code: req.query.code });
  if (!token.access_token) throw new AppError('Meta did not return an access token.');
  const long = await graph('oauth/access_token', `${env().META_APP_ID}|${env().META_APP_SECRET}`, { grant_type: 'fb_exchange_token', client_id: env().META_APP_ID, client_secret: env().META_APP_SECRET, fb_exchange_token: token.access_token });
  if (!long.access_token) throw new AppError('Meta did not complete the connection. Please connect again.');
  const wanted = String(env().META_PAGE_ID);
  let page, after;
  for (let i = 0; i < 10 && !page; i++) {
    const pages = await graph('me/accounts', long.access_token, { fields: 'id,name,access_token,tasks', limit: 100, ...(after ? { after } : {}) });
    page = (pages.data || []).find(p => String(p.id) === wanted);
    after = pages.paging?.cursors?.after;
    if (!pages.paging?.next || !after) break;
  }
  if (!page?.access_token) throw new AppError('Your configured Doc Jaks Facebook Page was not selected or was not available. Reconnect and select that Page.');
  if (!page.tasks?.some(t => ['CREATE_CONTENT', 'MANAGE'].includes(t))) throw new AppError('Your Facebook account does not have permission to create content on this Page.');
  await write('connection', seal({ pageId: page.id, pageName: page.name, pageToken: page.access_token, connectedAt: now(), source: 'oauth' }));
  await redis('DEL', PREFIX + 'connection-status');
  res.redirect(303, config().origin + '/?connection=saved');
});
