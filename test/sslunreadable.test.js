/**
 * A site that answers but whose certificate cannot be read is not a site
 * without a certificate.
 *
 * `checkSSL` has answered `{ error: … }` since P0-3 whenever a handshake could
 * not be finished, and `action.yml:137` has counted that as a failure since
 * P1-63. Nothing else read it. The watch pass asked the owner for a day count
 * and a lapse, got neither, and stored nothing — so a site that answered 200
 * over TLS and then failed its own handshake was stored exactly like a plain
 * HTTP URL, and every later surface printed the plain-HTTP dash.
 *
 * Measured 2026-09-28 through the real watch loop, against a site slow enough
 * that the request leg's budget was spent before the certificate leg's second
 * handshake began (no code changed):
 *
 *   checkSSL    -> {"error":"SSL handshake timed out"}
 *   watch --once  baseline recorded: UP (200) — 10674ms
 *   state.json    no sslValidDays, no sslExpired, no sslError
 *   status        ✅ https://localhost:60656/ (200) · 74 bytes
 *   report        | … | UP (200) | 100% (1 check) | 10674 ms | — | … |
 *   report --json "sslDaysRemaining": null, "sslIssuer": null
 *
 * The `—` in the client report is that document's own word for "this URL cannot
 * have a certificate", so a bureau sent a customer a site with an unreadable
 * certificate as a site with none. These tests pin the fix at the owner, at the
 * writer, and on all four surfaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEntry, readSslState, sslUnreadableNote } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';
import { runPass } from '../src/watch.js';

const URL_SITE = 'https://kunde.dk/';
const NOW = new Date('2026-09-28T12:00:00.000Z');
const ERROR = 'SSL handshake timed out';

function tempStateFile(t, tag = 'sslunreadable') {
  const home = mkdtempSync(join(tmpdir(), `deskuptime-${tag}-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return join(home, '.deskuptime', 'state.json');
}

/** The state a real pass wrote for the measurement above. */
function answeredButUnreadable(extra = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: '2026-09-28T11:00:00.000Z',
    checks: 12,
    checksUp: 12,
    lastResponseMs: 10674,
    sslError: ERROR,
    ...extra,
  };
}

// --- the owner --------------------------------------------------------------

test('readSslState: a failed handshake is its own state, not a missing certificate', () => {
  const failed = readSslState({ error: ERROR });
  assert.equal(failed.failed, true);
  assert.equal(failed.measured, false, 'no certificate was read, so nothing may be claimed');
  assert.equal(failed.days, null);
  assert.equal(failed.expired, false);
  assert.equal(failed.expiringSoon, null, 'a claim about a measurement that never happened');
  assert.equal(failed.error, ERROR);
  assert.match(failed.failedNote, /could not be read/);
  assert.match(failed.failedNote, new RegExp(ERROR));

  // The three neighbours it must not be confused with, all silent as before.
  assert.equal(readSslState({}).failed, false, 'a URL that cannot have a certificate');
  assert.equal(readSslState({}).failedNote, '');
  assert.equal(readSslState({ days: null, expired: true, expiredDays: 3 }).failed, false, 'a lapsed certificate is measured');
  assert.equal(readSslState({ days: 40 }).failed, false, 'a reading is measured');
  assert.equal(readSslState({ days: 40, error: ERROR }).failed, false, 'a reading plus an error is still the reading');
  assert.equal(readSslState({ error: '   ' }).failed, false, 'a blank reason is no reason');
  assert.equal(readSslState({ error: 42 }).failed, false, 'a non-string is not a reason');
});

test('sslUnreadableNote: the reason is the server\'s text, so it is flattened once', () => {
  assert.equal(
    sslUnreadableNote('ERR: \u001b[31mboom\u001b[0m'),
    'could not be read — the site answered, but its certificate did not: ERR: boom',
    'a control sequence from a TLS stack must not reach a document a bureau sends on',
  );
  // The state is the finding; the reason is a courtesy, so it may be missing.
  assert.equal(
    sslUnreadableNote(null),
    'could not be read — the site answered, but its certificate did not',
  );
});

// --- the two terminal lists -------------------------------------------------

