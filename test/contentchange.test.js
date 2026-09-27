/**
 * P1-56 — a page that changed must be visible in the client report.
 *
 * The feature matrix promises "content-change detection" in *both* tiers, and
 * the detector had worked since P0-3: `content.js` hashes every page on every
 * pass, `runPass` raises `content_changed`, the terminal prints it and the
 * webhook POSTs it to the paid channel. What no surface could do was *report*
 * it. Measured 2026-09-27 with the real CLI, a real Pro record and a real page
 * swapped for `<title>Free iPhone!!</title>`:
 *
 *   pass    ->  🔄 http://kunde.dk/ content changed (70 -> 91 bytes)
 *   report  ->  | http://kunde.dk/ | UP (200) | 100% (7 checks) | ... | 51 ms | — | ... |
 *               **1 site(s) · 1 up · 0 down · 7 checks · 0 failed**
 *
 * One document said the page changed and the other said nothing — and the second
 * is the one the customer receives. A defaced homepage read as `UP (200) | 100%`
 * to the recipient, while every uptime column stayed perfect, because a
 * defacement is not an uptime problem. `state.json` held `lastHash`,
 * `lastContentLength` and `lastTitle` the whole time; nothing read them.
 *
 * The same measurement found the second half: `content.js` skips a page over
 * 2 MiB and leaves `lastContentLength` untouched, so `contentBytes` in
 * `report --json` kept publishing the size from an *earlier* pass as if it
 * described the page now — measured, a pass that skipped a 3 MiB page still
 * printed `contentBytes: 70`.
 *
 * Nothing here moves a verdict. A changed page is still `UP (200)`, still 100 %,
 * still exit 0: uptime is what the status code says, and a page can be served
 * perfectly while being somebody else's. The report gains a column, a named
 * line, a count and additive JSON fields, and every one of them is read from one
 * owner (`readContentChangeState` in src/status.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readContentChangeState } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
// Asynchronous, because the HTTP fixture lives in *this* process — a
// synchronous spawn would block the event loop and the fixture could never
// answer, which looks exactly like the CLI timing out.
const run = promisify(execFile);
const NOW = new Date('2026-09-27T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/**
 * A site whose page the test can rewrite between passes. `mode()` reads the
 * flag file the test flips, because the checker is given a URL and not a
 * closure.
 */
async function pageFixture(t) {
  const flag = join(mkdtempSync(join(tmpdir(), 'deskuptime-page-')), 'mode');
  const server = createServer((_req, res) => {
    const mode = readFileSync(flag, 'utf8').trim();
    if (mode === 'big') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>Side A</title></head><body>${'x'.repeat(3 * 1024 * 1024)}</body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>${mode === 'defaced' ? 'Free iPhone!!' : 'Side A'}</title></head><body>hej verden</body></html>`);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return {
    url: `http://127.0.0.1:${port}/`,
    serve: (mode) => writeFileSync(flag, mode),
  };
}

/** A real Pro record and one monitored site, on disk, in a throwaway HOME. */
function tempHome(t, urls) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-contentchange-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const stateFile = join(home, '.deskuptime', 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    license: {
      key: 'a'.repeat(32),
      instance: 'deskuptime-agency',
      plan: 'pro',
      status: 'active',
      validatedAt: new Date().toISOString(),
    },
    urls,
  }));
  return { home, stateFile, options: { HOME: home, USERPROFILE: home } };
}

function cli(args, options) {
  return run(process.execPath, [CLI, ...args], { env: { ...process.env, ...options } });
}

