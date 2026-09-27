/**
 * P1-55 — an expired certificate must be read on a site that is down.
 *
 * The measurement that wrote this file, with the real engine and a real
 * certificate that expired 40 days before the run:
 *
 *   checkSSL  -> {"validDays": 0, "isExpired": true, "expiredDays": 40}
 *   checkUrl  -> {"reachable": false, "healthy": false,
 *                 "errorType": "network_error", "error": "certificate has
 *                 expired", "ssl": null}
 *
 * The certificate was read, measured and then thrown away, because the engine
 * gated the SSL leg on `result.reachable` and an expired certificate is exactly
 * what stops the request leg from ever getting an answer. Every paid surface
 * then said it knew nothing about the certificate, for the one reason the
 * renewal warning exists:
 *
 *   watch --status  🚨 down  https://kunde.dk/ (—) @ …
 *   report          | https://kunde.dk/ | DOWN | … | — | … |
 *   report summary  1 site(s) · 0 up · 1 down · 101 checks · 1 failed
 *
 * No `SSL —`, no `SSL EXPIRED`, no named line and no `ssl_expired` alert. The
 * customer is told their site is down and not why, and the bureau cannot renew
 * a certificate from the document it sends them.
 *
 * The fix is one gate, asked of one owner. The verdict cannot move: `healthy` is
 * the request leg's answer, so the exit code and every uptime number are
 * untouched, and the extra leg only reads a certificate it would have thrown
 * away.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:https';
import { fileURLToPath } from 'node:url';

import { canReadCertificate, expectsCertificate } from '../src/status.js';
import { checkUrl, summarize } from '../src/engine.js';
import { runPass } from '../src/watch.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';
import { selfSigned } from './helpers/certs.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
const NODE = process.execPath;
const REQUEST_TIMEOUT = '20000';
// Asynchronous, because the TLS fixture lives in *this* process — a synchronous
// spawn would block the event loop and the fixture could never answer, which
// looks exactly like the CLI timing out.
const run = promisify(execFile);
const SITE = 'https://kunde.dk/';

function hasOpenssl() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A certificate that expired 40 days before this run — the ordinary reason a
 * customer's site stops answering, and the reason the renewal warning exists.
 * Both dates are in the past, so nothing in the repo ever expires.
 */
function lapsedCert(dir) {
  return selfSigned(dir, {
    fromDays: 41,
    toDays: 40,
    subject: '/O=DeskUptime Test CA/CN=127.0.0.1',
    sans: 'DNS:127.0.0.1',
  });
}

/** A site that serves a certificate which expired 40 days ago. */
async function lapsedFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-lapsed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert, certPath } = lapsedCert(dir);
  const server = createTlsServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>lapsed fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  // `NODE_EXTRA_CA_CERTS` makes `fetch` trust the certificate as a CA, so the
  // only thing left to refuse is its *expiry* — which is the case under test.
  return { url: `https://127.0.0.1:${port}/`, certPath };
}

