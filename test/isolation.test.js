/**
 * P1-58 — the suite must not be able to touch the state file of whoever runs it.
 *
 * The CLI keeps its monitoring state in `$HOME/.deskuptime/state.json` and
 * `watch --once` rewrites the file it reads, so a test that runs the CLI with
 * the ambient `HOME` overwrites the real thing. It is not a hypothetical:
 * on 2026-09-27 one test did exactly that (❓ 15), and the measurement behind
 * this task found the suite writing a fixture URL — with `transitionAlerts`,
 * `transitions` and `sslExpiredWarned` — into whatever `HOME` it was given, and
 * creating `state.json` plus `history.json` from nothing when that `HOME` was
 * empty.
 *
 * These tests are the lock, not a description of one. The first fails if
 * somebody runs `node --test` by hand instead of `npm test`, because the suite
 * is then no longer under the throwaway HOME `tools/run-tests.mjs` sets. The
 * rest pin the rule itself, so the check cannot be satisfied by a prefix
 * comparison, by a `HOME` that merely looks temporary, or by quietly removing
 * the runner from `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTempHome, effectiveHome, isTempHome, tempHome } from './helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A home directory that cannot be a temp directory on any platform. It is a
 * stand-in rather than the machine's real one on purpose: `os.homedir()` reads
 * `$HOME`, so inside a correctly isolated suite it *is* the throwaway directory
 * (see the test below), and the real home is not addressable from in here at
 * all — which is the property this whole file is protecting.
 */
const SOMEONE_ELSES_HOME = process.platform === 'win32'
  ? 'C:\\Users\\deskuptime-someone-else'
  : '/Users/deskuptime-someone-else';

/**
 * The variable `os.homedir()` actually reads — `USERPROFILE` on Windows, `HOME`
 * everywhere else. Measured on the Windows runner, where overriding only `HOME`
 * left the fallback pointing at the throwaway directory and this file's claim
 * below was false for exactly the platform that needs it most: the fallback
 * decides where a *test* would write, and on Windows that is `USERPROFILE`.
 */
const HOMEDIR_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

test('the suite itself runs under a throwaway HOME', () => {
  // This is the lock, not a comment about it. `tools/run-tests.mjs` starts the
  // whole suite with HOME/USERPROFILE pointing at a temp directory; running
  // `node --test test/…` by hand skips that, and this assertion is what turns
  // the bypass into a red gate instead of a write to the real state file.
  assert.ok(
    isTempHome(process.env.HOME),
    `the suite must run under a throwaway HOME (got ${JSON.stringify(process.env.HOME)}). ` +
    'Run the tests through `npm test`, not `node --test` — the runner owns the HOME lock.',
  );
  assert.ok(
    isTempHome(process.env.USERPROFILE),
    `and on Windows this is the variable that decides it (got ${JSON.stringify(process.env.USERPROFILE)})`,
  );
});

test('os.homedir() follows $HOME, so an isolated suite cannot even name the real home', () => {
  // Measured while writing this file: the first version used `homedir()` as
  // "the real HOME" and every assertion passed against the throwaway
  // directory — a lock that cannot be tested because it cannot fail. Node
  // resolves `os.homedir()` from `$HOME` on POSIX, so once the suite is
  // isolated the real home is unreachable from inside it, by env or by API.
  assert.equal(homedir(), process.env.HOME, 'homedir() is the runner\'s HOME, not the passwd entry');
  assert.ok(isTempHome(homedir()));
});

test('a CLI call with somebody else\'s HOME is refused before anything is spawned', () => {
  // No child process is started here on purpose: the refusal is the claim, and
  // a lock that only fails *after* the CLI has written is not a lock.
  assert.throws(() => assertTempHome({ HOME: SOMEONE_ELSES_HOME, USERPROFILE: SOMEONE_ELSES_HOME }), /must not run the CLI outside a temp HOME/);
  assert.throws(() => assertTempHome({ HOME: SOMEONE_ELSES_HOME }), /must not run the CLI outside a temp HOME/);
  assert.throws(() => assertTempHome({ HOME: join(SOMEONE_ELSES_HOME, '.deskuptime', '..') }), /must not run the CLI outside a temp HOME/);
});

