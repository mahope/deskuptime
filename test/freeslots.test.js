/**
 * P1-109 — the free tier's ceiling was invisible on the surface a free user
 * runs every day, and the list ended on a tip jar instead.
 *
 * The plan's own ❓ 16 named the gap: "`deskuptime status` has the buy line for
 * free users, but the daily list `watch --status` — run by the same user every
 * day — never mentions Pro", with the instruction to *measure the concrete
 * shortage first* and to keep it from selling in the footer of an all-green
 * list. This file is that measurement, run against the real CLI:
 *
 *   deskuptime watch --status     (3 of 3 free slots, real state file)
 *     📋 3 monitored URL(s):
 *       ✅ up  http://127.0.0.1:61001/ (200) …      ← three green rows
 *       ✅ up  http://127.0.0.1:61002/ (200) …
 *       ✅ up  http://127.0.0.1:61003/ (200) …
 *       That helped — thank you. …donate…            (exit 0)
 *
 * The `3` in the header *is* the whole free allowance, so the next
 * `deskuptime watch <url>` answers `Free tier monitors 3 URLs … not added`
 * with exit 1 — but the only place the ceiling was ever visible was that
 * refusal. The user learns they are full by being turned away, and the list
 * that answers "is my monitoring fine?" said yes, then asked for money.
 *
 * The fix is one line and one owner, `freeSlotsNote()` in `src/watch.js`, next
 * to the two Pro gates it must not contradict. Everything below is a local file
 * and the real CLI: no network, no loop, no timers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FREE, PRO, PRODUCT } from '../src/features.js';
import { freeLimitMessage, freeSlotsNote, getStateFile, monitoredCount } from '../src/watch.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const BUY = PRODUCT.buyUrl;
const DONATION = PRODUCT.donationUrl;

const A = 'https://kunde.dk/';
const B = 'https://kunde.dk/b/';
const C = 'https://kunde.dk/c/';

/** A site a real pass measured: 200, a page, nothing else claimed. */
function healthy(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    checks: 12,
    checksUp: 12,
    lastContentReadAt: new Date().toISOString(),
    lastHash: 'a'.repeat(64),
    lastContentLength: 4096,
    sslValidDays: 89,
    ...overrides,
  };
}

/** A license record the local reading puts *off* the free tier. */
const PRO_LICENSE = {
  key: '0123456789abcdef0123456789abcdef',
  instance: 'deskuptime-slots',
  plan: 'pro',
  status: 'active',
  validatedAt: new Date().toISOString(),
};

const urls = list => Object.fromEntries(list.map(url => [url, healthy()]));

function homeWith(t, state) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-slots-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 1, ...state }, null, 2));
  return { home, stateFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function list(env) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, 'watch', '--status'], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

// ───────────────────────────────────── den målte mangel, låst på den rigtige flade

test('tre af tre: listen siger at væggen er nået, før den næste URL afvises', async (t) => {
  const { env } = homeWith(t, { urls: urls([A, B, C]) });
  const { code, stdout } = await list(env);

  assert.equal(code, 0, 'en fyldt liste er ikke en fejl');
  assert.match(stdout, new RegExp(`all ${FREE.urlLimit} URL slots in use`),
    `listen fortæller ikke at alle ${FREE.urlLimit} pladser er brugt: ${stdout}`);
  // The line has to say what the ceiling *does*, not just that it is there: a
  // user who reads only this line must know the next `watch` is turned away.
  assert.match(stdout, /the next URL will not be added/,
    `linjen siger ikke hvad væggen gør: ${stdout}`);
  assert.ok(stdout.includes(BUY), `linjen peger ikke på købet: ${stdout}`);
});

test('under væggen: fakten står, men der er ingen købslinje (❓ 16s egen regel)', async (t) => {
  const { env } = homeWith(t, { urls: urls([A]) });
  const { stdout } = await list(env);

  assert.match(stdout, new RegExp(`Free tier: 1 of ${FREE.urlLimit} URL slots in use`),
    `listen fortæller ikke hvor mange pladser der er brugt: ${stdout}`);
  // "lad være med at sælge i footeren af en liste der er helt grøn" — a user with
  // room left is told the room, not sold to.
  assert.ok(!stdout.includes(BUY),
    `en liste med plads tilbage må ikke pege på købet: ${stdout}`);
});

