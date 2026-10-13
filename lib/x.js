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
    throw new AppError('X could not be reached. Check the account before retrying a post.',502,
      options.method === 'POST' && path === '/tweets');
  }
  if (!response.ok || data.errors || data.error) {
    const detail=data.detail || data.title || data.error_description || data.error
      || data.errors?.[0]?.detail || 'X could not complete the request.';
    throw new AppError(detail,response.status || 502,
      options.method === 'POST' && path === '/tweets' && response.status>=500);
  }
  return data;
}
async function connection() {
  const saved = await read('x-connection');
  return saved ? unseal(saved) : null;
}
async function saveConnection(value, newAuthorization=false) {
  await write('x-connection', seal(value));
  await redis('DEL', PREFIX + 'x-status');
  if(newAuthorization) {
    const prior=await read('x-auto-settings');
    if(prior?.enabled) await write('x-auto-settings',{...prior,enabled:false,disabledReason:'X authorization changed',updatedAt:now()});
  }
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
    scope: token.scope || c.scope || '',
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
    const me = await api('/users/me?user.fields=id,name,username,public_metrics', c.accessToken);
    if (!me.data?.id) throw new AppError('X did not return the connected account.');
    out.connected = true;
    out.canPublish = true;
    out.canUploadMedia=String(c.scope || '').split(/\s+/).includes('media.write');
    out.autoReady=out.canUploadMedia && !!c.refreshToken;
    out.name = '@' + me.data.username;
    out.username = me.data.username;
    out.id = me.data.id;
    out.followers = Number(me.data.public_metrics?.followers_count) || null;
    out.message = out.autoReady ? 'Connected · image posting permission available' : 'Connected for text. Reconnect X to authorize image uploads.';
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

/** Pay-per-use X image posting remains disabled until explicit owner consent. */
export async function xAutoSettings(){
  const s=await read('x-auto-settings');
  return {enabled:s?.enabled===true,rotationOnly:true,includeLinks:true,approvedAt:s?.approvedAt||null};
}
export function xComposeCampaignText(record){
  const link=String(record.link||'').trim();
  const clean=String(record.caption||record.title||'')
    .replace(/\*\*/g,'').replace(/https?:\/\/\S+/g,'')
    .replace(/[ \t]+/g,' ').trim();
  const lines=clean.split(/\n+/).map(t=>t.trim()).filter(Boolean);
  const head=lines[0] || String(record.title||'Doc Jaks');
  const desc=lines.slice(1).filter(t=>!t.startsWith('#')).join(' ').trim();
  const trailer=link?'\n\n'+link:'';
  const budget=268-trailer.length;
  if(budget<20)throw new AppError('The X campaign link is too long.');
  let summary=(head+(desc?'\n\n'+desc:'')).trim();
  if(summary.length>budget){
    let slice=summary.slice(0,budget-1);
    const breakAt=slice.lastIndexOf(' ');
    if(breakAt>budget*0.65)slice=slice.slice(0,breakAt);
    summary=slice.trimEnd()+'…';
  }
  const text=summary+trailer;
  if(!text || text.length>280)throw new AppError('X caption could not fit within 280 characters.');
  return text;
}
export async function xPublishCampaignImage(jpegBase64,text,onSending){
  const c=await xConnection();
  if(!c?.accessToken)throw new AppError('Connect your X account before scheduling X posts.');
  if(!String(c.scope||'').split(/\s+/).includes('media.write'))
    throw new AppError('Reconnect X to authorize media.write for picture posting.');
  if(!c.refreshToken)throw new AppError('Reconnect X to authorize offline.access for scheduling.');
  if(typeof jpegBase64!=='string'|| !/^[A-Za-z0-9+/]+={0,2}$/.test(jpegBase64))
    throw new AppError('The stored picture is unavailable for X.');
  if(typeof text!=='string'||!text.trim()||text.length>280)
    throw new AppError('X posts must fit within 280 characters.');
  const uploaded=await api('/media/upload',c.accessToken,{
    method:'POST',body:JSON.stringify({media:jpegBase64,media_category:'tweet_image'})
  });
  const mediaId=uploaded?.data?.id||uploaded?.data?.media_id;
  if(!mediaId)throw new AppError('X did not confirm the picture upload. The post was not submitted.');
  if(onSending)await onSending();
  const data=await api('/tweets',c.accessToken,{
    method:'POST',body:JSON.stringify({text,media:{media_ids:[String(mediaId)]}})
  });
  if(!data?.data?.id)
    throw new AppError('X did not return a post ID. Check X before retrying.',502,true);
  return {postId:String(data.data.id),mediaId:String(mediaId),text};
}
export const xAutoSettingsEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET','POST']);
  const session=await authorize(req);
  if(req.method==='GET'){
    const settings=await xAutoSettings();
    const status=await xStatus(false);
    return res.json({...settings,account:status.name||null,connected:!!status.connected,
      ready:!!status.autoReady,canUploadMedia:!!status.canUploadMedia,
      connectionMessage:status.message,estimatedPerLinkedPostUsd:0.20,estimated45PostsUsd:9});
  }
  const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
  if(b.action==='disable'){
    await write('x-auto-settings',{enabled:false,updatedAt:now(),disabledReason:'Owner disabled X automatic posting'});
    return res.json({success:true,enabled:false});
  }
  if(b.action!=='enable')throw new AppError('Choose to enable or disable X automatic posting.');
  if(b.acknowledgePayPerUse!==true)
    throw new AppError('Confirm the X API pay-per-use charges before enabling.');
  const c=await xConnection();
  if(!c?.accessToken)throw new AppError('Connect X first from the Platforms page.');
  if(!c.refreshToken||!String(c.scope||'').split(/\s+/).includes('media.write'))
    throw new AppError('Reconnect X in Platforms and allow media.write and offline.access.');
  const verified=await xStatus(true);
  if(!verified.connected||!verified.autoReady)
    throw new AppError(verified.message||'X could not verify your connected account.');
  await write('x-auto-settings',{enabled:true,rotationOnly:true,includeLinks:true,
    approvedBy:session.name,approvedAt:now(),accountId:verified.id,
    account:verified.name,updatedAt:now()});
  return res.json({success:true,enabled:true,account:verified.name});
});

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
    scope: 'tweet.read tweet.write users.read media.write offline.access',
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
    scope: token.scope || '',
    expiresAt: Date.now() + (Number(token.expires_in || 7200) * 1000),
    connectedAt: now()
  };
  await saveConnection(value,true);
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


