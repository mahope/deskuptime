/**
 * history.js — the daily buckets behind the client report's "last 30 days".
 *
 * What these tests protect:
 *   - the history is bounded, so a watch loop running for a year cannot grow the
 *     file without limit, and a hand-edited file cannot produce negative uptime;
 *   - a redirected state file drags the history with it — history can never be
 *     written to the real home directory by a test or a second installation;
 *   - the window figure uses the same uptime definition as the lifetime figure;
 *   - a site with no recorded day in the window shows —, never 100 %;
 *   - writing history can never take down the monitoring pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WINDOW_DAYS,
  HISTORY_DAYS,
  MAX_HISTORY_URLS,
  dayKey,
  emptyHistory,
  getHistoryFile,
  loadHistory,
  normalizeHistory,
  pruneHistory,
  recordHistoryPass,
  saveHistory,
  windowSummary,
} from '../src/history.js';
import { buildReport, renderReportJson, renderReportMarkdown, uptimePercent } from '../src/report.js';
import { getStateFile, runPass } from '../src/watch.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';
const NOW = new Date('2026-09-25T09:30:00.000Z');
const URL_A = 'https://acme.example/';
const URL_B = 'https://beta.example/';

function daysAgo(count, from = NOW) {
  return new Date(from.getTime() - count * 24 * 60 * 60 * 1000);
}

function tempHome(t, prefix = 'deskuptime-history-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** A store with `days` recorded days for a URL, all UP unless stated. */
function historyWithDays(url, days, { failures = 0, now = NOW } = {}) {
  const history = emptyHistory();
  for (let index = days - 1; index >= 0; index--) {
    const at = daysAgo(index, now);
    const bucket = recordHistoryPass(history, url, { healthy: true }, { now: at });
    // The `failures` most recent days (index 0 = today) are DOWN instead of UP.
    if (index < failures) bucket.failures = 1;
  }
  return history;
}

test('the history file sits beside the state file, on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const env of [{ HOME: '/home/agency' }, { HOME: '/home/agency', USERPROFILE: 'C:\\Users\\agency' }]) {
      const options = { env, platform };
      assert.equal(
        dirname(getHistoryFile(options)),
        dirname(getStateFile(options)),
        `history and state ended up in different directories on ${platform}`,
      );
    }
  }
});

