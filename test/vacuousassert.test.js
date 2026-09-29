/**
 * P1-116 — an assertion that cannot fail is worse than no assertion.
 *
 * Measured: four assertions were deleted one at a time from four files, and the
 * suite stayed green at 867/867 every time. A deleted assertion that no test
 * notices is an assertion that was carrying nothing, and a lock built on it
 * inherits that. This file is the fourth instance of one disease the plan has
 * measured seven times before (P1-91, 108, 107, 111, 113, 114, 115) — a promise
 * the code does not keep — except this time the broken promise was in the
 * *locks* rather than in a customer-facing surface:
 *
 *   test/history.test.js:125    assert.deepEqual(X.sort(), X.sort())
 *   test/license.test.js:99     assert.equal(getDeviceId(a), getDeviceId(a))
 *   test/offlinegate.test.js:135  assert.equal(typeof x === 'string' || x === null, true)
 *   test/isolation.test.js:189    assert.ok(touched === null || typeof touched === 'number')
 *
 * Three shapes, all of them decided by the *expression* rather than by the
 * value: a value compared with itself, a disjunction that covers the whole
 * domain of the thing it inspects, and a literal compared with itself.
 *
 * Built as a state machine, not a regex, on P1-115's own ⚠️: the last iteration's
 * HOME-scanner survived a mutation that swapped two alternatives in its skip
 * regex, because a regex's correctness depends on the *order* its branches are
 * written in and nothing in the test notices that. A scanner that walks
 * characters has no order to swap. What it must still be able to do is report
 * its own failure, so `the scanner reports its own failure` below plants every
 * shape — and the shapes that are *not* vacuous — in a synthetic source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)));

/**
 * Replace every comment and string *body* with spaces, keeping the length and
 * every newline, so offsets still point at the original character.
 *
 * Length-preserving is the point: a caller can index the result and read the
 * original text back, which is what lets the scanner report the line a human
 * will go and look at. Comments and literals are blanked *entirely*, quotes
 * included, so this file's own examples — which quote every shape below — do
 * not report themselves.
 */
const QUOTE_DOUBLE = String.fromCharCode(34);
const QUOTE_SINGLE = String.fromCharCode(39);
const QUOTE_TEMPLATE = String.fromCharCode(96);

export function mask(src) {
  const out = src.split('');
  let inString = null;
  let inComment = null;

  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];

    if (inComment === '//') {
      if (c === '\n') inComment = null; else blank(i);
      continue;
    }
    if (inComment === '/*') {
      if (c === '*' && next === '/') { blank(i); blank(i + 1); inComment = null; i++; }
      else if (c !== '\n') blank(i);
      continue;
    }
    if (inString) {
      if (c === '\\') { blank(i); if (next !== undefined && next !== '\n') { blank(i + 1); i++; } }
      // A `'` or `"` that runs to the end of its line without closing is not a
      // literal — it is an apostrophe in prose, and the neighbours of this file
      // are full of them. Ending the literal at the newline is what keeps the
      // walker in step on real code; the price is a multi-line template literal
      // whose *body* holds an apostrophe is read as code, which the caller
      // cannot see. That limit is measured in `the scanner reports its own
      // failure` and written down here, not papered over.
      else if (c === '\n') {
        if (inString === QUOTE_TEMPLATE) continue; // a template may span lines
        inString = null;
      }
      else if (c === inString) { blank(i); inString = null; }
      else blank(i);
      continue;
    }
    if (c === '/' && next === '/') { blank(i); blank(i + 1); inComment = '//'; i++; continue; }
    if (c === '/' && next === '*') { blank(i); blank(i + 1); inComment = '/*'; i++; continue; }
    // Compared by code point, not written as `c === '"' || c === "'"`. That
    // form is a `'`-quoted string containing a `"`, so a scanner reading this
    // line opens a literal at the `"` and never closes it — which is how this
    // file desynced and reported its own fixtures. It is P1-115's ⚠️ again: a
    // construct that looks like the code it means can be the code that breaks
    // the thing that reads it.
    if (c === QUOTE_DOUBLE || c === QUOTE_SINGLE || c === QUOTE_TEMPLATE) { blank(i); inString = c; continue; }
  }
  return out.join('');
}

