/**
 * The matrix promises a negotiated TLS version. Nothing delivered it.
 *
 * `src/checkers/ssl.js` has read `protocol` and `cipher` off every handshake
 * since P0-3, and measured against a real certificate no surface could say which
 * TLS version a site speaks:
 *
 *   checkSSL  -> {"validDays":90,"protocol":"TLSv1.3","cipher":"TLS_AES_256_GCM_SHA384"}
 *   `check`   ->  🔒 SSL:     90d ✅
 *   `check --json` -> no protocol field, no cipher field
 *
 * Meanwhile the feature matrix — the source of truth behind the README table,
 * `--help`, the npm description and `docs/pro-alerts.md` — promises the SSL row
 * in *both* tiers, and `test/claims.test.js` locks that row against all four
 * surfaces. "Which TLS version does the customer's site speak?" is the first
 * line a security questionnaire asks, and the answer was in the data the whole
 * time.
 *
 * The first tests are about what must not change: `null` per field for every
 * shape that is not a completed handshake, each field independent, whitespace
 * trimmed. The last test is the lock: the promise may only exist while the
 * fields do.
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

import { readSslTls } from '../src/status.js';
import { summarize } from '../src/engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
const NODE = process.execPath;
const REQUEST_TIMEOUT = '20000';
// Asynchronous, because the TLS fixture lives in *this* process: a synchronous
// spawn would block the event loop and the fixture could never answer, which
// looks exactly like the CLI timing out. (The `tls.createServer` variant of this
// fixture hung for three minutes in P1-52 — `https.createServer` closes its
// connections.)
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
  // `closeAllConnections()` exists on http/https servers, not on a bare
  // `net.Server` — calling it unconditionally threw here and left the file
  // hanging, which looks exactly like the CLI never answering.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A self-signed certificate, generated per run so nothing in the repo expires.
 * NODE_EXTRA_CA_CERTS then makes fetch trust exactly this certificate.
 */
function selfSignedCert(dir) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

async function tlsFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert, certPath } = selfSignedCert(dir);
  const server = createTlsServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>tls fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { url: `https://127.0.0.1:${port}/`, certPath };
}

// ── The one owner: what the handshake reported, and nothing else ──

