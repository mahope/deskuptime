/**
 * P1-102: `check` found no baseline for a site it was watching, because the
 * site was typed the way a browser shows it.
 *
 * Measured 2026-09-28 with the real CLI, a real local server and a real state
 * file. One site, watched without a trailing slash, then checked with one — the
 * second form is what a browser's address bar shows and what a user copies:
 *
 *   $ deskuptime watch http://127.0.0.1:62057 --once
 *     [7:47:58 PM] • http://127.0.0.1:62057 baseline recorded: UP (200) — 24ms
 *   …the page changed…
 *   $ deskuptime check http://127.0.0.1:62057
 *     🔄 Content: 56 bytes — changed since the reading today     ← found it
 *   $ deskuptime check http://127.0.0.1:62057/
 *     — Content: 56 bytes — no reading to compare against      ← lost it
 *
 * The certificate reading breaks the same way, and it is the more expensive one:
 * an agency asks "is this still the customer's certificate?" every week, and
 * `check` — the command that answers it — says `no earlier certificate to
 * compare against` for a site it has been checking all along.
 *
 * The cause is that two commands asked "which saved key is this address?" and
 * got different answers. `watch` and `unwatch` ask `findUrlKey()`, which
 * compares the address the way `new URL()` reads it, so a trailing slash, a
 * default port or a scheme in capitals finds the same site. `check` indexed
 * `state.urls` with the address the user typed and read `undefined` for
 * everything else — a miss that is *silent*, because the sentence it fell
 * through to, "no reading to compare against", is exactly what a site that was
 * never watched also says. So the one thing that could have told the user their
 * spelling was the problem said nothing at all.
 *
 * The fix is that `check` asks the same owner. It does not learn a second rule
 * for what the same site looks like: `findUrlKey` is imported from status.js,
 * where the other two commands already get it.
 *
 * The tests below run the real CLI against a real server and a real state file,
 * because the bug is a *miss*, and a miss cannot be seen by a function that is
 * asked the question it was written to answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUrlKey } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');

function run(args, home) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, DUB_STUB_SCENARIO: 'passthrough' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-p102-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return home;
}

/** A server whose page changes between passes, on one port that survives both. */
async function changingSite(t) {
  let title = 'A';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>${title}</title></head><body>x</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    change: (next) => { title = next; },
  };
}

test('check finder grundlinjen for det site, der er overvåget i en anden skrivemåde', async t => {
  const site = await changingSite(t);
  const home = tempHome(t);

  // Watched without a trailing slash — the form a person types.
  const watched = await run(['watch', site.origin, '--once'], home);
  assert.equal(watched.code, 0, `watch fejlede: ${watched.stdout}${watched.stderr}`);
  site.change('B');

  // Checked with one — the form a browser's address bar shows and a user copies.
  const checked = await run(['check', `${site.origin}/`], home);
  assert.equal(checked.code, 0, `check fejlede: ${checked.stdout}${checked.stderr}`);

  assert.match(
    checked.stdout,
    /🔄 Content:.*changed since the reading/,
    `check fandt ikke den læsning, dette site har lagt: ${checked.stdout}`,
  );
  assert.doesNotMatch(
    checked.stdout,
    /no reading to compare against/,
    `check sagde at det aldrig har set sitet, selv om det overvåger det: ${checked.stdout}`,
  );
});

test('det er den samme fejl i JSON som i terminalen', async t => {
  const site = await changingSite(t);
  const home = tempHome(t);
  await run(['watch', site.origin, '--once'], home);
  site.change('B');

  const checked = await run(['check', `${site.origin}/`, '--json'], home);
  const [row] = JSON.parse(checked.stdout);
  assert.equal(row.contentChanged, true, `contentChanged er null, altså "ingen læsning": ${checked.stdout}`);
  assert.ok(row.contentBaselineReadAt, 'contentBaselineReadAt er null, altså ingen grundlinje fundet');
  assert.ok(row.contentHash, 'contentHash er null, altså sidelæsningen aldrig blev brugt');
});

test('en skrivemåde der virker, gør ikke en der ikke virker til at virke', async t => {
  // The two spellings are the same site, so the same page and the same stored
  // hash must produce the same verdict. Before the fix this held only for the
  // spelling that happened to match the key.
  const site = await changingSite(t);
  const home = tempHome(t);
  await run(['watch', site.origin, '--once'], home);
  site.change('B');

  const a = await run(['check', site.origin], home);
  const b = await run(['check', `${site.origin}/`], home);
  const verdict = out => /🔄 Content:.*changed/.test(out);
  assert.equal(verdict(a.stdout), verdict(b.stdout),
    `de to skrivemåder af ét site fik to forskellige domme:\n--- ${site.origin}\n${a.stdout}\n--- ${site.origin}/\n${b.stdout}`);
});

test('skemaet og porten er det samme spørgsmål som skråstregen', async t => {
  // `new URL()` reads a capital scheme and a default port as the same address,
  // and `findUrlKey` is the owner of that reading. These are the other two
  // spellings a user can arrive with; they were measured with the same miss.
  const urls = { 'https://Kunde.dk': 'https://kunde.dk/', 'http://kunde.dk:80/': 'http://kunde.dk/' };
  for (const [typed, stored] of Object.entries(urls)) {
    assert.equal(findUrlKey({ [stored]: {} }, typed), stored, `${typed} er ikke fundet under ${stored}`);
  }
});

test('et site der aldrig er overvåget siger stadig det samme som før', async t => {
  // The fix must not turn "no baseline" into a false claim either: a site this
  // machine has never watched has no reading, and the sentence saying so is the
  // honest one.
  const site = await changingSite(t);
  const home = tempHome(t);
  const checked = await run(['check', site.origin], home);
  assert.match(checked.stdout, /no reading to compare against/, checked.stdout);
});

test('state.json er uændret af check', async t => {
  // `check` stays read-only. Reading a baseline through `findUrlKey` must not
  // become a writer, and a miss must not create the key it looked for.
  const site = await changingSite(t);
  const home = tempHome(t);
  await run(['watch', site.origin, '--once'], home);
  const file = join(home, '.deskuptime', 'state.json');
  const before = readFileSync(file, 'utf-8');
  await run(['check', `${site.origin}/`, '--json'], home);
  assert.equal(readFileSync(file, 'utf-8'), before, 'check skrev til state.json');
});
