/**
 * The matrix promises hostname coverage. Nothing delivered it.
 *
 * `src/checkers/ssl.js` has read `subjectaltname` on every SSL check since P0-3,
 * and the handshake deliberately runs with `rejectUnauthorized: false` — so a
 * certificate that does not cover the host we asked about is reported as a
 * healthy site with a valid certificate. Measured against real certificates,
 * nothing could say whether the certificate covers the name:
 *
 *   checkSSL -> {"subjectAltName":["DNS:npmjs.com","DNS:*.internal.npmjs.com","DNS:*.npmjs.com"]}
 *   `check`  ->  🔒 SSL:     74d ✅
 *   `check --json` -> no coverage field, no names
 *
 * "Does the certificate cover the hostname we monitor?" is the question a bureau
 * gets when a client's site warns in one browser and not in another, and it is
 * the question a parked or hijacked domain answers wrongly. The answer was in
 * the data the whole time.
 *
 * The first tests are about the rule that decides it, because a literal
 * comparison is a false alarm on one of the largest sites on the internet:
 * `www.npmjs.com` is covered by `*.npmjs.com` and a `includes()` says it is
 * not. The last test is the lock: the promise may only exist while the fields do.
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

import { readCertCoverage } from '../src/status.js';
import { summarize } from '../src/engine.js';
import { checkSSL } from '../src/checkers/ssl.js';

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
  // `closeAllConnections()` exists on http/https servers, not on a bare
  // `net.Server` — calling it unconditionally threw and left the file hanging,
  // which looks exactly like the CLI never answering.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A self-signed certificate, generated per run so nothing in the repo expires.
 * `subjectAltName` is what the case is about, so it is a parameter: a fixture
 * can cover the host it is served on, name somebody else's host, or name
 * nothing at all.
 */
function selfSignedCert(dir, subjectAltName) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/O=DeskUptime Test CA/CN=127.0.0.1',
    ...(subjectAltName ? ['-addext', `subjectAltName=${subjectAltName}`] : []),
  ], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

async function tlsFixture(t, subjectAltName) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert, certPath } = selfSignedCert(dir, subjectAltName);
  const server = createTlsServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>tls fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { url: `https://127.0.0.1:${port}/`, certPath };
}

// ── The one owner: the rule a browser uses, and nothing else ──

test('a certificate that names the host covers it', () => {
  const coverage = readCertCoverage({ subjectAltName: ['DNS:example.com', 'DNS:*.example.com'] }, 'https://example.com/');
  assert.equal(coverage.coversHost, true);
  assert.equal(coverage.note, 'Certificate covers example.com');
});

test('a wildcard covers one label, the way a browser reads it', () => {
  // Measured, not assumed: this is npm's real certificate, and a literal
  // comparison calls the second line below uncovered.
  const npm = { subjectAltName: ['DNS:npmjs.com', 'DNS:*.internal.npmjs.com', 'DNS:*.npmjs.com'] };
  assert.equal(readCertCoverage(npm, 'https://www.npmjs.com/').coversHost, true);
  assert.equal(readCertCoverage(npm, 'https://npmjs.com/').coversHost, true);
  // `*.a.dk` covers `b.a.dk`, and neither `a.dk` nor `x.b.a.dk`.
  const wildcard = { subjectAltName: ['DNS:*.example.com'] };
  assert.equal(readCertCoverage(wildcard, 'https://a.example.com/').coversHost, true);
  assert.equal(readCertCoverage(wildcard, 'https://example.com/').coversHost, false);
  assert.equal(readCertCoverage(wildcard, 'https://x.a.example.com/').coversHost, false);
});

test('an address is covered by its own entry, never by a wildcard', () => {
  assert.equal(readCertCoverage({ subjectAltName: ['IP Address:127.0.0.1'] }, 'https://127.0.0.1:8443/').coversHost, true);
  assert.equal(readCertCoverage({ subjectAltName: ['DNS:*.0.0.1'] }, 'https://127.0.0.1:8443/').coversHost, false);
});

test('a unicode name and its punycode form are the same name, in both directions', () => {
  assert.equal(readCertCoverage({ subjectAltName: ['DNS:bøchen.dk'] }, 'https://bøchen.dk/').coversHost, true);
  assert.equal(readCertCoverage({ subjectAltName: ['DNS:xn--bchen-vua.dk'] }, 'https://bøchen.dk/').coversHost, true);
  // Case and the root dot are the same host too.
  assert.equal(readCertCoverage({ subjectAltName: ['DNS:acme.dk.'] }, 'https://ACME.DK./').coversHost, true);
});

