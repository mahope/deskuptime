/**
 * history.js — daily uptime buckets, so a client report can say "last 30 days"
 * instead of "since I started watching".
 *
 * Why a separate file: `state.json` is rewritten on every pass and holds the
 * license key. History grows with time, so mixing the two would make the state
 * file unbounded and would put counters next to the license record. This file
 * holds counters only.
 *
 * What is deliberately *not* stored per day: page content, response headers,
 * status codes, error strings, IP addresses and anything about the license. A
 * day bucket is two integers, which is what makes `rm ~/.deskuptime/history.json`
 * a complete deletion of the history (docs/agency-report.md §5).
 *
 * Bounded by construction: at most `HISTORY_DAYS` day buckets per URL and at
 * most `MAX_HISTORY_URLS` URLs, both pruned on write. A watch loop running for a
 * year therefore produces a file of a fixed, small size.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, chmodSync } from 'fs';
import { dirname, join, posix, win32 } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { passAge } from './status.js';

export const HISTORY_VERSION = 1;
/** Kept days per URL. The report window is 30 days; the slack avoids a window
 *  that is empty because a day has not been recorded yet. */
export const HISTORY_DAYS = 35;
export const DEFAULT_WINDOW_DAYS = 30;
/** Hard cap on URLs, so adding and dropping sites cannot grow the file forever. */
export const MAX_HISTORY_URLS = 500;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Beside `getStateFile()` in watch.js, and asserted to be so by
 * test/history.test.js — the history must never land in a different directory
 * than the state it describes.
 */
export function getHistoryFile({ env = process.env, platform = process.platform } = {}) {
  const home = platform === 'win32'
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || homedir();
  const path = platform === 'win32' ? win32 : posix;
  return path.join(home, '.deskuptime', 'history.json');
}

/**
 * An explicit `historyFile` wins; otherwise the history sits in the same
 * directory as the state it describes — including when a caller (or a test)
 * redirects the state to a temporary directory, which must not silently send
 * history to the real home directory.
 */
export function historyFileFrom(options = {}) {
  if (options.historyFile) return options.historyFile;
  if (options.stateFile) return join(dirname(options.stateFile), 'history.json');
  return getHistoryFile(options);
}

export function emptyHistory() {
  return { version: HISTORY_VERSION, urls: {} };
}

/** A hand-edited or half-written history file must read as empty, never crash. */
export function normalizeHistory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyHistory();
  const source = value.urls;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return emptyHistory();
  const urls = {};
  for (const [url, days] of Object.entries(source)) {
    if (typeof url !== 'string' || !url || !days || typeof days !== 'object' || Array.isArray(days)) continue;
    const kept = {};
    for (const [day, bucket] of Object.entries(days)) {
      if (!DAY_KEY.test(day) || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const checks = counter(bucket.checks);
      if (checks === 0) continue;
      // `failures` is clamped to `checks`: a hand-edited bucket can then never
      // produce negative uptime in a report a customer reads.
      kept[day] = { checks, failures: Math.min(counter(bucket.failures), checks) };
    }
    if (Object.keys(kept).length > 0) urls[url] = kept;
  }
  return { version: HISTORY_VERSION, urls };
}

