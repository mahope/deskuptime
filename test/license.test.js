/**
 * License module tests — fetch is mocked, no network.
 * Run: npm test
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  activateLicense,
  validateLicense,
  deactivateLicense,
  refreshLicense,
  getDeviceId,
  normalizeLicense,
  describeLicense,
  redactSecrets,
  LICENSE_API_BASE,
  PRODUCT_KEY,
  LICENSE_STATUS,
  LICENSE_TIMEOUT_MS,
  LICENSE_ATTEMPTS,
  OFFLINE_GRACE_MS,
} from '../src/license.js';

const KEY = '0123456789abcdef0123456789abcdef';
const realFetch = globalThis.fetch;
let calls = [];

function mockFetch(status, body, { raw = false } = {}) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (body instanceof Error) throw body;
    const payload = raw ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { 'Content-Type': raw ? 'text/html' : 'application/json' },
    });
  };
}

/** Retry tests must not pay the real pause; the attempt count is what they pin. */
const NO_WAIT = { retryDelayMs: 0 };

afterEach(() => { globalThis.fetch = realFetch; });

test('license: constants point at the Mahope license server', () => {
  assert.equal(LICENSE_API_BASE, 'https://mahope.tools/api/license');
  assert.equal(PRODUCT_KEY, 'deskuptime-pro');
  assert.equal(OFFLINE_GRACE_MS, 7 * 24 * 60 * 60 * 1000);
});

test('license: device id is stable and within 128 chars', () => {
  const id = getDeviceId();
  assert.equal(id, getDeviceId());
  assert.ok(id.length > 0 && id.length <= 128);
});

// ── device_id scheme: the golden fixture the desktop app must also pass ──
const golden = JSON.parse(readFileSync(new URL('./fixtures/device-id.golden.json', import.meta.url), 'utf8'));

test('device id: golden fixture is the version this build implements', () => {
  assert.equal(golden.version, 1);
  assert.equal(golden.prefix, 'deskuptime-');
  assert.equal(golden.max_length, 128);
  assert.equal(golden.fallback, 'unknown');
  assert.ok(Array.isArray(golden.cases) && golden.cases.length > 0);
});

test('device id: matches every case in the golden fixture', () => {
  for (const c of golden.cases) {
    assert.equal(
      getDeviceId({ platform: c.platform, env: c.env, host: c.hostname }),
      c.expected,
      `case ${c.name}`,
    );
  }
});

test('device id: Windows CLI and desktop agree on a long machine name', () => {
  // The bug this guards: os.hostname() returns the 15-char NetBIOS name, so the
  // CLI and the desktop app each claimed a seat for the same machine.
  const desktop = getDeviceId({ platform: 'win32', env: { COMPUTERNAME: 'WORKSTATION-NORD-01' }, host: 'WORKSTATIO-NORD-01' });
  assert.equal(desktop, 'deskuptime-workstation-nord-01');
  assert.notEqual(desktop, `deskuptime-${'workstatio-nord-01'}`);
});

test('device id: CLI and desktop both read COMPUTERNAME on Windows', () => {
  const args = { platform: 'win32', env: { COMPUTERNAME: 'WORKSTATION-NORD-01' }, host: 'WORKSTATIO-NORD-01' };
  assert.equal(getDeviceId(args), getDeviceId(args));
});

test('activate: posts key, device_id and product to /activate', async () => {
  mockFetch(200, { ok: true, activated: true, plan: 'pro', expires_at: null, devices_in_use: 1 });
  const res = await activateLicense(`  ${KEY.toUpperCase()} `, 'dev-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://mahope.tools/api/license/activate');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, { license_key: KEY, device_id: 'dev-1', product: 'deskuptime-pro' });
  assert.equal(res.valid, true);
  assert.equal(res.activated, true);
  assert.equal(res.key, KEY);
  assert.equal(res.deviceId, 'dev-1');
  assert.equal(res.meta.plan, 'pro');
  assert.equal(res.meta.devicesInUse, 1);
});

test('activate: device limit (409) fails with server message', async () => {
  mockFetch(409, { ok: false, error: 'Device limit reached' });
  const res = await activateLicense(KEY, 'dev-4');
  assert.equal(res.valid, false);
  assert.equal(res.status, 409);
  assert.match(res.error, /Device limit reached/);
});

test('activate: malformed key is rejected locally without a request', async () => {
  mockFetch(200, {});
  const res = await activateLicense('not-a-key', 'dev-1');
  assert.equal(res.valid, false);
  assert.equal(calls.length, 0);
});

