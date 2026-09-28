/**
 * P1-79 — the client report called a page "stable" that the pass never opened.
 *
 * `content.js` skips a body over the 2 MiB limit. When the server *declares* its
 * size, it keeps that declaration in `contentLength` and returns `fetched: false,
 * tooLarge: true` — so the number is the server's claim about the page, not a
 * reading of it. P1-21 had already made exactly that distinction the rule for
 * `check --json` (`readContentState`, with `contentSkipped: "too-large"`), and
 * P1-78 made the report name the age of a size it did have.
 *
 * The pass was never given that rule. `runPass` asked
 * `Number.isFinite(result.content?.contentLength)`, which a declaration satisfies,
 * so an oversized page was stored as a measured size while `lastContentReadAt` —
 * stamped only where a hash was written — stayed empty. Measured 2026-09-28 with a
 * real `runPass`, a real state file, a real 3 MiB page and a real report, Pro from
 * the passthrough stub and nothing stubbed but the license server:
 *
 *   | http://…/stor | UP (200) | 100% (1 check) | … | stable · 3145728 bytes, read at an unknown time |
 *
 * `stable` is a claim that the page was read and did not change. That is the false
 * all-clear P1-21 removed from `check --json`, in the one document an agency
 * forwards, about a page that was never opened — and the report's own footnote
 * already promised the opposite: "a page over the content-check limit is never
 * read, so it shows — rather than a size".
 *
 * The same page served *without* a `content-length` never reached the line at all,
 * because there the checker returns `contentLength: null`. Same limit, same
 * never-read page, two answers — which is why the P1-78 test (a streamed 3 MiB
 * body) was green while the declared form was wrong. Both forms are measured here,
 * so the two answers cannot drift apart again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, renderReportMarkdown } from '../src/report.js';
import { emptyHistory } from '../src/history.js';
import { readContentState, readEntry } from '../src/status.js';
import { assertTempHome, tempHome } from './helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
// Asynchronous, because the HTTP fixture lives in *this* process — a
// synchronous spawn would block the event loop and the fixture could never
// answer, which looks exactly like the CLI timing out.
const run = promisify(execFile);
const NOW = new Date('2026-09-28T09:00:00.000Z');
const OVER_LIMIT = 3 * 1024 * 1024;
const SMALL_PAGE = '<html><head><title>Side A</title></head><body>hej verden</body></html>';

/**
 * A site the pass is *not* seeing for the first time. `watch --once` exits 2 when
 * a site is DOWN and 0 when every site is up, and the tests below are about a
 * page's size rather than about a verdict, so each starts from a state file whose
 * site already has an UP baseline from an earlier pass.
 */
const PRIOR_PASS = {
  lastChecked: '2026-09-27T08:00:00.000Z',
  wasUp: true,
  lastStatus: 200,
  checks: 40,
  checksUp: 40,
  addedAt: '2026-08-01T00:00:00.000Z',
};

/**
 * A real HTTP server that can answer the same path three ways: a small page, a
 * 3 MiB page that declares its own size, and a 3 MiB page streamed with no
 * `content-length`. The last two are both over the content-check limit and both
 * are skipped — they differ only in whether the checker keeps a number, which is
 * exactly the distinction this task is about.
 */
