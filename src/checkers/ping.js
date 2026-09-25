/**
 * HTTP/HTTPS reachability checker
 * Uses native fetch (Node 24+) — no external dependencies.
 */

import {
  DEFAULT_TIMEOUT_MS,
  describeFetchError,
  isHealthyStatus,
} from '../status.js';

// Servers that do not serve HEAD on a route answer 404/405/501 to it while the
// same route answers GET fine (Cloudflare Workers, some API routes). Without a
// GET retry those healthy URLs are reported DOWN.
const HEAD_UNSUPPORTED = new Set([404, 405, 501]);

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

async function request(url, method, signal) {
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': 'Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)',
    },
  });

  // A GET retry only needs the status line, so release the body unbuffered.
  if (method === 'GET') await response.body?.cancel();

  return response;
}

export async function checkReachability(url, options = {}) {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remainingMs = () => Math.max(1, start + timeoutMs - Date.now());

  try {
    const head = await request(url, 'HEAD', AbortSignal.timeout(remainingMs()));
    if (!HEAD_UNSUPPORTED.has(head.status)) return toHttpResult(head, start);

    // --timeout stays a budget for the whole check, so the retry only gets what
    // is left of it instead of doubling the worst case.
    const get = await request(url, 'GET', AbortSignal.timeout(remainingMs()));
    return toHttpResult(get, start);
  } catch (error) {
    return toNetworkResult(error, start);
  }
}
