/**
 * P1-76 — the client report counted checks on days the machine had stopped
 * checking the site, and named the opposite disagreement instead.
 *
 * The window column and the `Last check` column are read from two different
 * files: `history.json` for the window, `state.json` for the pass. P1-30 closed
 * one direction of that disagreement — the history file missing a pass the state
 * file knows ran, which printed `— (last check missing from the history file)`.
 * Its own comment says `lastChecked` "is only ever used to say that the history
 * file is missing a pass that demonstrably ran", so the other direction had no
 * reader at all.
 *
 * Measured 2026-09-28 with the real CLI over a real `state.json` and a real
 * `history.json`, Pro from the passthrough stub, nothing stubbed but the license
 * server. One site, whose newest pass was 8 days old, and ten recorded days of
 * 24 checks each:
 *
 *   | http://c.dk/ | UP (200) ⚠️ stale — last check 8 d ago | 100% (3 checks) | 100% (10 recorded d, 240 checks) | … |
 *   **3 site(s) · 1 up · 1 down · 17 checks · 4 failed · 1 stale (no check in the last 2 d)**
 *   **Monitoring data is stale for 1 site — no pass in the last 2 days:** http://c.dk/ (8 d)
 *
 * One row claiming 240 checks, a summary claiming no pass in two days, in the
 * document an agency forwards to the customer it bills. Neither number is
 * invented — each is what its own file holds — but a client cannot see which
 * file is behind, and the two cannot both be true. This is P1-30's class in the
 * one direction it did not cover, and it is the direction that reads as a boast.
 *
 * The fix is the mirror of `passNotRecorded`, in the same owner: whole recorded
 * days that postdate the newest pass the state file knows about. Whole days, so a
 * pass that is minutes late cannot put a line in a customer document. No status,
 * exit code, uptime number or existing cell moves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, renderReportMarkdown } from '../src/report.js';
import { windowSummary, emptyHistory, normalizeHistory } from '../src/history.js';

const NOW = new Date('2026-09-28T09:00:00.000Z');
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';
const STALE = 'https://kunde.dk/';
const FRESH = 'https://frisk.dk/';

function daysAgoIso(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dayKey(daysAgo) {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function proState(urls) {
  return {
    license: {
      key: LICENSE_KEY,
      instance: 'deskuptime-bureau',
      plan: 'pro',
      status: 'active',
      validatedAt: daysAgoIso(0),
    },
    urls,
  };
}

function entry(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgoIso(0),
    addedAt: daysAgoIso(30),
    checks: 10,
    checksUp: 10,
    ...overrides,
  };
}

/** `recordedDays` days of 24 checks, newest first. */
function historyWith(recordedDays) {
  const urls = {};
  for (let i = 0; i < recordedDays; i++) urls[dayKey(i)] = { checks: 24, failures: 0 };
  return normalizeHistory({ version: 1, urls: { [STALE]: urls } });
}

const share = ({ checks, checksUp }) => (checks ? Math.round((checksUp / checks) * 10000) / 100 : null);

test('a window that counts checks after the machine stopped is named, not printed as one measurement', () => {
  const history = historyWith(10);
  const report = buildReport(
    proState({ [STALE]: entry({ lastChecked: daysAgoIso(8), checks: 3, checksUp: 3 }) }),
    { now: NOW, history },
  );
  const markdown = renderReportMarkdown(report);

  // The two claims that cannot both be true, measured before the fix.
  assert.match(markdown, /stale — last check 8 d ago/);
  assert.match(markdown, /100% \(10 recorded d, 240 checks\)/);
  // And what says which one to believe. The window number itself is not
  // rewritten: it is what the history file holds, and hiding it would be a third
  // claim rather than a resolution of the first two.
  assert.match(markdown, /The two sources disagree for 1 site/);
  assert.match(markdown, /8 days of recorded checks after the last pass/);
  assert.match(markdown, /"Last check" column is the one to believe/);

  const site = report.sites.find(one => one.url === STALE);
  assert.equal(site.windowPassesAfter, 8);
  assert.equal(site.window.checks, 240, 'the recorded checks are not thrown away');
  assert.equal(site.window.days, 10);
});

