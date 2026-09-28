/**
 * P1-105: on the free tier at its three-site limit, one respelled URL stopped the
 * whole cron pass — and the tool blamed the limit.
 *
 * Measured 2026-09-28 with the real CLI, three real local servers and a real
 * state file, zero code changed. The three sites were added the way a browser
 * shows them, with the trailing slash, and then the same three sites were given
 * to the cron command without it:
 *
 *   $ deskuptime watch http://127.0.0.1:62669/ … --once   →  exit 0, three baselines, all UP
 *   $ deskuptime watch http://127.0.0.1:62669  … --once    →  exit 1
 *     ❌ Error: Free tier monitors 3 URLs. http://127.0.0.1:62669 not added.
 *               Pro unlocks unlimited URLs and a 30s interval: https://buy.stripe.com/…
 *     …three times, and not one site was measured: `lastChecked` and `checks`
 *     stood exactly where the first run had left them.
 *   $ deskuptime watch http://127.0.0.1:62669/ … --once   →  exit 0, all monitored sites OK
 *
 * The third run is the control, and it is the same three sites. So the two lists
 * describe one monitoring job, and one of them silently does nothing — on the
 * cron path, which is the way the tool is meant to run unattended, and the path
 * the client report is built from. Nothing about the user's setup changed; the
 * free tier stopped measuring three sites it was already measuring.
 *
 * The sentence is the second half, and it is worse than the silence. For each
 * site it named a limit the user was not at, over a site they already watch, and
 * it ended in the buy link. The contract says Pro is shown "where the user is
 * missing it"; here the user was missing nothing, and the tool pointed at the
 * paywall anyway. A user who believed it would have paid to fix a limit that was
 * never the problem.
 *
 * The cause is ❓ 21 in its fourth command. `addMonitoredUrls()` — the loop's own
 * path, and the one P1-46 fixed — has asked `findUrlKey()`, the single owner of
 * "is this site already saved?", since then; `check` learned the same local rule
 * and was measured finding the same bug in P1-102. This pre-flight asked
 * `!state.urls[url]`, an exact string read, and so could not see a site it was
 * already watching. It is the last remaining place in `src/` where a typed
 * address is compared against the saved keys by hand: the reads inside `runPass`
 * and `mergePersistedState` are all keyed from `Object.keys(state.urls)`, so
 * they are correct by construction.
 *
 * Two things the measurement also ruled out, so they are not fixed here:
 * `monitoredCount()` already asks `urlIdentity()`, so a state file that holds
 * both spellings spends one slot and not two, and Pro skips the pre-flight
 * entirely (`if (!pro)`), so a paying customer never hit this.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOnce } from '../src/watch.js';

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

function tempHome(t, prefix = 'deskuptime-p105-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return home;
}

/** Real sites answering 200 — the question is about slots, not reachability. */
async function liveSites(t, count) {
  const urls = [];
  for (let i = 0; i < count; i++) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><title>site ${i}</title>hej</html>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // The CLI holds the connection open, so close() on its own never resolves.
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    urls.push(`http://127.0.0.1:${server.address().port}/`);
  }
  return urls;
}

const stateFile = home => join(home, '.deskuptime', 'state.json');
const savedState = home => (existsSync(stateFile(home))
  ? JSON.parse(readFileSync(stateFile(home), 'utf-8'))
  : null);

/** What a pass *did*, read from the file: the counters move or they do not. */
const checksOf = (home, url) => savedState(home)?.urls?.[url]?.checks ?? null;

/** The same three addresses as a browser shows them, and as a person types them. */
const browserForm = url => url;
const typedForm = url => url.replace(/\/$/, '');

test('cron-listen uden skråstreg tjekker de tre sites den gemmer med skråstreg', async t => {
  const sites = await liveSites(t, 3);
  const home = tempHome(t);
  await run(['watch', ...sites.map(browserForm), '--once'], home);
  const before = sites.map(url => checksOf(home, url));
  assert.deepEqual(before, [1, 1, 1], `grundlinjen kom ikke i stand: ${JSON.stringify(savedState(home))}`);

  const r = await run(['watch', ...sites.map(typedForm), '--once'], home);

  // The measured failure, in the order it appeared: the limit, the buy link, and
  // not one site measured.
  assert.doesNotMatch(r.stderr, /Free tier monitors/, r.stderr);
  assert.doesNotMatch(r.stderr, /buy\.stripe\.com/, `et site der allerede overvåges må ikke sende brugeren i kassen: ${r.stderr}`);
  for (const url of sites) {
    assert.equal(checksOf(home, url), 2, `${url} blev ikke tjekket af sit eget site: ${r.stdout}${r.stderr}`);
  }
  assert.deepEqual(Object.keys(savedState(home).urls).sort(), [...sites].sort(), 'listen må ikke ændre sig');
  assert.equal(r.code, 0, `tre sunde sites er en ren kørsel: ${r.stdout}${r.stderr}`);
});

test(' én af tre sites i en anden skrivemåde stopper ikke de to andre', async t => {
  const sites = await liveSites(t, 3);
  const home = tempHome(t);
  await run(['watch', ...sites, '--once'], home);

  // Measured 2026-09-28: this alone gave exit 1 and one `Free tier monitors 3
  // URLs` for a site that was already monitored, and the two perfectly spelled
  // sites beside it were not checked either.
  const r = await run(['watch', sites[0], sites[1], typedForm(sites[2]), '--once'], home);

  assert.doesNotMatch(r.stderr, /Free tier monitors/, r.stderr);
  for (const url of sites) {
    assert.equal(checksOf(home, url), 2, `${url} blev ikke tjekket: ${r.stdout}${r.stderr}`);
  }
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
});

