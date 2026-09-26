/**
 * An expired certificate must never read as one that is about to expire.
 *
 * `checkSSL` clamps `validDays` to `Math.max(0, …)` and computed `isExpired`
 * correctly, but **no surface read `isExpired`**. Measured against a real
 * certificate whose `notAfter` is 1 February 2020, every surface said the same
 * thing as for a certificate expiring tonight:
 *
 *   checkSSL  -> {"validDays":0,"isExpired":true,"expiresSoon":true}
 *   `check`   ->  🔒 SSL:  0d ✅   (and "renew soon" inside the window)
 *
 * For a bureau whose headline feature is expiry warnings, "renew soon" about a
 * certificate that broke the site last week is the worst answer available, and
 * it is the one a customer reads. These tests pin the fix at every surface, and
 * pin them to *one* owner so they cannot drift apart again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { checkSSL } from '../src/checkers/ssl.js';
import { summarize } from '../src/engine.js';
import { runPass } from '../src/watch.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';
import { readEntry, readSslState, expiredNote, SSL_WARN_DAYS } from '../src/status.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;
// Asynchronous, because the TLS fixture lives in *this* process: a synchronous
// spawn would block the event loop and the fixture could never accept the
// connection, which looks exactly like the CLI timing out.
const run = promisify(execFile);

const URL_UP = 'https://acme.dk/';
const freshEntry = (extra = {}) => ({
  wasUp: true,
  lastStatus: 200,
  lastChecked: new Date().toISOString(),
  checks: 10,
  checksUp: 10,
  ...extra,
});

function hasOpenssl() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

/** A real TLS server with a certificate whose `notAfter` is in the past. */
function expiredTlsServer() {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-expired-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-nodes', '-subj', '/CN=expired.example',
    '-not_before', '20200101000000Z', '-not_after', '20200201000000Z',
  ], { stdio: 'ignore' });

  return new Promise((resolve) => {
    const server = tls.createServer({
      key: readFileSync(join(dir, 'k.pem')),
      cert: readFileSync(join(dir, 'c.pem')),
    }, (socket) => socket.end('hi'));
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => { server.close(done); rmSync(dir, { recursive: true, force: true }); }),
    }));
  });
}

// --- the owner itself -------------------------------------------------------

test('readSslState: a lapsed certificate is expired, not "0 days left"', () => {
  // The measured checker output, verbatim.
  const lapsed = readSslState({ days: 0, expired: true, expiredDays: 2381 });
  assert.equal(lapsed.expired, true);
  assert.equal(lapsed.expiringSoon, false, 'an expired certificate is not "renew soon"');
  assert.equal(expiredNote(lapsed.expiredDays), 'expired 2381d ago');

  // A certificate expiring tonight is the same `days: 0` and is NOT expired.
  const tonight = readSslState({ days: 0, expired: false, expiredDays: null });
  assert.equal(tonight.expired, false);
  assert.equal(tonight.expiringSoon, true);
});

test('readSslState: the owner is the only place that decides the window', () => {
  for (const days of [0, 1, SSL_WARN_DAYS]) {
    assert.equal(readSslState({ days }).expiringSoon, true, `${days} d is inside the window`);
  }
  for (const days of [SSL_WARN_DAYS + 1, 3650]) {
    assert.equal(readSslState({ days }).expiringSoon, false, `${days} d is outside the window`);
  }
  // Unknown is not urgent: NaN, Infinity, a string, a boolean, negative, null.
  for (const bad of [NaN, Infinity, -Infinity, -3, '9', true, null, undefined, {}]) {
    const ssl = readSslState({ days: bad });
    assert.equal(ssl.days, null, `${String(bad)} is not a day count`);
    // `null` since P1-22, where this was `false`: an unreadable day count is no
    // measurement, so the owner says nothing about the window. The intent of the
    // line is unchanged — nothing invents a renewal — and `false` is the value
    // that claimed a certificate had been measured.
    assert.equal(ssl.expiringSoon, null, `${String(bad)} must not invent a renewal`);
    assert.notEqual(ssl.expiringSoon, true);
    assert.equal(ssl.expired, false, 'a corrupt value is not an expired certificate');
  }
  // A negative day count with no expiry fact stays unknown — never expired.
  assert.equal(readSslState({ days: -3 }).unreadable, true);
  assert.equal(readSslState({ days: -3 }).expired, false);
  // `expired: true` alone is enough to say expired, even without a day count.
  const unknownWhen = readSslState({ days: null, expired: true, expiredDays: null });
  assert.equal(unknownWhen.expired, true);
  assert.equal(expiredNote(unknownWhen.expiredDays), 'expired — expiry date unknown');
});

