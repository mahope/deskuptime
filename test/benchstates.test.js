/**
 * P1-87 — the measurement bench must measure the state it is named for.
 *
 * P1-81 fixed the bench writing into the real `~/.deskuptime`. This is the other
 * way a bench lies: it writes a state file, prints four surfaces, and the reader
 * concludes the surfaces agree. If the file is not the state the scenario is
 * called after, "all four agree" is a fact about a state nobody was asking
 * about — and the agreement looks like a result.
 *
 * That is not hypothetical. Measured 2026-09-28, running every scenario of
 * `tools/measure-surfaces.mjs` and reading all four surfaces: eight of the nine
 * reached the state they are named for, and `ssl-lapsed-since-pass` did not.
 * It held `sslValidDays: 9` against a pass `5 d` old — four days of margin, so
 * the certificate had *not* lapsed and P1-79's `mayHaveExpired` branch was never
 * entered. The four surfaces agreed, and the agreement was about the ordinary
 * "renew soon" path:
 *
 *   | https://kunde.dk/ | UP (200) ⚠️ stale — last check 5 d ago | … | ⚠️ 9 d — renew soon | … |
 *   **1 site(s) · 0 up · 0 down · 0 checks · 0 failed · 1 SSL expiring soon · 1 stale …**
 *
 * An iteration of "read the four surfaces for every state" therefore could not
 * have read that branch, and its negative result was a fact about the wrong
 * file. The repair is in the bench: every scenario carries `expect`, a function
 * of the entry the bench wrote, written as the arithmetic its name claims — a
 * certificate with N days left read D days ago has lapsed only when N − D ≤ 0.
 * The bench checks it, prints the reading anyway, and exits non-zero.
 *
 * The second test is the one the mis-specified scenario made impossible: with
 * the state corrected (2 d left, read 5 d ago), the branch P1-79 fixed is
 * reached on all four surfaces, and a lapsed certificate is still not counted as
 * a renewal to schedule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH = join(ROOT, 'tools', 'measure-surfaces.mjs');

/** Every scenario name the bench offers, asked of the bench itself. */
function scenarioNames() {
  const result = spawnSync(process.execPath, [BENCH, 'no-such-scenario'], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const listed = /have: (.+)$/m.exec(result.stderr)?.[1] ?? '';
  const names = listed.split(',').map(name => name.trim()).filter(Boolean);
  assert.ok(names.length >= 9, `the bench must still offer its scenarios, found ${names.length}`);
  return names;
}

function runBench(name) {
  const result = spawnSync(process.execPath, [BENCH, name], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { ...result, status: result.status };
}

test('every scenario says which state it claims, and the bench checks it', () => {
  for (const name of scenarioNames()) {
    const { status, stdout, stderr } = runBench(name);
    assert.equal(
      status,
      0,
      `scenario "${name}" does not measure what its name says:\n${stdout}\n${stderr}`,
    );
    assert.doesNotMatch(
      stdout,
      /does not measure what its name says/,
      `scenario "${name}" measured the wrong state`,
    );
    // The reading itself must still be there: a bench that refuses to run is
    // not a bench that tells the truth about its own state.
    for (const label of ['----- status', '----- watch --status', '----- report (exit', '----- report --json']) {
      assert.ok(stdout.includes(label), `${name}: the bench must still print "${label}"`);
    }
  }
});

test('a scenario that stopped measuring what it claims is reported, not printed as agreement', (t) => {
  // The lock that survives having the arithmetic deleted. `expect` is only a
  // guard if it bites: a copy of the bench with one scenario's arithmetic
  // broken — the exact mistake this iteration found, `9 d` left read `5 d` ago
  // — must still print its four surfaces and exit non-zero, so four surfaces
  // agreeing about a state nobody asked about cannot be read as a result.
  // The copy sits next to the original because the bench resolves the CLI and
  // the temp-HOME helper relative to itself.
  const source = readFileSync(BENCH, 'utf8');
  const copy = join(ROOT, 'tools', '.benchstates-lapsed-copy.mjs');
  writeFileSync(copy, source.replace('sslValidDays: 2,', 'sslValidDays: 9,'));
  t.after(() => rmSync(copy, { force: true }));

  const result = spawnSync(process.execPath, [copy, 'ssl-lapsed-since-pass'], {
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.match(
    result.stdout,
    /does not measure what its name says: the certificate still has 4\.0 d to run/,
    'the bench must name the arithmetic that failed',
  );
  assert.equal(result.status, 1, 'and exit non-zero, so npm test cannot read it as green');
  // The reading is still printed: refusing to measure is not the same as
  // measuring, and the person running the bench may still want to see it.
  assert.match(result.stdout, /----- status \(exit 0\) -----/, 'the bench must still print its surfaces');
});

test('a lapsed certificate reaches all four surfaces, and is not a renewal to schedule', () => {
  // The branch P1-79 fixed, measured through the real bench on the corrected
  // state. Before the correction this scenario never got here at all.
  const { status, stdout } = runBench('ssl-lapsed-since-pass');
  assert.equal(status, 0, stdout);

  const owner = '🔴 may be expired — last reading: 2 d left, checked 5 d ago';
  const blocks = stdout.split(/^----- /m).slice(1);
  // Keyed on the whole label: `report` and `report --json` are different
  // surfaces, and keying on the first word would let the JSON answer for the
  // Markdown.
  const byLabel = Object.fromEntries(
    blocks.map(b => [b.split(' (exit')[0], b]),
  );
  assert.deepEqual(Object.keys(byLabel), ['status', 'watch --status', 'report', 'report --json']);

  for (const label of ['status', 'watch --status', 'report']) {
    assert.ok(byLabel[label], `the bench must print ${label}`);
    assert.ok(
      byLabel[label].includes(owner),
      `${label} must name the lapsed certificate with the owner's own sentence:\n${byLabel[label]}`,
    );
  }

  // Counted in its own bucket, and *not* as a certificate to renew: a lapsed
  // reading is a reading to take again, not a deadline still in the future.
  const report = byLabel.report;
  assert.match(report, /· 1 SSL may be expired ·/, report);
  assert.doesNotMatch(report, /SSL expiring soon/, 'a lapsed reading is not a renewal to schedule');

  // The same fact as a boolean in the JSON an agency imports, so a consumer
  // does not have to read the sentence to branch on it.
  assert.match(byLabel['report --json'], /"sslMayHaveExpired": true/, byLabel['report --json']);
  assert.match(byLabel['report --json'], /"sslExpiringSoon": false/, byLabel['report --json']);
});
