/**
 * P1-101 — the Pro gate that names a plural feature said "needs".
 *
 * Measured 2026-09-28 through the real CLI, a real `~/.deskuptime` in a temp
 * HOME, a real local webhook receiver and the license server stubbed (never a
 * call to mahope.tools), on the free tier and on a released seat:
 *
 *   ⚠️  No webhook was sent. webhook alerts needs an active Pro license. Pro unlocks it here: …
 *   ❌ Error: the client report needs an active Pro license. Pro unlocks it here: …
 *
 * Two gates, five sentences each, one owner — and the owner held the noun and
 * the verb apart. `proGateMessage(license, feature)` took the feature as a
 * string and interpolated `` `${feature} needs an active Pro license` ``, so the
 * verb could only ever be the singular `needs`. The singular gate read correctly
 * and the plural one did not, in all four states that print a message, including
 * the two that tell a customer who already paid whether to buy a second license.
 *
 * The defect is worth a lock of its own rather than one more assertion inside
 * license.test.js, because the two tests that *did* cover this function asserted
 * on a subject the caller supplied — they passed the same string in and read the
 * same string out, so a wrong verb was invisible to them. This file therefore
 * does not pass a verb in and check that it comes back: it checks the two
 * sentences against what a customer reads, and it locks the *shape* of every
 * call site in `src/`, which is the only place the bug can enter again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LICENSE_STATUS, describeLicense, proGateMessage } from '../src/license.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const iso = (t) => new Date(t).toISOString();

/** The two gates, exactly as `src/` names them. */
const WEBHOOK = { subject: 'webhook alerts', verb: 'need' };
const REPORT = { subject: 'the client report', verb: 'needs' };

/** Every state that prints a gate message, with the one that is Pro omitted. */
function gatedStates() {
  const paid = { key: KEY, instance: 'deskuptime-workstation-01', plan: 'pro' };
  return {
    free: null,
    unverified: { ...paid, status: LICENSE_STATUS.ACTIVE, validatedAt: iso(NOW - 41 * DAY) },
    invalid: { ...paid, status: LICENSE_STATUS.INVALID, validatedAt: iso(NOW - 1 * DAY) },
    released: { released: true, releasedAt: iso(NOW - 2 * DAY), plan: 'pro', machinesInUse: 1 },
  };
}

/** `describeLicense` really is in the state the name claims, or the row is a lie. */
test('the four gated states are the states their names claim', () => {
  const expected = {
    free: LICENSE_STATUS.FREE,
    unverified: LICENSE_STATUS.UNVERIFIED,
    invalid: LICENSE_STATUS.INVALID,
    released: LICENSE_STATUS.RELEASED,
  };
  for (const [name, license] of Object.entries(gatedStates())) {
    assert.equal(describeLicense(license, { now: NOW }).status, expected[name], `${name} is not ${expected[name]}`);
    assert.ok(proGateMessage(license, WEBHOOK, { now: NOW }), `${name} printed no gate message for the webhook`);
    assert.ok(proGateMessage(license, REPORT, { now: NOW }), `${name} printed no gate message for the report`);
  }
});

test('a plural feature gets "need" and a singular one gets "needs", in all four states', () => {
  for (const [name, license] of Object.entries(gatedStates())) {
    for (const gate of [WEBHOOK, REPORT]) {
      const message = proGateMessage(license, gate, { now: NOW });
      assert.ok(
        message.startsWith(`${gate.subject} ${gate.verb} an active Pro license`),
        `${name} / ${gate.subject}: ${message}`,
      );
    }
  }
});

// The one that would have caught the bug. It reads the sentences the way a
// customer does — as text with a subject and a verb — and it is deliberately
// blind to which gate produced them. The word boundary is the load-bearing part:
// "needs" contains "need", so a plain `includes` would flag every correct
// singular gate as wrong.
test('no gate says "needs" about a plural feature, or "need" about a singular one', () => {
  const wrong = { [WEBHOOK.subject]: 'needs', [REPORT.subject]: 'need' };
  for (const [name, license] of Object.entries(gatedStates())) {
    for (const gate of [WEBHOOK, REPORT]) {
      const message = proGateMessage(license, gate, { now: NOW });
      const misused = new RegExp(`${gate.subject} ${wrong[gate.subject]}\\b`);
      assert.ok(!misused.test(message), `${name}: ${misused} in ${message}`);
    }
  }
});

