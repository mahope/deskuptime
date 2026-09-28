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

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600_000).toISOString();
}
function daysAgo(n) {
  return hoursAgo(n * 24);
}

/** The scenarios: one state file each, described by the fact under test. */
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
  },
  // The pass read a certificate with 9 days left, but that was 5 days ago. The
  // deadline has passed since. The free lists own a `mayHaveExpired` reading —
  // does the paid one?
  'ssl-lapsed-since-pass': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: daysAgo(5),
      sslValidDays: 9,
      sslIssuer: 'Ganske Cloud A/S',
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
  },
  // A pass time ahead of this machine's clock.
  'clock-ahead': {
    'https://kunde.dk/': {
      url: 'https://kunde.dk/',
      wasUp: true,
      lastStatus: 200,
      lastChecked: new Date(Date.now() + 19 * 86_400_000).toISOString(),
      sslValidDays: 89,
    },
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
