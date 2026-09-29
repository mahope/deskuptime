/**
 * P1-112 — a floating spawn promise kills a whole test file and says nothing
 * about why.
 *
 * Two iterations (125 and 126) each lost a run to `test/tarball.test.js`
 * failing at *file* level with `test failed` and no reason, and neither could
 * reproduce it: four full gate runs and twelve targeted ones, all green. That
 * is the expensive part. The flake itself cost seconds; not being able to tell
 * where it came from cost an iteration, twice.
 *
 * The mechanism was measured, not guessed. A spawn whose promise is never
 * awaited is a floating promise, and if it rejects after the last test has
 * ended, Node's test runner reports it as asynchronous activity after the test
 * and kills the file:
 *
 *   ℹ Error: A resource generated asynchronous activity after the test ended.
 *     …which triggered an unhandledRejection event, caught by the test runner.
 *   ✖ test/zzcrashprobe.test.js (66.242541ms)
 *   ✖ failing tests:
 *   test at test/zzcrashprobe.test.js:1:1
 *   ✖ test/zzcrashprobe.test.js
 *     'test failed'
 *
 * The reason is on the scrollback, one screen above the block a person actually
 * reads, and it is attributed to no test — because no test failed. Every test in
 * the file passed. So the summary says `test failed`, names nothing, and the
 * next iteration has to go looking.
 *
 * `test/tarball.test.js` had exactly such a call: `run('mkdir', ['-p', …])`,
 * un-awaited, immediately before an awaited `tar -xzf … -C` into the same
 * directory. It is now awaited, and this file is the lock.
 *
 * The lock is a scan, and a scan that finds nothing is indistinguishable from a
 * scan that is broken — so `scanneren genkender sin egen fejl` below plants the
 * shapes in a synthetic source and requires the ones that float to be reported
 * and the ones that do not to be left alone. A scanner that stopped matching
 * would fail there, not silently pass the suite.
 *
 * Measured scope, so the lock is not oversold: it reads the files the suite
 * runs, and reports a spawn call that *starts a line* outside any parentheses.
 * A call in argument position (`Promise.all([run(…)])`, `assert.rejects(run(…))`)
 * is an argument, not a floating statement, and is left alone; a call sharing
 * a line with `{` is not seen. Synchronous spawns are excluded on purpose —
 * `execFileSync` returns no promise, so it cannot float, and six of them are
 * called this way in the suite today.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

/** The same list the suite runs, so the lock covers exactly what the gate runs. */
function suiteFiles() {
  return [
    'test.js',
    ...readdirSync(TEST_DIR)
      .filter((name) => name.endsWith('.test.js'))
      .sort(),
  ];
}

/**
 * The names in `src` that can start a child process without blocking.
 *
 * Taken from the file itself rather than from a fixed list, so a test that
 * imports a spawner under a new name is covered without editing the lock. A
 * name that is itself `promisify`'d — the shape most of these files use to get
 * their `run()` helper — inherits its spawner, so an alias is covered too.
 * `*Sync` is dropped: it returns no promise, so it cannot float.
 */
function spawnerNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'node:child_process'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name && !name.endsWith('Sync')) names.add(name);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*promisify\(\s*(\w+)\s*\)/g)) {
    if (names.has(m[2])) names.add(m[1]);
  }
  return names;
}

/**
 * The floating spawn calls in `src`, as `line: text`.
 *
 * A hit is a call to a spawner that starts a line of its own and is not inside
 * parentheses or brackets. Depth is counted for `(` and `[` only: braces are
 * how a bare statement gets *inside* a block (`if (!skip) {`), and counting
 * them would hide every call written that way. Comments and strings are
 * skipped so a spawner named in either is not mistaken for a call.
 */
export function findFloatingSpawns(src, names) {
  const hits = [];
  let depth = 0;
  let line = 1;
  let inString = null;
  let inComment = null;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (inComment === '//') {
      if (c === '\n') { inComment = null; line++; }
      continue;
    }
    if (inComment === '/*') {
      if (c === '*' && next === '/') { inComment = null; i++; } else if (c === '\n') line++;
      continue;
    }
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      else if (c === '\n') line++;
      continue;
    }
    if (c === '/' && next === '/') { inComment = '//'; i++; continue; }
    if (c === '/' && next === '*') { inComment = '/*'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '\n') { line++; continue; }
    if (c === '(' || c === '[') { depth++; continue; }
    if (c === ')' || c === ']') { depth--; continue; }
    if (depth !== 0) continue;

    for (const name of names) {
      if (!src.startsWith(`${name}(`, i)) continue;
      const lineStart = src.lastIndexOf('\n', i) + 1;
      if (src.slice(lineStart, i).trim() === '') {
        hits.push({ line, text: src.slice(i, src.indexOf('\n', i)).trim() });
      }
    }
  }
  return hits;
}

test('ingen testfil efterlader en spawn-promise flyvende', () => {
  const floating = [];
  for (const name of suiteFiles()) {
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    for (const hit of findFloatingSpawns(src, spawnerNames(src))) {
      floating.push(`${name}:${hit.line}  ${hit.text}`);
    }
  }
  assert.deepEqual(
    floating,
    [],
    `en spawn uden await dræber hele filen med "test failed" og uden årsag:\n${floating.join('\n')}`,
  );
});

test('scanneren genkender sin egen fejl', () => {
  // The names go through spawnerNames() rather than being handed over, so this
  // covers the half that matters most: execFileSync is imported here and must
  // still be dropped, because it returns no promise and cannot float.
  const source = [
    "import { execFile, execFileSync } from 'node:child_process';",
    "const run = promisify(execFile);",
    "run('mkdir', ['-p', DIR]);", // floats: no await, no assignment
    "await run('bash', ['-c', 'true']);", // awaited
    'const out = await run(CLI, args);', // assigned
    '  return run(CLI, args);', // returned
    'Promise.all([', '  run(a, []),', '  run(b, []),', ']);', // arguments
    "assert.rejects(() => run('bash', ['-c', 'exit 1']));", // argument
    "execFileSync('openssl', ['version']);", // synchronous: cannot float
    "// run('nope', []);", // a comment
    "const s = \"run('nope', [])\";", // a string
    'await Promise.all([run(a, [])]);', // arguments
  ].join('\n');

  const names = spawnerNames(source);
  assert.ok(names.has('run'), 'aliasen fra promisify() skal være dækket');
  assert.ok(!names.has('execFileSync'), 'execFileSync kan ikke flyve og skal ikke scannes');

  const hits = findFloatingSpawns(source, names);
  assert.equal(hits.length, 1, `forventede præcis ét fund, fandt: ${JSON.stringify(hits)}`);
  assert.equal(hits[0].line, 3);
  assert.match(hits[0].text, /^run\('mkdir'/);
});
