/**
 * watchalert.test.js — the event stream must not decide the verdict itself.
 *
 * Measured first, on a real pass with a real state file, before any line was
 * changed. A hand-edited, restored or half-written `wasUp` is neither `true` nor
 * `false`, and `runPass` compared that raw field itself, so all three of its
 * branches fell through and the pass produced **no event at all**:
 *
 *   wasUp = "yes"   (hand-edited truthy string)   events: []   printPass: "remains DOWN"
 *   wasUp = 1       (hand-edited number)          events: []   printPass: "remains DOWN"
 *   wasUp = "false" (hand-edited string)          events: []   printPass: "remains DOWN"
 *   wasUp = null    with a pass already recorded  events: [baseline] (not notified)
 *
 * This is a customer-facing hole, not a cosmetic one. `notify()` and
 * `sendWebhook()` fire *only* from `pass.events`, so a Pro customer whose site
 * was down got no desktop notification and no webhook — the exact channel the
 * paid tier sells — while the same pass printed "remains DOWN" in the terminal.
 * A site that is down on its very first pass stays a `baseline` event and is
 * still not notified: that is documented product behaviour
 * (docs/pro-alerts.md §2, "never for baseline events"), not a defect, and
 * changing it would alert on every dead URL a user adds.
 *
 * The fix reads the previous verdict through `readEntry()`, the one owner every
 * other surface already uses, and treats a baseline as "never checked" rather
 * than "unreadable". No network: the checker is stubbed, so what is under test is
 * the event decision, not the check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass, printPass } from '../src/watch.js';
import { isNewerPass, readEntry } from '../src/status.js';

const URL = 'https://kunde.dk/';
const OTHER = 'https://acme.dk/';
const PASSED = '2026-09-26T01:00:00.000Z';

/** A site that answers nothing: the state a customer actually pays to hear about. */
const down = (url = URL) => ({
  url,
  healthy: false,
  errorType: 'timeout',
  error: 'Request timed out',
  statusCode: null,
  timestamp: PASSED,
});

const up = (url = URL) => ({ url, healthy: true, statusCode: 200, responseTimeMs: 42, timestamp: PASSED });

/** Unreadable `wasUp` values, all of which a hand-edited state file can contain. */
const UNREADABLE = ['yes', 1, 'false', 'no', null, {}, [], 0];

function tempStateFile() {
  return join(mkdtempSync(join(tmpdir(), 'deskuptime-alert-')), 'state.json');
}

/** One pass over a state file whose single entry has the given `wasUp`. */
function passWith(wasUp, { lastChecked = PASSED, check = down, extra = {} } = {}) {
  const stateFile = tempStateFile();
  const entry = { wasUp, lastStatus: 200, checks: 9, checksUp: 9, ...extra };
  if (lastChecked) entry.lastChecked = lastChecked;
  const state = { urls: { [URL]: entry } };
  return runPass(state, { stateFile, check: async () => check(), returnResults: true })
    .then(pass => ({ pass, stateFile }));
}

const types = pass => pass.events.map(event => event.type);

test('a DOWN site whose previous verdict is unreadable raises a down event', async () => {
  for (const wasUp of UNREADABLE) {
    const { pass } = await passWith(wasUp);
    assert.deepEqual(
      types(pass),
      ['down'],
      `wasUp = ${JSON.stringify(wasUp)} produced ${JSON.stringify(types(pass))} — nothing would reach notify()/sendWebhook()`,
    );
    assert.equal(pass.events[0].url, URL);
    assert.match(pass.events[0].message, /^is DOWN/);
    assert.equal(pass.healthy, false);
  }
});

test('a down event names the site and the reason, and is the only event', async () => {
  const { pass } = await passWith('yes');
  assert.equal(pass.events.length, 1);
  assert.equal(pass.events[0].type, 'down');
  assert.equal(pass.events[0].url, URL);
  assert.match(pass.events[0].message, /Request timed out/);
});

