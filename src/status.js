export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Days before expiry at which a certificate counts as "renew it soon".
 *
 * One definition, because three surfaces report the same certificate: `check`
 * (summarize), `watch` (the latched ssl_warning event) and the client report.
 * They used to hardcode 14 in two files and use no threshold at all in the
 * report, so a bureau forwarding the report to a customer could not see which
 * site needed a certificate.
 */
export const SSL_WARN_DAYS = 14;

/**
 * True only for a known, finite, non-negative number of days inside the window.
 * A negative count is not a certificate that expired — it is a corrupt or
 * hand-edited state file, and a client report must not render it as "renew now".
 */
export function isSslExpiringSoon(validDays) {
  return Number.isFinite(validDays) && validDays >= 0 && validDays <= SSL_WARN_DAYS;
}

/**
 * How long a certificate has been expired, in whole days. `0` means it lapsed
 * today. `null` when the expiry itself is unknown, which is not the same as
 * "not expired" — see `readSslState`.
 */
function expiredDaysCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * One reading of a certificate, shared by every surface that shows one.
 *
 * `check`, `watch --status`, `status`, the client report and the GitHub Action
 * all answer the same two questions about the same certificate: is it inside the
 * renewal window, and has it already lapsed. The checker computed both
 * (`isExpired` from the certificate's own `validTo`) and **no surface read
 * `isExpired`** — `validDays` was clamped to `Math.max(0, …)`, so a certificate
 * that lapsed on 1 February 2020 and one expiring tonight both rendered as
 * `0d ⚠️` / "renew soon". Measured against a real expired certificate:
 *
 *   checkSSL  -> {"validDays":0,"isExpired":true,"expiresSoon":true}
 *   `check`   ->  🔒 SSL:  0d ✅   (and `0d ⚠️` once inside the window)
 *
 * For a bureau whose headline feature is expiry warnings, "renew soon" about a
 * certificate that broke the site last week is the worst possible answer, and it
 * is the one a customer reads.
 *
 * So the facts are decided here, once, from whatever a caller has:
 *
 *   - `days` is only a day count when it is finite and non-negative. A negative
 *     is a corrupt or hand-edited state file, not an expired certificate.
 *   - `expired` is decided by the checker's own `isExpired` (or by an explicit
 *     `expiredDays`), never by `days === 0`. A certificate expiring tonight is
 *     not expired, and conflating the two is the bug this replaces.
 *   - `expiringSoon` is false for an expired certificate: a lapsed certificate
 *     is not "renew soon", it is broken, and the two must not share a message.
 *
 * Callers pick their own icon and punctuation and cannot re-decide any of it.
 *
 * @param {object} ssl — `{ days, expired, expiredDays }`; `days` is the
 *   checker's `validDays` or the state entry's `sslValidDays`.
 */
export function readSslState(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : {};
  const days = Number.isFinite(value.days) && value.days >= 0 ? Math.floor(value.days) : null;
  const expiredDays = expiredDaysCount(value.expiredDays);
  const expired = value.expired === true || expiredDays !== null;
  return {
    days,
    expired,
    expiredDays,
    expiringSoon: !expired && isSslExpiringSoon(days),
    // A field that was present but unreadable is reported as unknown; a field
    // that was never there says nothing at all, so plain-HTTP monitoring does
    // not grow a column of dashes.
    unreadable: value.days !== undefined && value.days !== null && days === null && !expired,
  };
}

/**
 * The fixed wording for a lapsed certificate, in one place: `expired 12d ago`,
 * `expired today`, or an honest "unknown" when only the fact is known.
 */
export function expiredNote(expiredDays) {
  if (expiredDays === null) return 'expired — expiry date unknown';
  return expiredDays === 0 ? 'expired today' : `expired ${expiredDays}d ago`;
}

/**
 * How old the newest completed pass may be before a report stops presenting it
 * as current.
 *
 * A report says "3 up · 0 down" about the *last* pass, not about a moment in
 * time — and nothing in the report re-checks anything. If the watch loop died,
 * a site checked six weeks ago looks exactly like one checked eight minutes
 * ago, so a bureau forwarding the report tells a customer their site is healthy
 * on the strength of a measurement that long expired. Two days tolerates a
 * daily cron without crying wolf, and is far below the point where a customer
 * would be misled.
 */
