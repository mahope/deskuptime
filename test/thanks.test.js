/**
 * P1-91 — the free tool had no way to say thank you, and never thanked anyone.
 *
 * `PRODUCT.donationUrl` has been in `src/features.js` since the free tier
 * shipped, and it is in `.github/FUNDING.yml` and the README — but the file's own
 * docstring claims *"Every customer-facing surface renders from this file"*, and
 * no customer-facing surface rendered it. Measured 2026-09-28, real CLI, a real
 * state file, a real local site answering 200:
 *
 *   deskuptime check http://localhost:60661/  →  ✅ … 200 — UP  (exit 0)
 *   deskuptime watch … --once                 →  … baseline recorded: UP (200)  (exit 0)
 *   deskuptime watch --status                 →  ✅ up … (200) · 71 bytes  (exit 0)
 *
 * Three green results, and not one of them had anywhere to say thank you. The
 * only route to the donation link was finding the repository and reading the
 * funding file. So the constant was not a claim that could drift — it was a
 * constant with no consumer, which `test/matrix.test.js` was happy about: it
 * only ever asserted the *string*, never that a command prints it.
 *
 * `watch --status` is the one place it belongs. It is the daily list, and its
 * entire output is an answer to "is it fine?" — the one command whose whole job
 * is to tell a user their monitoring works. `check` and `watch --once` are the
 * two surfaces a CI log and a cron mail read, where a tip jar is noise, and the
 * last test below locks that boundary so it stays a decision.
 *
 * Everything here is a local file and the real CLI: no network, no loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCT, renderThanks } from '../src/features.js';
import { getStateFile } from '../src/watch.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const SITE = 'https://kunde.dk/';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DONATION = 'https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c';

function hoursAgo(n) {
  return new Date(Date.now() - n * HOUR).toISOString();
}
function daysAgo(n) {
  return hoursAgo(n * 24);
}
function daysAhead(n) {
  return new Date(Date.now() + n * DAY).toISOString();
}

/** A site a real pass measured: 200, a certificate, a page, nothing else claimed. */
function healthy(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: hoursAgo(1),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    lastContentReadAt: hoursAgo(1),
    lastHash: 'a'.repeat(64),
    lastContentLength: 4096,
    sslValidDays: 89,
    ...overrides,
  };
}

/** Two license records the local reading puts *off* the free tier. */
const PRO = {
  key: '0123456789abcdef0123456789abcdef',
  instance: 'deskuptime-thanks',
  plan: 'pro',
  status: 'active',
  validatedAt: new Date().toISOString(),
};
const RELEASED = { ...PRO, released: true, releasedAt: new Date().toISOString() };

