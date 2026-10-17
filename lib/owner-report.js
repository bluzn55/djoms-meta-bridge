import { AppError, config, env, id, now, write, authorize, endpoint, only } from './core.js';
import { collectAnalytics } from './verified-analytics.js';
import { REPORT_VERSION, reportPeriod, metricNumber, testingEstimate, validReportSignature } from './report-metrics.js';
import { wixSiteStatus } from './wix-blog.js';
import { youtubeConnection, youtubeStatus } from './youtube.js';
import { buildRadioReport } from './radio-report.js';
import { reportAccess } from './report-access.js';
import { resolveReportWindow } from './report-window.js';

const YT_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const YT_BASE_SCOPES = 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';
const combinedCache = new Map();
const combinedPending = new Map();

// Kept for a future, explicit YouTube reporting request. Not called by combinedReport.
export async function youtubeAnalytics(range) {
  const period = reportPeriod(range);
  const scope = { startDate: period.startDate, endDate: period.endDate, timezone: 'America/Los_Angeles',
    note: 'YouTube uses Pacific calendar days and may delay recent statistics. This is not the Central-time website window.' };
  let account = null;
  try {
    account = await youtubeStatus(false);
    const c = await youtubeConnection();
    if (!c?.accessToken) return { status: 'not_connected', period: scope, checkedAt: now(), account: accountSummary(account), metrics: null };
    const metrics = ['views', 'estimatedMinutesWatched', 'likes', 'comments', 'shares', 'subscribersGained', 'subscribersLost'];
    const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports');
    url.search = new URLSearchParams({ ids: 'channel==MINE', startDate: scope.startDate, endDate: scope.endDate,
      metrics: metrics.join(','), dimensions: 'day', sort: 'day', maxResults: '400' }).toString();
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + c.accessToken }, signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    if (!response.ok || data.error) {
      const reason = data.error?.errors?.[0]?.reason;
      const disabled = reason === 'accessNotConfigured';
      return { status: disabled ? 'analytics_api_not_enabled' : response.status === 403 ? 'permission_or_api_setup_required' : 'unavailable', period: scope,
        checkedAt: now(), account: accountSummary(account), metrics: null,
        message: disabled ? 'Google reports that the YouTube Analytics API is not enabled for the connected app. Enable that API before retrying; reconnecting alone does not enable it.' : response.status === 403 ? 'YouTube has not authorized this analytics request. Check read-only reporting permission and app access.' : 'YouTube did not return the requested statistics.',
        providerStatus: response.status, providerReason: typeof reason === 'string' ? reason.slice(0, 120) : null,
        connectUrl: disabled ? null : '/api/meta/youtube-report-connect' };
    }
    const headers = Array.isArray(data.columnHeaders) ? data.columnHeaders.map(header => header.name) : [];
    if (!['day', ...metrics].every(name => headers.includes(name))) {
      return { status: 'incomplete_response', period: scope, checkedAt: now(), account: accountSummary(account), metrics: null,
        message: 'YouTube omitted requested report columns. No totals were guessed.' };
    }
    const rows = (Array.isArray(data.rows) ? data.rows : []).map(row => Object.fromEntries(headers.map((name, index) =>
      [name, name === 'day' ? row[index] : metricNumber(row[index])])));
    const totals = Object.fromEntries(metrics.map(name => [name, rows.length && rows.every(row => row[name] !== null)
      ? rows.reduce((sum, row) => sum + row[name], 0) : null]));
    return { status: rows.length ? 'available' : 'no_rows_returned', period: scope, checkedAt: now(),
      account: accountSummary(account), metrics: totals, daily: rows,
      returnedThrough: rows.length ? rows.at(-1).day : null,
      message: rows.length ? 'Totals cover returned days only. Missing days are not filled with zeros.' : 'No daily rows were returned. This is not treated as confirmed zero activity.' };
  } catch {
    return { status: 'unavailable', period: scope, checkedAt: now(), account: accountSummary(account), metrics: null,
      message: 'The YouTube reporting connection could not be read. Existing posting settings were not changed.' };
  }
}

function accountSummary(account) {
  if (!account) return null;
  return { connected: !!account.connected, id: account.id || null, name: account.name || null,
    subscribers: metricNumber(account.subscribers), lifetimeViews: metricNumber(account.views),
    videoCount: metricNumber(account.videoCount), scope: 'Current cumulative channel counters, not period totals.' };
}

