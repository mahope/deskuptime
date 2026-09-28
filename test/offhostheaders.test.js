/**
 * P1-96: `headers` is the only surface that walks the redirect chain by hand, and
 * it was the only one that never asked the owner of the question the walk answers
 * — *did another host reply?*
 *
 * P1-26/P1-27 (2026-09-25) built `readRedirectTarget` as the one owner of that
 * fact and gave it to `check --json`, `watch`, both lists, the report row, the
 * named line under the report table and the paid webhook. Their lock was a scan
 * for the sentence, and the sentence is in `status.js` — so the scan went green
 * while one surface kept describing the same site its own way: not in its own
 * words, but by *not asking*.
 *
 * Measured 2026-09-28 with the real CLI, two real local servers and a site that
 * answers 301 to a path on another host (a parked page, a hijacked domain, a
 * typo landing on a registrar's "did you mean" — all three answer 200), no code
 * changed:
 *
 *   $ deskuptime headers http://127.0.0.1:61780/offhost
 *   🧭 http://127.0.0.1:61780/offhost
 *      301 → http://127.0.0.1:61779/landet
 *      Final: http://127.0.0.1:61779/landet (200) — redirected
 *      HTTPS forced: ❌ no — site served over plain HTTP
 *   exit 0
 *
 *   $ deskuptime check http://127.0.0.1:61780/offhost
 *   ✅ http://127.0.0.1:61780/offhost
 *      Status:   200 — UP
 *      ⚠️  answered by another host — the response came from 127.0.0.1:61779,
 *         not 127.0.0.1:61780
 *   exit 0
 *
 *   headers --json: { "finalUrl": "http://127.0.0.1:61779/landet", "redirected": true }
 *   check   --json: { "finalUrl": "http://127.0.0.1:61779/landet", "offHostRedirect": true }
 *
 * The chain is on screen, so a careful reader can see the host change — but the
 * *verdict line* says only "redirected", and that one word is asked to cover the
 * most ordinary redirect on the web (`www.acme.dk → acme.dk`) and a domain that
 * no longer serves the client's site at all. In `--json` a bureau's script has
 * `redirected: true` for both and no field that tells them apart, on the one
 * command whose whole job is to explain a client's site.
 *
 * The fix is one reading, asked once, from the owner every other surface already
 * uses: the same `note` in the terminal, and the same `offHostRedirect` key in
 * `--json` that `check --json` publishes — so a consumer learns the rule once.
 *
 * What does not move, and is asserted below: the verdict stays UP, the exit code
 * stays 0 (a redirect is not a failure — that is P1-26's rule, and it is why the
 * note is a ⚠️ line and not a verdict), every other line of both outputs is byte
 * for byte what it was, and a redirect on the site's *own* host stays silent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTempHome } from './helpers/env.mjs';
import { readRedirectTarget } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const REQUEST_TIMEOUT = '8000';

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-offhostheaders-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assertTempHome(env, 'P1-96');
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

/** One server that answers 200, and one that 301s the walk to the other. */
async function offHostRedirect(t) {
  const parked = await listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>domain for sale</title></html>');
  });
  const front = await listen(t, (req, res) => {
    res.writeHead(301, { location: `http://127.0.0.1:${parked.port}/landet` });
    res.end();
  });
  return { url: `http://127.0.0.1:${front.port}/`, answered: `http://127.0.0.1:${parked.port}/landet`, front };
}

/** A site that redirects to itself's other path: the ordinary redirect. */
async function sameHostRedirect(t) {
  const site = await listen(t, (req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/gammel') {
      res.writeHead(301, { location: '/ny' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>ny</title></html>');
  });
  return { url: `http://127.0.0.1:${site.port}/gammel`, final: `http://127.0.0.1:${site.port}/ny` };
}

/**
 * A walk that crosses to the other host and then loops, so the last address we
 * *asked* is on the other host while no response ever came from it. The chain is
 * abandoned, which is the case that must not claim a crossing nobody saw.
 */
async function abandonedAfterCrossing(t) {
  const other = { port: null };
  const front = await listen(t, (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/loop-here') {
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}/hop` });
      res.end();
      return;
    }
    res.writeHead(302, { location: `http://127.0.0.1:${other.port}/hop` });
    res.end();
  });
  const away = await listen(t, (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/hop') {
      res.writeHead(302, { location: `http://127.0.0.1:${front.port}/loop-here` });
      res.end();
      return;
    }
    res.writeHead(302, { location: `http://127.0.0.1:${front.port}/loop-here` });
    res.end();
  });
  other.port = away.port;
  return { url: `http://127.0.0.1:${front.port}/loop-here` };
}

// ── Den målte kunderejse: rigtig CLI, rigtige servere ─────────────────────────