test('a redirected state file drags the history with it', () => {
  const history = emptyHistory();
  recordHistoryPass(history, URL_A, { healthy: true }, { now: NOW });
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-history-beside-'));
  try {
    saveHistory(history, { stateFile: join(dir, 'state.json') });
    const files = readdirSync(dir);
    assert.deepEqual(files, ['history.json'], `unexpected files beside the state: ${files.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pass is counted even when it failed, and days never overlap', () => {
  const history = emptyHistory();
  recordHistoryPass(history, URL_A, { healthy: true }, { now: new Date('2026-09-25T23:30:00Z') });
  recordHistoryPass(history, URL_A, { healthy: false }, { now: new Date('2026-09-26T00:30:00Z') });
  recordHistoryPass(history, URL_A, { healthy: false }, { now: new Date('2026-09-26T12:00:00Z') });
  assert.deepEqual(history.urls[URL_A]['2026-09-25'], { checks: 1, failures: 0 });
  assert.deepEqual(history.urls[URL_A]['2026-09-26'], { checks: 2, failures: 2 });
  assert.equal(Object.keys(history.urls[URL_A]).length, 2, 'UTC days must not be merged or duplicated');
  assert.equal(dayKey('2026-09-25T23:59:59Z'), '2026-09-25');
});

test('a day bucket holds counters and nothing else', () => {
  const history = emptyHistory();
  const bucket = recordHistoryPass(
    history,
    URL_A,
    { healthy: false, statusCode: 500, error: 'HTTP 500', content: { hash: 'abc', contentLength: 12 }, ssl: { validDays: 3 } },
    { now: NOW },
  );
  assert.deepEqual(Object.keys(bucket).sort(), ['checks', 'failures']);
  assert.ok(!JSON.stringify(history).includes('abc'), 'a content hash was stored in the history');
  assert.ok(!JSON.stringify(history).includes('500'), 'a status code or error string was stored in the history');
});

test('retention keeps the window plus slack, and forgets emptied URLs', () => {
  const history = historyWithDays(URL_A, HISTORY_DAYS + 10);
  recordHistoryPass(history, URL_B, { healthy: true }, { now: daysAgo(HISTORY_DAYS + 5) });
  pruneHistory(history, { now: NOW });
  assert.equal(Object.keys(history.urls).length, 1, 'a URL with no day left in the window must be dropped');
  assert.deepEqual(Object.keys(history.urls[URL_A]).sort(), Object.keys(history.urls[URL_A]).sort());
  assert.equal(Object.keys(history.urls[URL_A]).length, HISTORY_DAYS);
  assert.equal(history.urls[URL_A][dayKey(NOW)].checks, 1, 'today must survive pruning');
  assert.ok(!history.urls[URL_A][dayKey(daysAgo(HISTORY_DAYS))], 'a day outside the window survived');
});

test('the URL count is capped, so dropping sites cannot grow the file forever', () => {
  const history = emptyHistory();
  for (let index = 0; index < MAX_HISTORY_URLS + 10; index++) {
    recordHistoryPass(history, `https://site-${index}.example/`, { healthy: true }, { now: NOW });
  }
  pruneHistory(history, { now: NOW });
  assert.equal(Object.keys(history.urls).length, MAX_HISTORY_URLS);
  assert.ok(history.urls[`https://site-${MAX_HISTORY_URLS + 9}.example/`], 'the newest URLs must be the ones kept');
});

test('a hand-edited history file reads as empty instead of crashing or lying', () => {
  for (const junk of [null, 'text', [], 42, { urls: [] }, { urls: { 'https://x.example/': 'no' } }]) {
    assert.deepEqual(normalizeHistory(junk), emptyHistory(), `not normalized: ${JSON.stringify(junk)}`);
  }
  const cleaned = normalizeHistory({
    version: 1,
    urls: {
      [URL_A]: {
        '2026-09-25': { checks: 4, failures: 1 },
        yesterday: { checks: 4 },
        '2026-09-24': { checks: 0, failures: 0 },
        '2026-09-23': { checks: -5, failures: 99 },
        '2026-09-22': 'not an object',
      },
      '': { '2026-09-25': { checks: 1 } },
    },
  });
  assert.deepEqual(cleaned.urls, { [URL_A]: { '2026-09-25': { checks: 4, failures: 1 } } });
});

test('failures above the number of checks cannot produce negative uptime', () => {
  const history = normalizeHistory({ urls: { [URL_A]: { '2026-09-25': { checks: 2, failures: 9 } } } });
  const summary = windowSummary(history, URL_A, { now: NOW, uptimePercent });
  assert.equal(summary.failures, 2);
  assert.equal(summary.uptimePercent, 0);
});

test('the window counts only recorded days inside it, with the same uptime rule', () => {
  const history = historyWithDays(URL_A, 40, { failures: 2 });
  const summary = windowSummary(history, URL_A, { now: NOW, uptimePercent });
  assert.equal(summary.days, DEFAULT_WINDOW_DAYS);
  assert.equal(summary.checks, DEFAULT_WINDOW_DAYS);
  assert.equal(summary.failures, 2);
  assert.equal(summary.from, dayKey(daysAgo(DEFAULT_WINDOW_DAYS - 1)));
  assert.equal(summary.to, dayKey(NOW));
  // 28 UP + 2 DOWN out of 30 — the lifetime figure uses the same rounding.
  assert.equal(summary.uptimePercent, uptimePercent({ checks: 30, checksUp: 28 }));
});

test('a wider window than the recorded history is honest about it', () => {
  const history = historyWithDays(URL_A, 3);
  assert.equal(windowSummary(history, URL_A, { now: NOW, uptimePercent }).days, 3);
  assert.equal(windowSummary(history, URL_A, { days: 1, now: NOW, uptimePercent }).days, 1);
  assert.equal(windowSummary(history, URL_B, { now: NOW, uptimePercent }), null);
  assert.equal(windowSummary(emptyHistory(), URL_A, { now: NOW, uptimePercent }), null);
  assert.equal(windowSummary(undefined, URL_A, { now: NOW, uptimePercent }), null);
});

test('a day from the future is not counted as uptime', () => {
  const history = historyWithDays(URL_A, 2);
  recordHistoryPass(history, URL_A, { healthy: true }, { now: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000) });
  assert.equal(windowSummary(history, URL_A, { now: NOW, uptimePercent }).days, 2);
});

