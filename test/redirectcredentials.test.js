/**
 * P1-71: a password in a **redirect target** is a secret the site handed us, and
 * the free tool printed it — twice — on the one command a bureau runs to explain
 * a client's site.
 *
 * P1-45 (2026-09-26) closed the address a *user* types: `watch`,
 * `unwatch`, `check` and the report all refuse `http://demo:pass@…` and never
 * store it. It said nothing about the address a *site* answers with, and its
 * locks could not see that half: a `Location:` header is the one URL in the
 * whole program that we did not write and did not choose.
 *
 * Measured 2026-09-27 with the real CLI, two local servers and a redirect
 * carrying a password, no code changed:
 *
 *   $ deskuptime headers http://127.0.0.1:51748/
 *   🧭 http://127.0.0.1:51748/
 *      Final: http://demo:sup3rsecret@127.0.0.1:51747/staging (n/a)
 *      ⚠️  Error: Request cannot be constructed from a URL that includes
 *         credentials: http://demo:sup3rsecret@127.0.0.1:51747/staging
 *
 *   $ deskuptime headers http://127.0.0.1:51748/ --json
 *   { "finalUrl": "http://demo:sup3rsecret@127.0.0.1:51747/staging",
 *     "steps": [ { "url": "http://127.0.0.1:51748/", "status": 302,
 *                  "location": "http://demo:sup3rsecret@127.0.0.1:51747/staging" } ],
 *     "error": "Request cannot be constructed from a URL that includes credentials:
 *               http://demo:sup3rsecret@127.0.0.1:51747/staging" }
 *
 * Three copies of the password on stdout, three more in `--json`, and a bureau
 * pastes that JSON into a ticket, a step summary or an email. The site it
 * describes is a customer's staging site behind a proxy that asks for HTTP Basic
 * credentials — the single most ordinary reason a redirect target carries one.
 *
 * Two things the same measurement proved, and they are why this is one owner and
 * not four patches:
 *
 *   1. `fetch` refuses to build a request for a URL with credentials, so the
 *      *check* leg never carries one: `check` answered `cross origin not allowed
 *      for request mode "cors"` with `finalUrl: null`, and the state file, the
 *      alert to the customer's channel and the report were all clean already.
 *      Only `headers`, which follows the chain by hand, ever held the string.
 *   2. The error sentence is `undici`'s, not ours, and it quotes the URL that
 *      failed. So the leak had a second, textual shape — which is why
 *      `scrubUrlCredentials` exists next to `withoutCredentials`: one owner for
 *      an address, its sibling for a sentence that quotes one.
 *
 * The verdict does not move. The walk still *requests* the real address, so the
 * credentialed hop fails exactly as `check` fails on it, and the two commands
 * keep agreeing about the site — measured before and after, both exit 2.
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
import { describeFetchError, readRedirectTarget, scrubUrlCredentials } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const PASSWORD = 'sup3rsecret';
const REQUEST_TIMEOUT = '8000';

/** Every copy of the password a reader can find in a string, whole or in JSON. */
function copies(text) {
  return String(text).split(PASSWORD).length - 1;
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-redirectcreds-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assertTempHome(env, 'P1-71');
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

/**
 * Two real servers: one answers 200, the other sends a `Location` header that
 * carries a password on its way there. The walk is real — no stubbed fetch — so
 * what a surface shows is what it would show on a client's site.
 */
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

// ── The two owners ───────────────────────────────────────────────────────────

test('en sætning får hverken brugernavn eller adgangskode uden URL\'en de lå i', () => {
  const withPassword = `Request cannot be constructed from a URL that includes credentials: http://demo:${PASSWORD}@a.dk/staging`;
  assert.equal(
    scrubUrlCredentials(withPassword),
    'Request cannot be constructed from a URL that includes credentials: http://a.dk/staging',
  );
  assert.equal(scrubUrlCredentials('https://demo@a.dk/ og http://demo:' + PASSWORD + '@b.dk/'), 'https://a.dk/ og http://b.dk/');

  // Text we did not write keeps its own characters: a relative redirect with an
  // `@` in it is a path, and a `mailto:` address is not a request we can send.
  assert.equal(scrubUrlCredentials('Location: /@handle/profil'), 'Location: /@handle/profil');
  assert.equal(scrubUrlCredentials('skriv til demo@a.dk'), 'skriv til demo@a.dk');
  assert.equal(scrubUrlCredentials('HTTP://Demo:' + PASSWORD + '@a.dk/'), 'HTTP://a.dk/', 'store bogstaver er også credentials');
  assert.equal(scrubUrlCredentials('Connection refused'), 'Connection refused', 'en sætning uden URL er uændret');
  assert.equal(scrubUrlCredentials(''), '');
});

test('fejl-sætningen er renset dér den bliver en påstand, ikke på de seks flader', () => {
  const spoken = { cause: { message: `boom http://demo:${PASSWORD}@a.dk/x` } };
  const described = describeFetchError(spoken);
  assert.equal(described.errorType, 'network_error');
  assert.equal(described.error, 'boom http://a.dk/x');
  assert.equal(copies(described.error), 0, 'den tekst kunden læser må ikke have adgangskoden i');

  // The sentences we own are byte for byte what they were.
  assert.deepEqual(describeFetchError({ name: 'TimeoutError' }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ cause: { code: 'ECONNREFUSED' } }), { errorType: 'connection_refused', error: 'Connection refused' });
  assert.deepEqual(describeFetchError({ cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND a.dk' } }), { errorType: 'dns_error', error: 'getaddrinfo ENOTFOUND a.dk' });
});

test('den kendsgerning der forlader maskinen har aldrig en adgangskode i', () => {
  // `fetch` will not produce this, so the owner is asked directly: `finalUrl` is
  // published to the customer's own channel as the paid webhook's `finalUrl`.
  const target = readRedirectTarget({
    url: 'https://kunde.dk/',
    finalUrl: `http://demo:${PASSWORD}@parked.example/lander?token=abc`,
  });
  assert.equal(copies(JSON.stringify(target)), 0, 'webhook-kroppen må ikke have adgangskoden i');
  assert.equal(target.finalUrl, 'http://parked.example/lander?token=abc', 'resten af den adresse er stadig værdien kunden har brug for');
  assert.equal(target.offHost, true);
  assert.equal(target.answeredHost, 'parked.example');
  assert.match(target.note, /parked\.example/);

  // A final URL we did not write to is returned unchanged — a token in the path
  // is a fact about the customer, not something to redact (P1-27).
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: 'https://kunde.dk/ny' }).finalUrl, 'https://kunde.dk/ny');
});

