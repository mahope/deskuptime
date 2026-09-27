/**
 * P1-61 — the client report could not see that a site's certificate had been
 * replaced, and the state file it reads had thrown the fact away.
 *
 * P1-60 made the rotation visible in `check`, in the watch loop's events and on
 * the paid webhook. It left two surfaces silent, and this is the first and the
 * expensive one: `report` is the document a bureau forwards to the customer.
 *
 * Measured 2026-09-27, real CLI, real `runPass`, two state files written by real
 * passes over a site that answers 200 in both. The only difference between them
 * is which certificate answered on the second day:
 *
 *   uændret certifikat         →  | kunde.dk | UP (200) | 100% | … | 88 d | …
 *   certifikatet byttet i dag  →  | kunde.dk | UP (200) | 100% | … | 89 d | …
 *
 * No line, no count, no JSON field — and the SSL day count is not even a signal,
 * because a reissued certificate usually has *more* days left than the one it
 * replaced. The hijack read as the healthier of the two.
 *
 * The cause was on the write side, not the read side. `runPass` overwrites
 * `lastCertFingerprint` with the new identity on the pass that saw the rotation,
 * so a day later the state file could not tell the two cases apart either. The
 * same shape as the page: `lastContentChangedAt` (P1-56) and now
 * `lastCertRotatedAt`, with `readCertRotationState` as the one owner.
 *
 * A replaced certificate is not a verdict — most hosts reissue every 90 days —
 * so nothing here moves a status, an exit code or an uptime number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPass } from '../src/watch.js';
import { readCertRotationState, certRotationStateNote } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const SITE = 'https://kunde.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const SHA256 = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function tempState(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certrotreport-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, 'state.json');
}

function daysAgo(days) {
  return new Date(new Date(BASE).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A site that answers 200 with the certificate the test picks. */
function certCheck(fingerprints) {
  let i = 0;
  return url => {
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
        serialNumber: '01EEE6AABB521D5E14FC315FD9985690',
        fingerprint256: fingerprint,
        subject: { CN: 'kunde.dk' },
        issuer: { O: 'Test CA' },
      },
      content: { hash: 'h1', contentLength: 89, title: 'Kunde' },
    };
  };
}

// ---------------------------------------------------------------- the owner

test('en rotation i state-filen læses med sin alder, og en manglende er false', () => {
  const now = new Date(BASE);
  const rotated = readCertRotationState({ lastCertRotatedAt: daysAgo(3) }, { now });
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.rotatedAt, daysAgo(3));
  assert.equal(rotated.ageDays, 3, 'alderen følger med, fordi en rotation er en kendsgerning om fortiden');
  assert.equal(rotated.note, '🔑 certificate replaced 3 d ago');

  const today = readCertRotationState({ lastCertRotatedAt: daysAgo(0) }, { now });
  assert.equal(today.note, '🔑 certificate replaced today');

  const never = readCertRotationState({ lastCertFingerprint: SHA256, lastCertSeenAt: daysAgo(9) }, { now });
  assert.equal(never.rotated, false, 'et site uden rotation har ingen linje, ikke en tom');
  assert.equal(never.rotatedAt, null);
  assert.equal(never.note, '', 'ingen sætning er bedre end en der ligner en kendsgerning');
});

