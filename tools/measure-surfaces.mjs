#!/usr/bin/env node
/**
 * A measurement bench: build a state file, then print what each of the four
 * surfaces says about the *same* site. It is not a test and asserts nothing —
 * its whole job is to make two surfaces disagree in one screen, so the
 * disagreement can be read before anything is changed.
 *
 *   node tools/measure-surfaces.mjs [scenario]
 *
 * It always runs under a throwaway HOME (test/helpers/env.mjs is the owner of
 * that rule), and it never writes the real `~/.deskuptime/state.json`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import { tempHome } from '../test/helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');

const DAY_MS = 86_400_000;

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600_000).toISOString();
}
function daysAgo(n) {
  return hoursAgo(n * 24);
}

/** Whole days between an ISO stamp and now, as a float — the reader's arithmetic. */
function daysSince(iso, now) {
  return (now.getTime() - Date.parse(iso)) / DAY_MS;
}

/** The scenarios: one state file each, described by the fact under test.
 *
 * P1-87: each scenario also carries `expect` — a function of the entry the bench
 * wrote and `now`, returning `null` when the file really is in the state its
 * name claims, or a sentence saying why it is not. A bench that quietly measures
 * the wrong state is worse than no bench: P1-79's lapsed-certificate branch was
 * never actually reached by `ssl-lapsed-since-pass`, because a certificate with
 * 9 days left that was read 5 days ago still had 4 days to run — so four
 * surfaces were measured against the *ordinary* "renew soon" path for a whole
 * iteration and read as agreeing. The arithmetic is written here, in the bench,
 * out of the values it wrote, so the reader is told rather than left to spot it.
 */
const SCENARIOS = {
  // A site whose *last pass* succeeded but which has since been redirected to
  // another host. The pass wrote `lastFinalUrl`; who says so out loud?
  'off-host-redirect': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: hoursAgo(2),
      lastFinalUrl: 'https://parket.example/',
      sslValidDays: 89,
    },
    expect: (e, now) => (e.lastFinalUrl && new URL(e.lastFinalUrl).host !== new URL(e.url).host
      ? null
      : `lastFinalUrl (${e.lastFinalUrl}) is on the same host as the URL`),
  },
  // A site whose certificate was replaced and whose authority changed hands.
  'cert-issuer-change': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: hoursAgo(2),
      sslValidDays: 89,
      sslIssuer: 'Rogue Cert BV',
      certIssuerBefore: 'Ganske Cloud A/S',
      certIssuerChangedAt: daysAgo(1),
      lastCertRotatedAt: daysAgo(1),
      lastCertSeenAt: daysAgo(1),
      lastCertFingerprint: 'aa:bb:cc',
      certRotationCount: 1,
    },
    expect: (e, now) => (e.sslIssuer && e.certIssuerBefore && e.sslIssuer !== e.certIssuerBefore
      ? null
      : `the two issuers are the same string (${e.sslIssuer} / ${e.certIssuerBefore})`),
  },
  // A pass recorded a moment ago, but the *page* was last read days ago and it
  // has been changed since. Who says the page changed?
  'content-changed-old-read': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: hoursAgo(1),
      lastContentReadAt: daysAgo(5),
      lastHash: 'abc123',
      lastTitle: 'Kunde — hjem',
      lastContentLength: 4096,
      lastContentChangedAt: daysAgo(5),
    },
    expect: (e, now) => (e.lastContentChangedAt && daysSince(e.lastContentReadAt, now) > 2
      ? null
      : 'the page was read on the last pass, so there is no old reading to report'),
  },
  // Every measured fact at once, all current.
  healthy: {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: hoursAgo(1),
      lastContentReadAt: hoursAgo(1),
      lastHash: 'abc123',
      lastTitle: 'Kunde — hjem',
      lastContentLength: 4096,
      sslValidDays: 89,
      sslIssuer: 'Ganske Cloud A/S',
    },
    expect: (e, now) => (daysSince(e.lastChecked, now) < 1 && daysSince(e.lastContentReadAt, now) < 1
      ? null
      : 'the pass, or the page reading, is not from the last day'),
  },
  // The pass read a certificate with 2 days left, but that was 5 days ago: the
  // deadline passed 3 days ago. The free lists own a `mayHaveExpired` reading —
  // does the paid one? (P1-87: this was `9 d left` read `5 d ago`, which still
  // had 4 days to run and so never reached the branch it was named for.)
  'ssl-lapsed-since-pass': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: daysAgo(5),
      sslValidDays: 2,
      sslIssuer: 'Ganske Cloud A/S',
    },
    expect: (e, now) => {
      const left = e.sslValidDays - daysSince(e.lastChecked, now);
      return left <= 0 ? null : `the certificate still has ${left.toFixed(1)} d to run after the pass`;
    },
  },
  // The pass measured the certificate as already expired.
  'ssl-expired-at-pass': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: hoursAgo(2),
      sslValidDays: -3,
      sslExpired: true,
      sslExpiredDays: 3,
      sslIssuer: 'Ganske Cloud A/S',
    },
    expect: (e, now) => (e.sslValidDays < 0 && e.sslExpired ? null : 'the certificate is not expired at the pass'),
  },
  // A pass time ahead of this machine's clock.
  'clock-ahead': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: new Date(Date.now() + 19 * DAY_MS).toISOString(),
      sslValidDays: 89,
    },
    expect: (e, now) => (Date.parse(e.lastChecked) > now.getTime()
      ? null
      : 'the pass is not dated ahead of this machine\'s clock'),
  },
  // A site that stopped being watched, with a DOWN verdict from its last pass.
  'stale-down': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: false,
      lastStatus: 503,
      lastChecked: daysAgo(9),
      checks: 412,
      checksUp: 400,
    },
    expect: (e, now) => (daysSince(e.lastChecked, now) > 2 && e.wasUp === false
      ? null
      : 'the site is not a stopped loop with a DOWN verdict'),
  },
  // Response time recorded, and a page read long ago that has *not* changed.
  'slow-old-page': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastResponseMs: 4210,
      lastChecked: hoursAgo(1),
      lastContentReadAt: daysAgo(6),
      lastHash: 'abc123',
      lastTitle: 'Kunde — hjem',
      lastContentLength: 4096,
      sslValidDays: 89,
      checks: 100,
      checksUp: 100,
    },
    expect: (e, now) => (daysSince(e.lastContentReadAt, now) > 2 && daysSince(e.lastChecked, now) < 1
      ? null
      : 'the page reading is not older than the pass that is fresh'),
  },
};