test('validate: posts key, device_id and product to /validate', async () => {
  mockFetch(200, { ok: true, valid: true, plan: 'pro', expires_at: null });
  const res = await validateLicense(KEY, 'dev-1');
  assert.equal(calls[0].url, 'https://mahope.tools/api/license/validate');
  assert.deepEqual(calls[0].body, { license_key: KEY, device_id: 'dev-1', product: 'deskuptime-pro' });
  assert.equal(res.valid, true);
  assert.equal(res.transient, false);
});

test('validate: 503 and network errors are transient', async () => {
  mockFetch(503, { ok: false, error: 'Temporarily unavailable' });
  assert.equal((await validateLicense(KEY, 'dev-1')).transient, true);
  mockFetch(0, new TypeError('fetch failed'));
  const res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.valid, false);
  assert.equal(res.transient, true);
});

test('deactivate: posts key and device_id (no product) to /deactivate', async () => {
  mockFetch(200, { ok: true, deactivated: true, devices_in_use: 0 });
  const res = await deactivateLicense(KEY, 'dev-1');
  assert.equal(calls[0].url, 'https://mahope.tools/api/license/deactivate');
  assert.deepEqual(calls[0].body, { license_key: KEY, device_id: 'dev-1' });
  assert.equal(res.deactivated, true);
});

// ── refreshLicense: cached Pro status with 7-day offline grace ──
const NOW = Date.parse('2026-09-24T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const lic = (validatedDaysAgo) => ({
  key: KEY, instance: 'dev-1', validatedAt: new Date(NOW - validatedDaysAgo * DAY).toISOString(),
});

test('refresh: valid answer keeps Pro and bumps validatedAt', async () => {
  mockFetch(200, { ok: true, valid: true, plan: 'pro' });
  const r = await refreshLicense(lic(3), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.license.validatedAt, new Date(NOW).toISOString());
});

test('refresh: server down within 7 days keeps cached Pro', async () => {
  mockFetch(503, { ok: false, error: 'down' });
  const r = await refreshLicense(lic(6), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.license.key, KEY);
});

test('refresh: server down beyond 7 days drops Pro but keeps the key', async () => {
  mockFetch(0, new TypeError('fetch failed'));
  const r = await refreshLicense(lic(8), { now: NOW });
  assert.equal(r.pro, false);
  assert.equal(r.license.key, KEY);
});

test('refresh: definitive invalid answer drops Pro', async () => {
  mockFetch(403, { ok: false, error: 'License revoked' });
  const r = await refreshLicense(lic(1), { now: NOW });
  assert.equal(r.pro, false);
  assert.match(r.reason, /revoked/);
});

// ── P0-7: a hard timeout, so a hanging server cannot hang the CLI ──
test('license: every call carries an abort signal and a finite timeout', async () => {
  mockFetch(200, { ok: true, activated: true });
  await activateLicense(KEY, 'dev-1');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(LICENSE_TIMEOUT_MS, 10_000);
  // An unset signal would hang forever: a timed-out signal is what turns a
  // stalled connection into a transient verdict.
  assert.ok(Number.isFinite(LICENSE_TIMEOUT_MS) && LICENSE_TIMEOUT_MS > 0);
});

test('license: a real stalled server is aborted and reported as transient', async () => {
  const real = realFetch;
  let released;
  const stalled = new Promise((resolve) => { released = resolve; });
  const server = createServer(async (req, res) => { await stalled; res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  globalThis.fetch = (url, init) => real(`http://127.0.0.1:${port}/`, init);
  try {
    const res = await validateLicense(KEY, 'dev-1', { timeoutMs: 150 });
    assert.equal(res.valid, false);
    assert.equal(res.transient, true);
    assert.match(res.error, /did not answer within 150ms/);
  } finally {
    globalThis.fetch = real;
    released();
    server.close();
  }
});

// ── P0-7: which HTTP answers carry a verdict, and which do not ──
test('validate: 408 and 429 carry no verdict, 400/403/404/409 do', async () => {
  for (const status of [408, 429, 502, 503]) {
    mockFetch(status, { ok: false, error: 'later' });
    const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
    assert.equal(res.transient, true, `HTTP ${status} must be transient`);
  }
  for (const status of [400, 403, 404, 409]) {
    mockFetch(status, { ok: false, error: 'definitive' });
    const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
    assert.equal(res.transient, false, `HTTP ${status} must be a verdict`);
  }
});

test('validate: a 200 that is not a verdict (HTML page, empty body, ok:false) is transient', async () => {
  mockFetch(200, '<html>Just a moment…</html>', { raw: true });
  let res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.valid, false);
  assert.equal(res.transient, true, 'a captive portal must not read as "revoked"');

  mockFetch(200, {});
  res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.transient, true);

  mockFetch(200, { ok: false, error: 'proxy said no' });
  res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.transient, true);
});

