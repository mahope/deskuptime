/**
 * report.js — the client report an agency sends to a customer.
 *
 * The tests below are the guarantees that make the report sellable:
 *   - uptime is the share of UP passes, and no data means "—", never 100%;
 *   - the counters are written by the real watch pass, not by hand;
 *   - a hostile URL cannot break the Markdown table or become markup;
 *   - the stored license key can never reach a file that leaves the machine;
 *   - a free user gets one honest answer with the buy link, not a stack trace.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, counters, nonNegative, recordPass, renderReportJson, renderReportMarkdown, siteBuckets, uptimePercent } from '../src/report.js';
import { readEntry, readResponseMs, verdictFor } from '../src/status.js';
import { checkReachability } from '../src/checkers/ping.js';
import { loadState, runPass } from '../src/watch.js';
import { PRODUCT } from '../src/features.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-09-25T09:30:00.000Z');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-report-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeState(home, state) {
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify(state));
  return home;
}

function proState(urls) {
  // A real activated license always carries the timestamp of the check that
  // activated it (`refreshLicense` bumps `validatedAt` on every verdict). A
  // record without one has never been confirmed, and `describeLicense` says so
  // rather than letting the stored word `active` speak for it — see P1-18.
  return {
    license: {
      key: LICENSE_KEY,
      instance: 'deskuptime-agency',
      plan: 'pro',
      status: 'active',
      validatedAt: new Date().toISOString(),
    },
    urls,
  };
}

function upEntry(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: '2026-09-25T09:00:00.000Z',
    addedAt: '2026-08-01T00:00:00.000Z',
    checks: 100,
    checksUp: 100,
    lastResponseMs: 142,
    sslValidDays: 78,
    ...overrides,
  };
}

function rows(markdown) {
  return markdown.split('\n').filter(line => line.startsWith('| ') && !line.includes('---') && !line.startsWith('| Site '));
}

test('uptime is the share of UP passes, and no data is never 100%', () => {
  assert.equal(uptimePercent({ checks: 0 }), null);
  assert.equal(uptimePercent({}), null);
  assert.equal(uptimePercent({ checks: 4, checksUp: 3 }), 75);
  assert.equal(uptimePercent({ checks: 2880, checksUp: 2879 }), 99.97);
  // A hand-edited or half-written state file must not produce NaN in a report.
  assert.equal(uptimePercent({ checks: 'many', checksUp: null }), null);
  // A negative counter is unusable data, not 0% uptime.
  assert.equal(uptimePercent({ checks: -3, checksUp: 9 }), null);
  // More UP passes than passes is not a site that is more than up. A state file
  // edited by hand, restored from a backup or written by another tool must not
  // produce a number above 100 % in a document a customer reads.
  assert.equal(uptimePercent({ checks: 2, checksUp: 5 }), 100);
  assert.equal(uptimePercent({ checks: 2880, checksUp: 99999 }), 100);
  for (const entry of [{ checks: 2, checksUp: 5 }, { checks: 0, checksUp: 9 }, { checks: 'many', checksUp: 9 }, { checks: 5, checksUp: -2 }]) {
    const { checks, checksUp, failures } = counters(entry);
    assert.ok(checksUp <= checks, `${JSON.stringify(entry)} has more UP passes than passes`);
    assert.ok(failures >= 0, `${JSON.stringify(entry)} has negative failures`);
  }
});

test('recordPass repairs a state file whose counters are out of step', () => {
  // checksUp above checks: the old code incremented both counters and kept the
  // skew forever, so the report claimed 250 % uptime and a negative number of
  // failures. One pass must bring the entry back to a state that can be true.
  const entry = { checks: 5, checksUp: 9 };
  const pass = recordPass(entry, { healthy: false });
  assert.deepEqual(pass, { checks: 6, failures: 1 });
  assert.ok(entry.checksUp <= entry.checks, 'the entry is left consistent');
  assert.equal(uptimePercent(entry), 83.33);

  // A skewed entry followed by an UP pass is capped too — checksUp can never be
  // pushed above the passes that actually ran.
  recordPass(entry, { healthy: true });
  recordPass(entry, { healthy: true });
  assert.ok(entry.checksUp <= entry.checks, 'repeated passes keep it consistent');
  assert.ok(counters(entry).failures >= 0);

  // A healthy first pass on a skewed entry is 100 %, not more.
  const healed = { checks: 4, checksUp: 40 };
  recordPass(healed, { healthy: true });
  assert.deepEqual(counters(healed), { checks: 5, checksUp: 5, failures: 0 });
  assert.equal(uptimePercent(healed), 100);
});

test('recordPass counts every pass and only the UP ones', () => {
  const entry = {};
  assert.deepEqual(recordPass(entry, { healthy: true, responseTimeMs: 120 }), { checks: 1, failures: 0 });
  recordPass(entry, { healthy: false });
  const third = recordPass(entry, { healthy: true });
  assert.deepEqual(third, { checks: 3, failures: 1 });
  assert.equal(entry.lastResponseMs, 120, 'a pass without a response time keeps the last known one');
  // Existing state from before this feature has no counters at all.
  const legacy = { wasUp: true };
  assert.deepEqual(recordPass(legacy, { healthy: true }), { checks: 1, failures: 0 });
});

test('the real watch pass writes the counters the report reads', async (t) => {
  const home = tempHome(t);
  const options = { env: { HOME: home, USERPROFILE: home } };
  const url = 'https://acme.dk/';
  let state = { urls: { [url]: { addedAt: '2026-08-01T00:00:00.000Z' } } };
  const responses = [true, false, true, true];

  for (const healthy of responses) {
    await runPass(state, {
      ...options,
      check: async () => ({
        healthy,
        reachable: healthy,
        statusCode: healthy ? 200 : 503,
        responseTimeMs: 100,
        timestamp: NOW.toISOString(),
        ssl: { validDays: 40 },
        content: null,
      }),
      returnResults: true,
    });
    state = loadState(options);
  }

  assert.equal(state.urls[url].checks, 4);
  assert.equal(state.urls[url].checksUp, 3);
  const built = buildReport(state, { now: NOW });
  assert.equal(built.sites.length, 1);
  assert.equal(built.sites[0].uptimePercent, 75);
  assert.equal(built.sites[0].failures, 1);
  assert.equal(built.sites[0].sslDaysRemaining, 40);
  assert.equal(built.summary.failures, 1);
});

test('the report puts problems first and states its own data honestly', () => {
  const markdown = renderReportMarkdown(buildReport({
    urls: {
      'https://ok.dk/': upEntry(),
      'https://down.dk/': upEntry({ wasUp: false, lastStatus: 503, checks: 10, checksUp: 8 }),
      'https://new.dk/': { addedAt: '2026-09-25T09:00:00.000Z' },
    },
  }, { title: 'Acme — September', now: NOW }));
  const table = rows(markdown);
  assert.equal(table.length, 3);
  assert.ok(table[0].includes('https://down.dk/'), 'the DOWN site must open the report');
  assert.ok(table[1].includes('https://new.dk/'));
  assert.ok(table[2].includes('https://ok.dk/'));
  assert.ok(markdown.includes('# Acme — September'));
  assert.ok(markdown.includes('80% (10 checks, 2 failed)'), markdown);
  assert.ok(markdown.includes('— (no completed pass)'), 'a site without a pass must not read as 100%');
  assert.ok(markdown.includes('142 ms') && markdown.includes('78 d'));
  assert.ok(markdown.includes('2026-09-25 09:00 UTC'), markdown);
  // The line is a partition now, so the never-checked site is a number and not
  // a row that belongs to nothing: 1 up + 1 down + 1 not checked = 3 sites.
  assert.ok(markdown.includes('3 site(s) · 1 up · 1 down · 1 not checked · 110 checks · 2 failed'), markdown);
  assert.ok(markdown.includes('nothing was uploaded'));
});

test('a hostile URL cannot break the table or turn into markup', () => {
  const hostile = 'https://evil.dk/?a=1|b=<script>alert(1)</script>\n| fake | row |';
  const markdown = renderReportMarkdown(buildReport({
    urls: { [hostile]: upEntry({ lastResponseMs: null, sslValidDays: null }) },
  }, { now: NOW }));
  const table = rows(markdown);
  assert.equal(table.length, 1, `a URL with pipes and newlines produced ${table.length} rows`);
  // Seven columns means six unescaped pipes; every pipe from the URL is escaped.
  assert.equal(table[0].split(/(?<!\\)\|/).length, 9);
  assert.ok(!markdown.includes('<script>'), 'the URL was not escaped and can become markup');
  assert.ok(markdown.includes('&lt;script&gt;'));
  // No response time or SSL day is invented for a pass that never ran.
  assert.ok(markdown.includes('| — | — |'), markdown);
});

test('the license record can never reach the report', () => {
  const built = buildReport(proState({ 'https://acme.dk/': upEntry() }), { now: NOW });
  const markdown = renderReportMarkdown(built);
  const json = renderReportJson(built);
  for (const text of [markdown, json]) {
    assert.ok(!text.includes(LICENSE_KEY), 'the license key leaked into the report');
    assert.ok(!text.includes('device_id') && !text.includes('deskuptime-agency'), 'machine identity leaked');
    assert.ok(!text.includes('instance'));
  }
  // The field set is pinned, so a new one has to be a decision rather than a
  // side effect. `partition` is the disjoint split `summary` overlaps with, so
  // `--json` can say what the customer line says.
  assert.deepEqual(Object.keys(built).sort(), ['generatedAt', 'partition', 'sites', 'summary', 'title', 'tool', 'windowDays']);
  assert.deepEqual(Object.keys(built.partition).sort(), ['down', 'neverChecked', 'stale', 'unknown', 'up']);
  for (const site of built.sites) {
    for (const key of Object.keys(site)) {
      assert.ok(!/license|key|instance|hash/i.test(key), `unexpected report field: ${key}`);
    }
  }
});

test('--json is pure JSON and carries the same numbers as the table', () => {
  const built = buildReport({ urls: { 'https://acme.dk/': upEntry() } }, { now: NOW });
  const parsed = JSON.parse(renderReportJson(built));
  assert.equal(parsed.sites[0].uptimePercent, 100);
  assert.equal(parsed.sites[0].checks, 100);
  assert.equal(parsed.sites[0].status, 'up');
  assert.equal(parsed.sites[0].url, 'https://acme.dk/');
});

test('a free user gets one honest answer with the buy link, and no report', async (t) => {
  const home = writeState(tempHome(t), { urls: { 'https://acme.dk/': upEntry() } });
  const error = await run(process.execPath, [CLI, 'report'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  }).then(() => null, err => err);
  assert.ok(error, 'report worked without a license');
  assert.equal(error.code, 1);
  assert.match(error.stderr, /needs an active Pro license/);
  assert.ok(error.stderr.includes(PRODUCT.buyUrl), `no way to buy: ${error.stderr}`);
  assert.equal(error.stdout, '', 'a report was printed for a free user');
});

test('an unverified or rejected key does not get a report either', async (t) => {
  for (const status of ['unverified', 'invalid']) {
    const home = writeState(tempHome(t), proState({ 'https://acme.dk/': upEntry() }));
    const state = JSON.parse(readFileSync(join(home, '.deskuptime', 'state.json'), 'utf8'));
    state.license.status = status;
    writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify(state));
    const error = await run(process.execPath, [CLI, 'report'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }).then(() => null, err => err);
    assert.ok(error, `a ${status} key got a report`);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /deskuptime activate <license-key>/, error.stderr);
    assert.equal(error.stdout, '', `a report was printed for a ${status} key`);
    if (status === 'unverified') {
      // A key the server never judged must not be answered with the checkout:
      // that is the double-purchase trap, and `deskuptime status` already gets
      // it right for the very same state.
      assert.doesNotMatch(error.stderr, /buy\.stripe\.com/, `a paying customer saw a checkout link: ${error.stderr}`);
    } else {
      // Rejected keys may mention the checkout, but only as "if you have not bought".
      assert.match(error.stderr, /If you have not bought yet/);
    }
  }
});

test('the report gate tells a paid-but-unverified customer the same thing as status', async (t) => {
  const license = { key: LICENSE_KEY, instance: 'deskuptime-agency', plan: 'pro', status: 'unverified', validatedAt: '2026-09-15T09:00:00.000Z' };
  const home = writeState(tempHome(t), { license, urls: { 'https://acme.dk/': upEntry() } });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const runCli = (args) => run(process.execPath, [CLI, ...args], { env }).then(
    ({ stdout, stderr }) => ({ stdout, stderr }),
    error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
  );

  const status = await runCli(['status']);
  const report = await runCli(['report']);
  assert.equal(report.code, 1);
  // `status` writes the license state to stdout, the report gate to stderr, so
  // both are read as one text — the customer reads one message either way.
  for (const [name, surface] of [['status', status], ['report', report]]) {
    const said = `${surface.stdout}${surface.stderr}`;
    assert.match(said, /unverified/, `${name}: ${said}`);
    assert.match(said, /deskuptime activate <license-key>/, `${name}: ${said}`);
    assert.doesNotMatch(said, /buy\.stripe\.com/, `checkout link in ${name}: ${said}`);
  }
});

test('a Pro customer gets a report, with the title it asked for', async (t) => {
  const home = writeState(tempHome(t), proState({
    'https://acme.dk/': upEntry(),
    'https://shop.dk/': upEntry({ wasUp: false, lastStatus: 500, checks: 50, checksUp: 49 }),
  }));
  const { stdout } = await run(process.execPath, [CLI, 'report', '--title', 'Acme — September 2026'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.match(stdout, /^# Acme — September 2026/);
  assert.ok(stdout.includes('https://shop.dk/'));
  assert.ok(stdout.includes('DOWN (500)'));
  assert.ok(!stdout.includes(LICENSE_KEY));
});

test('--json, an empty state and a broken title are answered, not crashed on', async (t) => {
  const home = writeState(tempHome(t), proState({ 'https://acme.dk/': upEntry() }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const json = await run(process.execPath, [CLI, 'report', '--json'], { env });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.sites.length, 1);
  assert.equal(parsed.title, 'Website uptime report');
  assert.match(parsed.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const emptyHome = writeState(tempHome(t), proState({}));
  const empty = await run(process.execPath, [CLI, 'report'], { env: { ...env, HOME: emptyHome, USERPROFILE: emptyHome } })
    .then(() => null, err => err);
  assert.ok(empty, 'an empty state produced a report');
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /No monitored URLs/);

  for (const bad of [['--title'], ['--title', '--json'], ['--nope'], ['https://acme.dk/']]) {
    const failed = await run(process.execPath, [CLI, 'report', ...bad], { env }).then(() => null, err => err);
    assert.ok(failed, `report accepted ${bad.join(' ')}`);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
  }
});

test('a long or multi-line title is flattened to one short line', () => {
  assert.equal(buildReport({ urls: {} }, { title: '  Acme\n\n  DK  ' }).title, 'Acme DK');
  assert.equal(buildReport({ urls: {} }, { title: 'x'.repeat(300) }).title.length, 120);
  assert.equal(buildReport({ urls: {} }, { title: '   ' }).title, 'Website uptime report');
});

// ── SSL expiry is a warning the client can act on, not a bare number ──
//
// `check` and `watch` have warned inside the 14-day window since early on,
// hardcoded in two different files. The report had no threshold at all, so the
// one surface a bureau forwards to its customer was the one that could not say
// "renew this certificate". These tests lock all three to the same window.

test('a certificate inside the warning window is marked, one day later is not', () => {
  const build = days => buildReport(
    proState({ 'https://acme.dk/': upEntry({ sslValidDays: days }) }),
    { now: NOW },
  );

  const at14 = build(14);
  assert.equal(at14.sites[0].sslExpiringSoon, true);
  assert.equal(at14.summary.sslExpiringSoon, 1);
  assert.match(renderReportMarkdown(at14), /⚠️ 14 d — renew soon/);
  assert.match(renderReportMarkdown(at14), /renewal needed:\*\* https:\/\/acme\.dk\/ \(14 d\)/);

  const at15 = build(15);
  assert.equal(at15.sites[0].sslExpiringSoon, false);
  assert.equal(at15.summary.sslExpiringSoon, 0);
  const markdown = renderReportMarkdown(at15);
  assert.match(markdown, /\| 15 d \|/);
  assert.doesNotMatch(markdown, /renew soon/);
  assert.doesNotMatch(markdown, /renewal needed/);
  assert.doesNotMatch(markdown, /SSL expiring soon/);

  // A site with no known expiry is not an urgent one, and a hostile number in
  // a hand-edited state file cannot invent a warning either. `null` and not
  // `false` (P1-22): the claim is "no certificate was read", which is what the
  // dashboard forwards — `false` said "read, and it is not expiring". Both stay
  // out of the renewal count, and `false` is not asserted anywhere here.
  for (const bogus of [null, undefined, -3, NaN, '9', Infinity]) {
    const site = buildReport(proState({ 'https://acme.dk/': upEntry({ sslValidDays: bogus }) }), { now: NOW }).sites[0];
    assert.equal(site.sslExpiringSoon, null, `${bogus} must not claim a renewal window`);
    assert.equal(site.sslDaysRemaining, null);
    assert.equal(buildReport(proState({ 'https://acme.dk/': upEntry({ sslValidDays: bogus }) }), { now: NOW }).summary.sslExpiringSoon, 0);
  }
  assert.match(renderReportMarkdown(buildReport(proState({ 'https://acme.dk/': upEntry({ sslValidDays: null }) }), { now: NOW })), /\| — \|/);
});

test('every site that needs renewing is named, and the JSON agrees with the text', () => {
  const report = buildReport(proState({
    'https://acme.dk/': upEntry({ sslValidDays: 3 }),
    'https://shop.dk/': upEntry({ sslValidDays: 9 }),
    'https://blog.dk/': upEntry({ sslValidDays: 200 }),
    'https://plain.dk/': upEntry(),
  }), { now: NOW });

  assert.equal(report.summary.sslExpiringSoon, 2);
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /2 SSL expiring soon/);
  const named = markdown.split('renewal needed:**')[1].split('\n')[0];
  assert.match(named, /https:\/\/acme\.dk\/ \(3 d\)/);
  assert.match(named, /https:\/\/shop\.dk\/ \(9 d\)/);
  assert.doesNotMatch(named, /blog\.dk/);
  assert.doesNotMatch(named, /plain\.dk/);

  const json = JSON.parse(renderReportJson(report));
  assert.equal(json.summary.sslExpiringSoon, 2);
  assert.deepEqual(
    json.sites.filter(site => site.sslExpiringSoon).map(site => site.url),
    ['https://acme.dk/', 'https://shop.dk/'],
  );
});

test('a report can never claim more than 100 % uptime or a negative failure', () => {
  const report = buildReport(proState({
    'https://acme.dk/': upEntry({ checks: 2, checksUp: 5 }),
    'https://shop.dk/': upEntry({ wasUp: false, lastStatus: 503, checks: 50, checksUp: 49 }),
  }), { now: NOW });

  // Problems first, so the skewed site is looked up by URL, not by index.
  const byUrl = Object.fromEntries(report.sites.map(site => [site.url, site]));
  assert.equal(byUrl['https://acme.dk/'].uptimePercent, 100);
  assert.equal(byUrl['https://acme.dk/'].failures, 0);
  assert.equal(byUrl['https://shop.dk/'].uptimePercent, 98);
  assert.equal(report.summary.failures, 1);
  assert.equal(report.summary.checks, 52);

  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /250 ?%/);
  assert.doesNotMatch(markdown, /-2 failed|-1 failed/);
  assert.match(markdown, /\| 100% \(2 checks\) \|/);
  assert.match(markdown, /1 failed\*\*/);

  const json = JSON.parse(renderReportJson(report));
  for (const site of json.sites) {
    assert.ok(site.uptimePercent === null || (site.uptimePercent >= 0 && site.uptimePercent <= 100), `${site.url} is outside 0–100 %`);
    assert.ok(site.failures >= 0, `${site.url} has negative failures`);
  }
  assert.ok(json.summary.failures >= 0);
});