// ── Den målte kunderejse: rigtig CLI, rigtige servere ─────────────────────────

test('et redirect med en adgangskode i er ikke en grund til at rydde dommen', async (t) => {
  const env = tempHome(t);
  const { url, finalUrl } = await credentialedRedirect(t);

  const out = await runCli(['headers', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(out.code, 2, 'sitet er stadig DOWN: adgangskoden i et redirect må ikke gøre et dødt site sundt');
  assert.equal(copies(out.stdout), 0, `adgangskoden nåede terminalen:\n${out.stdout}`);
  assert.equal(copies(out.stderr), 0, `adgangskoden nåede stderr:\n${out.stderr}`);

  // The reason is still named, and the hop is still shown: a bureau must be able
  // to see that the site sent the client somewhere else.
  assert.match(out.stdout, /includes credentials/, 'grunden for fejlen skal stadig stå i linjen');
  assert.match(out.stdout, new RegExp(`Final: ${finalUrl.replace(/[.]/g, '\\.')} \\(n/a\\)`), `hoppet skal stadig kunne læses:\n${out.stdout}`);

  const json = await runCli(['headers', url, '--json', '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(json.code, 2);
  assert.equal(copies(json.stdout), 0, `adgangskoden nåede JSON:\n${json.stdout}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.finalUrl, finalUrl, 'den beskrevne adresse er den rensede, ikke en ny');
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].location, finalUrl, 'hoppet er med, uden adgangskoden');
  assert.equal(parsed.steps[0].url, url, 'den første hoppe er den brugeren bad om');
  assert.equal(parsed.redirected, true);
  assert.equal(parsed.reachable, false, 'der kom intet svar fra den adgangskodet adresse');
  assert.equal(parsed.healthy, false);
  assert.equal(parsed.stopReason, null);

  // And the two commands still agree about the site, which is the one thing a
  // client document may not contradict itself about.
  const check = await runCli(['check', url, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(check.code, 2, 'check skal stadig sige DOWN om det samme site');
  assert.equal(copies(check.stdout), 0);
});
