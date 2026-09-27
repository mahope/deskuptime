/**
 * certrotationflood.test.js — a certificate that alternates between two servers
 * must not raise an alert on every pass.
 *
 * Measured first, with the real loop, before a line was changed. A name answered
 * by two servers with their own certificate each — two regions behind one load
 * balancer, a CDN mid-rollout, a canary deploy — both certificates valid and both
 * covering the name, so the verdict is `UP (200)` in every pass and only the
 * certificate alternates. Six passes, 30 s apart:
 *
 *   pass 1  • baseline recorded: UP (200)
 *   pass 2  🔑 SSL certificate replaced — certificate rotated since …
 *   pass 3  🔑 SSL certificate replaced — certificate rotated since …
 *   pass 4  🔑 SSL certificate replaced — certificate rotated since …
 *   pass 5  🔑 SSL certificate replaced — certificate rotated since …
 *   pass 6  🔑 SSL certificate replaced — certificate rotated since …
 *
 * Five of six passes, and each one is a POST to the paid channel and a desktop
 * notification — 2 880 a day per site at the shortest Pro interval, for as long
 * as the loop runs. The damage is what that buys: a channel and a notification
 * centre that cry wolf all day get muted, and the muting is what then hides the
 * real `is DOWN`.
 *
 * So the comparison still runs and the rotation is still *written* on every
 * pass. What changed is what is sent: at most one rotation alert per site per
 * hour (`CERT_ALERT_MIN_GAP_MS`), with the first rotation after a quiet hour
 * sent as before — a domain handed to a new owner is a rotation, and it is the
 * first one since the last alert. The difference from a throttled `down`
 * (P1-49) is the point: `down` cannot be held, because a customer buys this to
 * hear the moment a site breaks, and there the throttle only engages on a site
 * that is already flapping. A certificate has no such moment — it is a fact
 * about the past, and `lastCertRotatedAt` is the only copy that survives the
 * pass overwriting the fingerprint (P1-61), so holding the *fact* would take
 * the knowledge out of the client report too. What is held is counted, and the
 * next sent alert says how many rotations it stands for.
 *
 * The checker is stubbed here, so what is under test is the alert decision
 * itself, not the TLS handshake. The first tests drive the real `runPass` over a
 * real state file; the last one is the owner's own boundary table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass } from '../src/watch.js';
import { CERT_ALERT_MIN_GAP_MS, readCertRotation, readCertRotationAlert } from '../src/status.js';
import { readCertRotationState } from '../src/status.js';
import { tempHome } from './helpers/env.mjs';

const URL = 'https://kunde.dk/';
const OTHER = 'https://acme.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const HOUR = 60 * 60 * 1000;
/** 64 hex characters, which is what `checkSSL` actually stores. */
const FINGERPRINT_A = 'aa'.repeat(32);
const FINGERPRINT_B = 'bb'.repeat(32);

const rotated = event => event?.type === 'cert_rotated';

/** An UP site whose certificate alternates between two identities. */
function flappingCheck(fingerprints = [FINGERPRINT_A, FINGERPRINT_B]) {
  let n = 0;
  return url => {
    n += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      finalUrl: url,
      content: { fetched: true, contentLength: 132, hash: `hash-${n}`, changed: null, title: 'Kunde' },
      ssl: {
        valid: true,
        validDays: 89,
        issuer: 'Lets Encrypt',
        fingerprint256: fingerprints[(n - 1) % fingerprints.length],
        serialNumber: '01',
      },
    };
  };
}

const at = offsetMs => new Date(new Date(BASE).getTime() + offsetMs);
const afterAnHour = CERT_ALERT_MIN_GAP_MS + 1000;

test('seks pass over et flappende certifikat giver én alarm', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  const check = flappingCheck();

  const first = await runPass(state, { home, now: at(0), check, returnResults: true });
  assert.equal(first.events.filter(rotated).length, 0, 'a baseline is not a rotation');

  const second = await runPass(state, { home, now: at(30_000), check, returnResults: true });
  assert.equal(second.events.filter(rotated).length, 1, 'the first real rotation is sent as before');

  for (let i = 2; i < 6; i += 1) {
    const pass = await runPass(state, { home, now: at(i * 30_000), check, returnResults: true });
    assert.equal(pass.events.filter(rotated).length, 0, `pass ${i + 1} is measured, not sent`);
  }

  // Measured, not skipped: the newest identity is on the entry, so the *next*
  // comparison is against the certificate the site answered with last.
  assert.equal(state.urls[URL].lastCertFingerprint, FINGERPRINT_B);
  assert.equal(state.urls[URL].certRotationsHeld, 4, 'the held rotations are counted, not dropped');
});

