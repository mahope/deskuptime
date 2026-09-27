/**
 * P1-64 — the client report could not say who issued the customer's certificate,
 * and a certificate that started answering from a *different* authority read
 * exactly like a routine renewal.
 *
 * `readSslIssuer` has measured the issuer since P1-53 and only `check` ever asked,
 * so nothing stored it: the state file had no issuer at all, and the document a
 * bureau forwards to a customer could not answer the first question a security
 * questionnaire asks, nor see the one signal that separates a renewal from a
 * domain that changed hands — a different authority.
 *
 * Measured 2026-09-27, real `runPass`, real state file, real CLI, before any code
 * changed. Two passes over a site that answers 200 in both; the only difference
 * is which certificate — and which authority — answered the second time:
 *
 *   | https://kunde.dk/ | UP (200) | 100% | … | 89 d | … |
 *   **1 site has its certificate replaced …** (🔑 certificate replaced today)
 *
 * The rotation was named, the authority was not: not in the table, not in a line
 * below it, not in `--json`, and not in the state file a later pass could read.
 * And the day count argues against noticing it — a reissued certificate usually
 * has *more* days left than the one it replaced, so the hijack read as the
 * healthier of the two.
 *
 * A different authority is not a verdict: moving a site to another host, or a
 * CA being taken over, produces one for innocent reasons. So nothing here moves a
 * status, an exit code, an uptime number or the SSL cell.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass } from '../src/watch.js';
import { certIssuerChangeNote, readCertIssuerState } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const SITE = 'https://kunde.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const OLD_ISSUER = { O: 'Ganske Cloud A/S' };
const NEW_ISSUER = { O: 'Rogue Cert BV' };

function tempState(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certissuer-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, 'state.json');
}

function daysAgo(days) {
  return new Date(new Date(BASE).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A site that answers 200 with the certificate and authority the test picks. */
function certCheck(readings) {
  let i = 0;
  return url => {
    const reading = readings[Math.min(i, readings.length - 1)];
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
        serialNumber: '01EE',
        fingerprint256: reading.fingerprint,
        subject: { CN: 'kunde.dk' },
        issuer: reading.issuer,
      },
      content: { hash: 'h1', contentLength: 89, title: 'Kunde' },
    };
  };
}

const UNCHANGED = { fingerprint: OLD, issuer: OLD_ISSUER };
const ROTATED_SAME_AUTHORITY = { fingerprint: NEW, issuer: OLD_ISSUER };
const ROTATED_OTHER_AUTHORITY = { fingerprint: 'c'.repeat(64), issuer: NEW_ISSUER };

// ---------------------------------------------------------------- the owner

test('en byttet udsteder læses med alder, begge navne og en tom tilstand uden den', () => {
  const now = new Date(BASE);
  const changed = readCertIssuerState({
    sslIssuer: 'Rogue Cert BV',
    certIssuerBefore: 'Ganske Cloud A/S',
    certIssuerChangedAt: daysAgo(3),
  }, { now });
  assert.equal(changed.changed, true);
  assert.equal(changed.issuer, 'Rogue Cert BV', 'hvem der udstedte det, der svarer nu');
  assert.equal(changed.previous, 'Ganske Cloud A/S', 'og hvem der gjorde det før — ellers er påstanden tom');
  assert.equal(changed.ageDays, 3, 'alderen følger med: en udsteder-skift er en kendsgerning om fortiden');
  assert.equal(changed.note, '🏢 certificate answers from a different issuer 3 d ago (Ganske Cloud A/S → Rogue Cert BV)');

  const today = readCertIssuerState({
    sslIssuer: 'Rogue Cert BV',
    certIssuerBefore: 'Ganske Cloud A/S',
    certIssuerChangedAt: daysAgo(0),
  }, { now });
  assert.equal(today.note, '🏢 certificate answers from a different issuer today (Ganske Cloud A/S → Rogue Cert BV)');

  const never = readCertIssuerState({ sslIssuer: 'Ganske Cloud A/S' }, { now });
  assert.equal(never.changed, false, 'et site hvis udsteder aldrig har flyttet sig har ingen linje');
  assert.equal(never.issuer, 'Ganske Cloud A/S', 'men den aktuelle udsteder er stadig en kendsgerning');
  assert.equal(never.note, '');
});

test('en halv påstand er ingen påstand: stempel uden gammelt navn, og navn uden stempel', () => {
  const now = new Date(BASE);
  const noPrevious = readCertIssuerState({ sslIssuer: 'Rogue Cert BV', certIssuerChangedAt: daysAgo(1) }, { now });
  assert.equal(noPrevious.changed, false, 'et stempel uden den udsteder, der blev forladt, kan ikke sige hvad der ændrede sig');
  const noStamp = readCertIssuerState({ sslIssuer: 'Rogue Cert BV', certIssuerBefore: 'Ganske Cloud A/S' }, { now });
  assert.equal(noStamp.changed, false, 'et navn uden stempel siger kun hvad sidste pass så, ikke at noget skiftede');
  assert.equal(noStamp.previous, 'Ganske Cloud A/S', 'men det navn er ikke slettet — det er stadig sandt');
});