test('Pro: ingen slot-linje overhovedet — en betalt kunde har ingen loft at blive fortalt om', async (t) => {
  const { env } = homeWith(t, { license: PRO_LICENSE, urls: urls([A, B, C]) });
  const { stdout } = await list(env);

  assert.match(stdout, /✅ up/, `listen skrev ikke sit svar: ${stdout}`);
  assert.ok(!/URL slots in use/.test(stdout),
    `en Pro-kunde fik en slot-væg, de ikke har: ${stdout}`);
  assert.ok(!stdout.includes(DONATION), `en Pro-kunde fik en taklinje: ${stdout}`);
});

// ───────────────────────────────────────── den tæller, der holder pladsen

test('tællingen er den der holder en plads, ikke antallet af rækker', async (t) => {
  // Three saved keys, two sites: the same site written with and without the
  // trailing slash — the form a browser's address bar shows, and the one a user
  // copies. `rows.length` is 3; the ceiling is enforced on 2.
  const { env } = homeWith(t, {
    urls: urls([A, A.replace(/\/$/, ''), B]),
  });
  const { stdout } = await list(env);

  assert.match(stdout, new RegExp(`Free tier: 2 of ${FREE.urlLimit} URL slots in use`),
    `listen tæller rækker i stedet for sites: ${stdout}`);
  assert.ok(!/all 3 URL slots/.test(stdout),
    `listen erklærede væggen nået på 2 af 3 pladser: ${stdout}`);
});

test('en gemt nøgle der ikke er en adresse holder ingen plads', async (t) => {
  // It prints as a row, and it can never be checked — so it must not be counted
  // against the three either, or the list would claim the wall is reached while
  // `deskuptime watch <url>` still accepts a third site.
  const { env } = homeWith(t, { urls: { ...urls([A, B]), 'kunde.dk': { checks: 1 } } });
  const { stdout } = await list(env);

  assert.match(stdout, /📋 3 monitored URL\(s\)/, `tre rækker forventes: ${stdout}`);
  assert.match(stdout, new RegExp(`Free tier: 2 of ${FREE.urlLimit} URL slots in use`),
    `en ubrugelig nøgle blev talt som en plads: ${stdout}`);
  assert.ok(!/all 3 URL slots/.test(stdout),
    `listen erklærede væggen nået på 2 af 3 pladser: ${stdout}`);
});

test('den samme tæller som væggen selv bruger', () => {
  // The line and the refusal are two surfaces; if they count differently the
  // list can say "2 of 3" an hour before the third URL is accepted.
  const state = { urls: urls([A, A.replace(/\/$/, ''), B, 'kunde.dk']) };
  assert.equal(monitoredCount(state), 2);
  assert.match(freeSlotsNote(monitoredCount(state)), new RegExp(`2 of ${FREE.urlLimit}`));
  assert.match(freeSlotsNote(FREE.urlLimit), new RegExp(`all ${FREE.urlLimit}`));
});

// ───────────────────────────────────── ejeren: én sætning, der ikke kan ligge

test('ejeren siger aldrig "grænsen" under den, og altid købslinket over den', () => {
  for (let used = 0; used < FREE.urlLimit; used++) {
    const line = freeSlotsNote(used);
    assert.ok(!line.includes(BUY), `ved ${used} af ${FREE.urlLimit} er der ingen grund til købslinket: ${line}`);
    assert.match(line, new RegExp(`^Free tier: ${used} of ${FREE.urlLimit} URL slots in use\\.$`));
  }
  const full = freeSlotsNote(FREE.urlLimit);
  assert.ok(full.includes(BUY), `på væggen peger linjen ikke på købet: ${full}`);
  assert.ok(full.includes('the next URL will not be added'),
    `på væggen siger linjen ikke hvad den gør: ${full}`);
});

test('væggen og afviselsen peger på det samme køb og den samme Pro-værdi', () => {
  // `freeLimitMessage()` is the refusal `deskuptime watch` prints. It and the
  // new line are two sentences about one ceiling, so they cannot name two
  // different ways to get past it.
  const note = freeSlotsNote(FREE.urlLimit);
  const refusal = freeLimitMessage(A);
  const value = `Pro unlocks unlimited URLs and a ${PRO.minIntervalSeconds}s interval`;
  for (const line of [note, refusal]) {
    assert.ok(line.includes(BUY), `linjen peger ikke på købet: ${line}`);
    assert.ok(line.includes(value), `linjen siger en anden Pro-værdi end den anden: ${line}`);
  }
});
