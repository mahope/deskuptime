/**
 * P1-93 — the lock behind `test/helpers/clock.mjs`.
 *
 * `main` was red when this iteration started, and the red had nothing to do with
 * the product. Measured on the unchanged tree, `npm test` → **749/756**, and the
 * seven failures were all one defect wearing three faces: a test fixture stamped
 * from a *literal* instant, read by something that ages it against the *wall*
 * clock.
 *
 *   test/certissuerlists.test.js, test/certrotationlists.test.js
 *     `const BASE = '2026-09-27T09:00:00.000Z'` and `daysAgo(n)` from it. Both
 *     lists are printed by a child process running the real `status` and
 *     `watch --status`, so the command aged the stamp from the machine's clock
 *     while the expected sentence held an age counted from the literal:
 *
 *       the assertion wants  🏢 certificate answers from a different issuer 2 d ago
 *       the row printed     🏢 certificate answers from a different issuer 3 d ago
 *
 *   test/oversizedpage.test.js
 *     the same two clocks the other way round: the report's `now` was the
 *     literal, the pass stamped the real time, so the pass was *ahead* and the
 *     Content cell grew `stable · 70 bytes, read 36 min ahead of this machine's
 *     clock` — the report being right, P1-42 doing its job, about a clock that
 *     had been fiction for half an hour.
 *
 * The gate cannot be trusted to be red for a reason somebody can find, and this
 * one cost a day: a merge was shipped because 11 merges before it had been red
 * too (P1-67), and the plan filed the failures under "not mine" because they were
 * green when the work started.
 *
 * It is deliberately **not** a scan of the test tree for date literals. That
 * version was written and thrown away in the same way P1-92's was: measured
 * against the 33 files in `test/`, it flags twenty files that are *correct* —
 * `readEntry` and `buildReport` take `{ now }`, and a file that hands both the
 * reader and the writer the same instant has made the age deterministic on
 * purpose. Four classes of noise to catch three real cases is a lock that gets
 * switched off.
 *
 * So the lock is the same measurement P1-92 runs, run on purpose: it *runs* the
 * real command and watches it age a stamp. That is exact, it has no blind spot to
 * reason about, and it fails with the sentence the command printed rather than
 * with a line number in a list. The three files that were measured red are then
 * pinned by name, as `offlinegate.test.js` pins the two it exists for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getStateFile } from '../src/watch.js';
import { passAge } from '../src/status.js';
import { assertTempHome, tempHome } from './helpers/env.mjs';
import { ANCHOR, daysBefore, MS_PER_DAY } from './helpers/clock.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const SITE = 'https://kunde.dk/';

/** The one field the sentence under test ages, and the two days it claims. */
function siteWithRotationAt(iso) {
  return {
    [SITE]: {
      wasUp: true,
      lastStatus: 200,
      lastChecked: daysBefore(0),
      addedAt: daysBefore(30),
      checks: 100,
      checksUp: 100,
      sslValidDays: 89,
      sslExpired: false,
      lastCertFingerprint: 'b'.repeat(64),
      certBaselineSeenAt: daysBefore(7),
      lastCertRotatedAt: iso,
    },
  };
}

function homeWith(t, urls) {
  const { home, options } = tempHome(t, 'deskuptime-clockgate-');
  assertTempHome(options, 'the clock-gate tests');
  const stateFile = getStateFile({ env: { HOME: home } });
  writeFileSync(stateFile, JSON.stringify({ urls }, null, 2));
  return { stateFile, options };
}