test('a real watch pass writes consistent counters back to a skewed state file', async (t) => {
  const home = tempHome(t);
  const options = { env: { HOME: home, USERPROFILE: home } };
  const url = 'https://acme.dk/';
  writeState(home, { urls: { [url]: { ...upEntry({ checks: 5, checksUp: 9 }) } } });

  // Before a pass runs, the report on disk is clamped — it never prints the
  // skew it finds.
  const before = buildReport(loadState(options), { now: NOW });
  assert.equal(before.sites[0].uptimePercent, 100);
  assert.equal(before.sites[0].failures, 0);

  await runPass(loadState(options), {
    ...options,
    now: NOW,
    returnResults: true,
    check: async () => ({
      healthy: false,
      reachable: false,
      statusCode: 503,
      responseTimeMs: 90,
      timestamp: NOW.toISOString(),
      ssl: { validDays: 40 },
      content: null,
    }),
  });

  // The repair is persisted, so later reports — and the file itself — stay true.
  const entry = loadState(options).urls[url];
  assert.equal(entry.checks, 6);
  assert.equal(entry.checksUp, 5);
  const after = buildReport(loadState(options), { now: NOW });
  assert.equal(after.sites[0].uptimePercent, 83.33);
  assert.equal(after.sites[0].failures, 1);
  assert.equal(after.summary.failures, 1);
});

