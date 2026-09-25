/**
 * headers.js — Redirect chain, HTTPS and security-header checker
 *
 * Universal kernel part: works on any URL regardless of CMS/platform.
 * Returns the full redirect chain, whether the site forces HTTPS,
 * and which common security headers are present.
 */

import {
  DEFAULT_TIMEOUT_MS,
  describeFetchError,
  isHealthyStatus,
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
  return {
    finalUrl: currentUrl,
    redirected: currentUrl !== originalUrl,
    steps: [],
    reachable: false,
    healthy: false,
    statusCode: null,
    forcesHttps: null,
    startedHttp: originalUrl.startsWith('http://'),
    server: null,
    poweredBy: null,
    security: emptySecurity(),
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
        if (r.status >= 300 && r.status < 400 && loc && remaining > 0) {
          let next;
          try {
            next = new URL(loc, current).toString();
          } catch {
            next = null;
          }
          if (next && !steps.some((s) => s.url === next)) {
            steps.push({ url: current, status: r.status, location: next });
            current = next;
            follow(remaining - 1);
            return;
          }
        }
        finish(r);
      }).catch((error) => {
        resolve({
          ...errorResult(url, current, error),
          steps,
        });
      });
    };

    const finish = (r) => {
      const h = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      const security = {};
      for (const name of SECURITY_HEADERS) security[name] = h[name] || null;

      const startIsHttp = url.startsWith('http://');
      const finalIsHttps = current.startsWith('https://');
      const healthy = isHealthyStatus(r.status);

      resolve({
        finalUrl: current,
        redirected: steps.length > 0 || current !== url,
        steps,
        reachable: true,
        healthy,
        statusCode: r.status,
        errorType: healthy ? null : 'http_error',
        error: healthy ? null : `HTTP ${r.status}`,
        forcesHttps: startIsHttp ? finalIsHttps : null,
        startedHttp: startIsHttp,
        server: h['server'] || null,
        poweredBy: h['x-powered-by'] || null,
        security,
      });
    };

    follow(maxRedirects);
  });
}
