/**
 * P1-69 — the client report could name *that* a certificate had been replaced,
 * *how many* times and *who* issued the new one, and not *which* certificate,
 * even though every state file has carried the answer since P0-3.
 *
 * Measured 2026-09-27 before a line was changed, with real passes writing a real
 * state file and the paid report surface reading it — a site that answered 200
 * in both passes, whose certificate was replaced on the second one by one from
 * another authority, which is what a hijack looks like on the wire:
 *
 *   state.json  lastCertSerial = "0badc0de99"  ← written by every pass
 *   report      **1 site has its certificate replaced …** (🔑 certificate replaced today)
 *   report      **1 site answers from a certificate authority other than …** (🏢 … → Rogue Cert BV)
 *   report --json  certRotated, certRotationCount, sslIssuer, certIssuerChanged…
 *                 — and no serial anywhere.
 *
 * A security questionnaire asks for the issuer *and* the serial, and this is the
 * document a bureau forwards when it is asked. The one surface that could answer
 * was the one-off `check`, which prints the same number truncated to 12
 * characters with an ellipsis — so the number existed in the product and was not
 * obtainable from any of it.
 *
 * The fix is the smallest one that gives the report what it is missing: the state
 * file has held the serial all along, so nothing new is stored, no new event
 * type is added, and no status, exit code, uptime number or existing cell moves.
 * The two terminal lists keep the sentence they have always printed — an
 * unshortened 40-character number teaches nothing on a line the reader glances
 * at — and the one caller that needs it asks for it, so that difference is a
 * decision in the call rather than a second sentence.
 *
 * The rules are the ones `certRotationCount` already follows, because they are
 * the same question asked of the same kind of file: a value is a serial number
 * when it is one and the absence of one otherwise, and only hex survives, so the
 * string cannot carry a newline, a pipe or a markdown escape into a document
 * that gets forwarded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, renderReportMarkdown } from '../src/report.js';
import { certRotationStateNote, certSerialNumber, readCertRotationState } from '../src/status.js';

const SITE = 'https://kunde.dk/';
const NOW = new Date('2026-09-27T09:00:00.000Z');
/** 40 hex characters: the longest a serial can be (RFC 5280, 20 octets). */
const SERIAL = '0badc0de99aabbccddeeff0011223344556677';
const ROTATED_AT = '2026-09-27T08:00:00.000Z';

const daysAgo = days => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

/** A state entry for a site whose certificate was replaced `ageDays` ago. */
function replaced({ ageDays = 0, serial = SERIAL, rotations = 1, issuer = 'Rogue Cert BV' } = {}) {
  return {
    url: SITE,
    wasUp: true,
    lastStatus: 200,
    lastResponseMs: 12,
    lastChecked: NOW.toISOString(),
    checks: 4,
    checksUp: 4,
    sslValidDays: 89,
    sslIssuer: issuer,
    lastCertRotatedAt: new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString(),
    certRotationCount: rotations,
    lastCertSerial: serial,
  };
}

const siteOf = (state, opts) => buildReport({ urls: { [SITE]: state }, passes: 4 }, { now: NOW, ...opts }).sites[0];
const markdown = state => renderReportMarkdown(buildReport({ urls: { [SITE]: state }, passes: 4 }, { now: NOW }), { now: NOW });

test('den kanoniske serial er hex i små bogstaver, eller ingenting', () => {
  assert.equal(certSerialNumber(SERIAL), SERIAL, 'a real serial passes through unchanged');
  assert.equal(certSerialNumber('0F:11:CE'), '0f11ce', 'the colons openssl prints are stripped, not kept');
  assert.equal(certSerialNumber('  0F11CE  '), '0f11ce', 'whitespace from a hand-edited file is not a value');
  // Everything that is the *absence* of a serial, from the three ways a state
  // file reaches this code: never written, written as nothing, or half-written.
  for (const absent of [null, undefined, '', '   ', 42, {}, [], true, 'zz', '0x']) {
    assert.equal(certSerialNumber(absent), null, `${JSON.stringify(absent)} is not a serial`);
  }
  // 41 characters is past the format's own maximum, so it is a value nobody can
  // look up — and printing it would put a number in a customer document that
  // answers to nothing. Shortening it instead would name a different certificate.
  assert.equal(certSerialNumber('a'.repeat(41)), null, 'past 20 octets is not a serial');
  assert.equal(certSerialNumber('a'.repeat(40)), 'a'.repeat(40), 'exactly 20 octets still is');
});

test('et håndredigeret serial kan ikke blive en sætning', () => {
  // The injection shapes, on the value that reaches a document a bureau forwards.
  // `certSerialNumber` accepts hex and the separators a serial is written with,
  // and nothing else — so there is no separator left to break out of a table row
  // with. Rejecting beats filtering here: the first version of the function
  // removed every non-hex character instead, and turned the word `not-a-serial`
  // into the serial `aeae`, which is a number a customer could have looked up.
  const hostile = ['a | evil', 'a\n| evil', '**OWNED**', 'a](javascript:x)', '`rm -rf`', '0f11ce | evil', 'not-a-serial'];
  for (const value of hostile) {
    assert.equal(certSerialNumber(value), null, `rejected, not cleaned: ${JSON.stringify(value)}`);
    const note = certRotationStateNote({ rotated: true, ageDays: 0, serial: value });
    assert.equal(note, '🔑 certificate replaced today', `no number reaches the document: ${JSON.stringify(value)}`);
  }
  // The separators that *are* legitimate still work, because they are how a serial
  // is written down everywhere — including by openssl and by check.
  assert.equal(certSerialNumber('0F:11:CE:00:01'), '0f11ce0001');
  assert.equal(certSerialNumber('0x0F11CE'), '0f11ce');
});

