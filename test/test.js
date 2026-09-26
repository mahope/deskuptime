#!/usr/bin/env node
/**
 * DeskUptime test suite — node:test, zero dependencies.
 * Run: npm test   (or: node test/test.js)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSSL } from '../src/checkers/ssl.js';
import { checkContentChange, MAX_CONTENT_BYTES } from '../src/checkers/content.js';
import { readContentState, contentSkipNote } from '../src/status.js';
import { checkUrl } from '../src/engine.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REQUEST_TIMEOUT = '5000';

// Every network test below runs against a local server. A live example.com
// dependency fails on a flaky connection, behind a proxy or when the site is
// slow, and it never proved anything about our own code.
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function fixtureServer(t) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/redirect') {
      res.writeHead(302, { location: '/final' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html',
      'strict-transport-security': 'max-age=63072000',
    });
    res.end('<html><body>fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  return `http://127.0.0.1:${port}`;
}

// A self-signed cert for the SSL test, generated per run so nothing expires in
// the repo. NODE_EXTRA_CA_CERTS then makes fetch trust exactly this cert.
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

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Unit: hash-based change detection ──
function sha(s) { return createHash('sha256').update(s).digest('hex'); }

test('hash: identical content produces identical hash', () => {
  assert.equal(sha('<html>hello</html>'), sha('<html>hello</html>'));
});

test('hash: changed content produces different hash', () => {
  assert.notEqual(sha('<html>v1</html>'), sha('<html>v2</html>'));
});

// ── CLI behaviour ──
test('cli: --version prints version', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--version']);
  assert.match(stdout.trim(), /^deskuptime v\d+\.\d+\.\d+$/);
});

test('cli: --help lists commands and does not leak template bugs', async () => {
  const { stdout } = await run(process.execPath, [CLI, '--help']);
  assert.match(stdout, /check <urls/);
  assert.match(stdout, /watch <url>/);
  assert.match(stdout, /watch <url> --once\s+Run one monitoring pass and exit/);
  // The help has to say that this command reports *saved* data and marks a pass
  // that is no longer current — the two facts a reader of the output needs.
  assert.match(stdout, /watch --status\s+Saved status, no network calls \(marks a pass older than \d+ d as stale\)/);
  assert.match(stdout, /--once exits 0 when all URLs are healthy, 2 when any is DOWN, and 1 for invalid usage/);
  assert.match(stdout, /Node 24\+/);
  assert.doesNotMatch(stdout, /Node 18\+/);
  // regression: literal $(...) must never appear in rendered help
  assert.ok(!stdout.includes('$('));
});

test('cli: check without URLs exits non-zero', async () => {
  await assert.rejects(
    () => run(process.execPath, [CLI, 'check']),
    (err) => err.code !== 0
  );
});

test('cli: check rejects invalid URLs before running', async () => {
  await assert.rejects(
    () => run(process.execPath, [CLI, 'check', 'not-a-url']),
    (error) => error.code === 1 && /Invalid URL: not-a-url/.test(error.stderr)
  );
});

// ── check against a local HTTP fixture (no live network) ──
test('cli: check against a local server returns UP + status', { timeout: 30000 }, async (t) => {
  const baseUrl = await fixtureServer(t);
  const { stdout } = await run(process.execPath, [CLI, 'check', `${baseUrl}/final`]);
  assert.match(stdout, new RegExp(`✅ ${baseUrl}/final`));
  assert.match(stdout, /Status:\s+200/);
  assert.match(stdout, /SSL:\s+N\/A/);
});

test('cli: check against a local TLS server reports real certificate days', { timeout: 30000 }, async (t) => {
  if (!opensslAvailable()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'du-cert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert, certPath } = selfSignedCert(dir);
  const server = createTlsServer({ key, cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>tls fixture</body></html>');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const url = `https://127.0.0.1:${port}/`;
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath };

  const { stdout } = await run(process.execPath, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT], { env });
  assert.match(stdout, new RegExp(`✅ ${url}`));
  assert.match(stdout, /Status:\s+200/);
  assert.match(stdout, /SSL:\s+2d/);

  const { stdout: json } = await run(process.execPath, [CLI, 'check', url, '--json', '--timeout', REQUEST_TIMEOUT], { env });
  const [result] = JSON.parse(json);
  assert.equal(result.healthy, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.sslError, null);
  assert.ok(result.sslDaysRemaining >= 1 && result.sslDaysRemaining <= 2, `got ${result.sslDaysRemaining}`);
});

test('ssl: an IP-literal host is checked instead of failing the handshake', { timeout: 30000 }, async (t) => {
  if (!opensslAvailable()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'du-cert-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { key, cert } = selfSignedCert(dir);
  const server = createTlsServer({ key, cert }, (_req, res) => res.end('ok'));
  const port = await listen(server);
  t.after(() => close(server));

  // Node 24+ throws when SNI is an IP literal, so passing one broke every
  // SSL check for a server monitored by IP and hid the expiry countdown.
  const result = await checkSSL(`https://127.0.0.1:${port}/`);
  assert.equal(result.error, undefined);
  assert.equal(result.isExpired, false);
  assert.ok(result.validDays >= 1 && result.validDays <= 2, `got ${result.validDays}`);
});

// ── JSON mode (if implemented): machine-readable output ──
test('cli: check --json outputs valid JSON array', { timeout: 30000 }, async (t) => {
  const baseUrl = await fixtureServer(t);
  const { stdout } = await run(process.execPath, [CLI, 'check', `${baseUrl}/final`, '--json', '--timeout', REQUEST_TIMEOUT]);
  const data = JSON.parse(stdout);
  assert.ok(Array.isArray(data));
  assert.equal(data[0].url, `${baseUrl}/final`);
  assert.equal(data[0].reachable, true);
  assert.equal(data[0].healthy, true);
  assert.equal(data[0].statusCode, 200);
});

// ── Watch state handling ──
test('watch state: corrupt state file recovers to empty state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'du-test-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, '{not valid json');
  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); } catch { state = { urls: {} }; }
  assert.deepEqual(state, { urls: {} });
  rmSync(dir, { recursive: true, force: true });
});

// ── License / status commands ──
test('cli: status runs and reports tier', async () => {
  const { stdout } = await run(process.execPath, [CLI, 'status']);
  assert.match(stdout, /(Free tier|Pro license)/);
});

test('cli: activate without key exits non-zero with usage', async () => {
  await assert.rejects(
    () => run(process.execPath, [CLI, 'activate']),
    (err) => err.code !== 0
  );
});

// ── headers command ──
test('cli: headers follows a local redirect and outputs JSON', { timeout: 30000 }, async (t) => {
  const baseUrl = await fixtureServer(t);
  const { stdout } = await run(process.execPath, [CLI, 'headers', `${baseUrl}/redirect`, '--json', '--timeout', REQUEST_TIMEOUT]);
  const r = JSON.parse(stdout);
  assert.equal(typeof r.redirected, 'boolean');
  assert.equal(r.redirected, true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.steps.length, 1);
  assert.match(String(r.security['strict-transport-security']), /max-age=63072000/);
});

test('cli: headers without URL exits non-zero', async () => {
  await assert.rejects(
    () => run(process.execPath, [CLI, 'headers']),
    (err) => err.code !== 0
  );
});

// ── watch: regression — startWatch crashed with ReferenceError (webhookUrl) ──
test('cli: watch starts monitoring without crashing', { timeout: 30000 }, async (t) => {
  const baseUrl = await fixtureServer(t);
  const home = mkdtempSync(join(tmpdir(), 'du-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [CLI, 'watch', `${baseUrl}/final`], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  // Distinguish "we killed it after it started monitoring" from "it exited on
  // its own" — resolving null in both cases made the old assertion vacuous.
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve({ started: false, code: null }); }, 8000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ started: out.includes('Monitoring'), code, signal }); });
    child.stdout.on('data', () => {
      if (out.includes('Monitoring')) { clearTimeout(timer); child.kill(); resolve({ started: true, code: null, killed: true }); }
    });
  });

  assert.ok(!out.includes('ReferenceError'), out);
  assert.match(out, /Monitoring 1 URL/);
  assert.equal(outcome.started, true, `watch never started: ${out}`);
  assert.equal(outcome.killed, true, `watch exited by itself: ${JSON.stringify(outcome)}`);
});

// ── P2-1 del B: the content check must be bounded in size and in time ──
// Both bounds exist because a monitored site is not under our control: a big
// page and a stalling body must cost us a content signal, never the loop.
async function bodyServer(t, handler) {
  const server = createServer(handler);
  const port = await listen(server);
  t.after(() => close(server));
  return `http://127.0.0.1:${port}`;
}

test('content: a normal page still hashes, counts bytes and extracts the title', async (t) => {
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Hej kunde</title></head><body>ok</body></html>');
  });
  const r = await checkContentChange(`${base}/`);
  assert.equal(r.fetched, true);
  assert.equal(r.title, 'Hej kunde');
  assert.equal(r.changed, null, 'no previous hash means no verdict, not "changed"');
  // Real bytes on the wire. The old code reported UTF-16 code units, so a page
  // with any non-ASCII text showed a smaller "bytes" figure than it sent.
  assert.equal(r.contentLength, Buffer.byteLength('<html><head><title>Hej kunde</title></head><body>ok</body></html>'));
  assert.equal(r.contentLength, new TextEncoder().encode('<html><head><title>Hej kunde</title></head><body>ok</body></html>').length);
});

test('content: an oversized page gives no content signal instead of buffering it', async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let written = 0;
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // No content-length, so the cap can only be enforced while streaming.
    const pump = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(pump);
      written += chunk.length;
      res.write(chunk);
      if (written > 4 * 1024 * 1024) { clearInterval(pump); res.end(); }
    }, 1);
  });

  const r = await checkContentChange(`${base}/`, 'stale-hash');
  assert.equal(r.fetched, false);
  assert.equal(r.tooLarge, true);
  assert.equal(r.hash, undefined, 'a partial body must never be hashed');
  assert.match(r.error, new RegExp(`${MAX_CONTENT_BYTES}-byte content-check limit`));
  // The point of the cap: we stop reading instead of taking the whole body.
  assert.ok(written < 4 * 1024 * 1024, `read ${written} bytes, expected the cap to stop it earlier`);
});

test('content: a declared oversized body is skipped without reading it', async (t) => {
  let written = 0;
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(64 * 1024 * 1024) });
    res.on('drain', () => {});
    const pump = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(pump);
      written += 65536;
      res.write(Buffer.alloc(65536));
    }, 1);
  });

  const r = await checkContentChange(`${base}/`);
  assert.equal(r.fetched, false);
  assert.equal(r.tooLarge, true);
  assert.equal(r.contentLength, 64 * 1024 * 1024, 'the server already told us the size');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(written < 1024 * 1024, `read ${written} bytes of a body the server had already sized`);
});

test('content: a body that never ends is aborted, not waited on forever', { timeout: 30000 }, async (t) => {
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><body>');   // headers and a promise, then silence
  });
  const started = Date.now();
  const r = await checkContentChange(`${base}/`, null, { timeoutMs: 250 });
  const elapsed = Date.now() - started;
  assert.equal(r.fetched, false);
  assert.match(r.error, /did not send its body within 250ms/);
  // The regression: the old code cleared its abort right after fetch resolved,
  // so a stalling body had no deadline and this call never returned.
  assert.ok(elapsed < 5000, `took ${elapsed}ms — the body read is not bounded in time`);
});

test('engine: a too-large page is never reported as a DOWN site', async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const base = await bodyServer(t, (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      // Reachability is checked with HEAD first; that must answer, or the site
      // is DOWN for a reason that has nothing to do with its size.
      if (req.method === 'HEAD') return res.end();
      const pump = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(pump);
        res.write(chunk);
      }, 1);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });

  const result = await checkUrl(`${base}/big`, { timeoutMs: 5000 });
  assert.equal(result.reachable, true);
  assert.equal(result.healthy, true, 'a big page is not an outage');
  assert.equal(result.content.fetched, false);
  assert.equal(result.content.tooLarge, true);
});

test('content: a non-UTF-8 page keeps its title and reports its real byte count', async (t) => {
  // The old code reported UTF-16 code units as "bytes" and let the runtime pick
  // the decoder. Getting either wrong shows up as a one-off false
  // content-changed alert on every non-ASCII site after an upgrade.
  const body = Buffer.from('<html><head><title>Smørrebrød</title></head><body>æøå</body></html>', 'latin1');
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
    res.end(body);
  });
  const r = await checkContentChange(`${base}/`);
  assert.equal(r.fetched, true);
  assert.equal(r.title, 'Smørrebrød', 'the declared charset must be honoured, not mojibake');
  assert.equal(r.contentLength, body.length, 'bytes on the wire, not characters');
});

// ── P1-21: a content check that did not happen must not look like a measurement ──
// The 2 MiB cap from P2-1 del B keeps one big page from taking the watch loop
// down, but it used to leave a number behind that described *our reader*, not
// the page: `check --json` published the bytes we had read when we gave up, a
// figure no server sent and one that moved between identical runs.
test('content: a skipped body reports the limit and a lower bound, never a page size', async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let written = 0;
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const pump = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(pump);
      written += chunk.length;
      res.write(chunk);
    }, 1);
  });

  const r = await checkContentChange(`${base}/`);
  assert.equal(r.fetched, false);
  assert.equal(r.tooLarge, true);
  assert.equal(r.contentLength, null, 'the byte count our reader stopped at is not the page size');
  assert.ok(r.atLeastBytes > MAX_CONTENT_BYTES, `lower bound ${r.atLeastBytes} should exceed the cap`);
  assert.equal(r.contentLimit, MAX_CONTENT_BYTES, 'the limit belongs to the fact, so a surface can name it');
  assert.ok(written < 4 * 1024 * 1024, `read ${written} bytes, the cap must still stop the read`);
});

test('content: a declared oversized body keeps the server\'s own size', async (t) => {
  const declaredBytes = 8 * 1024 * 1024;
  const base = await bodyServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(declaredBytes) });
    res.end(Buffer.alloc(1024, 0x62));
  });

  const r = await checkContentChange(`${base}/`);
  assert.equal(r.tooLarge, true);
  assert.equal(r.contentLength, declaredBytes, 'the server declared this size, so it is the page size');
  assert.equal(r.atLeastBytes, undefined, 'nothing was read, so there is no lower bound to report');
  assert.equal(r.contentLimit, MAX_CONTENT_BYTES);
});

test('readContentState: one reading of the content check, whatever shape it arrives in', () => {
  // Read the page: the byte count is ours and it is a measurement.
  const read = readContentState({ fetched: true, contentLength: 4096, hash: 'abc' });
  assert.equal(read.measured, true);
  assert.equal(read.length, 4096);
  assert.equal(read.skipped, null);

  // Declared too large: a real size the server told us, labelled as its claim.
  const declared = readContentState({ fetched: false, tooLarge: true, contentLength: 5242880, contentLimit: MAX_CONTENT_BYTES });
  assert.equal(declared.measured, false);
  assert.equal(declared.length, 5242880);
  assert.equal(declared.declared, true);
  assert.equal(declared.skipped, 'too-large');

  // Streamed too large: the number we stopped at is a lower bound, never a size.
  const streamed = readContentState({ fetched: false, tooLarge: true, contentLength: null, atLeastBytes: 2162237, contentLimit: MAX_CONTENT_BYTES });
  assert.equal(streamed.length, null, 'our own progress must never be published as the page size');
  assert.equal(streamed.atLeast, 2162237);
  assert.equal(streamed.declared, false);
  assert.equal(streamed.skipped, 'too-large');

  // Never looked at: a DOWN site, an unreachable one, plain HTTP. Nothing was
  // skipped and nothing was read, and neither may be reported as a fact.
  const never = readContentState(null);
  assert.equal(never.measured, false);
  assert.equal(never.length, null);
  assert.equal(never.skipped, null);
  assert.equal(readContentState({ fetched: false, error: 'HTTP 500' }).skipped, null);

  // A record that claims to be read but holds no usable count must not throw and
  // must not print a number: `null.toLocaleString()` used to be one line away.
  const corrupt = readContentState({ fetched: true, contentLength: -12 });
  assert.equal(corrupt.measured, true);
  assert.equal(corrupt.length, null);
  assert.equal(readContentState({ fetched: true, contentLength: 'lots' }).length, null);
  assert.equal(readContentState({ fetched: true, contentLength: Number.NaN }).length, null);
  assert.equal(contentSkipNote(readContentState({ fetched: false, tooLarge: true, contentLimit: MAX_CONTENT_BYTES })), 'not read — page over the 2,097,152-byte content-check limit');
  assert.match(contentSkipNote(streamed), /\(read 2,162,237 bytes before stopping\)$/);
});

test('cli: an oversized page says it was not read, in text and in JSON', { timeout: 30000 }, async (t) => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const base = await bodyServer(t, (req, res) => {
    // HEAD must answer, or the site is DOWN for a reason unrelated to its size.
    if (req.method === 'HEAD') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    const pump = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(pump);
      res.write(chunk);
    }, 1);
  });

  const { stdout } = await run(process.execPath, [CLI, 'check', `${base}/`, '--json', '--timeout', REQUEST_TIMEOUT]);
  const r = JSON.parse(stdout)[0];
  assert.equal(r.healthy, true, 'a big page is not an outage');
  assert.equal(r.contentChecked, false, 'the JSON must be able to say the page was not read');
  assert.equal(r.contentSkipped, 'too-large');
  assert.equal(r.contentHash, null);
  assert.equal(r.contentLength, null, `published ${r.contentLength} as the page size — our reader\'s position, not the page`);

  // And the human surface names the skip, instead of printing no Content line at
  // all and leaving `contentHash: null` to be read as "the page has no hash".
  const text = await run(process.execPath, [CLI, 'check', `${base}/`, '--timeout', REQUEST_TIMEOUT]);
  assert.match(text.stdout, /Content: not read — page over the 2,097,152-byte content-check limit/);
  assert.doesNotMatch(text.stdout, /Content: (?!not read)/, 'a skipped check must not print a byte count');
});
