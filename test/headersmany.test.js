/**
 * P1-113 — the matrix row said `headers` takes any number of URLs. It did not.
 *
 * `src/features.js` has published '`check` and `headers` on any number of URLs'
 * since P1-1, and that one string is generated into the README table, into
 * `--help` and onto the npm page, so the promise is on every surface a customer
 * reads. Measured 2026-09-29 with the real CLI, no code changed:
 *
 *   $ deskuptime headers https://example.com https://example.org
 *   ❌ Error: Unexpected argument: https://example.org      exit 1
 *
 *   $ deskuptime check https://example.com https://example.org
 *   🔍 Checking 2 URL(s)…                                      exit 0
 *
 * One command honoured the row and the other refused it. The reader who trusted
 * the table is auditing twelve client domains for a bureau and gets one domain
 * per terminal invocation — or, worse, a shell loop whose failure is a single
 * `Unexpected argument` that names none of the sites it would have scanned.
 *
 * This is the fifth shape of the same illness the plan has measured: built code
 * no customer can reach (P1-91), a flag no surface names (P1-108), a ref that
 * does not exist (P1-107), a table row standing in for a demonstration
 * (P1-111), and now a table row the code actively refuses.
 *
 * The lock is behavioural on purpose. A test that asserted "the matrix mentions
 * headers" would pass with the promise still broken, which is what every lock
 * here is written against. So the servers are real, the CLI is real, and the
 * claim is checked by *scanning several sites in one invocation* and reading
 * what came back:
 *
 *   1. three URLs, one invocation, three sheets and three JSON entries — the
 *      row, executed;
 *   2. `--json` is an array for several URLs and *still* the bare object for
 *      one, because `jq '.security'` is in the README and on `--help` and every
 *      published script reads it that way. Changing that shape would break the
 *      customers the row is written for;
 *   3. one site among several being down is exit 2 — the strictest verdict, not
 *      the last URL's, so a green run cannot come from the site that happened to
 *      be scanned last;
 *   4. a typo in the fourth address sends *no* request at all, the same rule
 *      `check` follows and the README's status policy already states;
 *   5. `--timeout` is read as a flag wherever it stands, and its value is never
 *      scanned as a URL;
 *   6. `check` and `headers` are both asked the same question — "any number of
 *      URLs" — and they answer it the same way, so the row has one meaning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertTempHome } from './helpers/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const REQUEST_TIMEOUT = '8000';

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-headersmany-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  assertTempHome(env, 'P1-113');
  return env;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, ...env, DUB_STUB_SCENARIO: 'passthrough' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function listen(t, handler) {
  const server = createServer(handler);
  t.after(() => server.close());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/**
 * Three sites with distinguishable names, and a fourth that is simply broken.
 * The header a site sends is its own, so a sheet can be traced back to the
 * address that produced it — otherwise "three sheets" could be the same site
 * printed three times.
 */
async function threeSites(t) {
  const make = (name) => listen(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': name });
    res.end(`<html><title>${name}</title></html>`);
  });
  const a = await make('site-a');
  const b = await make('site-b');
  const c = await make('site-c');
  const dead = await make('never-answers');
  dead.server.close();
  return {
    a: `http://127.0.0.1:${a.port}/`,
    b: `http://127.0.0.1:${b.port}/`,
    c: `http://127.0.0.1:${c.port}/`,
    dead: `http://127.0.0.1:${dead.port}/`,
  };
}

test('matrixens løfte er sandt: `headers` scanner flere URL\'er i én kørsel', async (t) => {
  const env = tempHome(t);
  const { a, b, c } = await threeSites(t);

  const out = await runCli(['headers', a, b, c, '--timeout', REQUEST_TIMEOUT], env);

  assert.equal(out.stderr, '', 'flere URL\'er er ikke en fejl — kommandoen skal ikke skrive til stderr');
  assert.notEqual(out.code, 1, `kommandoen må ikke afvise den anden adresse:\n${out.stdout}${out.stderr}`);
  // One sheet per URL, each opening with its own address. A single sheet here
  // is the exact bug: the row promised a scan of any number of sites.
  for (const url of [a, b, c]) {
    assert.ok(out.stdout.includes(`🧭 ${url}`), `mangler et ark for ${url}:\n${out.stdout}`);
  }
  assert.equal(out.stdout.match(/🧭 /g).length, 3, `ét ark pr. URL, ikke færre:\n${out.stdout}`);
  // And the sheets are the *sites*, not one site described three times.
  for (const name of ['site-a', 'site-b', 'site-c']) {
    assert.ok(out.stdout.includes(name), `arket for ${name} mangler sit eget svar:\n${out.stdout}`);
  }
});

