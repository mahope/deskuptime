/**
 * P1-106 — the one command that takes the key *and* starts monitoring was built
 * and never mentioned.
 *
 * Measured 2026-09-28 with the real CLI, a real local site and a real temp HOME.
 * `--activate` is parsed by `watch` and reaches `activateLicense`, and it worked on
 * the first try — but it appeared in **zero** of the three places a customer looks
 * after paying:
 *
 *   grep -c -- "--activate" README.md docs/*.md   →  0
 *   deskuptime --help | grep -c -- "--activate"  →  0
 *
 * So the only thing the tool told someone who had just paid $19 was
 * `deskuptime activate <key>`, and then a second command to start watching. The
 * single step that does both was real, reachable, and undiscoverable. On a repo
 * with 35 npm downloads a month and 0 GitHub stars, that is the whole difference
 * between a customer who is monitoring five minutes after checkout and one who is
 * not.
 *
 * These tests lock it in place. The surface tests are the lock; the behaviour
 * tests are there so the lock cannot be satisfied by a line of prose that the code
 * stopped honouring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const lifecycle = readFileSync(join(ROOT, 'docs', 'license-lifecycle.md'), 'utf8');
const help = readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8');

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-activate-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

function cli(args, env, scenario = 'passthrough') {
  return run(process.execPath, ['--import', STUB, CLI, ...args], {
    env: { ...process.env, DUB_STUB_SCENARIO: scenario, ...env },
  });
}

/** A real site answering 200, so the loop has something to measure. */
async function liveSite(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Acme</title></head><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

/** The real `watch` loop, killed after `ms`. The banner is part of what we read. */
function watchLoop(args, env, ms = 6000, scenario = 'ok') {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: scenario, ...env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// ── The lock: the flag is named on every surface a customer reads ──────────

test('the rendered --help names --activate on the watch line and in an example', async t => {
  const home = tempHome(t);
  const { stdout } = await cli(['--help'], home);
  const watchLine = stdout.split('\n').find(line => line.includes('deskuptime watch <url> ['));
  assert.ok(watchLine, '--help has no watch usage line');
  assert.ok(watchLine.includes('--activate'), `the watch line in --help does not offer --activate:\n${watchLine}`);
  assert.ok(
    stdout.split('\n').some(line => /deskuptime watch \S+ --activate/.test(line)),
    'no --help example shows the key going straight into watch',
  );
  // The other documented way stays discoverable from the same screen.
  assert.ok(/deskuptime activate <key>/.test(stdout), '--help dropped the activate command');
  assert.ok(stdout.includes('watch <url> --activate <key>'), 'the activate line does not point at the flag');
});

test('README shows the one-step form next to the key the customer just paid for', () => {
  assert.ok(
    /deskuptime watch https?:\/\/\S+ --activate <license-key>/.test(readme),
    'README does not show `watch <url> --activate <license-key>`',
  );
  assert.ok(/deskuptime activate <license-key>/.test(readme), 'README dropped the activate command');
  // The claim the README now makes, so a later edit cannot quietly make it false.
  assert.ok(/same license record/i.test(readme), 'README does not say the two ways write the same record');
});

test('the lifecycle spec names both activation paths and the rules of the flag', () => {
  assert.ok(lifecycle.includes('--activate <license-key>'), 'docs/license-lifecycle.md does not name the flag');
  assert.ok(/De to aktiveringsveje/.test(lifecycle), 'docs/license-lifecycle.md has no section on the two paths');
});

// ── The behaviour, so the lock cannot be satisfied by prose ─────────────────

test('the flag reaches activation: a real key unlocks Pro before the loop starts', async t => {
  const home = tempHome(t);
  const site = await liveSite(t);
  const { stdout } = await watchLoop(['watch', site, '--activate', KEY], home);
  assert.match(stdout, /🔑 Activating license\.\.\./);
  assert.match(stdout, /✅ Pro activated \(3 of 3 machines in use\)/);
  // Pro, not the free tier — the whole point of doing it in one command.
  assert.match(stdout, /\[Pro\]/, `the loop did not start as Pro:\n${stdout}`);
  assert.doesNotMatch(stdout, /Free tier monitors/, 'a freshly activated customer hit the free URL wall');
});

test('a key the server will not confirm costs no seat and the loop still runs free', async t => {
  const home = tempHome(t);
  const site = await liveSite(t);
  // `limit` is the stub's 409: a fourth machine on a three-machine license.
  const { stdout, stderr } = await watchLoop(['watch', site, '--activate', KEY], home, 6000, 'limit');
  assert.match(stderr, /❌ Activation failed/);
  const state = JSON.parse(readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf8'));
  assert.equal(state.license, undefined, 'a refused key was written to the state file');
  assert.ok(Object.keys(state.urls).length >= 1, 'the loop stopped instead of monitoring on the free tier');
  assert.match(stdout, /free tier/i, `the loop did not say it is on the free tier:\n${stdout}`);
});

test('a cron run cannot activate: --once and --status both refuse the flag', async t => {
  const home = tempHome(t);
  const site = await liveSite(t);
  const once = await run(process.execPath, [CLI, 'watch', site, '--once', '--activate', KEY], { env: { ...process.env, ...home } })
    .catch(error => error);
  assert.match(once.stderr, /--once cannot be combined with monitoring options/);
  const status = await run(process.execPath, [CLI, 'watch', '--status', '--activate', KEY], { env: { ...process.env, ...home } })
    .catch(error => error);
  assert.match(status.stderr, /--status does not accept URLs or monitoring options/);
  const statePath = join(home.HOME, '.deskuptime', 'state.json');
  const written = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
  assert.equal(written.includes(KEY), false, 'a refused combination still wrote the key');
});
