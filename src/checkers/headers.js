/**
 * headers.js — Redirect chain, HTTPS and security-header checker
 *
 * Universal kernel part: works on any URL regardless of CMS/platform.
 * Returns the full redirect chain, whether the site forces HTTPS,
 * and which common security headers are present.
 */

import {
  CHAIN_STOP,
  DEFAULT_TIMEOUT_MS,
  describeFetchError,
  isHealthyStatus,
  readChain,
  readHttpsState,
} from '../status.js';

const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
];

function emptySecurity() {
  return Object.fromEntries(SECURITY_HEADERS.map(name => [name, null]));
}

function errorResult(originalUrl, currentUrl, error) {
  const https = readHttpsState({ startUrl: originalUrl });
  return {
    finalUrl: currentUrl,
    redirected: currentUrl !== originalUrl,
    steps: [],
    reachable: false,
    healthy: false,
    statusCode: null,
    forcesHttps: https.forcesHttps,
    startedHttp: https.startedHttp,
    server: null,
    poweredBy: null,
    // Five nulls, which is what a site missing all five also looks like — the
    // terminal never gets this far, but `headers --json` does, and it is handed
    // `securityChecked: false` beside it (see `readChain().measured`).
    security: emptySecurity(),
    // No reading of the site at all, so there is no chain to describe.
    stopReason: null,
    ...describeFetchError(error),
  };
}

/**
 * Follow redirects manually so we can record the chain.
 * @param {string} url
 * @param {number} [maxRedirects=10]
 * @returns {Promise<object>} { finalUrl, redirected, steps[], forcesHttps, insecureStart, headers, security }
 */
export function checkHeaders(url, maxRedirects = 10, options = {}) {
  const steps = [];
  let current = url;

  return new Promise((resolve) => {
    const follow = (remaining) => {
      fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: { 'user-agent': 'deskuptime-headers/0.1 (+https://github.com/mahope/deskuptime)' },
      }).then((r) => {
        if (r.body) r.body.cancel().catch(() => {});
        const loc = r.headers.get('location');
        if (r.status >= 300 && r.status < 400) {
          let next = null;
          if (loc) {
            try {
              next = new URL(loc, current).toString();
            } catch {
              next = null;
            }
          }
          // The reason the walk stopped is the fact the surfaces need: one that
          // left a redirect in front of us is an unfinished reading, one that
          // hit a dead end is the site's own response. See `readChain`.
          if (next && remaining <= 0) return finish(r, CHAIN_STOP.MAX_REDIRECTS);
          if (next && steps.some((s) => s.url === next)) return finish(r, CHAIN_STOP.LOOP);
          if (!next) return finish(r, CHAIN_STOP.NO_LOCATION);
          steps.push({ url: current, status: r.status, location: next });
          current = next;
          follow(remaining - 1);
          return;
        }
        finish(r);
      }).catch((error) => {
        resolve({
          ...errorResult(url, current, error),
          steps,
        });
      });
    };

    const finish = (r, stopReason = null) => {
      const h = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      const security = {};
      for (const name of SECURITY_HEADERS) security[name] = h[name] || null;

      const https = readHttpsState({ startUrl: url, finalUrl: current });
      const chain = readChain({ stopReason, statusCode: r.status, steps, limit: maxRedirects });
      const healthy = chain.complete && isHealthyStatus(r.status);

      resolve({
        finalUrl: current,
        redirected: steps.length > 0 || current !== url,
        steps,
        reachable: true,
        // A chain we declined to follow is not a healthy site: `check` reaches
        // the same URL with `redirect: 'follow'`, gets "redirect count exceeded"
        // and exits 2, so `headers` was reporting the opposite verdict of the
        // same site. The rule lives in `readChain` — this only applies it.
        healthy,
        statusCode: r.status,
        // The raw fact; `readChain` is what turns it into a claim about the site.
        stopReason,
        // Not an `error`: the request did not fail, the *reading* is unfinished,
        // and the sentence naming why comes from `readChain` in the terminal.
        errorType: healthy ? null : (chain.complete ? 'http_error' : 'redirect_incomplete'),
        error: healthy ? null : (chain.complete ? `HTTP ${r.status}` : null),
        forcesHttps: https.forcesHttps,
        startedHttp: https.startedHttp,
        server: h['server'] || null,
        poweredBy: h['x-powered-by'] || null,
        security,
      });
    };

    follow(maxRedirects);
  });
}