test('flere URL\'er giver et array, én URL giver stadig objektet `jq \'.security\'` læser', async (t) => {
  const env = tempHome(t);
  const { a, b } = await threeSites(t);

  const many = await runCli(['headers', a, b, '--json', '--timeout', REQUEST_TIMEOUT], env);
  const sheets = JSON.parse(many.stdout);
  assert.ok(Array.isArray(sheets), `flere URL\'er skal give et array, som \`check --json\` gør:\n${many.stdout}`);
  assert.equal(sheets.length, 2, 'ét element pr. URL');
  assert.deepEqual(sheets.map(s => s.finalUrl), [a, b], 'hvert element svarer til den adresse, der blev spurgt');
  assert.ok(sheets.every(s => s.security && typeof s.security === 'object'), 'hvert ark har sin egen security-læsning');

  // The one that must not move. README and `--help` both print
  // `headers <url> --json | jq '.security'`, so a single URL keeps publishing
  // the bare object; a script that reads `.security` must not start reading
  // `.[0].security` because this task made a command accept more than one URL.
  const one = await runCli(['headers', a, '--json', '--timeout', REQUEST_TIMEOUT], env);
  const sheet = JSON.parse(one.stdout);
  assert.ok(!Array.isArray(sheet), 'én URL er stadig ét objekt — den publicerede form er ikke ændret');
  assert.ok(sheet.security && typeof sheet.security === 'object', "jq '.security' virker stadig som før");
  assert.equal(sheet.finalUrl, a, 'objektet er stadig netop den adresse, der blev spurgt');
});

test('et nedbrud blandt flere er exit 2 — ikke den sidste URL\'s domme', async (t) => {
  const env = tempHome(t);
  const { a, dead } = await threeSites(t);

  // The healthy site last, so a scanner that let the final verdict win would
  // exit 0 and hand a bureau a green run over a scan that failed.
  const deadLast = await runCli(['headers', a, dead, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(deadLast.code, 2, 'et site der ikke svarer tæller, uanset hvor i listen det står');

  const deadFirst = await runCli(['headers', dead, a, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(deadFirst.code, 2, 'det er ikke kun den sidste, der dommer');

  const allUp = await runCli(['headers', a, '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(allUp.code, 0, 'ét sundt site er stadig exit 0 — dommen er ikke strammet');
});

test('en skrivefejl i den fjerde adresse sender ingen request overhovedet', async (t) => {
  const env = tempHome(t);
  const { a, b } = await threeSites(t);

  // `check`'s regel, og den status policy i README allerede skriver ned: alle
  // adresser valideres før der sendes noget, så en bureau ikke sidder med tre
  // scanninger og et delvis svar.
  const out = await runCli(['headers', a, b, 'kunde.dk', '--timeout', REQUEST_TIMEOUT], env);
  assert.equal(out.code, 1, 'ugyldig adresse er en fejl, exit 1');
  assert.match(out.stderr, /Invalid URL/, `fejlen skal navngine adressen:\n${out.stderr}`);
  assert.equal(out.stdout, '', 'der må ikke være sendt en eneste scanning — hverken ark eller JSON');
});

test('`--timeout` læses som et flag hvor det står, og værdien er aldrig en URL', async (t) => {
  const env = tempHome(t);
  const { a, b } = await threeSites(t);

  for (const args of [
    ['headers', a, b, '--timeout', REQUEST_TIMEOUT],
    ['headers', '--timeout', REQUEST_TIMEOUT, a, b],
    ['headers', a, '--timeout', REQUEST_TIMEOUT, b],
  ]) {
    const out = await runCli(args, env);
    assert.notEqual(out.code, 1, `flaget skal findes i denne stilling: ${args.join(' ')}\n${out.stdout}${out.stderr}`);
    assert.equal(out.stdout.match(/🧭 /g).length, 2,
      `begge adresser skal scannes, timeout-værdien må ikke tælle som en tredje: ${args.join(' ')}\n${out.stdout}`);
    // The value is a number, and `Invalid URL: 8000` is what a scanner that
    // collected it as a site would say instead.
    assert.doesNotMatch(out.stdout + out.stderr, /Invalid URL/,
      `timeout-værdien blev læst som en adresse: ${args.join(' ')}`);
  }

  // And a missing value is still the timeout error, not an empty scan.
  const dangling = await runCli(['headers', a, '--timeout'], env);
  assert.equal(dangling.code, 1);
  assert.match(dangling.stderr, /--timeout must be a positive integer/);
});

test('`check` og `headers` svarer det samme på "hvilket som helst antal URL\'er"', async (t) => {
  const env = tempHome(t);
  const { a, b, c } = await threeSites(t);

  // The row names two commands and one promise. If they drift apart again, the
  // table is lying about half of itself — which is how this task started.
  for (const command of ['check', 'headers']) {
    const out = await runCli([command, a, b, c, '--timeout', REQUEST_TIMEOUT], env);
    assert.equal(out.code, 0, `${command} på tre sunde sider er exit 0:\n${out.stdout}${out.stderr}`);
    for (const url of [a, b, c]) {
      assert.ok(out.stdout.includes(url), `${command} skal nævne ${url}:\n${out.stdout}`);
    }
  }

  // And the sentence itself is still there, on the surface the customer reads.
  const features = await import('../src/features.js');
  const row = features.MATRIX.find(f => f.en.includes('any number of URLs'));
  assert.ok(row, 'matrixen skal stadig have rækken om vilkårligt mange URL\'er');
  assert.match(row.en, /`check` and `headers`/,
    'rækken skal stadig navngive begge kommandoer — den er låst på denne måling');
});
