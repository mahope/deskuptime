/**
 * P1-68 — the paid report could not tell a site that renewed its certificate
 * from a site that rotates it constantly, and said the same words about both.
 *
 * P1-63 stopped a flapping name from sending an alert on every pass, and it
 * counted what it held back in `certRotationsHeld` so nothing was dropped. That
 * counter is spent on the next alert that goes out, and `lastCertRotatedAt` is a
 * time, not a count — so neither of them could say how many rotations there
 * have been. Measured 2026-09-27, 24 h of real passes over two sites, both
 * answering 200 with a valid certificate, differing only in which certificate
 * answers:
 *
 *   quiet.dk   renewed once, the ordinary 90-day case
 *   flap.dk    a different certificate on every pass — a CDN mid-rollout, a
 *              canary deploy, or a domain rotating certificates to stay ahead
 *              of a blocklist
 *
 * The client report a bureau forwards, written 90 days after monitoring stopped:
 *
 *   **2 sites have their certificate replaced since monitoring — …:**
 *   https://quiet.dk/ (🔑 certificate replaced 90 d ago)
 *   https://flap.dk/   (🔑 certificate replaced 90 d ago)
 *
 * Two lines, character for character equal, about the difference between a
 * renewal every host does four times a year and the shape a hijack takes. The
 * report is where that difference is worth money, and it was the one surface
 * that could not see it.
 *
 * So the pass counts, on the same branch and in the same pass as the stamp that
 * already existed — a rotation can never be counted in one and not the other —
 * and `readCertRotationState`, the owner P1-61 made and P1-62/P1-64/P1-65
 * extended, carries the count to all three surfaces. The two free lists ask the
 * same owner, so they say it without a line of their own.
 *
 * **The ordinary case is byte-for-byte unchanged.** One replacement says
 * `🔑 certificate replaced 90 d ago`, exactly as it always has, because a client
 * who reads "1 replacement" learns nothing they did not have and a number in a
 * forwarded document has to be worth reading. Only a second one changes it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPass } from '../src/watch.js';
import { certRotationCount, certRotationStateNote, readCertRotationState, readEntry } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';
import { tempHome } from './helpers/env.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const QUIET = 'https://quiet.dk/';
const FLAP = 'https://flap.dk/';
const BASE = '2026-06-27T09:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const at = offsetMs => new Date(new Date(BASE).getTime() + offsetMs);
const fingerprint = n => String(n).padStart(2, '0').repeat(32);

/**
 * Two sites over one checker, which is what `runPass` hands it: one call per
 * site per pass. The pass number is counted *per url* — a single shared call
 * counter advances twice per pass and pins both sites to one certificate
 * forever, which is what the first version of the measurement did.
 */
function twoSites({ renewalAt = 24, flapping = true } = {}) {
  const seen = new Map();
  return url => {
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    const now = at((n - 1) * HOUR / 2);
    const identity = url === QUIET
      ? (n >= renewalAt ? fingerprint(9) : fingerprint(1))   // renews once, and stays
      : fingerprint((n % 2) + 1);                            // a new one every pass
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 11,
      finalUrl: url,
      timestamp: now.toISOString(),
      content: { fetched: true, contentLength: 100, hash: `h-${n}`, changed: null, title: 'Kunde' },
      ssl: { valid: true, validDays: 89, issuer: 'Lets Encrypt', fingerprint256: identity, serialNumber: '0a' },
    };
  };
}

async function monitor(home, { passes = 48, ...options } = {}) {
  const state = { urls: { [QUIET]: {}, [FLAP]: {} } };
  const check = twoSites(options);
  for (let i = 0; i < passes; i += 1) {
    await runPass(state, { home, now: at(i * HOUR / 2), check, returnResults: true });
  }
  return state;
}

