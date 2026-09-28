/**
 * P1-82: a saved key with a password in it is not a site, and the two free
 * terminal lists must say so on the row — not four lines below it.
 *
 * Measured 2026-09-28 with the real CLI, a real `state.json` in a temp HOME and
 * no HTTP at all: one key `http://demo:pass@kunde.dk/` carrying `wasUp: true`,
 * `lastStatus: 200`, `checks: 4` and a 512-byte content reading made one
 * command print two opposite claims about the same row.
 *
 *   Monitored URLs (1):
 *     ✅ http://kunde.dk/ (200) · 512 bytes
 *   ⚠️  Cannot be checked — not a site that is down: 1 saved URL has a username
 *       and a password in it … No monitored site could be checked on this pass.
 *
 * The `(200)` and the byte count belong to a pass that can never happen: P1-71
 * established that no request is ever sent to such an address, so those numbers
 * are whatever a hand-edited or botched-restored file happens to say. This is
 * P1-40's bug in the second form — a `kunde.dk` key was fixed in 2026-09-26 by
 * asking the one owner of "can a pass send a request here"; `readEntry()` kept
 * asking the older, weaker `isHttpUrl()`, which *accepts* a credentialed
 * address. The credentials rule arrived after the fix, and the half that reads
 * was not revisited.
 *
 * These tests are the same measurement, kept. The CLI is the real one, the
 * state file is real, and the license server is never written to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readEntry } from '../src/status.js';
import { buildReport } from '../src/report.js';
import { tempHome } from './helpers/env.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');
const KEY = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'hunter2-very-secret';
const CREDENTIALED = `http://demo:${PASSWORD}@kunde.dk/`;

/**
 * A key no pass may check, with every number a healthy site would have. The
 * numbers are the point: they are what a stale or hand-edited file holds, and
 * none of them is a measurement anything can make.
 */
const claimedHealthy = {
  addedAt: '2026-09-20T10:00:00.000Z',
  lastChecked: new Date().toISOString(),
  wasUp: true,
  lastStatus: 200,
  checks: 4,
  checksUp: 4,
  lastResponseMs: 12,
  lastContentLength: 512,
  lastContentReadAt: new Date().toISOString(),
};

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function withState(t, urls, { pro = true } = {}) {
  const { home, options, dir } = tempHome(t, 'deskuptime-credentialrow-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    version: 1,
    urls,
    ...(pro ? { license: { key: KEY, instance: 'p182', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() } } : {}),
  }, null, 2));
  return { home, options };
}

// ── The owner ──

test('a credentialed key has no verdict, whatever the state file claims', () => {
  const entry = readEntry(claimedHealthy, { url: CREDENTIALED });
  assert.equal(entry.verdict, 'unknown');
  assert.equal(entry.uncheckable, true);
  // The reason has to name the real cause. `kunde.dk` is not a full address;
  // `http://demo:pass@kunde.dk/` very much is — it is just one no pass may
  // send a request to — so the row may not borrow the other sentence.
  assert.match(entry.unknownNote, /username or password/);
  assert.doesNotMatch(entry.unknownNote, /not a full address/);
  assert.doesNotMatch(entry.unknownNote, new RegExp(PASSWORD));
});

test('the key that is not an address keeps the sentence it always had', () => {
  const entry = readEntry(claimedHealthy, { url: 'kunde.dk' });
  assert.equal(entry.verdict, 'unknown');
  assert.match(entry.unknownNote, /not a full address/);
});

test('an ordinary address is untouched by the stricter rule', () => {
  for (const url of ['https://kunde.dk/', 'http://kunde.dk:8080/x?y=1']) {
    const entry = readEntry(claimedHealthy, { url });
    assert.equal(entry.verdict, 'up', url);
    assert.equal(entry.uncheckable, false, url);
    // `unknownNote` is always filled — a readable time gives a note about being
    // readable — so the lock is on the one sentence a row must never carry.
    assert.doesNotMatch(entry.unknownNote, /no pass can check it/, url);
  }
  // A password that lives in the query or the path is not a credential in the
  // address — `fetch` sends those happily — so the row may claim a verdict.
  for (const url of ['https://kunde.dk/pw?pass=hunter2', 'https://kunde.dk/hunter2']) {
    assert.equal(readEntry(claimedHealthy, { url }).verdict, 'up', url);
  }
  // A user *name* is a credential too, even with no password beside it.
  assert.equal(readEntry(claimedHealthy, { url: 'https://kunde.dk@godt.dk/' }).verdict, 'unknown');
});

