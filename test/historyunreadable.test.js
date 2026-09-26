/**
 * P1-48: an uptime history that exists and cannot be read.
 *
 * Measured 2026-09-26 with the real CLI, a real local site answering 200, a
 * real `state.json` with Pro and a real 30 days of history, then the history
 * truncated to half its bytes — what a full disk or a killed process leaves
 * behind:
 *
 *   watch --once  →  ✓ all monitored sites OK                       (exit 0)
 *   history.json  →  2 383 bytes → 147 bytes                       (29 recorded d,
 *                      41 760 checks, 12 failures → one bucket, today)
 *   report        →  | …/ | UP (200) | 100% (2 checks) | 100% (1 recorded d, 1 checks) |
 *
 * One pass replaced a month of evidence and said nothing. The report then signed
 * a client's document with a share read from a file it could not read, and
 * P1-38's window-gap guard could not see it: after the overwrite the file really
 * does hold one recorded day, so the gap it looks for is not there.
 *
 * `state.json` got the same guard in P1-44 because it holds a license key. This
 * file holds the uptime a bureau bills for, and it had none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EHISTORY_UNREADABLE, readHistoryFile, saveHistory } from '../src/history.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const license = { key: KEY, instance: 'p148', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-historybroken-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { home, env: { HOME: home, USERPROFILE: home }, history: join(home, '.deskuptime', 'history.json') };
}

function site(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Acme</title>');
  });
  t.after(() => new Promise(r => server.close(r)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`)));
}

/** 30 days of real history, in the shape history.js itself writes. */
function monthOfHistory(url) {
  const days = {};
  for (let i = 30; i >= 1; i--) {
    days[new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)] = { checks: 1440, failures: i % 7 === 0 ? 3 : 0 };
  }
  return { version: 1, urls: { [url]: days } };
}

function truncate(file, full) {
  const good = JSON.stringify(full, null, 2);
  const cut = good.slice(0, Math.floor(good.length / 2));
  writeFileSync(file, cut);
  return { good, cut };
}

test('a history file that cannot be read is never written over, and the pass says why', async (t) => {
  const { env, history } = tempHome(t);
  const url = await site(t);
  const full = monthOfHistory(url);

  writeFileSync(join(env.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    license, urls: { [url]: { wasUp: true, lastChecked: new Date().toISOString(), lastStatus: 200, totalChecks: 43200, totalUptime: 43188 } },
  }));
  const { cut } = truncate(history, full);

  const pass = await run(['watch', '--once'], { env });

  // Monitoring is not the thing that broke, so the pass still ran and still exits
  // on the health of the sites — P1-39's rule, unchanged.
  assert.equal(pass.code, 0);
  assert.match(pass.stdout, /all monitored sites OK/);
  // The one harm: the file the user must not lose is byte-for-byte the file they
  // had. Before the fix this was 147 bytes — one bucket, today.
  assert.equal(readFileSync(history, 'utf-8'), cut);
  assert.ok(cut.length > 500, 'the fixture must really hold a month, or the test proves nothing');
  // …and it is said, with the file and the reason, not left to be inferred from
  // a missing counter.
  assert.match(pass.stderr, /cannot read the uptime history/);
  assert.match(pass.stderr, /invalid JSON/);
  assert.match(pass.stderr, /history\.json/);
  // The one command that gets a clean month back, and it keeps the old bytes.
  assert.match(pass.stderr, /mv ".*history\.json" ".*history\.json\.broken"/);
});

test('no client report is built from a history file that cannot be read', async (t) => {
  const { env, history } = tempHome(t);
  const url = await site(t);

  writeFileSync(join(env.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    license, urls: { [url]: { wasUp: true, lastChecked: new Date().toISOString(), lastStatus: 200, totalChecks: 43200, totalUptime: 43188 } },
  }));
  truncate(history, monthOfHistory(url));

  const report = await run(['report'], { env });
  assert.equal(report.code, 1);
  assert.match(report.stderr, /cannot read the uptime history/);
  // No share, no "1 recorded d", no table: the document is the product here, and
  // a number we could not measure is what P1-38 exists to keep out of it.
  assert.equal(report.stdout, '');
  assert.doesNotMatch(report.stdout, /recorded d/);
});

test('the counterweight: a readable history is written and reported as before', async (t) => {
  const { env, history } = tempHome(t);
  const url = await site(t);
  const full = monthOfHistory(url);

  writeFileSync(join(env.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    license, urls: { [url]: { wasUp: true, lastChecked: new Date().toISOString(), lastStatus: 200, totalChecks: 43200, totalUptime: 43188 } },
  }));
  writeFileSync(history, JSON.stringify(full, null, 2));

  const pass = await run(['watch', '--once'], { env });
  assert.equal(pass.code, 0);
  assert.equal(pass.stderr, '', 'a readable history has nothing to warn about');
  // The month's days are still there, and today's pass was added to them — 30
  // written by the fixture, 31 counted after the pass.
  const after = readHistoryFile({ historyFile: history }).history;
  assert.equal(Object.keys(after.urls[url]).length, 31);
  assert.ok(after.urls[url][new Date().toISOString().slice(0, 10)]);

  const report = await run(['report'], { env });
  assert.equal(report.code, 0);
  assert.match(report.stdout, /recorded d/);
});

test('the counterweight: a history that is readable but missing today is still the "missing pass" column', async (t) => {
  const { env, history } = tempHome(t);
  const url = await site(t);
  // A file that parses and holds nothing — an agency that copied `state.json`
  // and not `history.json`. This is P1-41's case, and it must not regress into
  // a refusal, because there the report *can* name what it does not have: a
  // readable file with no bucket for the pass the state file records.
  const withoutAnyPasses = { version: 1, urls: {} };

  writeFileSync(join(env.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    license, urls: { [url]: { wasUp: true, lastChecked: new Date().toISOString(), lastStatus: 200, totalChecks: 43200, totalUptime: 43188 } },
  }));
  writeFileSync(history, JSON.stringify(withoutAnyPasses, null, 2));

  const report = await run(['report'], { env });
  assert.equal(report.code, 0);
  assert.match(report.stdout, /last check missing from the history file/);
  assert.equal(report.stderr, '');
});

test('saveHistory refuses to replace a file it could not parse, and leaves it alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-savehist-'));
  const file = join(dir, 'history.json');
  writeFileSync(file, '{"version":1,"urls":{"https://kunde.dk/":{"2026-09-2');

  const reason = readHistoryFile({ historyFile: file }).unreadable;
  assert.ok(reason, 'a truncated file is unreadable, not empty');
  assert.match(reason.historyFile, /history\.json$/);

  assert.throws(
    () => saveHistory({ version: 1, urls: { 'https://ny.dk/': { '2026-09-26': { checks: 1, failures: 0 } } } }, { historyFile: file }),
    (error) => error.code === EHISTORY_UNREADABLE,
  );
  assert.equal(readFileSync(file, 'utf-8'), '{"version":1,"urls":{"https://kunde.dk/":{"2026-09-2');

  // A readable file is written as before, so the guard costs nothing in the
  // ordinary case — including the first write of a file that does not exist yet.
  const fresh = join(dir, 'fresh.json');
  saveHistory({ version: 1, urls: { 'https://ny.dk/': { '2026-09-26': { checks: 1, failures: 0 } } } }, { historyFile: fresh });
  assert.equal(readHistoryFile({ historyFile: fresh }).history.urls['https://ny.dk/']['2026-09-26'].checks, 1);
  rmSync(dir, { recursive: true, force: true });
});
