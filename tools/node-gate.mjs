/**
 * node-gate.mjs — the one place that answers "may this suite run on this Node?"
 *
 * **Measured 2026-09-27, nothing stubbed.** The `node` first on PATH on the
 * development machine is v22.23.2 (`/opt/homebrew/opt/node@22/bin/node`).
 * `package.json` has required `>=24` since the first release, and `.nvmrc` says
 * `24`, so the full suite came back **615/635 — 20 failures** on a clean `main`.
 * All twenty are one line: `tools/install.sh` and `action.yml` both check the
 * major and refuse to run, so the tests that drive them get nothing but
 * `Node.js 24+ is required`. Not one is a bug in the code. Node **26.7.0** is
 * installed at `/opt/homebrew/bin/node` and simply is not first on PATH.
 *
 * That is the same trap the project guidelines describe for jordemoderstudy on
 * 23 August, turned around: there the build server was too old and it broke at
 * deploy; here the *author's own machine* is too old and it breaks at the gate,
 * where it reads as 20 defects and invites a "fix" that changes nothing.
 *
 * So the gate is explicit about its own runtime, and the runner acts on the
 * answer rather than printing twenty red lines:
 *
 *   - a Node that satisfies `engines` runs the suite exactly as before — no
 *     extra process, no lookup, so CI is untouched;
 *   - a Node that does not is re-executed under one that does, **with its
 *     directory prepended to `PATH`**, because the tests that fail run
 *     `install.sh` and `action.yml` in a shell that resolves `node` from
 *     `PATH`, not from `process.execPath` (measured: `test/status.test.js`
 *     passes `...process.env` to `bash -c`, `test/install.test.js` prepends
 *     `dirname(process.execPath)`). Switching the runner alone leaves 13 of the
 *     20 failures standing;
 *   - with no usable Node anywhere, one message names the version, the
 *     requirement and the fix, and the suite does not start.
 *
 * The required major is **read from `package.json`, never written here.** It is
 * already the owner: `test/install.test.js` locks `install.sh` against it. This
 * module removes the temptation to add a sixth copy of the number, and
 * `test/nodegate.test.js` locks the four files that still spell it out.
 *
 * Usage (all of it is pure; the runner owns the spawning):
 *   requiredNodeMajor(pkg)                     → 24
 *   nodeSatisfies('v22.23.2', 24)              → false
 *   candidateNodePaths({ env, platform })      → ['/opt/homebrew/bin/node', …]
 *   pickSatisfyingNode(paths, 24, probe)       → '/opt/homebrew/bin/node'
 *   unusableNodeMessage({ version, required }) → one string
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The major a Node reports, or `null` when it reports something unreadable. */
export function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * The required major, from `engines.node`. Only a *lower* bound is read, and
 * that is deliberate: `>=24` and `>=24 <25` both mean "24 will do", and a range
 * whose minimum cannot be read (`24.x`, `^24.0.0`, `latest`, no `engines` at
 * all) is a bug in package.json — so it fails here, loudly at the gate, instead
 * of being read as "anything goes".
 */
export function requiredNodeMajor(pkg) {
  const range = String(pkg?.engines?.node ?? '').trim();
  const match = /^>=\s*(\d+)/.exec(range);
  if (!match) {
    throw new Error(
      `package.json has no "engines.node" range starting with a lower bound (">=<major>") to ` +
      `read a required Node from (found ${JSON.stringify(range)}). The gate cannot know which ` +
      `Node this project supports, and the installer and the GitHub Action both check it.`,
    );
  }
  return Number(match[1]);
}

/** Does this running Node satisfy the requirement? */
export function nodeSatisfies(version, required) {
  const major = nodeMajor(version);
  return major !== null && major >= required;
}

/**
 * Every Node binary this machine might be hiding, in a fixed order.
 *
 * Read-only discovery: nothing is executed and nothing outside the paths below
 * is touched. `env` and `platform` are parameters so a test can hand this a
 * machine that is not this one — the alternative, a test that installs a second
 * Node, is a test nobody runs.
 */
