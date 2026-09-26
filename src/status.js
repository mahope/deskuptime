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