// P1-32's own measurement, on the real report. `passDayInWindow` used to parse
// `lastChecked` itself and decide "is this pass in the window?" by comparing
// day keys, so a clock a few hours fast was answered as though the pass had
// happened: the same column said two different sentences for one condition,
// split only by whether the skew crossed midnight UTC.
test('a pass ahead of the clock is never a day inside the window', () => {
  // Recorded days, but none of them inside any of the three windows below, so
  // the window reports no recorded day and the only thing that can decide the
  // sentence is what the state file claims.
  const stale = historyWithDays(URL_A, 3, { now: daysAgo(40) });
  // P1-30's counterweight, kept and pinned at both sides of the midnight edge.
  // +19 d is the skew P1-30 measured; +2 h and +23 h share their UTC day with
  // "now", which is the case the old day comparison got wrong.
  for (const aheadMs of [2 * 3600e3, 6 * 3600e3, 23 * 3600e3, 19 * 86400e3]) {
    const lastChecked = new Date(NOW.getTime() + aheadMs).toISOString();
    for (const days of [1, 7, 30]) {
      // `null` is the counterweight: no recorded day in the window, and no
      // claim that a recorded pass is missing from the history file — because
      // a pass dated in the future has no day that belongs to a past window,
      // so there is nothing to be missing.
      assert.equal(
        windowSummary(stale, URL_A, { days, now: NOW, uptimePercent, lastChecked }),
        null,
        `skew +${aheadMs}ms produced a window summary at --days ${days}`,
      );
    }
  }
});

test('a pass the history really is missing is still named as missing', () => {
  // The counterpart of the test above, and the reason it could be written: an
  // honest pass 2 h old with no bucket for today is a real disagreement between
  // two files, and the report must keep saying so.
  const lastChecked = new Date(NOW.getTime() - 2 * 3600e3).toISOString();
  const summary = windowSummary(historyWithDays(URL_A, 3, { now: daysAgo(40) }), URL_A, { days: 1, now: NOW, uptimePercent, lastChecked });
  assert.equal(summary.passNotRecorded, true);
  assert.equal(summary.uptimePercent, null);
});

test('the history file is written 0600, atomically, and a corrupt one is ignored', (t) => {
  const home = tempHome(t);
  const historyFile = join(home, '.deskuptime', 'history.json');
  const history = historyWithDays(URL_A, 2);
  saveHistory(history, { historyFile });
  if (process.platform !== 'win32') {
    assert.equal(statSync(historyFile).mode & 0o777, 0o600, 'the history file must not be world-readable');
    assert.equal(statSync(join(home, '.deskuptime')).mode & 0o777, 0o700);
  }
  assert.deepEqual(readdirSync(join(home, '.deskuptime')), ['history.json'], 'a temporary file was left behind');
  assert.deepEqual(loadHistory({ historyFile }).urls, history.urls);

  writeFileSync(historyFile, '{"urls": {"https://acme.example/": {');
  assert.deepEqual(loadHistory({ historyFile }), emptyHistory(), 'a half-written file must read as empty');
  assert.equal(loadHistory({ historyFile: join(home, 'missing.json') }).urls && Object.keys(loadHistory({ historyFile: join(home, 'missing.json') }).urls).length, 0);
});

test('the real monitoring pass records the history beside the state', async (t) => {
  const home = tempHome(t);
  const stateFile = join(home, '.deskuptime', 'state.json');
  const state = { urls: { [URL_A]: { wasUp: null, addedAt: NOW.toISOString() } } };
  const healthy = (url) => ({ url, healthy: true, statusCode: 200, responseTimeMs: 10, timestamp: NOW.toISOString() });
  await runPass(state, { stateFile, check: healthy, now: NOW });
  await runPass(state, { stateFile, check: healthy, now: daysAgo(1) });
  await runPass(state, { stateFile, check: () => ({ url: URL_A, healthy: false, errorType: 'timeout', timestamp: NOW.toISOString() }), now: NOW });

  const history = loadHistory({ stateFile });
  assert.deepEqual(history.urls[URL_A][dayKey(NOW)], { checks: 2, failures: 1 });
  assert.equal(Object.keys(history.urls[URL_A]).length, 2);
  assert.ok(!readFileSync(stateFile, 'utf-8').includes('history'), 'the state file must not carry the history');
});

test('a history that cannot be written never takes down the pass', async (t) => {
  const home = tempHome(t);
  const stateFile = join(home, '.deskuptime', 'state.json');
  // A directory where the history file should be: rename(2) onto it fails.
  mkdirSync(join(home, '.deskuptime', 'history.json'), { recursive: true });
  const state = { urls: { [URL_A]: { wasUp: null } } };
  const pass = await runPass(state, {
    stateFile,
    returnResults: true,
    check: url => ({ url, healthy: true, statusCode: 200, responseTimeMs: 5, timestamp: NOW.toISOString() }),
    now: NOW,
  });
  assert.equal(pass.results.length, 1, 'the pass did not return its results');
  assert.ok(readFileSync(stateFile, 'utf-8').includes(URL_A), 'the state was not saved');
});