export const STALE_AFTER_DAYS = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Age in ms of the newest completed pass, or null when the state file does not
 * say when that pass ran.
 *
 * A timestamp in the future is clock skew or a wrong system clock, not old
 * data, so it is reported as a negative age rather than invented into an
 * outage. The report prints the exact timestamp either way.
 */
export function checkAgeMs(lastChecked, now = new Date()) {
  if (typeof lastChecked !== 'string' || !lastChecked) return null;
  const parsed = Date.parse(lastChecked);
  if (Number.isNaN(parsed)) return null;
  return now.getTime() - parsed;
}

/**
 * True only when a pass is known to have run and is older than the window.
 *
 * Absent `lastChecked` is *not* stale: the report already shows such a site as
 * "not checked yet", and flagging it twice would say nothing new. A timestamp
 * that is present but unreadable *is* stale — a pass was recorded and we cannot
 * show that it is current, which is exactly what a client report must not do.
 */
export function isCheckStale(lastChecked, now = new Date()) {
  if (typeof lastChecked !== 'string' || !lastChecked) return false;
  if (Number.isNaN(Date.parse(lastChecked))) return true;
  return checkAgeMs(lastChecked, now) > STALE_AFTER_DAYS * MS_PER_DAY;
}

/** Whole days since the last pass, for display. `null` when it is unknown. */
export function checkAgeDays(lastChecked, now = new Date()) {
  const age = checkAgeMs(lastChecked, now);
  if (age === null) return null;
  return Math.max(0, Math.floor(age / MS_PER_DAY));
}

/** A recorded pass time we can order, or null when it is absent or unreadable. */
function passTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is `candidate` the newer of two recorded passes?
 *
 * `watch` merges the state file on disk into the pass it is about to run, so
 * that two invocations — a manual `deskuptime watch <url>` and a cron `watch
 * --once` — cannot lose each other's newest observation. That merge used to
 * compare the two timestamps as *strings*, which is only accidentally right.
 * Measured, with two timestamps a real state file can hold:
 *
 *   '2026-09-26T01:00:00+02:00' > '2026-09-25T23:30:00Z'   // string: true
 *   Date.parse difference                                  // -30 min
 *
 * The second is 30 minutes *newer* and the string says it is older, because
 * `T…Z` and `T…+02:00` only sort correctly when every timestamp is UTC with the
 * same precision. The merge therefore kept the *older* entry, and it is a
 * whole entry: `wasUp`, the status code, the certificate days, the uptime
 * counters and the age all rolled back to the older pass and were written
 * onward. A site that had recovered to UP read as DOWN again, and
 * `watch --status` reported the older age.
 *
 * Timezones and precision are also what make it reachable rather than
 * theoretical. `toISOString()` always writes `…THH:mm:ss.sssZ`, which is why
 * DeskUptime's own writes happened to sort correctly — but a state file
 * restored from a backup, hand-edited, or written by another tool carries
 * offsets or second precision, and a second-precision stamp is a *second*
 * wrong in the same way: `…:00Z` sorts after `…:00.500Z` while being older.
 *
 * An unreadable timestamp is not a time at all, so it can never displace a
 * readable one. It used to: letters sort after digits, so a hand-edited
 * `lastChecked: "yes"` won the merge over a real timestamp and hid a genuine
 * pass.
 */
export function isNewerPass(candidate, reference) {
  const candidateTime = passTime(candidate);
  const referenceTime = passTime(reference);
  if (candidateTime === null) return false;
  if (referenceTime === null) return true;
  return candidateTime > referenceTime;
}