test('nothing to judge is null with no sentence, never "does not cover"', () => {
  // The false-alarm guard. A certificate with no `subjectAltName` is old, and
  // the verdict for one belongs to a browser — so every shape we cannot read is
  // `null` and prints no line, exactly like `sslChecked: false`.
  for (const [ssl, url] of [
    [null, 'https://acme.dk/'],
    [undefined, 'https://acme.dk/'],
    [{}, 'https://acme.dk/'],
    [{ error: 'SSL handshake timed out' }, 'https://acme.dk/'],
    [{ subjectAltName: [] }, 'https://acme.dk/'],
    // Only names that are not host names: an `othername` entry is not something
    // a connection can be validated against.
    [{ subjectAltName: ['othername:1.2.3.4;UTF8:acme'] }, 'https://acme.dk/'],
    // A shape we have never read is not guessed at.
    [{ subjectAltName: 'DNS:acme.dk' }, 'https://acme.dk/'],
    [{ subjectAltName: [null, 42, '   '] }, 'https://acme.dk/'],
    // A URL that names no host.
    [{ subjectAltName: ['DNS:acme.dk'] }, 'kunde.dk'],
    [{ subjectAltName: ['DNS:acme.dk'] }, null],
  ]) {
    const coverage = readCertCoverage(ssl, url);
    assert.equal(coverage.coversHost, null, `got a verdict for ${JSON.stringify(ssl)} ${url}`);
    assert.equal(coverage.note, null, `got a sentence for ${JSON.stringify(ssl)} ${url}`);
  }
});

test('the names are the certificate own: trimmed, without prefixes, without repeats', () => {
  const coverage = readCertCoverage({
    subjectAltName: ['DNS: a.dk ', 'DNS:a.dk', 'IP Address:127.0.0.1', '  DNS:b.dk  ', 'DNS:'],
  }, 'https://a.dk/');
  assert.deepEqual(coverage.names, ['a.dk', '127.0.0.1', 'b.dk']);
});

test('a mismatch names the certificate, but not all of it', () => {
  const coverage = readCertCoverage({
    subjectAltName: ['DNS:*.a.dk', 'DNS:*.b.dk', 'DNS:c.dk', 'DNS:d.dk', 'DNS:e.dk', 'DNS:f.dk'],
  }, 'https://acme.dk/');
  assert.equal(coverage.coversHost, false);
  assert.equal(coverage.note, 'Certificate does not cover acme.dk — it names: *.a.dk, *.b.dk, c.dk, d.dk, and 2 more');
  // Every name is still there for a script; only the sentence is bounded.
  assert.equal(coverage.names.length, 6);
});

test('summarize carries the coverage, so the human surface cannot invent one', () => {
  const covered = summarize({ url: 'https://acme.dk/', healthy: true, ssl: { validDays: 90, subjectAltName: ['DNS:acme.dk'] } }).sslCoverage;
  assert.equal(covered.coversHost, true);
  assert.deepEqual(summarize({ url: 'http://acme.dk/', healthy: true, ssl: null }).sslCoverage,
    { coversHost: null, names: [], note: null });
});

// ── What the promise costs a reader: a real certificate, through the real CLI ──

test('check says the certificate covers the host, and the promise has an output', { timeout: 30000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const { url, certPath } = await tlsFixture(t, 'IP:127.0.0.1');
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath };

  const { stdout } = await run(NODE, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT], { env });
  assert.match(stdout, /📜 Certificate covers 127\.0\.0\.1/);
  assert.match(stdout, /SSL:\s+2d/, 'the days line is unchanged');
  assert.match(stdout, /Status:   200 — UP/);
  const [result] = JSON.parse((await run(NODE, [CLI, 'check', url, '--json', '--timeout', REQUEST_TIMEOUT], { env })).stdout);
  assert.equal(result.sslCoversHost, true);
  assert.deepEqual(result.sslCertNames, ['127.0.0.1']);
});

