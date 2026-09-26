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
import { buildReport, recordPass, renderReportJson, renderReportMarkdown, uptimePercent } from '../src/report.js';
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
  assert.ok(markdown.includes('1 up · 1 down · 110 checks · 2 failed'), markdown);
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
