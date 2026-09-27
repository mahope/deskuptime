/**
 * P1-50 — the interval floor was the one Pro limit that refused in silence.
 *
 * Measured 2026-09-27 with the real CLI, a real local site answering 200 and a
 * real `state.json` with no license — every place a free user is stopped, to see
 * which ones name the upgrade path:
 *
 *   4th URL    ⚠️  Free tier monitors 3 URLs. … Pro unlocks unlimited URLs …
 *   --webhook  ⚠️  No webhook was sent. … Pro unlocks it here: <buy link> …
 *   --interval ⚠️  (nothing)   ← typed 30, ran every 60s, said nothing
 *
 * Silence is the worst answer of the three, because 30s is the value the matrix
 * and `upgradeHint` advertise as the Pro one. The user typed the number they saw
 * on the sales page, the tool disagreed, and it said nothing: the number in the
 * banner was not the number in the command, and the one place the CLI could have
 * said "this is what Pro is for" is the one place it did not.
 *
 * It was also the only case where the free tier was *not* usable afterwards. The
 * URL limit and the webhook both keep the loop running and say so; the interval
 * did the same, so the fix is a sentence and not a refusal — the first tests
 * below are about what must keep working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { intervalRaisedMessage, freeLimitMessage, upgradeHint, PRO_BUY_URL } from '../src/watch.js';
import { FREE, PRO } from '../src/features.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const license = { key: KEY, instance: 'p150', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };

/** A real site answering 200, so the loop has something to measure. */
async function liveSite(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/`;
}

function tempHome(t, { pro = false, site } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-interval-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const state = {
    urls: { [site]: { wasUp: true, lastCheck: Date.now(), lastFinalUrl: site, lastStatus: 200, checks: 2, checksUp: 2, lastChecked: new Date().toISOString() } },
  };
  if (pro) state.license = { ...license };
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify(state, null, 2));
  return { HOME: home, USERPROFILE: home };
}

/**
 * The real `watch` loop, killed after `ms`. A loop that answered the clamp by
 * refusing to start would exit before the banner, so the banner is part of what
 * these tests read.
 */
function watchLoop(args, env, ms = 6000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', STUB, CLI, ...args], { env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('the sentence names the value asked, the value used and the Pro value', () => {
  const said = intervalRaisedMessage(30, FREE.minIntervalSeconds);
  assert.match(said, /--interval 30/, 'the user must see the number they typed');
  assert.match(said, /every 60s/, 'and the number the loop will really use');
  assert.match(said, /a 30s interval/, 'and the Pro value that unlocks it');
});

test('a free user who typed the Pro interval is told, and given the way to buy it', () => {
  // The measured journey. Everything else about it already worked: the loop ran.
  const said = intervalRaisedMessage(30, FREE.minIntervalSeconds);
  assert.ok(said.includes(PRO_BUY_URL), 'a Pro limit must name the way to lift it');
  assert.equal(said, `${intervalRaisedMessage(30, FREE.minIntervalSeconds)}`, 'one owner, one sentence');
});

test('a paying customer below Pro\'s own minimum is told without the checkout', () => {
  // P1-19's rule, applied to a second surface: this machine has already paid,
  // and a buy link here is the reply that makes a customer buy twice.
  const said = intervalRaisedMessage(5, PRO.minIntervalSeconds, { pro: true });
  assert.match(said, /--interval 5/);
  assert.match(said, /every 30s/);
  assert.ok(!said.includes(PRO_BUY_URL), 'Pro must never be sent to the checkout');
});

test('an interval the tier does run says nothing at all', async t => {
  // The other half of the rule, and it belongs to the call site rather than the
  // owner: the owner always has a sentence ready, and the loop must only ask
  // for it when the floor actually bit. A note on every start would be noise,
  // and it would teach the customer to skip the line that matters.
  const site = await liveSite(t);
  const r = await watchLoop(['watch', site, '--interval', '60'], tempHome(t, { site }));
  assert.match(r.stdout, /every 60s/);
  assert.ok(!r.stderr.includes('--interval'), `nothing to say about an interval we honoured, got: ${r.stderr}`);
  assert.ok(!r.stdout.includes(PRO_BUY_URL), 'and no checkout for a user who asked for nothing extra');
});

test('the real loop: a free user asking for 30s is told, and the loop still runs', async t => {
  const site = await liveSite(t);
  const env = tempHome(t, { site });
  const r = await watchLoop(['watch', site, '--interval', '30'], env);
  assert.match(r.stdout, /every 60s/, 'the banner is unchanged — the floor still holds');
  assert.match(r.stderr, /--interval 30 is below the free tier's 60s minimum/);
  assert.ok(r.stderr.includes(PRO_BUY_URL), 'and the sentence carries the buy link');
});

test('the real loop: an interval the free tier runs is not announced as a refusal', async t => {
  const site = await liveSite(t);
  const r = await watchLoop(['watch', site, '--interval', '300'], tempHome(t, { site }));
  assert.match(r.stdout, /every 300s/);
  assert.ok(!r.stderr.includes('--interval'), `nothing to say about an interval we honoured, got: ${r.stderr}`);
  assert.ok(!r.stdout.includes(PRO_BUY_URL), 'and no checkout for a user who asked for nothing extra');
});

test('all three Pro walls reach the same upgrade path', () => {
  // The finding itself: the URL limit and the webhook named the upgrade, the
  // interval did not. A lock on the three together, so a fourth Pro wall
  // cannot be added without deciding where it sits.
  for (const said of [
    freeLimitMessage('https://kunde.dk/'),
    upgradeHint('a 30s interval'),
    intervalRaisedMessage(30, FREE.minIntervalSeconds),
  ]) {
    assert.ok(said.includes(PRO_BUY_URL), `a Pro limit must name the checkout: ${said}`);
  }
});

test('the floor is read from the same constants the matrix advertises', () => {
  // If the sentence and the enforced number could disagree, the sentence would
  // be a second claim about the tier — the drift P1-1's matrix exists to stop.
  assert.equal(FREE.minIntervalSeconds, 60);
  assert.equal(PRO.minIntervalSeconds, 30);
  assert.match(intervalRaisedMessage(30, FREE.minIntervalSeconds), new RegExp(`every ${FREE.minIntervalSeconds}s`));
  assert.match(intervalRaisedMessage(5, PRO.minIntervalSeconds, { pro: true }), new RegExp(`every ${PRO.minIntervalSeconds}s`));
});

test('the floor lives in the loop, not in the CLI\'s argument check', () => {
  // Structural: the CLI validates the *range*, the tier owns the *floor*. A
  // second clamp in the argument check would let the two disagree about which
  // numbers are acceptable, which is the mistake P1-16 measured on the payload.
  const watch = readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8');
  const clamp = watch.match(/const interval = Math\.max\([^;]+;/);
  assert.ok(clamp, 'the clamp must still be a single expression');
  assert.match(clamp[0], /minInterval/, 'and it must be the tier minimum, not a literal');
});