test('a certificate that names another host is named, not silently accepted', { timeout: 30000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  // The parked / hijacked shape: a certificate for somebody else's domain,
  // served on a host we asked about. The checker reads it because the handshake
  // runs with `rejectUnauthorized: false`, so the fact is measured here on the
  // checker's own result — a `fetch` leg cannot be part of this case, because
  // undici refuses a hostname the certificate does not cover, and that refusal
  // is the browser's verdict, not ours.
  const { url } = await tlsFixture(t, 'DNS:kunde.dk');
  const checked = await checkSSL(url);
  assert.equal(checked.error, undefined, `the handshake read the certificate: ${checked.error}`);

  const coverage = readCertCoverage(checked, url);
  assert.equal(coverage.coversHost, false);
  assert.equal(coverage.note, 'Certificate does not cover 127.0.0.1 — it names: kunde.dk');
  // The same sentence the human surface prints, and the same fields the JSON
  // publishes — both read the owner, so neither can say something else.
  const summary = summarize({ url, healthy: true, ssl: checked });
  assert.equal(summary.sslCoverage.note, coverage.note);
  assert.equal(summary.status, 'UP', 'coverage is a fact about the certificate, not a verdict on the site');
});

test('a certificate that names no host says nothing at all', { timeout: 30000 }, async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  // The false-alarm guard, measured rather than assumed: a certificate with an
  // empty `subjectAltName` is old, and both surfaces must stay silent about it
  // instead of printing "does not cover". `fetch` is no part of this case —
  // measured on this machine, Node's `fetch` refuses a CA trusted through
  // `NODE_EXTRA_CA_CERTS` when the certificate carries no SAN, so the CLI leg
  // would fail before any of this was read. `checkSSL` accepts the handshake
  // (`rejectUnauthorized: false`) and hands over the empty list.
  const { url } = await tlsFixture(t, null);
  const checked = await checkSSL(url);
  assert.equal(checked.error, undefined, `the handshake read the certificate: ${checked.error}`);
  assert.deepEqual(checked.subjectAltName, [], 'this fixture is the one with no names');

  const coverage = readCertCoverage(checked, url);
  assert.equal(coverage.coversHost, null);
  assert.equal(coverage.note, null);
  assert.equal(summarize({ url, healthy: true, ssl: checked }).sslCoverage.note, null);
});

test('a plain-HTTP URL has no coverage, rather than an empty one', { timeout: 30000 }, async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  const { stdout } = await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--timeout', REQUEST_TIMEOUT]);
  assert.doesNotMatch(stdout, /Certificate/);
  const [result] = JSON.parse((await run(NODE, [CLI, 'check', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(result.sslCoversHost, null);
  assert.deepEqual(result.sslCertNames, []);
  assert.equal(result.sslChecked, false);
});

test('a connection that failed reports no coverage, the same way it reports no issuer', { timeout: 30000 }, async () => {
  // Measured rather than assumed: the failure is reported as `errorType:
  // connection_refused` and *not* as `sslError`, because the SSL check never
  // ran. What matters here is that no new field is invented for a connection
  // that never happened.
  const { createServer: createNetServer } = await import('node:net');
  const probe = createNetServer();
  const port = await listen(probe);
  await close(probe);

  const { stdout } = await run(NODE, [CLI, 'check', `https://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])
    .catch((err) => err);
  const [result] = JSON.parse(stdout);
  assert.equal(result.sslCoversHost, null);
  assert.deepEqual(result.sslCertNames, []);
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
    'sslChecked', 'sslError', 'sslIssuer', 'sslProtocol', 'sslCipher', 'sslCoversHost',
    'sslCertNames', 'contentChecked', 'contentSkipped', 'contentLength', 'contentHash']) {
    assert.ok(key in result, `check --json lost the field ${key}`);
  }
  // `errorType`/`error` are omitted entirely on a healthy check, not null — a
  // pre-existing shape this task does not touch. Locked here so the additive
  // test stays honest about it.
  assert.equal('errorType' in result, false);
});

// ── The lock: the claim may only exist while the fields do ──

test('the matrix promises hostname coverage, so the coverage must be reachable', () => {
  const features = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
  const cli = readFileSync(CLI, 'utf8');
  // The row itself, not the sentence: this lock guards that the SSL row still
  // promises coverage, so it must not freeze the wording around it.
  const row = /id: 'ssl-content',[\s\S]*?\n  \},/.exec(features)?.[0] ?? '';
  assert.match(row, /hostname coverage/,
    'the SSL row no longer promises hostname coverage — drop this test instead of keeping it');
  // One owner, and the names the certificate chose are never printed raw.
  assert.equal((cli.match(/readCertCoverage\(/g) || []).length, 1, 'cli.js must read the coverage through the one owner');
  assert.match(cli, /\$\{safeText\(summary\.sslCoverage\.note, \{ max: 0 \}\)\}/, 'a certificate name is the certificate\'s, so it goes through safeText');
});
