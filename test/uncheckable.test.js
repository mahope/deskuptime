/**
 * P1-40: one saved key that is not an address must not take the whole pass
 * with it.
 *
 * Measured 2026-09-26 with the real CLI and a real `state.json` holding two
 * working sites and `kunde.dk`: `runPass()` validated every key before the first
 * request, so `new URL('kunde.dk')` threw `TypeError: Invalid URL: kunde.dk`,
 * the process exited 1 with empty stdout, and **neither** working site was
 * checked — on `deskuptime watch --once`, the documented cron path, where the
 * only trace is a stack trace in the cron mail. The tests below are the same
 * measurement, kept: the real CLI, a real state file in a temp HOME, and a
 * stubbed license API (test/fixtures/license-stub.mjs) so the license server is
 * never written to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invalidHttpUrls, partitionUsableUrls, readEntry, unusableUrlNote } from '../src/status.js';
import { monitoredCount, runPass } from '../src/watch.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-uncheckable-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

const entry = { addedAt: '2026-09-20T00:00:00.000Z', wasUp: true, sslWarned: false };
const license = { key: KEY, instance: 'p140', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };

function withState(t, urls, { pro = true } = {}) {
  const home = tempHome(t);
  writeFileSync(join(home.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    urls: Object.fromEntries(Object.entries(urls).map(([url, value]) => [url, { ...entry, ...value }])),
    ...(pro ? { license } : {}),
  }, null, 2));
  return home;
}

// One fixture server per test that needs real answers: 200 and 500 on loopback.
function fixtures(t) {
  const up = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>hej</title>hei</html>'); });
  const down = createServer((req, res) => { res.writeHead(500); res.end('nope'); });
  t.after(() => { up.close(); down.close(); });
  const listening = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return Promise.all([listening(up), listening(down)]).then(([a, b]) => ({ up: `http://127.0.0.1:${a}/`, down: `http://127.0.0.1:${b}/` }));
}

// ── The owner ──

test('one owner decides which keys can be checked', () => {
  const { usable, unusable } = partitionUsableUrls(['https://a.dk/', 'kunde.dk', 'http://b.dk', 'ftp://c.dk/', '']);
  assert.deepEqual(usable, ['https://a.dk/', 'http://b.dk']);
  assert.deepEqual(unusable, ['kunde.dk', 'ftp://c.dk/', '']);
  // One decision, asked everywhere: the partition is exactly what the strict
  // check rejects, so a key cannot pass here and be fatal there.
  assert.deepEqual(unusable, invalidHttpUrls(['https://a.dk/', 'kunde.dk', 'http://b.dk', 'ftp://c.dk/', '']));
});

test('the note names the key, denies nothing about the site, and gives the way out', () => {
  const note = unusableUrlNote(['kunde.dk'], { checked: 24 });
  assert.match(note, /kunde\.dk/);
  assert.match(note, /not a full address/);
  assert.match(note, /The other 24 monitored sites were checked as usual/);
  assert.match(note, /deskuptime unwatch 'kunde\.dk'/);
  // The one thing it must never do is claim a customer's site is down: we have
  // no reading of it at all, so the sentence denies it in those words.
  assert.match(note, /not a site that is down/);
  assert.doesNotMatch(note, /is down\b(?!:)/);
  assert.equal(unusableUrlNote(['a'], { checked: 0 }).includes('No monitored site could be checked'), true);
  assert.equal(unusableUrlNote(['a'], { brief: true }), 'not a full address, so no pass can check it');
});

// ── The pass ──

test('one unusable key does not stop the other sites from being checked', { timeout: 30000 }, async (t) => {
  const { up, down } = await fixtures(t);
  const home = withState(t, {
    [up]: { lastChecked: '2026-09-26T10:00:00.000Z', lastStatus: 200 },
    [down]: { wasUp: true, lastChecked: '2026-09-26T10:00:00.000Z', lastStatus: 200 },
    'kunde.dk': {},
  });

  const pass = await run(['watch', '--once'], { env: home });
  // The pass ran, and the DOWN site it found is the reason the exit code is 2.
  assert.equal(pass.code, 2, pass.stderr);
  assert.match(pass.stdout, /is DOWN — HTTP 500/);
  // The healthy site is silent in the output (only failures are printed), so the
  // proof that it was measured is in the state file: a fresh pass on it.
  const saved = JSON.parse(readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf8'));
  assert.equal(saved.urls[up].lastStatus, 200, 'the working site was not checked');
  assert.equal(saved.urls['kunde.dk'].lastChecked, undefined, 'the unusable key must not be measured or written to');
  // …and the unusable key is named, every pass, on the channel the cron mail
  // keeps. Not as a site that is down.
  assert.match(pass.stderr, /kunde\.dk/);
  assert.match(pass.stderr, /not a full address/);
  assert.doesNotMatch(pass.stderr, /TypeError|Invalid URL:/);
  // A second pass says it again: the state file still holds the key, and the
  // next cron run has to be able to see it too.
  const again = await run(['watch', '--once'], { env: home });
  assert.match(again.stderr, /kunde\.dk/);
});

test('a pass over nothing but unusable keys is not a healthy pass', async (t) => {
  const state = { urls: { 'kunde.dk': { wasUp: true } } };
  const seen = [];
  const pass = await runPass(state, {
    check: async url => { seen.push(url); return { healthy: true, url }; },
    returnResults: true,
    stateFile: join(tempHome(t).HOME, '.deskuptime', 'state.json'),
  });
  // `[].every()` is true, so a pass that measured nothing used to report itself
  // green — and a cron job would have had nothing to look at.
  assert.equal(pass.healthy, false);
  assert.deepEqual(seen, []);
});

// ── The list and the customer document ──

test('a key that cannot be checked is never shown as an up site', async (t) => {
  const home = withState(t, {
    'https://godt.dk/': { lastChecked: new Date().toISOString(), lastStatus: 200 },
    // A stored `wasUp: true` that no pass can ever confirm: the file says it,
    // the tool cannot measure it, so it must not be printed as a healthy site.
    'kunde.dk': { lastChecked: new Date().toISOString(), lastStatus: 200 },
  });

  for (const args of [['status'], ['watch', '--status']]) {
    const r = await run(args, { env: home });
    const row = r.stdout.split('\n').find(line => line.includes('kunde.dk'));
    assert.equal(/✅|🚨 up/.test(row), false, `${args[0]} claimed a key it cannot check is a site: ${row}`);
    assert.match(r.stdout, /not a full address/);
  }
});

test('the client report names the key apart from the sites', async (t) => {
  const home = withState(t, {
    'https://godt.dk/': { lastChecked: new Date().toISOString(), lastStatus: 200, uptimeTotal: 10, uptimeFailures: 0 },
    'kunde.dk': { wasUp: true, lastChecked: new Date().toISOString(), lastStatus: 200 },
  });
  const r = await run(['report', '--json'], { env: home });
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.uncheckable, 1);
  // Additive: every key the summary had before is still there with the same
  // meaning, and the site count is unchanged — the row stays, it is only named.
  assert.equal(report.summary.sites, 2);
  assert.equal(report.sites.find(site => site.url === 'kunde.dk').status, 'unknown');
  assert.equal(report.sites.find(site => site.url === 'kunde.dk').uncheckable, true);

  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /not a full address/);
  assert.match(markdown, /1 not a full address/);
  assert.doesNotMatch(markdown, /kunde\.dk \| UP/);
});

test('a saved key that cannot be checked does not hold a free slot', async (t) => {
  // The free tier has three slots. A key no pass can check used to take one of
  // them, and the only way to get it back was to hand-edit `state.json` — the
  // file that also holds the license key.
  const state = { urls: { 'https://a.dk/': {}, 'https://b.dk/': {}, 'kunde.dk': {} } };
  assert.equal(monitoredCount(state), 2);
  const home = withState(t, state.urls, { pro: false });
  const r = await run(['watch', 'https://c.dk/', '--once'], { env: home });
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf8'));
  assert.ok(saved.urls['https://c.dk/'], 'the third slot is free again');
});

test('unwatch can remove a key that is not an address', { timeout: 30000 }, async (t) => {
  const home = withState(t, { 'https://a.dk/': {}, 'kunde.dk': {} });
  const r = await run(['unwatch', 'kunde.dk'], { env: home });
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.urls), ['https://a.dk/']);
  // A typo that is not in the file is still a typo.
  const typo = await run(['unwatch', 'kunde.dkk'], { env: home });
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /Invalid URL/);
});

test('an unusable key does not change a healthy pass or a valid list', async (t) => {
  // The no-change guarantee, measured: same state without the broken key, same
  // exit codes, same rows, and no note anywhere.
  const { up, down } = await fixtures(t);
  for (const urls of [{ [up]: {}, [down]: { wasUp: true, lastChecked: '2026-09-26T10:00:00.000Z', lastStatus: 200 } }]) {
    const home = withState(t, urls);
    const pass = await run(['watch', '--once'], { env: home });
    assert.equal(pass.code, 2, pass.stderr);
    assert.doesNotMatch(pass.stderr, /not a full address/);
    const status = await run(['watch', '--status'], { env: home });
    assert.doesNotMatch(status.stdout, /not a full address/);
    const report = await run(['report', '--json'], { env: home });
    assert.equal(JSON.parse(report.stdout).summary.uncheckable, 0);
  }
  // readEntry without a url is untouched: it has no key to judge.
  assert.equal(readEntry({ wasUp: true, lastChecked: new Date().toISOString() }).verdict, 'up');
  assert.equal(readEntry({ wasUp: true }, { url: 'kunde.dk' }).verdict, 'unknown');
});
