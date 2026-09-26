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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, counters, nonNegative, recordPass, renderReportJson, renderReportMarkdown, siteBuckets, uptimePercent } from '../src/report.js';
import { readEntry, verdictFor } from '../src/status.js';
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
  return {
    license: { key: LICENSE_KEY, instance: 'deskuptime-agency', plan: 'pro', status: 'active' },
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
  assert.deepEqual(Object.keys(built).sort(), ['generatedAt', 'sites', 'summary', 'title', 'tool', 'windowDays']);
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
  // a hand-edited state file cannot invent a warning either.
  for (const bogus of [null, undefined, -3, NaN, '9', Infinity]) {
    const site = buildReport(proState({ 'https://acme.dk/': upEntry({ sslValidDays: bogus }) }), { now: NOW }).sites[0];
    assert.equal(site.sslExpiringSoon, false, `${bogus} was treated as expiring`);
    assert.equal(site.sslDaysRemaining, null);
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
});
