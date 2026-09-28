/**
 * headersource.test.js — whose response the five security headers belong to
 *
 * Measured 2026-09-28 (P1-97) with the real CLI against two real local servers:
 * a client domain that 301s to a parking page on another host, where the
 * stranger sent *strong* security headers and a `X-Powered-By` version string:
 *
 *   $ deskuptime headers http://127.0.0.1:65108/
 *      301 → http://127.0.0.1:65107/parked
 *      Final: http://127.0.0.1:65107/parked (200) — redirected
 *      ⚠️  answered by another host — the response came from 127.0.0.1:65107, not …
 *      ⚠️  X-Powered-By exposed: PHP/8.2.1
 *      ✅ strict-transport-security: max-age=63072000
 *      ✅ content-security-policy: default-src 'none'
 *      ✅ x-content-type-options: nosniff
 *      ✅ x-frame-options: DENY
 *      ✅ referrer-policy: no-referrer
 *
 * Every line below the `Final:` was the **stranger's**, printed as the client's,
 * in a sheet byte-identical to the one `headers` prints for the stranger itself.
 * A bureau scanning a client domain — the job this command exists for — could
 * write the stranger's HSTS and the stranger's `PHP/8.2.1` into a customer's
 * report, and `headers --json` gave a script `security` with no field saying
 * whose values they were.
 *
 * The rule these tests hold: a walk that left the host reads the five headers
 * and the two stack fields from the **site's own first response**, and says so.
 * A redirect inside one host keeps the final reading, byte for byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTempHome } from './helpers/env.mjs';
import { readHeaderSource } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const CHECKER = join(ROOT, 'src', 'checkers', 'headers.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const REQUEST_TIMEOUT = '8000';

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-headersource-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assertTempHome(env, 'P1-97');
  return env;
}

/** The CLI, with a throwaway HOME and no license calls (P1-58). */
function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, ...env, DUB_STUB_SCENARIO: 'passthrough' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function listen(t, handler) {
  const server = createServer(handler);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** The stranger: a parked page with strong headers, so a leak is unmistakable. */
const STRANGER_HEADERS = {
  'content-type': 'text/html',
  server: 'nginx/1.18.0',
  'x-powered-by': 'PHP/8.2.1',
  'strict-transport-security': 'max-age=63072000',
  'content-security-policy': "default-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

async function parkedPage(t) {
  return listen(t, (req, res) => {
    res.writeHead(200, STRANGER_HEADERS);
    res.end('<html><title>domain for sale</title></html>');
  });
}

/**
 * The client domain: it answers a 301 and puts *its own* weak-but-real reading
 * on that hop, so a sheet that came from the wrong host is obvious in both
 * directions — a stranger's `max-age=63072000` must not appear, and the site's
 * own `max-age=300` and its empty `X-Powered-By` must.
 */
async function clientRedirectingAway(t, parked) {
  const front = await listen(t, (req, res) => {
    res.writeHead(301, {
      location: `http://127.0.0.1:${parked.port}/landet`,
      server: 'cloudflare',
      'x-powered-by': '',
      'strict-transport-security': 'max-age=300',
    });
    res.end();
  });
  return { url: `http://127.0.0.1:${front.port}/`, host: `127.0.0.1:${front.port}` };
}

/** The ordinary redirect: one host, two paths, a strong final page. */
async function sameHostRedirect(t) {
  const site = await listen(t, (req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/gammel') {
      res.writeHead(301, { location: '/ny', 'strict-transport-security': 'max-age=99' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html',
      'strict-transport-security': 'max-age=31536000',
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end('<html><title>ny</title></html>');
  });
  return { url: `http://127.0.0.1:${site.port}/gammel`, host: `127.0.0.1:${site.port}` };
}

// ── Den målte kunderejse: rigtig CLI, rigtige servere ─────────────────────────

test('et krydsende svar giver ikke fremmede headere som kundens fund', async (t) => {
  const env = tempHome(t);
  const parked = await parkedPage(t);
  const client = await clientRedirectingAway(t, parked);

  const out = await runCli(['headers', client.url, '--timeout', REQUEST_TIMEOUT], env);

  // Not one value of the stranger's may be on the sheet, with or without its name.
  for (const value of ['max-age=63072000', "default-src 'none'", 'DENY',
    'no-referrer', 'nginx/1.18.0', 'PHP/8.2.1']) {
    assert.equal(out.stdout.includes(value), false,
      `fremmede værd må ikke stå på arket: ${value}\n${out.stdout}`);
  }
  // And the site's own reading is what stands there.
  assert.match(out.stdout, /✅ strict-transport-security: max-age=300/);
  assert.match(out.stdout, /X-Powered-By sent with no value/);
  // The sheet says whose it is — the owner owns the sentence, both surfaces read it.
  assert.match(out.stdout, new RegExp(`the five security headers and the stack are ${client.host}'s own`));
  // P1-96's line and P1-26's rule both stay: a redirect is not a failure.
  assert.match(out.stdout, /answered by another host — the response came from 127\.0\.0\.1:\d+, not/);
  assert.equal(out.code, 0);
});

test('det er netop arkene for den fremmede vært, der ikke må bruges', async (t) => {
  const env = tempHome(t);
  const parked = await parkedPage(t);
  const client = await clientRedirectingAway(t, parked);

  const strangerSheet = (await runCli(['headers', `http://127.0.0.1:${parked.port}/landet`, '--timeout', REQUEST_TIMEOUT], env)).stdout;
  const clientSheet = (await runCli(['headers', client.url, '--timeout', REQUEST_TIMEOUT], env)).stdout;

  // The two sheets agreed line for line before the fix. They must not share a
  // single header line now: the whole point is that they are readings of two
  // different servers.
  const lines = (text) => text.split('\n')
    .map(line => line.trim())
    .filter(line => /^(✅|⚠️|⬜) (strict-transport|content-security|x-content-type|x-frame|referrer|X-Powered-By)/.test(line));
  const overlap = lines(strangerSheet).filter(line => lines(clientSheet).includes(line));
  assert.deepEqual(overlap, [],
    `de to ark må ikke dele en headerlinje:\n${overlap.join('\n')}`);
});

test('en redirect på egen vært er uændret: sidens egen side er sandheden', async (t) => {
  const env = tempHome(t);
  const site = await sameHostRedirect(t);

  const out = await runCli(['headers', site.url, '--timeout', REQUEST_TIMEOUT], env);

  // Byte for byte the pre-existing behaviour: the final page of the same site.
  assert.match(out.stdout, /✅ strict-transport-security: max-age=31536000/);
  assert.equal(out.stdout.includes('max-age=99'), false, 'første hop skal ikke vinde på egen vært');
  // The owner's sentence is silent here — a normal site must not grow a line.
  assert.equal(out.stdout.includes('are '), false);
  assert.equal(out.code, 0);
});

test('et script kan se hvilken vært arket er læst fra', async (t) => {
  const env = tempHome(t);
  const parked = await parkedPage(t);
  const client = await clientRedirectingAway(t, parked);
  const site = await sameHostRedirect(t);

  const crossed = JSON.parse((await runCli(['headers', client.url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);
  const same = JSON.parse((await runCli(['headers', site.url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);

  // Positive, not a boolean: a script compares it with the host it asked.
  assert.equal(crossed.headersFrom, client.host);
  assert.equal(crossed.offHostRedirect, true);
  assert.equal(crossed.security['strict-transport-security'], 'max-age=300');
  assert.equal(crossed.security['x-frame-options'], null, 'fremmede fund må ikke stå i JSON');
  assert.equal(crossed.server, 'cloudflare');
  assert.equal(crossed.poweredBy, '');
  assert.equal(crossed.securityChecked, true);

  // The ordinary site names itself, and its final reading is untouched.
  assert.equal(same.headersFrom, site.host);
  assert.equal(same.offHostRedirect, false);
  assert.equal(same.security['strict-transport-security'], 'max-age=31536000');
  assert.equal(same.securityChecked, true);

  // The walk's internal bookkeeping is not part of any consumer's contract.
  assert.equal('ownReading' in crossed, false);
  assert.equal('ownReading' in same, false);
});

// ── Ejers regel, målt på en rigtig læsning ──────────────────────────────────

test('ejers sætning tier på egen vært og siger noget på en fremmed', () => {
  const same = readHeaderSource({ url: 'https://acme.dk/gammel', finalUrl: 'https://acme.dk/ny' });
  assert.equal(same.crossed, false);
  assert.equal(same.note, '');
  assert.equal(same.host, 'acme.dk');

  const crossed = readHeaderSource({ url: 'https://acme.dk/', finalUrl: 'https://parket.example/landet' });
  assert.equal(crossed.crossed, true);
  assert.equal(crossed.host, 'acme.dk', 'arket er læst fra det vi spurgte, ikke fra svareren');
  assert.equal(crossed.note.includes('parket.example'), true);
  assert.equal(crossed.note.includes('acme.dk'), true);

  // Samme regel som P1-26: en kæde uden svar må ikke påstå noget.
  const unanswered = readHeaderSource({ url: 'https://acme.dk/', finalUrl: null, measured: false });
  assert.equal(unanswered.crossed, false);
  assert.equal(unanswered.host, null, 'ingen læsning at tilskrive');
  assert.equal(unanswered.note, '');
});

// ── Struktur-låse ───────────────────────────────────────────────────────────

test('gået kæde læser egen første læsning, og ejers sætning findes kun i status.js', () => {
  const checker = readFileSync(CHECKER, 'utf8');
  const cli = readFileSync(CLI, 'utf8');
  const status = readFileSync(join(ROOT, 'src', 'status.js'), 'utf8');

  // The first response is kept, or there is no reading of the site to show.
  assert.match(checker, /ownReading = readResponseHeaders\(r\)/);
  // The terminal publishes the chosen reading, not the last response's.
  assert.match(cli, /const reading = source\.crossed && r\.ownReading \? r\.ownReading/);
  // `ownReading` must not survive into the document as a second reading.
  assert.match(cli, /const \{ ownReading, \.\.\.rest \} = r/);
  // One owner for the sentence: the whole sentence, not its first words. P1-96
  // measured that a lock on the first three words is red for the wrong reason.
  assert.equal(cli.includes('are ' + "the five security headers"), false);
  assert.equal(status.includes('are ${askedHost}\'s own'), true);
  assert.equal(checker.includes('are ${askedHost}\'s own'), false);
});
