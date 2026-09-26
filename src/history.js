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
function historyFileFrom(options = {}) {
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
 * `dayKey` deliberately falls back to today for an unreadable value, which is
 * right for a bucket being written and wrong here: an unreadable pass time must
 * not be read as "checked today". A pass dated beyond today is not inside the
 * window either — it is clock skew, and the report already has a word for the
 * age of a skew we cannot place.
 */
function passDayInWindow(lastChecked, from, to) {
  if (typeof lastChecked !== 'string' || !lastChecked) return null;
  const parsed = Date.parse(lastChecked);
  if (Number.isNaN(parsed)) return null;
  const day = dayKey(new Date(parsed));
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
  const passDay = passDayInWindow(lastChecked, from, to);
  const buckets = history?.urls?.[url];
  if (!buckets || typeof buckets !== 'object') return emptyWindow({ days, from, to, passDay });
  let checks = 0;
  let failures = 0;
  let recordedDays = 0;
  let first = null;
  for (const [day, bucket] of Object.entries(buckets)) {
    if (!DAY_KEY.test(day) || day < from || day > to) continue;
    const dayChecks = counter(bucket?.checks);
    if (dayChecks === 0) continue;
    recordedDays++;
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
  };
}

export function loadHistory(options = {}) {
  const file = historyFileFrom(options);
  if (!existsSync(file)) return emptyHistory();
  try {
    return normalizeHistory(JSON.parse(readFileSync(file, 'utf-8')));
  } catch {
    return emptyHistory();
  }
}

/** Same discipline as the state file: 0600 in a 0700 dir, written atomically. */
export function saveHistory(history, options = {}) {
  const file = historyFileFrom(options);
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
