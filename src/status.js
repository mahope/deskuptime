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
  // Same rule as the report's SSL cell: only a known, finite, non-negative day
  // count is a number of days. A negative value is a corrupt or hand-edited
  // state file, not a certificate that expired — and a string, a boolean or
  // NaN is not a day count either.
  const sslDays = Number.isFinite(value.sslValidDays) && value.sslValidDays >= 0
    ? value.sslValidDays
    : null;
  // A field that is present but unreadable is reported as unknown, the same as
  // the report's `—`. A field that was never there says nothing at all, so
  // plain-HTTP monitoring does not grow a column of dashes.
  const sslUnknown = sslDays === null && value.sslValidDays !== undefined && value.sslValidDays !== null;
  const stale = isCheckStale(value.lastChecked, now);
  const ageDays = checkAgeDays(value.lastChecked, now);

  return {
    verdict: value.wasUp === true ? 'up' : value.wasUp === false ? 'down' : 'unknown',
    statusCode: Number.isInteger(value.lastStatus) ? value.lastStatus : null,
    sslDays,
    // Without a leading separator: the two surfaces punctuate differently, but
    // neither can change what is being said about the certificate.
    sslNote: sslDays === null
      ? (sslUnknown ? 'SSL —' : '')
      : isSslExpiringSoon(sslDays) ? `SSL ⚠️ ${sslDays}d — renew soon` : `SSL ${sslDays}d`,
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
