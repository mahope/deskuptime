/**
 * deskuptime — Core monitor engine
 *
 * Universal kernel: can run standalone (Node.js), as CLI, or integrated into
 * a Tauri desktop app. Takes an array of URLs, runs all checks, returns results.
 */

import { checkReachability } from './checkers/ping.js';
import { checkSSL, SSL_TIMEOUT_MS } from './checkers/ssl.js';
import { checkContentChange, CONTENT_TIMEOUT_MS } from './checkers/content.js';
import { assertValidHttpUrls, isHealthyStatus } from './status.js';

/**
 * `--timeout` is a budget for the *whole* check, not just the first request.
 *
 * A check is three legs: the reachability request, the TLS handshake and the
 * content read. Each leg has its own default deadline, and without this the
 * flag only bounded the first one — `check --timeout 500` still waited 20 s for
 * a body that never arrived, which is the flag a CI job uses to stay short.
 *
 * A leg never gets more than its own default, so passing `--timeout` cannot make
 * a check slower than it is today, and the floor of 1 ms means an exhausted
 * budget reports an honest timeout instead of running unbounded.
 *
 * With no `--timeout` there is no deadline and every leg keeps its own default.
 */
export function legTimeoutMs(deadline, fallbackMs, now = Date.now()) {
  if (!deadline) return fallbackMs;
  return Math.max(1, Math.min(fallbackMs, deadline - now));
}

/**
 * Run all checks on a single URL
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.contentHash] — optional previous content hash to detect changes
 * @param {number} [opts.timeoutMs] — budget for the whole check (all three legs)
 * @returns {Promise<object>} { url, reachable, healthy, statusCode, responseTimeMs, ssl, content, error? }
 */
export async function checkUrl(url, opts = {}) {
  assertValidHttpUrls([url]);
  // A deadline is only set when the caller gave a budget, so the default path
  // is byte-for-byte what it was before.
  const deadline = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0
    ? Date.now() + opts.timeoutMs
    : null;
  const result = {
    url,
    timestamp: new Date().toISOString(),
    reachable: false,
    healthy: false,
    statusCode: null,
    responseTimeMs: null,
    finalUrl: null,
    ssl: null,
    content: null,
    errorType: null,
    error: null,
  };

  // 1. Reachability + response time
  try {
    const pingResult = await checkReachability(url, { timeoutMs: opts.timeoutMs });
    result.reachable = pingResult.reachable;
    result.healthy = pingResult.healthy ?? isHealthyStatus(pingResult.statusCode);
    result.statusCode = pingResult.statusCode;
    result.responseTimeMs = pingResult.responseTimeMs;
    result.finalUrl = pingResult.finalUrl;
    result.errorType = pingResult.errorType;
    result.error = pingResult.error;
  } catch (err) {
    result.errorType = 'check_error';
    result.error = `Reachability check failed: ${err.message}`;
    return result;
  }

  // 2. SSL check (only if HTTPS and reachable)
  if (result.reachable && url.startsWith('https://')) {
    try {
      result.ssl = await checkSSL(url, { timeoutMs: legTimeoutMs(deadline, SSL_TIMEOUT_MS) });
    } catch (err) {
      result.ssl = { error: err.message };
    }
  }

  // 3. Content hash (for change detection)
  if (result.healthy) {
    try {
      const contentResult = await checkContentChange(url, opts.contentHash, {
        timeoutMs: legTimeoutMs(deadline, CONTENT_TIMEOUT_MS),
      });
      result.content = contentResult;
    } catch (err) {
      result.content = { error: err.message };
    }
  }

  return result;
}

/**
 * Run all checks on multiple URLs (parallel)
 * @param {string[]} urls
 * @param {object} [opts]
 * @returns {Promise<object[]>}
 */
export async function checkUrls(urls, opts = {}) {
  assertValidHttpUrls(urls);
  return Promise.all(urls.map(url => checkUrl(url, opts)));
}

/**
 * Simple summary: just the essential status
 * @param {object} result — from checkUrl()
 * @returns {object} minimal status
 */
export function summarize(result) {
  const status = result.healthy ? 'UP' : 'DOWN';

  let sslStatus = 'N/A';
  if (result.ssl && result.ssl.validDays !== undefined) {
    sslStatus = result.ssl.validDays <= 14 ? `${result.ssl.validDays}d ⚠️` : `${result.ssl.validDays}d ✅`;
  } else if (result.ssl && result.ssl.error) {
    sslStatus = `ERR: ${result.ssl.error}`;
  }

  return {
    url: result.url,
    status,
    statusCode: result.statusCode,
    responseTime: `${result.responseTimeMs}ms`,
    ssl: sslStatus,
    lastChecked: result.timestamp,
  };
}