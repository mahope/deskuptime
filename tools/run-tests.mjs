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
 *
 * P1-75 — this is also where the gate decides whether it may run at all. The
 * `node` first on PATH was measured at v22.23.2 on a machine with v26.7.0
 * installed, and a Node below `engines` used to return 20 failures, every one
 * of them the installer or the Action refusing to run. `tools/node-gate.mjs`
 * owns that decision; here it is acted on: switch to a Node that satisfies
 * `engines`, or say once why the suite does not start.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTempHome } from '../test/helpers/env.mjs';
import {
  candidateNodePaths,
  maySwitchNode,
  nodeSatisfies,
  pickSatisfyingNode,
  requiredNodeMajor,
  unusableNodeMessage,
} from './node-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

/**
 * Run the suite under a Node that satisfies `engines`, or explain that it
 * cannot. Returns the exit code when the suite must not start, and `null` when
 * it may — the caller owns every process after that.
 *
 * The switch prepends the chosen Node's directory to `PATH`, and that is the
 * load-bearing half: the 20 measured failures come from tests that run
 * `tools/install.sh` and `action.yml` in a shell, and a shell resolves `node`
 * from `PATH` rather than from `process.execPath`. Re-executing this runner
 * alone would have left 13 of them failing.
 */
function resolveRuntime() {
  const required = requiredNodeMajor(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')));
  if (nodeSatisfies(process.versions.node, required)) return null;

  if (!maySwitchNode(process.env)) {
    console.error(unusableNodeMessage({ version: process.version, required }));
    console.error(
      '(Already switched once, and this is still the same result — so there is no newer ' +
      'Node on this machine. Set DESKUPTIME_NODE to a working one.)',
    );
    return 1;
  }

  const chosen = pickSatisfyingNode(candidateNodePaths({ env: process.env }), required);
  if (!chosen) {
    console.error(unusableNodeMessage({ version: process.version, required }));
    return 1;
  }

  // Announced, never silent: a gate that quietly runs on a different runtime
  // than the one that started it is a gate nobody can reason about.
  console.log(
    `node ${process.version} is older than this project requires (>=${required}); ` +
    `running the suite under ${chosen} instead.`,
  );

  const child = spawnSync(chosen, process.argv.slice(1), {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DESKUPTIME_NODE_SWITCHED: '1',
      PATH: `${dirname(chosen)}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  if (child.error) {
    console.error(`found ${chosen} but could not run it: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

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
  const refused = resolveRuntime();
  if (refused !== null) process.exit(refused);

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