test('den betalte rapport kan se en flappende side fra en fornyelse', async t => {
  const home = tempHome(t);
  const state = await monitor(home);

  const report = buildReport(state, { now: at(48 * HOUR / 2 + 90 * 86_400_000), title: 'Kunde' });
  const rows = Object.fromEntries(report.sites.map(site => [site.url, site]));

  // The finding, measured before the fix: these two lines were equal.
  assert.notEqual(rows[QUIET].certRotatedNote, rows[FLAP].certRotatedNote);
  assert.match(rows[FLAP].certRotatedNote, /🔑 certificate replaced 90 d ago · \d+ replacements since the site was added/);
  assert.ok(rows[FLAP].certRotationCount > 1, `flapping count was ${rows[FLAP].certRotationCount}`);

  // And the ordinary renewal still gets no count — the whole reason the count is
  // not printed for a single rotation. P1-69 extended this lock rather than
  // loosening it: the sentence now also carries that certificate's serial number,
  // so the rule it was written to protect is asserted on its own, independently of
  // the rest of the line, and the full sentence is asserted too.
  assert.ok(!rows[QUIET].certRotatedNote.includes('replacements'), rows[QUIET].certRotatedNote);
  assert.match(rows[QUIET].certRotatedNote, /^🔑 certificate replaced 90 d ago · serial [0-9a-f]+$/);
  assert.equal(rows[QUIET].certRotationCount, 1);

  // The count reaches the document itself, not only the machine surface.
  const markdown = renderReportMarkdown(report);
  assert.ok(markdown.includes('replacements since the site was added'), markdown);
});

test('en fornyet side siger præcis, hvad den altid har sagt', async t => {
  const home = tempHome(t);
  // No flapping at all: the second site keeps the certificate it was given.
  const state = { urls: { [QUIET]: {} } };
  const seen = new Map();
  const check = url => {
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 11,
      finalUrl: url,
      timestamp: at((n - 1) * HOUR / 2).toISOString(),
      content: { fetched: true, contentLength: 100, hash: `h-${n}`, changed: null, title: 'Kunde' },
      ssl: { valid: true, validDays: 89, issuer: 'Lets Encrypt', fingerprint256: fingerprint(n >= 5 ? 9 : 1), serialNumber: '0a' },
    };
  };
  for (let i = 0; i < 10; i += 1) await runPass(state, { home, now: at(i * HOUR / 2), check, returnResults: true });

  const row = buildReport(state, { now: at(5 * HOUR) }).sites[0];
  assert.equal(row.certRotationCount, 1);
  // Same extension as above: no count for one rotation, locked on its own, and
  // the sentence it produces.
  assert.ok(!row.certRotatedNote.includes('replacements'), row.certRotatedNote);
  assert.match(row.certRotatedNote, /^🔑 certificate replaced today · serial [0-9a-f]+$/);
});

test('et site der aldrig har roteret, tæller nul', async t => {
  const home = tempHome(t);
  const state = { urls: { [QUIET]: {} } };
  const check = url => ({
    url,
    reachable: true,
    healthy: true,
    statusCode: 200,
    responseTimeMs: 11,
    finalUrl: url,
    timestamp: at(0).toISOString(),
    content: { fetched: true, contentLength: 100, hash: 'h', changed: null, title: 'Kunde' },
    ssl: { valid: true, validDays: 89, issuer: 'Lets Encrypt', fingerprint256: fingerprint(1), serialNumber: '0a' },
  });
  await runPass(state, { home, now: at(0), check, returnResults: true });
  await runPass(state, { home, now: at(HOUR), check, returnResults: true });

  const row = buildReport(state, { now: at(HOUR) }).sites[0];
  assert.equal(row.certRotated, false);
  assert.equal(row.certRotationCount, 0);
  assert.equal(row.certRotatedNote, '');
});

test('tælleren overlever state-filer skrevet før den fandtes', () => {
  // Every upgrade lands here: a file with no `certRotationCount` at all must
  // read as zero, never as undefined, and never invent a rotation.
  assert.equal(certRotationCount(undefined), 0);
  assert.equal(certRotationCount(null), 0);
  // `now` is given rather than left to the machine's clock: the age is measured
  // from it, so a default would make "2 d ago" true on the day it was written
  // and false ever after.
  const stored = readCertRotationState({ lastCertRotatedAt: daysAgoIso(2) }, { now: new Date(BASE) });
  assert.equal(stored.rotations, 0);
  assert.equal(stored.note, '🔑 certificate replaced 2 d ago', 'uden tæller er sætningen uændret');
});

