/**
 * P1-103 — a change whose title did not move was announced as one that did.
 *
 * P1-80 kept the title pair beside the change so a later reader could say what the
 * page became. It left the *other* case unnamed. A pass that measures a change and
 * finds the page's title exactly where it was — a nonce, a CSRF token, a live
 * counter, a price re-rendered with the same digits — has no pair, because there
 * is nothing to pair. All three readers were left holding only `lastTitle`, which
 * is the page as it is *now*, so they fell through to their one-sided form.
 *
 * Measured 2026-09-28 with the real loop and a real page, no code changed. The
 * body grew by one byte and the title never moved:
 *
 *   channel:  content changed — same size (68 bytes): the page's bytes differ
 *   status:   🔄 content changed today — page title: "Acme — home"
 *   watch:    🔄 content changed today — page title: "Acme — home"
 *   report:   🔄 content changed today — page title: "Acme — home"
 *
 * The channel says the title did not move. The three readers say it did, by naming
 * it — and `page title:` after the word *changed* is the sentence an agency reads
 * when a customer's homepage is defaced. Naming a title the change never touched
 * is the same failure as P1-80's, pointing the other way: there the sentence
 * described the page instead of the change, here it describes a change that did not
 * happen.
 *
 * The cause is that "we never kept a before" and "we kept none, because the title
 * stayed" were one absence, and only the first of the two is allowed to name a
 * title. The pass measured the difference and threw it away; it now keeps it, as
 * `contentTitleUnchanged`, and the readers ask.
 *
 * Nothing here moves a status, an exit code, an uptime number, the Content cell,
 * the alert or a field any consumer already reads. A state file written before the
 * flag existed has no flag, and keeps the one-sided sentence — which is all it can
 * honestly say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass } from '../src/watch.js';
import { contentChangeNote, readContentChangeState } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const SITE = 'https://kunde.dk/';
const BASE = '2026-09-28T09:00:00.000Z';
const BEFORE = 'Acme — home';
const AFTER = 'Acme — shop';

function tempState(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-titleunchanged-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, 'state.json');
}

/**
 * One reading of a page: the title it carried and whether its bytes differ. The
 * readings are written out by the test rather than counted in the helper, because a
 * counter that restarts turns the next pass into a baseline and quietly tests
 * nothing.
 */
function pageCheck(readings) {
  let i = 0;
  return url => {
    const r = readings[Math.min(i, readings.length - 1)];
    i += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      content: {
        fetched: true,
        hash: `hash-${i}`,
        contentLength: 95,
        changed: r.changed,
        title: r.title,
      },
    };
  };
}

const changedEntry = (extra) => ({
  lastContentChangedAt: BASE,
  lastChecked: BASE,
  wasUp: true,
  lastStatus: 200,
  checks: 4,
  checksUp: 4,
  lastTitle: AFTER,
  ...extra,
});

// ── the loop: the fact is measured and kept ─────────────────────────────────

test('passen beholder at den målte titlen, og at den ikke flyttede sig', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: {} } };
  // Pass 1 baseline, pass 2 a real title change, pass 3 a bytes-only change.
  const check = pageCheck([
    { title: BEFORE, changed: null },
    { title: AFTER, changed: true },
    { title: AFTER, changed: true },
  ]);
  await runPass(state, { stateFile, check, returnResults: true });
  await runPass(state, { stateFile, check, returnResults: true });
  assert.equal(state.urls[SITE].contentTitleBefore, BEFORE, 'en titel der flytter sig giver et par');
  assert.equal(state.urls[SITE].contentTitleUnchanged, undefined, 'og ingen "flyttede ikke"-notat');

  await runPass(state, { stateFile, check, returnResults: true });
  const entry = state.urls[SITE];
  assert.equal(entry.lastTitle, AFTER, 'siden har stadig sin titel');
  assert.equal(entry.contentTitleUnchanged, true, 'men passen må huske at denne ændring ikke flyttede den');
  // The pair is gone, as P1-80 required — an arrow from pass 2 would claim
  // today's change renamed the page. The new field says *why* it is gone.
  assert.equal(entry.contentTitleBefore, undefined, 'et gammelt par må ikke overleve en ændring uden titel');
});

test('en titel der flytter sig igen rydder notatet væk, så en senere ændring må navngive den', async (t) => {
  // The flag belongs to a change, not to the page — the same rule as the pair. A
  // flag left behind would silence the title on the next change that *did* move
  // it, which is the change an agency most needs named.
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: {} } };
  const check = pageCheck([
    { title: BEFORE, changed: null },
    { title: BEFORE, changed: true },   // change 1: title unmoved
    { title: AFTER, changed: true },    // change 2: title moved
  ]);
  await runPass(state, { stateFile, check, returnResults: true });
  await runPass(state, { stateFile, check, returnResults: true });
  assert.equal(state.urls[SITE].contentTitleUnchanged, true);

  await runPass(state, { stateFile, check, returnResults: true });
  const entry = state.urls[SITE];
  assert.equal(entry.contentTitleBefore, BEFORE, 'den nye ændring har sit eget par');
  assert.equal(entry.contentTitleUnchanged, undefined, 'og må ikke arve den forriges "flyttede ikke"');
});

