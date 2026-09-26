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
