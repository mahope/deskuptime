/**
 * P1-60 — a domain that is no longer the customer's answered 200 with a valid
 * certificate, and every surface called it healthy.
 *
 * `checkSSL` has read `serialNumber` on every SSL check since P0-3, and no
 * surface could read it. Measured 2026-09-27, real CLI, a state file holding a
 * stored certificate fingerprint that was deliberately wrong, nothing changed:
 *
 *   state: lastCertFingerprint <forkert>, lastCertSeenAt 7 d ago
 *   check -> 🔒 SSL: 89d ✅ / 🏷️ Issuer: SSL Corporation /
 *            📜 Certificate covers example.com / 🔐 TLS: TLSv1.3
 *   check --json -> intet cert-felt
 *   et pass skriver lastCertFingerprint -> 0 steder
 *
 * The three certificate questions the tool could answer were all *about* the
 * certificate and none of them *was* it: who issued it (P1-53), does it cover
 * the host (P1-54), and — the one an agency asks after a hijack — is it still
 * the same one? A domain that expires and gets bought answers 200 with someone
 * else's certificate: the countdown counts down, the issuer is named, the
 * coverage matches, because the new certificate covers the site's own name.
 *
 * The identity is `fingerprint256`, not the `fingerprint` the checker has also
 * read since P0-3: SHA-1 is collision-broken and this is a security tool. The
 * SHA-1 field is left exactly as Node produced it, so nothing that read it
 * silently changes meaning.
 *
 * Nothing here moves a verdict. A rotated certificate is still `UP (200)`,
 * still exit 0, because a certificate is not a status code. What changes is
 * that the fact is now visible: one line and four additive JSON fields in
 * `check`, one stored identity per site, and one new event type on the paid
 * channel. Spec: docs/cert-rotation.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

import { runPass, WEBHOOK_EVENT_TYPES } from '../src/watch.js';
import { readCertIdentity, readCertRotation, CERT_VERDICT } from '../src/status.js';
import { checkSSL } from '../src/checkers/ssl.js';
import { selfSignedFixture } from './helpers/certs.mjs';

const SITE = 'https://kunde.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const SERIAL = '01EEE6AABB521D5E14FC315FD9985690';
const SHA256 = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function tempState(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certrot-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, 'state.json');
}

function daysAgo(days) {
  return new Date(new Date(BASE).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hasOpenssl() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

/**
 * A local TLS server serving a real, currently valid certificate, generated per
 * run from `helpers/certs.mjs`.
 *
 * This test used to shake hands with `https://example.com`, and the gate's
 * colour was then decided by the network rather than by the code: commit
 * 606166c was green here and red on the runner with `read ECONNRESET` from a
 * plan-only diff. The claim being tested is about a *certificate*, so the
 * certificate is made here instead — same assertion, no public host.
 *
 * `toDays` is negative, which puts `notAfter` 30 days in the future: the
 * certificate has to be one the checker would otherwise accept, or a future
 * change to how it treats an expired certificate would fail this test for the
 * wrong reason. Nothing is committed — the fixture is written to a temp
 * directory and removed with it — so the "no fixture in the repo ever expires"
 * guarantee the helper documents still holds.
 */
function localCertServer(t) {
  const { key, cert } = selfSignedFixture(t, {
    fromDays: 4000,
    toDays: -30,
    subject: '/O=DeskUptime Test CA/CN=127.0.0.1',
    sans: 'IP:127.0.0.1',
  });
  const server = tls.createServer({ key, cert }, (socket) => socket.end('hi'));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      url: `https://127.0.0.1:${server.address().port}/`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

/** A site that answers 200 with a certificate whose identity the test picks. */
function certCheck(fingerprints) {
  let i = 0;
  return (url) => {
    const fingerprint = fingerprints[Math.min(i, fingerprints.length - 1)];
    i += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      ssl: {
        validDays: 89,
        isExpired: false,
        serialNumber: SERIAL,
        fingerprint256: fingerprint,
        subject: { CN: 'kunde.dk' },
        issuer: { O: 'Test CA' },
      },
      content: { hash: 'h1', contentLength: 89 },
    };
  };
}

// ---------------------------------------------------------------- the owner

test('identiteten normaliseres, så tegnsætning aldrig kan finde på en rotation', () => {
  const id = readCertIdentity({
    serialNumber: '01:EE:E6:AA:BB:52:1D:5E:14:FC:31:5F:D9:98:56:90',
    fingerprint256: '89:9C:B2:59:E7:DE:8D:F1:00:33:A2:AF:48:C2:2C:2F:65:80:A2:1D',
  });
  assert.equal(id.serial, SERIAL.toLowerCase());
  assert.equal(id.fingerprint, '899cb259e7de8df10033a2af48c22c2f6580a21d');
});

