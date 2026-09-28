/**
 * P1-107 — the README's copy-paste CI recipe pointed at a tag that does not exist.
 *
 * The "Use in GitHub Actions" section is the shortest path from a visitor to a
 * running install of the free tool, and its whole value is that the YAML can be
 * pasted unchanged. Measured 2026-09-29 against the real repository, nothing
 * stubbed:
 *
 *   $ grep -n "uses: mahope/deskuptime" README.md
 *   201:      - uses: mahope/deskuptime@v0
 *
 *   $ git ls-remote --tags origin | grep -E "refs/tags/v0$"
 *   (nothing — 18 tags, none of them `v0`)
 *
 *   $ git rev-parse --verify "v0^{commit}"
 *   fatal: Needed a single revision
 *
 * GitHub's answer to that line is `Unable to resolve action
 * 'mahope/deskuptime@v0', unable to find version 'v0'`, so every customer who
 * copied the recipe got a red run before the tool ever measured a URL. The
 * README's own feature table calls the action "✅ ✅ In both tiers", so the
 * promise was not a wish — it was a broken link in the one place a new user
 * meets the product.
 *
 * The interesting half is *why* nothing caught it. The repository ships a claims
 * lock (`test/claims.test.js`) that fails when a customer surface promises a
 * channel that was never built, and it covers `README.md` and `--help`. What it
 * cannot do is ask whether a ref is real: that is a question about this
 * repository's own refs, not about a string, and the suite runs with the public
 * internet unreachable (P1-92), so no test may go and look one up.
 *
 * So the answer is the same one as everywhere else in this repo: ask the local
 * git. `git rev-parse --verify <ref>^{commit}` is offline, exact, and cannot
 * answer "yes" for a tag nobody pushed. The second test goes one step further,
 * because a ref that resolves is not enough: it reads the `action.yml` **at
 * that ref** and requires it to declare the inputs and outputs the README
 * documents. That is what makes the fix honest rather than cosmetic — pinning
 * the recipe to the newest release tag would resolve, and would quietly ship
 * three weeks of an older `action.yml` whose `down-count` means "unreachable"
 * while the table two lines below it says "HTTP 4xx/5xx or network error".
 *
 * Everything here is a local file and the local git: no network, no loop, no
 * HOME.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one owner of the repository slug. Two spellings would be two recipes. */
const ACTION_OWNER = 'mahope/deskuptime';

const readme = readFileSync(join(root, 'README.md'), 'utf-8');
const docs = readdirSync(join(root, 'docs'))
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => [join('docs', name), readFileSync(join(root, 'docs', name), 'utf-8')]);

const surfaces = [['README.md', readme], ...docs];

/** A ref stops at a backtick, a quote or whitespace, so `` `@main` `` reads as `main`. */
function referencedRefs(text) {
  return [...text.matchAll(new RegExp(`${ACTION_OWNER}@([A-Za-z0-9._/-]+)`, 'g'))].map((m) => m[1]);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Does this ref name a commit in *this* repository? No network is consulted.
 *
 * The two spellings are measured, not defensive. `actions/checkout` builds a
 * local branch when it checks out a push, but a pull request arrives as a
 * detached HEAD with only `refs/remotes/origin/main` present — verified in a
 * throwaway clone: there `main^{commit}` fails and `origin/main^{commit}`
 * answers. A lock that only knew the first spelling would turn this repository's
 * own CI red on every pull request, which is the same mistake as a test that
 * fails for a reason that is not a defect.
 */
function resolveRef(ref) {
  for (const candidate of [ref, `origin/${ref}`]) {
    try {
      return git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).trim();
    } catch {
      // Not that spelling. Try the next.
    }
  }
  return null;
}