test('kendsgerningen skrives på hvert pass, også de der holdes tilbage', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  const check = flappingCheck();

  await runPass(state, { home, now: at(0), check, returnResults: true });
  await runPass(state, { home, now: at(30_000), check, returnResults: true });
  const stamped = state.urls[URL].lastCertRotatedAt;

  await runPass(state, { home, now: at(60_000), check, returnResults: true });
  const entry = state.urls[URL];
  // P1-61's whole reason for existing: a rotation the alert held back must
  // still be in the file the client report reads, or a domain handed over two
  // days into a flapping period would leave no trace anywhere but the channel.
  assert.ok(entry.lastCertRotatedAt, 'the rotation is stamped even when the alert is held');
  assert.notEqual(entry.lastCertRotatedAt, stamped, 'and it is the newest pass that stamped it');

  // And a later surface still reads it, with an age. Read from the stamp itself
  // rather than from a fixed date: a stubbed check carries no `timestamp`, so the
  // pass stamps with this machine's real clock (`measuredAt`), and a test that
  // placed `now` months away from the real one would measure nothing.
  const readAt = new Date(Date.parse(entry.lastCertRotatedAt) + 2 * 86_400_000);
  const later = readCertRotationState(entry, { now: readAt });
  assert.equal(later.rotated, true);
  assert.equal(later.ageDays, 2);
  assert.match(later.note, /🔑 certificate replaced 2 d ago/);
});

test('den næste sendte alarm siger hvad den står for', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  const check = flappingCheck();

  await runPass(state, { home, now: at(0), check, returnResults: true });
  await runPass(state, { home, now: at(30_000), check, returnResults: true });
  for (let i = 2; i < 5; i += 1) await runPass(state, { home, now: at(i * 30_000), check, returnResults: true });

  // An hour after the *alert*, not after the baseline: the window is measured
  // from the last thing the customer heard, which is the rule for content too.
  const pass = await runPass(state, { home, now: at(30_000 + afterAnHour), check, returnResults: true });
  const alert = pass.events.find(rotated);
  assert.ok(alert, 'a rotation after a quiet hour is sent');
  assert.match(alert.message, /3 earlier rotations since the last alert, not sent/);
  assert.equal(state.urls[URL].certRotationsHeld, 0, 'the count is spent with the alarm it rode on');
});

test('et certifikat der bliver liggende efter en rotation giver én alarm og så ingen', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: {} } };
  // Two certificates, and then the second one stays — a domain handed to a new
  // owner, or a host that reissued after 90 days. Neither flaps.
  let n = 0;
  const check = url => {
    n += 1;
    return flappingCheck([n < 3 ? FINGERPRINT_A : FINGERPRINT_B])(url);
  };

  const first = await runPass(state, { home, now: at(0), check, returnResults: true });
  assert.equal(first.events.filter(rotated).length, 0, 'a baseline is not a rotation');

  await runPass(state, { home, now: at(30_000), check, returnResults: true });
  const rotation = await runPass(state, { home, now: at(60_000), check, returnResults: true });
  assert.equal(rotation.events.filter(rotated).length, 1, 'the real rotation is sent');

  for (let i = 3; i < 6; i += 1) {
    const pass = await runPass(state, { home, now: at(i * 30_000), check, returnResults: true });
    assert.equal(pass.events.filter(rotated).length, 0, 'a stable certificate is not a rotation at all');
  }
});

test('et site der ikke roterer får ingen alarm overhovedet', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { lastCertFingerprint: FINGERPRINT_A, lastCertSeenAt: BASE } } };
  const pass = await runPass(state, { home, now: at(0), check: flappingCheck([FINGERPRINT_A]), returnResults: true });
  assert.equal(pass.events.filter(rotated).length, 0);
});

