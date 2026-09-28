/**
 * P1-98: the free tier refused the 4th URL by throwing away the other three.
 *
 * Measured 2026-09-28 with the real CLI, real local servers and an empty state —
 * the way a new free user sets the tool up, by pasting their list in one go:
 *
 *   $ deskuptime watch a b c --once      →  exit 0, three sites monitored
 *   $ deskuptime watch a b c d --once    →  exit 1
 *     ❌ Error: Free tier monitors 3 URLs. …/d/ not added. Pro unlocks …
 *     $ deskuptime status                 →  Monitored URLs (0)
 *   $ deskuptime watch a b c d e --once  →  exit 1, two errors, and still 0
 *
 * The message is true and the work is not: it names only the URL that did not
 * fit, which is exactly what a user reads as "a, b and c are being watched".
 * Nothing was. `state.json` was never even created, so the tool answered the
 * first question it exists to answer — *is my monitoring working?* — with zero
 * sites on a command that named three.
 *
 * The cause is that this decision was made twice, and the two copies disagreed.
 * `addMonitoredUrls()` — the one the running loop uses — takes the limit one URL
 * at a time and keeps the ones that fit. `runOnce()` computed the same list
 * again, ahead of the pass, and `return`ed the whole pass the moment it was
 * non-empty, so `--once` and `watch` gave opposite answers to the same command.
 * The loop was the honest one, and the loop is the surface a paid user is on.
 *
 * The fix is not a softer limit. The pre-flight keeps its job — it owns the
 * sentence the user reads, and it still refuses before a single request when
 * nothing fits, which is the 3-already-monitored case `matrix.test.js` locks —
 * and it now only takes the URLs that do not fit *away* from the run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-p198-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return home;
}

/** Real sites answering 200 — the wall is about slots, not about reachability. */
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

const savedUrls = home => {
  const file = join(home, '.deskuptime', 'state.json');
  return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf-8')).urls) : [];
};

test('4 URLer i én --once overvåger de 3, der passer, og afviser kun den 4.', async t => {
  const urls = await liveSites(t, 4);
  const home = tempHome(t);
  const r = await run(['watch', ...urls, '--once'], home);

  assert.equal(savedUrls(home).length, 3, `de 3 URL'er der passede blev ikke gemt: ${r.stdout}${r.stderr}`);
  // The refusal is unchanged — same sentence, same limit, same buy link.
  assert.match(r.stderr, /Free tier monitors 3 URLs/, r.stderr);
  assert.match(r.stderr, /https:\/\/buy\.stripe\.com\//, r.stderr);
  assert.ok(r.stderr.includes(urls[3]), 'afvisningen navngiver ikke den URL, der ikke passede');
  // …and the sites that were measured are reported, because the sentence above
  // only names the one that was not. Silence here is what made the bug a lie.
  for (const url of urls.slice(0, 3)) {
    assert.ok(r.stdout.includes(url), `passet for ${url} er ikke printet: ${r.stdout}`);
  }
  assert.equal(r.code, 1, 'en del af kommandoen blev ikke udført, så exit 1 er rigtigt');
});

test('5 URLer: de 3 der passer overvåges, de 2 der ikke, afvises hver for sig', async t => {
  const urls = await liveSites(t, 5);
  const home = tempHome(t);
  const r = await run(['watch', ...urls, '--once'], home);

  assert.equal(savedUrls(home).length, 3, `${savedUrls(home).length} gemt, forventede 3: ${r.stdout}${r.stderr}`);
  assert.equal(r.stderr.match(/Free tier monitors 3 URLs/g)?.length, 2, `hver afvisning skal have sin egen sætning: ${r.stderr}`);
  assert.ok(r.stderr.includes(urls[3]) && r.stderr.includes(urls[4]), 'begge afviste URLer skal navngives');
  for (const url of urls.slice(0, 3)) assert.ok(r.stdout.includes(url), `${url} mangler i passet: ${r.stdout}`);
});

test('3 URLer alene er uændret: exit 0, ingen afvisning', async t => {
  const urls = await liveSites(t, 3);
  const home = tempHome(t);
  const r = await run(['watch', ...urls, '--once'], home);

  assert.equal(r.code, 0, `en ren kørsel skal være exit 0: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Free tier monitors/, r.stderr);
  assert.equal(savedUrls(home).length, 3);
});

test('det er kun de nye URL’er der tæller mod grænsen, så en cron-kørsel ikke låser sig selv ude', async t => {
  const urls = await liveSites(t, 4);
  const home = tempHome(t);
  await run(['watch', ...urls.slice(0, 3), '--once'], home);
  // The same three sites again — what a cron `--once` does every interval — plus
  // the fourth. The three are already saved, so they are not "new" and must not
  // spend a slot; only the fourth is over the limit.
  const r = await run(['watch', ...urls, '--once'], home);

  assert.equal(savedUrls(home).length, 3, `cron-kørslen ændrede listen: ${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes(urls[3]), `den 4. skal stadig afvises: ${r.stderr}`);
});

test('når intet passer, afvises der stadig FØR en eneste request', async t => {
  // The case matrix.test.js locks, kept as a lock on behaviour rather than on a
  // count: three sites are saved, the fourth cannot be added, so there is
  // nothing to measure and the pass must not pretend otherwise.
  const home = tempHome(t);
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({
    urls: { 'https://a.example/': {}, 'https://b.example/': {}, 'https://c.example/': {} },
  }));
  const r = await run(['watch', 'https://d.example/', '--once'], home);

  assert.equal(r.code, 1);
  assert.match(r.stderr, /Free tier monitors 3 URLs/, r.stderr);
  assert.doesNotMatch(r.stdout, /baseline recorded/, `passet må ikke køre når intet passer: ${r.stdout}`);
});
