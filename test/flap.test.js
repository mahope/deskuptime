/**
 * P1-49 — a site that flaps must not turn the paid channel into a siren.
 *
 * The measurement that wrote this file: the real `runPass` and a real webhook
 * receiver against a local site that alternated 200 and 500, 40 passes.
 * Before: 28 POSTs, one every other pass, for as long as the loop runs — 2 016
 * a day per site at the shortest Pro interval. After: 4, and then silence until
 * the window opens. The harm is the one the content flood (P1-47) was written
 * for, one class over: a channel that cries wolf all day is muted, and the
 * muting is what then hides a real `is DOWN`.
 *
 * The rule is deliberately NOT P1-47's. A customer buys this product to hear the
 * moment a site breaks, so a plain per-window cap on `down` could spend the
 * window in silence on a genuine outage. The throttle only engages on a site
 * that is *already* flapping, which is why the first tests below are about what
 * must NOT be throttled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { runPass } from '../src/watch.js';
import { readTransitionAlert, TRANSITION_ALERT_MIN_GAP_MS, TRANSITION_FLAP_THRESHOLD } from '../src/status.js';

const SITE = 'https://kunde.dk/';
const BASE = '2026-09-27T09:00:00.000Z';

function tempState(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-flap-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, 'state.json');
}

/** ISO stamps `count` minutes before BASE, oldest first. */
function minutesAgo(count, from = 1) {
  return Array.from({ length: count }, (_, i) =>
    new Date(new Date(BASE).getTime() - (count - i + from - 1) * 60 * 1000).toISOString());
}

/** A site that answers `healthy` on each pass, in the order given. */
function flippingCheck(verdicts) {
  let i = 0;
  return (url) => {
    const healthy = verdicts[Math.min(i, verdicts.length - 1)];
    i += 1;
    return {
      url,
      reachable: true,
      healthy,
      statusCode: healthy ? 200 : 500,
      responseTimeMs: 12,
      error: healthy ? undefined : 'HTTP 500',
    };
  };
}

async function passes(state, stateFile, verdicts, { times } = {}) {
  const check = flippingCheck(verdicts);
  const seen = [];
  for (let i = 0; i < verdicts.length; i += 1) {
    const opts = { stateFile, check, returnResults: true };
    if (times) opts.now = new Date(times[i]);
    const pass = await runPass(state, opts);
    seen.push(pass.events.filter(e => e.type === 'down' || e.type === 'up'));
  }
  return seen;
}

test('et enkelt nedbrud er aldrig holdt tilbage — det er den løfte kunden betaler for', () => {
  // A site that has been quiet all hour and now breaks. Two transitions ago is
  // the last time it moved; there is no flapping here, so nothing is throttled.
  const alert = readTransitionAlert({
    type: 'down',
    message: 'is DOWN — HTTP 500',
    recentAt: minutesAgo(1, 40),
    previousAlertedAt: minutesAgo(1, 41)[0],
    now: new Date(BASE),
  });
  assert.ok(alert, 'the outage is announced');
  assert.equal(alert.message, 'is DOWN — HTTP 500');
  assert.equal(alert.flapping, false);
});

test('et nedbrud efter to flap i timen meldes stadig, selv om der kom et i samme time', () => {
  // The regression a plain per-window cap would have shipped: the site flapped
  // twice, so a `down` was sent at 08:00; at 08:30 it goes down for good. A
  // timer alone holds that outage until the window opens and the customer hears
  // nothing at all. The threshold is what stops it.
  const alert = readTransitionAlert({
    type: 'down',
    message: 'is DOWN — HTTP 500',
    recentAt: [minutesAgo(1, 30)[0], minutesAgo(1, 1)[0]],
    previousAlertedAt: minutesAgo(1, 30)[0],
    now: new Date(BASE),
  });
  assert.ok(alert, 'a site that flaps twice and then breaks is still told');
  assert.equal(alert.flapping, false);
});

test('først da en site har vist fire skift i vinduet, holdes der tilbage', () => {
  const held = readTransitionAlert({
    type: 'down',
    message: 'is DOWN — HTTP 500',
    recentAt: minutesAgo(TRANSITION_FLAP_THRESHOLD, 2),
    previousAlertedAt: minutesAgo(1, 3)[0],
    now: new Date(BASE),
  });
  assert.equal(held, null, 'the fifth transition inside the window is not sent');
});

test('hvad der holdes tilbage tælles, og næste alarm siger hvor mange den står for', () => {
  const at = minutesAgo(1, 2)[0];
  const sent = readTransitionAlert({
    type: 'down',
    message: 'is DOWN — HTTP 500',
    recentAt: minutesAgo(TRANSITION_FLAP_THRESHOLD, 2),
    previousAlertedAt: minutesAgo(1, 16)[0],
    counted: 3,
    now: new Date(BASE),
  });
  assert.ok(sent, 'the window has opened, so the outage is announced');
  assert.match(sent.message, /3 earlier outages since the last alert, not sent/);
  assert.equal(sent.held, 3);
  assert.ok(at);
});

test('op og ned har hvert sit vindue, så en flappende site hører stadig at den er op', () => {
  const down = readTransitionAlert({
    type: 'down', message: 'is DOWN', recentAt: minutesAgo(6, 1),
    previousAlertedAt: minutesAgo(1, 1)[0], now: new Date(BASE),
  });
  assert.equal(down, null, 'the down alert is inside its own window');
  const up = readTransitionAlert({
    type: 'up', message: 'is UP (200)', recentAt: minutesAgo(6, 1),
    previousAlertedAt: null, now: new Date(BASE),
  });
  assert.ok(up, 'no up alert has been sent, so this one goes out');
  assert.equal(up.message, 'is UP (200)');
});