const norm = (expr) => expr.replace(/\s+/g, ' ').trim();


const EQUALITY = new Set(['equal', 'strictEqual', 'notEqual', 'notStrictEqual', 'deepEqual', 'deepStrictEqual', 'notDeepEqual']);

/**
 * Parse an `assert.<method>(…)` call whose `assert` starts at `start`, as
 * `{name, args, end}` — or null if what starts there is not a complete call.
 *
 * `end` is the closing parenthesis, so a caller can quote the whole call rather
 * than guessing where it stopped: `src.indexOf(')', i)` would stop at the first
 * inner paren and report `assert.equal(f(x` for `assert.equal(f(x), f(x))`.
 */
function callArgs(src, masked, start) {
  const open = src.indexOf('(', start);
  if (open === -1) return null;
  const name = masked.slice(start, open);
  if (!/^assert\.[A-Za-z]+$/.test(name)) return null;

  const args = [];
  let depth = 0;
  let quote = null;
  let from = open + 1;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } continue; }
    if (c === ',' && depth === 1) { args.push(src.slice(from, i)); from = i + 1; }
  }
  if (quote || end === -1) return null;
  args.push(src.slice(from, end));
  return { name: name.slice('assert.'.length), args: args.map(norm), end };
}


/**
 * The vacuous `assert.*` calls in `src`, as `{line, text, why}`.
 *
 * Two rules, each decided by the *shape* of the expression, so neither needs a
 * value to decide and both are decidable statically:
 *
 *   SELF     two arguments that are the same expression — `f(x), f(x)`. This
 *            also covers `assert.equal(1, 1)`, which is why there is no
 *            separate "both are constants" rule: a constant compared with an
 *            equal constant is the same expression, and one compared with a
 *            *different* constant is a failing test, not a vacuous one.
 *   DOMAIN   a disjunction whose branches name one value and between them
 *            accept every value it could have, so the test is true whatever
 *            `statSync` and `JSON.parse` returned — `x === null || typeof x === 'number'`
 *
 * `assert.ok` takes one argument, so DOMAIN is the only rule that can apply to
 * it. The other needs a pair, which is why the measured cases split three-and-one
 * between them: three `assert.equal`/`deepEqual` self-comparisons and one
 * `assert.ok` tautology.
 *
 * **Measured scope, so the lock is not oversold.** This decides two shapes and no
 * more. It does not know whether the thing being compared is the *right* thing —
 * `assert.equal(sha(x), sha(x))` was wrong because it compares one call with
 * another, and that is caught; `assert.equal(actual, 3)` being the wrong
 * expectation is not this scanner's business. The mask's newline rule is a
 * defensive net for an unterminated literal, and mutations M3 and M4 (reversing
 * the quote order, and breaking that rule) both survive, which is *expected*:
 * valid JavaScript has no unterminated literal, so no fixture can tell the two
 * behaviours apart. M1, M2 and M5 — a self-comparison, a domain tautology, and a
 * broken closing-quote test — each die with the file and line named.
 */