function tempStateFile(t, tag = 'certondown') {
  const home = mkdtempSync(join(tmpdir(), `deskuptime-${tag}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return join(home, '.deskuptime', 'state.json');
}

/** The engine's own result for a lapsed certificate, measured — not invented. */
const LAPSED = {
  reachable: false,
  healthy: false,
  statusCode: null,
  responseTimeMs: null,
  finalUrl: null,
  errorType: 'network_error',
  error: 'certificate has expired',
  ssl: { validDays: 0, isExpired: true, expiredDays: 40, subjectAltName: ['DNS:127.0.0.1'], protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
};

async function cli(args, env) {
  try {
    return (await run(NODE, [CLI, ...args], { env, encoding: 'utf8' })).stdout;
  } catch (error) {
    // A DOWN site exits 2 on purpose, and the output is what is under test.
    if (error.code === undefined && !error.stdout) throw error;
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
}

// ── The one owner: is a certificate still worth reading? ──

test('a request that answered is the old case, and a certificate failure is the new one', () => {
  assert.equal(canReadCertificate({ reachable: true, errorType: 'http_error' }), true);
  // Measured: `describeFetchError` calls an expired certificate and a wrong-host
  // certificate `network_error`, because it has no vocabulary for certificates.
  assert.equal(canReadCertificate({ reachable: false, errorType: 'network_error' }), true);
  // A refused connection, a name that does not resolve and a timeout never reach
  // a handshake, and asking costs a doomed connection on the sites a watch loop
  // checks most often.
  assert.equal(canReadCertificate({ reachable: false, errorType: 'connection_refused' }), false);
  assert.equal(canReadCertificate({ reachable: false, errorType: 'dns_error' }), false);
  assert.equal(canReadCertificate({ reachable: false, errorType: 'timeout' }), false);
  // Nothing to read from, so nothing is claimed.
  assert.equal(canReadCertificate(), false);
  assert.equal(canReadCertificate({}), false);
  assert.equal(canReadCertificate({ reachable: false, errorType: 'something_new' }), false);
  assert.equal(canReadCertificate(null), false);
});

test('ownership is pinned: the SSL leg may not be gated on reachability again', () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const engine = strip(readFileSync(join(ROOT, 'src', 'engine.js'), 'utf8'));
  assert.doesNotMatch(engine, /result\.reachable\s*&&\s*expectsCertificate/);
  assert.match(engine, /canReadCertificate\(result\)/);
});

// ── Measured, through the real engine and a real lapsed certificate ──

test('a site whose certificate expired is DOWN and the certificate is still read', { timeout: 60000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a lapsed certificate');
    return;
  }
  const fixture = await lapsedFixture(t);
  const result = await checkUrl(fixture.url, { timeoutMs: 20000 });

  // The verdict is the request leg's answer and is not the thing under test.
  assert.equal(result.healthy, false);
  assert.equal(result.reachable, false);
  // Measured, not assumed: this is the failure the whole finding rests on, and
  // if Node ever words it differently this test has to say so rather than pass
  // on a guess.
  assert.equal(result.errorType, 'network_error');
  assert.match(result.error, /certificate has expired/);

  // The reading that used to be thrown away.
  assert.notEqual(result.ssl, null);
  assert.equal(result.ssl.isExpired, true);
  assert.equal(result.ssl.validDays, 0);
  assert.equal(result.ssl.expiredDays, 40);
  assert.equal(summarize(result).ssl, '🔴 expired 40d ago');
  assert.equal(summarize(result).sslIcon, '🔴');
});

test('the JSON says the certificate was read, and the exit code still says DOWN', { timeout: 60000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a lapsed certificate');
    return;
  }
  const fixture = await lapsedFixture(t);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: fixture.certPath };
  let failed = false;
  let stdout = '';
  try {
    stdout = (await run(NODE, [CLI, 'check', '--json', fixture.url, '--timeout', REQUEST_TIMEOUT], { env, encoding: 'utf8' })).stdout;
  } catch (error) {
    failed = true;
    assert.equal(error.code, 2, 'a DOWN site exits 2, exactly as before the fix');
    stdout = error.stdout;
  }
  assert.equal(failed, true, 'an expired certificate must not read as an up site');

  const [result] = JSON.parse(stdout);
  assert.equal(result.sslChecked, true, 'the certificate was read, so the JSON may no longer say it was not');
  assert.equal(result.sslExpired, true);
  assert.equal(result.sslExpiredDays, 40);
  assert.equal(result.sslExpiringSoon, false, 'a lapsed certificate is out of service, not a renewal to schedule');
  // Everything else about the site is unchanged, and every other certificate
  // fact comes along for the ride because it was measured on the same wire.
  assert.equal(result.reachable, false);
  assert.equal(result.statusCode, null);
  assert.equal(result.errorType, 'network_error');
  assert.deepEqual(result.sslCertNames, ['127.0.0.1']);
  assert.equal(result.sslProtocol, 'TLSv1.3');
});

test('the terminal says why the site is down', { timeout: 60000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a lapsed certificate');
    return;
  }
  const fixture = await lapsedFixture(t);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: fixture.certPath };
  const stdout = await cli(['check', fixture.url, '--timeout', REQUEST_TIMEOUT], env);
  assert.match(stdout, /Status: {3}N\/A — DOWN/);
  assert.match(stdout, /🔴 SSL: {5}🔴 expired 40d ago/);
});

// ── The paid surfaces: the customer is told, and the alert goes out ──

test('a pass remembers the lapsed certificate and raises the alert it exists for', async (t) => {
  const stateFile = tempStateFile(t);
  const state = { urls: { [SITE]: { wasUp: true, lastStatus: 200, checks: 10, checksUp: 10 } } };
  const pass = await runPass(state, {
    stateFile,
    returnResults: true,
    check: async (url) => ({ ...LAPSED, url }),
  });

  const expired = pass.events.find(event => event.type === 'ssl_expired');
  assert.ok(expired, 'a lapsed certificate must reach the channel the customer pays for');
  assert.match(expired.message, /expired 40d ago/);

  const saved = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(saved.sslExpired, true);
  assert.equal(saved.sslExpiredDays, 40);
  assert.equal(saved.sslValidDays, undefined, 'a countdown is not a fact about a lapsed certificate');
});

test('the client report says the certificate is expired, and counts it', async (t) => {
  const stateFile = tempStateFile(t, 'certondown-report');
  const state = { urls: { [SITE]: { wasUp: true, lastStatus: 200, checks: 10, checksUp: 10 } } };
  await runPass(state, { stateFile, check: async (url) => ({ ...LAPSED, url }) });
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));

  const report = buildReport(saved, { title: 'Kunde Acme', now: new Date() });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /🔴 expired 40d ago/);
  assert.match(markdown, /1 SSL EXPIRED/);
  // The row keeps the site as DOWN: the certificate did not stop the site from
  // being down, and the fix must not invent an uptime number.
  assert.equal(report.summary.down, 1);
  assert.equal(report.summary.sslExpired, 1);
  assert.equal(report.sites[0].sslExpired, true);
  assert.equal(report.sites[0].sslExpiredDays, 40);
  assert.equal(report.sites[0].sslExpiringSoon, false);
});

test('a site that is down for a reason no certificate can answer stays silent about it', async (t) => {
  const stateFile = tempStateFile(t, 'certondown-refused');
  const state = { urls: { [SITE]: { wasUp: true, lastStatus: 200, checks: 10, checksUp: 10 } } };
  // A refused connection: `canReadCertificate` says no, so the pass must not
  // invent a certificate reading to fill the gap.
  const pass = await runPass(state, {
    stateFile,
    returnResults: true,
    check: async (url) => ({
      url,
      reachable: false,
      healthy: false,
      statusCode: null,
      responseTimeMs: null,
      finalUrl: null,
      errorType: 'connection_refused',
      error: 'Connection refused',
    }),
  });

  assert.equal(pass.events.some(event => event.type === 'ssl_expired'), false);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(saved.sslExpired, undefined);
  assert.equal(saved.sslExpiredDays, undefined);
  assert.equal(saved.sslValidDays, undefined);
  assert.equal(saved.sslError, undefined);
});

test('a plain-HTTP site is still a site whose certificate was never read', () => {
  // The rule has to keep its other half: no certificate can exist there, so no
  // surface may claim one was checked. `expectsCertificate()` is the owner of
  // that, and the engine still asks it before the new gate.
  assert.equal(expectsCertificate('http://kunde.dk/'), false);
  assert.equal(expectsCertificate('https://kunde.dk/'), true);
});