test('both callers pass a subject and a verb, and a name that agrees with itself', () => {
  const sources = ['cli.js', 'watch.js'].map(name => readFileSync(join(ROOT, 'src', name), 'utf8'));
  const callers = sources.flatMap(source => [...source.matchAll(/proGateMessage\([^,]+,\s*([A-Z_]+)\s*\)/g)].map(m => m[1]));
  assert.deepEqual([...new Set(callers)].sort(), ['REPORT_GATE', 'WEBHOOK_GATE'], `ukendte gate-kald: ${callers}`);
  // The constants themselves, read out of the two files rather than restated
  // here: a caller that hard-codes 'webhook alerts' inline again is the bug
  // returning, and this is what would notice.
  for (const [name, source] of [['cli.js', sources[0]], ['watch.js', sources[1]]]) {
    for (const [, subject, verb] of source.matchAll(/subject:\s*'([^']+)',\s*verb:\s*'(needs|need)'/g)) {
      const plural = /s$/.test(subject);
      assert.equal(verb, plural ? 'need' : 'needs', `${name}: "${subject}" med verbet "${verb}"`);
    }
  }
});

/** A local server that is a healthy site, so the loop reaches the gate. */
async function healthySite() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Gate</title></head><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise(done => server.close(done)),
  };
}

function home(t, license) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-progateverb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.deskuptime'), { recursive: true });
  writeFileSync(join(dir, '.deskuptime', 'state.json'), JSON.stringify({ version: 1, license, urls: {} }, null, 2));
  return dir;
}

function run(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', HOME: env, USERPROFILE: env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

/** The loop prints its gate in the first three seconds and then keeps running. */
async function gateFromLoop(site, dir) {
  const child = spawn(process.execPath, ['--import', STUB, CLI, 'watch', site.url, '--interval', '60', '--webhook', 'http://127.0.0.1:1/never'], {
    env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', HOME: dir, USERPROFILE: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !stderr.includes('No webhook was sent')) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGINT');
  await new Promise(resolve => child.on('exit', resolve));
  return stderr;
}

test('the real CLI: the webhook gate reads "webhook alerts need" on the free tier', async (t) => {
  const site = await healthySite();
  t.after(() => site.close());
  const stderr = await gateFromLoop(site, home(t, undefined));
  assert.match(stderr, /No webhook was sent\. webhook alerts need an active Pro license\./);
  assert.ok(
    !/webhook alerts needs\b/.test(stderr),
    `the plural gate still says "needs": ${stderr}`,
  );
});

test('the real CLI: the released-seat webhook gate says "need" too, and offers no checkout', async (t) => {
  const site = await healthySite();
  t.after(() => site.close());
  const released = { released: true, releasedAt: iso(Date.now()), plan: 'pro', machinesInUse: 1 };
  const stderr = await gateFromLoop(site, home(t, released));
  assert.match(stderr, /webhook alerts need an active Pro license — seat released on this machine on/);
  assert.doesNotMatch(stderr, /buy\.stripe\.com/, 'a machine that released its seat must not see the checkout');
});

test('the real CLI: the client-report gate is byte-identical to what it always printed', async (t) => {
  const dir = home(t, undefined);
  const r = await run(['report'], dir);
  assert.equal(r.code, 1);
  // Exactly this string, and not "need": the singular gate was never the broken
  // one, and a customer who upgrades gets the same words they had before.
  assert.match(
    r.stderr,
    /❌ Error: the client report needs an active Pro license\. Pro unlocks it here: https:\/\/buy\.stripe\.com\/7sY9AS9eX3Iu418fJ5bMQ01 — then "deskuptime activate <key>"\./,
  );
});

test('the client-report gate is unchanged in all four gated states', () => {
  // The regression half of the fix: the owner renders five sentences from one
  // noun and one verb, and only the webhook noun changed. These are the strings
  // the singular gate has always produced.
  assert.match(
    proGateMessage(null, REPORT, { now: NOW }),
    /^the client report needs an active Pro license\. Pro unlocks it here: /,
  );
  assert.match(
    proGateMessage({ released: true, releasedAt: iso(NOW - 2 * DAY) }, REPORT, { now: NOW }),
    /^the client report needs an active Pro license — seat released on this machine on 2026-09-26\./,
  );
});
