/**
 * P1-75 — the gate may not be red for a reason that is not a defect.
 *
 * **Measured 2026-09-27 on a clean `main`, nothing stubbed.** The `node` first
 * on PATH was v22.23.2; Node 26.7.0 was installed and not on PATH. The suite
 * came back **615/635 — 20 failures**, and all twenty were the same line:
 * `tools/install.sh` and `action.yml` check the major and refuse to run, so
 * the 7 installer tests and the 13 Action tests got `Node.js 24+ is required`
 * and nothing else. The same suite on 26.7.0: 635/635.
 *
 * That is the jordemoderstudy trap of 23 August, turned around — there the
 * build server was too old and it broke at deploy, here the author's own
 * machine is too old and it breaks at the gate, where twenty red lines read as
 * twenty defects and invite a "fix" that changes nothing.
 *
 * Two locks, one per reason the mess could exist:
 *
 *   1. `tools/node-gate.mjs` decides, and the runner acts on it: switch to a
 *      Node that satisfies `engines`, or say once why the suite does not start.
 *      What is tested here is the *decision* — the pure functions — because the
 *      alternative, a test that installs a second Node, is a test nobody runs.
 *   2. "Which Node does this project support" was written in six places and
 *      locked in one pair. The second test below locks all six together, so the
 *      class dies instead of this instance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  candidateNodePaths,
  maySwitchNode,
  nodeMajor,
  nodeSatisfies,
  pickSatisfyingNode,
  requiredNodeMajor,
  unusableNodeMessage,
} from '../tools/node-gate.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const REQUIRED = requiredNodeMajor(PKG);

test('kravet læses i package.json, og en Node under det kan ikke køre gaten', () => {
  assert.equal(REQUIRED, 24);
  assert.equal(nodeSatisfies('v24.0.0', REQUIRED), true);
  assert.equal(nodeSatisfies('v26.7.0', REQUIRED), true);
  assert.equal(nodeSatisfies('v22.23.2', REQUIRED), false);
  assert.equal(nodeSatisfies('v23.11.0', REQUIRED), false);
});

test('den Node der må køre gaten lige nu, er den der faktisk kører den', () => {
  // The runner switches instead of failing, so on a machine where it did not,
  // this test file is running on a supported Node — and says so rather than
  // trusting engines. It is the one assertion in the suite that cannot be
  // faked by a stub, because it reads this process.
  assert.equal(
    nodeSatisfies(process.versions.node, REQUIRED),
    true,
    `the suite is running on ${process.version}, which is below the required >=${REQUIRED}`,
  );
});

test('et engines-range uden en nedre grænse er en fejl, ikke "alt er tilladt"', () => {
  // Only a lower bound is read, so `>=24 <25` is 24 — the same promise. A
  // range that never states one cannot be read as a promise at all, and
  // defaulting to "anything runs" is how a gate stops meaning anything.
  for (const range of [undefined, '', '24.x', '^24.0.0', 'latest', '24']) {
    assert.throws(
      () => requiredNodeMajor({ engines: { node: range } }),
      /engines\.node/,
      `range ${JSON.stringify(range)} should not be readable as a major`,
    );
  }
  assert.equal(requiredNodeMajor({ engines: { node: '>= 24' } }), 24);
  assert.equal(requiredNodeMajor({ engines: { node: '>=24 <25' } }), 24);
});

test('en Node der ikke svarer, kan ikke regnes for at overholde kravet', () => {
  for (const version of [null, undefined, '', 'not-a-version', 'v', 24]) {
    assert.equal(nodeSatisfies(version, REQUIRED), false, `${JSON.stringify(version)} is not a Node`);
  }
  assert.equal(nodeMajor('v26.7.0'), 26);
  assert.equal(nodeMajor('26.7.0'), 26);
  assert.equal(nodeMajor('nonsense'), null);
});

test('de steder der efterspørges, dækker de versionstyrere der findes', () => {
  // A fake machine: real directories with no Node in them, so discovery can be
  // verified without a second installation and without reading the real home.
  const home = mkdtempSync(join(tmpdir(), 'du-nodegate-'));
  try {
    for (const rel of [
      '.nvm/versions/node/v24.11.0/bin',
      '.nvm/versions/node/v22.23.2/bin',
      '.fnm/node-versions/v24.9.0/installation/bin',
      '.local/share/mise/installs/node/26.7.0/bin',
      '.volta/tools/image/node/24.1.1/bin',
      '.asdf/installs/nodejs/24.5.0/bin',
    ]) {
      mkdirSync(join(home, rel), { recursive: true });
    }
    // A version manager's cache of downloads is not an install.
    mkdirSync(join(home, '.nvm/.cache/bin'), { recursive: true });

    const found = candidateNodePaths({ env: { HOME: home, NVM_DIR: join(home, '.nvm') }, platform: 'linux' });
    for (const expected of [
      join(home, '.nvm/versions/node/v24.11.0/bin/node'),
      join(home, '.nvm/versions/node/v22.23.2/bin/node'),
      join(home, '.fnm/node-versions/v24.9.0/installation/bin/node'),
      join(home, '.local/share/mise/installs/node/26.7.0/bin/node'),
      join(home, '.volta/tools/image/node/24.1.1/bin/node'),
      join(home, '.asdf/installs/nodejs/24.5.0/bin/node'),
    ]) {
      assert.ok(found.includes(expected), `expected ${expected} to be looked for`);
    }
    assert.ok(!found.includes(join(home, '.nvm/.cache/bin/node')));
    // nvm's own directory, when NVM_DIR says so, is where the versions live.
    assert.ok(
      candidateNodePaths({ env: { HOME: '/nowhere', NVM_DIR: join(home, '.nvm') }, platform: 'linux' })
        .includes(join(home, '.nvm/versions/node/v24.11.0/bin/node')),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('på Windows leder den efter node.exe, ikke node', () => {
  const found = candidateNodePaths({ env: { HOME: 'C:\\nowhere' }, platform: 'win32' });
  assert.ok(found.length > 0, 'the fixed bin paths are looked for on win32 too');
  assert.ok(found.every((path) => !path.endsWith('node')), `win32 candidates: ${found.join(', ')}`);
  assert.ok(found.includes('/opt/homebrew/bin/node.exe'));
});

test('det er den højeste Node der overholder kravet, der kører gaten', () => {
  const picked = pickSatisfyingNode(
    ['/fake/node24', '/fake/node22', '/fake/node26', '/fake/node28'],
    REQUIRED,
    (path) => ({ '/fake/node22': 22, '/fake/node24': 24, '/fake/node26': 26, '/fake/node28': 28 })[path],
  );
  assert.equal(picked, '/fake/node28');
});

test('den valgte Node måles, ikke gættet ud fra mappenavnet', () => {
  // The whole reason `probe` exists: a directory called node@22 holding a Node
  // 26 must not be believed. A stub that lies about the name and tells the
  // truth about the binary is exactly the machine this defends against.
  assert.equal(
    pickSatisfyingNode(['/opt/liar/node@22'], REQUIRED, () => 26),
    '/opt/liar/node@22',
  );
  assert.equal(pickSatisfyingNode(['/opt/liar/node@26'], REQUIRED, () => 22), null);
});

test('en Node der ikke kan starte, er ikke et kandidat', () => {
  assert.equal(pickSatisfyingNode(['/fake/node24'], REQUIRED, () => 22), null);
  assert.equal(pickSatisfyingNode(['/fake/node24'], REQUIRED, () => null), null);
  assert.equal(pickSatisfyingNode([], REQUIRED, () => 26), null);
  // The real probe, on a path that cannot run: a version manager's download
  // cache and every absent version answer exactly this way, and a list can
  // name hundreds of them.
  assert.equal(pickSatisfyingNode(['/definitely/not/here/node'], REQUIRED), null);
});

test('den virkelige maskine har den Node, der blev valgt — målt ved at køre den', () => {
  // The default probe is the only one that runs a binary, so this is the test
  // that cannot be stubbed. A real executable reports its real major, and a
  // real file without the execute bit reports nothing at all — which is what
  // every version manager's download cache and every `node` symlink loop
  // looks like from here.
  const home = mkdtempSync(join(tmpdir(), 'du-nodegate-real-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const shim = join(bin, 'node');
    writeFileSync(shim, '#!/bin/sh\necho v26.7.0\n');
    const notExecutable = join(bin, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\necho v26.7.0\n');
    chmodSync(shim, 0o755);

    const found = candidateNodePaths({ env: { HOME: home, DESKUPTIME_NODE: shim }, platform: 'linux' });
    assert.equal(found[0], shim, 'the override leads the list');
    assert.equal(pickSatisfyingNode([shim], REQUIRED), shim);
    assert.equal(pickSatisfyingNode([shim], 27), null, '26.7.0 does not satisfy 27');
    assert.equal(
      pickSatisfyingNode([notExecutable], REQUIRED),
      null,
      'a file without the execute bit is not a Node, however well it reports itself',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('gaten skifter Node højst én gang, så en gammel maskine ikke kan løbe i cirkel', () => {
  // The machine that keeps every version a version manager ever installed is
  // an ordinary machine, not an exotic one. Without this guard, "find the
  // newest Node" finds the same too-old Node and starts over forever.
  assert.equal(maySwitchNode({}), true);
  assert.equal(maySwitchNode({ DESKUPTIME_NODE_SWITCHED: '0' }), true);
  assert.equal(maySwitchNode({ DESKUPTIME_NODE_SWITCHED: '1' }), false);
});

test('en for gammel Node får én besked, der siger hvad der sker og hvad der gør', () => {
  const message = unusableNodeMessage({ version: 'v22.23.2', required: REQUIRED });
  assert.match(message, /v22\.23\.2/, 'the message names the Node that is running');
  assert.match(message, /24\+/, 'the message names the requirement');
  assert.match(message, /install\.sh/, 'the message names what refuses to run, not 20 red lines');
  assert.match(message, /action\.yml/);
  assert.match(message, /not a defect in the code/, 'the message says why this is not 20 bugs');
  for (const fix of ['nvm install 24', 'brew install node@24', 'DESKUPTIME_NODE=']) {
    assert.ok(message.includes(fix), `the message offers ${fix}`);
  }
  // One message, not twenty: the whole point is that it replaces them.
  assert.equal((message.match(/is required/g) ?? []).length, 1);
});

test('"hvilken Node" er ét tal med seks ejere, og de må ikke glide fra hinanden', () => {
  // The reason this iteration existed: `engines`, `.nvmrc`, `action.yml`,
  // `install.sh` and three CI workflows each spelled the major themselves, and
  // only `install.sh` was locked to `engines`. Raising the requirement to 26
  // would have left the Action demanding 24 and the workflows testing it.
  const sources = {
    '.nvmrc': readFileSync(join(ROOT, '.nvmrc'), 'utf8'),
    'action.yml': readFileSync(join(ROOT, 'action.yml'), 'utf8'),
    'tools/install.sh': readFileSync(join(ROOT, 'tools/install.sh'), 'utf8'),
  };

  assert.equal(Number(sources['.nvmrc'].trim()), REQUIRED, '.nvmrc disagrees with engines.node');
  assert.match(sources['action.yml'], new RegExp(`<\\s*${REQUIRED}\\b`), 'action.yml checks a different major');
  assert.match(
    sources['action.yml'],
    new RegExp(`Node\\.js ${REQUIRED}\\+ is required`),
    "action.yml's own error names a different major",
  );
  assert.match(
    sources['tools/install.sh'],
    new RegExp(`^REQUIRED_NODE_MAJOR=${REQUIRED}$`, 'm'),
    'install.sh requires a different major',
  );

  const workflows = [
    'ci.yml',
    'publish.yml',
    'release-cli.yml',
    'self-monitor.yml',
  ];
  for (const name of workflows) {
    const source = readFileSync(join(ROOT, '.github/workflows', name), 'utf8');
    // Either a literal `node-version: 24` or a matrix whose every entry is 24.
    const literals = [...source.matchAll(/node-version:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(literals.length > 0, `${name} never sets node-version`);
    for (const value of literals) {
      if (value.includes('${{')) {
        const matrix = /node:\s*\[([^\]]*)\]/.exec(source);
        assert.ok(matrix, `${name} uses a matrix but declares none`);
        for (const entry of matrix[1].split(',').map((s) => s.trim())) {
          assert.equal(Number(entry), REQUIRED, `${name} tests Node ${entry}, not ${REQUIRED}`);
        }
      } else {
        assert.equal(Number(value), REQUIRED, `${name} builds on Node ${value}, not ${REQUIRED}`);
      }
    }
  }
});

test('den PATH et skift rejser med rammer den Node der blev valgt', () => {
  // Measured, not assumed: the 20 failures come from tests that run
  // `install.sh` and `action.yml` in a shell, and a shell resolves `node` from
  // PATH — `test/status.test.js` passes `...process.env` to `bash -c` without
  // prepending `process.execPath`'s directory, which is why 13 of the 20
  // survived a runner-only switch. So the child must get the chosen Node's
  // directory first, and it must be locked here or it will be "optimised" away.
  const source = readFileSync(join(ROOT, 'tools/run-tests.mjs'), 'utf8');
  assert.match(
    source,
    /PATH: `\$\{dirname\(chosen\)\}\$\{delimiter\}\$\{process\.env\.PATH \?\? ''\}`/,
    'the child process must get the chosen Node first on PATH',
  );
  assert.match(
    source,
    /DESKUPTIME_NODE_SWITCHED: '1'/,
    'the child must be told the switch already happened, or it switches again',
  );
  assert.match(source, /stdout: 'inherit'|stdio: 'inherit'/, 'the child must write where npm can see it');
});