test('the report, check and watch share one expiry threshold', async () => {
  const { summarize } = await import('../src/engine.js');
  const { runPass: runWatchPass, loadState: loadWatchState } = await import('../src/watch.js');

  // summarize() — the `check` surface.
  const ssl = days => ({ validDays: days });
  assert.match(summarize({ healthy: true, url: 'https://acme.dk/', ssl: ssl(14) }).ssl, /⚠️$/);
  assert.match(summarize({ healthy: true, url: 'https://acme.dk/', ssl: ssl(15) }).ssl, /✅$/);

  // The latched watch event — the same window, so a certificate cannot warn in
  // one surface and read as routine in another.
  const warned = async days => {
    const home = mkdtempSync(join(tmpdir(), 'deskuptime-ssl-'));
    try {
      await runWatchPass(
        { urls: { 'https://acme.dk/': { wasUp: true, sslWarned: false } } },
        { stateFile: join(home, 'state.json'), now: NOW, returnResults: true, check: async () => ({ healthy: true, ssl: { validDays: days }, statusCode: 200, responseTimeMs: 10, timestamp: NOW.toISOString() }) },
      );
      return JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).urls['https://acme.dk/'].sslWarned;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
  assert.equal(await warned(14), true);
  assert.equal(await warned(15), false);
  assert.ok(loadWatchState, 'watch state loader is available');
});

test('staleness has one definition, and only old data is stale', async () => {
  const { STALE_AFTER_DAYS, checkAgeDays, isCheckStale } = await import('../src/status.js');
  const at = (iso, now = NOW) => isCheckStale(iso, now);
  const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(STALE_AFTER_DAYS, 2);
  assert.equal(at(daysAgo(0)), false, 'a pass from this second is current');
  assert.equal(at(daysAgo(1.99)), false, 'a daily cron must not cry wolf');
  assert.equal(at(daysAgo(STALE_AFTER_DAYS)), false, 'exactly at the window is still current');
  assert.equal(at(daysAgo(STALE_AFTER_DAYS + 0.01)), true);
  assert.equal(at(daysAgo(41)), true);

  // No pass at all is not stale — the report already says "not checked yet", and
  // flagging it twice would say nothing new.
  assert.equal(at(undefined), false);
  assert.equal(at(''), false);
  assert.equal(at(null), false);
  // A pass that ran, at a time we cannot read, is stale: we cannot show that the
  // data is current, which is what a client report must never assume.
  assert.equal(at('not-a-date'), true);
  // Clock skew is not old data. The exact timestamp is printed either way.
  assert.equal(at(new Date(NOW.getTime() + 60 * 1000).toISOString()), false);

  assert.equal(checkAgeDays(daysAgo(41.9), NOW), 41, 'whole days, floored, never negative');
  assert.equal(checkAgeDays('not-a-date', NOW), null);
  assert.equal(checkAgeDays(new Date(NOW.getTime() - 60 * 1000).toISOString(), NOW), 0);
  assert.equal(checkAgeDays(undefined, NOW), null);
});

test('a report does not present a dead monitoring loop as current health', async () => {
  const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
  const report = buildReport(proState({
    'https://acme.dk/': upEntry({ lastChecked: daysAgo(41) }),
    'https://shop.dk/': upEntry(),
  }), { now: NOW });

  const byUrl = Object.fromEntries(report.sites.map(site => [site.url, site]));
  // The observed result is not rewritten — the pass really did answer 200 — but
  // it is not presented as current either.
  assert.equal(byUrl['https://acme.dk/'].status, 'up');
  assert.equal(byUrl['https://acme.dk/'].stale, true);
  assert.equal(byUrl['https://acme.dk/'].ageDays, 41);
  assert.equal(byUrl['https://shop.dk/'].stale, false);
  assert.equal(byUrl['https://shop.dk/'].ageDays, 0);

  // The headline number is the claim a client reads: a stale pass is not "up".
  assert.equal(report.summary.stale, 1);
  assert.equal(report.summary.up, 1);

  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /UP \(200\) ⚠️ stale — last check 41 d ago/);
  assert.match(markdown, /1 stale \(no check in the last 2 d\)/);
  assert.match(markdown, /\*\*Monitoring data is stale for 1 site — no pass in the last 2 days:\*\* https:\/\/acme\.dk\/ \(41 d\)/);
  assert.doesNotMatch(markdown, /2 up/, 'the stale site must not be counted as up');

  const json = JSON.parse(renderReportJson(report));
  assert.equal(json.summary.up, 1);
  assert.equal(json.summary.stale, 1);
  assert.equal(json.sites.find(site => site.url === 'https://acme.dk/').stale, true);
  assert.equal(json.sites.find(site => site.url === 'https://shop.dk/').stale, false);
});

test('a fresh report is unchanged, and a site that was never checked is not stale', () => {
  const report = buildReport(proState({
    'https://ok.dk/': upEntry(),
    'https://new.dk/': { addedAt: '2026-09-25T09:00:00.000Z' },
  }), { now: NOW });
  assert.equal(report.summary.stale, 0);
  assert.equal(report.summary.up, 1);
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /⚠️ stale/, 'no site may be flagged when every pass is current');
  assert.doesNotMatch(markdown, /· \d+ stale/, 'the summary must not claim stale data');
  assert.doesNotMatch(markdown, /not checked yet.*stale/);
  // A site whose last pass was DOWN stays visible as down, stale or not — a
  // customer must still see it.
  const down = buildReport(proState({
    'https://down.dk/': upEntry({ wasUp: false, lastStatus: 503, lastChecked: '2026-01-01T00:00:00.000Z' }),
  }), { now: NOW });
  assert.equal(down.summary.down, 1);
  assert.equal(down.summary.stale, 1);
  assert.match(renderReportMarkdown(down), /DOWN \(503\) ⚠️ stale/);
});

test('the CLI marks a stopped watch loop stale, from a real state file', async (t) => {
  const home = tempHome(t);
  const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  writeState(home, proState({
    'https://acme.dk/': upEntry({ lastChecked: daysAgo(42) }),
    'https://shop.dk/': upEntry(),
  }));

  const { stdout } = await run(process.execPath, [CLI, 'report'], { env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.match(stdout, /stale/, stdout);
  assert.match(stdout, /1 stale \(no check in the last 2 d\)/, stdout);
  assert.doesNotMatch(stdout, /2 up/, stdout);

  const { stdout: jsonOut } = await run(process.execPath, [CLI, 'report', '--json'], { env: { ...process.env, HOME: home, USERPROFILE: home } });
  const json = JSON.parse(jsonOut);
  assert.equal(json.summary.stale, 1);
  assert.equal(json.summary.up, 1);
  assert.equal(json.sites.find(site => site.url === 'https://acme.dk/').ageDays, 42);
});

/**
 * A measured quantity, or `null`.
 *
 * The report is the one document an agency forwards to a customer, so a value
 * we cannot read must leave as `—` and nothing else. `Number.isFinite` alone
 * let a negative through, and a state file can hold one (hand-edited,
 * restored, written by another tool). Measured on a real report:
 *
 *   `| https://a.test | UP | 75% (4 checks) | -5 ms | 30 d |`   ← Response column
 *   `"contentBytes": -999`                                       ← --json
 *
 * `lastResponseMs: -5` is not a site that answered in five negative
 * milliseconds. It is a value we cannot read, and the sibling cells already
 * had the honest answer for that.
 */
const UNREADABLE_MEASUREMENTS = [-5, -999, NaN, null, undefined, '42', Infinity, -Infinity];

test('nonNegative is a measurement or null, never a negative', () => {
  assert.equal(nonNegative(0), 0, 'a measured zero is a measurement, not an absence');
  assert.equal(nonNegative(1234), 1234);
  for (const value of UNREADABLE_MEASUREMENTS) {
    assert.equal(nonNegative(value), null, `${String(value)} must not be reported as a measurement`);
  }
});

test('the client report never prints a negative response time or byte count', () => {
  const state = proState({
    'https://kunde.dk/': { wasUp: true, lastStatus: 200, checks: 4, checksUp: 3, lastChecked: NOW.toISOString(), lastResponseMs: -5, lastContentLength: -999 },
  });
  const report = buildReport(state, { now: NOW });
  const site = report.sites.find(s => s.url === 'https://kunde.dk/');
  assert.equal(site.responseMs, null);
  assert.equal(site.contentBytes, null);

  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /-5 ms/, 'the Response column must not carry a negative duration');
  assert.doesNotMatch(markdown, /-999/, 'no negative byte count in a document a bureau forwards');
  assert.match(markdown, /\| — \|/, 'the cell falls back to the same — the sibling cells use');

  const json = JSON.parse(renderReportJson(report));
  const jsonSite = json.sites.find(s => s.url === 'https://kunde.dk/');
  assert.equal(jsonSite.responseMs, null);
  assert.equal(jsonSite.contentBytes, null);
});

test('a real measurement still reaches the report unchanged', () => {
  // The point of the fix is the negative value, not the whole column: a report
  // that dropped every number would be as useless as one that invented them.
  const state = proState({
    'https://kunde.dk/': { wasUp: true, lastStatus: 200, checks: 4, checksUp: 3, lastChecked: NOW.toISOString(), lastResponseMs: 187, lastContentLength: 20480 },
  });
  const site = buildReport(state, { now: NOW }).sites[0];
  assert.equal(site.responseMs, 187);
  assert.equal(site.contentBytes, 20480);
  assert.match(renderReportMarkdown(buildReport(state, { now: NOW })), /187 ms/);
});

test('a window with no computable share says so, like its two sibling cells', () => {
  // windowSummary returns a null share when it is not given an uptimePercent
  // function. Measured as unreachable through `report` — buildReport always
  // passes one, and a window with recorded buckets always has a check to
  // divide — so this states the rule rather than fixing an observed line. The
  // two sibling cells (uptimeCell, sslCell) both have such a branch; this one
  // did not, and would have printed `null% (1 recorded d, 10 checks)`.
  const site = {
    responseMs: null,
    sslDaysRemaining: null,
    sslExpired: false,
    ageDays: null,
    window: { days: 1, windowDays: 30, checks: 10, failures: 0, uptimePercent: null },
  };
  const markdown = renderReportMarkdown({
    title: 't', generatedAt: NOW, windowDays: 30, summary: { total: 1, up: 1, down: 0, stale: 0 },
    sites: [{ ...site, url: 'https://kunde.dk/', status: 'up', stale: false, uptimePercent: null, checks: 0, failures: 0 }],
  });
  assert.doesNotMatch(markdown, /null%/, 'a share we cannot compute must not print as "null%"');
  assert.match(markdown, /— \(no share in the last 30 d\)/);
});

// ---------------------------------------------------------------------------
// The summary line is a partition (measured, 2026-09-26)
// ---------------------------------------------------------------------------
//
// `up` excluded a stale pass while `down` kept one — both deliberate, both
// right, and together they made the line unreadable. Over one up, one down and
// one stale-down site it printed `1 up · 2 down · 1 stale`: four sites out of
// three, with the stale site inside both numbers. And `summary.unknown` was
// counted, exported in the JSON, and never printed, so a never-checked site
// was a row in the table that belonged to no number on the line.

const STALE_DK = '2026-07-15T09:00:00.000Z';

test('every site lands in exactly one bucket of the summary line', () => {
  const cases = {
    'fresh up, fresh down, stale down': {
      'https://a.dk/': upEntry(),
      'https://b.dk/': upEntry({ wasUp: false, lastStatus: 503 }),
      'https://c.dk/': upEntry({ wasUp: false, lastStatus: 503, lastChecked: STALE_DK }),
    },
    'two fresh up, one stale up, one never checked': {
      'https://a.dk/': upEntry(),
      'https://b.dk/': upEntry(),
      'https://c.dk/': upEntry({ lastChecked: STALE_DK }),
      'https://d.dk/': { addedAt: '2026-09-25T08:00:00.000Z' },
    },
    // The overlap that has no bucket at all if staleness is not resolved first:
    // a stale pass *and* an unreadable verdict — the state file a user restores
    // from a backup gets.
    'stale verdict, never checked, stale up, fresh down': {
      'https://a.dk/': upEntry({ wasUp: 'yes', lastChecked: STALE_DK }),
      'https://b.dk/': { addedAt: '2026-09-25T08:00:00.000Z' },
      'https://c.dk/': upEntry({ lastChecked: STALE_DK }),
      'https://d.dk/': upEntry({ wasUp: false, lastStatus: 500 }),
    },
  };

  for (const [name, urls] of Object.entries(cases)) {
    const report = buildReport(proState(urls), { now: NOW });
    const buckets = siteBuckets(report.sites);
    const total = buckets.up + buckets.down + buckets.unknown + buckets.stale;
    assert.equal(total, report.summary.sites, `${name}: the buckets must cover every site`);
    assert.equal(buckets.neverChecked <= buckets.unknown, true, `${name}: never checked is part of unknown`);

    // The JSON keeps the numbers it has always had — the split is additive, so
    // an agency reading `down` or `unknown` gets what it got before.
    const s = report.summary;
    assert.equal(s.up + (s.down - s.staleDown) + (s.unknown - s.staleUnknown) + s.stale, s.sites, `${name}: JSON overlap is readable`);

    // And the line a customer reads is exactly those buckets.
    const line = renderReportMarkdown(report).split('\n').find(l => l.startsWith('**') && l.includes('site(s)'));
    assert.match(line, new RegExp(`\\*\\*${s.sites} site\\(s\\)`), name);
    assert.match(line, new RegExp(`· ${buckets.up} up `), `${name}: up count`);
    assert.match(line, new RegExp(`· ${buckets.down} down`), `${name}: down count`);
    if (buckets.stale > 0) assert.match(line, new RegExp(`· ${buckets.stale} stale`), `${name}: stale count`);
    if (buckets.neverChecked > 0) assert.match(line, new RegExp(`· ${buckets.neverChecked} not checked`), `${name}: never-checked count`);
    const unreadable = buckets.unknown - buckets.neverChecked;
    if (unreadable > 0) assert.match(line, new RegExp(`· ${unreadable} status unknown`), `${name}: unreadable count`);
  }
});

test('a site that was checked is never called "not checked yet"', () => {
  // The row that contradicts itself: a pass from an hour ago, a verdict the
  // state file cannot read, and the words "not checked yet".
  const report = buildReport(proState({
    'https://kunde.dk/': upEntry({ wasUp: 'yes', lastChecked: '2026-09-25T08:30:00.000Z', checks: 4, checksUp: 3 }),
  }), { now: NOW });
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /not checked yet/, 'a pass ran, so the site was checked');
  assert.match(markdown, /status unknown \(last check 0 d ago\)/);
  assert.match(markdown, /· 1 status unknown/, 'the count is on the summary line, not only in the JSON');
  assert.equal(report.summary.neverChecked, 0);
  assert.equal(report.summary.unknown, 1);

  // An unreadable timestamp is named as unreadable rather than as an age.
  const noAge = buildReport(proState({
    'https://kunde.dk/': upEntry({ wasUp: 'yes', lastChecked: 'ikke-en-dato' }),
  }), { now: NOW });
  assert.match(renderReportMarkdown(noAge), /status unknown \(last check unreadable\)/);

  // No pass at all keeps the old words — they are true there.
  const never = buildReport(proState({ 'https://ny.dk/': { addedAt: '2026-09-25T08:00:00.000Z' } }), { now: NOW });
  assert.match(renderReportMarkdown(never), /not checked yet/);
  assert.match(renderReportMarkdown(never), /· 1 not checked/);
});