test('both halves of the negotiated handshake are carried through', () => {
  assert.deepEqual(
    readSslTls({ protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' }),
    { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' },
  );
  assert.deepEqual(
    readSslTls({ protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES128-GCM-SHA256' }),
    { protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES128-GCM-SHA256' },
  );
});

test('no handshake is null for both fields, not an empty version', () => {
  for (const ssl of [null, undefined, {}, { error: 'SSL handshake timed out' },
    { validDays: 90 }, { protocol: null, cipher: null }, { protocol: '', cipher: '   ' }]) {
    assert.deepEqual(readSslTls(ssl), { protocol: null, cipher: null },
      `got a value for ${JSON.stringify(ssl)}`);
  }
});

test('the two fields are read independently, so one half can be missing', () => {
  // A handshake can report a version and no cipher suite. The surface must then
  // print the version alone rather than reach for a placeholder.
  assert.deepEqual(readSslTls({ protocol: 'TLSv1.3' }), { protocol: 'TLSv1.3', cipher: null });
  assert.deepEqual(readSslTls({ cipher: 'TLS_AES_128_GCM_SHA256' }), { protocol: null, cipher: 'TLS_AES_128_GCM_SHA256' });
});

test('a value that is not a string is not a version', () => {
  assert.deepEqual(readSslTls({ protocol: 13, cipher: ['TLSv1.3'] }),
    { protocol: null, cipher: null });
});

test('surrounding whitespace is trimmed, so a padded name cannot break the column', () => {
  assert.deepEqual(readSslTls({ protocol: ' TLSv1.3 \n', cipher: ' TLS_AES_256_GCM_SHA384 ' }),
    { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' });
});

test('summarize carries the handshake, so the human surface cannot invent one', () => {
  const tls = { protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' };
  assert.deepEqual(
    summarize({ url: 'https://acme.dk/', healthy: true, ssl: { validDays: 90, ...tls } }).sslTls, tls);
  assert.deepEqual(
    summarize({ url: 'http://acme.dk/', healthy: true, ssl: null }).sslTls,
    { protocol: null, cipher: null });
});

// ── What the promise costs a reader: a real handshake, through the real CLI ──

test('check names the negotiated TLS version and cipher, and the promise has an output', { timeout: 30000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const { url, certPath } = await tlsFixture(t);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath };

  const { stdout } = await run(NODE, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT], { env });
  const line = /🔐 TLS: (\S+) — (\S+)/.exec(stdout);
  assert.ok(line, `no TLS line in:\n${stdout}`);
  assert.match(line[1], /^TLSv1\.[23]$/, 'the fixture negotiates a modern TLS version');
  assert.ok(line[2].length > 0, 'the cipher suite belongs on the line');
  // The line belongs after the certificate it was negotiated on, and the days
  // line is unchanged. A 2-day certificate is inside the 14-day renewal window,
  // so the days carry a ⚠️ rather than a 🔒 — the TLS line is indifferent to that.
  assert.match(stdout, /SSL:\s+2d/);
  assert.ok(stdout.indexOf('SSL:') < stdout.indexOf('TLS:'), 'the TLS line must follow the certificate lines');
});

test('a plain-HTTP URL has no TLS line and no version, rather than an empty one', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  const { stdout } = await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--timeout', REQUEST_TIMEOUT]);
  assert.doesNotMatch(stdout, /TLS/);
  const [result] = JSON.parse((await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(result.sslProtocol, null);
  assert.equal(result.sslCipher, null);
  assert.equal(result.sslChecked, false);
});

test('a connection that failed reports no version, the same way it reports no issuer', { timeout: 30000 }, async () => {
  // A port that was bound and released: nothing answers there. Measured rather
  // than assumed — the failure is reported as `errorType: connection_refused`
  // and *not* as `sslError`, because the SSL check never ran, and the CLI exits
  // 2. What matters here is that neither new field is invented for a connection
  // that never happened.
  const { createServer: createNetServer } = await import('node:net');
  const probe = createNetServer();
  const port = await listen(probe);
  await close(probe);

  const { stdout } = await run(NODE, [CLI, 'check', `https://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])
    .catch((err) => err);
  const [result] = JSON.parse(stdout);
  assert.equal(result.sslProtocol, null);
  assert.equal(result.sslCipher, null);
  assert.equal(result.sslIssuer, null);
  assert.equal(result.sslChecked, false);
  assert.equal(result.errorType, 'connection_refused');
});

test('the JSON contract is additive: every field that existed still exists', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  const [result] = JSON.parse((await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  for (const key of ['url', 'reachable', 'healthy', 'statusCode', 'responseTimeMs', 'finalUrl',
    'offHostRedirect', 'sslDaysRemaining', 'sslExpired', 'sslExpiredDays', 'sslExpiringSoon',
    'sslChecked', 'sslError', 'sslIssuer', 'sslProtocol', 'sslCipher', 'contentChecked',
    'contentSkipped', 'contentLength', 'contentHash']) {
    assert.ok(key in result, `check --json lost the field ${key}`);
  }
  assert.equal(result.sslProtocol, null);
  // `errorType`/`error` are omitted entirely on a healthy check, not null — a
  // pre-existing shape this task does not touch. Locked here so the
  // additive-field test stays honest about it.
  assert.equal('errorType' in result, false);
});

// ── The lock: the claim may only exist while the fields do ──

test('the matrix promises a negotiated TLS version, so the field must be reachable', () => {
  const features = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
  const cli = readFileSync(CLI, 'utf8');
  // The row itself, not the sentence: this lock guards that the SSL row still
  // promises a TLS version, so it must not freeze the wording around it — P1-54
  // widened the same row with hostname coverage, which is honest, and froze the
  // sentence that would have made this test lie about the promise.
  const row = /id: 'ssl-content',[\s\S]*?\n  \},/.exec(features)?.[0] ?? '';
  assert.match(row, /negotiated TLS version/,
    'the SSL row no longer promises a TLS version — drop this test instead of keeping it');
  // One owner, and the values the server chose are never printed raw.
  assert.equal((cli.match(/readSslTls\(/g) || []).length, 1, 'cli.js must read the handshake through the one owner');
  assert.match(cli, /TLS: \$\{safeText\(/, 'a negotiated name is the server\'s, so it goes through safeText');
});
