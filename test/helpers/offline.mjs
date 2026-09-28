/**
 * P1-92 — the gate's colour must be a fact about the code.
 *
 * Loaded with `--import` into every process the suite starts, so the public
 * internet is unreachable from the gate. Two measured reasons, both of them a
 * red CI run that said nothing about the code:
 *
 *   1. `test/certrotation.test.js` shook hands with `https://example.com` to
 *      measure "checkSSL reads both identity fields". Commit 606166c — a diff in
 *      `IMPLEMENTATION_PLAN.md` alone — was red on the runner:
 *
 *        test/certrotation.test.js:145  målt på et rigtigt certifikat
 *          AssertionError: målingen skal nå et certifikat: read ECONNRESET
 *          tests 741 · pass 740 · fail 1
 *
 *   2. `test/uncheckable.test.js` ran the real CLI against `https://c.dk/`, which
 *      is a *registered* Danish domain, and asserted exit 0. With the internet
 *      cut it exits 2, because the site is gone rather than up.
 *
 * The first is now a local certificate from `helpers/certs.mjs`, and the second
 * a loopback server. Neither was found by reading the code: both were found by
 * cutting the network and looking at what turned red. This file is what keeps
 * that hand available for the next one, and it closes the class rather than the
 * two instances — a test that reaches the internet is a test whose result the
 * internet decides.
 *
 * Loopback keeps working, because that is the whole shape of this suite: 34
 * files that stand up their own `node:http`/`node:https` servers. What is left
 * is a site that only exists on the public internet, which in a test is a
 * dependency the project did not mean to take.
 *
 * A case that genuinely has to read a public page — a live redirect chain, a
 * real CA's certificate — names its host in `PUBLIC_READS` below, with a reason.
 * That list is what makes such a test findable by name instead of by `rg` when a
 * gate goes red somewhere else, and `test/offlinegate.test.js` holds it empty
 * until someone argues for an entry in review.
 */

import dns from 'node:dns';
import net from 'node:net';

/**
 * Public hosts the gate is allowed to resolve, as `host → why`. Empty: every
 * case in the suite is measurable from this machine.
 */
export const PUBLIC_READS = {
  // 'example.com': 'which case has to be measured against the real site, and what it proves',
};

const original = {
  lookup: dns.lookup.bind(dns),
  promisesLookup: dns.promises.lookup.bind(dns.promises),
  resolve: dns.resolve.bind(dns),
  resolve4: dns.resolve4.bind(dns),
  resolve6: dns.resolve6.bind(dns),
  promisesResolve: dns.promises.resolve.bind(dns.promises),
};

/** A name this machine can answer on its own: an address, or a loopback name. */
export function isLocalHost(host) {
  const name = String(host);
  return net.isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost');
}

/** Everything else, unless a case has argued for it by name. */
export function isUnreachableFromHere(host) {
  const name = String(host).toLowerCase();
  return !isLocalHost(name) && !Object.hasOwn(PUBLIC_READS, name);
}

/** The failure a machine with no route to that host would report. */
function unreachable(host) {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: 'ENOTFOUND',
    hostname: String(host),
    syscall: 'getaddrinfo',
  });
}

// `dns.lookup` is the one every connect path goes through — `net.connect`,
// `tls.connect` and therefore `https` and `fetch`. It takes
// `(hostname[, options], callback)` and its options argument is optional, so
// both shapes have to be passed through untouched or local fixtures break.
dns.lookup = function lookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  if (!isUnreachableFromHere(Array.isArray(hostname) ? hostname[0] : hostname)) {
    return original.lookup(hostname, options, callback);
  }
  const host = Array.isArray(hostname) ? hostname[0] : hostname;
  process.nextTick(() => done(unreachable(host)));
};

dns.promises.lookup = async function lookup(hostname, options) {
  if (isUnreachableFromHere(hostname)) throw unreachable(hostname);
  return original.promisesLookup(hostname, options);
};

// The resolver APIs do not back `connect`, so nothing in `src/` reaches them
// today — but a test that asks for a name directly should meet the same answer
// as one that dials it, rather than learning that only the connect path is shut.
const refuseResolve = (fn) => function resolver(hostname, ...rest) {
  if (isUnreachableFromHere(hostname)) {
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function') {
      process.nextTick(() => callback(unreachable(hostname)));
      return undefined;
    }
    return Promise.reject(unreachable(hostname));
  }
  return fn(hostname, ...rest);
};

dns.resolve = refuseResolve(original.resolve);
dns.resolve4 = refuseResolve(original.resolve4);
dns.resolve6 = refuseResolve(original.resolve6);
dns.promises.resolve = refuseResolve(original.promisesResolve);