test('no HOME at all is refused, because the CLI then falls back to the real one', () => {
  // `getStateFile()` reads `env.HOME` and falls back to `os.homedir()`. An env
  // that forgot to set it is not a neutral env — it is the developer's home
  // with an extra step, and `env: {}` looks innocent.
  //
  // Measured while writing this: inside a correctly isolated suite `env: {}` is
  // in fact harmless, because `homedir()` is the throwaway directory. The
  // fallback only reaches a real home when the suite is run outside the runner,
  // which is what the first test forbids — so the branch is exercised here by
  // pointing the ambient HOME at a real-looking path for the length of the call.
  assert.equal(effectiveHome({}), homedir());
  assert.doesNotThrow(() => assertTempHome({}), 'inside the runner, the fallback is the suite\'s own home');

  const real = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = SOMEONE_ELSES_HOME;
  process.env.USERPROFILE = SOMEONE_ELSES_HOME;
  try {
    assert.equal(effectiveHome({}), SOMEONE_ELSES_HOME, `the fallback follows $${HOMEDIR_VAR}, which is the point`);
    assert.throws(() => assertTempHome({}), /no HOME is set/);
    assert.throws(() => assertTempHome(undefined), /no HOME is set/);
  } finally {
    process.env.HOME = real;
    process.env.USERPROFILE = realProfile;
  }
  assert.ok(isTempHome(process.env.HOME), 'and the suite is still isolated afterwards');
});

test('a partly-overridden env is refused, because Windows reads the other one', () => {
  // `getStateFile()` prefers `USERPROFILE` on win32. A test that sets only HOME
  // is safe on macOS and writes the real state file on Windows — so both have
  // to be temporary, whatever this machine happens to be.
  assert.throws(() => assertTempHome({ HOME: tmpdir(), USERPROFILE: SOMEONE_ELSES_HOME }), /USERPROFILE/);
});

test('a path that only looks temporary is refused', () => {
  // The cheap version of this check is `home.startsWith(tmpdir())`, and it
  // accepts `<tmpdir>/../../../Users/someone` — a traversal out of the temp
  // directory and into a real home, through the guard written to keep tests
  // out of it. `path.join()` cannot build that fixture, because it resolves
  // the `..` away before the guard ever sees it.
  const escape = `${tmpdir()}${sep}..${sep}..${sep}..${sep}Users${sep}someone${sep}.deskuptime`;
  assert.ok(escape.includes(`..${sep}`), 'the fixture really is a traversal, not a temp path');
  assert.equal(isTempHome(escape), false, 'a traversal out of tmpdir is not a temp directory');
  assert.equal(isTempHome(`${tmpdir()}${sep}ok`), true);
  assert.equal(isTempHome(tmpdir()), true);
  // `'/tmp'` cannot be in this list: on Linux `tmpdir()` *is* `/tmp`, so the
  // two lines above and a hardcoded `'/tmp'` contradict each other and the
  // suite fails there for being right. Measured on the Linux runner, where
  // that was the whole of this test's output. A real home is not a temp
  // directory on any platform, and this file already carries one.
  for (const notAHome of [undefined, null, '', 42, {}, 'relative/path', SOMEONE_ELSES_HOME]) {
    assert.equal(isTempHome(notAHome), false, `${JSON.stringify(notAHome)} is not a temp directory`);
  }
});

test('the factory hands out a HOME the lock accepts', (t) => {
  const { home, options, dir } = tempHome(t, 'deskuptime-isolation-');
  assert.equal(isTempHome(home), true);
  assert.equal(options.HOME, home);
  assert.equal(options.USERPROFILE, home, 'Windows reads this one');
  assert.ok(existsSync(join(dir, '')), 'the .deskuptime folder is there, so a test does not have to make it');
  assert.equal(assertTempHome(options), home, 'and the lock lets it through');
});

test('the check has no side effects on the directory it judges', () => {
  // The lock is a check, not a migration: passing a temp path must not create
  // it, and rejecting one must not either. A guard that made the directory it
  // inspected would be able to create the very state file it exists to keep
  // tests away from.
  const absent = join(tmpdir(), `deskuptime-never-made-${process.pid}`);
  assert.equal(existsSync(absent), false);
  assert.equal(assertTempHome({ HOME: absent, USERPROFILE: absent }), absent, 'a temp path is accepted');
  assert.equal(existsSync(absent), false, 'accepting one must not create it');
  assert.throws(() => assertTempHome({ HOME: SOMEONE_ELSES_HOME }));
  assert.equal(existsSync(join(SOMEONE_ELSES_HOME, '.deskuptime')), false, 'and rejecting one must not either');
});

test('npm test still goes through the runner that owns the lock', () => {
  // A lock that can be removed by editing one line of package.json is worth
  // less than it looks, so the wiring is itself pinned. The first test above
  // catches a *bypassed* runner; this one catches a *deleted* one.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node tools/run-tests.mjs', 'npm test must not call `node --test` directly');
  assert.ok(existsSync(join(ROOT, 'tools', 'run-tests.mjs')), 'the runner exists');
  const runner = readFileSync(join(ROOT, 'tools', 'run-tests.mjs'), 'utf8');
  assert.match(runner, /USERPROFILE: home/, 'and it sets both variables the CLI reads');
  // P1-115 — the fourth lock: the suite must not write into the repo it runs
  // from. It is pinned here for the same reason the runner is pinned above —
  // a lock that one deleted `const` removes is worth less than it looks.
  assert.match(runner, /repoTreeStamp/, 'the runner also compares the repo tree before and after');
});

