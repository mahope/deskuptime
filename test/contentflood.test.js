/**
 * contentflood.test.js — a page that changes on every request must not raise an
 * alert on every request.
 *
 * Measured first, with the real CLI and a real page, before a line was changed.
 * A fixture serving a per-request token in the markup (a CSRF nonce, a
 * cache-buster, a "last updated" timestamp, a live counter — all ordinary on a
 * real site) gave, three passes apart:
 *
 *   pass 1  • baseline recorded: UP (200)
 *   pass 2  🔄 content changed — same size (132 bytes): the page's bytes differ
 *   pass 3  🔄 content changed — same size (132 bytes): the page's bytes differ
 *
 * Every one of those becomes a POST to the paid channel and a desktop
 * notification — every 30 s at the shortest Pro interval, so 2 880 a day per
 * site, for as long as the loop runs. The damage is what that buys: a channel
 * and a notification centre that cry wolf all day get muted, and the muting is
 * what then hides the real `is DOWN`.
 *
 * So the change is still read, hashed, counted and written on every pass. What
 * changed is what is *sent*: at most one content-change alert per site per hour
 * (`CONTENT_ALERT_MIN_GAP_MS`), with the first change after a quiet hour sent as
 * before — a defacement is a change, and it is the first change since the last
 * alert. Everything the throttle holds back is counted, and the next sent alert
 * says how many changes it stands for.
 *
 * The checker is stubbed here, so what is under test is the alert decision
 * itself, not the hash. The first test drives the real `runPass` over a real
 * state file; the last one is the owner's own boundary table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass } from '../src/watch.js';
import { CONTENT_ALERT_MIN_GAP_MS, readContentChange, readContentChangeAlert } from '../src/status.js';

const URL = 'https://kunde.dk/';
const OTHER = 'https://acme.dk/';
const BASE = '2026-09-27T09:00:00.000Z';

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-contentflood-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return home;
}

/** A page that differs on every read, the way a nonce or a counter makes it. */
function changingCheck(overrides = {}) {
  return (url, { contentHash = null } = {}) => ({
    url,
    reachable: true,
    healthy: true,
    statusCode: 200,
    responseTimeMs: 12,
    content: {
      fetched: true,
      contentLength: 132,
      hash: `hash-${contentHash ? Math.random() : 1}`,
      // The engine's own rule: with no previous hash there is nothing to
      // compare against, so the first reading is a baseline, not a change.
      changed: contentHash ? true : null,
      title: 'Kunde',
    },
    ...overrides,
  });
}

function unchangedCheck() {
  return url => ({
    url,
    reachable: true,
    healthy: true,
    statusCode: 200,
    responseTimeMs: 12,
    content: { fetched: true, contentLength: 132, hash: 'hash-1', changed: false, title: 'Kunde' },
  });
}

const changed = event => event?.type === 'content_changed';

test('tre pass over en side der ændrer sig hvert krav giver én alarm', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  const now = new Date(BASE);
  const check = changingCheck();

  const first = await runPass(state, { home, now, check, returnResults: true });
  assert.equal(first.events.filter(changed).length, 0, 'a baseline is not a change');

  const second = await runPass(state, { home, now, check, returnResults: true });
  assert.equal(second.events.filter(changed).length, 1, 'the first real change is sent as before');

  const third = await runPass(state, { home, now, check, returnResults: true });
  assert.equal(third.events.filter(changed).length, 0, 'a change inside the hour is measured, not sent');

  // Measured, not skipped: the hash and the size of the newest reading are on
  // the entry, so the *next* comparison is against the page as it is now.
  assert.match(state.urls[URL].lastHash, /^hash-/, 'the newest hash is remembered');
  assert.equal(state.urls[URL].lastContentLength, 132);
  assert.equal(state.urls[URL].contentChangesHeld, 1, 'the held change is counted, not dropped');
});

test('den næste sendte alarm siger hvad den står for', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  const check = changingCheck();
  const now = new Date(BASE);

  await runPass(state, { home, now, check, returnResults: true });
  await runPass(state, { home, now, check, returnResults: true });
  for (let i = 0; i < 3; i++) await runPass(state, { home, now, check, returnResults: true });

  const later = new Date(new Date(BASE).getTime() + CONTENT_ALERT_MIN_GAP_MS + 1000);
  const pass = await runPass(state, { home, now: later, check, returnResults: true });
  const alert = pass.events.find(changed);
  assert.ok(alert, 'a change after a quiet hour is sent');
  assert.match(alert.message, /3 earlier changes since the last alert, not sent/);
  assert.equal(state.urls[URL].contentChangesHeld, 0, 'the count is spent with the alarm it rode on');
});

test('en side der ikke ændrer sig får ingen alarm overhovedet', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { lastHash: 'hash-1', lastContentLength: 132 } } };
  const pass = await runPass(state, { home, now: new Date(BASE), check: unchangedCheck(), returnResults: true });
  assert.equal(pass.events.filter(changed).length, 0);
});

