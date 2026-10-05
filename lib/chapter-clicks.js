// Read-only report for the owner's exact free-chapter PDF. No tracking writes.
import { AppError, authorize, endpoint, only, read, unseal } from './core.js';
import { localDate, shiftDate, midnight } from './website-interests.js';

export const TARGET = 'https://www.docjaks.com/_files/ugd/cf21c8_27ee63f049e5479b8d37c885f638bb2b.pdf';
const ASSET = 'cf21c8_27ee63f049e5479b8d37c885f638bb2b';
const ENABLED_DATE = '2026-10-05';
const BASE = 'https://www.wixapis.com/analytics/semantic-model/v3/semantic-models';
const MODEL = '0ddc1712-68b1-4fbf-9db4-223bd9124d19';
const FIELDS = ['clicks.element_title', 'clicks.element_type', 'clicks.element_id', 'clicks.element_linked_to_details', 'clicks.page_url_from_click', 'clicks.clicks_count', 'clicks.unique_visitors_clicks_count'];
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const ncell = (row, key) => num(row.fields?.[key]?.numericValue);
const text = (row, key) => row.fields?.[key]?.stringValue || '';
export function matchesPdf(value) {
  if (typeof value !== 'string') return false;
  try {
    const v = decodeURIComponent(value.trim());
    if (v.startsWith('wix:document://v1/')) return v.slice(18).split(/[/?#]/)[0] === ASSET + '.pdf';
    const url = new URL(v, 'https://www.docjaks.com');
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (!['www.docjaks.com', 'docjaks.com', 'static.wixstatic.com'].includes(url.hostname)) return false;
    return url.pathname.split('/').at(-1) === ASSET + '.pdf';
  } catch (_) { return false; }
}

export async function buildChapterReport(request, days, today) {
  const start = [ENABLED_DATE, shiftDate(today, -(days - 1))].sort().at(-1);
  const end = shiftDate(today, 1);
  const interval = { start: midnight(start), end: midnight(end), timezone: 'America/Chicago' };
  const schema = (await request(BASE + '/' + MODEL)).semanticModel;
  const schemaFields = [...(schema?.measures || []), ...(schema?.dimensions || []), ...(schema?.parameters || [])];
  for (const name of [...FIELDS, 'clicks.created_timeframe']) {
    const field = schemaFields.find(f => f.name === name);
    if (!field || field.dependencies?.some(d => ![...FIELDS, 'clicks.created_timeframe'].includes(d))) throw new AppError('Wix click fields changed. The chapter report needs review.', 503);
  }
  const query = body => request(BASE + '/query-data', { semanticModelId: MODEL, interval, ...body });
  const rows = [];
  let complete = false;
  for (let offset = 0; offset < 5000; offset += 1000) {
    const data = await query({ fields: FIELDS, paging: { limit: 1000, offset } });
    if (!Array.isArray(data.results)) throw new AppError('Wix did not return a usable click report.', 502);
    rows.push(...data.results);
    if (data.results.length < 1000) { complete = true; break; }
  }
  const matched = rows.filter(r => matchesPdf(text(r, 'clicks.element_linked_to_details')));
  const buttons = matched.map(r => ({ title: text(r, 'clicks.element_title'), type: text(r, 'clicks.element_type'), elementId: text(r, 'clicks.element_id'), page: text(r, 'clicks.page_url_from_click'), target: text(r, 'clicks.element_linked_to_details'), clicks: ncell(r, 'clicks.clicks_count'), uniqueClickers: ncell(r, 'clicks.unique_visitors_clicks_count') }));
  const usable = complete && buttons.length > 0 && buttons.every(r => r.clicks !== null);
  const clicks = usable ? buttons.reduce((sum, r) => sum + r.clicks, 0) : null;
  // Unique clickers are never summed across different buttons or pages.
  const uniqueClickers = usable && buttons.length === 1 ? buttons[0].uniqueClickers : null;
  let daily = [], dailyVerified = false;
  if (usable && clicks > 0) {
    const linkField = schemaFields.find(f => f.name === 'clicks.element_linked_to_details');
    const granularity = schemaFields.find(f => f.name === 'timeframeGranularity');
    if (linkField?.filters?.conditions?.includes('EQUAL') && granularity?.enumerations?.includes('DAY')) {
      try {
        const data = await query({ fields: ['clicks.element_title', 'clicks.element_type', 'clicks.created_timeframe', 'clicks.clicks_count'], filters: [{ field: 'clicks.element_linked_to_details', condition: 'EQUAL', prefix: 'IS', values: [...new Set(buttons.map(b => b.target))] }, { field: 'timeframeGranularity', condition: 'EQUAL', prefix: 'IS', values: ['DAY'] }], paging: { limit: 1000, offset: 0 } });
        const byDay = new Map();
        let valid = Array.isArray(data.results) && data.results.length < 1000;
        for (const row of data.results || []) {
          const stamp = row.fields?.['clicks.created_timeframe']?.timestampValue;
          const amount = ncell(row, 'clicks.clicks_count');
          if (!stamp || !Number.isFinite(Date.parse(stamp)) || amount === null) { valid = false; break; }
          const day = localDate(new Date(stamp));
          if (day < start || day >= end) { valid = false; break; }
          byDay.set(day, (byDay.get(day) || 0) + amount);
        }
        daily = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, clicks: count }));
        dailyVerified = valid && daily.reduce((sum, r) => sum + r.clicks, 0) === clicks;
        if (!dailyVerified) daily = [];
      } catch (_) { /* Keep the verified button results; omit unverified trends. */ }
    }
  }
  return { version: '2026-10-05.chapter.1', connected: true, status: clicks > 0 ? 'reported' : 'waiting', partial: !complete || buttons.some(r => r.clicks === null), target: TARGET, enabledDate: ENABLED_DATE, range: { start, end, days, timezone: 'America/Chicago' }, checkedAt: new Date().toISOString(), clicks, uniqueClickers, buttons, daily, dailyVerified, reportHasRows: rows.length > 0, uniqueMethod: buttons.length === 1 ? 'Single reported button' : 'Per-button counts only; visitors may overlap', measuresReading: false };
}
async function load(days, today) {
  const saved = await read('wix-blog-connection');
  if (!saved?.sealed) throw new AppError('Connect Wix website data first.', 409);
  const c = unseal(saved.sealed);
  if (!c.clientId || !c.clientSecret) throw new AppError('The Wix connection needs attention.', 409);
  const signal = AbortSignal.timeout(35000);
  const tr = await fetch('https://www.wixapis.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }), signal });
  const token = await tr.json();
  if (!tr.ok || !token.access_token) throw new AppError('Wix authorization needs attention.', 409);
  const request = async (url, body) => {
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: { Authorization: token.access_token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    if (!r.ok) throw new AppError('Wix click data could not be read. Other dashboard reports are unchanged.', 502);
    return r.json();
  };
  return buildChapterReport(request, days, today);
}
const cache = new Map(), pending = new Map();
export const chapterClicksEndpoint = endpoint(async (req, res) => {
  only(req, res, ['GET']); await authorize(req);
  const raw = req.query?.days || '7';
  if (!['7', '28'].includes(raw)) throw new AppError('Choose 7 or 28 days.');
  const today = localDate(new Date()), key = today + ':' + raw;
  const old = cache.get(key);
  if (old && old.until > Date.now()) return res.json({ ...old.data, cached: true });
  let job = pending.get(key);
  if (!job) {
    job = load(Number(raw), today).then(data => {
      if (cache.size > 3) cache.clear();
      cache.set(key, { data, until: Date.now() + 120000 });
      return data;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return res.json({ ...await job, cached: false });
});