// --- the real certificate, measured -----------------------------------------

test('ssl: a genuinely expired certificate is reported as expired, with an age', async (t) => {
  if (!hasOpenssl()) return t.skip('openssl is not available');
  const server = await expiredTlsServer();
  t.after(() => server.close());

  const ssl = await checkSSL(`https://127.0.0.1:${server.port}/`);
  assert.equal(ssl.isExpired, true, 'the checker must see a 2020 certificate as expired');
  assert.equal(ssl.expiredDays > 2000, true, 'and know how long ago it lapsed');
  assert.equal(ssl.validDays, 0, 'validDays stays clamped for compatibility');

  // The `check` surface.
  const summary = summarize({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 85, timestamp: new Date().toISOString(), ssl });
  assert.match(summary.ssl, /^🔴 expired \d+d ago$/, 'not "0d ✅" and not "renew soon"');
  assert.equal(summary.sslIcon, '🔴');
  assert.equal(summary.ssl.includes('⚠️'), false, 'an expired certificate must not warn as expiring');
});

// --- every surface agrees ---------------------------------------------------

test('every surface says the same thing about the same certificate', () => {
  // One entry, four readers: `check` (summarize), `watch --status`/status
  // (readEntry) and the client report (buildReport).
  const lapsed = { validDays: 0, isExpired: true, expiredDays: 12 };
  const entry = freshEntry({ sslValidDays: 0, sslExpired: true, sslExpiredDays: 12 });

  const check = summarize({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 85, timestamp: new Date().toISOString(), ssl: lapsed });
  const read = readEntry(entry);
  const report = buildReport({ urls: { [URL_UP]: entry } }).sites[0];
  const markdown = renderReportMarkdown(buildReport({ urls: { [URL_UP]: entry } }));

  assert.equal(check.sslIcon, '🔴');
  assert.match(read.sslNote, /^SSL 🔴 expired 12d ago$/);
  assert.equal(report.sslExpired, true);
  assert.equal(report.sslExpiringSoon, false, 'expired is not "expiring soon"');
  assert.equal(report.sslExpiredDays, 12);
  assert.match(markdown, /🔴 expired 12d ago/);
  assert.match(markdown, /SSL certificate has expired/);
  assert.match(markdown, /1 SSL EXPIRED/);
  assert.equal(/renew soon/.test(markdown), false, 'a lapsed certificate must not be listed as "renew soon"');

  // And the honest, unexpired cases are untouched.
  const healthy = summarize({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 85, ssl: { validDays: 63 } });
  assert.equal(healthy.ssl, '63d ✅');
  assert.equal(healthy.sslIcon, '🔒');
  const inWindow = summarize({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 85, ssl: { validDays: 9 } });
  assert.equal(inWindow.ssl, '9d ⚠️');
  assert.equal(inWindow.sslIcon, '⚠️');
});

test('a corrupt negative day count is still unknown, not expired', () => {
  // Regression guard on the P1-2b rule: a hand-edited state file must not be
  // able to claim a certificate lapsed, any more than it could claim a renewal.
  const entry = freshEntry({ sslValidDays: -3 });
  const read = readEntry(entry);
  assert.equal(read.sslExpired, false);
  assert.equal(read.sslDays, null);
  assert.equal(read.sslNote, 'SSL —');

  const report = buildReport({ urls: { [URL_UP]: entry } }).sites[0];
  assert.equal(report.sslExpired, false);
  assert.equal(report.sslDaysRemaining, null);
  assert.equal(renderReportMarkdown(buildReport({ urls: { [URL_UP]: entry } })).includes('expired'), false);
});

/** A real TLS server whose certificate expires in `days` days. */
function expiringTlsServer(t, days) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-days-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, 'k.pem');
  const cert = join(dir, 'c.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', String(days),
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>ok</body></html>');
    },
  );
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    certPath: cert,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}

