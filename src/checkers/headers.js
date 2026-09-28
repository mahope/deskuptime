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
  httpDownNote,
  isHealthyStatus,
  readChain,
  readHttpsState,
  withoutCredentials,
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

/**
 * The five security headers plus the two stack fields, off one response.
 *
 * `?? null`, not `|| null`: a header the site sent with no value is a fact about
 * the site, and `||` threw it away and made it identical to a header it never
 * sent. `readSecurityHeaders` reads the difference. One function so the site's
 * own first response and the final response cannot drift apart in how they are
 * read — the two are the same measurement of two different servers.
 */
function readResponseHeaders(r) {
  const h = {};
  r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  const security = {};
  for (const name of SECURITY_HEADERS) security[name] = h[name] ?? null;
  return { security, server: h['server'] ?? null, poweredBy: h['x-powered-by'] ?? null };
}

function errorResult(originalUrl, currentUrl, error) {
  const https = readHttpsState({ startUrl: originalUrl });
  return {
    // The URL we asked last, without the credentials a redirect may have put in
    // it (P1-71). The comparison stays on the real strings: whether we were
    // redirected is a fact about the walk, not about the spelling of the address.
    finalUrl: withoutCredentials(currentUrl),
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
  // The site's *own* response, kept from the first hop. Measured 2026-09-28: the
  // five security headers and `server`/`poweredBy` were read off whichever
  // response came last, so a client domain that 301s to a parking page, a
  // hijacked domain or a registrar's "did you mean" page reported *that host's*
  // HSTS, CSP and `X-Powered-By: PHP/8.2.1` as findings about the client — and
  // the sheet was byte-identical to what `headers` prints for the stranger. The
  // first response is the only one the site's own server ever sent us, so it is
  // the only reading that can be attributed to the site. `null` until a response
  // arrives, and it stays `null` when the walk never gets one.
  let ownReading = null;
  // `current` is what we request, `shown` what we may print: a `Location:` header
  // can carry a username and a password (P1-71), and the chain is read by three
  // surfaces — the terminal, `headers --json` and the CI job that pastes it into
  // a step summary. Measured 2026-09-27: before this, `headers` printed the
  // password in the `Final:` line, in the error sentence and in
  // `steps[].location`, all three of them, for a site that answered 200.
  //
  // The request still goes to the real address, so the verdict does not move: a
  // credentialed hop still fails the way `check` fails on it (`fetch` refuses to
  // build the request), and the two commands keep agreeing. `seen` is the raw
  // form, so loop detection cannot be fooled by two hops that differ only in
  // their password.
  let current = url;
  let shown = withoutCredentials(url);
  // The raw addresses of the hops we have followed, in the raw form: the first
  // hop is recorded like any other, so a self-redirect is still "1 hop", and two
  // hops that differ only in their password cannot pass for a loop.
  const seen = new Set();

  return new Promise((resolve) => {
    const follow = (remaining) => {
      fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        headers: { 'user-agent': 'deskuptime-headers/0.1 (+https://github.com/mahope/deskuptime)' },
      }).then((r) => {
        if (r.body) r.body.cancel().catch(() => {});
        if (!ownReading) ownReading = readResponseHeaders(r);
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
          if (next && seen.has(next)) return finish(r, CHAIN_STOP.LOOP);
          if (!next) return finish(r, CHAIN_STOP.NO_LOCATION);
          seen.add(next);
          steps.push({ url: shown, status: r.status, location: withoutCredentials(next) });
          current = next;
          shown = withoutCredentials(next);
          follow(remaining - 1);
          return;
        }
        finish(r);
      }).catch((error) => {
        resolve({
          ...errorResult(url, current, error),
          steps,
          // Whatever the site's own host did send before the walk died, kept for
          // the same reason: it is the only reading that belongs to the site. The
          // five in `security` above stay `null` — that is `errorResult`'s
          // contract and `securityChecked: false` beside it says why.
          ownReading,
        });
      });
    };

    const finish = (r, stopReason = null) => {
      const last = readResponseHeaders(r);
      const security = last.security;

      const https = readHttpsState({ startUrl: url, finalUrl: current });
      const chain = readChain({ stopReason, statusCode: r.status, steps, limit: maxRedirects });
      const healthy = chain.complete && isHealthyStatus(r.status);

      resolve({
        finalUrl: shown,
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
        error: healthy ? null : (chain.complete ? httpDownNote({ statusCode: r.status }) : null),
        forcesHttps: https.forcesHttps,
        startedHttp: https.startedHttp,
        // `?? null`, not `|| null`, for the same reason as the five: a server that
        // sends `X-Powered-By: ` *is* disclosing that it sends the header, and
        // `||` reported that site as disclosing nothing. `readDisclosure` reads
        // the difference.
        server: last.server,
        poweredBy: last.poweredBy,
        security,
        // The site's own host, from the first response of the walk — see above.
        ownReading,
      });
    };

    follow(maxRedirects);
  });
}
