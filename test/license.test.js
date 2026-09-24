/**
 * License module tests — fetch is mocked, no network.
 * Run: npm test
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateLicense,
  validateLicense,
  deactivateLicense,
  refreshLicense,
  getDeviceId,
  LICENSE_API_BASE,
  PRODUCT_KEY,
  OFFLINE_GRACE_MS,
} from '../src/license.js';

const KEY = '0123456789abcdef0123456789abcdef';
const realFetch = globalThis.fetch;
let calls = [];

function mockFetch(status, body) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

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
