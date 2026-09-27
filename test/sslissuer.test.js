/**
 * The matrix promises "issuer". Nothing delivered it.
 *
 * `src/checkers/ssl.js` has read `issuer` off every certificate since P0-3, and
 * measured against a real certificate no surface could say who issued it:
 *
 *   checkSSL  -> {"validDays":90,"issuer":{"C":"US","O":"SSL Corporation", …}}
 *   `check`   ->  🔒 SSL:     90d ✅
 *   `check --json` -> no issuer field
 *
 * Meanwhile the feature matrix — the source of truth behind the README table,
 * `--help`, the npm description and `docs/pro-alerts.md` — promises "SSL expiry
 * countdown, **issuer** and content-change detection" in *both* tiers, and
 * `test/claims.test.js` locks that row against all four surfaces. So the one
 * claim in the matrix that nothing implemented was the one a test protected.
 * "Who issued this certificate?" is the first question an agency is asked
 * about a customer's site.
 *
 * The first tests are about what must not change: `O` before `CN` (a modern
 * certificate's `CN` is a rotating code like `R11`, not a name), the string form
 * kept as it came, and `null` for every shape that is not a read certificate.
 * The last test is the lock: the promise may only exist if the field does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:https';
import { fileURLToPath } from 'node:url';

import { readSslIssuer } from '../src/status.js';
import { summarize } from '../src/engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
const NODE = process.execPath;
const REQUEST_TIMEOUT = '20000';
// Asynchronous, because the TLS fixture lives in *this* process: a synchronous
// spawn would block the event loop and the fixture could never answer, which
// looks exactly like the CLI timing out.
const run = promisify(execFile);

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
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A self-signed certificate from an authority with a *name*, so the tests can
 * tell `O` and `CN` apart instead of accepting whichever came back. Generated per
 * run, so nothing in the repo expires. NODE_EXTRA_CA_CERTS then makes fetch trust
 * exactly this certificate.
 */
function namedCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/O=DeskUptime Test CA/CN=ca-code-42',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

async function tlsFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-issuer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert, certPath } = namedCert(dir);
  const server = createTlsServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>issuer fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { url: `https://127.0.0.1:${port}/`, certPath };
}

// ── The one owner: which of the two names is the authority ──

test('the authority is the organisation, not the rotating short code in CN', () => {
  assert.equal(readSslIssuer({ issuer: { C: 'US', O: "Let's Encrypt", CN: 'R11' } }), "Let's Encrypt");
});

test('a certificate with no organisation still names itself, through CN', () => {
  assert.equal(readSslIssuer({ issuer: { CN: '127.0.0.1' } }), '127.0.0.1');
});

test('the flattened string form older Node returns is kept, not re-spelled', () => {
  assert.equal(readSslIssuer({ issuer: 'C=DK, O=Acme, CN=Acme CA' }), 'C=DK, O=Acme, CN=Acme CA');
});

test('no certificate read is null, not an empty issuer', () => {
  for (const ssl of [null, undefined, {}, { issuer: null }, { issuer: '' }, { issuer: '   ' },
    { issuer: {} }, { issuer: { O: '' } }, { issuer: { O: 42 } }, { issuer: [] }, { error: 'handshake failed' }]) {
    assert.equal(readSslIssuer(ssl), null, `got a value for ${JSON.stringify(ssl)}`);
  }
});

test('surrounding whitespace is trimmed, so a padded name cannot break the column', () => {
  assert.equal(readSslIssuer({ issuer: { O: '  Acme CA \n' } }), 'Acme CA');
});

test('summarize carries the issuer, so the human surface cannot invent one', () => {
  assert.equal(summarize({ url: 'https://acme.dk/', healthy: true, ssl: { validDays: 90, issuer: { O: 'Acme CA' } } }).sslIssuer, 'Acme CA');
  assert.equal(summarize({ url: 'http://acme.dk/', healthy: true, ssl: null }).sslIssuer, null);
});

// ── What the promise costs a reader: a real certificate, through the real CLI ──

test('check names the certificate authority, and the promise finally has an output', { timeout: 30000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const { url, certPath } = await tlsFixture(t);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath };

  const { stdout } = await run(NODE, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT], { env });
  assert.match(stdout, /🏷️ Issuer: DeskUptime Test CA/);
  // The line it belongs to is unchanged, and the two stay in that order. A
  // 2-day certificate is inside the 14-day renewal window, so the days carry a
  // ⚠️ rather than a 🔒 — the issuer line is indifferent to that.
  assert.match(stdout, /SSL:\s+2d/);
  assert.ok(stdout.indexOf('SSL:') < stdout.indexOf('Issuer:'), 'the issuer line must follow the days it belongs to');
});

test('a plain-HTTP URL has no issuer line and no issuer, rather than an empty one', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  const { stdout } = await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--timeout', REQUEST_TIMEOUT]);
  assert.doesNotMatch(stdout, /Issuer/);
  const [result] = JSON.parse((await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(result.sslIssuer, null);
  assert.equal(result.sslChecked, false);
});

test('the JSON contract is additive: every field that existed still exists', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  const [result] = JSON.parse((await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  for (const key of ['url', 'reachable', 'healthy', 'statusCode', 'responseTimeMs', 'finalUrl',
    'offHostRedirect', 'sslDaysRemaining', 'sslExpired', 'sslExpiredDays', 'sslExpiringSoon',
    'sslChecked', 'sslError', 'sslIssuer', 'contentChecked', 'contentSkipped', 'contentLength',
    'contentHash']) {
    assert.ok(key in result, `check --json lost the field ${key}`);
  }
  assert.equal(result.sslIssuer, null);
  // `errorType`/`error` are omitted entirely on a healthy check, not null — a
  // pre-existing shape this task does not touch, and one a script cannot rely on
  // being present. Locked here so the additive-field test stays honest about it.
  assert.equal('errorType' in result, false);
});

// ── The lock: the claim may only exist while the field does ──

test('the matrix promises "issuer", so the certificate issuer must be reachable', () => {
  const features = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
  const cli = readFileSync(CLI, 'utf8');
  assert.match(features, /issuer and content-change detection/,
    'the matrix row no longer promises an issuer — drop this test instead of keeping it');
  // One owner, and the value the site chose is never printed raw.
  assert.equal((cli.match(/readSslIssuer\(/g) || []).length, 1, 'cli.js must read the issuer through the one owner');
  assert.match(cli, /Issuer: \$\{safeText\(/, 'an issuer is chosen by the certificate, so it goes through safeText');
});
