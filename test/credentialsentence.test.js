/**
 * P1-72: a site that answers 200 the whole way was reported DOWN with a sentence
 * about **CORS** — in the client document a bureau forwards to a customer.
 *
 * P1-71 (2026-09-27) closed the password a *redirect target* leaked. It said
 * nothing about the sentence describing **why** the request never happened, so
 * the leak was gone and the uselessness stayed.
 *
 * Measured 2026-09-27 with the real CLI, two real local servers, no code
 * changed: one server answers 200, the other sends
 * `Location: http://demo:sup3rsecret@…/staging`.
 *
 *   $ deskuptime check http://127.0.0.1:49174/
 *   ❌ http://127.0.0.1:49174/
 *      Status:   N/A — DOWN
 *      ⚠️  Error:  cross origin not allowed for request mode "cors"
 *
 *   $ deskuptime check http://127.0.0.1:49174/ --json
 *   { "reachable": false, "healthy": false, "statusCode": null, "finalUrl": null,
 *     "errorType": "network_error",
 *     "error": "cross origin not allowed for request mode \"cors\"" }
 *
 *   $ deskuptime watch http://127.0.0.1:49174/ --once
 *   • http://127.0.0.1:49174/ baseline recorded: DOWN — cross origin not allowed
 *     for request mode "cors"
 *
 *   # and on a down transition, the same string in the message the **paid**
 *   # webhook carries to Slack/Discord/Teams (watch.js builds it from `result.error`):
 *   🚨 http://127.0.0.1:49906/ is DOWN — cross origin not allowed for request
 *     mode "cors"
 *
 * No browser is involved anywhere: this is a CLI in a shell, a customer's proxy
 * put HTTP Basic into a `Location` header, and the customer's own status page
 * reads CORS. That is P1-35's class — a claim that does not describe what
 * happened — on the sentence a bureau copies.
 *
 * The measurement also found the cause, and it is two sentences for one fact.
 * `fetch` has two different failures for a credentialed address:
 *
 *   - a URL the **caller typed** is refused outright, with
 *     `Request cannot be constructed from a URL that includes credentials: <url>`;
 *   - a URL we only reach by **following a redirect** never gets that sentence.
 *     `undici`'s cross-origin gate throws `fetch failed` with a cause reading
 *     `cross origin not allowed for request mode "cors"`.
 *
 * `check` follows redirects, so it always gets the second form; `headers` walks
 * the chain by hand and hands the address to `fetch` directly, so it gets the
 * first. `headers` was therefore the only surface that told the truth, and the
 * one nobody pastes into a client document.
 *
 * Reading CORS as a cross-origin failure is safe **only** in Node, and that is
 * measured rather than assumed: eight shapes were tried (a foreign
 * `Access-Control-Allow-Origin`, no ACAO header, `mode: 'no-cors'`,
 * `mode: 'cors'`, a POST, a username with no password, a typed credentialed URL
 * and a credentialed redirect) on Node 22.23.2 and 26.7.0. Only the last
 * produced the sentence — Node's `fetch` does not enforce CORS responses at all.
 *
 * What must **not** move: the site is genuinely unmeasurable, because the
 * request was never sent. So the verdict stays DOWN, the exit code stays 2, the
 * JSON keeps its shape, and `errorType` stays `network_error` — the last one is
 * load-bearing, because `canReadCertificate()` spends the certificate reading on
 * a `network_error`, and a customer behind such a proxy still wants to know what
 * the certificate of the site in front of the redirect looks like. Only the
 * sentence changes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTempHome } from './helpers/env.mjs';
import { describeFetchError } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const PASSWORD = 'sup3rsecret';
const CORS = 'cross origin not allowed';
const REQUEST_TIMEOUT = '8000';

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-credcredentials-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assertTempHome(env, 'P1-72');
  return env;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, ...env, DUB_STUB_SCENARIO: 'passthrough' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

/** The sentence `undici` throws for a redirect into a credentialed address. */
function undiciCredentialsGate() {
  return { name: 'TypeError', message: 'fetch failed', cause: { message: `${CORS} for request mode "cors"` } };
}

/** The same site as the last test file builds it: 200 behind a credentialed hop. */
async function credentialedRedirect(t) {
  const target = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>staging</title>hej</html>');
  });
  t.after(() => target.close());
  const targetPort = await new Promise((r) => target.listen(0, '127.0.0.1', () => r(target.address().port)));

  const front = createServer((req, res) => {
    res.writeHead(302, { location: `http://demo:${PASSWORD}@127.0.0.1:${targetPort}/staging` });
    res.end();
  });
  t.after(() => front.close());
  const frontPort = await new Promise((r) => front.listen(0, '127.0.0.1', () => r(front.address().port)));

  return {
    url: `http://127.0.0.1:${frontPort}/`,
    finalUrl: `http://127.0.0.1:${targetPort}/staging`,
  };
}

// ── The one owner ─────────────────────────────────────────────────────────────

