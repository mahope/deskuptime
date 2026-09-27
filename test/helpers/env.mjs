/**
 * P1-58 — the one owner of "which HOME may a test use".
 *
 * The suite runs the real CLI, and the CLI reads and writes
 * `$HOME/.deskuptime/state.json`. A test that runs it with the ambient `HOME`
 * therefore measures — and overwrites — the monitoring state of whoever ran
 * `npm test`. That is not a theoretical risk, it happened twice:
 *
 *   2026-09-27, `test/contentchange.test.js` — a destructuring slip in a new
 *   test meant `watch --once` ran with the real HOME and stored its result in
 *   `~/.deskuptime/state.json` (see ❓ 15).
 *   2026-09-27, this task's own measurement — `npm test` with a canary HOME
 *   wrote `http://kunde.dk/` (with `transitionAlerts`, `transitions` and
 *   `sslExpiredWarned`) into `$HOME/.deskuptime/state.json`, and with an empty
 *   canary it *created* `state.json` and `history.json` from nothing.
 *
 * `watch --once` rewrites the file it reads, so a single missing fixture is
 * enough: measured, a pass over a state holding one URL moved `lastChecked`
 * from 2020 to now.
 *
 * Three independent locks, none of which needs a test author to remember
 * anything:
 *
 *   1. `tools/run-tests.mjs` starts the whole suite under one throwaway HOME,
 *      so a test that forgets its own env inherits a temp directory.
 *   2. `test/isolation.test.js` asserts that the suite's own `HOME` is a temp
 *      directory, so running `node --test` by hand — which skips lock 1 — turns
 *      the gate red instead of writing to the real state file.
 *   3. The runner stats the real `~/.deskuptime/state.json` before and after
 *      and fails if it moved, so lock 1 is verified, not assumed.
 *
 * Per-file locks still exist where a test calls the CLI directly
 * (`cli()` below); they are the early warning, not the guarantee.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * The variables that decide where the CLI keeps its state. `getStateFile()`
 * reads `USERPROFILE` first on Windows and `HOME` first elsewhere, and falls
 * back to `os.homedir()` when neither is set — so all three answers have to be
 * a temp directory, not just the one this platform happens to prefer.
 */
const HOME_VARS = ['HOME', 'USERPROFILE'];

/**
 * Is this a directory a test is allowed to write monitoring state into?
 *
 * `resolve()` does the work that a `startsWith` alone gets wrong: on macOS
 * `/tmp` is a symlink into `/private/tmp`, so a realpath-based check would
 * reject the very directories `mkdtempSync` hands out, while a prefix check
 * would happily accept `/var/folders/xx/../../Users/mads` and hand a test the
 * developer's home through the back door. Comparing the *resolved* path to the
 * input rejects the traversal and leaves the symlink alone.
 */
export function isTempHome(home) {
  if (typeof home !== 'string' || home === '') return false;
  if (resolve(home) !== home) return false;
  return home === tmpdir() || home.startsWith(tmpdir() + sep);
}

/**
 * The home a given `env` would actually resolve to, following `getStateFile()`.
 */
export function effectiveHome(env) {
  if (!env) return homedir();
  if (process.platform === 'win32') return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || homedir();
}

/**
 * Refuse an environment that could reach a real state file. Throws with the
 * offending value, because "the CLI must not run with the real HOME" is only
 * useful if it says which HOME it meant.
 */
export function assertTempHome(env, subject = 'a test') {
  const offenders = HOME_VARS
    .filter((name) => env?.[name] !== undefined)
    .filter((name) => !isTempHome(env[name]));
  if (offenders.length > 0) {
    const detail = offenders.map((name) => `${name}=${JSON.stringify(env[name])}`).join(', ');
    throw new Error(
      `${subject} must not run the CLI outside a temp HOME — ${detail} would read and write ` +
      `the monitoring state of whoever runs the suite. Use tempHome() from test/helpers/env.mjs, ` +
      `or run the suite through \`npm test\`, which starts it under a throwaway HOME.`,
    );
  }
  const home = effectiveHome(env);
  if (!isTempHome(home)) {
    throw new Error(
      `${subject} must not run the CLI outside a temp HOME — no HOME is set, so the CLI would ` +
      `fall back to ${JSON.stringify(home)}. Use tempHome() from test/helpers/env.mjs.`,
    );
  }
  return home;
}

/**
 * A throwaway HOME with `.deskuptime` already present, removed when the test
 * ends. `options` is the `env` fragment to spread into a child process.
 */
export function tempHome(t, prefix = 'deskuptime-test-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const options = { HOME: home, USERPROFILE: home };
  if (t && typeof t.after === 'function') t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { home, options, dir: join(home, '.deskuptime') };
}
