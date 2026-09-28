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
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync as read, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeLicense, normalizeLicense, readTerm } from '../src/license.js';

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

/** The real loop, as its own process — the only surface that asks the server. */
function spawnCli(args, { env }) {
  return spawn(process.execPath, ['--import', STUB, CLI, ...args], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
}

/** Poll a fact until it is true, so a test never sleeps a fixed amount. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch { /* the file is not there yet */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`waited ${timeoutMs} ms for a fact that never became true`);
}

/** A loopback site, so the watch loop has something real to pass against. */
function startServer(t, tag) {
  return new Promise((resolve) => {
    const server = createServer((q, r) => {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('<html><head><title>Term</title></head><body>ok</body></html>');
    });
    t.after(() => new Promise(done => server.close(done)));
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/`, tag }));
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
  assert.match(s.stdout, /term ended 2026-08-01/);
  // The word "expires" must never be used about a day that is already gone —
  // `active, expires 2026-08-01` contradicts itself in the same breath.
  assert.doesNotMatch(s.stdout, /expires 2026-08-01/);
});

test('a date only the activation ever reported says so, and a re-read one does not', async (t) => {
  // `expiresAtVerified` is new, so *every* file a released CLI wrote lacks it —
  // and for those the date really is the activation's own reading, which is
  // exactly what the note has to admit. After a pass has asked the server
  // again, the date is the server's current answer and the line already carries
  // the moment it was read (`last verified`), so a second clause would only
  // name a moment that has nothing to do with the date any more.
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  const state = readState(home.HOME);
  delete state.license.expiresAtVerified;
  state.license.expiresAt = '2026-08-01T00:00:00.000Z';
  writeState(home.HOME, state);

  const before = await run(['status'], { env: home });
  assert.match(before.stdout, /term ended 2026-08-01 as reported at activation/);

  state.license.expiresAtVerified = true;
  writeState(home.HOME, state);
  const after = await run(['status'], { env: home });
  assert.match(after.stdout, /term ended 2026-08-01\n/);
  assert.doesNotMatch(after.stdout, /as reported at activation/);
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

// ── A renewal the server has already accepted was invisible on the only
//    surface that shows the term ──

test('a pass re-reads the term, so a renewal reaches the file that shows it', async (t) => {
  // Measured on `main` with the real CLI and the `renewed` scenario: activate
  // stores a term two days in the past, the server answers a year out on every
  // validate, and the stored date never moved — through a pass, through a whole
  // watch loop. `status` printed its own honest sentence about a dead date:
  //
  //   Pro license: active, … term ended 2026-09-26 as reported at activation
  //
  // The word `active` and the word `term ended` sat on one line, both from the
  // same file, and only one of them had asked anybody.
  const home = tempHome(t);
  const activated = await run(['activate', KEY], { env: { ...home, DUB_STUB_SCENARIO: 'renewed' } });
  assert.equal(activated.code, 0, activated.stderr);
  assert.equal(readState(home.HOME).license.expiresAt, '2026-09-26T00:00:00.000Z');

  // `runOnce` is the cron path and does not validate; the loop is the surface
  // that asks the server, so the loop is what has to carry the answer.
  const server = await startServer(t, 'renew-loop');
  const loop = spawnCli(['watch', server.url], { env: { ...home, DUB_STUB_SCENARIO: 'renewed' } });
  t.after(() => loop.kill('SIGTERM'));
  await waitFor(() => readState(home.HOME).license?.expiresAt === '2027-09-26T00:00:00.000Z', 8000);

  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /Pro license: active,.*expires 2027-09-26/);
  // The word that demoted nothing must not be there: the server says the key
  // is valid, and the date it now names is a year out.
  assert.doesNotMatch(s.stdout, /term ended/);
});

test('the loop\'s activation writes the record the activate command writes', async (t) => {
  // The same defect one layer over, and the same customer: `deskuptime watch
  // <url> --activate <key>` is a documented way in, and it stored no
  // `expiresAt` and no `machinesInUse` at all. Measured on `main`, the same
  // key activated through this option left `status` saying
  // `Pro license: active, last verified 2026-09-28` — no term, no seats — for
  // a customer who had activated the identical key a minute earlier and been
  // told `2 of 3 machines in use`. Two ways to activate, two different files.
  const home = tempHome(t);
  const server = await startServer(t, 'activate-loop');
  const loop = spawnCli(
    ['watch', server.url, '--activate', KEY],
    { env: { ...home, DUB_STUB_SCENARIO: 'ok' } },
  );
  t.after(() => loop.kill('SIGTERM'));
  await waitFor(() => Boolean(readState(home.HOME).license?.key), 8000);

  const viaLoop = readState(home.HOME).license;
  const viaCommand = (() => {
    const other = mkdtempSync(join(tmpdir(), 'deskuptime-activate-cmd-'));
    return other;
  })();
  t.after(() => rmSync(viaCommand, { recursive: true, force: true }));
  mkdirSync(join(viaCommand, '.deskuptime'), { recursive: true });
  await run(['activate', KEY], { env: { HOME: viaCommand, USERPROFILE: viaCommand } });
  const viaCmd = JSON.parse(read(join(viaCommand, '.deskuptime', 'state.json'), 'utf8')).license;

  for (const field of ['expiresAt', 'expiresAtVerified', 'machinesInUse', 'plan', 'status']) {
    assert.deepEqual(viaLoop[field], viaCmd[field], `${field} differs between the two ways to activate`);
  }
  // And the line the customer reads is the same either way.
  const a = await run(['status'], { env: { HOME: viaCommand, USERPROFILE: viaCommand } });
  const b = await run(['status'], { env: home });
  assert.equal(
    a.stdout.split('\n')[0].replace(/last verified \d{4}-\d{2}-\d{2}/, 'D'),
    b.stdout.split('\n')[0].replace(/last verified \d{4}-\d{2}-\d{2}/, 'D'),
  );
});

test('a term the server restates drops the "at activation" label, and silence does not', () => {
  // Three answers, three meanings. Only the first two may change the file, and
  // the last one is the reason: a server that does not report `expires_at` has
  // not said the term is gone, so the stored reading stands.
  assert.deepEqual(readTerm('2027-09-26T00:00:00.000Z', null), {
    expiresAt: '2027-09-26T00:00:00.000Z',
    expiresAtVerified: true,
  });
  // `expires_at: null` is the lifetime answer — an answer, so a date left over
  // from an earlier term goes with it.
  assert.deepEqual(readTerm(null, { expiresAt: '2020-01-01T00:00:00.000Z' }), {
    expiresAt: undefined,
    expiresAtVerified: true,
  });
  // Absent, or unreadable: keep what we have.
  assert.deepEqual(readTerm(undefined, { expiresAt: '2020-01-01T00:00:00.000Z' }), {});
  assert.deepEqual(readTerm('soon', { expiresAt: '2020-01-01T00:00:00.000Z' }), {});
  // Nothing stored and nothing reported is still not a term.
  assert.deepEqual(readTerm(undefined, null), { expiresAt: undefined, expiresAtVerified: true });
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
