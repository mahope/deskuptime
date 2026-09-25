/**
 * HTTP/HTTPS reachability checker
 * Uses native fetch (Node 24+) — no external dependencies.
 */

import {
  DEFAULT_TIMEOUT_MS,
  describeFetchError,
  isHealthyStatus,
} from '../status.js';

function toHttpResult(response, start) {
  const result = {
    reachable: true,
    healthy: isHealthyStatus(response.status),
    statusCode: response.status,
    responseTimeMs: Date.now() - start,
    finalUrl: response.url,
    headers: Object.fromEntries(response.headers.entries()),
  };

  if (!result.healthy) {
    result.errorType = 'http_error';
    result.error = `HTTP ${response.status}`;
  }

  return result;
}

function toNetworkResult(error, start) {
  return {
    reachable: false,
    healthy: false,
    statusCode: null,
    responseTimeMs: Date.now() - start,
    finalUrl: null,
    errorType: null,
    error: null,
    ...describeFetchError(error),
  };
}

export async function checkReachability(url, options = {}) {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)',
      },
    });

    return toHttpResult(response, start);
  } catch (error) {
    return toNetworkResult(error, start);
  }
}