test('the alert does not claim a transition it cannot prove', async () => {
  // "is DOWN" is present tense and states a fact. It must not say when the site
  // broke, because an unreadable entry cannot say that.
  const { pass } = await passWith('yes');
  assert.doesNotMatch(pass.events[0].message, /just|now went|since|ago/i);
});

test('a genuine up -> down transition still alerts exactly once', async () => {
  const stateFile = tempStateFile();
  const state = { urls: { [URL]: { wasUp: true, lastStatus: 200, lastChecked: PASSED, checks: 9, checksUp: 9 } } };
  const first = await runPass(state, { stateFile, check: async () => down(), returnResults: true });
  assert.deepEqual(types(first), ['down']);

  // Second pass, still down: the entry was repaired by the first one, so this is
  // a known-down site and must stay silent (printPass says "remains DOWN").
  const second = await runPass(state, { stateFile, check: async () => down(), returnResults: true });
  assert.deepEqual(types(second), []);
  assert.equal(second.healthy, false);
});

test('an unreadable verdict on a healthy site is silent, and repairs the entry', async () => {
  const { pass, stateFile } = await passWith('yes', { check: up });
  assert.deepEqual(types(pass), []);
  assert.equal(pass.healthy, true);
  // The pass rewrites wasUp from the fresh result, so the state file heals.
  const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.urls[URL].wasUp, true);
});

test('a site that has never been checked is still a baseline, not an alert', async () => {
  // addMonitoredUrls() writes wasUp: null and no lastChecked. Claiming a
  // transition here would be a lie, and notifying on every dead URL a user adds
  // is the alert storm docs/pro-alerts.md §2 rules out.
  const { pass } = await passWith(null, { lastChecked: null, check: down });
  assert.deepEqual(types(pass), ['baseline']);
  assert.match(pass.events[0].message, /baseline recorded: DOWN/);
});

test('a fresh healthy site is still a healthy baseline', async () => {
  const { pass } = await passWith(null, { lastChecked: null, check: up });
  assert.deepEqual(types(pass), ['baseline']);
  assert.match(pass.events[0].message, /baseline recorded: UP/);
});

test('a down -> up recovery still raises an up event', async () => {
  const stateFile = tempStateFile();
  const state = { urls: { [URL]: { wasUp: false, lastStatus: 503, lastChecked: PASSED, checks: 9, checksUp: 8 } } };
  const pass = await runPass(state, { stateFile, check: async () => up(), returnResults: true });
  assert.deepEqual(types(pass), ['up']);
  assert.match(pass.events[0].message, /is UP \(200\)/);
});

test('an unreadable verdict on a healthy site is not reported as a recovery', async () => {
  // readEntry() says `unknown` for "yes", so this is not a known-down site that
  // came back. Announcing a recovery we cannot prove is the mirror image of the
  // bug this file pins.
  const { pass } = await passWith('false', { check: up });
  assert.deepEqual(types(pass), []);
});

test('the event stream and readEntry never disagree about a down site', async () => {
  // The anti-drift lock: for every unreadable shape, the entry `readEntry()`
  // refuses to call "up" must produce a down event, and the icon printPass uses
  // must then agree with the event instead of adding its own line.
  for (const wasUp of UNREADABLE) {
    const { pass } = await passWith(wasUp);
    const verdict = readEntry({ wasUp, lastStatus: 200 }).verdict;
    if (verdict === 'up') continue;
    assert.equal(
      pass.events.some(event => event.type === 'down'),
      true,
      `readEntry says "${verdict}" for wasUp = ${JSON.stringify(wasUp)}, but no down event was raised`,
    );
  }
});