test('alderen læses gennem passAge, så et ur ikke alderes til i dag', () => {
  const now = new Date(BASE);
  const unreadable = readCertRotationState({ lastCertRotatedAt: 'not a date' }, { now });
  assert.equal(unreadable.rotated, true, 'stemplet er der, det kan bare ikke placeres');
  assert.equal(unreadable.ageDays, null, 'et ulæseligt stempel har ingen alder, ikke en opdigtet');
  assert.equal(unreadable.note, '🔑 certificate replaced at an unreadable time');

  const ahead = readCertRotationState({ lastCertRotatedAt: daysAgo(-3) }, { now });
  assert.match(ahead.note, /ahead of this machine's clock/);
  assert.equal(ahead.ageDays, null, 'et fremtidigt stempel navner skævningen, alderen forsvinder');

  // A hand-written empty string is no rotation, not a rotation of unknown age.
  const empty = readCertRotationState({ lastCertRotatedAt: '' }, { now });
  assert.equal(empty.rotated, false);
});

test('sætningen findes kun hos ejeren', () => {
  assert.equal(certRotationStateNote({ rotated: false }), '');
  assert.equal(certRotationStateNote({ rotated: true, ageDays: 0 }), '🔑 certificate replaced today');
  assert.equal(certRotationStateNote({ rotated: true, ageDays: 12 }), '🔑 certificate replaced 12 d ago');
  assert.equal(certRotationStateNote({ rotated: true, aheadMs: 5_000 }), '🔑 certificate replaced — 5 s ahead of this machine\'s clock');
});

// ------------------------------------------------------------- the write side

test('passet gemmer HVORNÅR certifikatet blev byttet, ikke bare det nye', async (t) => {
  const stateFile = tempState(t);
  // First reading: a baseline. Nothing was replaced, so nothing is stamped.
  await runPass({ urls: { [SITE]: {} } }, { stateFile, check: certCheck([SHA256]), returnResults: true });
  let entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.lastCertFingerprint, SHA256);
  assert.equal(entry.lastCertRotatedAt, undefined, 'en første læsning er ikke en rotation');

  // Same certificate: still nothing.
  await runPass({ urls: { [SITE]: { ...entry } } }, { stateFile, check: certCheck([SHA256]), returnResults: true });
  entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.lastCertRotatedAt, undefined, 'det samme certifikat er ikke en rotation');

  // A different one: this is the stamp the report could not do without.
  await runPass({ urls: { [SITE]: { ...entry } } }, { stateFile, check: certCheck([OTHER]), returnResults: true });
  entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(entry.lastCertFingerprint, OTHER, 'den nye identitet overtager, så næste rotation kan ses');
  assert.equal(typeof entry.lastCertRotatedAt, 'string', 'men hvornår den skiftede, overlever også');
  assert.equal(Date.parse(entry.lastCertRotatedAt) <= Date.now(), true);

  // And it does not move anything that describes the site.
  assert.equal(entry.wasUp, true, 'et nyt certifikat er ikke et nedet site');
  assert.equal(entry.sslValidDays, 89, 'og nedtællingen er den nye certificats, ikke en dom');
});

test('et kønt certifikat, der aldrig er byttet, efterlader intet at læse', async (t) => {
  const stateFile = tempState(t);
  await runPass({ urls: { [SITE]: {} } }, { stateFile, check: certCheck([SHA256]), returnResults: true });
  const entry = JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE];
  assert.equal(readCertRotationState(entry, { now: new Date() }).rotated, false);
});

// ------------------------------------------------------------ the report

/** The report over a state file a real pass left behind. */
function reportOver(entry, now = new Date(BASE)) {
  return renderReportMarkdown(buildReport({ urls: { [SITE]: entry } }, { now }));
}

test('et kundedokument skal kunne se et certifikat, der er blevet byttet', () => {
  const markdown = reportOver({
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgo(0),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    lastResponseMs: 12,
    sslValidDays: 89,
    lastCertRotatedAt: daysAgo(3),
  });
  assert.ok(markdown.includes('1 site has its certificate replaced'), markdown);
  assert.ok(markdown.includes(`https://kunde.dk/ (🔑 certificate replaced 3 d ago)`), markdown);
  assert.ok(markdown.includes('· 1 certificate replaced'), 'tællingen i resumelinjen:');
  assert.ok(markdown.includes('the SSL column above counts down from the new certificate'), markdown);
});

test('et uændret certifikat giver ingen linje og ingen tælling', () => {
  const markdown = reportOver({
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgo(0),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    lastResponseMs: 12,
    sslValidDays: 89,
    lastCertFingerprint: SHA256,
    lastCertSeenAt: daysAgo(9),
  });
  assert.ok(!markdown.includes('certificate replaced'), 'et site uden rotation skal ikke få en linje om en');
  assert.ok(!markdown.includes('certificates replaced'), markdown);
});