async function pageFixture(t) {
  const flag = join(mkdtempSync(join(tmpdir(), 'deskuptime-oversized-')), 'mode');
  writeFileSync(flag, 'small');
  const big = Buffer.alloc(OVER_LIMIT, 0x61);
  const server = createServer((_req, res) => {
    const mode = readFileSync(flag, 'utf8').trim();
    if (mode === 'declared') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(big.length) });
      res.end(big);
      return;
    }
    if (mode === 'streamed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write(big.subarray(0, Math.floor(big.length / 2)));
      res.end(big.subarray(Math.floor(big.length / 2)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SMALL_PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/`, serve: mode => writeFileSync(flag, mode) };
}

/** A Pro state file in a throwaway HOME, so `report` is not gated. */
function proHome(t, urls) {
  const { dir, options } = tempHome(t, 'deskuptime-oversized-home-');
  assertTempHome(options, 'the oversized-page tests');
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    license: { key: 'a'.repeat(32), instance: 'deskuptime-bureau', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() },
    urls,
  }));
  return { stateFile, options };
}

function readState(stateFile) {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function reportRow(stateFile, url) {
  const markdown = renderReportMarkdown(buildReport(readState(stateFile), { now: NOW, history: emptyHistory() }));
  return markdown.split('\n').find(line => line.startsWith('|') && line.includes(url));
}

/** The fragment the two terminal lists place in `contentSize`. */
function listContentSize(stateFile, url) {
  return readEntry(readState(stateFile).urls[url], { now: NOW, url }).contentSize;
}

/** The Content cell of a table row, which is the column these tests are about. */
function contentCell(row) {
  return row.split('|').map(part => part.trim())[7];
}

/** One real pass through the real CLI: reads the page as it is served right now. */
async function pass(stateFile, options) {
  await run(process.execPath, [CLI, 'watch', '--once'], { env: { ...process.env, ...options }, cwd: ROOT });
}

test('a page over the limit that DECLARES its size is never reported as stable', async (t) => {
  const site = await pageFixture(t);
  site.serve('declared');
  const { stateFile, options } = proHome(t, { [site.url]: { ...PRIOR_PASS } });
  await pass(stateFile, options);

  const entry = readState(stateFile).urls[site.url];

  // The pass measured nothing about the page, so it stores no size for it. The
  // declaration is still available to `check --json` and to the human `check`,
  // which name the limit and the bound — it is a fact about the page, and it is
  // not a reading.
  assert.equal(entry.wasUp, true, 'the page answered 200, so the site is up');
  assert.equal(entry.lastContentLength, undefined, 'a declared size is not a measured size');
  assert.equal(entry.lastContentReadAt, undefined, 'so there is no read time to quote either');
  assert.equal(entry.lastHash, undefined, 'and no hash, because the body was never read');

  // The report says nothing about the page rather than calling it stable, and the
  // two terminal lists agree — the same owner, three surfaces.
  assert.doesNotMatch(reportRow(stateFile, site.url), /stable/, 'never "stable" for a page nobody read');
  assert.doesNotMatch(reportRow(stateFile, site.url), /bytes/, 'and no size at all');
  assert.match(reportRow(stateFile, site.url), /\| — \|/);
  assert.equal(listContentSize(stateFile, site.url), '', 'a list row prints nothing for a page nobody read');
});

test('the declared and the streamed form of the same oversized page are the same answer', async (t) => {
  // Both are over the limit and both are skipped. Only one of them carries a
  // number out of the checker, and that must not decide what the surfaces say —
  // this is the pair the P1-78 test could not see, because it only had the second.
  const answers = [];
  for (const mode of ['declared', 'streamed']) {
    const site = await pageFixture(t);
    site.serve(mode);
    const { stateFile, options } = proHome(t, { [site.url]: { ...PRIOR_PASS } });
    await pass(stateFile, options);

    const entry = readState(stateFile).urls[site.url];
    answers.push({
      mode,
      stored: entry.lastContentLength,
      readAt: entry.lastContentReadAt,
      cell: reportRow(stateFile, site.url),
      list: listContentSize(stateFile, site.url),
    });
  }

  const [declared, streamed] = answers;
  assert.equal(declared.stored, undefined);
  assert.equal(streamed.stored, undefined, 'the streamed form never stored one either, so both are —');
  assert.equal(declared.list, streamed.list);
  // The two sites are on different ports and answer in different milliseconds, so
  // the rows cannot be compared whole — the Content cell is the claim under test.
  assert.equal(contentCell(declared.cell), contentCell(streamed.cell), 'same limit, same page, one answer');
  assert.equal(contentCell(declared.cell), '—');
});

test('a page that grew past the limit keeps the size of the pass that read it, and that pass\'s age', async (t) => {
  // The ordinary upgrade: a site that answered yesterday and outgrew the limit
  // today. The last real reading is still the best fact we have, and it is named
  // with its own age — P1-78's fix, unchanged by this one.
  const site = await pageFixture(t);
  site.serve('small');
  const { stateFile, options } = proHome(t, { [site.url]: { ...PRIOR_PASS } });
  await pass(stateFile, options);
  const measured = readState(stateFile).urls[site.url];
  assert.equal(typeof measured.lastContentLength, 'number', 'the small page was read and measured');
  assert.equal(typeof measured.lastContentReadAt, 'string');

  site.serve('declared');
  await pass(stateFile, options);
  const after = readState(stateFile).urls[site.url];

  assert.equal(after.lastContentLength, measured.lastContentLength, 'the size on disk is still the measured one');
  assert.equal(after.lastContentReadAt, measured.lastContentReadAt, 'and it still belongs to the pass that read it');
  assert.equal(after.lastHash, measured.lastHash, 'a skipped pass writes no new hash');

  // A reading from *now* is unchanged, character for character: this is still an
  // ordinary `stable · N bytes`.
  assert.match(reportRow(stateFile, site.url), /\| stable · \d+ bytes \|/);
});

test('a page that was read keeps its size — the ordinary pass is untouched', async (t) => {
  const site = await pageFixture(t);
  site.serve('small');
  const { stateFile, options } = proHome(t, { [site.url]: { ...PRIOR_PASS } });
  await pass(stateFile, options);

  const entry = readState(stateFile).urls[site.url];
  assert.equal(entry.lastContentLength, Buffer.byteLength(SMALL_PAGE));
  assert.equal(typeof entry.lastContentReadAt, 'string');
  assert.equal(typeof entry.lastHash, 'string');
  assert.match(reportRow(stateFile, site.url), /\| stable · \d+ bytes \|/);
  assert.equal(listContentSize(stateFile, site.url), `${Buffer.byteLength(SMALL_PAGE)} bytes`);
});

test('the owner is the one `check --json` already asks, so the two cannot disagree', () => {
  // The distinction is decided once, in `readContentState`, and `runPass` now asks
  // it. A declaration is kept for `check` (it is a true fact about the page) and
  // never becomes a stored measurement.
  const declared = readContentState({ fetched: false, tooLarge: true, contentLength: 3_145_728, contentLimit: 2_097_152 });
  assert.equal(declared.measured, false, 'not measured — this is the line the pass now gates on');
  assert.equal(declared.length, 3_145_728, 'but still the size, for the surface that asks about this check');
  assert.equal(declared.skipped, 'too-large');

  const streamed = readContentState({ fetched: false, tooLarge: true, contentLength: null, atLeastBytes: 1_572_864, contentLimit: 2_097_152 });
  assert.equal(streamed.measured, false);
  assert.equal(streamed.length, null, 'our own streaming artifact is not a page size');
  assert.equal(streamed.atLeast, 1_572_864, 'it is a lower bound, and it is carried as one');

  const measured = readContentState({ fetched: true, contentLength: 91, hash: 'a'.repeat(64) });
  assert.equal(measured.measured, true, 'a real reading is stored, as before');
  assert.equal(measured.length, 91);
  assert.equal(measured.skipped, null);
});