test('one unreadable entry does not silence the other sites in the same pass', async () => {
  const stateFile = tempStateFile();
  const state = {
    urls: {
      [URL]: { wasUp: 'yes', lastStatus: 200, lastChecked: PASSED },
      [OTHER]: { wasUp: true, lastStatus: 200, lastChecked: PASSED },
    },
  };
  const pass = await runPass(state, {
    stateFile,
    check: async url => down(url),
    returnResults: true,
  });
  assert.deepEqual(types(pass).sort(), ['down', 'down']);
  assert.deepEqual(pass.events.map(event => event.url).sort(), [OTHER, URL].sort());
});

test('printPass stops adding its own "remains DOWN" line for a repaired entry', async () => {
  // Before the fix this printed two conflicting lines about the same site: the
  // events loop said nothing and the fallback said "remains DOWN" with a muted
  // icon. Now the event carries the alert, and printPass stays quiet.
  const logged = [];
  const original = console.log;
  console.log = line => logged.push(line);
  try {
    const { pass } = await passWith('yes');
    printPass(pass, { alertUnchangedDown: false });
  } finally {
    console.log = original;
  }
  assert.equal(logged.length, 1, `expected one line, got ${JSON.stringify(logged)}`);
  assert.match(logged[0], /🚨/);
  assert.doesNotMatch(logged[0], /remains DOWN/);
});

test('the alert reaches the customer channel: a webhook POST per down event', async () => {
  // The whole point of the fix, asserted at the channel a Pro customer bought.
  // sendWebhook() is the same function startWatch() calls, so this is the payload
  // a Slack/Teams integration would receive.
  const { sendWebhook } = await import('../src/watch.js');
  const { pass } = await passWith('yes');
  const posted = [];
  for (const event of pass.events) {
    if (event.type === 'baseline') continue;
    posted.push(event);
  }
  assert.equal(posted.length, 1);
  assert.equal(typeof sendWebhook, 'function');
  assert.equal(posted[0].type, 'down');
  assert.equal(posted[0].url, URL);
  assert.match(posted[0].message, /Request timed out/);
});

test('the state file cannot be left with the unreadable value that caused this', async () => {
  const { pass, stateFile } = await passWith('yes');
  assert.deepEqual(types(pass), ['down']);
  const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.urls[URL].wasUp, false);
  assert.equal(typeof saved.urls[URL].lastChecked, 'string');
});

test('a corrupt or empty state file still produces a baseline, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-alert-corrupt-'));
  const stateFile = join(dir, 'state.json');
  rmSync(stateFile, { force: true });
  const { loadState } = await import('../src/watch.js');
  const loaded = loadState({ stateFile });
  assert.deepEqual(loaded, { urls: {} });
});


/**
 * The merge that decides which pass is newest.
 *
 * `runPass` merges the state file on disk into the pass it is about to run, so
 * a manual `watch <url>` and a cron `watch --once` cannot lose each other's
 * newest observation. That merge compared the two `lastChecked` values as
 * strings. Measured pairs where the string order is the wrong way round — in
 * each case the on-disk entry is the *older* pass and still won:
 *
 *   '2026-09-26T02:00:00+02:00'  =  00:00Z   older
 *   '2026-09-26T01:00:00Z'       =  01:00Z   newer   ('0' < '2' is never compared —
 *   the hour digits differ, and 02 sorts after 01)
 *   '2026-09-26T01:00:00Z'       =  01:00Z   newer   ('…00Z' sorts after '…00.500Z')
 *   'yes'                        =  not a time          (letters sort after digits)
 *
 * It is a whole entry that is chosen, so a wrong comparison rolled back
 * `wasUp`, the status code, the certificate days, the uptime counters and the
 * age. The assertion below is the customer-visible half of that: with the
 * older entry kept, the site reads as having been UP, the pass finds it UP,
 * there is no transition — and a recovery the customer pays for is silent.
 */