test('en liste aldr filens egen alder, så et forankret fixture er alderet rigtigt hver gang', async (t) => {
  // The door, measured rather than assumed: the real command ages a stamp
  // against this machine's clock. Two runs of the same command, the only
  // difference being which clock the fixture was anchored to — a stamp written
  // just now reads `today`, the same stamp written a day and an hour ago reads
  // `1 d ago`. That is the arithmetic every age in this repo rests on, and it is
  // why a fixture anchored to the wall clock is stable: it always sits exactly as
  // far back as it says it does.
  const { options } = homeWith(t, siteWithRotationAt(new Date().toISOString()));
  const today = await run(process.execPath, [CLI, 'status'], { env: { ...process.env, ...options } });
  assert.match(today.stdout, /🔑 certificate replaced today/, today.stdout);

  const { options: older } = homeWith(t, siteWithRotationAt(new Date(Date.now() - 25 * 3600_000).toISOString()));
  const yesterday = await run(process.execPath, [CLI, 'status'], { env: { ...process.env, ...older } });
  assert.match(yesterday.stdout, /🔑 certificate replaced 1 d ago/, yesterday.stdout);

  // Both are the same command against the same clock; the difference is the
  // fixture. A test that printed a third age here would be measuring the machine,
  // not the code.
  assert.doesNotMatch(today.stdout, /d ago/, 'a stamp written now is today, in both forms');
});

test('et anker følger maskinens ur, og en alder følger sit anker i hele døgn', () => {
  // Why anchoring to the wall clock is sound rather than a different kind of
  // flakiness: the owner floors. A stamp taken when the process loaded reads
  // `0 d` for every remaining second of that day, and turns into `1 d` at
  // exactly 24 hours — so a fixture anchored at load says the same thing at
  // 23:59 and at 00:01, and the ages a test asserts are the ages the product
  // prints whenever the suite runs.
  const drift = Date.now() - ANCHOR.getTime();
  assert.ok(Math.abs(drift) < 60_000, `ANCHOR is this machine's clock, not a stored instant (drift ${drift} ms)`);

  // A stamp taken at any hour of the day, read at the end of that day, is `0 d`;
  // one taken a day earlier is `1 d`. Whole days, because the owner floors.
  const endOfDay = new Date(ANCHOR.getTime() + 23.99 * 3600_000);
  for (const hours of [0, 1, 6, 12, 23, 23.99]) {
    const stamp = new Date(ANCHOR.getTime() + hours * 3600_000).toISOString();
    assert.equal(passAge(stamp, endOfDay).ageDays, 0, `${hours} h into the day is still today at the end of it`);
  }
  assert.equal(passAge(daysBefore(1), endOfDay).ageDays, 1, 'a stamp from the day before is 1 d');
  assert.equal(passAge(daysBefore(1)).ageDays, 1, 'and 1 d right now, not 0 and not 2');
  assert.equal(daysBefore(2), new Date(ANCHOR.getTime() - 2 * MS_PER_DAY).toISOString(), 'daysBefore writes whole days');
});

test('de tre filer der blev målt røde har ingen fast tidspunkt mere', () => {
  // Pinned by name, as `offlinegate.test.js` pins the two cases it exists for:
  // the files that were measured red, and no others, so this lock cannot start
  // shouting about the twenty files that hand the reader and the writer the same
  // literal instant on purpose.
  const fixed = [
    ['test/certissuerlists.test.js', /const BASE = ANCHOR;/],
    ['test/certrotationlists.test.js', /const BASE = ANCHOR;/],
    ['test/oversizedpage.test.js', /const now = \(\) => new Date\(\);/],
  ];
  for (const [file, expected] of fixed) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:new Date\(|Date\.parse\(|=\s*)['"]\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
      `${file} must not hold a fixed instant as its clock`,
    );
    assert.match(source, expected, `${file} takes its clock the way the lock says`);
  }

  // The two certificate lists age from the one helper, so a fourth file with the
  // same shape has somewhere to copy from.
  for (const file of ['test/certissuerlists.test.js', 'test/certrotationlists.test.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.match(source, /import \{ ANCHOR, daysBefore \} from '\.\/helpers\/clock\.mjs';/, `${file} uses the shared clock`);
    assert.match(source, /return daysBefore\(days, BASE\);/, `${file} derives its stamps from the anchor`);
  }
});
