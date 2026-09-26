/**
 * The seat surface: what a customer is told when a machine activates, when a
 * machine releases its seat, and when the license has no room left.
 *
 * The real CLI, a real state file in a temp HOME, and a stubbed license API
 * (test/fixtures/license-stub.mjs) — no network, and the license server is never
 * written to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeLicense, proGateMessage, releaseReceipt, normalizeLicense, LICENSE_STATUS } from '../src/license.js';
import { isPro } from '../src/watch.js';
import { PRODUCT } from '../src/features.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const BUY_URL = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'ok', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-seat-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

const stateFile = home => join(home, '.deskuptime', 'state.json');
const readState = home => JSON.parse(readFileSync(stateFile(home), 'utf8'));

// ── The harm: a machine that gave its seat up on purpose was sold the checkout ──

test('seat: a machine that released its seat is never shown the checkout', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  const released = await run(['deactivate'], { env: home });
  assert.equal(released.code, 0, released.stderr);

  // Every surface the customer can reach on that machine, one after the other.
  for (const args of [['status'], ['report'], ['deactivate']]) {
    const r = await run(args, { env: home });
    const said = r.stdout + r.stderr;
    assert.doesNotMatch(said, /buy\.stripe\.com/, `${args.join(' ')} must not sell a license this machine already has`);
    assert.doesNotMatch(said, /Free tier/i, `${args.join(' ')} must not call a released machine a free-tier machine`);
  }
});

test('seat: releasing says what the server answered and how to move the license', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  const r = await run(['deactivate'], { env: home });
  // The server said 2 of 3 after the release; that number is the customer's only
  // confirmation that the move worked, and it used to be discarded.
  assert.match(r.stdout, /2 of 3 machines in use/);
  assert.match(r.stdout, /deskuptime activate <license-key>/);
});

test('seat: the release receipt keeps no key, and Pro is off on that machine', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  await run(['deactivate'], { env: home });
  const license = readState(home.HOME).license;
  assert.equal(license.released, true);
  assert.equal(license.key, undefined, 'a released key must not be kept on the machine that gave it up');
  assert.equal(license.machinesInUse, 2);
  assert.ok(Number.isFinite(Date.parse(license.releasedAt)), 'a receipt without a time cannot say when it happened');
  assert.equal(isPro({ license }), false, 'a released seat is not Pro');
});

test('seat: the seat count and expiry survive activation instead of printing once', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  const license = readState(home.HOME).license;
  assert.equal(license.machinesInUse, 3);
  assert.equal(license.expiresAt, '2027-09-26T00:00:00.000Z');
  // Labelled as a fact about the activation, not as the state of the seats now:
  // validate never reports a seat count, so an undated number would be a guess.
  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /3 of 3 machines in use when activated/);
});

test('seat: the fourth machine is told which command frees a seat', async (t) => {
  const home = tempHome(t);
  const r = await run(['activate', KEY], { env: { ...home, DUB_STUB_SCENARIO: 'limit' } });
  assert.equal(r.code, 1);
  // The server's own sentence names no command and no seat count, so a customer
  // who bought three machines had nothing to act on.
  assert.match(r.stderr, /deskuptime deactivate/);
  assert.match(r.stderr, new RegExp(`${PRODUCT.machines} machines`));
  assert.equal(existsSync(stateFile(home.HOME)), false, 'a failed activation stores nothing');
});

test('seat: re-activating on the same machine restores Pro over the receipt', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  await run(['deactivate'], { env: home });
  const again = await run(['activate', KEY], { env: home });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(isPro({ license: readState(home.HOME).license }), true);
  const s = await run(['status'], { env: home });
  assert.match(s.stdout, /Pro license: active/);
});

test('seat: status on a released machine makes no network call', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  await run(['deactivate'], { env: home });
  // The stub exits 9 on any call, so a green status proves the surface stayed
  // read-only with the new state shape.
  const s = await run(['status'], { env: { ...home, DUB_STUB_SCENARIO: 'trap' } });
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /Pro license: seat released on this machine/);
});

// ── The owners, locked where a second copy would be invisible ──

test('seat: describeLicense reads a receipt, with or without its optional facts', () => {
  const full = describeLicense(releaseReceipt({ plan: 'pro', machinesInUse: 2, releasedAt: '2026-09-26T10:00:00.000Z' }));
  assert.equal(full.status, LICENSE_STATUS.RELEASED);
  assert.equal(full.detail, 'seat released on this machine on 2026-09-26, 2 of 3 machines in use');

  // A half-written receipt must still mean "this machine paid" — the date and
  // the count are extra, the fact that the seat was given up is not.
  const bare = describeLicense({ released: true });
  assert.equal(bare.status, LICENSE_STATUS.RELEASED);
  assert.equal(bare.detail, 'seat released on this machine');
  assert.equal(bare.validatedAt, null);
});

test('seat: the gate names the release and never the checkout', () => {
  const receipt = releaseReceipt({ plan: 'pro', machinesInUse: 2, releasedAt: '2026-09-26T10:00:00.000Z' });
  const msg = proGateMessage(receipt, 'the client report');
  assert.doesNotMatch(msg, /buy\.stripe\.com/);
  assert.match(msg, /deskuptime activate <license-key>/);
  // Same state word as `deskuptime status`, so the gate cannot be read as a
  // different answer to the same question.
  assert.match(msg, new RegExp(describeLicense(receipt).detail));
});

test('seat: only checked numbers are kept as a seat count', () => {
  const base = { key: KEY, instance: 'dev-1', status: 'active', validatedAt: '2026-09-26T09:00:00.000Z' };
  assert.equal(normalizeLicense({ ...base, machinesInUse: 3 }).machinesInUse, 3);
  assert.equal(normalizeLicense({ ...base, machinesInUse: -1 }).machinesInUse, undefined, 'a negative count is not a count');
  assert.equal(normalizeLicense({ ...base, machinesInUse: '3' }).machinesInUse, undefined, 'a string is not a count');
  assert.equal(normalizeLicense({ ...base, machinesInUse: 2.5 }).machinesInUse, undefined, 'a fraction of a machine is not a count');
  assert.equal(normalizeLicense({ ...base, expiresAt: '2027-09-26T00:00:00.000Z' }).expiresAt, '2027-09-26T00:00:00.000Z');
  assert.equal(normalizeLicense({ ...base, expiresAt: 'whenever' }).expiresAt, undefined, 'an unreadable date is no date');
  assert.equal(normalizeLicense({ ...base, released: true, machinesInUse: 1 }).key, KEY, 'a receipt flag must not unkey a license');
});

test('seat: the license key is not written to a report, released or not', async (t) => {
  const home = tempHome(t);
  await run(['activate', KEY], { env: home });
  writeFileSync(stateFile(home.HOME), JSON.stringify({
    urls: {},
    license: releaseReceipt({ plan: 'pro', machinesInUse: 2 }),
  }));
  const r = await run(['report'], { env: home });
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY));
});