// ── the owner: three sentences that used to be one ──────────────────────────

test('ejeren skelner en titel der blev målt og ikke flyttede sig fra en der aldrig blev gemt', () => {
  const now = { changed: true, ageDays: 0, title: AFTER };

  // The new case: the pass measured the title and it stayed. No title is named,
  // because no title changed.
  assert.equal(
    contentChangeNote({ ...now, titleUnchanged: true }),
    '🔄 content changed today',
    'en ændring der ikke flyttede titlen må ikke navngive den',
  );

  // The old case, unchanged: a state file written before the pair existed. Its
  // one-sided sentence is the truth about that file, and it stays.
  assert.equal(
    contentChangeNote(now),
    `🔄 content changed today — page title: "${AFTER}"`,
    'uden både par *og* notatet er den ensidige sætning stadig alt den kan sige',
  );

  // A pair still wins over the flag. Two titles that really differ are a change
  // the flag cannot speak for, and a hand-edited or restored file can hold both.
  assert.equal(
    contentChangeNote({ ...now, previousTitle: BEFORE, titleUnchanged: true }),
    `🔄 content changed today — page title: "${BEFORE}" → "${AFTER}"`,
    'et læsbart par er stærkere evidens end et notat',
  );

  // And the ages and the clock are untouched by any of it.
  assert.equal(
    contentChangeNote({ changed: true, ageDays: 3, title: AFTER, titleUnchanged: true }),
    '🔄 content changed 3 d ago',
  );
});

test('læsningen gør de tre tilstande kan skelnes, også i JSON', () => {
  const now = new Date(BASE);
  const unmoved = readContentChangeState(changedEntry({ contentTitleUnchanged: true }), { now });
  assert.equal(unmoved.titleUnchanged, true);
  assert.equal(unmoved.previousTitle, null, 'der er intet par at finde');
  assert.equal(unmoved.title, AFTER, 'og siden har stadig sin titel');
  assert.equal(unmoved.note, '🔄 content changed today');

  // Absent is not the same as false: a file written before the flag has no flag,
  // and the sentence it gets is the one-sided one.
  const legacy = readContentChangeState(changedEntry({}), { now });
  assert.equal(legacy.titleUnchanged, false);
  assert.match(legacy.note, /page title: "Acme — shop"$/, 'en gammel fil beholder sin ensidige sætning');
});

// ── the four readers: one change, four sentences ────────────────────────────

test('de tre lister og rapporten siger det samme som kanalen, når titlen ikke flyttede sig', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { addedAt: BASE } } };
  const check = pageCheck([
    { title: BEFORE, changed: null },
    { title: BEFORE, changed: true },
  ]);
  await runPass(state, { stateFile, check, returnResults: true });
  const second = await runPass(state, { stateFile, check, returnResults: true });

  // The channel says the title did not move — it measured both sides and had no
  // pair, so it fell to its honest size sentence.
  const alert = second.events.find(event => event.type === 'content_changed');
  assert.ok(alert, 'den anden pass rejser en ændring');
  assert.doesNotMatch(alert.message, /page title/, `kanalen må ikke navngive en titel den ikke flyttede: ${alert.message}`);

  // The readers say the same thing, in the only way they can: no title at all.
  const reading = readContentChangeState(state.urls[SITE], { now: new Date() });
  assert.equal(reading.note, '🔄 content changed today');
  const report = buildReport(state, { now: new Date() });
  assert.equal(report.sites[0].contentNote, '🔄 content changed today');
  assert.equal(report.sites[0].contentTitleUnchanged, true, 'JSON kan ikke se forskel på de to ellers');
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /🔄 content changed today\)/, markdown);
  assert.doesNotMatch(markdown, /page title/, 'kundedokumentet må ikke navngive en titel ændringen ikke flyttede');

  // And the parts of the report that describe the site are untouched by any of it.
  assert.equal(report.sites[0].status, 'up');
  assert.equal(report.sites[0].uptimePercent, 100);
  assert.equal(report.sites[0].contentChanged, true);
  assert.equal(report.sites[0].contentTitle, BEFORE, 'siden har stadig sin titel i JSON — den er bare ikke en ændring');
});

test('en titel der flyttede sig giver stadig pilen på alle fire flader', async (t) => {
  // The fix must not cost the pair P1-80 built: this is the sentence an agency
  // reads when a customer really did rename their homepage.
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { addedAt: BASE } } };
  const check = pageCheck([
    { title: BEFORE, changed: null },
    { title: AFTER, changed: true },
  ]);
  await runPass(state, { stateFile, check, returnResults: true });
  const second = await runPass(state, { stateFile, check, returnResults: true });

  const arrow = `page title: "${BEFORE}" → "${AFTER}"`;
  assert.ok(second.events.find(e => e.type === 'content_changed').message.includes(arrow));
  assert.ok(readContentChangeState(state.urls[SITE], { now: new Date() }).note.includes(arrow));
  assert.ok(renderReportMarkdown(buildReport(state, { now: new Date() })).includes(arrow));
});
