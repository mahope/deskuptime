/**
 * P1-78 — the client report printed a page size with no age, while both terminal
 * lists named it. Three surfaces, one state file, one reading, three sentences.
 *
 * `content.js` skips a body over the 2 MiB limit and leaves `lastContentLength`
 * alone, so a pass can advance `lastChecked` while the size on the row is left
 * over from an earlier pass. `byteCountNote` in `status.js` has said so on the
 * two lists since 2026-09-27 — "3221225 bytes, read 5 d ago" — and the report's
 * Content cell printed the bare number instead. Measured 2026-09-28 with the real
 * CLI, a real `state.json` and a real report, Pro from the passthrough stub and
 * nothing stubbed but the license server:
 *
 *   report      | https://stor-side.dk/ | … | stable · 3221225 bytes | 2026-09-27 20:30 UTC |
 *   --status      ✅ up  https://stor-side.dk/ (200) @ 2026-09-27T20:30:53.552Z · 3221225 bytes, read 5 d ago
 *
 * The row's last column says the check was five hours old and the size column
 * reads as a measurement of that check. It is not: the page has not been *read*
 * for five days. In the document a client reads, `stable` is the claim that
 * nothing is wrong with the page now.
 *
 * The fix is one owner asked by a third caller: `contentBytesNote` is exported
 * and the cell appends its own `stable · ` to the same words the lists print, so
 * the decision has one implementation and the two placements differ only in the
 * prefix. A reading from today is unchanged, character for character.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, renderReportMarkdown } from '../src/report.js';
import { contentBytesNote, readContentChangeState } from '../src/status.js';
import { emptyHistory } from '../src/history.js';
import { readEntry } from '../src/status.js';

const NOW = new Date('2026-09-28T09:00:00.000Z');
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';
const AGED = 'https://stor-side.dk/';
const UNPLACEABLE = 'https://tidlos-laest.dk/';
const FRESH = 'https://daglig.dk/';

function daysAgoIso(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function proState(urls) {
  return {
    license: { key: LICENSE_KEY, instance: 'deskuptime-bureau', plan: 'pro', status: 'active', validatedAt: daysAgoIso(0) },
    urls,
  };
}

/** A pass 5 h ago. The page read time is what each case varies. */
function entry(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgoIso(0.2),
    lastResponseMs: 100,
    lastContentLength: 3_221_225,
    lastContentReadAt: daysAgoIso(5),
    lastHash: 'a'.repeat(64),
    lastFinalUrl: AGED,
    addedAt: daysAgoIso(200),
    checks: 120,
    checksUp: 119,
    ...overrides,
  };
}

function rowFor(markdown, url) {
  return markdown.split('\n').find(line => line.startsWith('|') && line.includes(url));
}

function markdownFor(urls) {
  return renderReportMarkdown(buildReport(proState(urls), { now: NOW, history: emptyHistory() }));
}

/** The same fragment the two terminal lists print in `contentSize`. */
function listRow(entryValue) {
  return readEntry(entryValue, { now: NOW, url: AGED });
}

test('a size that is not from today says how old it is, in the report too', () => {
  const markdown = markdownFor({ [AGED]: entry() });

  // The measured case: a five-hour-old pass, a five-day-old reading.
  assert.match(rowFor(markdown, AGED), /stable · 3221225 bytes, read 5 d ago/);
});

test('the report and the two terminal lists say the same words about one reading', () => {
  // One owner, asked by three surfaces: the row may carry a prefix, but the age
  // cannot be assembled twice or be absent on one of them.
  for (const [url, value] of [
    [AGED, entry()],
    [UNPLACEABLE, entry({ lastContentLength: 100, lastContentReadAt: 'not-a-date', lastFinalUrl: UNPLACEABLE })],
  ]) {
    const cell = rowFor(markdownFor({ [url]: value }), url)
      .split('|')
      .map(part => part.trim());
    const size = listRow(value).contentSize;
    assert.ok(size.length > 0, `${url} has no list fragment`);
    assert.ok(cell.includes(`stable · ${size}`), `report says "${cell.join(' | ')}", list says "${size}"`);
  }
});