test('tætheden er pr. site: den anden side i samme pass alarmerer stadig', async t => {
  const home = tempHome(t);
  const state = {
    urls: {
      // This one alerted inside the hour and is now answering with a different
      // certificate; the other one is answering with a different certificate for
      // the first time and has never alerted.
      [URL]: { lastCertFingerprint: FINGERPRINT_B, lastCertSeenAt: BASE, certAlertedAt: BASE },
      [OTHER]: { lastCertFingerprint: FINGERPRINT_A, lastCertSeenAt: BASE },
    },
  };
  const check = url => flappingCheck(url === URL ? [FINGERPRINT_A] : [FINGERPRINT_B])(url);
  const pass = await runPass(state, { home, now: at(0), check, returnResults: true });
  assert.deepEqual(
    pass.events.filter(rotated).map(event => event.url),
    [OTHER],
    'only the site that alerted inside the hour is held back',
  );
});

test('et nedbrud er aldrig tynget af tætheden', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { wasUp: true, lastStatus: 200, lastChecked: BASE, certAlertedAt: BASE } } };
  const down = url => ({ url, reachable: false, healthy: false, statusCode: null, responseTimeMs: null, content: null, error: 'refused' });
  const pass = await runPass(state, { home, now: at(0), check: down, returnResults: true });
  assert.ok(pass.events.some(event => event.type === 'down'), 'the alarm a customer pays for is never throttled');
});

test('et ur der gik baglæs undertrykker intet', async t => {
  const home = tempHome(t);
  const state = { urls: { [URL]: { lastCertFingerprint: FINGERPRINT_B, lastCertSeenAt: BASE, certAlertedAt: '2099-01-01T00:00:00.000Z' } } };
  const check = flappingCheck([FINGERPRINT_A]);
  const pass = await runPass(state, { home, now: at(0), check, returnResults: true });
  assert.ok(pass.events.some(rotated), 'a clock problem is not evidence about the certificate');
});

test('en håndskrevet tæller i state-filen kan ikke slå dækken fra', () => {
  const rotation = readCertRotation({ fingerprint: FINGERPRINT_A, baselineFingerprint: FINGERPRINT_B, seenAt: BASE, now: at(0) });
  const now = at(0);
  for (const counted of [undefined, null, 0, -4, '3', 2.5, Number.NaN]) {
    const alert = readCertRotationAlert({ rotation, previousAlertedAt: 'nonsense', counted, now });
    assert.ok(alert, `counted=${String(counted)} must not suppress an alert`);
    assert.equal(alert.held, 0, 'nothing is claimed to have been held that was not counted');
  }
});

test('en beskadiget sidste alarmtid tæller ikke som en alarm', () => {
  const rotation = readCertRotation({ fingerprint: FINGERPRINT_A, baselineFingerprint: FINGERPRINT_B, seenAt: BASE, now: at(0) });
  // A restored or half-written state file must not silence a site for an hour.
  for (const previousAlertedAt of [null, undefined, '', 'i går', 12345, {}]) {
    assert.ok(
      readCertRotationAlert({ rotation, previousAlertedAt, now: at(0) }),
      `previousAlertedAt=${String(previousAlertedAt)} must not silence a rotation`,
    );
  }
});

test('sætningen med sit 🔑 og sin time findes kun hos ejeren', () => {
  const rotation = readCertRotation({ fingerprint: FINGERPRINT_A, baselineFingerprint: FINGERPRINT_B, seenAt: BASE, now: at(0) });
  const alert = readCertRotationAlert({ rotation, now: at(0) });
  assert.equal(alert.message, `SSL certificate replaced — ${rotation.note}`);
  assert.equal(alert.held, 0);

  // One rotation held, and the sentence says so in the singular.
  const one = readCertRotationAlert({ rotation, counted: 1, now: at(0) });
  assert.match(one.message, /\(1 earlier rotation since the last alert, not sent\)$/);

  // …and the owner's own minute boundary: the hour is a limit, not an
  // off-by-one where the alert on the last pass of a flapping site is lost.
  const just = new Date(at(0).getTime() + CERT_ALERT_MIN_GAP_MS);
  assert.equal(readCertRotationAlert({ rotation, previousAlertedAt: BASE, now: at(CERT_ALERT_MIN_GAP_MS - 1) }), null);
  assert.ok(readCertRotationAlert({ rotation, previousAlertedAt: BASE, now: just }), 'the hour is reached, not passed');
  assert.equal(HOUR, CERT_ALERT_MIN_GAP_MS, 'the window is the hour the docs and the matrix name');
});