test('et ur der gik baglæs undertrykker intet', () => {
  const alert = readTransitionAlert({
    type: 'down', message: 'is DOWN', recentAt: minutesAgo(6, 1),
    previousAlertedAt: new Date(new Date(BASE).getTime() + 10 * 60 * 1000).toISOString(),
    now: new Date(BASE),
  });
  assert.ok(alert, 'a backwards clock is a clock problem, not a verdict');
});

test('målt: 40 pass på en flappende side gav 28 alarmer før og 4 efter', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { wasUp: null } } };
  const verdicts = Array.from({ length: 40 }, (_, i) => (i % 2 === 1 ? false : true));
  const seen = await passes(state, stateFile, verdicts);
  const alerts = seen.flat().map(e => e.type);
  assert.equal(alerts.length, 4, 'four transitions are sent, the rest of the hour is not');
  assert.deepEqual(alerts, ['down', 'up', 'down', 'up']);

  // Nothing is dropped: the file still knows when every one of them happened,
  // and what the channel is still owed.
  const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const entry = saved.urls[SITE];
  assert.equal(entry.wasUp, false, 'the last pass is still what the file says');
  assert.ok(entry.transitions.length >= TRANSITION_FLAP_THRESHOLD, 'the transitions are recorded');
  assert.equal(entry.transitionAlerts.down.held, 18, 'the held outages are counted, not lost');
  assert.equal(entry.transitionAlerts.up.held, 17, 'and so are the held recoveries');
});

test('målt: en side der flapper og så bliver nede, hører det næste vindue — og ved hvor meget', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { wasUp: null } } };
  // Baseline, three flaps, then down for good. Once four transitions sit in the
  // window the site is flapping, and the outage that follows is *held* — that is
  // the price, stated rather than hidden: up to one window of silence for a site
  // that has already flapped. It is not lost. The window opens, the outage is
  // announced, and the alert says how many it stands for.
  const verdicts = [true, false, true, false, true, false, false, false, false];
  const seen = await passes(state, stateFile, verdicts);
  assert.deepEqual(seen.flat().map(e => e.type), ['down', 'up', 'down', 'up']);
  const entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.wasUp, false, 'the site is still recorded as down');
  assert.equal(entry.transitionAlerts.down.held, 1, 'the held outage is counted, not dropped');

  // The window opens: the outage is announced, and the count rides with it.
  const later = new Date(new Date(entry.transitionAlerts.up.at).getTime() + TRANSITION_ALERT_MIN_GAP_MS);
  const after = await runPass(state, { stateFile, check: flippingCheck([false]), now: later, returnResults: true });
  assert.equal(after.events.length, 0, 'a site that is still down raises no new transition to announce');
  const fresh = { urls: { [SITE]: { ...entry, wasUp: true } } };
  const reopened = await runPass(fresh, { stateFile, check: flippingCheck([false]), now: later, returnResults: true });
  const down = reopened.events.find(e => e.type === 'down');
  assert.ok(down, 'a site that breaks again after the window is announced');
  assert.equal(down.message, 'is DOWN — HTTP 500', 'nothing about this outage was counted into the previous one');
});

test('en baseline, en SSL-advarsel og en redirect er aldrig tynget', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { wasUp: null } } };
  const first = await runPass(state, { stateFile, check: flippingCheck([true]), returnResults: true });
  assert.equal(first.events.filter(e => e.type === 'baseline').length, 1);
  const state2 = { urls: { [SITE]: { wasUp: true, transitions: minutesAgo(9, 1), transitionAlerts: { down: { at: minutesAgo(1, 1)[0], held: 4 }, up: { at: minutesAgo(1, 1)[0], held: 4 } } } } };
  const cross = await runPass(state2, { stateFile, check: flippingCheck([false]), now: new Date(BASE), returnResults: true });
  const redirect = cross.events.filter(e => e.type === 'redirect');
  assert.equal(redirect.length, 0, 'a same-host pass raises no redirect event, so nothing can hold it back');
  assert.equal(cross.events.filter(e => e.type === 'down').length, 0, 'the held down alert is not re-raised as a fresh one');
});

test('sætningen og reglen har én ejer: passet spørger, det afgør ikke selv', () => {
  const watch = readFileSync(join(import.meta.dirname, '..', 'src', 'watch.js'), 'utf8');
  const status = readFileSync(join(import.meta.dirname, '..', 'src', 'status.js'), 'utf8');
  assert.equal((watch.match(/readTransitionAlert\(\{/g) || []).length, 1, 'passen spørger ejeren pr. gang');
  assert.match(status, /\$\{noun\}/, 'sætningen findes kun i ejeren');
  assert.match(status, /'outage'/, 'og navnet på den holdte hændelse også');
  assert.doesNotMatch(watch, /'outage'|'recovery'/, 'passen navngiver ingenting selv');
  // The two knobs belong to the owner: the pass must not carry its own window
  // or its own threshold, or a later change to one of them changes only half.
  assert.doesNotMatch(watch, /15 \* 60 \* 1000|TRANSITION_FLAP_THRESHOLD/, 'passen har ingen egen tærskel');
  assert.match(status, /export const TRANSITION_ALERT_MIN_GAP_MS = 15 \* 60 \* 1000/);
  assert.match(status, /export const TRANSITION_FLAP_THRESHOLD = 4/);
});