test('the row and the client report cannot disagree about the same key', () => {
  const report = buildReport({ urls: { [CREDENTIALED]: claimedHealthy } });
  const site = report.sites[0];
  assert.equal(site.status, 'unknown');
  assert.equal(site.uncheckable, true);
  // The report asked the strict rule all along (P1-40); the two free surfaces
  // did not. One reading, so this is a lock on the pair, not on either alone.
  assert.equal(readEntry(claimedHealthy, { url: CREDENTIALED }).verdict, site.status);
});

// ── The measured surfaces ──

test('deskuptime status does not call a credentialed key a healthy site', async (t) => {
  const { options } = withState(t, { [CREDENTIALED]: claimedHealthy });
  const { code, stdout } = await run(['status'], options);
  assert.equal(code, 0);
  // The row carries the reason, exactly as a `kunde.dk` row has since P1-40.
  assert.match(stdout, /· http:\/\/kunde\.dk\/ \(200\) — has a username or password in it/);
  assert.doesNotMatch(stdout, /^\s*✅ http:\/\/kunde\.dk\//m);
  assert.doesNotMatch(stdout, new RegExp(PASSWORD));
});

test('watch --status calls the same key unknown', async (t) => {
  const { options } = withState(t, { [CREDENTIALED]: claimedHealthy });
  const { code, stdout } = await run(['watch', '--status'], options);
  assert.equal(code, 0);
  assert.match(stdout, /❔ unknown\s+http:\/\/kunde\.dk\//);
  assert.doesNotMatch(stdout, /^\s*✅ up\s+http:\/\/kunde\.dk\//m);
  assert.doesNotMatch(stdout, new RegExp(PASSWORD));
});

test('a free user sees the same row, and the list still counts a real site', async (t) => {
  const { options } = withState(t, {
    [CREDENTIALED]: claimedHealthy,
    'https://godt.dk/': claimedHealthy,
  }, { pro: false });
  const { stdout } = await run(['status'], options);
  assert.doesNotMatch(stdout, /^\s*✅ http:\/\/kunde\.dk\//m);
  // One unusable key must not take a healthy neighbour down with it: that is
  // P1-40's rule, and it has to survive the stricter check.
  assert.match(stdout, /✅ https:\/\/godt\.dk\/ \(200\) · 512 bytes/);
  assert.match(stdout, /The other 1 monitored site was checked as usual/);
});

test('the report reads the same key as unknown, and never prints the password', async (t) => {
  const { options } = withState(t, { [CREDENTIALED]: claimedHealthy });
  const { code, stdout } = await run(['report', '--json'], options);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.sites[0].status, 'unknown');
  assert.equal(parsed.sites[0].uncheckable, true);
  assert.equal(parsed.sites[0].url, 'http://kunde.dk/');
  assert.doesNotMatch(stdout, new RegExp(PASSWORD));
});

test('the stricter rule is asked of the owner, not rebuilt beside it', () => {
  // A source scan, deliberately: the two rules differ by one call, both are
  // exported, both are imported into this file's subject module, and only the
  // behavioural tests above can tell which one the row asked. If a later
  // change reaches for the weaker one, this turns the gate red.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'status.js'), 'utf8');
  const body = source.slice(source.indexOf('export function readEntry('));
  const declaration = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.match(declaration, /const uncheckable = url !== '' && !isCheckableUrl\(url\);/);
  // The weaker rule is still a real function — `isCheckableUrl` is built on it
  // — it just may not decide what a row may claim.
  assert.doesNotMatch(declaration, /!isHttpUrl\(url\)/);
});
