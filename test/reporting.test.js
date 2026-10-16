import test from 'node:test';
import assert from 'node:assert/strict';
import { metricNumber, insightValue, midnight, reportPeriod, inPeriod, metricCoverage, summarizePosts,
  testingEstimate, reportSignature, validReportSignature } from '../lib/report-metrics.js';
import { measurePost, verifiedAnalyticsEndpoint } from '../lib/verified-analytics.js';
import { ownerReportEndpoint } from '../lib/owner-report.js';
import { groupFor } from '../lib/website-interests.js';

for (const value of [undefined, null, '', ' ', false, true, NaN, Infinity, -1, {}, []]) {
  test('Reject missing or invalid metric: ' + String(value), () => assert.equal(metricNumber(value), null));
}
test('Keep measured zeros and valid numeric strings', () => {
  assert.equal(metricNumber(0), 0); assert.equal(metricNumber('0'), 0); assert.equal(metricNumber('42'), 42);
});
test('Accept modern total_value and one lifetime value', () => {
  assert.equal(insightValue({ data: [{ name: 'views', total_value: { value: 0 } }] }, 'views'), 0);
  assert.equal(insightValue({ data: [{ name: 'views', values: [{ value: 7 }] }] }, 'views'), 7);
  assert.equal(insightValue({ data: [{ name: 'views', values: [{ value: 2 }, { value: 3 }] }] }, 'views'), undefined);
});
test('Do not turn incomplete sums into complete totals', () => {
  assert.deepEqual(metricCoverage([{ views: 5 }, { views: null }], 'views'), {
    value: null, measuredSubtotal: 5, measuredPosts: 1, expectedPosts: 2, complete: false
  });
  assert.equal(metricCoverage([{ views: 0 }], 'views').value, 0);
  assert.equal(metricCoverage([], 'views').value, null);
});
test('Never add post viewers into account unique people', () => {
  const summary = summarizePosts([{ reach: 12, postId: '1' }, { reach: 12, postId: '2' }], 'facebook');
  assert.equal(summary.reach, null); assert.equal(summary.uniqueAccountViewers, null);
  assert.equal(summary.postViewerSum, 24); assert.equal(summary.engagementRate, null);
});
test('Central midnight respects seasonal offsets and DST boundaries', () => {
  assert.equal(midnight('2026-10-16'), '2026-10-16T05:00:00.000Z');
  assert.equal(midnight('2026-12-16'), '2026-12-16T06:00:00.000Z');
  assert.equal(midnight('2026-03-08'), '2026-03-08T06:00:00.000Z');
  assert.equal(midnight('2026-03-09'), '2026-03-09T05:00:00.000Z');
});
test('Use publication dates and exclude future records', () => {
  const period = reportPeriod('7d', new Date('2026-10-16T12:00:00Z'));
  assert.equal(period.startDate, '2026-10-10');
  assert.equal(inPeriod('2026-10-10T05:00:00Z', period), true);
  assert.equal(inPeriod('2026-10-10T04:59:59Z', period), false);
  assert.equal(inPeriod('2026-10-16T12:00:01Z', period), false);
  assert.equal(inPeriod(null, period), false);
  assert.throws(() => reportPeriod('all'));
});
test('Testing estimate never changes raw measurements', () => {
  const raw = { visitors: 54, sessions: 59, pageViews: 69, sales: 12 };
  const estimate = testingEstimate(raw);
  assert.deepEqual(raw, { visitors: 54, sessions: 59, pageViews: 69, sales: 12 });
  assert.equal(estimate.visitors, 41); assert.equal(estimate.verifiedExclusion, false);
  assert.equal(Object.hasOwn(estimate, 'sales'), false);
});
test('Outlaw page maps to Music; shared lobby stays General', () => {
  assert.equal(groupFor('/outlaw-radio-5150'), 'music');
  assert.equal(groupFor('/outlaw-radio-5150/?ref=test'), 'music');
  assert.equal(groupFor('/kjak-24-7'), 'music');
  assert.equal(groupFor('/kjak'), 'general');
  assert.equal(groupFor('/'), 'general');
});
test('Read-only signature is short-lived and binds method, range and refresh', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const secret = 'test-only-not-a-production-key-123456789';
  const query = { range: '7d', expires: String(now / 1000 + 120), refresh: '1' };
  query.signature = reportSignature(secret, query.range, query.expires, query.refresh);
  const request = { method: 'GET', query };
  assert.equal(validReportSignature(request, secret, now), true);
  assert.equal(validReportSignature({ ...request, method: 'POST' }, secret, now), false);
  assert.equal(validReportSignature({ ...request, query: { ...query, range: '30d' } }, secret, now), false);
  assert.equal(validReportSignature({ ...request, query: { ...query, refresh: '0' } }, secret, now), false);
  assert.equal(validReportSignature(request, secret, now + 121000), false);
  assert.equal(validReportSignature(request, secret, now - 700000), false);
  assert.equal(validReportSignature(request, 'wrong-secret-with-sufficient-length-12345', now), false);
});
test('One failed Meta metric cannot erase other measured fields', async () => {
  const seen = [];
  const fake = async (path, token, params) => {
    seen.push(params.metric);
    if (!params.metric) return { id: '123_456', reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } }, shares: { count: 0 } };
    if (params.metric === 'post_total_media_view_unique') throw new Error('Permission missing');
    const value = params.metric === 'post_clicks_by_type' ? { 'link clicks': 0 } : 17;
    return { data: [{ name: params.metric, values: [{ value }] }] };
  };
  const result = await measurePost({ platform: 'facebook', postId: '123_456', publishedAt: '2026-10-16T12:00:00Z' }, 'fake', true, fake);
  assert.equal(result.views, 17); assert.equal(result.reach, null); assert.equal(result.clicks, 0);
  assert.equal(result.comments, 0); assert.equal(result.shares, 0); assert.equal(result.reactions, 2);
  assert.equal(seen.includes('post_impressions_unique'), false);
  assert.equal(seen.includes('post_engaged_users'), false);
});
test('Public reports stay locked; report signatures cannot authorize the analytics owner route', async () => {
  Object.assign(process.env, { PUBLIC_BASE_URL: 'https://example.test', DJOMS_SESSION_SECRET: 'x'.repeat(40),
    DJOMS_ADMIN_PASSWORD: 'x'.repeat(24), KV_REST_API_URL: 'https://example.test/redis', KV_REST_API_TOKEN: 'fake' });
  const capture = () => ({ code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(value) { this.code = value; return this; }, json(value) { this.body = value; } });
  let res = capture();
  await ownerReportEndpoint({ method: 'GET', headers: {}, query: { action: 'report', range: '7d' } }, res);
  assert.equal(res.code, 401);
  res = capture();
  await ownerReportEndpoint({ method: 'POST', headers: {}, query: { action: 'report' } }, res);
  assert.equal(res.code, 405);
  res = capture();
  await verifiedAnalyticsEndpoint({ method: 'GET', headers: {}, query: { signature: 'f'.repeat(64) } }, res);
  assert.equal(res.code, 401);
});
