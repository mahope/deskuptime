/**
 * P1-81 — the measurement benches must not write into the real `~/.deskuptime`.
 *
 * `getStateFile()` and `getHistoryFile()` each read `env.HOME`/`env.USERPROFILE`
 * out of the options object they are handed. A caller can therefore redirect
 * both files by passing `env` — and only by passing `env`. There is no `home`
 * key: it is read by nothing, and an option that is silently ignored looks
 * exactly like one that worked.
 *
 * `tools/measure-e2e.mjs` passed `home` to `runPass()`. Measured 2026-09-28,
 * nothing stubbed but the two directories it was pointed at, by running a real
 * `runPass` over a real local server with `process.env.HOME` aimed at a
 * throwaway stand-in for the developer's home:
 *
 *   opts.home (PASSED)           state.json    —
 *   opts.home (PASSED)           history.json  —
 *   process.env.HOME (AMBIENT)   state.json    WRITTEN
 *   process.env.HOME (AMBIENT)   history.json  WRITTEN
 *
 * Both files went to the real home while the bench printed surfaces from its
 * own empty temp HOME. That is P1-58's accident, reintroduced by the tool
 * added to prevent it, and it happened to the person running the bench. It also
 * made the bench lie: the report it printed said
 * `— (last check missing from the history file)` about a site it had just
 * recorded three passes for, because the passes it had taken were in the other
 * directory.
 *
 * These are locks on the behaviour, not on the spelling. The first test hands
 * `runPass()` a temp HOME two ways and requires that only `env` moves the
 * files; the second runs the real bench under an observed HOME and requires
 * that the directory it inherited stays empty — the observation that catches
 * the bug with the scan removed, measured: with the scan deleted the unit test
 * alone passed on the broken bench, and this one did not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempHome } from './helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Both files, in the directory a given HOME would use. */
function filesUnder(home) {
  const dir = join(home, '.deskuptime');
  return { state: join(dir, 'state.json'), history: join(dir, 'history.json') };
}

test('only env moves the files a pass writes; a `home` key moves nothing', async (t) => {
  // The suite's own HOME is shared: `node --test` runs files in parallel, and
  // the first version of this test asserted on it and failed the gate for a
  // reason that had nothing to do with the bug — a neighbouring file wrote
  // there. It gets a HOME of its own instead, and moves `process.env.HOME` for
  // the duration, which is what "the HOME a pass inherits" means to a caller
  // that passes no `env` at all.
  const { home: ambient } = tempHome(t, 'deskuptime-benchhome-ambient-');
  const { home: passed } = tempHome(t, 'deskuptime-benchhome-');
  const before = process.env.HOME;
  process.env.HOME = ambient;
  process.env.USERPROFILE = ambient;
  t.after(() => {
    process.env.HOME = before;
    process.env.USERPROFILE = before;
  });

  const { runPass } = await import('../src/watch.js');
  const { checkUrl } = await import('../src/engine.js');

  const site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Acme</title>ok');
  });
  t.after(() => new Promise(resolve => site.close(resolve)));
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const state = { version: 1, urls: { [url]: { addedAt: new Date().toISOString() } } };

  // The mistake, reproduced: a temp home handed over under a key nothing reads.
  await runPass(state, { home: passed, now: new Date(), check: checkUrl, returnResults: true });

  assert.equal(existsSync(filesUnder(passed).state), false, 'a `home` key must not redirect the state file');
  assert.ok(
    existsSync(filesUnder(ambient).state),
    'the pass still wrote into the HOME it inherited, which is what the bug looked like from the outside',
  );

  // The repair, measured the same way: `env` moves both files, and the
  // inherited HOME is left alone. The pass is run against a fresh temp HOME so
  // the two halves cannot be confused with each other.
  const { home: real } = tempHome(t, 'deskuptime-benchhome-real-');
  const { home: decoy } = tempHome(t, 'deskuptime-benchhome-decoy-');
  rmSync(filesUnder(ambient).state, { force: true });
  rmSync(filesUnder(ambient).history, { force: true });
  await runPass(state, { env: { HOME: real, USERPROFILE: real }, now: new Date(), check: checkUrl, returnResults: true });

  assert.ok(existsSync(filesUnder(real).state), 'env must redirect the state file');
  assert.ok(existsSync(filesUnder(real).history), 'and the history with it, so both owners are asked the same way');
  assert.equal(existsSync(filesUnder(decoy).state), false, 'and nothing may land in a directory nobody named');
  assert.equal(existsSync(filesUnder(ambient).state), false, 'the inherited HOME stays untouched');
});

test('running the real bench leaves the HOME it inherited untouched', (t) => {
  // The lock that survives having the scan removed. The bench is a process, so
  // the strongest version of this is to run it: give it a HOME of its own and
  // look at that directory afterwards. Measured both ways on 2026-09-28 with
  // the bench unmodified it wrote nothing there; with `home` put back it wrote
  // `state.json` (948 bytes) and `history.json` (147 bytes) — the exact files
  // that belong to whoever ran it.
  const { home: observed, dir } = tempHome(t, 'deskuptime-bench-observed-');
  const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'measure-e2e.mjs')], {
    env: { ...process.env, HOME: observed, USERPROFILE: observed },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `the bench must run: ${result.stderr}`);

  // Nothing, not "no state file": the bench is a measuring tool, so anything
  // under this HOME means it reached for the state it inherited.
  const written = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(written, [], `tools/measure-e2e.mjs wrote into the HOME it inherited: ${written.join(', ')}`);

  // And the observation is only meaningful if the same run really did measure
  // something — a bench that silently stopped would pass this test by doing
  // nothing at all.
  assert.match(result.stdout, /runPass|pass: /, 'the bench must actually have measured a pass');
});

test('neither measurement bench hands runPass a key it cannot read', () => {
  // A scan cannot prove `home` is unused — only the first test can, and only
  // because it watches the files. What the scan adds is that the mistake is
  // caught where it is written, in both benches, before a run costs anything.
  for (const name of ['measure-e2e.mjs', 'measure-surfaces.mjs']) {
    const source = readFileSync(join(ROOT, 'tools', name), 'utf8');
    assert.ok(
      !/runPass\([^)]*\bhome\s*[:,}]/.test(source),
      `tools/${name} passes \`home\` to runPass — read by nothing, so the pass writes the real ~/.deskuptime`,
    );
    assert.ok(source.includes('tempHome('), `tools/${name} must run under a throwaway HOME`);
  }
  // The other two ways to redirect a file are the ones the owners read, so
  // they are allowed — named here so the ban above cannot be read as a ban on
  // redirecting the files at all.
  const owners = readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8');
  assert.match(owners, /options\.stateFile \|\| getStateFile\(options\)/, 'the state file still has its explicit path');
});
