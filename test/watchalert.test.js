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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass, printPass } from '../src/watch.js';
import { readEntry } from '../src/status.js';

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