/** A throwaway HOME with a real state file the CLI will find. */
function homeWith(t, urls, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-thanks-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 1, ...extra, urls }, null, 2));
  return { home, stateFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

/** A command and its exit code together. */
function runExit(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

// ───────────────────────────────────────────────────── den grønne liste

test('en grøn, ny liste siger tak én gang, som sidste linje', async (t) => {
  const { env } = homeWith(t, { [SITE]: healthy() });
  const { code, stdout } = await runExit(['watch', '--status'], env);

  assert.equal(code, 0, 'en grøn liste er ikke en fejl');
  assert.ok(stdout.includes('✅ up'), `listen skrev ikke sit svar: ${stdout}`);
  assert.ok(stdout.includes(renderThanks()), `taklinjen mangler i listen: ${stdout}`);
  assert.ok(stdout.includes(DONATION), `taklinjen peger ikke på donationslinket: ${stdout}`);

  // One line, and it does not interrupt the answer the command exists to give:
  // the verdict is above it, so a user who reads the first line still knows
  // whether the site is up.
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.filter(line => line.includes(DONATION)).length, 1,
    `taklinjen skal siges én gang, ikke ${lines.filter(l => l.includes(DONATION)).length}: ${stdout}`);
  assert.equal(lines.at(-1).trim(), renderThanks(), 'taklinjen skal være den sidste linje');
});

test('listen siger tak med præcis den sætning, kilden ejer', async (t) => {
  // Two surfaces, one sentence. If somebody rewords the CLI without rewording
  // features.js, the two drift and this says which one is wrong.
  const { env } = homeWith(t, { [SITE]: healthy() });
  const { stdout } = await runExit(['watch', '--status'], env);
  assert.ok(renderThanks().includes(PRODUCT.donationUrl),
    'taklinjen skal bygges af den konstant, FUNDING.yml og README allerede deler');
  assert.ok(stdout.includes(renderThanks()),
    `listen skal gengive features.js' egen sætning: ${stdout}`);
});

// ───────────────────────────────────── de tilstande der ikke er et resultat

test('et nede site er ikke et resultat, der taks', async (t) => {
  const { env } = homeWith(t, { [SITE]: healthy({ wasUp: false, lastStatus: 503, checksUp: 99 }) });
  const { code, stdout } = await runExit(['watch', '--status'], env);
  assert.equal(code, 0, 'listen er read-only og skal ikke fejle på et nede site');
  assert.ok(stdout.includes('🚨 down'), `nedet site skrev ikke sit svar: ${stdout}`);
  assert.ok(!stdout.includes(DONATION), `en liste med et nede site sagde tak: ${stdout}`);
});

test('et pass der er for gammelt er ikke et resultat, der taks', async (t) => {
  // The row still reads `✅ up` — that is P1-76's measured finding — so only the
  // age can withhold the line. "Nothing broke, we just stopped looking" is not
  // something to be thanked for.
  const { env } = homeWith(t, { [SITE]: healthy({ lastChecked: daysAgo(9) }) });
  const { stdout } = await runExit(['watch', '--status'], env);
  assert.ok(stdout.includes('✅ up'), `rækken skal stadig være den målte sætning: ${stdout}`);
  assert.ok(!stdout.includes(DONATION), `en liste med et 9 dage gammelt pass sagde tak: ${stdout}`);
});

test('et site intet nogensinde har tjekket, tager ikke tak', async (t) => {
  // `lastChecked: undefined` disappears through JSON.stringify, which is exactly
  // the file a real pass leaves behind for a URL that was added and never ran.
  const { env } = homeWith(t, { [SITE]: healthy({ lastChecked: undefined }) });
  const { stdout } = await runExit(['watch', '--status'], env);
  assert.ok(!stdout.includes(DONATION), `en liste med et utjekket site sagde tak: ${stdout}`);
});

test('et ur foran sig selv tager ikke tak', async (t) => {
  // The row is `✅ up` and the pass reads as fresh — a wrong clock, not a working
  // site. The machine cannot vouch for the result, so it does not claim one.
  const { env } = homeWith(t, { [SITE]: healthy({ lastChecked: daysAhead(19) }) });
  const { stdout } = await runExit(['watch', '--status'], env);
  assert.ok(!stdout.includes(DONATION), `en liste med et ur 19 dage foran sagde tak: ${stdout}`);
});

test('en kunde der har købt, får ingen donationslinje', async (t) => {
  // The one wall that is not about the result. A Pro customer has a license and
  // a support channel; a released seat is someone who paid and gave the seat
  // back, which is a harder no than the free tier — the same rule that keeps
  // both off the checkout in `deskuptime status`.
  for (const [name, record] of [['active', PRO], ['released', RELEASED]]) {
    const { env } = homeWith(t, { [SITE]: healthy() }, { license: record });
    const { stdout } = await runExit(['watch', '--status'], env);
    assert.ok(!stdout.includes(DONATION), `en ${name} licens fik donationslinjen: ${stdout}`);
  }
});

// ───────────────────────────────────────────── advarsler er stadig et resultat

test('en liste med advarsler på rækkerne siger stadig tak', async (t) => {
  // Locks the rule where it is easy to get wrong: the predicate is about the
  // *verdict*, not about the annotations. A certificate counting down and a page
  // that changed both leave the row `✅ up` and print their own warning above
  // the footer; a stricter predicate would make the line unreachable in exactly
  // the installs that use the tool hardest.
  const { env } = homeWith(t, {
    [SITE]: healthy({
      sslValidDays: 12,
      lastContentReadAt: hoursAgo(48),
      lastContentChangedAt: hoursAgo(2),
    }),
  });
  const { stdout } = await runExit(['watch', '--status'], env);
  assert.ok(stdout.includes('renew soon'), `certifikatadvarslen skal stadig stå i rækken: ${stdout}`);
  assert.ok(stdout.includes('content changed'), `sideadvarslen skal stadig stå i rækken: ${stdout}`);
  assert.ok(stdout.includes(DONATION), `en grøn liste med advarsler sagde ikke tak: ${stdout}`);
});

// ───────────────────────────────────────────────────── hvor linjen IKKE hører hjemme

test('check og watch --once får ingen taklinje', async (t) => {
  // A deliberate boundary, locked so it stays one. Both of these are read by a
  // CI log and a cron mail — this repo ships a GitHub Action that calls `check` —
  // and a link in every build log is how a thank-you turns into noise.
  const { env } = homeWith(t, { [SITE]: healthy() });
  const check = await runExit(['check', SITE], env);
  assert.ok(!check.stdout.includes(DONATION), `check skrev donationslinket: ${check.stdout}`);
  const once = await runExit(['watch', SITE, '--once'], env);
  assert.ok(!once.stdout.includes(DONATION), `watch --once skrev donationslinket: ${once.stdout}`);
});