test('en fejl om credentials siger aldrig CORS', () => {
  const described = describeFetchError(undiciCredentialsGate());
  assert.equal(described.errorType, 'network_error', 'dommen flytter sig ikke: requesten blev aldrig sendt');
  assert.equal(described.error, 'Redirected to an address with credentials in it — no request was sent');
  assert.doesNotMatch(described.error, /cors/i, 'et site uden en browser kan ikke være blevet afvist på tværs af origin');
  assert.doesNotMatch(described.error, new RegExp(PASSWORD), 'sætningen må ikke cite noget som helst');
});

test('kun den sætning ændrer sig — de fire egne sætninger er tegn for tegn uændrede', () => {
  assert.deepEqual(describeFetchError({ name: 'TimeoutError' }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ name: 'AbortError' }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ cause: { code: 'ECONNREFUSED' } }), { errorType: 'connection_refused', error: 'Connection refused' });
  assert.deepEqual(
    describeFetchError({ cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND a.dk' } }),
    { errorType: 'dns_error', error: 'getaddrinfo ENOTFOUND a.dk' },
  );

  // Every other network failure keeps `undici`'s own sentence, redacted (P1-71):
  // the certificate sentences land here too, and they are the ones a bureau acts on.
  assert.deepEqual(
    describeFetchError({ cause: { message: 'certificate has expired' } }),
    { errorType: 'network_error', error: 'certificate has expired' },
  );
  assert.deepEqual(
    describeFetchError({ message: 'socket hang up' }),
    { errorType: 'network_error', error: 'socket hang up' },
  );
  assert.deepEqual(
    describeFetchError({ cause: { message: `certificate has expired for http://demo:${PASSWORD}@a.dk/` } }),
    { errorType: 'network_error', error: 'certificate has expired for http://a.dk/' },
  );
  assert.deepEqual(describeFetchError({}), { errorType: 'network_error', error: 'Network request failed' });
  assert.deepEqual(describeFetchError(null), { errorType: 'network_error', error: 'Network request failed' });
});

// ── Den målte kunderejse: rigtig CLI, rigtige servere ─────────────────────────

test('et sundt site bag et credentialed redirect siger hvad der skete — på alle flader', async (t) => {
  const env = tempHome(t);
  const { url, finalUrl } = await credentialedRedirect(t);

  const out = await runCli(['check', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(out.code, 2, 'sitet er stadig DOWN: requesten blev aldrig sendt, så der er intet at måle');
  assert.doesNotMatch(out.stdout, /cors/i, `CORS nåede terminalen:\n${out.stdout}${out.stderr}`);
  assert.doesNotMatch(out.stderr, /cors/i);
  assert.match(
    out.stdout,
    /Redirected to an address with credentials in it — no request was sent/,
    `sætningen skal sige hvad der skete:\n${out.stdout}`,
  );
  assert.match(out.stdout, /is DOWN|N\/A — DOWN/, `dommen skal stå uændret:\n${out.stdout}`);

  const json = await runCli(['check', url, '--json', '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(json.code, 2);
  assert.doesNotMatch(json.stdout, /cors/i, `CORS nåede JSON:\n${json.stdout}`);
  const parsed = JSON.parse(json.stdout)[0];

  // The whole shape is unmoved: the fields, their types, the errorType. Only the
  // sentence is ours now.
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.healthy, false);
  assert.equal(parsed.statusCode, null);
  assert.equal(parsed.finalUrl, null, 'der kom aldrig et svar, så der er ingen endelig adresse');
  assert.equal(parsed.errorType, 'network_error');
  assert.equal(parsed.error, 'Redirected to an address with credentials in it — no request was sent');
  assert.equal(parsed.responseTimeMs, null, 'vi ventede ikke på svar — der kom ikke et');

  // A pass writes the same sentence into the line a bureau reads while waiting,
  // and into the message the paid webhook carries to the customer's channel.
  const pass = await runCli(['watch', url, '--once'], env);
  assert.doesNotMatch(`${pass.stdout}${pass.stderr}`, /cors/i, `CORS nåede passet:\n${pass.stdout}${pass.stderr}`);
  assert.match(pass.stdout, /credentials in it — no request was sent/);
});

test('de to kommandoer bliver enige om sætningen uden at dommen flytter sig', async (t) => {
  const env = tempHome(t);
  const { url, finalUrl } = await credentialedRedirect(t);

  // `headers` walks the chain by hand, so `fetch` refuses the credentialed
  // address directly and `undici` names it. That sentence is the *true* one and
  // P1-71 locked it; it must survive this change untouched.
  const headers = await runCli(['headers', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(headers.code, 2, 'begge kommandoer skal stadig sige DOWN om samme site');
  assert.match(headers.stdout, /includes credentials/, 'den informative sætning fra headers er ikke rørt');
  assert.match(headers.stdout, new RegExp(`Final: ${finalUrl.replace(/[.]/g, '\\.')} \\(n/a\\)`), 'hoppet skal stadig kunne læses');

  // The two commands now name the same fact in their own words, and neither
  // contradicts the other about the site. That is the whole point: P1-71's lock
  // was that they agree about the *verdict*, and this keeps it while the
  // sentences stop disagreeing about the vocabulary.
  const check = await runCli(['check', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(check.code, headers.code);
  assert.match(check.stdout, /credentials in it/);
  assert.match(headers.stdout, /includes credentials/);
});
