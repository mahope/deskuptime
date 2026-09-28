/**
 * P1-77 — the client report said a site had never been checked, on a row that
 * carried the pass that checked it.
 *
 * `uptimePercent` returns `null` whenever the check counters are zero, and a
 * counter can be zero for two different reasons: no pass ran, or no pass is
 * *counted* — the `checks`/`checksUp` pair is not in the file. The cell turned
 * both into `— (no completed pass)`, which is a claim about history.
 *
 * Measured 2026-09-28 with the real `report` over a real `state.json` holding a
 * site with no counter pair, the shape a machine gets the first time it runs a
 * pass written by a version that did not have the counters, plus one site that
 * genuinely has never been checked. Pro from the passthrough stub, nothing
 * stubbed but the license server:
 *
 *   | https://never.dk/          | not checked yet | — (no completed pass) | … | —      | — | — | —                   |
 *   | http://127.0.0.1:57311/    | UP (200)        | — (no completed pass) | … | 120 ms | — | stable · 100 bytes | 2026-09-27 02:00 UTC |
 *   **2 site(s) · 1 up · 0 down · 1 not checked · 0 checks · 0 failed**
 *
 * Row two says a pass completed a day ago — a status, a response time and a
 * last-check time all say so — and in the same row says no pass ever completed.
 * The next real pass on that same file then measured `100% (1 check)`, so the
 * pass in row two did happen: it was the counter that was missing, and nothing
 * in the cell said which of the two was absent.
 *
 * The fix is one owner and two sentences, asked of the same `passRecorded` fact
 * `unknownNote` and the summary line already use. A site with no recorded pass
 * keeps the old words byte for byte — that claim is true there — and only a row
 * that already carries a pass gets the one that names the file. No status, exit
 * code, uptime number, cell or summary count moves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, counterNotRecorded, recordPass, renderReportMarkdown, uptimePercent } from '../src/report.js';
import { emptyHistory } from '../src/history.js';

const NOW = new Date('2026-09-28T09:00:00.000Z');
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';
const COUNTERLESS = 'http://127.0.0.1:57311/';
const NEVER = 'https://never.dk/';

function daysAgoIso(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
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

/** A pass ran a day ago; the file holds no `checks`/`checksUp` pair. */
function counterless(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgoIso(1),
    lastResponseMs: 120,
    lastContentLength: 100,
    lastContentReadAt: daysAgoIso(1),
    lastFinalUrl: COUNTERLESS,
    addedAt: daysAgoIso(200),
    ...overrides,
  };
}

function markdownFor(urls) {
  return renderReportMarkdown(buildReport(proState(urls), { now: NOW, history: emptyHistory() }));
}

/** The one table row for `url`, so a phrase in the footnote cannot satisfy a cell. */
function rowFor(markdown, url) {
  return markdown.split('\n').find(line => line.startsWith('|') && line.includes(url));
}

test('a row that carries a pass does not claim no pass ever completed', () => {
  const markdown = markdownFor({ [COUNTERLESS]: counterless() });
  const row = rowFor(markdown, COUNTERLESS);

  // The two claims that cannot both be true, measured before the fix.
  assert.match(row, /UP \(200\)/);
  assert.match(row, /2026-09-27 09:00 UTC/);
  // …and which file is behind the empty cell.
  assert.match(row, /— \(no counter in the state file\)/);
  assert.doesNotMatch(row, /no completed pass/);
});

test('a site that really has never been checked keeps the old sentence, byte for byte', () => {
  const markdown = markdownFor({ [NEVER]: { addedAt: daysAgoIso(3), wasUp: null, lastFinalUrl: NEVER } });
  const row = rowFor(markdown, NEVER);

  assert.match(row, /not checked yet/);
  assert.match(row, /— \(no completed pass\)/);
  assert.doesNotMatch(row, /no counter in the state file/);
});