test('the state file this suite writes is the suite\'s own', () => {
  // The consequence of the runner's lock, stated as an observation: whatever
  // `watch --once` writes while these tests run lands in the throwaway HOME.
  // If that ever stops being true, the real `~/.deskuptime` is being measured
  // and rewritten again — which is the accident from 2026-09-27.
  const state = join(process.env.HOME, '.deskuptime', 'state.json');
  const real = join(SOMEONE_ELSES_HOME, '.deskuptime', 'state.json');
  const touched = existsSync(state) ? statSync(state).mtimeMs : null;
  assert.notEqual(state, real);
  assert.ok(isTempHome(join(process.env.HOME, '.deskuptime')));
  // P1-116 — this was `touched === null || typeof touched === 'number'`, which
  // is what the line above always produces, so it could not fail. The real
  // claim is directional: the real home is never the one measured, and whatever
  // was touched belongs to the throwaway home — not merely to *some* directory.
  assert.ok(
    touched === null || isTempHome(dirname(state)),
    'a state file was written outside the throwaway home',
  );
});

/**
 * P1-115 — a home variable in a test file whose value is not a path.
 *
 * Measured: `test/unwatchpartial.test.js` passed `HOME: { …process.env, HOME: home }`.
 * Node stringifies an env value, so the CLI ran with `HOME=[object Object]` — a
 * *relative* path — and created `[object Object]/.deskuptime` in `cwd`, which is
 * the repo root. Every assertion in that test still passed, because an empty
 * state file says "not monitored" about every address. The runner's tree check
 * above catches the consequence; this catches the cause, so a test that tidies
 * up after itself cannot reopen it.
 *
 * Only the values that are statically decidable as "not a path" are listed. A
 * call (`HOME: mkdtempSync(…)`) returns a string and is left alone — a scanner
 * that could not tell would have to be a type checker.
 */
/**
 * Strip comments and string literals, so this file's own fixtures and the
 * header that quotes the bug are not reported back as findings. Same reason
 * `test/floatingspawn.test.js` skips both.
 */
function codeOnly(src) {
  // Quotes come *first* in the alternation, so a literal that opens with `//` or
  // `/*` is a literal and not a comment — the order costs a limitation instead:
  // an apostrophe in a `//` comment can start a literal that never closes, so
  // literals are not allowed to span lines. A home variable that needs two lines
  // to say is not a shape worth catching here.
  const skip = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\\n])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  return src.replace(skip, (match) => (match.includes('\n') ? '\n' : ' '));
}

function nonPathHomes(src) {
  const hits = [];
  for (const m of codeOnly(src).matchAll(/\b(HOME|USERPROFILE)\s*:\s*([^\n,}]+)/g)) {
    const value = m[2].trim();
    if (/^[{[\d]|^(null|true|false)\b/.test(value)) hits.push(`${m[1]}: ${value}`);
  }
  return hits;
}

test('no test file hands the CLI a HOME that is not a path', () => {
  const offenders = [];
  for (const name of readdirSync(join(ROOT, 'test')).filter((n) => n.endsWith('.js'))) {
    for (const hit of nonPathHomes(readFileSync(join(ROOT, 'test', name), 'utf8'))) {
      offenders.push(`${name}  ${hit}`);
    }
  }
  assert.deepEqual(offenders, [], `Node stringifies et env-værdi, så en ikke-streng HOME bliver en relativ mappe i cwd:\n${offenders.join('\n')}`);

  // The scanner recognises its own error, or "found nothing" and "is broken"
  // look the same from the outside.
  assert.deepEqual(
    nonPathHomes("const a = { HOME: { ...process.env, HOME: home } };"),
    ['HOME: { ...process.env'],
    'the object literal that caused this must be reported',
  );
  assert.deepEqual(
    nonPathHomes("const b = { HOME: home, USERPROFILE: home };"),
    [],
    'a real temp path is left alone',
  );
  // This file quotes the bug in a comment and in two strings, and those must
  // not come back as findings — the lock would otherwise be unsatisfiable.
  assert.deepEqual(
    nonPathHomes("// HOME: { …process.env, HOME: home }\nconst c = { USERPROFILE: null };"),
    ['USERPROFILE: null'],
    'comments and strings are skipped, real code is not',
  );
});