test('check --json: the renewal flag is the same decision the terminal prints', { timeout: 40000 }, async (t) => {
  if (!hasOpenssl()) return t.skip('openssl is not available');
  // `sslExpiringSoon` in the machine payload was a third copy of the window
  // rule — `isSslExpiringSoon(validDays) && isExpired !== true` — beside
  // `summarize()`'s. It agreed only because the checker rounds the day count,
  // so a plain unit test could not tell the two owners apart. Two real
  // certificates, on either side of the window, can.
  for (const [days, soon] of [[9, true], [40, false]]) {
    const server = await expiringTlsServer(t, days);
    t.after(() => server.close());
    const url = `https://127.0.0.1:${server.port}/`;
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: server.certPath };
    const args = [join(ROOT, 'src/cli.js'), 'check', url, '--timeout', '8000'];

    const json = await run(NODE, [...args, '--json'], { env });
    const [result] = JSON.parse(json.stdout);
    assert.equal(result.sslExpiringSoon, soon, `${days} d: the JSON flag`);
    assert.equal(result.sslExpired, false);

    const human = await run(NODE, args, { env });
    assert.match(human.stdout, soon ? /SSL:\s+9d ⚠️/ : /SSL:\s+40d ✅/, `${days} d: the terminal`);
  }
});

// --- the writer -------------------------------------------------------------

test('runPass: an expired certificate raises ssl_expired once and persists the fact', async () => {
  const state = { urls: { [URL_UP]: freshEntry() } };
  const expired = () => ({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 20, timestamp: new Date().toISOString(), ssl: { validDays: 0, isExpired: true, expiredDays: 5 }, content: { fetched: false } });

  const first = await runPass(state, { check: async () => expired(), returnResults: true });
  const entry = state.urls[URL_UP];
  const kinds = first.events.map(e => e.type);
  assert.equal(kinds.includes('ssl_expired'), true, 'the lapse is its own event');
  assert.equal(kinds.includes('ssl_warning'), false, 'and not a "renew soon" warning');
  const event = first.events.find(e => e.type === 'ssl_expired');
  assert.match(event.message, /SSL certificate expired 5d ago 🔴/);
  assert.equal(entry.sslExpired, true, 'so the status lists and the report can say it later');
  assert.equal(entry.sslExpiredDays, 5);
  assert.equal(entry.sslValidDays, undefined, 'no 0-day value that reads as "expires tonight"');

  // Latched: a second pass must not re-notify a customer every interval.
  const second = await runPass(state, { check: async () => expired(), returnResults: true });
  assert.equal(second.events.some(e => e.type === 'ssl_expired'), false);

  // Recovery clears the fact, and the renewal window works again.
  await runPass(state, { check: async () => ({ ...expired(), ssl: { validDays: 63, isExpired: false, expiredDays: null } }), returnResults: true });
  assert.equal(entry.sslExpired, undefined);
  assert.equal(entry.sslExpiredWarned, false, 'the expiry latch is released too');
  assert.equal(entry.sslValidDays, 63);
  assert.equal(entry.sslWarned, false, 'the renewal latch is released, so a later dip warns again');
});

test('runPass: a negative day count can no longer reach a notification or a webhook', async () => {
  // The writer's gate was `Number.isFinite` alone — weaker than every reader's —
  // so this produced "SSL expires in -3 days ⚠️" in the event, the desktop
  // notification and the customer's webhook, and persisted it into every report.
  const state = { urls: { [URL_UP]: freshEntry() } };
  const pass = await runPass(state, {
    check: async () => ({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 20, timestamp: new Date().toISOString(), ssl: { validDays: -3 },     content: { fetched: false } }), returnResults: true,
  });
  const entry = state.urls[URL_UP];
  assert.equal(pass.events.some(e => e.type.startsWith('ssl_')), false, 'no SSL event from an unusable value');
  assert.equal(entry.sslValidDays, undefined, 'and nothing unusable is persisted');
  assert.equal(entry.sslExpired, undefined);
});

test('runPass: the renewal window still latches and clears at the boundary', async () => {
  const at = (days) => async () => ({ url: URL_UP, healthy: true, statusCode: 200, responseTimeMs: 20, timestamp: new Date().toISOString(), ssl: { validDays: days, isExpired: false, expiredDays: null }, content: { fetched: false } });

  const inside = { urls: { [URL_UP]: freshEntry() } };
  const warned = await runPass(inside, { check: at(SSL_WARN_DAYS), returnResults: true });
  assert.equal(warned.events.some(e => e.type === 'ssl_warning'), true, 'exactly on the boundary still warns');
  assert.equal(warned.events.find(e => e.type === 'ssl_warning').message, `SSL expires in ${SSL_WARN_DAYS} days ⚠️`);

  const outside = { urls: { [URL_UP]: freshEntry() } };
  const quiet = await runPass(outside, { check: at(SSL_WARN_DAYS + 1), returnResults: true });
  assert.equal(quiet.events.some(e => e.type === 'ssl_warning'), false);
  assert.equal(quiet.urls === undefined || true, true);
});

// --- the GitHub Action ------------------------------------------------------