test('en håndredigeret tæller er ingen tæller', () => {
  // A state file that was edited, restored or half-written. Every one of these
  // reached a sentence before P1-68 existed; none of them may reach one now.
  for (const bad of ['many', -1, 0, 1.5, NaN, Infinity, 1e21, null, undefined, {}, [], true]) {
    assert.equal(certRotationCount(bad), 0, `${String(bad)} is not a count`);
  }
  // …and a value below one cannot be printed as a number of replacements.
  assert.equal(certRotationStateNote({ rotated: true, ageDays: 0, rotations: 1 }), '🔑 certificate replaced today');
  assert.equal(certRotationStateNote({ rotated: true, ageDays: 0, rotations: 0 }), '🔑 certificate replaced today');
  assert.equal(certRotationStateNote({ rotated: true, ageDays: 0, rotations: 'x' }), '🔑 certificate replaced today');
  // No rotation, no sentence — whatever the count says.
  assert.equal(certRotationStateNote({ rotated: false, rotations: 47 }), '');
});

test('en tæller på 2 og en på 47 siger det samme på én linje', () => {
  const shape = n => certRotationStateNote({ rotated: true, ageDays: 90, rotations: n });
  assert.match(shape(2), /· 2 replacements since the site was added$/);
  assert.match(shape(47), /· 47 replacements since the site was added$/);
  // The clock-skew form carries the count too, or a machine with a wrong clock
  // is exactly the machine where the count cannot be shown.
  assert.match(
    certRotationStateNote({ rotated: true, aheadMs: 3600_000, rotations: 47 }),
    /^🔑 certificate replaced — .*· 47 replacements since the site was added$/,
  );
  // An unreadable stamp likewise.
  assert.match(
    certRotationStateNote({ rotated: true, ageDays: null, rotations: 5 }),
    /🔑 certificate replaced at an unreadable time · 5 replacements since the site was added/,
  );
});

test('de to gratis-lister siger det samme om den samme fil', async t => {
  const home = tempHome(t);
  // Renew on pass 4 rather than 24: the CLI reads this file with the *machine's*
  // clock, so the fixtures are written close to BASE and the ages in the
  // sentences are whatever that gap is — the claim under test is the count, not
  // a number of days.
  const state = await monitor(home, { passes: 12, renewalAt: 4 });

  // The owner both lists ask, over the file the passes just wrote.
  const row = readEntry(state.urls[FLAP]);
  assert.match(row.certNote, /replacements since the site was added/, row.certNote);

  // …and the real CLI, in its own HOME, on a hand-written state file.
  const cliHome = mkdtempSync(join(tmpdir(), 'du-count-cli-'));
  t.after(() => rmSync(cliHome, { recursive: true, force: true }));
  mkdirSync(join(cliHome, '.deskuptime'), { recursive: true });
  writeFileSync(join(cliHome, '.deskuptime', 'state.json'), JSON.stringify({
    urls: {
      [FLAP]: { ...state.urls[FLAP], lastChecked: at(12 * HOUR / 2).toISOString() },
      [QUIET]: { ...state.urls[QUIET], lastChecked: at(12 * HOUR / 2).toISOString() },
    },
  }));

  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome } });
    const flapLine = stdout.split('\n').find(line => line.includes(FLAP));
    const quietLine = stdout.split('\n').find(line => line.includes(QUIET));
    assert.match(flapLine, /🔑 certificate replaced .* · \d+ replacements since the site was added/, `${args.join(' ')}: ${flapLine}`);
    assert.match(quietLine, /🔑 certificate replaced/, `${args.join(' ')}: ${quietLine}`);
    assert.ok(!/1 replacements/.test(quietLine), 'en enkelt fornyelse siger ikke "1 replacements"');
  }
});

function daysAgoIso(days) {
  return new Date(new Date(BASE).getTime() - days * 86_400_000).toISOString();
}