test('alderen læses gennem passAge, så et ur ikke skriver sig til i dag', () => {
  const now = new Date(BASE);
  const unreadable = readCertIssuerState({ sslIssuer: 'B', certIssuerBefore: 'A', certIssuerChangedAt: 'not a date' }, { now });
  assert.equal(unreadable.changed, true, 'stemplet er der, det kan bare ikke placeres');
  assert.equal(unreadable.ageDays, null, 'et ulæseligt stempel har ingen alder, ikke en opdigtet');

  const ahead = readCertIssuerState({ sslIssuer: 'B', certIssuerBefore: 'A', certIssuerChangedAt: daysAgo(-3) }, { now });
  assert.match(ahead.note, /ahead of this machine's clock/);
  assert.equal(ahead.ageDays, null, 'et fremtidigt stempel navner skævningen, alderen forsvinder');

  const empty = readCertIssuerState({ sslIssuer: 'B', certIssuerBefore: 'A', certIssuerChangedAt: '' }, { now });
  assert.equal(empty.changed, false, 'en håndskrevet tom streng er ingen udsteder-skift');
});

test('et navn der ikke kan læses navngives ikke, og sætningen findes kun hos ejeren', () => {
  const now = new Date(BASE);
  const blank = readCertIssuerState({ sslIssuer: '   ', certIssuerBefore: '  ', certIssuerChangedAt: daysAgo(1) }, { now });
  assert.equal(blank.issuer, null);
  assert.equal(blank.changed, false, 'to navne, der ikke er navne, kan ikke danne en udsteder-skift');
  assert.equal(certIssuerChangeNote({ changed: false }), '');
  assert.equal(certIssuerChangeNote({ changed: true, ageDays: 0, previous: 'A', issuer: 'B' }), '🏢 certificate answers from a different issuer today (A → B)');
  assert.equal(certIssuerChangeNote({ changed: true, ageDays: 2, previous: 'A', issuer: 'B' }), '🏢 certificate answers from a different issuer 2 d ago (A → B)');
  assert.match(certIssuerChangeNote({ changed: true, ageDays: null, previous: 'A', issuer: 'B' }), /unreadable time \(A → B\)/);
  assert.match(certIssuerChangeNote({ changed: true, aheadMs: 5_000, previous: 'A', issuer: 'B' }), /ahead of this machine's clock/);
  // A certificate that reported no authority is not given an invented one.
  assert.match(certIssuerChangeNote({ changed: true, ageDays: 1, previous: 'A', issuer: null }), /\(A → an unnamed authority\)/);
});

// ------------------------------------------------------------- the write side

test('passet gemmer HVEM der udstedte, og HVOR NÅR en ny udsteder overtog', async (t) => {
  const stateFile = tempState(t);
  await runPass({ urls: { [SITE]: {} } }, { stateFile, check: certCheck([UNCHANGED]), returnResults: true });
  let entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.sslIssuer, 'Ganske Cloud A/S', 'den første læsning etablerer udstederen');
  assert.equal(entry.certIssuerChangedAt, undefined, 'en første læsning er ikke en udsteder-skift');

  // Same certificate, same authority: still nothing.
  await runPass({ urls: { [SITE]: { ...entry } } }, { stateFile, check: certCheck([UNCHANGED]), returnResults: true });
  entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.certIssuerChangedAt, undefined, 'det samme certifikat fra det samme sted er ingen skift');

  // A renewal by the *same* authority: a rotation, but not a change of authority.
  await runPass({ urls: { [SITE]: { ...entry } } }, { stateFile, check: certCheck([ROTATED_SAME_AUTHORITY]), returnResults: true });
  entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.sslIssuer, 'Ganske Cloud A/S');
  assert.equal(entry.certIssuerChangedAt, undefined, 'den hyppigste fornyelse skal ikke se ud som et skift');
  assert.equal(typeof entry.lastCertRotatedAt, 'string', 'men rotationen er stadig en rotation');

  // Another authority answers: this is the fact the report could not do without.
  await runPass({ urls: { [SITE]: { ...entry } } }, { stateFile, check: certCheck([ROTATED_OTHER_AUTHORITY]), returnResults: true });
  entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.sslIssuer, 'Rogue Cert BV', 'hvem der svarer nu');
  assert.equal(entry.certIssuerBefore, 'Ganske Cloud A/S', 'hvem der svarede før, så påstanden kan pege på en forandring');
  assert.equal(typeof entry.certIssuerChangedAt, 'string');

  // And it moves nothing that describes the site.
  assert.equal(entry.wasUp, true, 'en ny udsteder er ikke et nedet site');
  assert.equal(entry.sslValidDays, 89, 'og nedtællingen er den nye certificats, ikke en dom');
});