function counter(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** UTC calendar day, so a pass at 23:30 and one at 00:30 never share a bucket. */
export function dayKey(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return iso.slice(0, 10);
}

function cutoffKey(now, days) {
  return dayKey(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
}

/**
 * Fold one completed pass into today's bucket. A failed pass counts as a check:
 * it ran, and the client is entitled to see it in the denominator.
 */
export function recordHistoryPass(history, url, result, { now = new Date() } = {}) {
  if (typeof url !== 'string' || !url) return null;
  if (!history.urls || typeof history.urls !== 'object') history.urls = {};
  const days = history.urls[url] || (history.urls[url] = {});
  const key = dayKey(now);
  const bucket = days[key] || (days[key] = { checks: 0, failures: 0 });
  bucket.checks = counter(bucket.checks) + 1;
  if (result?.healthy !== true) bucket.failures = counter(bucket.failures) + 1;
  return bucket;
}

/** Drop everything outside the retention window, and URLs past the hard cap. */
export function pruneHistory(history, { now = new Date(), days = HISTORY_DAYS } = {}) {
  if (!history?.urls || typeof history.urls !== 'object') return history;
  const cutoff = cutoffKey(now, days);
  for (const [url, buckets] of Object.entries(history.urls)) {
    if (!buckets || typeof buckets !== 'object') { delete history.urls[url]; continue; }
    for (const day of Object.keys(buckets)) {
      if (!DAY_KEY.test(day) || day < cutoff) delete buckets[day];
    }
    if (Object.keys(buckets).length === 0) delete history.urls[url];
  }
  const urls = Object.keys(history.urls);
  if (urls.length > MAX_HISTORY_URLS) {
    for (const url of urls.slice(0, urls.length - MAX_HISTORY_URLS)) delete history.urls[url];
  }
  return history;
}

/**
 * The day a pass belongs to, when that day falls inside the window — otherwise
 * `null`.
 *
 * `passMs` is the instant the pass was recorded, as `passAge` in status.js
 * decided it. This function used to parse `lastChecked` itself, which made it a
 * fifth independent owner of "when did the pass happen", and it got the one
 * case wrong that the owner had already settled: a pass dated ahead of this
 * machine's clock. `dayKey` deliberately falls back to today for an unreadable
 * value, which is right for a bucket being written and wrong here — an
 * unreadable pass time must not be read as "checked today" — and a pass dated
 * beyond today is not inside the window either, because it is clock skew.
 *
 * The old version expressed both of those rules as a *day* comparison, which
 * got them right only for a skew big enough to move the date. For a clock 6 h
 * fast, whose UTC day is still today, the pass came back as a day inside the
 * window, and the report told the customer their last check was missing from
 * the history file — a claim about their own files, in a document they read,
 * about a pass that had not happened yet. At 23 h of skew the very same state
 * file said "no pass in the last 1 d". The owner now answers the only question
 * this needs answered: is there an instant that can be placed on a day at all.
 */
function passDayInWindow(passMs, from, to) {
  if (passMs === null) return null;
  const day = dayKey(new Date(passMs));
  return day >= from && day <= to ? day : null;
}

/**
 * No recorded day in the window — or a pass the state file knows about and the
 * history file does not.
 *
 * Measured through the real `report` on a state file whose newest pass was 14
 * minutes old while its history file held no bucket for that day, the window
 * column claimed there had been no pass at all:
 *
 *   | https://kunde.dk/ | UP (200) | 100% (4 checks) | — (no pass in the last 30 d) | … | 09:18 UTC |
 *
 * One row, two claims about the same site, and the customer is the one who reads
 * it. The two files disagree for ordinary reasons, all of them reachable on an
 * install that works: `runPass` writes the history in a `try/catch` and keeps
 * monitoring when it fails (a full disk, a read-only home), and an agency moving
 * monitoring to a new machine copies the one file the README names —
 * `state.json` — and not `history.json`. So the window is not "no data about
 * this site"; it is *this source* having no data, and the report can see the
 * difference because it holds both.
 *
 * `passNotRecorded` says it, so the machine surface can reproduce the sentence
 * instead of inferring it. The shape is the same either way: `uptimePercent`
 * stays `null`, because there is genuinely no share to compute.
 *
 * `passesAfterLastPass` is the mirror of that disagreement, and it is measured
 * the same way. `emptyWindow` is the history file missing a pass the state file
 * demonstrably ran; this is the state file's last pass predating days the
 * history file says were checked. Measured through the real `report` on a site
 * whose newest pass was 8 days old while its history file held ten recorded
 * days:
 *
 *   | http://c.dk/ | UP (200) ⚠️ stale — last check 8 d ago | 100% (3 checks) | 100% (10 recorded d, 240 checks) | … |
 *
 * and above the table, `**Monitoring data is stale for 1 site — no pass in the
 * last 2 days:** http://c.dk/ (8 d)`. One row claiming 240 checks, a summary
 * claiming no pass in two days, in the document an agency forwards. The 240 is
 * not a fabricated number — it is what the other file holds — but a client
 * cannot see which file is behind, and the two claims cannot both be true.
 *
 * It counts **whole recorded days**, never hours, and never triggers on a pass
 * that is merely minutes late: a clock that disagrees with itself inside one day
 * is not a disagreement worth a line in a customer document. A pass outside the
 * window is not evidence of anything, so it counts `0` rather than guessing —
 * the honest reading there is that the site is simply older than the window.
 */
function emptyWindow({ days, from, to, passDay }) {
  if (!passDay) return null;
  return {
    days: 0,
    windowDays: days,
    checks: 0,
    failures: 0,
    uptimePercent: null,
    from: passDay < from ? from : passDay,
    to,
    passNotRecorded: true,
    // Nothing is recorded, so nothing can postdate the pass. Stated rather than
    // left out, so a consumer branches on the field and not on its absence.
    passesAfterLastPass: 0,
  };
}

/**
 * Uptime inside the reporting window, as a whole number of recorded days.
 * `uptimePercent` comes from report.js, so the window and the lifetime figure
 * are computed by the same definition and cannot disagree.
 *
 * `lastChecked` is the pass the state file records for this URL. It is only ever
 * used to say that the history file is missing a pass that demonstrably ran —
 * see `emptyWindow`.
 */
export function windowSummary(history, url, { days = DEFAULT_WINDOW_DAYS, now = new Date(), uptimePercent, lastChecked } = {}) {
  const from = cutoffKey(now, days);
  const to = dayKey(now);
  // Asked of the one owner of a pass time, so a pass this machine's clock puts
  // in the future can never be counted as a day inside a past window.
  const passDay = passDayInWindow(passAge(lastChecked, now).passMs, from, to);
  const buckets = history?.urls?.[url];
  if (!buckets || typeof buckets !== 'object') return emptyWindow({ days, from, to, passDay });
  let checks = 0;
  let failures = 0;
  let recordedDays = 0;
  let first = null;
  const recorded = [];
  for (const [day, bucket] of Object.entries(buckets)) {
    if (!DAY_KEY.test(day) || day < from || day > to) continue;
    const dayChecks = counter(bucket?.checks);
    if (dayChecks === 0) continue;
    recordedDays++;
    recorded.push(day);
    checks += dayChecks;
    failures += Math.min(counter(bucket?.failures), dayChecks);
    if (!first || day < first) first = day;
  }
  if (recordedDays === 0) return emptyWindow({ days, from, to, passDay });
  const percent = typeof uptimePercent === 'function' ? uptimePercent({ checks, checksUp: checks - failures }) : null;
  return {
    days: recordedDays,
    windowDays: days,
    checks,
    failures,
    uptimePercent: percent,
    from: first,
    to,
    // Always present, so a consumer can branch on the field without first
    // having to prove it can be absent. The disagreement case is `emptyWindow`.
    passNotRecorded: false,
    // The other direction of the same two-file disagreement, counted in whole
    // days so a pass that is minutes late cannot trigger it. See
    // `passesAfterLastPass` below for what the number is and is not.
    passesAfterLastPass: passDay === null ? 0 : recorded.filter(day => day > passDay).length,
  };
}

/**
 * How much of the window a site actually covers — and whether that is less than
 * the window the column claims.
 *
 * Measured through the real `report`, on a history file with one whole day
 * missing in the middle of the window:
 *
 *   | https://gab.dk/ | UP (200) | 97.5% (40 checks, 1 failed) | 95.83% (28 recorded d, 1344 checks, 56 failed) | … |
 *
 * `95.83%` and `30` appear in one cell, and the footnote defines the column as
 * "the passes recorded in the last 30 days". A customer reads that as 30 days.
 * Two of them were never monitored — the agency's cron was dead — and the only
 * warning was the word "recorded", in a table cell among other parentheses.
 *
 * A site that was *added* inside the window has the same shape and is not a gap:
 * 3 recorded days out of 30 is the whole truth about a site watched since
 * Tuesday. So the rule needs two more facts, and both are in the files the
 * report already reads:
 *
 *   - the site was already monitored when the window opened (`monitoringSince`
 *     falls on or before the window's first day), so the days inside the window
 *     were days it should have had; and
 *   - the history file was already recording when the window opened (its own
 *     earliest day is on or before the window's first day), so the missing days
 *     are not explained by the file being new.
 *
 * That second condition is the one that keeps this from crying wolf. Daily
 * buckets only started being written when `report` shipped; an agency that has
 * monitored the same five sites for a year and upgrades has 1 recorded day out
 * of 30 for all five, and accusing them of 29 missing days would be a claim
 * about their monitoring that the files cannot support.
 *
 * A window with no share at all is not a gap: `windowCell` already names that
 * case ("no pass in the last N d", or the missing-pass disagreement), and a line
 * that repeats the cell is noise.
 */
export function windowCoverage({ window, history, monitoringSince, days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const recordedDays = Number.isInteger(window?.days) ? window.days : 0;
  const base = { recordedDays, windowDays: days, missingDays: null, gap: false };
  if (!window || window.passNotRecorded) return base;
  if (recordedDays === 0 || recordedDays >= days) return base;
  const from = cutoffKey(now, days);
  // Asked of the one owner of a pass time, like `windowSummary` does; the day
  // format below is this file's own.
  const sinceMs = passAge(monitoringSince, now).passMs;
  if (sinceMs === null) return base;
  if (dayKey(new Date(sinceMs)) > from) return base;
  const earliest = earliestRecordedDay(history);
  if (earliest === null || earliest > from) return base;
  return { ...base, missingDays: days - recordedDays, gap: true };
}

/** The oldest day key anywhere in the file — when this file started recording. */
function earliestRecordedDay(history) {
  let earliest = null;
  for (const buckets of Object.values(history?.urls ?? {})) {
    if (!buckets || typeof buckets !== 'object') continue;
    for (const [day, bucket] of Object.entries(buckets)) {
      if (!DAY_KEY.test(day) || counter(bucket?.checks) === 0) continue;
      if (earliest === null || day < earliest) earliest = day;
    }
  }
  return earliest;
}

/**
 * The history file, and whether it could be read at all.
 *
 * This used to be an empty history, and that is not a safe default for this
 * file. Measured 2026-09-26 through the real CLI with a real local site, a real
 * Pro state file and 30 days of history — a file truncated to half its bytes,
 * which is what a full disk or a killed process leaves behind:
 *
 *   watch --once   →  ✓ all monitored sites OK          (exit 0, nothing on stderr)
 *   history.json   →  2 383 bytes → 147 bytes          (29 recorded d, 41 760
 *                      checks, 12 failures → one bucket, today)
 *   report         →  | …/ | UP (200) | 100% (2 checks) | 100% (1 recorded d, 1 checks) |
 *
 * One pass destroyed a month of evidence and said nothing. The report then
 * signed a client's document with a number read from a file it could not read —
 * and P1-38's window-gap guard, which exists precisely to catch an unrecorded
 * window, cannot see this at all: after the overwrite the file genuinely holds
 * one recorded day, so the gap it looks for is not there.
 *
 * So the reason travels next to the history instead of being swallowed, and the
 * callers that can act on it (the one that writes, and the one that reports) do.
 */
export function readHistoryFile(options = {}) {
  const file = historyFileFrom(options);
  if (!existsSync(file)) return { history: emptyHistory(), unreadable: null };
  try {
    return { history: normalizeHistory(JSON.parse(readFileSync(file, 'utf-8'))), unreadable: null };
  } catch (error) {
    return { history: emptyHistory(), unreadable: { code: error?.code || 'invalid JSON', historyFile: file } };
  }
}

export function loadHistory(options = {}) {
  return readHistoryFile(options).history;
}

/**
 * One sentence for "DeskUptime cannot read the uptime history", so a cron pass,
 * a running loop and the client report cannot each describe the same file
 * differently.
 *
 * The state file's own sentence says "nothing is written over it and nothing is
 * reported from it", and both halves are true here for the same reason: this file
 * is the evidence a bureau sends to a client. A truncated file is replaced by an
 * empty one that looks exactly like a fresh install, and the one command that
 * gets the real 30 days back is `mv` — never `rm`, which would throw away the
 * only copy.
 */
export function historyReadErrorMessage(error, historyFile) {
  const why = error?.code === 'ENOENT' ? 'file not found' : (error?.code || 'invalid JSON');
  return `DeskUptime cannot read the uptime history — ${why} — ${historyFile}. It holds the recorded days the 30-day report column is counted from, so nothing is written over it and no report is built from it. Move it aside to start clean: mv "${historyFile}" "${historyFile}.broken"`;
}

export const EHISTORY_UNREADABLE = 'EHISTORYUNREADABLE';

/**
 * One sentence for "DeskUptime cannot write its own history", so a cron pass and
 * a running loop cannot each describe the same failure differently — the same
 * rule `stateWriteErrorMessage()` follows for the state file, and for the same
 * reason: a full disk or a read-only home must cost the report one column, not
 * take monitoring down. A file we cannot *read* is not a write problem, and
 * telling the user to check free disk space about a truncated file sends them to
 * the wrong place, so that code maps to the read sentence.
 */
export function historyWriteErrorMessage(error, historyFile) {
  if (error?.code === EHISTORY_UNREADABLE) return historyReadErrorMessage(error.readError, historyFile);
  return `Could not write the uptime history — ${error?.code || error?.message || 'unknown error'} — ${historyFile}. Monitoring and alerts keep working; the report's ${DEFAULT_WINDOW_DAYS}-day column is missing today until the file can be written again.`;
}

/** The same check `saveState()` makes on the state file, for the same reason. */
function unreadableHistoryFile(historyFile) {
  if (!existsSync(historyFile)) return null;
  try {
    JSON.parse(readFileSync(historyFile, 'utf-8'));
    return null;
  } catch (error) {
    return { code: error?.code || 'invalid JSON' };
  }
}

/** Same discipline as the state file: 0600 in a 0700 dir, written atomically. */
export function saveHistory(history, options = {}) {
  const file = historyFileFrom(options);
  // Never write over a history file we could not read. See the measurement in
  // `readHistoryFile`: the save above replaces a truncated month with an empty
  // day, and the truncation is the only trace of what was there. The caller gets
  // the read sentence (historyWriteErrorMessage maps this code) and the user
  // keeps the file.
  const unreadable = unreadableHistoryFile(file);
  if (unreadable) {
    const error = new Error(historyReadErrorMessage(unreadable, file));
    error.code = EHISTORY_UNREADABLE;
    error.readError = unreadable;
    throw error;
  }
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* pre-existing dir we may not own */ }
  }
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(history, null, 2), { mode: 0o600 });
    renameSync(temporaryFile, file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}