test('intet at dømme om er null pr. felt, aldrig en opdigtet værdi', () => {
  assert.equal(readCertIdentity(null), null, 'ingen måling overhovedet');
  assert.equal(readCertIdentity({}), null, 'et resultat uden certifikat');
  assert.equal(readCertIdentity('nonsense'), null, 'ikke et objekt');
  const half = readCertIdentity({ serialNumber: SERIAL });
  assert.equal(half.serial, SERIAL.toLowerCase());
  assert.equal(half.fingerprint, null, 'et læst serienummer opfinder ikke et fingerprint');
  const empty = readCertIdentity({ serialNumber: '', fingerprint256: ':' });
  assert.equal(empty, null, 'kun tegnsætning er ikke en identitet');
});

test('de tre verdikter, og uden baseline er null — ikke false', () => {
  const now = new Date(BASE);
  const none = readCertRotation({ fingerprint: SHA256, baselineFingerprint: null, now });
  assert.equal(none.verdict, CERT_VERDICT.NO_BASELINE);
  assert.equal(none.rotated, null, '`null` betyder "intet at sammenligne med", ikke `false`');
  assert.equal(none.compared, false);

  const same = readCertRotation({ fingerprint: SHA256, baselineFingerprint: SHA256, seenAt: daysAgo(0), now });
  assert.equal(same.verdict, CERT_VERDICT.SAME);
  assert.equal(same.rotated, false);
  assert.equal(same.note, 'same certificate as the certificate seen today');

  const rotated = readCertRotation({ fingerprint: SHA256, baselineFingerprint: OTHER, seenAt: daysAgo(3), now });
  assert.equal(rotated.verdict, CERT_VERDICT.ROTATED);
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.note, 'certificate rotated since the certificate seen 3 d ago');
  assert.equal(rotated.ageDays, 3, 'alderen følger med, fordi "samme" er sandt om to læsninger');
});

test('et gemt fingerprint med andre tegn er samme certifikat, ikke en rotation', () => {
  const stored = SHA256.replace(/(.{2})/g, '$1:').replace(/:$/, '').toUpperCase();
  const now = new Date(BASE);
  const same = readCertRotation({ fingerprint: SHA256, baselineFingerprint: stored, seenAt: daysAgo(0), now });
  assert.equal(same.verdict, CERT_VERDICT.SAME, 'et fingerabdtryk skrevet med koloner og store bogstaver er ikke et nyt certifikat');
  const whitespace = readCertRotation({ fingerprint: SHA256, baselineFingerprint: `  ${OTHER}  `, seenAt: daysAgo(0), now });
  assert.equal(whitespace.verdict, CERT_VERDICT.ROTATED, 'men et andet certifikat er stadig et andet');
});

