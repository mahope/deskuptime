/**
 * deskuptime — Core monitor engine
 *
 * Universal kernel: can run standalone (Node.js), as CLI, or integrated into
 * a Tauri desktop app. Takes an array of URLs, runs all checks, returns results.
 */

import { checkReachability } from './checkers/ping.js';
import { checkSSL } from './checkers/ssl.js';
import { checkContentChange } from './checkers/content.js';

/**
 * Run all checks on a single URL
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.contentHash] — optional previous content hash to detect changes
 * @returns {Promise<object>} { url, reachable, statusCode, responseTimeMs, ssl, content, error? }
 */
export async function checkUrl(url, opts = {}) {
  const result = {
    url,
    timestamp: new Date().toISOString(),
    reachable: false,
    statusCode: null,
    responseTimeMs: null,
    ssl: null,
    content: null,
    error: null,
  };

  // 1. Reachability + response time
  try {
    const pingResult = await checkReachability(url);
    result.reachable = pingResult.reachable;
    result.statusCode = pingResult.statusCode;
    result.responseTimeMs = pingResult.responseTimeMs;
    result.finalUrl = pingResult.finalUrl;
  } catch (err) {
    result.error = `Reachability check failed: ${err.message}`;
    return result;
  }

  // 2. SSL check (only if HTTPS and reachable)
  if (result.reachable && url.startsWith('https://')) {
    try {
      result.ssl = await checkSSL(url);
    } catch (err) {
      result.ssl = { error: err.message };
    }
  }

  // 3. Content hash (for change detection)
  if (result.reachable) {
    try {
      const contentResult = await checkContentChange(url, opts.contentHash);
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
  return Promise.all(urls.map(url => checkUrl(url, opts)));
}

/**
 * Simple summary: just the essential status
 * @param {object} result — from checkUrl()
 * @returns {object} minimal status
 */
export function summarize(result) {
  const status = result.reachable ? 'UP' : 'DOWN';

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