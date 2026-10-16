import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedReport } from '../lib/owner-report.js';

test('Combined report makes no YouTube or X provider requests', async () => {
  const originalFetch = globalThis.fetch;
  const keys = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const commands = [];
  try {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.META_PAGE_ID;
    delete process.env.META_PAGE_ACCESS_TOKEN;
    process.env.KV_REST_API_URL = 'https://fixture-redis.invalid';
    process.env.KV_REST_API_TOKEN = 'synthetic-only';
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://fixture-redis.invalid', 'Unexpected provider request');
      const command = JSON.parse(options.body);
      commands.push(command);
      assert.ok(['GET', 'ZCARD', 'ZREVRANGE', 'SET'].includes(command[0]));
      if (command[0] === 'SET') assert.match(command[1], /^djoms:v2:(verified-analytics:|owner-report:)/);
      const result = command[0] === 'ZCARD' ? 0 : command[0] === 'ZREVRANGE' ? [] : command[0] === 'SET' ? 'OK' : null;
      return { ok: true, json: async () => ({ result }) };
    };
    const report = await combinedReport('7d', true);
    assert.deepEqual(report.excludedSources, ['youtube', 'x']);
    assert.equal(report.youtube.status, 'not_in_scope');
    assert.equal(report.x.status, 'not_in_scope');
    assert.equal(report.youtube.metrics, null);
    assert.deepEqual(Object.keys(report.social.platforms), ['facebook', 'instagram']);
    assert.equal(report.radio.listeners, null);
    assert.equal(commands.some(command => /youtube|x-status/.test(String(command[1]))), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