function isTag(ref) {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/tags/${ref}`]);
    return true;
  } catch {
    return false;
  }
}

function fileAtRef(ref, path) {
  return git(['show', `${ref}:${path}`]);
}

/**
 * The keys of a top-level `inputs:` / `outputs:` block, read from YAML with two
 * regular expressions rather than a parser: this suite has no dependencies, and
 * the shape that matters — two spaces for a key, four for its attributes — is
 * the shape `action.yml` is written in.
 */
function declaredNames(actionYml, block) {
  const lines = actionYml.split('\n');
  const start = lines.findIndex((line) => line === `${block}:`);
  if (start === -1) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
    if (key) names.push(key[1]);
  }
  return names;
}

/** The input table the README shows, scoped to the Actions section it belongs to. */
function documentedInputs() {
  const section = readme.slice(readme.indexOf('\nInputs:\n'), readme.indexOf('\nOutputs:'));
  return [...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);
}

function documentedOutputs() {
  const line = readme.split('\n').find((text) => text.startsWith('Outputs:'));
  return [...line.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
}

function everyReference() {
  return surfaces.flatMap(([surface, text]) =>
    referencedRefs(text).map((ref) => ({ surface, ref })),
  );
}

test('the ref a customer is told to copy exists in this repository', () => {
  const refs = everyReference();
  assert.ok(refs.length > 0, 'README/docs never say how to reference the action — the recipe is the promise');

  for (const { surface, ref } of refs) {
    assert.ok(
      resolveRef(ref) !== null,
      `${surface} tells a customer to use ${ACTION_OWNER}@${ref}, and no such ref exists in this repository ` +
        `(git rev-parse --verify "${ref}^{commit}" fails). GitHub answers that with ` +
        `"unable to find version '${ref}'", so the recipe fails before the tool ever runs.`,
    );
  }
});

test('the recipe is not pinned to a release or a commit, so it cannot freeze an older action', () => {
  // Measured, not hypothetical: `v0.2.8` is a tag that resolves and carries an
  // action.yml, and pinning the recipe to it would document a `down-count` that
  // means "unreachable" while the row two lines below it says "HTTP 4xx/5xx or
  // network error". The README's own sentence now says so in prose; this says it
  // in code, and a raw sha fails for the same reason — it is a fixed point
  // nobody will ever come back and name.
  //
  // Known limit, kept here rather than pretended away: a depth-1 CI checkout
  // fetches no tags at all, so there this lock cannot see one. It is strongest
  // in the full clone the plan names as the gate, and the sentence in README
  // covers a reader either way.
  for (const { surface, ref } of everyReference()) {
    assert.ok(
      !/^[0-9a-f]{40}$/.test(ref),
      `${surface} pins the action to a raw commit sha (${ref}); it is unmaintainable and ages into a ref nobody can name`,
    );
    assert.ok(
      !isTag(ref),
      `${surface} pins the action to the release tag ${ref}, whose action.yml is older than the input table ` +
        `printed directly below the recipe.`,
    );
  }
});

test('the action at that ref takes the inputs the README documents and publishes the outputs it names', () => {
  const ref = referencedRefs(readme)[0];
  const sha = ref ? resolveRef(ref) : null;
  assert.ok(sha, 'README references no ref that exists in this repository');

  // Both sides: the ref a customer resolves, and the file in this working tree,
  // so renaming an input without touching the README fails here as well.
  for (const source of [() => fileAtRef(sha, 'action.yml'), () => readFileSync(join(root, 'action.yml'), 'utf-8')]) {
    const actionYml = source();
    const inputs = declaredNames(actionYml, 'inputs');
    const outputs = declaredNames(actionYml, 'outputs');

    for (const name of documentedInputs()) {
      assert.ok(
        inputs.includes(name),
        `README documents the input \`${name}\`, but action.yml declares [${inputs.join(', ')}]`,
      );
    }
    for (const name of documentedOutputs()) {
      assert.ok(
        outputs.includes(name),
        `README documents the output \`${name}\`, but action.yml declares [${outputs.join(', ')}]`,
      );
    }
  }
});

test('every customer surface names one ref, so the recipe cannot drift into two versions', () => {
  const refs = [...new Set(surfaces.flatMap(([, text]) => referencedRefs(text)))];
  assert.deepEqual(
    refs,
    refs.length === 1 ? refs : [],
    `the surfaces disagree about which ref the action is used at: ${refs.join(', ')}`,
  );
});
