/**
 * P1-46: the same site in two spellings is one site.
 *
 * Measured 2026-09-26 with the real CLI, a real local site answering 200, a
 * real `state.json` and a real Pro client report:
 *
 *   deskuptime watch http://kunde.dk    →  baseline recorded: UP (200)
 *   deskuptime watch http://kunde.dk/   →  baseline recorded: UP (200)   ← same site
 *   deskuptime status                   →  Monitored URLs (2)
 *   deskuptime report                   →  | http://kunde.dk  | UP (200) | 100% (2 checks) …
 *                                        | http://kunde.dk/ | UP (200) | 100% (1 checks) …
 *                                        **2 site(s) · 2 up · 0 down · 3 checks · 0 failed**
 *   deskuptime unwatch http://kunde.dk/ →  ❌ Error: not monitored
 *
 * Four harms from one missing decision. The trailing slash is what a browser's
 * address bar shows, so it is the form a user copies; it took a second of the
 * free tier's three slots, so a customer with two sites could not add their
 * third. It was requested again on every pass. It got a second row with its own
 * numbers in the document a bureau sends to a customer, under a summary that
 * counted one site twice — and the only documented way to remove it answered
 * "not monitored", which sent the user to hand-edit the file that holds their
 * license key.
 *
 * `new URL()` is the parser `isHttpUrl()` already trusts, so the comparison is
 * the one the validator makes. The tests below are the same measurement, kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUrlKey, sameUrl, urlIdentity } from '../src/status.js';
import { monitoredCount } from '../src/watch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const license = { key: KEY, instance: 'p146', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-onesite-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

function fixture(t) {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>hej</title>hei</html>'); });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function savedKeys(home) {
  return Object.keys(JSON.parse(readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf-8')).urls);
}

const entry = (extra = {}) => ({ addedAt: '2026-09-20T00:00:00.000Z', wasUp: true, lastChecked: new Date().toISOString(), checks: 4, checksUp: 4, sslWarned: false, ...extra });

// ── The owner: one form two addresses are compared in ──

test('two spellings of one address are the same address', () => {
  assert.equal(urlIdentity('https://kunde.dk'), 'https://kunde.dk/');
  assert.equal(sameUrl('https://kunde.dk', 'https://kunde.dk/'), true);
  assert.equal(sameUrl('HTTPS://Kunde.DK', 'https://kunde.dk/'), true);
  assert.equal(sameUrl('https://kunde.dk:443/', 'https://kunde.dk/'), true);
  assert.equal(sameUrl('  https://kunde.dk/  ', 'https://kunde.dk/'), true);
  assert.equal(sameUrl('https://kunde.dk/a/../b', 'https://kunde.dk/b'), true);
});

test('a different site, path or query is not the same site', () => {
  assert.equal(sameUrl('https://kunde.dk/', 'https://kunde.dk/om'), false);
  assert.equal(sameUrl('https://kunde.dk/', 'https://kunde.dk/?a=1'), false);
  assert.equal(sameUrl('https://kunde.dk/', 'https://kunde.dk:8443/'), false);
  assert.equal(sameUrl('https://kunde.dk/', 'http://kunde.dk/'), false);
  assert.equal(sameUrl('https://kunde.dk/', 'https://www.kunde.dk/'), false);
});

test('a key that is not an address stays itself (the P1-40 class is untouched)', () => {
  assert.equal(urlIdentity('kunde.dk'), 'kunde.dk');
  assert.equal(sameUrl('kunde.dk', 'kunde.dk'), true);
  // Two unusable keys are two keys: neither can be measured, so merging them
  // would lose a row the user has to be able to remove by name.
  assert.equal(sameUrl('kunde.dk', 'Kunde.dk'), false);
  assert.equal(sameUrl('kunde.dk', 'kunde.dk/'), false);
});

test('an exact key wins over a normalised match, so both halves stay removable', () => {
  const urls = { 'https://kunde.dk': entry(), 'https://kunde.dk/': entry() };
  assert.equal(findUrlKey(urls, 'https://kunde.dk'), 'https://kunde.dk');
  assert.equal(findUrlKey(urls, 'https://kunde.dk/'), 'https://kunde.dk/');
  assert.equal(findUrlKey(urls, 'https://kunde.dk/?x=1'), null);
  assert.equal(findUrlKey(urls, 'https://anden.dk/'), null);
  assert.equal(findUrlKey({}, 'https://kunde.dk'), null);
});

// ── The three places that asked the wrong question ──

test('the same site in two spellings holds one free slot, not two', () => {
  assert.equal(monitoredCount({ urls: { 'https://a.dk/': entry(), 'https://b.dk/': entry() } }), 2);
  assert.equal(monitoredCount({ urls: { 'https://a.dk': entry(), 'https://a.dk/': entry() } }), 1);
  // A key a pass can never check still holds no slot (P1-40), and it is counted
  // apart from an address that happens to normalise to the same text.
  assert.equal(monitoredCount({ urls: { 'kunde.dk': entry() } }), 0);
  assert.equal(monitoredCount({ urls: { 'kunde.dk': entry(), 'https://a.dk/': entry() } }), 1);
  assert.equal(monitoredCount({ urls: {} }), 0);
  assert.equal(monitoredCount({}), 0);
});

test('watching the same site twice keeps one key and one row', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const bare = `http://127.0.0.1:${port}`;

  assert.equal((await run(['watch', bare, '--once'], { env: home })).code, 0);
  const again = await run(['watch', `${bare}/`, '--once'], { env: home });
  assert.equal(again.code, 0);
  assert.match(again.stdout, new RegExp(`Already monitoring this site as ${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} —`));
  assert.deepEqual(savedKeys(home), [bare]);

  const status = await run(['status'], { env: home });
  assert.match(status.stdout, /Monitored URLs \(1\)/);
  assert.doesNotMatch(status.stdout, /\n {2}[✅⚠️·❌] http:\/\/127\.0\.0\.1:\d+\/\s/);
});

test('a refused duplicate leaves the free slot free for a real third site', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const bare = `http://127.0.0.1:${port}`;

  await run(['watch', bare, '--once'], { env: home });
  await run(['watch', `${bare}/b`, '--once'], { env: home });
  // The same site as the first one, in the form the address bar shows. Before
  // this it took the third slot, and the customer's real third site was refused.
  const dup = await run(['watch', `${bare}/`, '--once'], { env: home });
  assert.equal(dup.code, 0);
  assert.doesNotMatch(dup.stdout + dup.stderr, /Free tier monitors/);

  const third = await run(['watch', `${bare}/c`, '--once'], { env: home });
  assert.equal(third.code, 0);
  assert.doesNotMatch(third.stdout + third.stderr, /Free tier monitors/);
  assert.deepEqual(savedKeys(home), [bare, `${bare}/b`, `${bare}/c`]);

  // And the fourth real site is still the one that is refused, on the free tier.
  const fourth = await run(['watch', `${bare}/d`, '--once'], { env: home });
  assert.notEqual(fourth.code, 0);
  assert.match(fourth.stderr, /Free tier monitors 3 URLs/);
});

test('a path, a query and a port are all part of the address', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const bare = `http://127.0.0.1:${port}`;

  // `/a` and `/a/` are two pages, not two spellings of one — a trailing slash
  // only fills in an *empty* path, so the merge cannot swallow a real site.
  for (const url of [`${bare}/a`, `${bare}/a/`, `${bare}/a?x=1`]) {
    assert.equal((await run(['watch', url, '--once'], { env: home })).code, 0);
  }
  assert.deepEqual(savedKeys(home), [`${bare}/a`, `${bare}/a/`, `${bare}/a?x=1`]);
});

test('unwatch finds the site in the spelling the address bar shows', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const bare = `http://127.0.0.1:${port}`;

  await run(['watch', bare, '--once'], { env: home });
  const out = await run(['unwatch', `${bare}/`], { env: home });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /No longer monitoring/);
  assert.deepEqual(savedKeys(home), []);
  assert.match((await run(['status'], { env: home })).stdout, /Monitored URLs \(0\)/);
});

test('a file that already holds both spellings can still be cleaned up by hand', async (t) => {
  const home = tempHome(t);
  writeFileSync(join(home.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    urls: { 'https://kunde.dk': entry(), 'https://kunde.dk/': entry(), 'https://b.dk/': entry() },
    license,
  }, null, 2));

  // One `unwatch` removes one key, and the other spelling is then the only
  // one left — so the two rows in an old client report are repairable without
  // ever opening the file by hand.
  const out = await run(['unwatch', 'https://kunde.dk'], { env: home });
  assert.equal(out.code, 0);
  assert.deepEqual(savedKeys(home), ['https://kunde.dk/', 'https://b.dk/']);

  const second = await run(['unwatch', 'https://kunde.dk/'], { env: home });
  assert.equal(second.code, 0);
  assert.deepEqual(savedKeys(home), ['https://b.dk/']);

  // A site that is not saved is still "not monitored" — the tolerance is for
  // spellings, not for a URL nobody asked us to watch.
  const missing = await run(['unwatch', 'https://kunde.dk'], { env: home });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /not monitored/);
});