function run(home, args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: error.stdout ?? '',
      err: error.stderr ?? '',
    };
  }
}

const name = process.argv[2] ?? 'off-host-redirect';
const state = SCENARIOS[name];
if (!state) {
  console.error(`unknown scenario "${name}" — have: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const { home, dir } = tempHome(null, 'deskuptime-measure-');
mkdirSync(dir, { recursive: true });
// A Pro record so the *paid* surfaces can be measured too. The bench never
// calls the license API: `validate` is not asked for, only the stored record,
// which is exactly what a machine that activated once carries.
writeFileSync(
  join(dir, 'state.json'),
  JSON.stringify(
    {
      version: 1,
      license: {
        key: '0123456789abcdef0123456789abcdef',
        instance: 'deskuptime-measure',
        plan: 'pro',
        status: 'active',
        validatedAt: new Date().toISOString(),
      },
      urls: state,
    },
    null,
    2,
  ),
);

console.log(`\n### scenario: ${name}\n`);

// The scenario's name is a claim about the file the bench just wrote, so the
// bench checks it before anyone reads a single surface. A scenario that does
// not measure what it is called is still measured and still printed — the
// reading may be worth having — but it is reported as the wrong measurement and
// the process exits non-zero, so neither a human nor `npm test` can read four
// agreeing surfaces as proof about a state that was never reached.
const notReached = typeof state.expect === 'function'
  ? Object.values(state).filter(entry => entry && typeof entry === 'object')
    .map(entry => state.expect(entry, new Date()))
    .find(why => why)
  : 'the scenario declares no `expect`, so nothing says what it measures';
if (notReached) {
  console.log(`⚠️  scenario "${name}" does not measure what its name says: ${notReached}\n`);
}

for (const [label, args] of [
  ['status', ['status']],
  ['watch --status', ['watch', '--status']],
  ['report', ['report']],
  ['report --json', ['report', '--json']],
]) {
  const r = run(home, args);
  console.log(`----- ${label} (exit ${r.code}) -----`);
  console.log(r.out.trim() || '(no stdout)');
  if (r.err.trim()) console.log(`[stderr] ${r.err.trim()}`);
  console.log('');
}

process.exit(notReached ? 1 : 0);