test('the report and watch --status cannot disagree about a verdict (one owner)', () => {
  // `siteStatus()` in the report and `readEntry().verdict` were byte-for-byte
  // identical and independently editable — the report cannot call `readEntry`,
  // because it also reads `addedAt` and the counters. Now both ask
  // `verdictFor()`, and this is the cross-surface check that keeps it so.
  for (const wasUp of [true, false, 'true', 'false', 1, 0, null, undefined, 'yes', NaN, [], {}, '']) {
    const report = buildReport(proState({ 'https://x.dk/': upEntry({ wasUp }) }), { now: NOW });
    const entry = { wasUp, lastChecked: '2026-09-25T09:00:00.000Z' };
    assert.equal(report.sites[0].status, readEntry(entry, { now: NOW }).verdict, `wasUp: ${String(wasUp)}`);
  }
  assert.equal(verdictFor(true), 'up');
  assert.equal(verdictFor(false), 'down');
  for (const unusable of ['true', 1, 0, null, undefined, {}, []]) {
    assert.equal(verdictFor(unusable), 'unknown', `wasUp: ${String(unusable)}`);
  }
});

test('a duplicated verdict owner is caught by reading the source, not the output', () => {
  // The cross-surface test above cannot catch this one: measured, putting the
  // old byte-for-byte `siteStatus()` back into the report changed no answer,
  // so 30/30 tests still passed. A duplicated owner is only visible in the
  // source, and it is the failure this file exists to prevent — the report
  // keeping "UP" for a state file the terminal calls `unknown`, in the one
  // document a bureau forwards. So the rule is checked structurally.
  const reportSrc = readFileSync(join(ROOT, 'src', 'report.js'), 'utf8');
  const statusSrc = readFileSync(join(ROOT, 'src', 'status.js'), 'utf8');

  assert.doesNotMatch(reportSrc, /wasUp\s*===/, 'the report must ask verdictFor(), not read wasUp itself');
  assert.match(reportSrc, /verdictFor\(entry\?\.wasUp\)/, 'and it must still ask for the verdict');
  assert.equal((statusSrc.match(/export function verdictFor\(/g) || []).length, 1, 'one definition');
  assert.match(statusSrc, /verdict: verdictFor\(value\.wasUp\)/, 'readEntry asks the same owner');

  // P1-14: the same trap, twice more. "not checked yet" and "stale — last check
  // N d ago" each had a copy here *and* one in readEntry, while the two terminal
  // lists said neither — three surfaces, three owners, two of them silent.
  assert.doesNotMatch(reportSrc, /'not checked yet'/, 'the report must ask unknownNote(), not own the sentence');
  assert.doesNotMatch(reportSrc, /stale — last check/, 'the report must ask staleAgeNote(), not own the sentence');
  // P1-30: the call now passes the two *facts* the wording names instead of the
  // site object, because the report holds the readable time — `null` for both
  // "no pass" and "unreadable" — and the owner is what decides between them.
  // It is still the owner, and still exactly one call.
  // P1-31: the call gained a third fact. A pass time *ahead* of this machine's
  // clock arrives here as `ageDays: null` — the same shape as an unreadable
  // time — so without `clockAhead` the report described a time that reads
  // cleanly as one that could not be read. The lock is extended, not relaxed:
  // the report still must not own the sentence, and it still makes exactly one
  // call, now with the fact that separates the two.
  assert.match(reportSrc, /unknownNote\(\{ passRecorded: site\.passRecorded, ageDays: site\.ageDays, clockAhead: site\.clockAhead \}\)/, 'and it must still ask for the unknown wording');
  assert.match(reportSrc, /staleAgeNote\(site\.ageDays\)/, 'and for the stale wording');
  assert.equal((statusSrc.match(/export function unknownNote\(/g) || []).length, 1, 'one unknown wording');
  assert.equal((statusSrc.match(/export function staleAgeNote\(/g) || []).length, 1, 'one stale wording');

  // The same trap for the status code, which had two owners and the weaker of
  // the two rules: `Number.isInteger` in readEntry and the same test in the
  // report, neither asking whether the number is an HTTP status code at all.
  // `UP (-1)` in the customer document is the measured failure, so the report
  // may not read `lastStatus` itself any more — exactly once, through the owner.
  assert.doesNotMatch(reportSrc, /Number\.isInteger\(entry\.lastStatus\)/, 'and not the weaker test beside it');
  assert.match(reportSrc, /readStatusCode\(entry\.lastStatus\)/, 'and it must still ask for the status code');
  assert.equal((reportSrc.match(/lastStatus/g) || []).length, 1, 'the report reads lastStatus in one place only');
  assert.equal((statusSrc.match(/export function readStatusCode\(/g) || []).length, 1, 'one status-code rule');
  assert.match(statusSrc, /statusCode: readStatusCode\(value\.lastStatus\)/, 'readEntry asks the same owner');
  assert.doesNotMatch(statusSrc, /Number\.isInteger\(value\.lastStatus\)/, 'and not the weaker test beside it');
  assert.equal((statusSrc.match(/lastStatus/g) || []).length, 3, 'readEntry reads lastStatus in one place only');
  // …and the third is the owner of the response duration, which has to ask
  // whether the last pass got a response at all: a `lastResponseMs` left over
  // from an earlier pass is not this pass's measurement. It asks `readStatusCode`
  // like its sibling does, so the weaker test cannot come back beside it.
  assert.match(statusSrc, /readResponseMs\(entry\)[\s\S]{0,200}readStatusCode\(entry\?\.lastStatus\)/, 'the duration owner asks the status-code owner');
});

test('the report and the terminal lists say the same thing about a site they cannot vouch for', () => {
  // The sentence three surfaces print, from one function, for the three states a
  // hand-edited or half-written state file produces.
  const cases = [
    { entry: { wasUp: null }, expected: 'not checked yet' },
    { entry: { wasUp: null, lastChecked: 'not-a-date' }, expected: 'status unknown (last check unreadable)' },
    { entry: { wasUp: 'yes', lastChecked: '2026-08-20T09:30:00.000Z' }, expected: 'status unknown (last check 36 d ago)' },
  ];
  for (const { entry, expected } of cases) {
    assert.equal(readEntry(entry, { now: NOW }).unknownNote, expected, JSON.stringify(entry));
    assert.equal(readEntry(entry, { now: NOW }).neverChecked, !entry.lastChecked, JSON.stringify(entry));
    // And the report built from the same state file carries the same sentence.
    const report = buildReport(proState({ 'https://x.dk/': { addedAt: '2026-08-01T08:00:00.000Z', ...entry } }), { now: NOW });
    assert.equal(report.sites[0].status, 'unknown', JSON.stringify(entry));
    assert.match(renderReportMarkdown(report), new RegExp(expected.replace(/[()]/g, String.raw`\$&`)));
  }
});

// ── The machine surface has to be able to say what the customer line says ──

test('report --json carries the same partition the customer line prints', () => {
  // Measured before this existed, on one state file with seven sites — the same
  // seven this test builds. The line a customer reads was a partition that
  // added up, and the JSON next to it was not:
  //
  //   **7 site(s) · 3 up · 1 down · 1 not checked · 1 status unknown · … · 1 stale**
  //   "sites": 7, "up": 3, "down": 1, "unknown": 2, "stale": 1   → 3+1+2 = 6
  //
  // `summary` still holds those four overlapping numbers on purpose (they are
  // the contract an existing consumer reads), so the disjoint partition the
  // report's own footnote defines is what the JSON has to carry separately.
  const report = buildReport(proState({
    'https://op.dk/': upEntry(),
    'https://ned.dk/': upEntry({ wasUp: false, lastStatus: 503, checks: 4, checksUp: 1, sslValidDays: undefined }),
    'https://gammel.dk/': upEntry({ lastChecked: STALE_DK, checks: 9, checksUp: 8 }),
    'https://aldrig.dk/': { addedAt: '2026-08-01T00:00:00.000Z' },
    'https://ulaes.dk/': upEntry({ wasUp: 'yes' }),
  }), { now: NOW });

  const partition = report.partition;
  assert.ok(partition, 'the report exports the partition it resolved');
  assert.equal(partition.up + partition.down + partition.unknown + partition.stale, report.summary.sites,
    'every site is in exactly one bucket');
  assert.equal(partition.neverChecked, 1);
  assert.ok(partition.neverChecked <= partition.unknown, 'never checked is a subset of unknown');

  // It is the one the line is written from, not a second opinion: every number
  // on the line has to be the number in the partition.
  const line = renderReportMarkdown(report).split('\n').find(l => l.startsWith('**') && l.includes('site(s)'));
  assert.match(line, new RegExp(`\\*\\*${report.summary.sites} site\\(s\\) · ${partition.up} up · ${partition.down} down`));
  assert.match(line, new RegExp(`· ${partition.neverChecked} not checked`));
  assert.match(line, new RegExp(`· ${partition.unknown - partition.neverChecked} status unknown`));
  assert.match(line, new RegExp(`· ${partition.stale} stale`));

  // The line reads the partition the report carries, so the two cannot drift.
  const tampered = { ...report, partition: { ...partition, up: partition.up + 1 } };
  assert.match(renderReportMarkdown(tampered), new RegExp(`· ${partition.up + 1} up `), 'the line follows the report');

  // And it survives the trip through the JSON, which is what CI and an agency's
  // own system actually read.
  const overTheWire = JSON.parse(renderReportJson(report));
  assert.deepEqual(overTheWire.partition, partition, 'the partition is machine-readable');
  assert.equal(overTheWire.partition.up + overTheWire.partition.down + overTheWire.partition.unknown + overTheWire.partition.stale,
    overTheWire.summary.sites, 'the partition a consumer computes still covers every site');

  // Additive: every key and value `summary` has always had is untouched, so an
  // agency that reads `down` or `unknown` still gets what it got before.
  for (const [key, value] of Object.entries({ sites: 5, up: 1, down: 1, unknown: 2, stale: 1, staleDown: 0, staleUnknown: 0, neverChecked: 1 })) {
    assert.equal(report.summary[key], value, `summary.${key} must not change`);
  }
});

test('a status code outside 100-599 is unknown, not a claim about a server', () => {
  // Measured on the same seven-site state file, before this was fixed: four
  // surfaces printed a number the state file held but no server could have sent.
  //
  //   report        | https://kode-1.dk/ | UP (-1)   | 100% (2 checks) |
  //   report --json | https://kode-2.dk/ | UP (9999) | "statusCode": 9999
  //   status        · ✅ https://kode-1.dk/ (-1)
  //   watch --status ✅ up https://kode-2.dk/ (9999)
  //
  // `Number.isInteger` was the whole check, and a state file that was hand-edited
  // or restored holds integers too. Out of range becomes `null` — the same "—"
  // every sibling cell prints for a number nobody measured — rather than being
  // clamped into a plausible code, which would be a different lie.
  for (const bogus of [-1, 0, 99, 600, 9999, 1e9, Number.MAX_SAFE_INTEGER]) {
    const report = buildReport(proState({ 'https://kode.dk/': upEntry({ lastStatus: bogus }) }), { now: NOW });
    assert.equal(report.sites[0].statusCode, null, `lastStatus ${bogus}`);
    assert.equal(readEntry({ wasUp: true, lastStatus: bogus }, { now: NOW }).statusCode, null,
      `the terminal lists must not print ${bogus} either`);
    const markdown = renderReportMarkdown(report);
    assert.doesNotMatch(markdown, new RegExp(`\\(${bogus}\\)`), `the customer document must not claim ${bogus}`);
    assert.match(markdown, /\| UP \|/, 'a site we cannot place keeps the verdict the pass gave');
  }

  // The ends of the real range are real codes, and so is everything between.
  for (const code of [100, 200, 301, 404, 418, 503, 599]) {
    const report = buildReport(proState({ 'https://acme.dk/': upEntry({ lastStatus: code }) }), { now: NOW });
    assert.equal(report.sites[0].statusCode, code, `lastStatus ${code} is a status code`);
    assert.equal(readEntry({ wasUp: false, lastStatus: code }, { now: NOW }).statusCode, code);
    assert.match(renderReportMarkdown(report), new RegExp(`\\(${code}\\)`), `the code ${code} belongs in the report`);
  }
});

/**
 * P1-30: the paid report measured against the real CLI for the first time.
 *
 * Everything above this block is a unit test on `buildReport`. These three are
 * the measurement itself, kept as tests because both defects are silent: a
 * customer reading the document, and a CI job reading the JSON, would not notice
 * either one — they only ever see a confident number.
 */

// A pass the state file records and the history file does not. Measured through
// the real `report`, the row claimed there had been no recent pass while the
// same row showed a check from 14 minutes earlier:
//
//   | https://kunde.dk/ | UP (200) | 100% (4 checks) | — (no pass in the last 30 d) | … | 09:18 UTC |
//
// Both files are written by the same pass, so this is not a corrupt file: the
// history write is deliberately allowed to fail (a full disk, a read-only home),
// and an agency moving monitoring to a new machine copies the file the README
// names — `state.json` — and not `history.json`.
test('a check the history file is missing is named, not reported as no data (real CLI)', async (t) => {
  const fresh = new Date().toISOString();
  const home = writeState(tempHome(t), proState({
    'https://kunde.dk/': upEntry({ lastChecked: fresh, addedAt: fresh, checks: 4, checksUp: 4 }),
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const runCli = (args) => run(process.execPath, [CLI, ...args], { env });

  const { stdout } = await runCli(['report']);
  const row = stdout.split('\n').find(line => line.startsWith('| https://kunde.dk/'));
  assert.ok(row, `no row for the site:\n${stdout}`);
  assert.match(row, /last check missing from the history file/, `the row must name the source: ${row}`);
  assert.doesNotMatch(row, /no pass in the last 30 d/, `the row must not claim the site went unmonitored: ${row}`);
  // The verdict the pass gave is untouched: this is a note about a column, not a
  // change of status, and the uptime column still has the lifetime figure.
  assert.match(row, /UP \(200\)/);
  assert.match(row, /100% \(4 checks\)/);
  // The summary line still counts the site once, as up.
  assert.match(stdout, /\*\*1 site\(s\) · 1 up · 0 down · 4 checks · 0 failed/, stdout);

  // And the machine surface can reproduce the sentence rather than infer it.
  const json = JSON.parse((await runCli(['report', '--json'])).stdout);
  const site = json.sites.find(s => s.url === 'https://kunde.dk/');
  assert.equal(site.window.uptimePercent, null, 'there is no share to compute');
  assert.equal(site.window.passNotRecorded, true);
  assert.equal(json.partition.up, 1, 'the disagreement must not move the site between buckets');
  assert.equal(json.partition.neverChecked, 0);
});

test('a site with no pass in the window is not blamed for the history file', () => {
  const history = { urls: {} };
  // A pass that is older than the window: the plain wording is correct, and the
  // new sentence would be a false alarm on every ordinary report.
  const stale = buildReport(proState({ 'https://gammel.dk/': upEntry({ lastChecked: '2026-08-16T09:00:00.000Z' }) }), { now: NOW, history });
  assert.equal(stale.sites[0].window, null);
  assert.match(renderReportMarkdown(stale), /— \(no pass in the last 30 d\)/);

  // Never checked: also the plain wording — the Status column already says
  // "not checked yet", and P1-14 is the reason that sentence exists.
  const never = buildReport(proState({ 'https://aldrig.dk/': { addedAt: '2026-09-25T08:00:00.000Z' } }), { now: NOW, history });
  assert.equal(never.sites[0].window, null);
  assert.match(renderReportMarkdown(never), /— \(no pass in the last 30 d\)/);

  // A pass dated in the future cannot be placed in the window either. It is
  // clock skew, which P1-6 decided must not be turned into an outage — so it
  // must not be turned into a missing file either.
  const skewed = buildReport(proState({ 'https://fremtid.dk/': upEntry({ lastChecked: '2026-10-15T09:00:00.000Z' }) }), { now: NOW, history });
  assert.equal(skewed.sites[0].window, null);
  const row = renderReportMarkdown(skewed).split('\n').find(line => line.startsWith('| https://fremtid.dk/'));
  assert.match(row, /— \(no pass in the last 30 d\)/);
  assert.doesNotMatch(row, /history file/, 'clock skew is not a missing history file');
});

// The last two raw values in the paid machine surface. Measured before this
// fix, `--json` carried the state's own strings while the Markdown beside them
// printed "—" and named the time unreadable:
//
//   "lastChecked": "OWNED"      "monitoringSince": "OWNED"
test('report --json forwards no timestamp it has already called unreadable', () => {
  const report = buildReport(proState({
    'https://a.dk/': upEntry({ lastChecked: 'OWNED', addedAt: 'OWNED' }),
    'https://b.dk/': upEntry({ lastChecked: '2026-09-25T09:00:00.000Z', addedAt: '2026-08-01T00:00:00.000Z' }),
  }), { now: NOW });
  const [a, b] = report.sites;
  assert.equal(a.lastChecked, null);
  assert.equal(a.monitoringSince, null);
  // A readable time is canonicalised, so JSON and the Markdown column carry the
  // same instant.
  assert.equal(b.lastChecked, '2026-09-25T09:00:00.000Z');
  assert.equal(b.monitoringSince, '2026-08-01T00:00:00.000Z');

  const json = renderReportJson(report);
  assert.doesNotMatch(json, /OWNED/, 'the raw state string must not reach a consumer');

  // "Unreadable" must not collapse into "never checked": a pass did run, the
  // report already says so in the Status column, and the summary line has to
  // agree with it. Only the row and the summary line are read here — the
  // footnote names the "not checked" bucket by definition, and it always has.
  const markdown = renderReportMarkdown(report);
  const row = markdown.split('\n').find(line => line.startsWith('| https://a.dk/'));
  const summary = markdown.split('\n').find(line => line.startsWith('**2 site(s)'));
  assert.match(row, /UP \(200\) ⚠️ stale — last check unreadable/, row);
  assert.doesNotMatch(row, /not checked/, `a pass was recorded: ${row}`);
  assert.doesNotMatch(summary, /not checked/, `the summary line must not claim it never was: ${summary}`);
  assert.equal(report.partition.neverChecked, 0);
  assert.equal(report.partition.stale, 1);
});

// A behavioural test cannot catch a duplicated owner (measured in P1-9), so the
// rule is locked on the source: the report must not read a state timestamp as a
// raw string again.
test('the report reads every state timestamp through the one owner', () => {
  const source = readFileSync(join(ROOT, 'src', 'report.js'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Both fields must be handed the owner's answer, not the entry's own value:
  // `readPassTime` is what turns an unreadable time into `null`.
  assert.match(source, /lastChecked: readPassTime\(entry\.lastChecked\)/, 'a raw state timestamp can reach --json again');
  // `addedAt` is read once and handed to both users — the row's `monitoringSince`
  // and the window-coverage rule — so the two cannot disagree about it. Widened
  // from `monitoringSince: readPassTime(entry.addedAt)`, which the refactor into
  // one local broke; the invariant it protected is the same and is now stronger.
  assert.match(source, /const monitoringSince = readPassTime\(entry\.addedAt\)/, 'a raw state timestamp can reach --json again');
  assert.match(source, /monitoringSince,/, 'and the row is written from the owner\'s answer');
  assert.equal((source.match(/readPassTime\(/g) ?? []).length, 2, 'both timestamps, and nothing else');
});

// ── P1-31: a pass time ahead of this machine's clock ──────────────────────────
//
// Measured before the fix, on a state file whose `lastChecked` was 19 days in
// the future, with a real `check` and `watch --once` against local fixtures:
//
//   | http://127.0.0.1:8811/ | UP (200) | 100% (1 checks) | … | 2026-10-15 10:24 UTC |
//   **2 site(s) · 1 up · 1 down · 2 checks · 1 failed**
//   "ageDays": 0
//
// A document generated 2026-09-26 told a customer their site was last checked
// on 2026-10-15, counted it as up right now, and `--json` said the pass was
// zero days old. `checkAgeMs` documented a negative age for exactly this case
// and had no reader: `checkAgeDays` floored it at 0.

test('a pass time ahead of the clock is its own state, not a pass from today', async () => {
  const { PASS_AGE, checkAgeDays, clockAheadNote, isCheckStale, passAge } = await import('../src/status.js');
  const ahead = ms => new Date(NOW.getTime() + ms).toISOString();
  const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  // The four states, one owner. `aged` is the only one with a day count.
  assert.equal(passAge(undefined, NOW).state, PASS_AGE.NEVER);
  assert.equal(passAge('', NOW).state, PASS_AGE.NEVER);
  assert.equal(passAge('not-a-date', NOW).state, PASS_AGE.UNREADABLE);
  assert.equal(passAge(ahead(19 * 86400000), NOW).state, PASS_AGE.AHEAD);
  assert.equal(passAge(daysAgo(3), NOW).state, PASS_AGE.AGED);

  // The measured bug, in one assertion: 0 is a claim — "checked today" — and it
  // must only be reachable by a pass that really happened today.
  assert.equal(checkAgeDays(ahead(19 * 86400000), NOW), null, 'a future pass is not a pass from today');
  assert.equal(checkAgeDays(ahead(1000), NOW), null, 'not even a second ahead');
  assert.equal(checkAgeDays(daysAgo(0.001), NOW), 0, 'a pass that really did just happen is still 0');
  assert.equal(checkAgeDays(daysAgo(41.9), NOW), 41);

  // AC 4: `checkAgeMs` documents that a future time yields a negative age, and
  // that claim is now true — the owner reads the sign instead of discarding it.
  const aheadPass = passAge(ahead(19 * 86400000), NOW);
  assert.ok(aheadPass.ageMs < 0, 'the negative age it documents is delivered and read');
  assert.equal(aheadPass.aheadMs, -aheadPass.ageMs);

  // P1-6's decision, kept and stated: a wrong clock is not old data, and a stale
  // marker is a claim that monitoring stopped.
  assert.equal(isCheckStale(ahead(19 * 86400000), NOW), false, 'never stale — that would invent an outage');
  assert.equal(isCheckStale(ahead(1000), NOW), false);
  assert.equal(isCheckStale('not-a-date', NOW), true, 'an unreadable time is still stale');
  assert.equal(isCheckStale(daysAgo(41), NOW), true);
  // …and the window is still compared in ms, not in floored days, so rounding
  // cannot move the boundary.
  assert.equal(isCheckStale(daysAgo(2.9), NOW), true, '2.9 d is outside a 2 d window');
  assert.equal(isCheckStale(daysAgo(2), NOW), false, 'exactly at the window is still current');

  // The wording is the owner's, and the unit follows the size: a clock drifting
  // mid-check and a clock set wrong are two different problems.
  assert.equal(clockAheadNote(0), '');
  assert.equal(clockAheadNote(-5), '', 'a pass that is not ahead says nothing');
  assert.equal(clockAheadNote(NaN), '');
  assert.equal(clockAheadNote(40 * 1000), '40 s ahead of this machine\'s clock');
  assert.equal(clockAheadNote(20 * 60 * 1000), '20 min ahead of this machine\'s clock');
  assert.equal(clockAheadNote(5 * 60 * 60 * 1000), '5 h ahead of this machine\'s clock');
  assert.equal(clockAheadNote(19 * 86400000), '19 d ahead of this machine\'s clock');
});

test('the report names a clock skew instead of printing a check that has not happened', async () => {
  const ahead = new Date(NOW.getTime() + 19 * 24 * 60 * 60 * 1000).toISOString();
  const report = buildReport(proState({
    'https://kunde.dk/': upEntry({ lastChecked: ahead }),
    'https://butik.dk/': upEntry(),
  }), { now: NOW });

  const skewed = report.sites.find(site => site.url === 'https://kunde.dk/');
  const ordinary = report.sites.find(site => site.url === 'https://butik.dk/');

  // The three claims that were wrong.
  assert.equal(skewed.ageDays, null, '"ageDays: 0" claimed the pass was from today');
  assert.equal(skewed.passState, 'ahead');
  assert.equal(skewed.clockAhead, '19 d ahead of this machine\'s clock');
  assert.equal(skewed.stale, false, 'P1-6: a wrong clock is not old data');

  // P1-6 again, on the counts: the verdict stands and the site is not moved into
  // the stale bucket, because "stale" is a claim that monitoring stopped and a
  // machine with the wrong clock has a clock problem. The row names the skew.
  assert.equal(report.partition.stale, 0);
  assert.equal(report.partition.up, 2);
  assert.equal(report.summary.up, 2);
  assert.equal(skewed.status, 'up', 'the recorded verdict is not rewritten');

  // The customer-facing line: the timestamp is still shown — it is the only clue
  // about *how* wrong the clock is — but it can no longer read as a plain check.
  const markdown = renderReportMarkdown(report);
  const row = markdown.split('\n').find(line => line.startsWith('| https://kunde.dk/'));
  assert.match(row, /2026-10-14 09:30 UTC ⚠️ 19 d ahead of this machine's clock/, row);
  assert.match(markdown, /\*\*2 site\(s\) · 2 up · 0 down/, 'the summary line is unchanged');

  // An ordinary pass is character for character what it was, and its JSON is
  // byte-identical apart from the two additive fields.
  assert.equal(ordinary.passState, 'aged');
  assert.equal(ordinary.clockAhead, '');
  assert.equal(ordinary.ageDays, 0);
  const ordinaryRow = markdown.split('\n').find(line => line.startsWith('| https://butik.dk/'));
  assert.match(ordinaryRow, /\| 2026-09-25 09:00 UTC \|$/, ordinaryRow);
});

test('a clean future time is never described as an unreadable one', async () => {
  const { unknownNote } = await import('../src/status.js');
  // Both arrive as `ageDays: null` at the call site, which is exactly why the
  // collapse is possible: before P1-31 the report described a time that reads
  // perfectly well as a time that could not be read.
  assert.equal(unknownNote({ passRecorded: true, ageDays: null }), 'status unknown (last check unreadable)');
  assert.equal(
    unknownNote({ passRecorded: true, ageDays: null, clockAhead: '19 d ahead of this machine\'s clock' }),
    'status unknown (last check 19 d ahead of this machine\'s clock)',
  );
  // "never checked" still wins over everything: it is a claim about history, and
  // a site with no pass at all is not in the future.
  assert.equal(unknownNote({ passRecorded: false, ageDays: null, clockAhead: '19 d ahead' }), 'not checked yet');
});

// A behavioural test cannot catch a duplicated owner (measured in P1-9), so AC 3
// is locked on the source: outside `status.js`, no surface may decide the four
// states for itself.
test('the four pass states are decided in one place, and only there', () => {
  // Comments are stripped, because a comment is allowed to *name* the rule — the
  // measured failures in this repo are documented in the code that caused them.
  const read = name => readFileSync(join(ROOT, 'src', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const statusSrc = read('status.js');

  assert.equal((statusSrc.match(/export function passAge\(/g) ?? []).length, 1, 'one definition of the four states');
  assert.equal((statusSrc.match(/export function clockAheadNote\(/g) ?? []).length, 1, 'one wording for a clock skew');
  assert.equal((statusSrc.match(/export const PASS_AGE =/g) ?? []).length, 1, 'one set of state names');

  for (const name of ['report.js', 'watch.js', 'cli.js', 'history.js', 'engine.js', 'display.js']) {
    const source = read(name);
    // No surface may age a pass with its own arithmetic. `Math.max(0, …)` is the
    // measured defect, and a bare `now - Date.parse(lastChecked)` is the same
    // decision written out again.
    assert.doesNotMatch(source, /Math\.max\(0,\s*Math\.(floor|round)/, `${name} floors a pass age itself`);
    assert.doesNotMatch(source, /getTime\(\)\s*-\s*Date\.parse/, `${name} ages a pass itself`);
    // …and no surface may *place* a pass by parsing it. `history.js` had its own
    // `Date.parse(lastChecked)`, which no other pattern above catches because it
    // never subtracts: it compared day keys instead, and got a clock 6 h fast
    // wrong while a clock 23 h fast was right (P1-32).
    assert.doesNotMatch(source, /Date\.parse\(\s*lastChecked/, `${name} places a pass time itself`);
    // …and no surface may write the sentence. These are the strings the two
    // lists and the report used to diverge on.
    assert.doesNotMatch(source, /ahead of this machine'?s clock/, `${name} owns the clock-skew wording`);
    assert.doesNotMatch(source, /'aged'|'ahead'|'unreadable'/, `${name} names a pass state itself`);
  }

  // The owner is asked, not re-implemented: the report, both terminal lists and
  // the window column go through it, by name.
  assert.match(read('report.js'), /passAge\(entry\.lastChecked, now\)/, 'the report asks the owner');
  assert.match(read('history.js'), /passAge\(lastChecked, now\)/, 'the window column asks the owner too');
  assert.match(statusSrc, /const pass = passAge\(value\.lastChecked, now\)/, 'readEntry asks the owner');

  // The one reader of the negative age is the owner, so `checkAgeMs` documents
  // behaviour it actually has (AC 4).
  const ageMs = statusSrc.match(/export function checkAgeMs\([\s\S]*?\n}/)?.[0] ?? '';
  assert.match(ageMs, /return now\.getTime\(\) - parsed/, 'the sign survives checkAgeMs');
  assert.equal((statusSrc.match(/checkAgeMs\(/g) ?? []).length, 2, 'its definition and the one reader');
});

// P1-31's own measurement, through the real CLI, on a state file whose
// `lastChecked` lies 19 days in the future. Before the fix all three surfaces
// reported it as an ordinary pass from today; `status` was the quietest of them,
// because that list prints no timestamps at all and so had nothing to give away
// that its clock was wrong.
test('all three surfaces name a clock skew, and none of them calls it stale (real CLI)', async (t) => {
  const ahead = new Date(Date.now() + 19 * 24 * 60 * 60 * 1000).toISOString();
  const home = writeState(tempHome(t), proState({
    'https://kunde.dk/': upEntry({ lastChecked: ahead, addedAt: '2026-08-01T00:00:00.000Z' }),
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const runCli = (args) => run(process.execPath, [CLI, ...args], { env });
  const note = /ahead of this machine's clock/;

  const report = (await runCli(['report'])).stdout;
  const row = report.split('\n').find(line => line.startsWith('| https://kunde.dk/'));
  assert.ok(row, `no row for the site:\n${report}`);
  assert.match(row, note, `the customer document must name the skew: ${row}`);
  assert.doesNotMatch(row, /stale/, `a wrong clock is not a dead monitoring loop: ${row}`);
  assert.match(report, /\*\*1 site\(s\) · 1 up · 0 down/, 'P1-6: the verdict and the count stand');

  // The machine surface, so a dashboard can say it without inferring it.
  const json = JSON.parse((await runCli(['report', '--json'])).stdout);
  const site = json.sites.find(s => s.url === 'https://kunde.dk/');
  assert.equal(site.ageDays, null, 'not 0 — 0 claims the check happened today');
  assert.equal(site.passState, 'ahead');
  assert.match(site.clockAhead, note);
  assert.equal(site.stale, false);
  assert.equal(json.partition.up, 1, 'the site stays where the verdict put it');
  assert.equal(json.partition.stale, 0);

  // The URL list on `status`, which printed no timestamp and therefore said
  // nothing at all about a wrong clock.
  const status = (await runCli(['status'])).stdout;
  assert.match(status.split('\n').find(line => line.includes('https://kunde.dk/')), note, status);
  assert.doesNotMatch(status, /stale/, status);

  // `watch --status` is the command a user runs to find out whether their
  // monitoring works at all, so it must not show an impossible date as fact.
  const watch = (await runCli(['watch', '--status'])).stdout;
  const watchRow = watch.split('\n').find(line => line.includes('https://kunde.dk/'));
  assert.ok(watchRow, watch);
  assert.match(watchRow, note, `the list must name the skew: ${watchRow}`);
  assert.match(watchRow, /✅ up/, 'P1-6: the recorded verdict is not rewritten');
  assert.doesNotMatch(watch, /No monitoring pass in the last/, 'and it is not called a dead loop');

  // An ordinary pass is untouched on all three.
  const fresh = new Date().toISOString();
  const okHome = writeState(tempHome(t), proState({ 'https://frisk.dk/': upEntry({ lastChecked: fresh }) }));
  const okEnv = { ...process.env, HOME: okHome, USERPROFILE: okHome };
  const okReport = (await run(process.execPath, [CLI, 'report'], { env: okEnv })).stdout;
  assert.doesNotMatch(okReport, /ahead of this machine's clock/, `an ordinary pass says nothing: ${okReport}`);
  const okWatch = (await run(process.execPath, [CLI, 'watch', '--status'], { env: okEnv })).stdout;
  assert.doesNotMatch(okWatch, /ahead of this machine's clock/, okWatch);
});

// P1-32, measured through the real CLI on a state file whose clock is 6 h fast
// and a history file that holds only older days. Before the fix the window
// column said `— (last check missing from the history file)` for the 6 h skew
// and `— (no pass in the last 1 d)` for a 19 d skew — one condition, two
// sentences, and the first one blamed the customer's own files for a pass that
// had not happened yet.
test('a clock a few hours fast does not accuse the history file (real CLI)', async (t) => {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const ago = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const window1 = '— (no pass in the last 1 d)';
  const missing = 'last check missing from the history file';

  for (const [label, skewMs] of [['2 h', 2 * 3600e3], ['6 h', 6 * 3600e3], ['19 d', 19 * 86400e3]]) {
    const home = tempHome(t);
    mkdirSync(join(home, '.deskuptime'), { recursive: true });
    // A real history file whose recorded days are all outside the 1-day window.
    writeFileSync(join(home, '.deskuptime', 'history.json'), JSON.stringify({
      version: 1,
      urls: { 'https://kunde.dk/': { [day(Date.now() - 2 * 86400e3)]: { checks: 12, failures: 0 } } },
    }));
    writeState(home, proState({ 'https://kunde.dk/': upEntry({ lastChecked: new Date(Date.now() + skewMs).toISOString() }) }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const runCli = (args) => run(process.execPath, [CLI, ...args], { env });

    const row = (await runCli(['report', '--days', '1'])).stdout.split('\n').find(l => l.startsWith('| https://kunde.dk/'));
    assert.ok(row, `no row for the ${label} skew`);
    assert.ok(row.includes(window1), `a ${label} clock must not read as a recorded pass: ${row}`);
    assert.doesNotMatch(row, new RegExp(missing), `a ${label} clock must not blame the history file: ${row}`);

    // The machine surface, so a dashboard reproduces the sentence rather than
    // inferring it from the absence of a number. A future pass has no window,
    // so there is no `passNotRecorded` to misread.
    const site = JSON.parse((await runCli(['report', '--json', '--days', '1'])).stdout).sites.find(s => s.url === 'https://kunde.dk/');
    assert.equal(site.window, null, `a ${label} clock must not produce a window summary`);
  }

  // The claim that is true is kept: an honest pass 2 h old whose day really is
  // absent from the history file is still a disagreement between two files.
  const honest = tempHome(t);
  mkdirSync(join(honest, '.deskuptime'), { recursive: true });
  writeFileSync(join(honest, '.deskuptime', 'history.json'), JSON.stringify({
    version: 1,
    urls: { 'https://kunde.dk/': { [day(Date.now() - 2 * 86400e3)]: { checks: 12, failures: 0 } } },
  }));
  writeState(honest, proState({ 'https://kunde.dk/': upEntry({ lastChecked: ago(0) }) }));
  const honestRow = (await run(process.execPath, [CLI, 'report', '--days', '1'], { env: { ...process.env, HOME: honest, USERPROFILE: honest } })).stdout
    .split('\n').find(l => l.startsWith('| https://kunde.dk/'));
  assert.match(honestRow, new RegExp(missing), `a genuinely absent pass is still named: ${honestRow}`);
});

// ---------------------------------------------------------------------------
// A certificate day count is a countdown, and a countdown expires.
//
// Measured through the real `report` on a state file whose newest pass was 36 h
// old and had read `sslValidDays: 1`, no code changed:
//
//   | https://kunde.dk/ | UP (200) | … | ⚠️ 1 d — renew soon | 2026-09-25 03:04 UTC |
//   **1 site(s) · 1 up · 0 down · … · 1 SSL expiring soon**
//   **SSL certificate expiring within 14 days — renewal needed:** … (1 d)
//
// `validDays` is `Math.round((validTo - now) / DAY)` *at the pass*, so "1 d left"
// was at most half a day of a promise, made 36 hours ago. The certificate had
// almost certainly lapsed, and the document a bureau forwards told the client to
// renew it "in a day".
// ---------------------------------------------------------------------------

const hoursAgo = h => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

test('a certificate reading too old to renew against is not "renew soon"', () => {
  const report = buildReport(proState({
    'https://kunde.dk/': upEntry({ sslValidDays: 1, lastChecked: hoursAgo(36) }),
    'https://frisk.dk/': upEntry({ sslValidDays: 1, lastChecked: hoursAgo(0.5) }),
    'https://langt.dk/': upEntry({ sslValidDays: 20, lastChecked: hoursAgo(36) }),
  }), { now: NOW });

  const byUrl = Object.fromEntries(report.sites.map(site => [site.url, site]));
  const lapsed = byUrl['https://kunde.dk/'];
  assert.equal(lapsed.sslMayHaveExpired, true, 'a day-old reading of "1 d left" cannot be renewed against');
  assert.equal(lapsed.sslReadingAgeDays, 1);
  assert.equal(lapsed.sslExpiringSoon, false, 'a certificate that may be gone is not a renewal to schedule');
  assert.equal(lapsed.sslExpired, false, 'nothing measured a lapse, so none is claimed');
  assert.equal(lapsed.sslDaysRemaining, 1, 'the measurement itself is unchanged');

  // The two cases that must not move: a reading younger than a day, and a
  // reading whose deadline is nowhere near.
  assert.equal(byUrl['https://frisk.dk/'].sslMayHaveExpired, false);
  assert.equal(byUrl['https://frisk.dk/'].sslExpiringSoon, true);
  assert.equal(byUrl['https://langt.dk/'].sslMayHaveExpired, false);
  assert.equal(byUrl['https://langt.dk/'].sslExpiringSoon, false);

  assert.equal(report.summary.sslMayHaveExpired, 1);
  assert.equal(report.summary.sslExpiringSoon, 1, 'and the two counts are disjoint');

  const markdown = renderReportMarkdown(report);
  const row = markdown.split('\n').find(l => l.startsWith('| https://kunde.dk/'));
  assert.match(row, /🔴 may be expired — last reading: 1 d left, checked 1 d ago/);
  assert.doesNotMatch(row, /renew soon/);
  assert.match(markdown, /1 SSL may be expired/);
  assert.doesNotMatch(markdown, /renewal needed:\*\* https:\/\/kunde\.dk/);
  assert.match(markdown, /Get a fresh certificate reading before you act on this:\*\* https:\/\/kunde\.dk\/ — may be expired — last reading: 1 d left, checked 1 d ago/);
  assert.match(markdown, /Run: deskuptime check <url>/);

  // The fresh reading still produces exactly the line it always did.
  assert.match(markdown, /⚠️ 1 d — renew soon/);
  assert.match(markdown, /1 SSL expiring soon/);

  const json = JSON.parse(renderReportJson(report));
  assert.equal(json.summary.sslMayHaveExpired, 1);
  assert.equal(json.sites.find(site => site.url === 'https://kunde.dk/').sslMayHaveExpired, true);
  assert.equal(json.sites.find(site => site.url === 'https://frisk.dk/').sslMayHaveExpired, false);
});

test('both terminal lists ask the same owner about a lapsed deadline', () => {
  const read = readEntry(upEntry({ sslValidDays: 1, lastChecked: hoursAgo(36) }), { now: NOW });
  assert.equal(read.sslMayHaveExpired, true);
  assert.equal(read.sslDays, 1);
  assert.equal(read.sslNote, 'SSL 🔴 may be expired — last reading: 1 d left, checked 1 d ago');

  // A reading younger than a day is the countdown it has always been.
  const fresh = readEntry(upEntry({ sslValidDays: 1, lastChecked: hoursAgo(0.5) }), { now: NOW });
  assert.equal(fresh.sslMayHaveExpired, false);
  assert.equal(fresh.sslNote, 'SSL ⚠️ 1d — renew soon');

  // A clock that cannot place the pass makes no claim in either direction —
  // P1-31's rule, asked of the same owner.
  const ahead = readEntry(upEntry({ sslValidDays: 1, lastChecked: '2026-10-15T10:24:20.661Z' }), { now: NOW });
  assert.equal(ahead.sslMayHaveExpired, false);
  assert.equal(ahead.sslReadingAgeDays, null);

  // A *measured* lapse is not aged: a certificate that had expired at the pass
  // has not un-expired since, so the reading errs in the safe direction.
  const lapsed = readEntry(upEntry({ sslExpired: true, sslExpiredDays: 3, lastChecked: hoursAgo(36) }), { now: NOW });
  assert.equal(lapsed.sslMayHaveExpired, false);
  assert.equal(lapsed.sslNote, 'SSL 🔴 expired 3d ago');
});

test('the certificate deadline is compared in one place, and only there', () => {
  const readSrc = name => readFileSync(join(ROOT, 'src', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const statusSrc = readSrc('status.js');

  assert.equal((statusSrc.match(/function readSslReadingAge\(/g) ?? []).length, 1, 'one reading of the deadline');
  assert.equal((statusSrc.match(/export function sslLapsedNote\(/g) ?? []).length, 1, 'one wording for a lapsed deadline');

  for (const name of ['report.js', 'watch.js', 'cli.js', 'engine.js', 'history.js', 'display.js']) {
    const source = readSrc(name);
    // No surface may compare a certificate's day count against a pass's age —
    // that comparison is the decision, and it is `readSslState`'s.
    assert.doesNotMatch(source, /ssl\.days\s*[<>=]/, `${name} decides a certificate deadline itself`);
    // The two forms of the sentence itself. The summary line's "1 SSL may be
    // expired" is a count label beside "1 SSL expiring soon", not a second
    // wording — so the lock targets the sentence, not the words.
    assert.doesNotMatch(source, /last reading:/, `${name} owns the lapsed wording`);
    assert.doesNotMatch(source, /may be expired —/, `${name} re-words the lapsed reading`);
    // …and no surface may read the reading's age to make that decision. It hands
    // the pass time to the owner instead, by name.
    assert.doesNotMatch(source, /passAge\([^)]*lastChecked[^)]*\)\s*\.\s*ageMs/, `${name} ages a certificate reading itself`);
  }

  assert.match(readSrc('report.js'), /measuredAt: entry\.lastChecked/, 'the report hands the pass time to the owner');
  assert.match(statusSrc, /measuredAt: value\.lastChecked/, 'and so does readEntry, for both terminal lists');
  assert.match(statusSrc, /passAge\(measuredAt, now\)/, 'the owner places the reading with passAge, not its own parsing');
});

// ---------------------------------------------------------------------------
// The Response column: a duration, or nothing (measured, 2026-09-26)
// ---------------------------------------------------------------------------
//
// `ping.js` filled `responseTimeMs` on the failure path too, so a pass that got
// no bytes back carried a number: the elapsed time *we waited*, printed as a
// latency. Measured with the real CLI against a closed port and a server that
// accepts the connection and never answers, no code changed:
//
//   Status:   N/A — DOWN
//   Response: 15ms          ← connection refused: nothing answered, in 15 ms
//   Status:   N/A — DOWN
//   Response: 2008ms        ← timed out: DEFAULT_TIMEOUT_MS plus overhead
//
//   | http://kunde.dk/ | DOWN | 0% (2 checks, 2 failed) | … | 5 ms     | … |
//   | http://kunde.dk/ | DOWN | 0% (1 checks, 1 failed) | … | 15002 ms | … |
//
// `5 ms` is the fastest a site can look while being unreachable, and `15002 ms`
// is not a latency at all — it is the timeout budget, so the number says "slow"
// where the truth is "we gave up". Both in the document a bureau forwards.
//
// Two fixes, and the second is the one with a decision in it. The producer stops
// inventing a number. But `recordPass` keeps the *previous* measurement, because
// a pass that measured nothing is not a pass that unmeasured something — so a
// site that answered in 22 ms and is now refused still has `lastResponseMs: 22`
// in its state entry, and the cell would quote it. Left alone, the Response cell
// would describe an earlier pass in a row whose every other cell describes the
// latest one. `readResponseMs` is that decision, and it is the same rule the row
// applies everywhere: no status code means no response, and no response has no
// duration.

test('a pass that got no response measures no response time', async () => {
  // The root cause, at the level it happens, against a real closed port: the
  // value is asked of `checkReachability` itself, so this is about what the
  // producer produced — not about a surface downstream choosing to ignore it.
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const refused = await checkReachability(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 });
  assert.equal(refused.reachable, false);
  assert.equal(refused.statusCode, null);
  assert.equal(refused.responseTimeMs, null, 'nothing answered, so there is no response time to report');
  assert.ok(refused.error, 'the reason is still reported — as a reason, not as a duration');
});

test('a duration the last pass never measured is not shown in the report', () => {
  const state = proState({
    // Refused: the previous pass answered in 22 ms, this one got nothing.
    'https://kunde.dk/': { wasUp: false, lastStatus: null, checks: 9, checksUp: 8, lastChecked: NOW.toISOString(), lastResponseMs: 22 },
    // A 500 *is* a response, so its duration must survive untouched.
    'https://fejl.dk/': { wasUp: false, lastStatus: 500, checks: 4, checksUp: 0, lastChecked: NOW.toISOString(), lastResponseMs: 143 },
  });
  const report = buildReport(state, { now: NOW });
  const refused = report.sites.find(s => s.url === 'https://kunde.dk/');
  const errored = report.sites.find(s => s.url === 'https://fejl.dk/');

  assert.equal(refused.responseMs, null, 'a number from an earlier pass is not this pass\'s measurement');
  assert.equal(errored.responseMs, 143, 'a response that arrived keeps its duration');

  const markdown = renderReportMarkdown(report);
  const refusedRow = markdown.split('\n').find(l => l.startsWith('| https://kunde.dk/'));
  const erroredRow = markdown.split('\n').find(l => l.startsWith('| https://fejl.dk/'));
  assert.match(refusedRow, /\| — \|/, 'the cell falls back to the dash its sibling cells use');
  assert.doesNotMatch(refusedRow, /22 ms/, 'and the row must not quote the earlier pass');
  assert.match(erroredRow, /143 ms/, 'a measured duration is not the thing being fixed');

  const json = JSON.parse(renderReportJson(report));
  assert.equal(json.sites.find(s => s.url === 'https://kunde.dk/').responseMs, null, '--json agrees with the cell');
});

test('readResponseMs answers from the two facts, not from the number alone', () => {
  for (const [entry, expected] of [
    [{ lastStatus: 200, lastResponseMs: 187 }, 187],
    [{ lastStatus: 500, lastResponseMs: 143 }, 143],
    // No status code: no response, whatever the state file still remembers.
    [{ lastStatus: null, lastResponseMs: 22 }, null],
    [{ lastResponseMs: 22 }, null],
    // A status code we cannot read is not a response either.
    [{ lastStatus: -1, lastResponseMs: 22 }, null],
    [{ lastStatus: 9999, lastResponseMs: 22 }, null],
    // A measured zero is a measurement, and an unreadable duration is not.
    [{ lastStatus: 200, lastResponseMs: 0 }, 0],
    [{ lastStatus: 200, lastResponseMs: -5 }, null],
    [{ lastStatus: 200, lastResponseMs: '42' }, null],
    [{ lastStatus: 200 }, null],
    [{}, null],
    [undefined, null],
  ]) {
    assert.equal(readResponseMs(entry), expected, JSON.stringify(entry));
  }
});

test('the duration has one owner, and the failure path cannot invent one', () => {
  // Same trap as the verdict and the status code: a rule copied beside the owner
  // is only visible in the source, and the measured failure is in the document
  // a customer reads. The report may not read `lastResponseMs` itself.
  const readSrc = name => readFileSync(join(ROOT, 'src', name), 'utf8');
  const reportSrc = readSrc('report.js');
  const statusSrc = readSrc('status.js');
  const pingSrc = readSrc('checkers/ping.js');

  // The reading, not the writing: `recordPass` is the one place that *stores*
  // `lastResponseMs`, and it stays there. What the report may not do is read the
  // stored number to decide what to print.
  assert.doesNotMatch(reportSrc, /nonNegative\(entry\.lastResponseMs\)/, 'the report must ask readResponseMs(), not read the number');
  assert.equal((reportSrc.match(/responseMs:/g) || []).length, 1, 'one place decides what the cell shows');
  assert.match(reportSrc, /responseMs: readResponseMs\(entry\)/, 'and it asks the owner');
  assert.equal((statusSrc.match(/export function readResponseMs\(/g) || []).length, 1, 'one owner');

  // The producer. A duration on the no-response path is the bug itself, and it
  // needs no report to be visible: `check` printed it, and so does every Action
  // summary built from `check --json`.
  assert.doesNotMatch(pingSrc, /responseTimeMs: Date\.now\(\) - start,\s*\n\s*finalUrl: null/, 'the no-response path must not report a duration');
  assert.equal((pingSrc.match(/responseTimeMs: Date\.now\(\) - start/g) || []).length, 1, 'only a real response times itself');
  assert.match(pingSrc, /responseTimeMs: null,[\s\S]{0,80}finalUrl: null/, 'the no-response path says it measured nothing');
});

// ---------------------------------------------------------------------------
// A window column that covers less than the window it names (measured, 2026-09-26)
// ---------------------------------------------------------------------------
//
// `95.83%` and `30 d` appeared in one cell, and the footnote defines the column
// as "the passes recorded in the last 30 days". A customer reads that as 30
// days. Two of them were never monitored — the agency's cron was dead — and the
// only warning was the word "recorded", in a cell among other parentheses.
//
// The named line needs two facts the report already has, or it cries wolf: a
// site added *inside* the window has 3 recorded days out of 30 and is not a gap,
// and a history file that only started recording yesterday says nothing about
// the 28 days before it, however long the agency has monitored the site.

const GAP_NOW = new Date('2026-09-25T09:30:00.000Z');

function dayKeyAgo(daysAgo, now) {
  return new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A history file for these URLs, holding every day from `from` days ago back to
 * `to` days ago, minus the days `missing` names for that URL. The window is the
 * 30 day keys from today backwards, so `to: 30` is the one bucket that falls
 * outside it and `to: 6` is a file that started recording this week.
 */
function historyBetween(url, { from = 0, to = 30, missing = {} } = {}) {
  const urls = {};
  for (const u of url) {
    const gaps = missing[u] ?? [];
    urls[u] = {};
    for (let d = from; d <= to; d++) {
      if (gaps.includes(d)) continue;
      urls[u][dayKeyAgo(d, GAP_NOW)] = { checks: 48, failures: 2 };
    }
  }
  return { urls };
}

test('a site with missing days in the window is named, and one added inside it is not', () => {
  const FULL = 'https://fuld.dk/';
  const GAP = 'https://gab.dk/';
  const NEW = 'https://ny.dk/';
  const history = historyBetween([FULL, GAP, NEW], { missing: { [GAP]: [5, 6] } });
  // The new site is only present for its own three days, in the same file.
  for (const d of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) delete history.urls[NEW][dayKeyAgo(d, GAP_NOW)];
  const report = buildReport(proState({
    [FULL]: upEntry(),
    [GAP]: upEntry(),
    [NEW]: upEntry({ addedAt: dayKeyAgo(2, GAP_NOW) }),
  }), { now: GAP_NOW, history });
  const site = url => report.sites.find(s => s.url === url);

  assert.equal(site(GAP).windowGap, true, 'two whole days missing inside the window');
  assert.equal(site(GAP).windowMissingDays, 2);
  assert.equal(site(GAP).windowRecordedDays, 28);
  assert.equal(site(FULL).windowGap, false, 'a window with every day is not a gap');
  assert.equal(site(FULL).windowMissingDays, null);
  assert.equal(site(NEW).windowGap, false, 'a site added inside the window has no days to be missing');
  assert.equal(site(NEW).windowMissingDays, null);
  assert.equal(report.summary.windowGaps, 1, 'and the document counts it');

  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /Fewer days recorded than the window for 1 site/);
  assert.match(markdown, /https:\/\/gab\.dk\/ \(28 of 30 d\)/, 'both counts, so the reader can see the shortfall');
  assert.match(markdown, /1 with an incomplete window/, 'and the summary line says so');
  const json = JSON.parse(renderReportJson(report));
  assert.equal(json.summary.windowGaps, 1, 'the machine surface agrees with the document');
});

test('a history file that only started recording inside the window is not a gap', () => {
  // The upgrade case: monitored for a year, daily buckets since last week. The
  // files cannot support a claim about the days before the file existed, and
  // the report must not make one — a false accusation in a customer document is
  // worse than a silent column.
  const A = 'https://a.dk/';
  const B = 'https://b.dk/';
  const history = historyBetween([A, B], { to: 6 });
  const report = buildReport(proState({
    [A]: upEntry({ addedAt: '2025-11-01T00:00:00.000Z' }),
    [B]: upEntry({ addedAt: '2025-11-01T00:00:00.000Z' }),
  }), { now: GAP_NOW, history });
  assert.deepEqual(report.sites.map(s => s.windowGap), [false, false]);
  assert.equal(report.summary.windowGaps, 0);
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /Fewer days recorded than the window/);
  assert.doesNotMatch(markdown, /incomplete window/, 'not even in the summary line');
});

test('the window shortfall is one owner, and the report asks it', () => {
  const readSrc = name => readFileSync(join(ROOT, 'src', name), 'utf8');
  const reportSrc = readSrc('report.js');
  const historySrc = readSrc('history.js');
  // A duplicated rule here is invisible to a behavioural test: the original
  // code re-inserted as a second copy gives identical output on every fixture.
  assert.equal((historySrc.match(/export function windowCoverage\(/g) || []).length, 1, 'one owner');
  assert.equal((reportSrc.match(/windowCoverage\(\{/g) || []).length, 1, 'and it is asked once');
  assert.doesNotMatch(reportSrc, /recordedDays < windowDays/, 'the report may not re-derive the rule');
  assert.match(reportSrc, /windowGap: coverage\.gap/, 'the cell and the line come from the same answer');
  assert.match(historySrc, /passAge\(monitoringSince, now\)\.passMs/, 'the time is asked of its owner, not parsed here');
  assert.doesNotMatch(historySrc, /Date\.parse\(monitoringSince/, 'and never parsed locally');
});