test('alderen læses gennem passAge, så et ur ikke alderes til i dag', () => {
  const now = new Date(BASE);
  const unreadable = readCertRotation({ fingerprint: SHA256, baselineFingerprint: OTHER, seenAt: 'not a date', now });
  assert.equal(unreadable.note, 'certificate rotated since a certificate of unknown age');
  assert.equal(unreadable.ageDays, null, 'et ulæseligt stempel har ingen alder, ikke en opdigtet');
  const ahead = readCertRotation({ fingerprint: SHA256, baselineFingerprint: OTHER, seenAt: daysAgo(-3), now });
  assert.match(ahead.note, /ahead of this machine's clock/);
  assert.equal(ahead.ageDays, null, 'et fremtidigt stempel navner skævningen, alderen forsvinder');
});

test('målt på et rigtigt certifikat: checkSSL læser begge identitetsfelter', async (t) => {
  if (!hasOpenssl()) {
    t.skip('openssl is unavailable, cannot create a TLS fixture');
    return;
  }
  const server = await localCertServer(t);
  t.after(() => server.close());

  const ssl = await checkSSL(server.url, { timeoutMs: 10_000 });
  assert.equal(ssl.error, undefined, `målingen skal nå et certifikat: ${ssl.error}`);
  // The fixture is the whole reason this measurement is worth taking: a
  // certificate the checker is willing to read, read through a real handshake.
  assert.equal(ssl.isExpired, false, 'fixtures measure a live certificate, so an expiry change cannot fail this test by accident');
  const id = readCertIdentity(ssl);
  assert.match(id.serial, /^[0-9a-f]+$/, 'serienummeret er hex, skrevet af udstederen');
  assert.equal(id.fingerprint.length, 64, 'identitetshashet er SHA-256, ikke SHA-1');
  assert.notEqual(id.fingerprint, ssl.fingerprint.replace(/:/g, '').toLowerCase(), 'SHA-1 er ikke det hashet, sammenligningen stoler på');
});

// ------------------------------------------------------------ the paid channel

test('passet giver den betalte kanal besked om en rotation — og kun om en rotation', async (t) => {
  const stateFile = tempState(t);
  // First reading: a baseline is not an event, exactly as a first reading of a
  // page is not. A user who has just added a site must not get an alert about a
  // certificate they never saw before.
  const first = await runPass({ urls: { [SITE]: {} } }, { stateFile, check: certCheck([SHA256]), returnResults: true });
  assert.equal(first.events.filter(e => e.type === 'cert_rotated').length, 0, 'en første læsning er ikke en rotation');
  const stored = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(stored.lastCertFingerprint, SHA256, 'identiteten gemmes, så næste pass har noget at sammenligne med');
  assert.equal(stored.lastCertSerial, SERIAL.toLowerCase());

  // Same certificate on the next pass: still no event.
  const same = await runPass({ urls: { [SITE]: { ...stored } } }, { stateFile, check: certCheck([SHA256]), returnResults: true });
  assert.equal(same.events.filter(e => e.type === 'cert_rotated').length, 0, 'det samme certifikat er ikke en rotation');

  // A different certificate: the one alert this type exists for.
  const rotated = await runPass({ urls: { [SITE]: { ...stored } } }, { stateFile, check: certCheck([OTHER]), returnResults: true });
  const events = rotated.events.filter(e => e.type === 'cert_rotated');
  assert.equal(events.length, 1, 'en rotation siges én gang');
  assert.match(events[0].message, /SSL certificate replaced/);
  assert.match(events[0].message, /d ago|today/, 'sætningen bærer alderen på den læsning den blev sammenlignet med');
  const after = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(after.lastCertFingerprint, OTHER, 'den nye identitet overtager, så næste rotation kan ses');
});

test('en rotation er ikke en fejl: verdikt, exit-relevante felter og tællere er urørte', async (t) => {
  const stateFile = tempState(t);
  const state = { urls: { [SITE]: { lastCertFingerprint: OTHER, lastCertSeenAt: daysAgo(2), wasUp: true } } };
  const pass = await runPass(state, { stateFile, check: certCheck([SHA256]), returnResults: true });
  assert.equal(pass.events.filter(e => e.type === 'cert_rotated').length, 1);
  assert.equal(pass.results[0].healthy, true, 'et nyt certifikat er ikke et nedet site');
  assert.equal(pass.results[0].statusCode, 200);
  const entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.wasUp, true, 'og loopens egen bedømmelse af sitet er uændret');
  assert.equal(entry.lastStatus, 200);
});

// ------------------------------------------------------------------- the locks

test('hændelsestypen er i koden, i specen og i den sendte liste', () => {
  assert.ok(WEBHOOK_EVENT_TYPES.includes('cert_rotated'), 'den nye type sendes i den betalte kanal');
  const spec = readFileSync(join(import.meta.dirname, '..', 'docs', 'pro-alerts.md'), 'utf8');
  assert.match(spec, /cert_rotated/, 'docs/pro-alerts.md §2 er kontrakten en adapter skrives imod');
  const own = readFileSync(join(import.meta.dirname, '..', 'docs', 'cert-rotation.md'), 'utf8');
  assert.match(own, /fingerprint256/, 'specen siger hvilken hash der stoles på');
});

test('sætningen og reglen har én ejer: passet og check spørger, de afgør ikke selv', () => {
  const watch = readFileSync(join(import.meta.dirname, '..', 'src', 'watch.js'), 'utf8');
  const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.js'), 'utf8');
  const status = readFileSync(join(import.meta.dirname, '..', 'src', 'status.js'), 'utf8');
  assert.equal((watch.match(/readCertRotation\(\{/g) || []).length, 1, 'passen spørger ejeren pr. site');
  assert.equal((cli.match(/readCertRotation\(\{/g) || []).length, 1, 'check spørger den samme ejer');
  assert.match(status, /certificate rotated since \$\{when\}/, 'sætningen findes kun i ejeren');
  assert.doesNotMatch(watch, /certificate rotated since/, 'passen skriver ikke sin egen sætning');
  assert.doesNotMatch(cli, /certificate rotated since/, 'check gør heller ikke det');
});
