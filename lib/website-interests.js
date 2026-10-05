// Read-only audience-interest report. No login, credential, or site-content writes.
import { AppError, authorize, endpoint, only, read, unseal } from './core.js';

const BASE = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const ZONE = 'America/Chicago';
const VERSION = '2026-10-05.interests.1';
export const GROUPS = [
  { id: 'book', label: 'Book / Emberhold', paths: ['/wooden-token', '/wooden-token-downloads', '/product-page/the-wooden-token-digital', '/emberhold-library', '/papa-severin'] },
  { id: 'music', label: 'Music / KJAK', paths: ['/kjak-24-7', '/back-porch-rebellion', '/song-of-emberhold', '/listenting-dock', '/back-porch-downloads', '/product-page/back-porch-rebellion-the-album', '/product-page/emberhold-entire-album', '/product-page/green-eyed-hoodoo-voodoo-woman', '/product-page/23-years', '/product-page/doc-jak-funk', '/product-page/midnight-pit-lanterns'] },
  { id: 'soss', label: 'Soss / Smokehouse', paths: ['/soss-s', '/the-pit', '/why-are-bbq-isnt-reqular-bbq', '/product-page/2-soss-package', '/product-page/sweet-bayou', '/product-page/boss-soss'] },
  { id: 'general', label: 'General / Unknown', paths: [] }
];
const pathGroups = new Map(GROUPS.flatMap(g => g.paths.map(p => [p, g.id])));
const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const cell = (fields, key) => numeric(fields?.[key]?.numericValue);
export function groupFor(path) {
  const normalized = typeof path === 'string' ? path.split(/[?#]/)[0].replace(/\/+$/, '') || '/' : '';
  return pathGroups.get(normalized) || 'general';
}
export function localDate(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function shiftDate(value, days) {
  const d = new Date(value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function midnight(value) {
  const target = Date.parse(value + 'T00:00:00Z');
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
    guess -= Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - target;
  }
  return new Date(guess).toISOString();
}

// request(url, body) is injected to make the same query logic testable.
export async function buildReport(request, days, today) {
  const start = shiftDate(today, -(days - 1)), end = shiftDate(today, 1);
  const interval = { start: midnight(start), end: midnight(end), timezone: ZONE };
  const models = await request(BASE);
  const model = models.semanticModels?.find(m => m.slug === 'traffic');
  if (!model?.id) throw new AppError('Wix traffic analytics are not available.', 503);
  const schema = (await request(BASE + '/' + encodeURIComponent(model.id))).semanticModel;
  const fields = [...(schema?.measures || []), ...(schema?.dimensions || [])];
  for (const name of ['traffic.page_url_from', 'traffic.views_count', 'traffic.visitors_count', 'traffic.sessions_count', 'traffic.page_time_seconds_avg']) {
    const f = fields.find(x => x.name === name);
    if (!f || f.dependencies?.length) throw new AppError('The Wix traffic schema changed. Interest reporting needs review.', 503);
  }
  const pageField = fields.find(x => x.name === 'traffic.page_url_from');
  if (!pageField.filters?.conditions?.includes('EQUAL')) throw new AppError('Wix page filtering needs review.', 503);
  const query = body => request(BASE + '/query-data', { semanticModelId: model.id, interval, ...body });
  let rows = [], totals = {}, truncated = true;
  for (let offset = 0; offset < 5000; offset += 1000) {
    const data = await query({ fields: ['traffic.page_url_from', 'traffic.views_count', 'traffic.visitors_count', 'traffic.sessions_count', 'traffic.page_time_seconds_avg'], sort: { fieldName: 'traffic.views_count', order: 'DESC', nullsLast: true }, paging: { limit: 1000, offset }, totalsIncluded: true });
    if (!Array.isArray(data.results)) throw new AppError('Wix did not return a usable page report.', 502);
    if (offset === 0) totals = data.totals?.fields || {};
    rows.push(...data.results);
    if (data.results.length < 1000) { truncated = false; break; }
  }
  if (rows.some(r => !r.fields || !Object.hasOwn(r.fields, 'traffic.page_url_from') || !Object.hasOwn(r.fields, 'traffic.views_count'))) {
    throw new AppError('Wix omitted required page fields. Counts are not being guessed.', 502);
  }
  const pages = rows.map(r => ({ path: r.fields['traffic.page_url_from']?.stringValue ?? null, views: cell(r.fields, 'traffic.views_count'), visitors: cell(r.fields, 'traffic.visitors_count'), sessions: cell(r.fields, 'traffic.sessions_count'), avgTimeSeconds: cell(r.fields, 'traffic.page_time_seconds_avg') }));
  const warnings = truncated ? ['The page report reached its safety limit. Group results cover only returned pages.'] : [];
  const groups = await Promise.all(GROUPS.map(async g => {
    const included = pages.filter(p => groupFor(p.path) === g.id);
    const absenceKnown = !truncated && (pages.length > 0 || cell(totals, 'traffic.views_count') === 0);
    const views = !included.length && !absenceKnown ? null : included.every(p => p.views !== null) ? included.reduce((n, p) => n + p.views, 0) : null;
    let visitors = null, sessions = null, verified = false;
    if (!included.length && absenceKnown) { visitors = 0; sessions = 0; verified = true; }
    else if (included.length && included.every(p => typeof p.path === 'string' && p.path.length > 0) && included.length <= 500) {
      try {
        const data = await query({ fields: ['traffic.visitors_count', 'traffic.sessions_count', 'traffic.views_count'], filters: [{ field: 'traffic.page_url_from', condition: 'EQUAL', prefix: 'IS', values: [...new Set(included.map(p => p.path))] }], paging: { limit: 1, offset: 0 }, totalsIncluded: true });
        const f = data.totals?.fields || data.results?.[0]?.fields || {};
        // The combined filter must reconcile with the included page views.
        if (cell(f, 'traffic.views_count') === views && views !== null) {
          visitors = cell(f, 'traffic.visitors_count'); sessions = cell(f, 'traffic.sessions_count');
          verified = visitors !== null && sessions !== null;
        }
      } catch (_) { /* Preserve page views; do not invent deduplicated counts. */ }
    }
    if (!verified) warnings.push(g.label + ': unique visitors or sessions could not be verified.');
    return { id: g.id, label: g.label, views, visitors, sessions, verified, pages: included, mappedPaths: g.paths };
  }));
  const totalViews = cell(totals, 'traffic.views_count');
  const sumViews = groups.every(g => g.views !== null) ? groups.reduce((n, g) => n + g.views, 0) : null;
  const reconciled = !truncated && totalViews !== null && sumViews === totalViews;
  if (!reconciled) warnings.push('Page-view coverage does not match the site total. Treat the breakdown as partial.');
  return { version: VERSION, connected: true, partial: warnings.length > 0, checkedAt: new Date().toISOString(), range: { start, end, days, timezone: ZONE }, totals: { views: totalViews, visitors: cell(totals, 'traffic.visitors_count'), sessions: cell(totals, 'traffic.sessions_count') }, groups, warnings, reconciled, mappedPageCount: pages.length, method: 'Exact page mapping. Unique visitors and sessions are queried once per group, never summed across pages. A visitor can belong to more than one group.' };
}

async function load(days, today) {
  const saved = await read('wix-blog-connection');
  if (!saved?.sealed) throw new AppError('Connect Wix website data first.', 409);
  const c = unseal(saved.sealed);
  if (!c.clientId || !c.clientSecret) throw new AppError('The Wix connection needs attention.', 409);
  const signal = AbortSignal.timeout(35000);
  const tokenResponse = await fetch('https://www.wixapis.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }), signal });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) throw new AppError('Wix authorization needs attention.', 409);
  const request = async (url, body) => {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: token.access_token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    const data = await response.json();
    if (!response.ok) throw new AppError('Wix interest data could not be read. Retry after checking the Wix connection.', 502);
    return data;
  };
  return buildReport(request, days, today);
}
const cache = new Map(), pending = new Map();
export const websiteInterestsEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); await authorize(req);
  const raw = req.query?.days || '7';
  if (!['7', '28'].includes(raw)) throw new AppError('Choose 7 or 28 days.');
  const days = Number(raw), today = localDate(new Date()), key = today + ':' + raw;
  const prior = cache.get(key);
  if (prior && prior.until > Date.now()) return res.json({ ...prior.data, cached: true });
  let job = pending.get(key);
  if (!job) {
    job = load(days, today).then(data => {
      if (cache.size >= 4) cache.clear();
      cache.set(key, { data, until: Date.now() + (data.partial ? 30000 : 120000) });
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  res.json({ ...await job, cached: false });
});