async function xHandled(id) {
  return await read('comment-handled:x:' + id);
}
export const xMentionsEndpoint = endpoint(async (req,res) => {
  only(req,res,['GET']);
  await authorize(req);
  const c = await xConnection();
  if (!c) throw new AppError('Connect X first.');
  const me = await api('/users/me?user.fields=id,name,username', c.accessToken);
  if (!me.data?.id) throw new AppError('X did not return the connected account.');
  const params = new URLSearchParams({
    'max_results':'50',
    'tweet.fields':'id,text,author_id,created_at,conversation_id,referenced_tweets',
    'expansions':'author_id',
    'user.fields':'id,name,username,profile_image_url'
  });
  const data = await api('/users/' + encodeURIComponent(me.data.id) + '/mentions?' + params.toString(), c.accessToken);
  const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id,u]));
  const items = [];
  for (const tweet of data.data || []) {
    const user = users[tweet.author_id] || {};
    const h = await xHandled(tweet.id);
    items.push({
      platform:'x',
      id:tweet.id,
      parentId:tweet.id,
      postId:tweet.conversation_id || tweet.id,
      postTitle:'X mention',
      author:user.username ? '@' + user.username : (user.name || 'X user'),
      text:tweet.text || '',
      publishedAt:tweet.created_at || null,
      handled:!!h,
      handledAt:h?.handledAt || null,
      openUrl:user.username ? 'https://x.com/' + encodeURIComponent(user.username) + '/status/' + encodeURIComponent(tweet.id) : 'https://x.com/i/web/status/' + encodeURIComponent(tweet.id)
    });
  }
  res.json({items,checkedAt:now()});
});
export const xMentionReplyEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  const session=await authorize(req);
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const tweetId=String(body?.tweetId || '').trim();
  const text=String(body?.text || '').trim();
  if(!/^[0-9]{5,30}$/.test(tweetId)) throw new AppError('Choose an X mention to reply to.');
  if(!text || text.length>280) throw new AppError('X replies must contain 1 to 280 characters.');
  const c=await xConnection();
  if(!c) throw new AppError('Connect X first.');
  const data=await api('/tweets',c.accessToken,{method:'POST',body:JSON.stringify({text,reply:{in_reply_to_tweet_id:tweetId}})});
  if(!data.data?.id) throw new AppError('X did not return a reply ID.',502,true);
  await write('comment-handled:x:' + tweetId,{handledAt:now(),handledBy:session.name,reason:'replied'});
  res.json({success:true,post:data.data});
});
export const xMentionHandledEndpoint = endpoint(async (req,res) => {
  only(req,res,['POST']);
  const session=await authorize(req);
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const tweetId=String(body?.tweetId || '').trim();
  if(!/^[0-9]{5,30}$/.test(tweetId)) throw new AppError('Choose an X mention.');
  const handled=body?.handled !== false;
  if(handled) await write('comment-handled:x:' + tweetId,{handledAt:now(),handledBy:session.name,reason:'manual'});
  else await redis('DEL',PREFIX + 'comment-handled:x:' + tweetId);
  res.json({success:true,handled});
});