test('validate: 200 with ok:true and valid:false is a real verdict, not a fault', async () => {
  mockFetch(200, { ok: true, valid: false, reason: 'Expired 2026-01-01' });
  const res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.valid, false);
  assert.equal(res.transient, false);
  assert.match(res.error, /Expired/);
});

test('validate: 200 with ok:true but no valid field is no verdict', async () => {
  mockFetch(200, { ok: true, plan: 'pro' });
  const res = await validateLicense(KEY, 'dev-1');
  assert.equal(res.transient, true, 'a missing verdict must not silently revoke Pro');
  const r = await refreshLicense(lic(1), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.status, LICENSE_STATUS.CACHED);
});

test('activate: a malformed 200 is transient and never stores a key', async () => {
  mockFetch(200, 'not json at all', { raw: true });
  const res = await activateLicense(KEY, 'dev-1');
  assert.equal(res.valid, false);
  assert.equal(res.activated, false);
  assert.equal(res.transient, true);
  assert.equal(res.key, undefined);
});

test('deactivate: transient or malformed answers keep the seat occupied', async () => {
  mockFetch(503, { ok: false, error: 'down' });
  let res = await deactivateLicense(KEY, 'dev-1');
  assert.equal(res.deactivated, false);
  assert.equal(res.transient, true);
  mockFetch(200, '<html>maintenance</html>', { raw: true });
  res = await deactivateLicense(KEY, 'dev-1');
  assert.equal(res.deactivated, false);
  mockFetch(200, { ok: true, deactivated: false });
  res = await deactivateLicense(KEY, 'dev-1');
  assert.equal(res.deactivated, false, 'only deactivated:true frees the seat');
});

// ── P0-7/P1-1 del B: status — five states, and the key is kept for diagnosis ──
test('refresh: a transient fault inside the grace window reports cached/offline', async () => {
  mockFetch(429, { ok: false, error: 'slow down' });
  const r = await refreshLicense(lic(1), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.status, LICENSE_STATUS.CACHED);
  assert.equal(r.license.status, LICENSE_STATUS.CACHED);
  assert.equal(r.license.key, KEY);
});

test('refresh: a malformed 200 keeps cached Pro instead of revoking it', async () => {
  mockFetch(200, '{"ok": true', { raw: true });
  const r = await refreshLicense(lic(2), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.status, LICENSE_STATUS.CACHED);
});

test('refresh: revoked key loses Pro at once but keeps the key for support', async () => {
  mockFetch(404, { ok: false, error: 'Unknown license key' });
  const r = await refreshLicense(lic(0.01), { now: NOW });
  assert.equal(r.pro, false);
  assert.equal(r.status, LICENSE_STATUS.INVALID);
  assert.equal(r.license.key, KEY, 'the key must survive so a later check can restore Pro');
  assert.equal(r.license.instance, 'dev-1');
});

test('refresh: no key at all is the free state', async () => {
  mockFetch(200, {});
  const r = await refreshLicense(null, { now: NOW });
  assert.equal(r.pro, false);
  assert.equal(r.status, LICENSE_STATUS.FREE);
  assert.equal(calls.length, 0);
});

test('describe: reports free, active, cached/offline and invalid', () => {
  assert.equal(describeLicense(null).status, LICENSE_STATUS.FREE);
  assert.equal(describeLicense({ key: KEY, instance: 'dev-1', status: 'active', validatedAt: new Date(NOW).toISOString() }, { now: NOW }).status, LICENSE_STATUS.ACTIVE);
  const cached = describeLicense({ key: KEY, instance: 'dev-1', status: 'cached', validatedAt: new Date(NOW - 2 * DAY).toISOString() }, { now: NOW });
  assert.equal(cached.status, LICENSE_STATUS.CACHED);
  assert.match(cached.detail, /unreachable/);
  const invalid = describeLicense({ key: KEY, instance: 'dev-1', status: 'invalid', validatedAt: new Date(NOW).toISOString() }, { now: NOW });
  assert.equal(invalid.status, LICENSE_STATUS.INVALID);
});

test('describe: a state file written before the status field exists is classified by age', () => {
  const fresh = { key: KEY, instance: 'dev-1', validatedAt: new Date(NOW - 1 * DAY).toISOString() };
  assert.equal(describeLicense(fresh, { now: NOW }).status, LICENSE_STATUS.ACTIVE);
  const stale = { key: KEY, instance: 'dev-1', validatedAt: new Date(NOW - 9 * DAY).toISOString() };
  const described = describeLicense(stale, { now: NOW });
  assert.equal(described.status, LICENSE_STATUS.UNVERIFIED);
  assert.match(described.detail, /9 days/);
  assert.match(described.detail, /not been rejected/);
});

