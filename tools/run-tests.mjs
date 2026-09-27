/**
 * P1-58 — the test suite's entry point, and the lock around `HOME`.
 *
 * `npm test` runs this instead of `node --test …` for one measured reason: a
 * test that runs the real CLI inherits `HOME`, and the CLI reads and writes
 * `$HOME/.deskuptime/state.json`. Three of the 34 test files never set a `HOME`
 * of their own, and the suite as a whole was measured creating a state file
 * and a history file from nothing in whatever `HOME` it was given — one of the
 * runs also wrote `http://kunde.dk/` into it.
 *
 * So the guard does not live in 34 files, where one forgotten line reopens it.
 * It lives here: the whole suite starts under one throwaway HOME, and the real
 * `~/.deskuptime/state.json` is stat'ed before and after so the guarantee is
 * *verified* rather than assumed. `test/isolation.test.js` is the second lock
 * — it fails if this runner was bypassed.
 *
 * Usage:
 *   node tools/run-tests.mjs                 # every test file
 *   node tools/run-tests.mjs test/foo.js …   # a subset (CI does this on Windows)
 *
 * `DU_KEEP_TEST_HOME=1` keeps the throwaway HOME and prints its path.
 */

import { spawn } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTempHome } from '../test/helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

/**
 * The suite, from the directory rather than from a list in `package.json`: a new
 * test file is then part of the gate by existing, not by being remembered in a
 * second place that can drift. `test/test.js` predates the `.test.js` suffix
 * and is still part of the suite.
 */
function allTestFiles() {
  const suffixed = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .sort();
  return ['test.js', ...suffixed].map((name) => join('test', name));
}

/** Metadata only — never the contents. A developer's state file is not read. */
function realStateStamp() {
  try {
    const s = statSync(join(homedir(), '.deskuptime', 'state.json'));
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    // No file, or a directory we may not read (this has happened here). Either
    // way there is nothing to compare against, and the second lock — the
    // isolation test — does not need access to the real home to do its job.
    return null;
  }
}

async function main() {
  const files = process.argv.slice(2);
  const suite = files.length > 0 ? files : allTestFiles();
  const home = join(tmpdir(), `deskuptime-suite-${process.pid}-${Date.now().toString(36)}`);

  if (!isTempHome(home)) {
    console.error(`refusing to run: the throwaway HOME is not a temp directory (${home})`);
    process.exit(1);
  }

  const before = realStateStamp();
  const child = spawn(process.execPath, ['--test', ...suite], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  const code = await new Promise((done) => child.on('exit', done));

  const after = realStateStamp();
  const moved = before !== null && after !== null && before !== after;
  if (moved) {
    console.error(
      `\n✖ the suite changed ~/.deskuptime/state.json on this machine ` +
      `(${before} → ${after}). A test is running the CLI without a throwaway HOME; ` +
      `the state file of whoever ran it must never be measured or written.`,
    );
  }

  if (code === 0 && !moved && !process.env.DU_KEEP_TEST_HOME) {
    // Only a green run tidies up after itself: a failure keeps the HOME so the
    // state a test wrote can be read.
    rmSync(home, { recursive: true, force: true });
  } else {
    console.log(`\nsuite HOME kept at ${home}`);
  }

  process.exit(code === 0 && !moved ? 0 : 1);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