test('a reading that cannot be placed in time says so rather than rounding to today', () => {
  const markdown = markdownFor({ [UNPLACEABLE]: entry({ lastContentLength: 100, lastContentReadAt: 'not-a-date', lastFinalUrl: UNPLACEABLE }) });
  const row = rowFor(markdown, UNPLACEABLE);

  assert.match(row, /stable · 100 bytes, read at an unknown time/);
  assert.doesNotMatch(row, /stable · 100 bytes \|/, 'an unplaceable reading must not print as a plain size');
});

test('a reading from today keeps the cell it has always had, character for character', () => {
  const markdown = markdownFor({ [FRESH]: entry({ lastContentLength: 100, lastContentReadAt: daysAgoIso(0.2), lastFinalUrl: FRESH }) });
  const row = rowFor(markdown, FRESH);

  assert.match(row, /\| stable · 100 bytes \|/);
  assert.doesNotMatch(row, /read /, 'a reading from today needs no words');
});

test('the owner is the cell, and it needs the reading time, not the pass time', () => {
  // A pass dated ahead of this clock cannot be aged here a second way (P1-31).
  assert.equal(contentBytesNote(100, daysAgoIso(0), NOW), '100 bytes');
  assert.equal(contentBytesNote(100, daysAgoIso(3), NOW), '100 bytes, read 3 d ago');
  assert.equal(contentBytesNote(100, 'not-a-date', NOW), '100 bytes, read at an unknown time');
  assert.equal(contentBytesNote(100, null, NOW), '100 bytes, read at an unknown time');
  assert.equal(
    contentBytesNote(100, new Date(NOW.getTime() + 6 * 3600 * 1000).toISOString(), NOW),
    '100 bytes, read 6 h ahead of this machine\'s clock',
  );
});

test('the other two cells of the column are untouched', () => {
  // A page nobody read says —, and a page that changed says the marker, with its
  // age under the table. Neither grows an age, because neither prints a size.
  const unread = markdownFor({ [AGED]: entry({ lastContentLength: null, lastContentReadAt: null }) });
  assert.match(rowFor(unread, AGED), /\| — \|/);
  assert.doesNotMatch(unread, /bytes/);

  const changed = markdownFor({ [AGED]: entry({ lastContentChangedAt: daysAgoIso(1) }) });
  assert.match(rowFor(changed, AGED), /🔄 changed/);
  assert.doesNotMatch(rowFor(changed, AGED), /bytes/, 'a size read before a change is not the size of what changed');
  assert.match(changed, /🔄 content changed 1 d ago/);
});

test('the footnote defines the column, so it has to name the age too', () => {
  const markdown = markdownFor({ [AGED]: entry() });

  assert.match(markdown, /A size that is not from today says how old it is/);
  assert.match(markdown, /`contentReadAt` in `--json` is that time/);
});

test('the JSON still carries the time, so a consumer can see the same case', () => {
  const report = buildReport(
    proState({ [AGED]: entry(), [UNPLACEABLE]: entry({ lastContentReadAt: null, lastFinalUrl: UNPLACEABLE }) }),
    { now: NOW, history: emptyHistory() },
  );
  const byUrl = Object.fromEntries(report.sites.map(site => [site.url, site]));

  assert.equal(byUrl[AGED].contentReadAt, daysAgoIso(5));
  assert.equal(byUrl[AGED].contentBytes, 3_221_225);
  // The reading the cell ages is the one the state file kept, not the pass.
  assert.equal(byUrl[AGED].lastChecked, daysAgoIso(0.2));
  assert.notEqual(byUrl[AGED].contentReadAt, byUrl[AGED].lastChecked);
  assert.equal(byUrl[UNPLACEABLE].contentReadAt, null);
  // And the owner that decided both is the one the state file was read through.
  assert.equal(readContentChangeState(entry()).bytesReadAt, daysAgoIso(5));
});