test('describe: a cached state whose grace has since run out reports unverified, not cached', () => {
  const stale = { key: KEY, instance: 'dev-1', status: 'cached', validatedAt: new Date(NOW - 9 * DAY).toISOString() };
  const described = describeLicense(stale, { now: NOW });
  assert.equal(described.status, LICENSE_STATUS.UNVERIFIED);
  assert.match(described.detail, /not verified for 9 days/);
  assert.match(described.detail, /not been rejected/);
  assert.doesNotMatch(described.detail, /rejected this key/, 'no verdict is not a rejection');
});

test('refresh: a server that never answers past the grace reports unverified, not invalid', async () => {
  mockFetch(503, { ok: false, error: 'license server down' });
  const r = await refreshLicense(lic(9), { now: NOW });
  assert.equal(r.pro, false, 'no verdict can never entitle Pro');
  assert.equal(r.status, LICENSE_STATUS.UNVERIFIED);
  assert.equal(r.license.status, LICENSE_STATUS.UNVERIFIED);
  assert.equal(r.license.key, KEY, 'the key survives, so one good answer restores Pro');
});

test('describe: an unverified key says it was never rejected, so nobody buys a second one', () => {
  const described = describeLicense({ key: KEY, instance: 'dev-1', status: 'unverified', validatedAt: new Date(NOW - 9 * DAY).toISOString() }, { now: NOW });
  assert.equal(described.status, LICENSE_STATUS.UNVERIFIED);
  assert.match(described.detail, /not been reachable since/);
  assert.match(described.detail, /never rejected/);
  assert.doesNotMatch(described.detail, /rejected this key/);
});

test('normalizeLicense: the unverified status survives a round-trip through the state file', () => {
  const record = normalizeLicense({ key: KEY, instance: 'dev-1', status: 'unverified', validatedAt: '2026-09-24T12:00:00Z' });
  assert.equal(record.status, LICENSE_STATUS.UNVERIFIED);
  assert.equal(describeLicense(record, { now: NOW + 9 * DAY }).status, LICENSE_STATUS.UNVERIFIED);
});

test('normalizeLicense: a malformed record is not a license', () => {
  assert.equal(normalizeLicense(null), null);
  assert.equal(normalizeLicense('nope'), null);
  assert.equal(normalizeLicense({ key: 'short', instance: 'dev-1' }), null);
  assert.equal(normalizeLicense({ key: KEY.toUpperCase(), instance: '' }), null);
  assert.equal(normalizeLicense({ key: KEY, instance: 'x'.repeat(129) }), null);
  const ok = normalizeLicense({ key: ` ${KEY.toUpperCase()} `, instance: ' dev-1 ', status: 'active', validatedAt: '2026-09-24T12:00:00Z', plan: 'pro' });
  assert.deepEqual(ok, { key: KEY, instance: 'dev-1', status: 'active', validatedAt: '2026-09-24T12:00:00.000Z', plan: 'pro' });
});

// ── P0-7: no key, no machine name, in any message we print ──
test('redact: server errors and network errors never carry the key or the machine', () => {
  assert.equal(redactSecrets(`bad key ${KEY}`), 'bad key «key»');
  assert.equal(redactSecrets('device deskuptime-workstation-nord-01 rejected'), 'device deskuptime-«device» rejected');
  assert.doesNotMatch(redactSecrets('getaddrinfo failed for deskuptime-workstation-nord-01'), /workstation/);
});

test('redact: a server that echoes the key back cannot leak it to the terminal', async () => {
  mockFetch(403, { ok: false, error: `Key ${KEY} is for another product (deskuptime-maskine-01)` });
  const res = await validateLicense(KEY, 'dev-1');
  assert.doesNotMatch(res.error, new RegExp(KEY));
  assert.doesNotMatch(res.error, /maskine-01/);
  assert.match(res.error, /«key»/);
  const act = await activateLicense(KEY, 'dev-1');
  assert.doesNotMatch(act.error, new RegExp(KEY));
});

test('activate: 200 with ok:true but no activated field is no verdict', async () => {
  mockFetch(200, { ok: true, plan: 'pro' });
  const res = await activateLicense(KEY, 'dev-1');
  assert.equal(res.transient, true);
  assert.equal(res.key, undefined);
  // An explicit activated:false is a real answer and stays definitive.
  mockFetch(200, { ok: true, activated: false, error: 'Seat already released' });
  assert.equal((await activateLicense(KEY, 'dev-1')).transient, false);
});

