/**
 * P1-92 — the lock behind `tools/run-tests.mjs` making the internet unreachable.
 *
 * Two tests in this suite were decided by the public internet, and neither was
 * found by reading the code:
 *
 *   `test/certrotation.test.js` measured "checkSSL reads both identity fields"
 *   by shaking hands with `https://example.com`. Commit 606166c — a diff in
 *   `IMPLEMENTATION_PLAN.md` alone — was red on the runner with
 *   `read ECONNRESET` from that one test.
 *
 *   `test/uncheckable.test.js` ran the real CLI against `https://c.dk/`, a
 *   *registered* Danish domain, and asserted exit 0. Cut the network and it
 *   exits 2, because the site is gone rather than up.
 *
 * `test/helpers/offline.mjs` closes the class; this file is what holds it there.
 * It is deliberately **not** a scan of the test sources for public URLs. A
 * regex version of this lock was written first and thrown away after measuring
 * it: it flagged a docstring, an RFC 2606 `.example` name, three URL templates
 * whose host is a loopback port, and its own fixtures — and it still missed
 * `c.dk`, because that call reaches the network through a local `run()` helper
 * and not through the functions the regex knew about. Four classes of noise to
 * catch one of two real cases is a lock that gets switched off.
 *
 * So the lock is the same measurement, run on purpose: cut the network in a
 * child and see what the code does. That is exact, it has no blind spot to
 * reason about, and it fails with the name of the test that needs the internet
 * rather than with a line number in a list.
 *
 * `isolation.test.js` sets the precedent this file follows: a gate-level guard
 * is worth little unless its own wiring is pinned, and worth nothing at all if
 * it cannot be made to fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { isLocalHost, isUnreachableFromHere, PUBLIC_READS } from './helpers/offline.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const PRELOAD = pathToFileURL(join(ROOT, 'test', 'helpers', 'offline.mjs')).href;

/** A script that prints what this machine could and could not have resolved. It is
 *  the control for the block below: without it, "the network was cut" is a claim
 *  about the preload rather than an observation. */
const PROBE = 'probe-offline.mjs';
const PROBE_SOURCE = `
  import dns from 'node:dns';
  import { isLocalHost, isUnreachableFromHere } from ${JSON.stringify(PRELOAD)};
  const report = async (host) => ({
    host,
    local: isLocalHost(host),
    unreachable: isUnreachableFromHere(host),
    lookedUp: await new Promise((done) => {
      dns.lookup(host, (error, address) =>
        done({ code: error?.code ?? null, address: address ?? null }));
    }),
  });
  console.log(JSON.stringify({
    loopback: await report('127.0.0.1'),
    localhostName: await report('localhost'),
    public: await report('example.com'),
    allowlisted: await report('mahope.tools'),
  }));
`;

/** A child process under the same preload the suite runs under. */
function probeUnderThePreload() {
  return run(process.execPath, [
    '--import', PRELOAD,
    join(ROOT, 'test', 'helpers', PROBE),
  ], { cwd: ROOT, encoding: 'utf8' });
}

test('a public host is unreachable under the preload, and loopback is not', async (t) => {
  const path = join(ROOT, 'test', 'helpers', PROBE);
  writeFileSync(path, PROBE_SOURCE);
  t.after(() => rmSync(path, { force: true }));

  const { stdout } = await probeUnderThePreload();
  const result = JSON.parse(stdout);

  assert.equal(result.public.lookedUp.code, 'ENOTFOUND', 'a public name must not resolve');
  assert.equal(result.public.lookedUp.address, null);
  assert.equal(result.public.unreachable, true, 'and the preload is what decided it');

  // The half that matters just as much: a suite of 34 files that stand up their
  // own servers must keep working, so loopback is explicitly not blocked.
  assert.equal(result.loopback.lookedUp.address, '127.0.0.1', 'loopback still resolves');
  assert.equal(result.loopback.local, true);
  assert.equal(result.loopback.unreachable, false);
  assert.equal(result.localhostName.lookedUp.code, null, 'and so does the name for it');
});

test('a control child without the preload, observed but never asserted on', async (t) => {
  // The control exists to answer one question: is the network cut by the
  // preload, or is this machine simply offline? It answers it by resolving
  // `example.com` in a child that does *not* load the preload, with the
  // suite's own `NODE_OPTIONS` stripped so the inheritance cannot reach it.
  //
  // It deliberately asserts nothing. An earlier version of this test required
  // the answer to be "resolved", which made the gate red on a machine without
  // a route to DNS — the exact class of failure this whole file exists to end.
  // The invariant that matters is the one the test above states; this one is
  // reported, so a reader can see which of the two situations they are in.
  const path = join(ROOT, 'test', 'helpers', 'probe-online.mjs');
  writeFileSync(path, `
    import dns from 'node:dns';
    dns.lookup('example.com', (error, address) => {
      console.log(JSON.stringify({ code: error?.code ?? null, address: address ?? null }));
    });
  `);
  t.after(() => rmSync(path, { force: true }));

  let observed;
  try {
    const { stdout } = await run(process.execPath, [path], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    observed = JSON.parse(stdout);
  } catch (error) {
    observed = { code: error.code ?? 'spawn failed', address: null };
  }
  t.diagnostic(observed.address
    ? `control: this machine resolves example.com (${observed.address}), so the block above is the preload's doing`
    : `control: this machine cannot resolve example.com (${observed.code}), so it is offline — the block above is still true, but not only because of the preload`);
  assert.equal(typeof observed.address === 'string' || observed.address === null, true, 'the control reported something either way');
});

test('the runner wires the preload, and no opt-out', () => {
  const runner = readFileSync(join(ROOT, 'tools', 'run-tests.mjs'), 'utf8');
  assert.match(runner, /NODE_OPTIONS/, 'the preload has to reach the children, not just the test runner');
  assert.match(runner, /helpers.*offline\.mjs|offline\.mjs/, 'and it has to be this preload');
  assert.doesNotMatch(runner, /DESKUPTIME_OFFLINE=0/, 'a switch that turns the lock off does not belong in the runner');

  // The suite's own entry point still has to go through the runner, or none of
  // the above is in force. `isolation.test.js` pins the rest of that wiring.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node tools/run-tests.mjs');
  assert.ok(existsSync(join(ROOT, 'test', 'helpers', 'offline.mjs')), 'the preload is where the runner says it is');
});

test('no case has argued for reading the public internet', () => {
  // Empty, and asserted empty: a non-empty list is a decision somebody has to
  // make in review, and it is also the list to grep when a gate goes red for a
  // reason nobody can find.
  assert.deepEqual(Object.keys(PUBLIC_READS), []);
});

test('the two measured sites are measured here instead', () => {
  // Pinned by name so the regression this file exists for cannot come back as a
  // passing suite: the certificate is built by the shared fixture helper, and
  // the free-slot test watches a loopback server rather than a Danish domain.
  const certrotation = readFileSync(join(ROOT, 'test', 'certrotation.test.js'), 'utf8');
  assert.match(certrotation, /selfSignedFixture/, 'the certificate is a local fixture');
  assert.doesNotMatch(certrotation, /checkSSL\(['"`]https:\/\/(?!127\.)/, 'and the handshake has no public host in it');

  const uncheckable = readFileSync(join(ROOT, 'test', 'uncheckable.test.js'), 'utf8');
  assert.doesNotMatch(uncheckable, /run\(\['watch', 'https:\/\/(?!127\.)/, 'the free-slot case watches a local server');
});