test('the field is additive and the summary line is unchanged, so a machine consumer can branch on it', () => {
  const history = historyWith(10);
  const report = buildReport(
    proState({ [STALE]: entry({ lastChecked: daysAgoIso(8) }) }),
    { now: NOW, history },
  );
  assert.equal(report.summary.sites, 1);
  // The partition P1-13 fixed: the disagreement is not a new state, it is a
  // fact about two files, so no site moves out of `up` because of it.
  assert.equal(report.summary.stale, 1);
  assert.equal(report.sites[0].windowPassesAfter, 8);
  assert.ok('windowPassesAfter' in report.sites[0]);
});

test('the two files agreeing says nothing at all, byte for byte', () => {
  // The ordinary case is the one that must not change: a site whose newest pass
  // is today has no recorded day after it, whatever else is true.
  const history = historyWith(10);
  const report = buildReport(
    proState({
      [FRESH]: entry({ lastChecked: daysAgoIso(0) }),
      [STALE]: entry({ lastChecked: daysAgoIso(0) }),
    }),
    { now: NOW, history: normalizeHistory({ version: 1, urls: { [FRESH]: history.urls[STALE], [STALE]: history.urls[STALE] } }) },
  );
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /The two sources disagree/);
  for (const site of report.sites) assert.equal(site.windowPassesAfter, 0);
});

test('a pass that is minutes late is the same day, and does not name a disagreement', () => {
  // Day granularity is the whole guard: `passDayInWindow` gives the same day
  // key for 23:50 and 00:10, so a clock disagreeing with itself inside one day
  // cannot put a line in a document a customer reads.
  const history = historyWith(3);
  const justBeforeMidnight = new Date(`${dayKey(0)}T23:50:00.000Z`);
  const summary = windowSummary(history, STALE, {
    now: NOW,
    uptimePercent: share,
    lastChecked: justBeforeMidnight.toISOString(),
  });
  assert.equal(summary.passesAfterLastPass, 0, 'today is not after today');
  assert.equal(summary.days, 3);
});

test('one recorded day after the pass is one day, and the count is whole days only', () => {
  const history = historyWith(3);
  const summary = windowSummary(history, STALE, {
    now: NOW,
    uptimePercent: share,
    lastChecked: daysAgoIso(2),
  });
  assert.equal(summary.passesAfterLastPass, 2, 'today and yesterday are after a pass two days ago');
});

test('a pass older than the window is not evidence of anything, so it counts zero', () => {
  // Guessing here would be inventing a claim: the state file's pass is outside
  // the window entirely, and the report already names the age of the pass.
  const history = historyWith(3);
  const summary = windowSummary(history, STALE, {
    now: NOW,
    days: 1,
    uptimePercent: share,
    lastChecked: daysAgoIso(40),
  });
  assert.equal(summary.passesAfterLastPass, 0);
});

test('a history file with nothing recorded keeps the sibling flag, and never claims a disagreement', () => {
  // `emptyWindow` is the P1-30 direction. The mirror field is stated there too,
  // so a consumer branches on the field instead of on its absence — and a site
  // with no buckets cannot postdate anything.
  const empty = windowSummary(emptyHistory(), STALE, {
    now: NOW,
    uptimePercent: share,
    lastChecked: daysAgoIso(1),
  });
  assert.equal(empty.passNotRecorded, true);
  assert.equal(empty.passesAfterLastPass, 0);

  // A site the report has never checked has no pass day to compare against, so
  // there is no disagreement to state — and inventing one would be a claim
  // about a site nobody looked at.
  const never = windowSummary(emptyHistory(), STALE, { now: NOW, uptimePercent: share });
  assert.equal(never, null);
});