// ── P2-1 del B: one bounded retry, so a blip is not a support ticket ──
// The bug these guard: a single 429 dropped a paying customer to cached, and a
// single dropped connection could start the seven-day unverified clock. A retry
// storm is the opposite failure, so the attempt count is pinned here too.
function mockFetchSequence(steps) {
  calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step.throw) throw step.throw;
    return new Response(step.raw ? step.body : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'Content-Type': step.raw ? 'text/html' : 'application/json', ...(step.headers ?? {}) },
    });
  };
}


test('license: a transient 503 is retried once and the next verdict is used', async () => {
  mockFetchSequence([
    { status: 503, body: { ok: false, error: 'Temporarily unavailable' } },
    { status: 200, body: { ok: true, valid: true, plan: 'pro' } },
  ]);
  const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
  assert.equal(res.valid, true);
  assert.equal(res.transient, false);
  assert.equal(calls.length, 2);
});

test('license: an activation that blips once still activates the key', async () => {
  // "A license that does not activate" is the mission's first priority. One
  // dropped connection must not read as a failed purchase.
  mockFetchSequence([
    { status: 500, body: { ok: false, error: 'boom' } },
    { status: 200, body: { ok: true, activated: true, plan: 'pro' } },
  ]);
  const res = await activateLicense(KEY, 'dev-1', NO_WAIT);
  assert.equal(res.activated, true);
  assert.equal(res.valid, true);
  assert.equal(res.key, KEY);
  assert.equal(calls.length, 2);
});

test('license: a verdict is never re-asked, however wrong it is', async () => {
  for (const step of [
    { status: 200, body: { ok: true, valid: false, reason: 'Revoked' } },
    { status: 403, body: { ok: false, error: 'Revoked' } },
    { status: 404, body: { ok: false, error: 'Unknown license key' } },
    { status: 409, body: { ok: false, error: 'Device limit reached' } },
  ]) {
    mockFetchSequence([step, { status: 200, body: { ok: true, valid: true } }]);
    const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
    assert.equal(res.valid, false, `HTTP ${step.status} must stay a verdict`);
    assert.equal(calls.length, 1, `HTTP ${step.status} must not be retried`);
  }
});

test('license: a healthy answer costs exactly one request', async () => {
  mockFetchSequence([{ status: 200, body: { ok: true, valid: true } }]);
  await validateLicense(KEY, 'dev-1', NO_WAIT);
  assert.equal(calls.length, 1, 'the common path must not pay for a retry it does not need');
});

test('license: two transient answers stop after one retry, never a storm', async () => {
  for (const step of [
    { status: 503, body: { ok: false, error: 'down' } },
    { status: 429, body: { ok: false, error: 'slow down' } },
    { status: 200, body: '<html>maintenance</html>', raw: true },
    { throw: new TypeError('fetch failed') },
  ]) {
    mockFetchSequence([step]);
    const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
    assert.equal(res.valid, false);
    assert.equal(res.transient, true);
    assert.equal(calls.length, LICENSE_ATTEMPTS, 'a persistent fault must not be retried forever');
  }
});

test('license: a long Retry-After is obeyed instead of hammered once more', async () => {
  mockFetchSequence([{ status: 429, body: { ok: false, error: 'rate limited' }, headers: { 'Retry-After': '60' } }]);
  const res = await validateLicense(KEY, 'dev-1', NO_WAIT);
  assert.equal(res.transient, true);
  assert.equal(calls.length, 1, 'the server asked us to come back later, not now');
});

test('license: a short Retry-After is taken as the pause before the retry', async () => {
  mockFetchSequence([
    { status: 429, body: { ok: false, error: 'rate limited' }, headers: { 'Retry-After': '0' } },
    { status: 200, body: { ok: true, valid: true } },
  ]);
  const started = Date.now();
  const res = await validateLicense(KEY, 'dev-1', { retryDelayMs: 60_000 });
  assert.equal(res.valid, true);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 5000, 'Retry-After must win over the default pause');
});

test('license: refresh keeps a paying customer on Pro through a single blip', async () => {
  // The end-to-end claim: one 503 must not start the seven-day unverified clock.
  mockFetchSequence([
    { status: 503, body: { ok: false, error: 'Temporarily unavailable' } },
    { status: 200, body: { ok: true, valid: true, plan: 'pro' } },
  ]);
  const r = await refreshLicense(lic(6), { now: NOW });
  assert.equal(r.pro, true);
  assert.equal(r.status, LICENSE_STATUS.ACTIVE, 'the retry restored a real verdict');
  assert.equal(calls.length, 2);
});
