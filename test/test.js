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
  assert.match(stdout, /watch --status\s+Show status without network checks/);
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