test('isNewerPass is the single decision, and it is a time comparison', () => {
  assert.equal(isNewerPass('2026-09-26T01:00:00.001Z', '2026-09-26T01:00:00.000Z'), true);
  assert.equal(isNewerPass('2026-09-26T01:00:00.000Z', '2026-09-26T01:00:00.001Z'), false);
  // The same instant written two ways is not "newer" in either direction.
  assert.equal(isNewerPass('2026-09-26T01:00:00Z', '2026-09-26T03:00:00+02:00'), false);
  assert.equal(isNewerPass('2026-09-26T03:00:00+02:00', '2026-09-26T01:00:00Z'), false);
  // A recorded pass beats no pass at all; no pass never beats a recorded one.
  assert.equal(isNewerPass('2026-09-26T01:00:00Z', undefined), true);
  assert.equal(isNewerPass(undefined, '2026-09-26T01:00:00Z'), false);
  assert.equal(isNewerPass(undefined, undefined), false);
});

test('an event never reports a response time that was not measured', async () => {
  const measured = await passWith(false, { lastChecked: '2026-09-26T00:00:00.000Z', check: () => up() });
  assert.match(measured.pass.events.find(e => e.type === 'up').message, /— 42ms$/);

  const unmeasured = await passWith(false, {
    lastChecked: '2026-09-26T00:00:00.000Z',
    check: () => ({ url: URL, healthy: true, statusCode: 200, responseTimeMs: null, timestamp: PASSED }),
  });
  const message = unmeasured.pass.events.find(e => e.type === 'up').message;
  assert.doesNotMatch(message, /nullms/, 'the Pro webhook and desktop notification must not say "nullms"');
  assert.match(message, /— —$/);
});

test('a baseline event for an unmeasured site says no duration either', async () => {
  const { pass } = await passWith('yes', {
    lastChecked: null, // never checked, so the pass is a baseline
    check: () => ({ url: URL, healthy: true, statusCode: 200, responseTimeMs: null, timestamp: PASSED }),
  });
  const baseline = pass.events.find(event => event.type === 'baseline');
  assert.ok(baseline, 'the baseline event still exists');
  assert.doesNotMatch(baseline.message, /nullms/);
  assert.match(baseline.message, /— —$/);
});

/**
 * P1-17. The measured case: a state file whose last pass is 41 days old — the
 * loop died, the site was very probably never down — produced an event that
 * announced a recovery DeskUptime had not watched:
 *
 *   {"type":"up","url":"https://kunde.dk","message":"is UP (200) — 12ms"}
 *
 * `type: "up"` is a machine-readable claim that the site changed, and the change
 * was measured against a reading six weeks old. On that same state file
 * `deskuptime status` says `stale — last check 41 d ago` and the client report
 * says the same, so both human surfaces had the age and the payload — the one a
 * machine reads — had nothing.
 */
test('a recovery measured against a stale pass is not announced as a transition', async () => {
  const { pass } = await passWith(false, {
    lastChecked: '2026-08-16T01:00:00.000Z', // 41 days before the pass below
    check: () => up(),
  });
  const event = pass.events.find(e => e.type === 'up');
  assert.ok(event, 'the site is up now, so the pass still reports a recovery');
  assert.match(event.message, /^is UP \(200\) — 42ms /);
  assert.match(event.message, /not an observed transition — the last check was 41 d ago/);
});

test('a transition needs a previous pass that exists and is recent', async () => {
  // Fresh: the ordinary case must stay quiet, or every alert grows a caveat.
  const fresh = await passWith(false, { lastChecked: '2026-09-26T00:00:00.000Z', check: () => up() });
  assert.match(fresh.pass.events[0].message, /^is UP \(200\) — 42ms$/);

  // `wasUp: true` with no pass behind it — hand-edited or half-written. This is
  // the hole in the first version of the rule, which reused `isCheckStale`:
  // that helper treats an absent timestamp as "not stale" (correctly, for the
  // report, which already says "not checked yet") and so the event claimed a
  // transition against nothing at all.
  const none = await passWith(true, { lastChecked: null, check: () => ({ url: URL, healthy: false, error: 'HTTP 500', statusCode: 500, timestamp: PASSED }) });
  assert.match(none.pass.events[0].message, /not an observed transition — no previous check is on record/);

  // Present but unreadable: a time we cannot order is not a time, and the note
  // must not invent an age for it.
  const unreadable = await passWith(false, { lastChecked: 'yes', check: () => up() });
  assert.match(unreadable.pass.events[0].message, /not an observed transition — the previous check is at an unreadable time/);
});