export function findVacuousAssertions(src) {
  const masked = mask(src);
  const hits = [];
  const lineAt = (index) => masked.slice(0, index).split('\n').length;

  for (let i = 0; i < masked.length; i++) {
    if (masked.slice(i, i + 7) !== 'assert.') continue;
    if (i > 0 && /[\w$.]/.test(masked[i - 1])) continue;

    const call = callArgs(src, masked, i);
    if (!call) continue;
    const { name, args, end } = call;
    const binary = EQUALITY.has(name);
    if (!binary && name !== 'ok') continue;
    if (args.some((a) => a === '')) continue;

    const text = norm(src.slice(i, end + 1));
    if (binary) {
      const [a, b] = args;
      if (a === b) { hits.push({ line: lineAt(i), text, why: 'SELF' }); continue; }
    }

    // `x === null || typeof x === 'number'`: the branches name the same value
    // and between them accept every shape it could take, so the assertion is
    // true whatever the call it inspects returned. It only reports a shape it
    // is *sure* about — two branches, one variable, one nullish guard and one
    // type guard. A disjunction with a third branch, or two variables, is left
    // alone: a scanner that guessed would be a type checker.
    const branches = args[0].split('||').map(norm);
    if (branches.length !== 2) continue;
    const names = new Set();
    const guards = new Set();
    for (const branch of branches) {
      const nullish = /^(\w[\w$.]*)\s*(?:===|==)\s*(?:null|undefined)$/.exec(branch);
      const typed = /^typeof\s+(\w[\w$.]*)\s*(?:===|==)\s*['"](?:string|number|boolean|object|undefined)['"]$/.exec(branch);
      if (nullish) { names.add(nullish[1]); guards.add('nullish'); }
      if (typed) { names.add(typed[1]); guards.add('type'); }
    }
    if (names.size === 1 && guards.size === 2) hits.push({ line: lineAt(i), text, why: 'DOMAIN' });
  }
  return hits;
}

test('no test asserts something that cannot fail', () => {
  const offenders = [];
  for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.js'))) {
    for (const hit of findVacuousAssertions(readFileSync(join(TEST_DIR, name), 'utf8'))) {
      offenders.push(`${name}:${hit.line}  [${hit.why}]  ${hit.text}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `en assertion der ikke kan fejle er værd mindre end ingen:\n${offenders.join('\n')}`,
  );
});

test('the scanner reports its own failure', () => {
  // Every shape it must catch, and the neighbours it must leave alone. A
  // scanner that stopped matching would fail here rather than quietly pass.
  const source = [
    'assert.equal(f(x), f(x));', // SELF
    'assert.equal(1, 1);', // SELF: a constant against the same constant
    "assert.ok(touched === null || typeof touched === 'number');", // DOMAIN
    "assert.ok(typeof observed.address === 'string' || observed.address === undefined);", // DOMAIN: same value, and 'undefined' is a type the guard can name
    'assert.equal(getDeviceId(a), getDeviceId(b));', // different calls
    'assert.equal(out.checks, 3);', // a real comparison
    'assert.equal(Object.keys(h.urls[U]).sort(), expected.sort());', // the fixed form
    "assert.equal(status, 200, 'HTTP 200');", // trailing message
    "assert.equal(a === null || typeof a === 'number', true);", // the offlinegate shape: DOMAIN, reported against the first argument
    '// assert.equal(f(x), f(x));', // a comment
    'const s = "assert.equal(f(x), f(x));";', // a string
    "const t = \"a site's own value\";", // a literal whose body holds a quote
    'assert.equal(g(z), g(z));', // SELF — found even though the line above carried a quote
    'assert.rejects(() => run(x));', // not an equality call
    'assert.ok(a === null || typeof a === "string" || a === 0);', // three branches: not a shape this scanner is sure about
  ].join('\n');

  const hits = findVacuousAssertions(source);
  assert.deepEqual(
    hits.map((h) => h.why).sort(),
    ['DOMAIN', 'DOMAIN', 'DOMAIN', 'SELF', 'SELF', 'SELF'],
    `the scanner must find exactly the shapes it claims:\n${JSON.stringify(hits, null, 2)}`,
  );
  assert.equal(hits[0].line, 1, 'and it must report the line a human will go and look at');
  assert.ok(
    hits.every((h) => h.text.endsWith(')')),
    'a hit quotes the whole call, not up to the first inner paren',
  );
  // By content, not by line number: a fixture added above would otherwise move
  // the line this check is really about. Only the two SELF lines that are real
  // code may be reported — the commented-out call and the call inside a string
  // are the same text, and neither may come back.
  assert.deepEqual(
    hits.filter((h) => h.why === 'SELF').map((h) => h.text).sort(),
    ['assert.equal(1, 1)', 'assert.equal(f(x), f(x))', 'assert.equal(g(z), g(z))'].sort(),
    `a comment and a string must not be reported as code:\n${JSON.stringify(hits, null, 2)}`,
  );
});