test('den ledige gratis-plads bruges af det nye site, ikke af en genstavning', async t => {
  const sites = await liveSites(t, 3);
  const home = tempHome(t);
  await run(['watch', ...sites.slice(0, 2), '--once'], home);

  // One slot free, one saved site respelled, one genuinely new site. Before the
  // fix the respelling counted as a new site, so the slice that decides what
  // does not fit refused the *new* one: the user was told they had no room for a
  // site they had never added, while a free slot sat there.
  const r = await run(['watch', typedForm(sites[0]), sites[2], '--once'], home);

  assert.doesNotMatch(r.stderr, /Free tier monitors/, r.stderr);
  assert.ok(savedState(home).urls[sites[2]], `det nye site blev ikke gemt: ${JSON.stringify(Object.keys(savedState(home).urls))}`);
  assert.equal(checksOf(home, sites[2]), 1, `det nye site blev ikke tjekket: ${r.stdout}${r.stderr}`);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
});

test('et ægte site over grænsen afvises stadig med den samme sætning og det samme købslink', async t => {
  // P1-98's lock, kept: the pre-flight's own job is unchanged. Two sites are
  // saved and one slot is free, so the third new site fits and the fourth does
  // not — the shape where the pre-flight both refuses *and* still measures, which
  // is what makes it worth holding separately from the "nothing fits" case below.
  // The fix is about which URLs the decision is asked about, not about softening
  // the limit, and the buy link the contract names must stay on a real refusal.
  const sites = await liveSites(t, 4);
  const home = tempHome(t);
  await run(['watch', ...sites.slice(0, 2), '--once'], home);

  const r = await run(['watch', ...sites, '--once'], home);

  assert.match(r.stderr, /Free tier monitors 3 URLs/, r.stderr);
  assert.match(r.stderr, /https:\/\/buy\.stripe\.com\//, r.stderr);
  assert.ok(r.stderr.includes(sites[3]), 'afvisningen skal navngive den URL, der ikke passede');
  assert.doesNotMatch(r.stderr, new RegExp(sites[2].replace(/[/.]/g, '\\$&')), 'det site der passede må ikke afvises');
  assert.equal(savedState(home).urls[sites[3]], undefined, 'det 4. site må ikke gemmes');
  // …and everything that fitted was measured, or the sentence lies by omission.
  assert.equal(checksOf(home, sites[2]), 1, `det site der passede blev ikke tjekket: ${r.stdout}${r.stderr}`);
  for (const url of sites.slice(0, 2)) {
    assert.equal(checksOf(home, url), 2, `${url} blev ikke tjekket: ${r.stdout}${r.stderr}`);
  }
  assert.equal(r.code, 1, 'en del af kommandoen blev ikke udført, så exit 1 er rigtigt');
});

test('retningen er symmetrisk: gemt uden skråstreg, cron-liste med', async t => {
  const sites = await liveSites(t, 3);
  const home = tempHome(t);
  await run(['watch', ...sites.map(typedForm), '--once'], home);

  const r = await run(['watch', ...sites, '--once'], home);

  assert.doesNotMatch(r.stderr, /Free tier monitors/, r.stderr);
  for (const url of sites) {
    assert.equal(checksOf(home, typedForm(url)), 2, `${url} blev ikke tjekket: ${r.stdout}${r.stderr}`);
  }
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
});

test('forudskridtet spørger ejeren: intet i rejected kan være et site der allerede er gemt', async t => {
  // The invariant, asked of the pre-flight directly rather than through a
  // process boundary. A behavioural CLI test can see that a pass ran; it cannot
  // see *why* one did not, so the list the refusal is built from is locked here.
  // Anything in `rejected` is taken away from the run, so a saved site in that
  // list is a monitoring job that stops without saying it measured anything.
  const sites = await liveSites(t, 3);
  const home = tempHome(t);
  await run(['watch', ...sites, '--once'], home);

  const saved = Object.keys(savedState(home).urls);
  for (const spelling of [typedForm, browserForm]) {
    const r = await runOnce(spelling === browserForm ? sites : sites.map(typedForm), { stateFile: stateFile(home) });
    for (const url of r.rejected ?? []) {
      assert.ok(!saved.includes(url), `${url} er gemt og kan derfor ikke være afvist`);
    }
    assert.equal((r.rejected ?? []).length, 0, `en cron-liste over gemte sites afviste: ${JSON.stringify(r.rejected)}`);
  }
});

test('en liste kun med nye sites over grænsen afvises stadig før en eneste request', async t => {
  // The other end of the same line: when nothing fits, there is nothing to
  // measure, and the pass must not pretend otherwise. Held apart from the
  // respelling tests so the refusal and the silence are two different facts.
  const home = tempHome(t, 'deskuptime-p105-over-');
  writeFileSync(stateFile(home), JSON.stringify({
    urls: { 'https://a.example/': {}, 'https://b.example/': {}, 'https://c.example/': {} },
  }));

  const r = await run(['watch', 'https://d.example/', '--once'], home);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /Free tier monitors 3 URLs/, r.stderr);
  assert.doesNotMatch(r.stdout, /baseline recorded/, `passet må ikke køre når intet passer: ${r.stdout}`);
});