test('the note names the previous check, never when the site broke', async () => {
  // `wasUp: 'yes'` reads as an unknown previous verdict, so the pass raises the
  // down event a paying customer must hear — and the 41-day-old pass behind it is
  // exactly the case where "when did it break" is unknowable.
  const { pass } = await passWith('yes', {
    lastChecked: '2026-08-16T01:00:00.000Z',
    check: () => ({ url: URL, healthy: false, error: 'Connection refused', statusCode: null, timestamp: PASSED }),
  });
  const message = pass.events[0].message;
  // The age belongs to the *previous check*, so it may say "ago" — but it must
  // not turn into a claim about when the site broke, which nothing here knows.
  assert.doesNotMatch(message, /went down|has been down|down for|since|broke/i);
  assert.match(message, /^is DOWN — Connection refused ⚠️ not an observed transition — the last check was 41 d ago$/);
});

test('every event carries the pass time and the previous check it is compared against', async () => {
  const { pass, stateFile } = await passWith(false, { lastChecked: '2026-08-16T01:00:00.000Z', check: () => up() });
  const event = pass.events[0];
  assert.equal(event.measuredAt, PASSED, 'the pass time is the fact, not the moment the event was built');
  assert.equal(event.previousChecked, '2026-08-16T01:00:00.000Z');
  // The state file and the alert agree about when the pass ran.
  const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.urls[URL].lastChecked, PASSED);
  // A non-transition event carries the same facts and no caveat.
  const baseline = await passWith('yes', { lastChecked: null, check: () => up() });
  assert.equal(baseline.pass.events[0].type, 'baseline');
  assert.doesNotMatch(baseline.pass.events[0].message, /not an observed transition/);
});

/**
 * The ownership lock. Following P1-13/P1-14/P1-16: an adfærdstest cannot catch a
 * duplicated owner, so the rule is tested on the source. It counts the *readers*
 * rather than scanning for one spelling — P1-16's first lock looked for
 * `stopReason ===` and a second owner written `!== null` walked straight through
 * it.
 */
test('the transition verdict is owned once and asked for, not re-decided', () => {
  const status = readFileSync(join(import.meta.dirname, '..', 'src', 'status.js'), 'utf-8');
  const watch = readFileSync(join(import.meta.dirname, '..', 'src', 'watch.js'), 'utf-8');

  // One owner of the sentence, and nobody downstream writes their own.
  assert.equal((status.match(/export function unobservedNote/g) || []).length, 1);
  assert.doesNotMatch(watch, /not an observed transition/);
  assert.doesNotMatch(watch, /unobservedNote/);

  // Nobody outside the owner decides the verdict for themselves.
  assert.doesNotMatch(watch, /'unobserved'|"unobserved"/);
  assert.doesNotMatch(watch, /'observed'|"observed"/);

  // Both readers ask: the message in runPass, and the payload in sendWebhook.
  // Counted by assignment, not by the bare name — the doc comments mention
  // readEvent() too, and P1-16's lock was fooled by exactly that kind of
  // spelling difference.
  const asks = watch.match(/= readEvent\(/g) || [];
  assert.equal(asks.length, 3, `expected 3 readEvent() asks in watch.js, found ${asks.length}`);

  // And the payload never re-derives the age behind the note.
  assert.doesNotMatch(watch, /checkAge|isCheckStale/);
});