test('et certifikat uden udsteder sletter ikke den sidste kendte', async (t) => {
  const stateFile = tempState(t);
  await runPass({ urls: { [SITE]: {} } }, { stateFile, check: certCheck([UNCHANGED]), returnResults: true });
  const entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  await runPass({ urls: { [SITE]: { ...entry } } }, {
    stateFile,
    check: url => {
      const result = certCheck([UNCHANGED])(url);
      return { ...result, ssl: { ...result.ssl, issuer: undefined } };
    },
    returnResults: true,
  });
  const after = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(after.sslIssuer, 'Ganske Cloud A/S', 'et certifikat uden oplyst udsteder er ikke en udsteder, der forsvandt');
});

// ---------------------------------------------------------------- the report

/** The report over a state file a real pass left behind. */
function reportOver(entry, now = new Date(BASE)) {
  return renderReportMarkdown(buildReport({ urls: { [SITE]: entry } }, { now }));
}

function hijacked() {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgo(0),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    lastResponseMs: 12,
    sslValidDays: 89,
    lastCertFingerprint: NEW,
    lastCertSeenAt: daysAgo(0),
    lastCertRotatedAt: daysAgo(2),
    sslIssuer: 'Rogue Cert BV',
    certIssuerBefore: 'Ganske Cloud A/S',
    certIssuerChangedAt: daysAgo(2),
  };
}

test('et kundedokument skal kunne se at en ny udsteder har taget over', () => {
  const markdown = reportOver(hijacked());
  assert.ok(markdown.includes('1 site answers from a certificate authority other than the one'), markdown);
  assert.ok(markdown.includes('https://kunde.dk/ (🏢 certificate answers from a different issuer 2 d ago (Ganske Cloud A/S → Rogue Cert BV))'), markdown);
  assert.ok(markdown.includes('· 1 from a new certificate authority'), 'tællingen i resumelinjen:');
  assert.ok(markdown.includes('`sslIssuer` in `--json` names the authority'), 'fodnoten forklarer feltet:');
});

test('en fornyelse fra den samme udsteder er stadig en rotation og ikke et skift', () => {
  const markdown = reportOver({
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgo(0),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    lastResponseMs: 12,
    sslValidDays: 89,
    lastCertRotatedAt: daysAgo(2),
    sslIssuer: 'Ganske Cloud A/S',
  });
  assert.ok(markdown.includes('1 site has its certificate replaced'), markdown);
  assert.ok(!markdown.includes('different issuer'), '90 dages fornyelser må ikke se ud som et skift af udsteder');
  assert.ok(!markdown.includes('new certificate authority'), markdown);
});

test('et sundt site uden stempel giver ingen linje, ingen tælling og ingen felt', () => {
  const json = buildReport({
    urls: {
      [SITE]: {
        wasUp: true,
        lastStatus: 200,
        lastChecked: daysAgo(0),
        addedAt: daysAgo(30),
        checks: 100,
        checksUp: 100,
        lastResponseMs: 12,
        sslValidDays: 89,
        lastCertFingerprint: OLD,
        lastCertSeenAt: daysAgo(9),
        sslIssuer: 'Ganske Cloud A/S',
      },
    },
  }, { now: new Date(BASE) });
  const site = json.sites[0];
  assert.equal(site.sslIssuer, 'Ganske Cloud A/S', 'hvem der udstedte det, kan altid svares — også uden et skift');
  assert.equal(site.certIssuerChanged, false);
  assert.equal(site.certIssuerChangedNote, '');
  assert.equal(json.summary.certIssuerChanged, 0);
  assert.ok(!renderReportMarkdown(json).includes('different issuer'), 'ingen linje for det normale tilfælde');
});

test('to sites, kun den ene hos en ny udsteder: tællingen er pr. site', () => {
  const markdown = renderReportMarkdown(buildReport({
    urls: {
      [SITE]: hijacked(),
      'https://denandet.dk/': { ...hijacked(), lastCertRotatedAt: undefined, certIssuerBefore: undefined, certIssuerChangedAt: undefined, sslIssuer: 'Ganske Cloud A/S' },
    },
  }, { now: new Date(BASE) }));
  assert.ok(markdown.includes('1 site answers from a certificate authority other than the one'), markdown);
  assert.ok(markdown.includes('1 from a new certificate authority'), markdown);
  assert.ok(!markdown.includes('sites answer from a certificate authority'), 'fleralformen hører til et flertal');
});

test('rækken, SSL-cellen og alle tal fra før denne ændring er uændrede', () => {
  const markdown = reportOver(hijacked());
  const row = markdown.split('\n').find(line => line.startsWith('| https://kunde.dk/ |'));
  assert.ok(row.includes('| https://kunde.dk/ | UP (200) | 100% (100 checks)'), row);
  assert.ok(row.includes('| 12 ms | 89 d |'), row);
  assert.ok(!row.includes('Rogue Cert BV') && !row.includes('Ganske Cloud'), 'udstederen kommer ikke i SSL-cellen — den er en linje under tabellen');
  assert.ok(
    markdown.includes('**1 site(s) · 1 up · 0 down · 100 checks · 0 failed · 1 certificate replaced · 1 from a new certificate authority'),
    'resume- og tællingslinjen er den gamle plus den nye tælling',
  );
});