export const youtubeReportingConnectEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  const session = await authorize(req);
  if (!env().YOUTUBE_CLIENT_ID || !env().YOUTUBE_CLIENT_SECRET) throw new AppError('YouTube account setup is incomplete.', 503);
  const state = id();
  await write('youtube-oauth:' + state, { sessionId: session.id }, 600);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env().YOUTUBE_CLIENT_ID,
    redirect_uri: config().origin + '/api/youtube/callback', response_type: 'code',
    scope: YT_BASE_SCOPES + ' ' + YT_ANALYTICS_SCOPE, access_type: 'offline',
    include_granted_scopes: 'true', prompt: 'consent', state }).toString();
  res.redirect(302, url.toString());
});

export async function combinedReport(range = '7d', refresh = false, selectedWindow=null) {
  const period=reportPeriod(range,new Date(),selectedWindow);
  const key=range+':'+period.startDate+':'+period.endDate;
  const cached = combinedCache.get(key);
  if (!refresh && cached && cached.until > Date.now()) return { ...cached.report, cached: true };
  if (combinedPending.has(key)) return combinedPending.get(key);
  const job = (async () => {
    // Only the active reporting sources. Inactive platforms do not gate this report.
    const tasks = await Promise.allSettled([
      collectAnalytics(range, refresh, selectedWindow), wixSiteStatus(range, selectedWindow||{}), reportAccess()
    ]);
    const result = index => tasks[index].status === 'fulfilled' ? tasks[index].value : null;
    const allSocial = result(0);
    const social = allSocial ? {
      ...allSocial,
      platforms: Object.fromEntries(Object.entries(allSocial.platforms || {}).filter(([key]) => ['facebook', 'instagram'].includes(key))),
      posts: (allSocial.posts || []).filter(post => ['facebook', 'instagram'].includes(post.platform)),
      campaigns: (allSocial.campaigns || []).map(campaign => ({ ...campaign,
        platforms: Object.fromEntries(Object.entries(campaign.platforms || {}).filter(([key]) => ['facebook', 'instagram'].includes(key))) }))
    } : null;
    const website = result(1);
    const imported = buildRadioReport();
    const days = (imported.rows || []).map(row => row.date).filter(Boolean).sort();
    const report = {
      version: REPORT_VERSION, checkedAt: now(), requestedRange: range,
      activeSources: ['facebook', 'instagram', 'website', 'radio'],
      excludedSources: ['youtube', 'x'],
      metaAccess: result(2) || { status: 'cannot_check' },
      social: social || { status: 'unavailable', platforms: {}, message: 'Social reporting could not be retrieved.' },
      website: website ? { ...website, scopeNote: 'Wix website summary uses the same requested Central-time reporting window.' }
        : { status: 'unavailable', message: 'Wix data could not be retrieved.' },
      websiteTestingEstimate: testingEstimate(website),
      youtube: { status: 'not_in_scope', metrics: null, connectUrl: null,
        message: 'Set aside at the owner\'s request. No YouTube reporting request is made by this report. Account connections are unchanged.' },
      x: { status: 'not_in_scope', account: null,
        message: 'Set aside at the owner\'s request. No X reporting request is made by this report. Account connections and scheduled posts are unchanged.' },
      radio: { status: 'current_listener_data_not_connected', station: 'Outlaw Radio 5150', listeners: null,
        message: 'Website visits do not establish listening. The saved Radio.co export is historical, not a live feed.',
        historicalImport: { sourceFile: imported.sourceFile, importedAt: imported.importedAt,
          firstDate: days[0] || null, lastDate: days.at(-1) || null, timezone: imported.timezone || 'UTC' } },
      songPreviews: { status: 'not_connected', starts: null, listeningTime: null },
      guardrails: ['Missing measurements stay null, not zero.', 'Raw website data is never reduced by the testing estimate.',
        'No cross-platform unique-person total is calculated.', 'Post views, website visits and radio listening are distinct measurements.',
        'No causal sales attribution is inferred from simultaneous activity.']
    };
    await write(`owner-report:${REPORT_VERSION}:${key}`, report, 86400 * 7).catch(() => {});
    combinedCache.set(key, { report, until: Date.now() + 60000 });
    return { ...report, cached: false };
  })().finally(() => combinedPending.delete(key));
  combinedPending.set(key, job);
  return job;
}

export const ownerReportEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const allowed=new Set(['action','range','start','end','refresh','expires','signature']);
  if(Object.keys(req.query||{}).some(key=>!allowed.has(key)))throw new AppError('Unsupported report parameter.');
  const requestWindow=resolveReportWindow(req.query||{});
  if(requestWindow.range==='custom'||!validReportSignature(req,env().DJOMS_REPORT_READ_SECRET))
    await authorize(req);
  res.json(await combinedReport(requestWindow.range,req.query?.refresh==='1',requestWindow));
});
