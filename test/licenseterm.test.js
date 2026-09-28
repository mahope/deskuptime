/**
 * When the license runs out.
 *
 * The server has answered `expires_at` on every activation, `activate` has
 * written it into `state.json` since P1-19, and `docs/license-lifecycle.md` has
 * said for days that `status` shows it. Measured 2026-09-28 through the real
 * CLI, one probe apart: the file held `"expiresAt": "2027-09-26T00:00:00.000Z"`
 * and `status` printed the seat count without the date. A yearly customer was
 * never told when the year is up.
 *
 * The real CLI and a real state file in a temp HOME, with the license API
 * stubbed (test/fixtures/license-stub.mjs) — no network, and the license server
 * is never written to. The `lifetime` scenario is the shape a one-time purchase
 * answers with: no `expires_at`, `lifetime: true`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync as read, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeLicense, normalizeLicense } from '../src/license.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T12:00:00.000Z');

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'ok', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-term-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

const stateFile = home => join(home, '.deskuptime', 'state.json');
const readState = home => JSON.parse(read(stateFile(home), 'utf8'));
const writeState = (home, state) => writeFileSync(stateFile(home), JSON.stringify(state, null, 2));

// ── The harm: the date is in the file and in the doc, and in no output ──

test('a yearly license says when it runs out, on the surface that documents it', async (t) => {
  const home = tempHome(t);
  const activated = await run(['activate', KEY], { env: home });
  assert.equal(activated.code, 0, activated.stderr);

  // The fact was stored all along — the missing half was never the measurement.
  assert.equal(readState(home.HOME).license.expiresAt, '2027-09-26T00:00:00.000Z');

  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /expires 2027-09-26/);
  // Everything the line already said, in the order it already said it: the seat
  // count and the verification time are locked elsewhere and must not move.
  assert.match(s.stdout, /Pro license: active, last verified \d{4}-\d{2}-\d{2}, 3 of 3 machines in use when activated,/);
  assert.equal(s.code, 0, s.stderr);
});

test('the documentation promise is kept by the code it names', () => {
  // docs/license-lifecycle.md says `status` shows the expiry. If the sentence
  // is ever softened to "we store it", this fails — the two must not drift.
  const doc = read(join(ROOT, 'docs', 'license-lifecycle.md'), 'utf8');
  assert.match(doc, /udløbsdatoen/);
  assert.match(doc, /`status` kan vise pladserne og udløbsdatoen/);
});

// ── A stored date must not decide Pro, and must not contradict the line ──

test('a date that is behind us never demotes the verdict the server gave', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  const state = readState(home.HOME);
  state.license.expiresAt = '2026-08-01T00:00:00.000Z';
  writeState(home.HOME, state);

  // A stored reading can be stale in the other direction too: the server may
  // have renewed the license and this file never heard. So the word stays, and
  // the line reports which side of that date this reading falls on.
  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /Pro license: active,/);
  assert.match(s.stdout, /term ended 2026-08-01 as reported at activation/);
  // The word "expires" must never be used about a day that is already gone —
  // `active, expires 2026-08-01` contradicts itself in the same breath.
  assert.doesNotMatch(s.stdout, /expires 2026-08-01/);
});

test('a stored date is a note, never the status word', () => {
  const record = {
    key: KEY,
    instance: 'dev-1',
    status: 'active',
    validatedAt: new Date(NOW).toISOString(),
    expiresAt: '2020-01-01T00:00:00.000Z',
  };
  assert.equal(describeLicense(record, { now: NOW }).status, 'active');
  assert.match(describeLicense(record, { now: NOW }).detail, /term ended 2020-01-01/);
});

// ── A license with no end date says nothing about one ──

test('a lifetime license is not given a date it does not have', async (t) => {
  const home = tempHome(t);
  const activated = await run(['activate', KEY], { env: { ...home, DUB_STUB_SCENARIO: 'lifetime' } });
  assert.equal(activated.code, 0, activated.stderr);
  assert.equal(readState(home.HOME).license.expiresAt, undefined);

  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /Pro license: active,/);
  // `expires_at: null` means there is no end date, not that we lost one. A word
  // here would be a claim the file cannot support.
  assert.doesNotMatch(s.stdout, /expires \d{4}|term ended|unverified|cached/);
  assert.equal(s.code, 0, s.stderr);
});

test('a record without a date keeps the sentence it always had', () => {
  const detail = describeLicense(
    { key: KEY, instance: 'dev-1', status: 'active', validatedAt: new Date(NOW).toISOString(), machinesInUse: 3 },
    { now: NOW },
  ).detail;
  assert.equal(detail, `last verified 2026-09-28, 3 of ${3} machines in use when activated`);
  // An unparseable date in a hand-edited file is no date, not a crash and not
  // a printed "Invalid Date".
  assert.equal(
    describeLicense({ key: KEY, instance: 'dev-1', status: 'active', validatedAt: new Date(NOW).toISOString(), expiresAt: 'soon' }, { now: NOW }).detail,
    'last verified 2026-09-28',
  );
  assert.equal(normalizeLicense({ key: KEY, instance: 'dev-1', expiresAt: 'soon' }).expiresAt, undefined);
});

// ── The date crosses a day boundary while the machine sits still ──

test('the note follows the machine clock, not the stored clock', () => {
  const record = { key: KEY, instance: 'dev-1', status: 'active', validatedAt: new Date(NOW).toISOString(), expiresAt: '2026-10-01T00:00:00.000Z' };
  assert.match(describeLicense(record, { now: NOW }).detail, /expires 2026-10-01/);
  // Three days later the same record reads the other way, with no re-check and
  // no new write: the date is compared against now, never against validatedAt.
  // Still inside the 7-day grace, so only the term note is what changes.
  assert.match(describeLicense(record, { now: NOW + 3 * DAY }).detail, /term ended 2026-10-01/);
  // The boundary: the end timestamp itself is still "expires", because the day
  // is not over at the instant it starts — one millisecond later it has.
  const end = Date.parse('2026-10-01T00:00:00.000Z');
  assert.match(describeLicense(record, { now: end }).detail, /expires 2026-10-01/);
  assert.match(describeLicense(record, { now: end + 1 }).detail, /term ended 2026-10-01/);
});