test('to sites, én byttet: fleralformen og tællingen', () => {
  const markdown = renderReportMarkdown(buildReport({
    urls: {
      [SITE]: { wasUp: true, lastStatus: 200, lastChecked: daysAgo(0), checks: 5, checksUp: 5, lastCertRotatedAt: daysAgo(1) },
      'https://to.dk/': { wasUp: true, lastStatus: 200, lastChecked: daysAgo(0), checks: 5, checksUp: 5, lastCertRotatedAt: daysAgo(2) },
    },
  }, { now: new Date(BASE) }));
  assert.ok(markdown.includes('2 sites have their certificate replaced'), markdown);
  assert.ok(markdown.includes('· 2 certificates replaced'), markdown);
});

test('--json bærer den samme kendsgerning, additivt', () => {
  const built = buildReport({
    urls: {
      [SITE]: { wasUp: true, lastStatus: 200, lastChecked: daysAgo(0), checks: 5, checksUp: 5, sslValidDays: 89, lastCertRotatedAt: daysAgo(3) },
      'https://to.dk/': { wasUp: true, lastStatus: 200, lastChecked: daysAgo(0), checks: 5, checksUp: 5, sslValidDays: 89 },
    },
  }, { now: new Date(BASE) });
  const rotated = built.sites.find(site => site.url === SITE);
  const quiet = built.sites.find(site => site.url === 'https://to.dk/');
  assert.equal(rotated.certRotated, true);
  assert.equal(rotated.certRotatedAt, daysAgo(3));
  assert.equal(rotated.certRotatedAgeDays, 3);
  assert.equal(rotated.certRotatedNote, '🔑 certificate replaced 3 d ago');
  assert.equal(built.summary.certRotated, 1);
  // Additive: the site without a rotation says false and null, never a guess.
  assert.equal(quiet.certRotated, false);
  assert.equal(quiet.certRotatedAt, null);
  assert.equal(quiet.certRotatedAgeDays, null);
  assert.equal(quiet.certRotatedNote, '');
  // And nothing that described the site moved: a reissued certificate is a fact,
  // not a verdict.
  assert.equal(rotated.status, 'up');
  assert.equal(rotated.sslDaysRemaining, 89);
});

test('en rotation rører ikke de øvrige tal i dokumentet', () => {
  const base = { wasUp: true, lastStatus: 200, lastChecked: daysAgo(0), addedAt: daysAgo(30), checks: 100, checksUp: 98, lastResponseMs: 12, sslValidDays: 89 };
  const strip = report => {
    const copy = JSON.parse(JSON.stringify(report));
    delete copy.summary.certRotated;
    for (const site of copy.sites) {
      delete site.certRotated;
      delete site.certRotatedAt;
      delete site.certRotatedAgeDays;
      delete site.certRotatedNote;
    }
    return copy;
  };
  const quiet = strip(buildReport({ urls: { [SITE]: base } }, { now: new Date(BASE) }));
  const rotated = strip(buildReport({ urls: { [SITE]: { ...base, lastCertRotatedAt: daysAgo(1) } } }, { now: new Date(BASE) }));
  assert.deepEqual(rotated, quiet, 'kun de additive felter er nye');
  // …and the Markdown differs in exactly two places: the summary line, which
  // grows the count, and the named line below the table. Every other line — the
  // table row, the footnote, the privacy line — is character for character equal.
  const before = renderReportMarkdown(buildReport({ urls: { [SITE]: base } }, { now: new Date(BASE) })).split('\n');
  const after = renderReportMarkdown(buildReport({ urls: { [SITE]: { ...base, lastCertRotatedAt: daysAgo(1) } } }, { now: new Date(BASE) })).split('\n');
  const added = after.filter(line => !before.includes(line));
  const removed = before.filter(line => !after.includes(line));
  assert.equal(removed.length, 1, `resumlinjen flytter tællingen, intet andet: ${removed.join(' / ')}`);
  assert.ok(removed[0].startsWith('**1 site(s) ·'), removed[0]);
  assert.equal(added.length, 2, `to linjer til, resum og navngivelse: ${added.join(' / ')}`);
  assert.ok(added[0].endsWith('· 1 certificate replaced**'), added[0]);
});