/**
 * The one decision behind every status word in this product: what does the
 * state file say about a site?
 *
 * It used to be written twice, byte for byte, in `readEntry` below and in
 * `siteStatus()` in the client report — and the report cannot call `readEntry`
 * for it, because the report also needs `addedAt` and the counters that
 * `readEntry` does not read. Two identical owners is a bug waiting to happen:
 * the report would have kept saying UP for a state file the terminal calls
 * `unknown`, in the one document a bureau forwards to a customer.
 *
 * Only the two booleans count. `"true"`, `1`, `null` and a missing field are
 * all `unknown`, because a state file that was hand-edited, restored from a
 * backup or half-written cannot be read as a claim about the site.
 *
 * The five surfaces then word this one decision five ways — `✅ up`/`❔ unknown`
 * (watch --status), `✅`/`·` (watch), `UP (200)`/`not checked yet` (the client
 * report), `✅ UP` (the Action's job summary) and `up`/`down`/`unknown` in both
 * JSON payloads. Those are layouts, not rival claims: the Action's summary and
 * `report --json` are read outside this repo, so unifying the *wording* would
 * break consumers while fixing nothing. What must stay single is the decision.
 */
export function verdictFor(wasUp) {
  return wasUp === true ? 'up' : wasUp === false ? 'down' : 'unknown';
}

/**
 * One reading of a state-file entry, shared by every surface that prints one.
 *
 * Three facts about a monitored site are all in `state.urls[url]`: whether the
 * last pass was up, which status code it saw, and how many days the certificate
 * has left. Two surfaces print that entry — `deskuptime watch --status` and the
 * URL list on `deskuptime status` — and each used to decide those facts on its
 * own instead of asking the rules above. Measured on a state file, that gave:
 *
 *   - a pass from 41 days ago printing `✅ up` with no age, while the client
 *     report built from the same file said `⚠️ stale — last check 41 d ago`;
 *   - a certificate with 9 days left printing `SSL 9d` in plain text, while
 *     `check`, `watch` and the report all warn inside the 14-day window;
 *   - `sslValidDays` interpolated straight into the terminal, so escape bytes in
 *     a hand-edited or restored state file printed as themselves (`^[[2J`), and
 *     an unusable value printed as a bare `SSL -2d` where the report shows `—`.
 *
 * So the claims are decided here, once, and only the layout is left to each
 * surface: a caller picks its own icon and separator and cannot re-decide
 * whether a certificate is expiring or how old a pass is.
 *
 * Every value returned is a fixed word or a checked number — nothing from the
 * state file is carried through as text — so an unusable field can only become
 * `null`, never a claim the caller did not check.
 */
export function readEntry(entry, { now = new Date() } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const ssl = readSslState({
    days: value.sslValidDays,
    expired: value.sslExpired,
    expiredDays: value.sslExpiredDays,
  });
  const stale = isCheckStale(value.lastChecked, now);
  const ageDays = checkAgeDays(value.lastChecked, now);

  return {
    verdict: verdictFor(value.wasUp),
    statusCode: Number.isInteger(value.lastStatus) ? value.lastStatus : null,
    sslDays: ssl.days,
    sslExpired: ssl.expired,
    // Without a leading separator: the two surfaces punctuate differently, but
    // neither can change what is being said about the certificate.
    sslNote: ssl.expired
      ? `SSL 🔴 ${expiredNote(ssl.expiredDays)}`
      : ssl.days === null
        ? (ssl.unreadable ? 'SSL —' : '')
        : ssl.expiringSoon ? `SSL ⚠️ ${ssl.days}d — renew soon` : `SSL ${ssl.days}d`,
    ageDays,
    stale,
    staleNote: stale
      ? (ageDays === null ? 'stale — last check unreadable' : `stale — last check ${ageDays} d ago`)
      : '',
  };
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function invalidHttpUrls(urls) {
  return urls.filter(url => !isHttpUrl(url));
}

export function assertValidHttpUrls(urls) {
  const invalidUrls = invalidHttpUrls(urls);
  if (invalidUrls.length > 0) {
    throw new TypeError(`Invalid URL: ${invalidUrls.join(', ')}`);
  }
}

export function isHealthyStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400;
}

export function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;

  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { errorType: 'timeout', error: 'Request timed out' };
  }
  if (code === 'ECONNREFUSED') {
    return { errorType: 'connection_refused', error: 'Connection refused' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { errorType: 'dns_error', error: cause.message || 'Host could not be resolved' };
  }

  return {
    errorType: 'network_error',
    error: cause?.message || error?.message || 'Network request failed',
  };
}