test('both sentences in one report, one per site, so the cell is not a fixed phrase', () => {
  const markdown = markdownFor({
    [COUNTERLESS]: counterless(),
    [NEVER]: { addedAt: daysAgoIso(3), wasUp: null, lastFinalUrl: NEVER },
  });

  assert.match(rowFor(markdown, COUNTERLESS), /no counter in the state file/);
  assert.match(rowFor(markdown, NEVER), /no completed pass/);
  // The footnote defines the column, so it has to name both cases too — the old
  // wording made the false claim for the whole column, not only for one cell.
  assert.match(markdown, /names the state file's missing check counter instead/);
  assert.match(markdown, /`counterNotRecorded` in `--json` is the same fact as a boolean/);
});

test('the owner is the cell, and it needs both facts, not one', () => {
  // The measured case: a pass is on the row and the pair is not in the file.
  assert.equal(counterNotRecorded({ passRecorded: true }), true);
  assert.equal(counterNotRecorded({ passRecorded: true, checks: 'many', checksUp: null }), true);
  assert.equal(counterNotRecorded({ passRecorded: true, checks: -1, checksUp: 3 }), true);
  // No pass means no missing counter, even with no pair in the file: the old
  // sentence is true there, and the owner must not turn it into a file problem.
  assert.equal(counterNotRecorded({ passRecorded: false }), false);
  assert.equal(counterNotRecorded({}), false);
  // A pair that is present is never "not recorded", whatever it holds.
  assert.equal(counterNotRecorded({ passRecorded: true, checks: 0, checksUp: 0 }), false);
  assert.equal(counterNotRecorded({ passRecorded: true, checks: 12, checksUp: 11 }), false);
});

test('a counter that is present and zero keeps the sentence it always had', () => {
  // A third state, and the one this fix must NOT rename: `checks: 0` written
  // *with* the pair. Nothing DeskUptime writes can produce it — `recordPass`
  // increments both counters and writes them with the pass — so it is a
  // hand-edited file, which `counters()` already clamps and repairs on the next
  // pass. Naming a missing file here would trade one wrong claim for another.
  const report = buildReport(
    proState({ [COUNTERLESS]: counterless({ checks: 0, checksUp: 0 }) }),
    { now: NOW, history: emptyHistory() },
  );
  const row = rowFor(renderReportMarkdown(report), COUNTERLESS);

  assert.equal(uptimePercent({ checks: 0, checksUp: 0 }), null);
  assert.equal(report.sites[0].counterNotRecorded, false);
  assert.match(row, /— \(no completed pass\)/);
  assert.doesNotMatch(row, /no counter in the state file/);
});

test('the next real pass on that file ends the case, which is what makes it reachable', () => {
  // The measured journey: no counter in the file, then one real pass on the same
  // entry. `recordPass` writes the pair with the pass, so the cell goes from
  // naming the file to printing a share — and nothing else about the row moves.
  const entry = counterless();
  assert.equal(uptimePercent(entry), null);
  recordPass(entry, { healthy: true, responseTimeMs: 120 });

  assert.equal(entry.checks, 1);
  assert.equal(entry.checksUp, 1);
  assert.equal(uptimePercent(entry), 100);
  const row = rowFor(markdownFor({ [COUNTERLESS]: entry }), COUNTERLESS);
  assert.match(row, /100% \(1 check\)/);
  assert.doesNotMatch(row, /no counter in the state file/);
});

test('the JSON carries the same fact as a boolean a consumer can branch on', () => {
  const report = buildReport(
    proState({
      [COUNTERLESS]: counterless(),
      [NEVER]: { addedAt: daysAgoIso(3), wasUp: null, lastFinalUrl: NEVER },
      'https://talt.dk/': counterless({ lastFinalUrl: 'https://talt.dk/', checks: 12, checksUp: 11 }),
    }),
    { now: NOW, history: emptyHistory() },
  );

  const byUrl = Object.fromEntries(report.sites.map(site => [site.url, site]));
  assert.equal(byUrl[COUNTERLESS].counterNotRecorded, true);
  assert.equal(byUrl[COUNTERLESS].uptimePercent, null);
  assert.equal(byUrl[NEVER].counterNotRecorded, false, 'no pass means no missing counter');
  assert.equal(byUrl[NEVER].uptimePercent, null);
  // A site whose counters are present is not the same case, and must not say it is.
  assert.equal(byUrl['https://talt.dk/'].counterNotRecorded, false);
  assert.equal(byUrl['https://talt.dk/'].uptimePercent, 91.67);
  // Always present, so a consumer can read it without proving it can be absent.
  for (const site of report.sites) {
    assert.equal(typeof site.counterNotRecorded, 'boolean', `${site.url} has no boolean`);
  }
});

test('an unreadable pass time is still a recorded pass, so it is the counter that is named', () => {
  // `lastChecked` that cannot be read is read as `null` by `readPassTime`, and
  // P1-14 exists so that cannot collapse into "no pass". This locks the same
  // boundary on the new field: the counter is what is missing, not the pass.
  const markdown = markdownFor({ [COUNTERLESS]: counterless({ lastChecked: 'not-a-date' }) });
  const row = rowFor(markdown, COUNTERLESS);
  assert.match(row, /— \(no counter in the state file\)/);
  assert.doesNotMatch(row, /no completed pass/);
});

test('nothing else on the row moves', () => {
  // The status, the response time, the content reading and the last-check time
  // are read from the same state file and must be identical before and after:
  // only the empty uptime cell gains a sentence.
  const withCounters = markdownFor({
    [COUNTERLESS]: counterless({ checks: 12, checksUp: 11 }),
  });
  const withoutCounters = markdownFor({ [COUNTERLESS]: counterless() });
  const row = (markdown) => markdown.split('\n').find(line => line.includes(COUNTERLESS));

  const [a, b] = [row(withCounters), row(withoutCounters)];
  assert.match(a, /91\.67% \(12 checks, 1 failed\)/);
  assert.match(b, /— \(no counter in the state file\)/);
  for (const shared of [/UP \(200\)/, /120 ms/, /stable · 100 bytes/, /2026-09-27 09:00 UTC/]) {
    assert.match(a, shared);
    assert.match(b, shared, `${shared} moved when only the counter was missing`);
  }
  // The summary line counts the counters it has, and both reports say the same.
  assert.match(withCounters, /1 up · 0 down · 12 checks · 1 failed/);
  assert.match(withoutCounters, /1 up · 0 down · 0 checks · 0 failed/);
  assert.equal(buildReport(proState({ [COUNTERLESS]: counterless() }), { now: NOW, history: emptyHistory() }).summary.up, 1);
});