test('et site der svarer fra en anden vært siges det med ejers sætning', async (t) => {
  const env = tempHome(t);
  const { url, answered } = await offHostRedirect(t);

  const out = await runCli(['headers', url, '--timeout', REQUEST_TIMEOUT], env);
  // The verdict and the exit code are P1-26's rule and do not move: a redirect
  // is not a failure, or every `www → apex` on the web would be a false alarm.
  assert.equal(out.code, 0, `en redirect er ikke en fejl:\n${out.stdout}${out.stderr}`);
  assert.match(out.stdout, /Final: .*\(200\) — redirected/, `hoppet skal stadig stå der:\n${out.stdout}`);
  assert.match(
    out.stdout,
    /⚠️  answered by another host — the response came from 127\.0\.0\.1:\d+, not 127\.0\.0\.1:\d+/,
    `værtskiftet skal have ejers sætning:\n${out.stdout}`,
  );
  assert.ok(out.stdout.includes(answered), `den adresse der svarede skal kunne læses:\n${out.stdout}`);

  // The two commands must not describe one site in two ways: this is the sentence
  // `check` printed for the very same URL before the fix existed.
  const check = await runCli(['check', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(check.code, 0);
  assert.match(check.stdout, /answered by another host — the response came from/);
});

test('begge JSON-flader giver samme nøgle og samme svar om det samme site', async (t) => {
  const env = tempHome(t);
  const { url } = await offHostRedirect(t);

  const headers = JSON.parse((await runCli(['headers', url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);
  const check = JSON.parse((await runCli(['check', url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);

  assert.equal(headers.offHostRedirect, true, 'et bureau-script skal kunne se krydsningen i headers --json');
  assert.equal(check[0].offHostRedirect, true, 'og check --json skal sige det samme om det samme site');
  // One key, one meaning: the consumer learns the rule once, and a script that
  // reads both outputs does not have to know which command wrote which.
  assert.equal(typeof headers.offHostRedirect, 'boolean');
  assert.equal(headers.redirected, true, 'redirected er uændret — den dækker stadig www → apex');
});

test('en redirect på sitets egen vært tier, og resten af output er uændret', async (t) => {
  const env = tempHome(t);
  const { url, final } = await sameHostRedirect(t);

  const out = await runCli(['headers', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(out.code, 0);
  assert.ok(!out.stdout.includes('answered by another host'), `egen vært skal ikke være en advarsel:\n${out.stdout}`);
  assert.match(out.stdout, new RegExp(`Final: ${final.replace(/[.]/g, '\\.')} \\(200\\) — redirected`));

  const json = JSON.parse((await runCli(['headers', url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);
  assert.equal(json.offHostRedirect, false);
  assert.equal(json.redirected, true, 'den almindelige redirect er stadig en redirect');
  assert.equal(json.healthy, true);
  assert.equal(json.securityChecked, true, 'målingen af headerne er urørt');
});

test('en kæde vi ikke fulgte til ende kan ikke have svaret fra en anden vært', async (t) => {
  const env = tempHome(t);
  const { url } = await abandonedAfterCrossing(t);

  const out = await runCli(['headers', url, '--timeout', REQUEST_TIMEOUT], env);
  // Dommen er urørt: en forladt kæde er ikke et sundt site (P1-84's regel, låst
  // af `test/redirectcredentials.test.js` og af exit-koden her).
  assert.equal(out.code, 2, `en forladt kæde er ikke en måling:\n${out.stdout}`);
  assert.ok(!out.stdout.includes('answered by another host'), `vi så ingen svarer, så vi kan ikke påstå det:\n${out.stdout}`);
  assert.match(out.stdout, /Final: — \(redirect chain not followed\)/);

  const json = JSON.parse((await runCli(['headers', url, '--json', '--timeout', REQUEST_TIMEOUT], env)).stdout);
  assert.equal(json.stopReason, 'loop');
  assert.equal(json.securityChecked, false);
  // Her ville krydsningen være sand uden porten: den sidste adresse vi *bad om*
  // lå på den anden vært, men intet svar kom derfra nogensinde.
  assert.equal(json.offHostRedirect, false, 'en vært der aldrig svarede kan ikke have svaret');
});

// ── Den strukturelle regel: én ejer, én sætning ──────────────────────────────

test('hen spørger ejeren, og sætningen findes kun ét sted i kilden', () => {
  const cli = readFileSync(CLI, 'utf8');
  const headersBlock = cli.slice(cli.indexOf("if (command === 'headers')"), cli.indexOf('// ── Activate'));
  assert.match(headersBlock, /readRedirectTarget\(\{ url, finalUrl: chain\.measured \? r\.finalUrl : null \}\)/,
    'headers skal bede den samme ejer om krydsningen, gated på at kæden blev målt');

  // One sentence, one file. A second copy is a second description of one fact,
  // which is the shape P1-26 removed from `check` and this file exists to keep
  // from coming back through a surface nobody scanned. The marker is the owner's
  // whole sentence, not its first three words: `report.js` may wrap it in the
  // named line under the table ("… answered by another host — the monitored URL
  // no longer serves the site itself"), and it does — measured, not assumed.
  const marker = 'answered by another host — the response came from';
  const owners = ['status.js', 'checkers/headers.js', 'watch.js', 'report.js', 'display.js', 'cli.js', 'features.js']
    .filter(name => readFileSync(join(ROOT, 'src', name), 'utf8').includes(marker));
  assert.deepEqual(owners, ['status.js'], `sætningen skal kun skrives i status.js, men findes i: ${owners.join(', ')}`);
  // And the report's named line is a wrapper around the same sentence, not a
  // replacement for it: the customer document names the host change in the
  // owner's own words.
  const report = readFileSync(join(ROOT, 'src', 'report.js'), 'utf8');
  assert.match(report, /offHostNote/, `rapportens navngiven linje skal bygge af ejers sætning:\n${report.slice(report.indexOf('answered by another host') - 400, report.indexOf('answered by another host') + 200)}`);

  // And the owner keeps the rule the fix leans on: a reading that cannot be
  // measured claims nothing, so a chain we abandoned is silent by construction.
  const silent = readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: null });
  assert.equal(silent.offHost, false);
  assert.equal(silent.note, '');
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: 'https://kunde.dk/ny' }).offHost, false);
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: 'https://parket.dk/' }).offHost, true);
});