test('both lists name a certificate that could not be read', () => {
  const entry = readEntry(answeredButUnreadable(), { url: URL_SITE, now: NOW });
  assert.equal(entry.verdict, 'up', 'the site answered 200 — this is not an outage');
  assert.match(entry.sslNote, /SSL ⚠️ could not be read/);
  assert.match(entry.sslNote, new RegExp(ERROR));

  // …and a site that genuinely has no certificate stays silent, as it always was.
  assert.equal(readEntry(answeredButUnreadable({ sslError: undefined }), { url: URL_SITE, now: NOW }).sslNote, '');
});

// --- the writer -------------------------------------------------------------

test('the watch pass stores the reason, and a later reading clears it', async (t) => {
  const stateFile = tempStateFile(t);
  const state = { urls: { [URL_SITE]: { wasUp: true, lastStatus: 200, checks: 10, checksUp: 10 } } };
  await runPass(state, {
    stateFile,
    // What `checkUrl` measured in the run above: the request leg answered 200,
    // the certificate leg came back with nothing but a reason.
    check: async (url) => ({
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 10674,
      finalUrl: url,
      ssl: { error: ERROR },
      content: { measured: false },
    }),
  });

  const stored = JSON.parse(readFileSync(stateFile, 'utf8')).urls[URL_SITE];
  assert.equal(stored.wasUp, true, 'the site answered — this is not an outage');
  assert.equal(stored.sslError, ERROR, 'the reason the pass threw away is now the state');
  assert.equal(stored.sslValidDays, undefined, 'no day count was read, so none is claimed');
  assert.equal(stored.sslExpired, undefined);

  // A later pass that reads the certificate clears the stale failure, so the
  // countdown and the note beside it cannot contradict each other.
  await runPass({ urls: { [URL_SITE]: { ...stored } } }, {
    stateFile,
    check: async (url) => ({
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 40,
      finalUrl: url,
      ssl: { validDays: 42, isExpired: false, expiredDays: null },
      content: { measured: false },
    }),
  });
  const after = JSON.parse(readFileSync(stateFile, 'utf8')).urls[URL_SITE];
  assert.equal(after.sslValidDays, 42);
  assert.equal(after.sslError, undefined, 'a fresh reading retires the old failure');
});

// --- the client report ------------------------------------------------------

test('the client report separates "unreadable" from "no certificate"', () => {
  const report = buildReport({ urls: { [URL_SITE]: answeredButUnreadable() } }, { now: NOW });
  const site = report.sites[0];

  assert.equal(site.sslUnreadable, true);
  assert.equal(site.sslDaysRemaining, null);
  assert.equal(site.sslExpiringSoon, null, 'a certificate that was not read is not "renew soon"');
  assert.equal(site.sslExpired, false);
  assert.equal(site.sslMayHaveExpired, false, 'disjoint from a lapsed reading');
  assert.equal(site.sslUnreadableNote, 'could not be read — the site answered, but its certificate did not: SSL handshake timed out');
  assert.equal(site.sslUnreadableReason, ERROR, 'the bare reason, for a line and for a script');
  assert.equal(report.summary.sslUnreadable, 1);
  assert.equal(report.summary.sslExpiringSoon, 0);
  assert.equal(report.summary.sslMayHaveExpired, 0);

  // The neighbour: a plain-HTTP URL stays `—` and stays uncounted.
  const plain = buildReport({ urls: { 'http://kunde.dk/': answeredButUnreadable({ sslError: undefined, lastStatus: 200 }) } }, { now: NOW });
  assert.equal(plain.sites[0].sslUnreadable, false);
  assert.equal(plain.summary.sslUnreadable, 0);
  assert.match(renderReportMarkdown(plain), /\| — \|/);

  const md = renderReportMarkdown(report);
  assert.match(md, /\| ⚠️ could not be read \|/, 'the column a customer reads must not say "no certificate"');
  assert.doesNotMatch(md, /\| — \| stable/, 'the unreadable row is not the plain-HTTP row');
  assert.match(md, /1 site answered but its certificate could not be read/);
  assert.match(md, new RegExp(ERROR), 'the reason is named, not just the state');
  assert.match(md, /1 SSL could not be read/, 'the summary line counts it');
  assert.doesNotMatch(md, /could not be read — the site answered[\s\S]*could not be read — the site answered/,
    'the named line names the reason, it does not repeat the sentence around it');

  // A blank reason is still a state, and the line still says so.
  const noReason = renderReportMarkdown(buildReport({ urls: { [URL_SITE]: answeredButUnreadable({ sslError: 'x' }) } }, { now: NOW }));
  assert.match(noReason, /could not be read/);
});
