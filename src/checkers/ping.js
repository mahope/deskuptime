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
//
// 403 belongs in the set for the same reason, one step further down the chain:
// WAFs and bot filters answer HEAD with 403 while serving GET normally. Measured
// 2026-09-26 against a server doing exactly that, with a healthy 200 on GET:
// `check` printed `Status: 403 — DOWN` and exited 2, `watch --once` stored a
// DOWN baseline, and `watch --status` showed `🚨 down` — a false DOWN on every
// surface, and the expensive kind: it tells a client their site is offline.
//
// A 12-URL read-only sample of public sites found the same shape on
// www.netflix.com, which answers 405 to HEAD and 200 to GET, and confirmed the
// other half on stackoverflow.com, which answers 403 to both. It found no site
// answering 403 to HEAD and 200 to GET, so that half rests on the documented
// WAF behaviour rather than on a sample — the retry is what makes it safe to
// rely on, because a 403 that survives GET is still DOWN (also measured, and
// the verdict stackoverflow.com already gets today).
//
// 401, 429 and the remaining 4xx stay out on purpose. "Authentication required"
// and "too many requests" are not properties of the request method, so GET
// answers them too and the extra request cannot change the verdict. A 429 is
// worse than useless: an immediate GET to a rate limiter is a second request
// from a client that was just told to slow down, which is how a monitor talks
// itself into a longer ban.
const HEAD_UNSUPPORTED = new Set([403, 404, 405, 501]);

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

/**
 * No response arrived, so there is no response time to report.
 *
 * `Date.now() - start` was written here for years and it is the wrong number:
 * it measures how long *we waited*, not how long the site took, and a pass that
 * never got a byte back printed it as a duration anyway. Measured 2026-09-26
 * with the real CLI against two local fixtures — a closed port and a server that
 * accepts the connection and never answers — no code changed:
 *
 *   Status:   N/A — DOWN
 *   Response: 15ms          ← connection refused: nothing answered, in 15 ms
 *   Status:   N/A — DOWN
 *   Response: 2008ms        ← timed out: 15 000 ms of budget plus overhead
 *
 * and in the client report, on the two rows a bureau forwards to a customer:
 *
 *   | http://kunde.dk/ | DOWN | 0% (2 checks, 2 failed) | … | 5 ms      | … |
 *   | http://kunde.dk/ | DOWN | 0% (1 checks, 1 failed) | … | 15002 ms  | … |
 *
 * `5 ms` is the fastest a site can look while being unreachable — a customer
 * reads it as a fast one — and `15002 ms` is not a latency at all, it is
 * `DEFAULT_TIMEOUT_MS` plus the round trip, so the number says "slow" when the
 * truth is "we gave up". Both were numbers we invented about someone else's
 * site.
 *
 * `formatMs()` in `src/display.js` documents the contract this now keeps: a
 * finite, non-negative number is a duration, anything else prints `—`. The
 * display side was already honest; the measurement side never let it show. The
 * timeout is still reported — as the *reason*, `error: 'Request timed out'`,
 * and the caller's own budget — not as a response time.
 */
function toNetworkResult(error) {
  return {
    reachable: false,
    healthy: false,
    statusCode: null,
    responseTimeMs: null,
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
    return toNetworkResult(error);
  }
}
