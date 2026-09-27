/**
 * deskuptime — Core monitor engine
 *
 * Universal kernel: can run standalone (Node.js), as CLI, or integrated into
 * a Tauri desktop app. Takes an array of URLs, runs all checks, returns results.
 */

import { checkReachability } from './checkers/ping.js';
import { checkSSL, SSL_TIMEOUT_MS } from './checkers/ssl.js';
import { checkContentChange, CONTENT_TIMEOUT_MS } from './checkers/content.js';
import { assertValidHttpUrls, canReadCertificate, expectsCertificate, isHealthyStatus, readCertCoverage, readSslIssuer, readSslState, readSslTls, expiredNote } from './status.js';
import { formatMs } from './display.js';

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
 * @param {Map<string,string>|object} [opts.contentHashes] — the same, per URL, for a
 *   multi-URL run where each site has its own stored reading. `check` reads the
 *   state file for this; `runPass` passes one URL at a time and uses
 *   `opts.contentHash`. Without it `content.js` answers `changed: null` and the
 *   page is never compared with anything.
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

  // 2. SSL check (only if a certificate can exist here, and the request leg did
  // not rule the certificate out)
  // `expectsCertificate()` rather than `url.startsWith('https://')`: the URL
  // parser lowercases a scheme, so `HTTPS://` was monitored over TLS and then
  // never had its certificate read — the renewal warning silently off.
  //
  // `canReadCertificate()` rather than `result.reachable`: a site that refuses
  // the handshake *because of its certificate* answers no request, and the gate
  // threw the certificate away with the answer. Measured 2026-09-27 against a
  // site serving a certificate that expired 40 days earlier: `checkSSL` on that
  // host read `{ validDays: 0, isExpired: true, expiredDays: 40 }`, the engine
  // kept `ssl: null`, and every paid surface then said it knew nothing about
  // the certificate — `SSL —` in the client report, no `SSL EXPIRED` line, no
  // `ssl_expired` alert, for the one reason the renewal warning exists.
  if (expectsCertificate(url) && canReadCertificate(result)) {
    try {
      result.ssl = await checkSSL(url, { timeoutMs: legTimeoutMs(deadline, SSL_TIMEOUT_MS) });
    } catch (err) {
      result.ssl = { error: err.message };
    }
  }

  // 3. Content hash (for change detection)
  if (result.healthy) {
    try {
      // The per-URL map wins over the single hash, so one option serves both a
      // one-URL pass and a batch without either caller having to know about the
      // other. `Map` and a plain object are both accepted, because a state file
      // is a plain object and rewrapping it at every call site is the kind of
      // ceremony that gets skipped.
      const stored = opts.contentHashes instanceof Map
        ? opts.contentHashes.get(url)
        : opts.contentHashes?.[url];
      const contentResult = await checkContentChange(url, stored ?? opts.contentHash, {
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

  // One reading of the certificate, from the one owner — the same call the
  // status lists and the client report make. This used to gate on
  // `validDays !== undefined` and print the number it found, so an unusable
  // value rendered as `-3d ✅` and a lapsed certificate as `0d ✅`.
  const ssl = readSslState({
    days: result.ssl?.validDays,
    expired: result.ssl?.isExpired,
    expiredDays: result.ssl?.expiredDays,
  });
  let sslStatus;
  if (ssl.expired) {
    sslStatus = `🔴 ${expiredNote(ssl.expiredDays)}`;
  } else if (ssl.days !== null) {
    sslStatus = `${ssl.days}d ${ssl.expiringSoon ? '⚠️' : '✅'}`;
  } else if (result.ssl?.error) {
    sslStatus = `ERR: ${result.ssl.error}`;
  } else {
    sslStatus = 'N/A';
  }

  return {
    url: result.url,
    status,
    statusCode: result.statusCode,
    responseTime: formatMs(result.responseTimeMs),
    ssl: sslStatus,
    /** The icon `check` prints next to the same line, decided by the same call. */
    sslIcon: ssl.expired ? '🔴' : ssl.expiringSoon ? '⚠️' : ssl.days !== null ? '🔒' : result.ssl?.error ? '🔓' : '—',
    /** Who issued the certificate, read through the one owner. `null` is a fact too. */
    sslIssuer: readSslIssuer(result.ssl),
    /** The TLS version and cipher the handshake negotiated, through the one owner. */
    sslTls: readSslTls(result.ssl),
    /** Whether that certificate covers the host we asked about, through the one owner. */
    sslCoverage: readCertCoverage(result.ssl, result.url),
    lastChecked: result.timestamp,
  };
}