export function candidateNodePaths({ env = {}, platform = process.platform } = {}) {
  const home = env.HOME || env.USERPROFILE || homedir();
  // The suite also runs on windows-latest, where a Node binary is `node.exe`.
  const exe = platform === 'win32' ? '.exe' : '';
  const nodeBin = (dir) => join(dir, `node${exe}`);

  // Directories that hold one folder per installed version, each with a Node
  // inside. The suffix is part of the entry because the version managers do not
  // agree on the depth: nvm and mise use `24.11.0/bin/node`, fnm nests the
  // install under `24.9.0/installation/bin/node`. Homebrew installs side by
  // side and links only one into bin, so the versioned kegs are listed too.
  const parents = [
    [join(env.NVM_DIR || join(home, '.nvm'), 'versions/node'), 'bin'],
    [join(home, '.fnm/node-versions'), join('installation', 'bin')],
    [join(home, '.local/share/mise/installs/node'), 'bin'],
    [join(home, '.volta/tools/image/node'), 'bin'],
    [join(home, '.asdf/installs/nodejs'), 'bin'],
    [join(home, '.local/share/n/versions/node'), 'bin'],
    [join(home, '.n/versions/node'), 'bin'],
    ['/opt/homebrew/opt', 'bin'],
    ['/usr/local/opt', 'bin'],
  ];

  // Binaries that sit at a fixed path instead of in a version folder. The
  // override is an explicit answer from whoever runs the suite, so it leads.
  const direct = [
    env.DESKUPTIME_NODE,
    `/opt/homebrew/bin/node${exe}`,
    `/usr/local/bin/node${exe}`,
  ];

  const found = [];
  const add = (path) => {
    if (path && !found.includes(path)) found.push(path);
  };

  for (const path of direct) add(path);

  for (const parent of parents) {
    const [dir, suffix] = parent;
    let entries;
    try {
      entries = readdirSync(dir).sort();
    } catch {
      // Not installed, or not readable. Both are the common case, not an error.
      continue;
    }
    for (const entry of entries) {
      // `node`, `node@26` (homebrew) or `24.11.0` / `v24.11.0` (nvm, mise).
      // A version shape, not a leading digit: `/opt/homebrew/opt/0mq` is a keg
      // like any other and is not a Node install.
      if (entry === 'node' || entry.startsWith('node@') || /^v?\d+\.\d+/.test(entry)) {
        add(nodeBin(join(dir, entry, suffix)));
      }
    }
  }

  return found;
}

/**
 * The highest Node on the list that satisfies the requirement, measured by
 * asking each candidate — never guessed from its directory name, because
 * `node@22` and `node` are both perfectly capable of disagreeing with their
 * own folder.
 *
 * `probe` is the single seam: it answers "which major does this path run, if
 * it runs at all", and `null` for a path that is missing, not executable, not
 * a Node, or built for another platform. The default runs the binary. A test
 * passes its own, so the selection rule is verifiable without installing a
 * second Node.
 */
export function pickSatisfyingNode(paths, required, probe = defaultProbe) {
  const usable = [];
  for (const path of paths) {
    const major = probe(path);
    if (major !== null && major >= required) usable.push({ path, major });
  }
  // Highest first: the newest supported Node is the closest to what a user of
  // the published CLI is running, and it is deterministic when two match.
  usable.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path));
  return usable.length > 0 ? usable[0].path : null;
}

function defaultProbe(path) {
  try {
    return nodeMajor(
      execFileSync(path, ['-p', 'process.versions.node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }),
    );
  } catch {
    // Missing, not executable, not a Node, or a dylib that cannot load. All
    // four are the same answer, and all four are common in these directories.
    return null;
  }
}

/**
 * One message for "this Node cannot run the gate", replacing twenty failures
 * that each said `Node.js 24+ is required` without saying whose Node was too
 * old or what to do about it.
 */
export function unusableNodeMessage({ version, required }) {
  return [
    `This project needs Node.js ${required}+ (package.json engines, .nvmrc) and this machine ` +
    `is running ${version}.`,
    `The suite is not started: the installer (tools/install.sh) and the ` +
    `GitHub Action (action.yml) both refuse to run on an older Node, so every test that drives ` +
    `them would fail with "Node.js ${required}+ is required" — a gate that is red for a reason ` +
    `that is not a defect in the code.`,
    `Fix it with any one of:  nvm install ${required} && nvm use ${required}   |   ` +
    `brew install node@${required}   |   mise use node@${required}   |   ` +
    `DESKUPTIME_NODE=/path/to/node${required} npm test`,
  ].join('\n');
}

/**
 * `true` when this suite is allowed to switch Node for itself. Without the
 * guard, a machine whose *newest* Node is still too old would find it, switch
 * to it, discover the same thing and start over — the version managers that
 * keep old versions around make that a normal machine, not an exotic one.
 */
export function maySwitchNode(env = {}) {
  return env.DESKUPTIME_NODE_SWITCHED !== '1';
}
