import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveReportWindow } from './report-window.js';

export const REPORT_VERSION = '2026-10-16.verified.1';
export const REPORT_ZONE = 'America/Chicago';
export const RANGE_DAYS = Object.freeze({ today: 1, '7d': 7, '30d': 30, '365d': 365 });

// Missing, suppressed and failed measurements must never become zero.
export function metricNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function insightValue(payload, metric) {
  const entry = (Array.isArray(payload?.data) ? payload.data : []).find(item => item.name === metric);
  if (!entry) return undefined;
  if (entry.total_value && Object.hasOwn(entry.total_value, 'value')) return entry.total_value.value;
  if (Object.hasOwn(entry, 'value')) return entry.value;
  if (Array.isArray(entry.values) && entry.values.length === 1) return entry.values[0]?.value;
  // Do not accidentally turn a daily series into a lifetime total.
  return undefined;
}

export function localDate(date, zone = REPORT_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDate(day, days) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function midnight(day, zone = REPORT_ZONE) {
  const target = Date.parse(day + 'T00:00:00Z');
  let value = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    const observed = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const adjustment = target - observed;
    value += adjustment;
    if (adjustment === 0) break;
  }
  return new Date(value).toISOString();
}

export function reportPeriod(range = '7d', at = new Date(), selectedWindow = null) {
  const window=(range==='custom' && selectedWindow?.range==='custom' && selectedWindow.start && selectedWindow.endInclusive && selectedWindow.end && Number.isInteger(selectedWindow.days))
    ? selectedWindow : resolveReportWindow(range==='custom'?{range,...selectedWindow}:{range},localDate(at));
  return {
    range, timezone: REPORT_ZONE, startDate:window.start, endDate:window.endInclusive,
    start:midnight(window.start), endExclusive:midnight(window.end),
    asOf:at.toISOString(), includesPartialToday:window.includesToday,days:window.days
  };
}

export function inPeriod(value, period) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp >= Date.parse(period.start) &&
    timestamp < Date.parse(period.endExclusive) && timestamp <= Date.parse(period.asOf);
}

export function metricCoverage(rows, key) {
  const values = rows.map(row => metricNumber(row[key]));
  const known = values.filter(value => value !== null);
  const complete = rows.length > 0 && known.length === rows.length;
  const subtotal = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  return { value: complete ? subtotal : null, measuredSubtotal: subtotal,
    measuredPosts: known.length, expectedPosts: rows.length, complete };
}

export function summarizePosts(rows, platform) {
  const coverage = {};
  for (const key of ['views', 'reactions', 'comments', 'shares', 'saves', 'clicks', 'reach']) {
    coverage[key] = metricCoverage(rows, key);
  }
  const sum = key => coverage[key].value;
  const interactionKeys = platform === 'instagram' ? ['reactions', 'comments', 'shares', 'saves'] : ['reactions', 'comments', 'shares'];
  const interactions = interactionKeys.every(key => sum(key) !== null)
    ? interactionKeys.reduce((total, key) => total + sum(key), 0) : null;
  const measured = rows.filter(row => ['views', 'reactions', 'comments', 'shares', 'clicks'].some(key => metricNumber(row[key]) !== null));
  const score = row => (metricNumber(row.clicks) ?? 0) * 4 + (metricNumber(row.shares) ?? 0) * 3 +
    (metricNumber(row.comments) ?? 0) * 2 + (metricNumber(row.reactions) ?? 0);
  const top = [...measured].sort((a, b) => score(b) - score(a) || String(a.postId).localeCompare(String(b.postId)))[0];
  return {
    posts: rows.length, views: sum('views'), reactions: sum('reactions'), likes: sum('reactions'),
    replies: sum('comments'), comments: sum('comments'), shares: sum('shares'), saves: sum('saves'),
    bookmarks: platform === 'x' ? sum('saves') : null, clicks: sum('clicks'),
    // Adding unique post viewers does not produce unique account viewers.
    reach: null, postViewerSum: sum('reach'), uniqueAccountViewers: null,
    interactions, engagementRate: null, coverage,
    topPost: top ? { recordId: top.recordId, title: top.title, campaign: top.campaign,
      permalink: top.permalink, views: top.views, reach: top.reach, clicks: top.clicks,
      shares: top.shares, comments: top.comments, reactions: top.reactions } : null,
    metricScope: 'Current lifetime counters for the listed posts, not actions that occurred only during the selected dates.',
    topPostBasis: 'Available interactions, not a complete ranking when some measurements are missing.'
  };
}

export function testingEstimate(website, fraction = 0.25) {
  const result = { fraction, source: 'Owner assumption', verifiedExclusion: false,
    note: 'Illustration only. Raw Wix records are unchanged. The remainder is not a verified count of customers or humans.' };
  for (const key of ['sessions', 'visitors', 'pageViews']) {
    const value = metricNumber(website?.[key]);
    result[key] = value === null ? null : Math.round(value * (1 - fraction));
  }
  return result;
}

export function reportSignature(secret, range, expires, refresh = '0') {
  return createHmac('sha256', secret)
    .update(`GET\n/api/meta/report\n${range}\n${expires}\n${refresh}`)
    .digest('hex');
}

// The signature is accepted ONLY by the read-only report route, never by owner APIs.
export function validReportSignature(req, secret, at = Date.now()) {
  if (req.method !== 'GET' || typeof secret !== 'string' || secret.length < 32) return false;
  const { range = '7d', expires, signature, refresh = '0' } = req.query || {};
  if (!Object.hasOwn(RANGE_DAYS, range) || !['0', '1'].includes(refresh)) return false;
  if (typeof expires !== 'string' || !/^\d{10}$/.test(expires) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const remaining = Number(expires) * 1000 - at;
  if (remaining <= 0 || remaining > 10 * 60 * 1000) return false;
  const expected = reportSignature(secret, range, expires, refresh);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}