function readState(stateFile) {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

const PASS = {
  lastChecked: '2026-09-27T08:00:00.000Z',
  wasUp: true,
  lastStatus: 200,
  checks: 40,
  checksUp: 40,
  addedAt: '2026-08-01T00:00:00.000Z',
};

test('the owner says nothing about a page nobody ever read', () => {
  // A fresh site has no hash, no size and no title. `changed` is false and
  // `bytes` is null — not 0, and not "no change", which would be a claim about
  // a page we never looked at (the false all-clear P1-21 removed from
  // `check --json`).
  const state = readContentChangeState({ lastChecked: '2026-09-27T08:00:00.000Z' }, { now: NOW });
  assert.equal(state.changed, false);
  assert.equal(state.changedAt, null);
  assert.equal(state.bytes, null);
  assert.equal(state.note, '', 'an unread page must get no sentence at all');
});

test('the owner names a change with the age it had when the report was made', () => {
  // Three states, three sentences. The age is the point: a report is read once,
  // often days after the pass, and "the page changed" without a date reads as
  // "this morning".
  const threeDaysAgo = readContentChangeState(
    { lastContentChangedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(), lastTitle: 'Free iPhone!!' },
    { now: NOW },
  );
  assert.equal(threeDaysAgo.changed, true);
  assert.equal(threeDaysAgo.ageDays, 3);
  assert.equal(threeDaysAgo.note, '🔄 content changed 3 d ago — page title: "Free iPhone!!"');

  const today = readContentChangeState(
    { lastContentChangedAt: '2026-09-27T06:00:00.000Z', lastContentLength: 91 },
    { now: NOW },
  );
  assert.equal(today.ageDays, 0);
  assert.equal(today.note, '🔄 content changed today', 'no title kept means no invented one');

  // A hand-edited or restored time ahead of this clock is a clock problem, not
  // a fact about the page: no age is invented, and the skew is named. Same rule
  // as `clockAheadNote`, asked of the same owner (`passAge`).
  const ahead = readContentChangeState(
    { lastContentChangedAt: '2026-10-15T00:00:00.000Z' },
    { now: NOW },
  );
  assert.equal(ahead.changed, true);
  assert.equal(ahead.ageDays, null, 'a change dated in the future has no age');
  assert.match(ahead.note, /18 d ahead of this machine's clock/);

  // An unreadable stamp says so rather than becoming "today" or nothing.
  const unreadable = readContentChangeState({ lastContentChangedAt: 'ikke-en-dato' }, { now: NOW });
  assert.equal(unreadable.note, '🔄 content changed at an unreadable time');
});

test('a byte count is a measurement, or it is null', () => {
  // The measured case, the unmeasured case, and the two shapes a hand-edited
  // state file can hold. `content.js` skips a body over 2 MiB and leaves the
  // old number behind, so "there is a number" and "a number describes this
  // pass" are different questions — and the report may only answer the second.
  assert.equal(readContentChangeState({ lastContentLength: 91 }, { now: NOW }).bytes, 91);
  assert.equal(readContentChangeState({ lastContentLength: 0 }, { now: NOW }).bytes, 0);
  assert.equal(readContentChangeState({ lastContentLength: -1 }, { now: NOW }).bytes, null);
  assert.equal(readContentChangeState({ lastContentLength: '91' }, { now: NOW }).bytes, null);
  assert.equal(readContentChangeState({ lastContentLength: Number.NaN }, { now: NOW }).bytes, null);
  assert.equal(readContentChangeState({}, { now: NOW }).bytes, null);
});

test('the report names a changed page instead of printing 100 % and moving on', async (t) => {
  const site = await pageFixture(t);
  site.serve('side');
  const { stateFile, options } = tempHome(t, { [site.url]: { ...PASS } });

  // Two real passes through the real CLI: the first reads the page, the second
  // sees it rewritten. No stub checker and no hand-written state — the claim
  // under test is that the *pass* records the change, not only the reporter.
  await cli(['watch', '--once'], options);
  const baseline = readState(stateFile).urls[site.url];
  assert.equal(typeof baseline.lastHash, 'string', 'the first pass hashed the page');
  assert.equal(typeof baseline.lastContentReadAt, 'string', 'the first pass stamped when it read');
  assert.equal(baseline.lastContentChangedAt, undefined, 'nothing changed yet, so nothing is claimed');

  site.serve('defaced');
  const second = await cli(['watch', '--once'], options);
  assert.match(second.stdout, /content changed/, 'the loop still raises the event it always did');

  const entry = readState(stateFile).urls[site.url];
  assert.equal(typeof entry.lastContentChangedAt, 'string', 'a measured change is stamped, alert or no alert');
  assert.equal(entry.lastTitle, 'Free iPhone!!', 'the title is the part a customer recognises');

  const report = buildReport({ urls: { [site.url]: entry } }, { now: NOW });
  const markdown = renderReportMarkdown(report);
  const site1 = report.sites[0];

  // The verdict does not move. A page served with 200 is up, whatever it says.
  assert.equal(site1.status, 'up');
  assert.equal(site1.uptimePercent, 100);

  // …and the document says what the columns above do not.
  assert.equal(site1.contentChanged, true);
  assert.equal(site1.contentTitle, 'Free iPhone!!');
  assert.match(markdown, /\| Content \|/, 'the table has a content column');
  assert.match(markdown, /🔄 changed/, 'the row marks the change');
  assert.match(markdown, /\*\*1 site\(s\) · 1 up · 0 down · \d+ checks? · 0 failed · 1 content changed\*\*/, markdown);
  assert.match(markdown, /had its page content change since monitoring/, markdown);
  assert.match(markdown, /page title: "Free iPhone!!"/, 'the named line carries the title');
});

test('an unchanged page is reported as stable, and a skipped one is not "stable"', async (t) => {
  const site = await pageFixture(t);
  site.serve('side');
  const { stateFile, options } = tempHome(t, { [site.url]: { ...PASS } });
  await cli(['watch', '--once'], options);
  const measured = readState(stateFile).urls[site.url];

  const steady = buildReport({ urls: { [site.url]: measured } }, { now: NOW });
  assert.equal(steady.sites[0].contentChanged, false);
  assert.match(renderReportMarkdown(steady), /stable · \d+ bytes/);
  assert.doesNotMatch(renderReportMarkdown(steady), /content changed/);

  // The measured second half: a page over the 2 MiB limit is never read, so
  // this pass produces no hash. The byte count on disk is the one from the pass
  // that *did* read it, and the report must not present it as this pass's
  // measurement — `contentReadAt` is what separates the two.
  site.serve('big');
  await cli(['watch', '--once'], options);
  const skipped = readState(stateFile).urls[site.url];
  assert.equal(skipped.lastHash, measured.lastHash, 'a skipped pass writes no new hash');
  assert.equal(skipped.lastContentLength, measured.lastContentLength, 'and no new size');
  assert.equal(skipped.lastContentReadAt, measured.lastContentReadAt, 'nor a new read time');

  const report = buildReport({ urls: { [site.url]: skipped } }, { now: NOW });
  assert.equal(report.sites[0].contentBytes, measured.lastContentLength);
  assert.equal(report.sites[0].contentReadAt, measured.lastContentReadAt, 'the report says when that reading was taken');

  // A site whose page was never read at all: `—`, never "stable", never 0.
  const never = buildReport({ urls: { [site.url]: { ...PASS } } }, { now: NOW });
  assert.equal(never.sites[0].contentBytes, null);
  assert.match(renderReportMarkdown(never), /\| — \|/);
});

test('the JSON and the table are the same reading, and the license key is still absent', async (t) => {
  const site = await pageFixture(t);
  site.serve('defaced');
  const { stateFile, options } = tempHome(t, { [site.url]: { ...PASS } });
  await cli(['watch', '--once'], options);
  site.serve('side');
  await cli(['watch', '--once'], options);

  const { stdout } = await cli(['report', '--json'], options);
  const json = JSON.parse(stdout);
  const site1 = json.sites[0];
  const markdown = await cli(['report'], options).then(r => r.stdout);

  // Additive fields only. `contentBytes` keeps its name and its meaning (the
  // size the last reading measured), so an existing consumer is untouched.
  assert.equal(site1.contentBytes, readState(stateFile).urls[site.url].lastContentLength);
  assert.equal(site1.contentChanged, true);
  assert.equal(typeof site1.contentChangedAt, 'string');
  assert.equal(typeof site1.contentReadAt, 'string');
  assert.equal(typeof site1.contentNote, 'string');
  assert.ok(markdown.includes(site1.contentNote), 'the named line is the JSON sentence, not a second one');

  // The report's own privacy rule survives a column that quotes the page: the
  // hash and the license key are still not in the document.
  assert.ok(!markdown.includes(readState(stateFile).urls[site.url].lastHash), 'no content hash in the report');
  assert.ok(!stdout.includes('a'.repeat(32)), 'no license key in the JSON');
  assert.ok(!markdown.includes('deskuptime-agency'), 'no device id in the report');
});

test('two changed sites are counted and named in the plural', async (t) => {
  const first = await pageFixture(t);
  const second = await pageFixture(t);
  first.serve('defaced');
  second.serve('defaced');
  const { options } = tempHome(t, { [first.url]: { ...PASS }, [second.url]: { ...PASS } });
  // A pass, then a rewrite, then another rewrite, so both entries carry a real
  // measured change from a real loop.
  await cli(['watch', '--once'], options);
  first.serve('side');
  second.serve('side');
  await cli(['watch', '--once'], options);
  first.serve('defaced');
  second.serve('defaced');
  await cli(['watch', '--once'], options);

  const { stdout } = await cli(['report'], options);
  assert.match(stdout, /2 sites have had its page content change/, stdout);
  assert.match(stdout, /2 content changed/);
  assert.equal(readState(join(options.HOME, '.deskuptime', 'state.json')).urls[first.url].lastHash.length, 64, 'the fixture really was monitored');
});