test('tætheden er pr. site: den anden side i samme pass alarmerer stadig', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { contentAlertedAt: BASE, lastHash: 'hash-1' }, [OTHER]: { contentAlertedAt: BASE, lastHash: 'hash-1' } } };
  const check = changingCheck();
  const pass = await runPass(state, { home, now: new Date(BASE), check, returnResults: true });
  assert.equal(pass.events.filter(changed).length, 0, 'both alerted inside the hour');

  // …and a site that has never alerted is not held back by its neighbour.
  const fresh = { urls: { [URL]: { contentAlertedAt: BASE, lastHash: 'hash-1' }, [OTHER]: { lastHash: 'hash-1' } } };
  const one = await runPass(fresh, { home, now: new Date(BASE), check, returnResults: true });
  assert.deepEqual(one.events.filter(changed).map(event => event.url), [OTHER], 'only the site that alerted inside the hour is held back');
});

test('et nedbrud er aldrig tynget af tætheden', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { wasUp: true, lastStatus: 200, lastChecked: BASE } } };
  const down = url => ({ url, reachable: false, healthy: false, statusCode: null, responseTimeMs: null, content: null, error: 'refused' });
  const pass = await runPass(state, { home, now: new Date(BASE), check: down, returnResults: true });
  assert.ok(pass.events.some(event => event.type === 'down'), 'the alarm a customer pays for is never throttled');
});

test('et ur der gik baglæs undertrykker intet', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { contentAlertedAt: '2099-01-01T00:00:00.000Z', lastHash: 'hash-1' } } };
  const pass = await runPass(state, { home, now: new Date(BASE), check: changingCheck(), returnResults: true });
  assert.ok(pass.events.some(changed), 'a clock problem is not evidence about the page');
});

test('en håndskrevet tæller i state-filen kan ikke slå dækken fra', () => {
  const change = readContentChange({ previousLength: 132, length: 132, previousTitle: 'Kunde', title: 'Kunde' });
  const now = new Date(BASE);
  for (const counted of [undefined, null, 0, -4, '3', 2.5, Number.NaN]) {
    const alert = readContentChangeAlert({ change, previousAlertedAt: 'nonsense', counted, now });
    assert.ok(alert, `counted=${String(counted)} must not suppress an alert`);
    assert.equal(alert.held, 0, 'nothing is claimed to have been held that was not counted');
  }
});

test('en beskadiget sidste alarmtid tæller ikke som en alarm', () => {
  const change = readContentChange({ previousLength: 132, length: 132, previousTitle: 'Kunde', title: 'Kunde' });
  const now = new Date(BASE);
  // A restored or half-written state file must not silence a site for an hour.
  for (const previousAlertedAt of [null, undefined, '', 'i går', 12345, {}]) {
    assert.ok(readContentChangeAlert({ change, previousAlertedAt, now }), `${String(previousAlertedAt)} must not suppress`);
  }
});

test('lige før en time er der stadig ikke sendt, lige efter er der', () => {
  const change = readContentChange({ previousLength: 132, length: 132, previousTitle: 'Kunde', title: 'Kunde' });
  const start = new Date(BASE);
  const justInside = readContentChangeAlert({ change, previousAlertedAt: BASE, now: new Date(new Date(BASE).getTime() + CONTENT_ALERT_MIN_GAP_MS - 1) });
  assert.equal(justInside, null, 'the window is closed a millisecond before the hour');
  const atGap = readContentChangeAlert({ change, previousAlertedAt: BASE, now: new Date(new Date(BASE).getTime() + CONTENT_ALERT_MIN_GAP_MS) });
  assert.ok(atGap, 'the window opens at the hour');
  assert.equal(atGap.message, change.message, 'nothing was held, so nothing is claimed');
});

test('en titel med et linjeskift må ikke stå som sit eget modsættende par', () => {
  // Measured 2026-09-27 with the real loop and a real page title holding one
  // line break: every surface that prints this sentence flattens the text to one
  // line (the terminal and the macOS notification, both through safeText), so the
  // quoted pair read `page title: "Free iPhone!!" → "Free iPhone!!"` — the same
  // string on both sides of an arrow that says the title changed.
  const change = readContentChange({
    previousLength: 56,
    length: 56,
    previousTitle: 'Free iPhone!!',
    title: 'Free\niPhone!!',
  });
  assert.equal(change.titleChanged, true, 'the titles really do differ');
  assert.doesNotMatch(change.message, /page title: "/, `the pair a reader cannot tell apart is quoted: ${change.message}`);
  assert.match(change.message, /differ only in whitespace or characters a screen cannot show/, change.message);
  // The ordinary case is byte-for-byte unchanged, both in the pair and in the
  // words around it: a title that changed by a visible character still names
  // both sides.
  const visible = readContentChange({ previousLength: 56, length: 56, previousTitle: 'Kunde', title: 'Kunde A/S' });
  assert.equal(visible.message, 'content changed — page title: "Kunde" → "Kunde A/S" (same size, 56 bytes)');
  // A page whose title did not change keeps the size sentence exactly.
  const same = readContentChange({ previousLength: 56, length: 56, previousTitle: 'Kunde', title: 'Kunde' });
  assert.equal(same.message, 'content changed — same size (56 bytes): the page\'s bytes differ');
});

test('en enkelt holdt ændring siges i ental', () => {
  const change = readContentChange({ previousLength: 132, length: 132, previousTitle: 'Kunde', title: 'Kunde' });
  const alert = readContentChangeAlert({ change, counted: 1, now: new Date(BASE) });
  assert.match(alert.message, /1 earlier change since the last alert, not sent/);
});