test('the report shows the window next to the lifetime figure', () => {
  const state = {
    urls: {
      [URL_A]: { wasUp: true, lastStatus: 200, checks: 100, checksUp: 100, lastChecked: NOW.toISOString() },
      [URL_B]: { wasUp: true, lastStatus: 200, checks: 10, checksUp: 10, lastChecked: NOW.toISOString() },
    },
  };
  const history = historyWithDays(URL_A, 30, { failures: 3 });
  const report = buildReport(state, { title: 'Acme', now: NOW, history });
  const [a, b] = report.sites;
  assert.equal(a.url, URL_A);
  assert.equal(a.uptimePercent, 100, 'the lifetime figure is unchanged');
  assert.equal(a.window.uptimePercent, 90, '30 recorded days with 3 failures');
  assert.equal(a.window.days, 30);

  // P1-30: this used to assert `— (no pass in the last 30 d)` for B, whose
  // `lastChecked` is NOW — the report was claiming there had been no recent pass
  // about a site whose own row showed a check from this very second. B has no
  // recorded *day*, so the column is still a dash, and it now names the file
  // that is missing the pass instead of making a claim about the site.
  assert.equal(b.window.uptimePercent, null, 'a site with no recorded day has no share, not 100 %');
  assert.equal(b.window.passNotRecorded, true);
  const markdown = renderReportMarkdown(report);
  assert.ok(markdown.includes('| Uptime (all) | Uptime (window) |'), 'the window column is missing');
  assert.ok(markdown.includes('90% (30 recorded d, 30 checks, 3 failed)'));
  assert.ok(markdown.includes('— (last check missing from the history file)'), 'a missing window must be shown, not guessed');
  assert.ok(!markdown.includes('— (no pass in the last 30 d)'), 'and must not claim the site went unmonitored');
  assert.ok(markdown.includes('the last 30 days'), 'the report must explain what the window covers');
  assert.equal(report.windowDays, DEFAULT_WINDOW_DAYS);

  const wide = renderReportMarkdown(buildReport(state, { now: NOW, history, windowDays: 7 }));
  assert.ok(wide.includes('the last 7 days'), 'the window length must follow --days');
});

test('the report window is the same numbers whether it is asked for or not', () => {
  const state = { urls: { [URL_A]: { wasUp: true, checks: 5, checksUp: 5 } } };
  const history = historyWithDays(URL_A, 30, { failures: 15 });
  const withDefault = buildReport(state, { now: NOW, history });
  const withExplicit = buildReport(state, { now: NOW, history, windowDays: DEFAULT_WINDOW_DAYS });
  assert.deepEqual(withDefault.sites[0].window, withExplicit.sites[0].window);
  assert.equal(withDefault.sites[0].window.uptimePercent, 50);
  assert.ok(!JSON.stringify(withDefault).includes('history'), 'the raw history must not be embedded in the report');
  assert.ok(!renderReportJson(withDefault).includes(LICENSE_KEY));
});

test('--days is validated instead of silently ignored', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({
    license: { key: LICENSE_KEY, instance: 'deskuptime-agency', plan: 'pro', status: 'active', validatedAt: NOW.toISOString() },
    urls: { [URL_A]: { wasUp: true, lastStatus: 200, checks: 4, checksUp: 4, lastChecked: NOW.toISOString() } },
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  for (const bad of ['0', 'abc', '1.5', '999', '', '30d']) {
    const failure = await run(process.execPath, [CLI, 'report', '--days', bad], { env }).then(() => null, error => error);
    assert.ok(failure, `--days ${bad} was accepted`);
    assert.match(failure.stderr, /--days must be a whole number between 1 and 35/, `--days ${bad}: ${failure.stderr}`);
  }
  // A value that looks like another flag is rejected as one, not read as a number.
  const negative = await run(process.execPath, [CLI, 'report', '--days', '-1'], { env }).then(() => null, error => error);
  assert.ok(negative, '--days -1 was accepted');
  assert.match(negative.stderr, /Unknown option: -1/);
  const missing = await run(process.execPath, [CLI, 'report', '--days'], { env }).then(() => null, error => error);
  assert.ok(missing, '--days without a value was accepted');
  assert.match(missing.stderr, /--days must be a whole number/);

  const good = await run(process.execPath, [CLI, 'report', '--days', '7'], { env });
  assert.match(good.stdout, /the last 7 days/);
  assert.match(good.stdout, /Uptime \(window\)/);
  assert.ok(!good.stdout.includes(LICENSE_KEY), 'the license key leaked into the CLI report');
  // No history file exists in this home, while the state file records a pass
  // from NOW: the report must still render, and it must name the missing file
  // rather than say the site was not monitored in the last 7 days (P1-30).
  assert.match(good.stdout, /last check missing from the history file/);
  assert.doesNotMatch(good.stdout, /no pass in the last 7 d/);
});
