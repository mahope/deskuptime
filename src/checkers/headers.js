/**
 * headers.js — Redirect chain, HTTPS and security-header checker
 *
 * Universal kernel part: works on any URL regardless of CMS/platform.
 * Returns the full redirect chain, whether the site forces HTTPS,
 * and which common security headers are present.
 */

const SECURITY_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
];

/**
 * Follow redirects manually so we can record the chain.
 * @param {string} url
 * @param {number} [maxRedirects=10]
 * @returns {Promise<object>} { finalUrl, redirected, steps[], forcesHttps, insecureStart, headers, security }
 */
export function checkHeaders(url, maxRedirects = 10) {
  const steps = [];
  let current = url;
  let lastRes = null;

  return new Promise((resolve) => {
    const follow = (remaining) => {
      let res;
      try {
        // redirect:'manual' lets us see each hop ourselves
        res = fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          headers: { 'user-agent': 'deskuptime-headers/0.1 (+https://github.com/mahope/deskuptime)' },
        });
      } catch (err) {
        resolve({ finalUrl: current, redirected: steps.length > 0, steps, error: err.message });
        return;
      }
      res.then((r) => {
        lastRes = r;
        // Release the body: an open undici stream at process.exit() trips a libuv assertion on Windows
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
      }).catch((err) => {
        resolve({ finalUrl: current, redirected: steps.length > 0, steps, error: err.message });
      });
    };

    const finish = (r) => {
      const h = {};
      r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      const security = {};
      for (const name of SECURITY_HEADERS) security[name] = h[name] || null;

      const startIsHttp = url.startsWith('http://');
      const finalIsHttps = current.startsWith('https://');

      resolve({
        finalUrl: current,
        redirected: steps.length > 0 || current !== url,
        steps,
        statusCode: r.status,
        forcesHttps: startIsHttp ? finalIsHttps : null, // only meaningful if started on http
        startedHttp: startIsHttp,
        server: h['server'] || null,
        poweredBy: h['x-powered-by'] || null, // tech fingerprint leak
        security,
      });
    };

    follow(maxRedirects);
  });
}