test('rapporten navngiver det certifikat der svarer nu', () => {
  const site = siteOf(replaced());
  assert.equal(site.certSerial, SERIAL, 'the JSON field carries the whole serial, not a prefix');
  assert.equal(site.certRotatedNote, `🔑 certificate replaced today · serial ${SERIAL}`);
  assert.ok(markdown(replaced()).includes(`🔑 certificate replaced today · serial ${SERIAL}`), 'and the customer reads it');
});

test('et site uden rotation får ingen linje og ingen tal', () => {
  // The rule P1-68 established, and the one this change has to respect: a site
  // whose certificate was never replaced has no line below the table at all, so
  // there is nothing for a number to ride on. The common case in a portfolio of
  // thirty client sites is exactly this one, and it is byte-for-byte what it was.
  const never = siteOf({
    url: SITE, wasUp: true, lastStatus: 200, lastChecked: NOW.toISOString(),
    sslValidDays: 89, sslIssuer: 'Lets Encrypt', lastCertSerial: SERIAL,
    checks: 4, checksUp: 4, lastResponseMs: 12,
  });
  assert.equal(never.certRotated, false);
  assert.equal(never.certRotatedNote, '', 'a stored serial is not a rotation');
  assert.equal(never.certSerial, SERIAL, 'but the field still answers, for the next surface that asks');
  // The number, not the word: the footnote below the table explains the serial in
  // every report, because a reader has to be able to look it up. What must not
  // appear for a site that never rotated is the *value*.
  assert.ok(!markdown({
    lastCertSerial: SERIAL, sslIssuer: 'Lets Encrypt', sslValidDays: 89, wasUp: true,
    lastStatus: 200, lastChecked: NOW.toISOString(), checks: 4, checksUp: 4, lastResponseMs: 12,
  }).includes(SERIAL), 'and the serial itself is nowhere in the document');
});

test('P1-68s regel om antallet står uændret ved siden af nummeret', () => {
  // One replacement is the routine every host does every 90 days, so it still
  // gets no count; more than one still gets one. The serial rides after that
  // clause, not instead of it, and a single renewal still names its certificate —
  // a TLS inventory lists issuer and serial together whatever the renewal
  // history, and a security questionnaire asks for the pair.
  const once = siteOf(replaced({ ageDays: 90, rotations: 1 }));
  assert.equal(once.certRotatedNote, `🔑 certificate replaced 90 d ago · serial ${SERIAL}`);
  assert.ok(!once.certRotatedNote.includes('replacements'), 'one replacement is still not a count');

  const many = siteOf(replaced({ ageDays: 1, rotations: 47 }));
  assert.equal(many.certRotatedNote, `🔑 certificate replaced 1 d ago · 47 replacements since the site was added · serial ${SERIAL}`,
    'the count clause and the serial both survive, in that order');
  assert.equal(many.certRotationCount, 47, 'and the field is untouched');
});

test('de to gratis-lister beholder den sætning de altid har skrevet', () => {
  // The lists share the sentence owner, and they do not ask for the serial. This
  // is the decision P1-69 made explicit rather than a side effect: a glance line
  // is not a place a 40-character number belongs, and the difference lives in the
  // call so there is still only one sentence.
  const entry = replaced({ ageDays: 2, rotations: 5 });
  const forLists = readCertRotationState(entry, { now: NOW });
  const forReport = readCertRotationState(entry, { now: NOW, withSerial: true });
  assert.equal(forLists.note, '🔑 certificate replaced 2 d ago · 5 replacements since the site was added');
  assert.equal(forLists.serial, SERIAL, 'the fact is there either way');
  assert.equal(forReport.note, `🔑 certificate replaced 2 d ago · 5 replacements since the site was added · serial ${SERIAL}`);
});

test('en rotation uden serial er stadig en rotation', () => {
  // Every state file written before this, and any site whose certificate reported
  // no serial at all. The sentence must not lose the fact to gain the number.
  for (const serial of [null, '', 'not-a-serial', 'zz', 'a'.repeat(41)]) {
    const site = siteOf(replaced({ serial }));
    assert.equal(site.certRotated, true, `still a rotation with ${JSON.stringify(serial)}`);
    assert.equal(site.certRotatedNote, '🔑 certificate replaced today');
    assert.equal(site.certSerial, null);
  }
});

test('de fire former af sætningen bærer alle nummeret', () => {
  // A wrong clock and an unreadable stamp are exactly the machines where the
  // number matters most, and where P1-68's own count was already carried. A form
  // that dropped the serial would give the reader the age and no certificate.
  const ahead = readCertRotationState({ ...replaced(), lastCertRotatedAt: '2099-01-01T00:00:00.000Z' }, { now: NOW, withSerial: true });
  assert.ok(ahead.note.includes(`serial ${SERIAL}`), 'the clock-ahead form carries the serial');
  assert.ok(ahead.note.includes('ahead of this machine'), 'and still names the clock');

  const unreadable = readCertRotationState({ ...replaced(), lastCertRotatedAt: 'OWNED' }, { now: NOW, withSerial: true });
  assert.equal(unreadable.note, `🔑 certificate replaced at an unreadable time · serial ${SERIAL}`);

  const today = readCertRotationState(replaced(), { now: NOW, withSerial: true });
  assert.equal(today.note, `🔑 certificate replaced today · serial ${SERIAL}`);

  const week = readCertRotationState(replaced({ ageDays: 7 }), { now: NOW, withSerial: true });
  assert.equal(week.note, `🔑 certificate replaced 7 d ago · serial ${SERIAL}`);
});
