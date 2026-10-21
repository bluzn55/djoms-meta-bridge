import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionEndpoint, PREFIX } from '../lib/core.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const TEST_ORIGIN = 'https://command.example.test';
const TEST_PASSWORD = 'this-is-only-a-test-password';
const ENV_KEYS = [
  'PUBLIC_BASE_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'DJOMS_SESSION_SECRET',
  'DJOMS_ADMIN_PASSWORD', 'DJOMS_OWNER_NAME',
];

function mockResponse() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}
function mockRequest(method, body = {}, cookie = '') {
  return {
    method, query: { action: 'session' }, body,
    headers: {
      origin: TEST_ORIGIN,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
  };
}

test('remembered owner session renews for 30 days on each return visit; short sessions do not', async () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const storage = new Map();
  try {
    Object.assign(process.env, {
      PUBLIC_BASE_URL: TEST_ORIGIN,
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-only-token',
      DJOMS_SESSION_SECRET: 'test-only-secret-of-at-least-32-characters',
      DJOMS_ADMIN_PASSWORD: TEST_PASSWORD,
      DJOMS_OWNER_NAME: 'Test Owner',
    });
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    Date.now = () => clock;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://redis.example.test');
      const [cmd, ...args] = JSON.parse(options.body);
      let result;
      if (cmd === 'GET') {
        const entry = storage.get(args[0]);
        if (entry && entry.expiry <= clock) storage.delete(args[0]);
        result = storage.get(args[0])?.value || null;
      } else if (cmd === 'SET') {
        const [key, value, expiryType, expirySeconds] = args;
        storage.set(key, {
          value,
          expiry: expiryType === 'EX' ? clock + Number(expirySeconds) * 1000 : Infinity,
        });
        result = 'OK';
      } else if (cmd === 'DEL') {
        result = storage.delete(args[0]) ? 1 : 0;
      } else if (cmd === 'EVAL') {
        // Simulate a first permitted login attempt.
        result = 1;
      } else {
        throw new Error('Unexpected Redis command ' + cmd);
      }
      return { ok: true, json: async () => ({ result }) };
    };

    const signIn = mockResponse();
    await sessionEndpoint(mockRequest('POST', { password: TEST_PASSWORD, remember: true }), signIn);
    assert.equal(signIn.statusCode, 200);
    assert.equal(signIn.body.authenticated, true);
    assert.match(signIn.headers['set-cookie'], /Max-Age=2592000/);
    const rememberedCookie = signIn.headers['set-cookie'].split(';')[0];
    const rememberedId = rememberedCookie.split('=')[1].split('.')[0];
    const rememberedKey = PREFIX + 'session:' + rememberedId;
    const first = JSON.parse(storage.get(rememberedKey).value);
    assert.equal(first.remember, true);

    clock += 10 * DAY_MS;
    const returnVisit = mockResponse();
    await sessionEndpoint(mockRequest('GET', {}, rememberedCookie), returnVisit);
    assert.equal(returnVisit.statusCode, 200);
    assert.equal(returnVisit.body.authenticated, true);
    assert.match(returnVisit.headers['set-cookie'], /Max-Age=2592000/);
    assert.equal(returnVisit.headers['set-cookie'].split(';')[0], rememberedCookie);
    const renewed = JSON.parse(storage.get(rememberedKey).value);
    assert.equal(renewed.expiresAt, clock + REMEMBER_SECONDS * 1000);
    assert.ok(renewed.expiresAt > first.expiresAt);

    clock += 20 * DAY_MS;
    const stillRemembered = mockResponse();
    await sessionEndpoint(mockRequest('GET', {}, rememberedCookie), stillRemembered);
    assert.equal(stillRemembered.body.authenticated, true, 'Returning within 30 days renews access');

    clock += 31 * DAY_MS;
    const expired = mockResponse();
    await sessionEndpoint(mockRequest('GET', {}, rememberedCookie), expired);
    assert.equal(expired.body.authenticated, false, '30 days without a visit expires the session');
    assert.equal(expired.headers['set-cookie'], undefined);

    const shortSignIn = mockResponse();
    await sessionEndpoint(mockRequest('POST', { password: TEST_PASSWORD, remember: false }), shortSignIn);
    const shortCookie = shortSignIn.headers['set-cookie'].split(';')[0];
    const shortId = shortCookie.split('=')[1].split('.')[0];
    const shortKey = PREFIX + 'session:' + shortId;
    const originalShort = JSON.parse(storage.get(shortKey).value);
    assert.equal(originalShort.remember, false);
    clock += 60 * 60 * 1000;
    const shortVisit = mockResponse();
    await sessionEndpoint(mockRequest('GET', {}, shortCookie), shortVisit);
    assert.equal(shortVisit.body.authenticated, true);
    assert.equal(shortVisit.headers['set-cookie'], undefined, 'Short logins are not silently extended');
    assert.deepEqual(JSON.parse(storage.get(shortKey).value), originalShort);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
});
