export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Days before expiry at which a certificate counts as "renew it soon".
 *
 * One definition, because three surfaces report the same certificate: `check`
 * (summarize), `watch` (the latched ssl_warning event) and the client report.
 * They used to hardcode 14 in two files and use no threshold at all in the
 * report, so a bureau forwarding the report to a customer could not see which
 * site needed a certificate.
 */
export const SSL_WARN_DAYS = 14;

/**
 * True only for a known, finite, non-negative number of days inside the window.
 * A negative count is not a certificate that expired — it is a corrupt or
 * hand-edited state file, and a client report must not render it as "renew now".
 */
export function isSslExpiringSoon(validDays) {
  return Number.isFinite(validDays) && validDays >= 0 && validDays <= SSL_WARN_DAYS;
}

/**
 * How long a certificate has been expired, in whole days. `0` means it lapsed
 * today. `null` when the expiry itself is unknown, which is not the same as
 * "not expired" — see `readSslState`.
 */
function expiredDaysCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * The scheme a URL actually has — the one owner of that question.
 *
 * The validator that admits a URL (`isHttpUrl`) goes through `new URL()`, which
 * lowercases the scheme, so a URL written `HTTPS://` or `HTTP://` is accepted and
 * then requested. Every rule that asked "is this https?" with a case-sensitive
 * `startsWith` therefore disagreed with the validator about the same string, and
 * two of those rules did not just mislabel the site: they stopped measuring it
 * (see `expectsCertificate` and `readHttpsState`).
 *
 * @param {string} url
 * @returns {'http:'|'https:'|null} null when the string is not a URL at all
 */
export function urlScheme(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/**
 * Whether a URL can have a certificate at all — one answer to the one owner above.
 *
 * Two surfaces need it and both used to spell it themselves as a case-sensitive
 * `startsWith('https')`, while the validator that admits a URL (`isHttpUrl`) goes
 * through `new URL()`, which lowercases the scheme. So `HTTPS://eksempel.dk` was
 * accepted, requested over TLS — and then never had its certificate read.
 * Measured against one local TLS server with a 5-day certificate:
 *
 *   https://localhost:PORT/  -> ssl: { validDays: 5, … }  "5d ⚠️"  expiringSoon: true
 *   HTTPS://localhost:PORT/  -> ssl: null                  "N/A"     expiringSoon: false
 *
 * One capital letter, and the certificate check is silently off — so a Pro
 * customer's expiry warning never fires, and the payload says the certificate is
 * *not* expiring. A rule with two owners and no owner is a rule that disagrees.
 *
 * @param {string} url
 * @returns {boolean} true only for a URL whose scheme is https
 */
export function expectsCertificate(url) {
  return urlScheme(url) === 'https:';
}

/**
 * One reading of a site's scheme policy, shared by every surface that shows one.
 *
 * `deskuptime headers` answers a bureau's first question about a client's site —
 * does plain HTTP get forced to HTTPS? — and measured against a real CLI, it
 * sometimes did not answer at all. The checker recognised the two schemes itself,
 * with `startsWith('http://')` and `startsWith('https://')`, in two functions:
 *
 *   http://127.0.0.1:PORT/ok  ->  startedHttp: true   forcesHttps: false
 *     HTTPS forced: ❌ no — site served over plain HTTP
 *
 *   HTTP://127.0.0.1:PORT/ok  ->  startedHttp: false  forcesHttps: null
 *     (no HTTPS line at all)
 *
 * Same site, same response, one capital letter: the tool said nothing about
 * enforcement where it had just been asked, and the JSON called a site serving
 * over plain HTTP "not applicable". The same family as `expectsCertificate`
 * (P1-22), one step further out: a rule that cannot be read is worse than a rule
 * that answers wrongly, because there is nothing on the screen to notice.
 *
 * The facts are decided here, once:
 *
 *   - `startedHttp` is the scheme the *walk began* on, so `HTTP://` counts.
 *   - `forcesHttps` is a verdict about a site that was *given the chance* to
 *     redirect, so only a plain-HTTP start can have one. An https start is `null`
 *     — there was nothing to force — and a walk that never reached a final
 *     response is `null` too, because we never saw what the site did.
 *
 * @param {object} [state] — `{ startUrl, finalUrl }`; `finalUrl` is null when
 *   the walk never got a response.
 */
export function readHttpsState({ startUrl = '', finalUrl = null } = {}) {
  const startedHttp = urlScheme(startUrl) === 'http:';
  return {
    startedHttp,
    forcesHttps: startedHttp && finalUrl !== null ? urlScheme(finalUrl) === 'https:' : null,
  };
}

/** The three states a judged security header can be in. */
export const SECURITY_HEADER = {
  /** The site sent the header with a value. */
  PRESENT: 'present',
  /** The site sent the header with no value at all. */
  EMPTY: 'empty',
  /** The site never sent the header. */
  ABSENT: 'absent',
};

/**
 * One reading of a site's security headers, shared by every surface that lists them.
 *
 * Three things are true of a judged header, and the tool could only say one of
 * them. `checkHeaders` collapsed them with `h[name] || null`, and a header the
 * server sent **with no value** became `null` — the same value as a header that
 * never arrived. Measured against a real server sending `x-frame-options: `:
 *
 *   x-frame-options:            (no value)
 *     headers        ->  ⬜ missing: x-frame-options
 *     headers --json ->  "x-frame-options": null
 *
 * So a bureau was told a customer's site lacks a header it is in fact sending,
 * and the JSON it pipes into the customer's own report says `null` — which reads
 * as "we looked and it was not there". Both are the fault P1-21 found in a
 * different number: a fact computed and thrown away, so two different errors
 * became indistinguishable. A header sent empty protects nothing, so it is not
 * a pass either — it is a third state, and it has to be sayable.
 *
 * Note that a whitespace-only value arrives as `''`: the HTTP layer strips
 * optional surrounding whitespace before anything sees it, so `x-frame-options: `
 * and `x-frame-options:    ` are one case, not two.
 *
 * Callers pick their own icon and their own sentence. Neither may re-decide
 * which of the three a header is in.
 *
 * @param {object} [security] — `{ [name]: string | null }` from `checkHeaders`
 * @returns {{ present: Array<[string, string]>, empty: string[], absent: string[] }}
 */
export function readSecurityHeaders(security) {
  const entries = security && typeof security === 'object' ? Object.entries(security) : [];
  const present = [];
  const empty = [];
  const absent = [];
  for (const [name, value] of entries) {
    if (value === null || value === undefined) absent.push(name);
    // `trim()` is belt and braces: the value is always a string here, but a
    // caller that hands us one built from a number must not read as a header
    // with content either.
    else if (String(value).trim() === '') empty.push(name);
    else present.push([name, value]);
  }
  return { present, empty, absent };
}

/**
 * One reading of a certificate, shared by every surface that shows one.
 *
 * `check`, `watch --status`, `status`, the client report and the GitHub Action
 * all answer the same two questions about the same certificate: is it inside the
 * renewal window, and has it already lapsed. The checker computed both
 * (`isExpired` from the certificate's own `validTo`) and **no surface read
 * `isExpired`** — `validDays` was clamped to `Math.max(0, …)`, so a certificate
 * that lapsed on 1 February 2020 and one expiring tonight both rendered as
 * `0d ⚠️` / "renew soon". Measured against a real expired certificate:
 *
 *   checkSSL  -> {"validDays":0,"isExpired":true,"expiresSoon":true}
 *   `check`   ->  🔒 SSL:  0d ✅   (and `0d ⚠️` once inside the window)
 *
 * For a bureau whose headline feature is expiry warnings, "renew soon" about a
 * certificate that broke the site last week is the worst possible answer, and it
 * is the one a customer reads.
 *
 * So the facts are decided here, once, from whatever a caller has:
 *
 *   - `days` is only a day count when it is finite and non-negative. A negative
 *     is a corrupt or hand-edited state file, not an expired certificate.
 *   - `expired` is decided by the checker's own `isExpired` (or by an explicit
 *     `expiredDays`), never by `days === 0`. A certificate expiring tonight is
 *     not expired, and conflating the two is the bug this replaces.
 *   - `expiringSoon` is false for an expired certificate: a lapsed certificate
 *     is not "renew soon", it is broken, and the two must not share a message.
 *   - `expiringSoon` is **null** when no certificate was read at all, because
 *     `false` there is a claim about a measurement that never happened. This
 *     used to be decided in the other direction: `readSslState({})` answered
 *     `false`, so `check --json` published `sslExpiringSoon: false` next to
 *     `sslDaysRemaining: null` for every plain-HTTP site, every unreachable
 *     HTTPS site and every URL whose scheme was written in capitals — three
 *     different situations, one boolean reading "measured, and fine". `null` is
 *     what every sibling field already prints for a fact nobody has, and it is
 *     falsy, so a `jq` filter or an `if` cannot tell it from the old `false`
 *     except by asking the question the field now answers.
 *
 * Callers pick their own icon and punctuation and cannot re-decide any of it.
 *
 * @param {object} ssl — `{ days, expired, expiredDays }`; `days` is the
 *   checker's `validDays` or the state entry's `sslValidDays`.
 */
export function readSslState(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : {};
  const days = Number.isFinite(value.days) && value.days >= 0 ? Math.floor(value.days) : null;
  const expiredDays = expiredDaysCount(value.expiredDays);
  const expired = value.expired === true || expiredDays !== null;
  // A certificate was read when it left us one fact: a day count, or a lapse.
  const measured = days !== null || expired;
  return {
    days,
    expired,
    expiredDays,
    measured,
    // Not `false` for a URL with no certificate: see above. The `expired` case is
    // measured, and stays false — a lapsed certificate is not "renew soon".
    expiringSoon: !measured ? null : (!expired && isSslExpiringSoon(days)),
    // A field that was present but unreadable is reported as unknown; a field
    // that was never there says nothing at all, so plain-HTTP monitoring does
    // not grow a column of dashes.
    unreadable: value.days !== undefined && value.days !== null && days === null && !expired,
  };
}

/**
 * One HTTP status code, or `null` when the state file does not hold one.
 *
 * An HTTP status code is an integer from 100 to 599. `Number.isInteger` is not
 * that check: a state file that was hand-edited, restored from a backup or
 * written by another tool can hold anything, and every surface then printed it
 * as if the server had said it. Measured on one state file, four surfaces, no
 * code changed:
 *
 *   report        | https://kode-1.dk/ | UP (-1)    | 100% (2 checks) |
 *   report --json | https://kode-2.dk/ | UP (9999)  | "statusCode": 9999
 *   status        · ✅ https://kode-1.dk/ (-1)
 *   watch --status ✅ up https://kode-2.dk/ (9999)
 *
 * `UP (-1)` is a claim about a server response in the one document a bureau
 * forwards to a customer: a customer reading it cannot tell a mangled state file
 * from a site that answered something impossible. `readEntry` already promises
 * that every value it returns is "a fixed word or a checked number … so an
 * unusable field can only become `null`, never a claim the caller did not
 * check" — the status code was the one field that promise did not cover, because
 * it was written twice and checked with the weaker of the two rules.
 *
 * Out of range becomes `null`, the same "unknown" every sibling cell prints for
 * a missing number, rather than being clamped into a plausible code: inventing
 * a 100 or a 599 would be a worse lie than the dash.
 *
 * @param {*} value — a raw `lastStatus` from a state file.
 */
export function readStatusCode(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

/**
 * The fixed wording for a lapsed certificate, in one place: `expired 12d ago`,
 * `expired today`, or an honest "unknown" when only the fact is known.
 */
export function expiredNote(expiredDays) {
  if (expiredDays === null) return 'expired — expiry date unknown';
  return expiredDays === 0 ? 'expired today' : `expired ${expiredDays}d ago`;
}

/** A byte count is a fact only when it is a whole, non-negative number. */
function byteCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * One reading of the content check, shared by every surface that prints one.
 *
 * The content check is not always a measurement. P2-1 del B capped the body at
 * 2 MiB so one large page cannot take the watch loop down, and it was right to:
 * a big page is not an outage. But the cap was invisible, and the byte count it
 * left behind was not a measurement of the page at all. Measured with the real
 * CLI against a 5 MiB page served without a `content-length`:
 *
 *   check --json -> { "contentLength": 2162237, "contentHash": null }
 *
 * The page is 5 242 880 bytes. 2 162 237 is where *our own reader* stopped
 * before it cancelled the stream — it moved to 2 120 910 on the next identical
 * run, because it depends on how much the socket happened to deliver. So a CI
 * job reporting "page size" from this field published a number no server sent,
 * and it was different every run. The two facts a consumer needed were both
 * missing: `tooLarge` was written by the checker and read by nobody, and the
 * checker's own explanation ("Page is 5242880 bytes — over the 2097152-byte
 * content-check limit") was computed and then thrown away, so the human output
 * printed no Content line at all and `contentHash: null` was indistinguishable
 * from a page that genuinely has no hash.
 *
 * So the answer is decided once, here:
 *
 * - `measured` is true only when the body was actually read and hashed.
 * - `length` is the byte count to publish, and it is `null` unless the number
 *   describes the page: our own read, or the server's own `content-length`
 *   declaration. The streaming artifact is *not* a page size, so it never
 *   reaches a surface as one — it is carried as `atLeast`, which says what it
 *   really is.
 * - `skipped` names the one deliberate skip, so a consumer can tell "we did not
 *   look" from "there was nothing to find".
 *
 * @param {object} content — a `checkContentChange()` result.
 */
export function readContentState(content) {
  const value = content && typeof content === 'object' ? content : {};
  const measured = value.fetched === true;
  const tooLarge = value.tooLarge === true;
  const atLeast = byteCount(value.atLeastBytes);
  // A server that declared an oversized body told us the size itself, so that
  // number is the server's claim about the page and is labelled as such. A body
  // we stopped reading halfway leaves us with a lower bound and nothing else.
  const declared = !measured && tooLarge ? byteCount(value.contentLength) : null;
  return {
    measured,
    length: measured ? byteCount(value.contentLength) : declared,
    declared: declared !== null,
    atLeast,
    limit: byteCount(value.contentLimit),
    skipped: tooLarge ? 'too-large' : null,
  };
}

/**
 * The fixed wording for a content check that was deliberately not made, in one
 * place: what was skipped, the limit that caused it, and the lower bound the
 * read actually reached.
 */
export function contentSkipNote(state) {
  const limit = state.limit === null ? 'the content-check limit' : `the ${state.limit.toLocaleString('en-US')}-byte content-check limit`;
  const read = state.atLeast === null ? '' : ` (read ${state.atLeast.toLocaleString('en-US')} bytes before stopping)`;
  return `not read — page over ${limit}${read}`;
}

/**
 * How old the newest completed pass may be before a report stops presenting it
 * as current.
 *
 * A report says "3 up · 0 down" about the *last* pass, not about a moment in
 * time — and nothing in the report re-checks anything. If the watch loop died,
 * a site checked six weeks ago looks exactly like one checked eight minutes
 * ago, so a bureau forwarding the report tells a customer their site is healthy
 * on the strength of a measurement that long expired. Two days tolerates a
 * daily cron without crying wolf, and is far below the point where a customer
 * would be misled.
 */
export const STALE_AFTER_DAYS = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Age in ms of the newest completed pass, or null when the state file does not
 * say when that pass ran.
 *
 * A timestamp in the future is clock skew or a wrong system clock, not old
 * data, so it is reported as a negative age rather than invented into an
 * outage. The report prints the exact timestamp either way.
 */
export function checkAgeMs(lastChecked, now = new Date()) {
  if (typeof lastChecked !== 'string' || !lastChecked) return null;
  const parsed = Date.parse(lastChecked);
  if (Number.isNaN(parsed)) return null;
  return now.getTime() - parsed;
}

/**
 * True only when a pass is known to have run and is older than the window.
 *
 * Absent `lastChecked` is *not* stale: the report already shows such a site as
 * "not checked yet", and flagging it twice would say nothing new. A timestamp
 * that is present but unreadable *is* stale — a pass was recorded and we cannot
 * show that it is current, which is exactly what a client report must not do.
 */
export function isCheckStale(lastChecked, now = new Date()) {
  if (typeof lastChecked !== 'string' || !lastChecked) return false;
  if (Number.isNaN(Date.parse(lastChecked))) return true;
  return checkAgeMs(lastChecked, now) > STALE_AFTER_DAYS * MS_PER_DAY;
}

/** Whole days since the last pass, for display. `null` when it is unknown. */
export function checkAgeDays(lastChecked, now = new Date()) {
  const age = checkAgeMs(lastChecked, now);
  if (age === null) return null;
  return Math.max(0, Math.floor(age / MS_PER_DAY));
}

/**
 * The fixed wording for a stale pass, in one place.
 *
 * The client report had its own copy of this sentence and `readEntry` had
 * another, so the two could drift; a surface that says "stale" without saying
 * how stale is the exact gap P1-6 opened.
 */
export function staleAgeNote(ageDays) {
  return ageDays === null ? 'stale — last check unreadable' : `stale — last check ${ageDays} d ago`;
}

/**
 * The fixed wording for a site the state file cannot vouch for, in one place.
 *
 * "not checked yet" is a claim about *history*, and until now only the client
 * report made it. Measured on one state file, the two terminal lists said
 * nothing at all about it, and two genuinely different states printed the very
 * same row:
 *
 *   deskuptime status
 *     · https://never.dk            ← wasUp: null, no pass has ever run
 *     · https://handedit.dk         ← wasUp: null, a pass ran 3 h ago
 *
 * A user reading that cannot tell "this was never monitored" from "the last pass
 * exists but its verdict is unreadable", and a URL added to the watch list
 * whose loop never ran is the same silent failure P1-10 measured in the alerts:
 * nothing says it. So the two cases get their own words, taken from the report's
 * rule, and an unknown verdict names the age of the pass behind it — "unknown"
 * without an age reads as "no data" too.
 *
 * @param {object} state — `{ lastChecked, ageDays }`; `ageDays` is
 *   `checkAgeDays(lastChecked)`.
 */
export function unknownNote({ lastChecked, ageDays } = {}) {
  if (!lastChecked) return 'not checked yet';
  if (ageDays === null || ageDays === undefined) return 'status unknown (last check unreadable)';
  return `status unknown (last check ${ageDays} d ago)`;
}

/** A recorded pass time we can order, or null when it is absent or unreadable. */
function passTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is `candidate` the newer of two recorded passes?
 *
 * `watch` merges the state file on disk into the pass it is about to run, so
 * that two invocations — a manual `deskuptime watch <url>` and a cron `watch
 * --once` — cannot lose each other's newest observation. That merge used to
 * compare the two timestamps as *strings*, which is only accidentally right.
 * Measured, with two timestamps a real state file can hold:
 *
 *   '2026-09-26T01:00:00+02:00' > '2026-09-25T23:30:00Z'   // string: true
 *   Date.parse difference                                  // -30 min
 *
 * The second is 30 minutes *newer* and the string says it is older, because
 * `T…Z` and `T…+02:00` only sort correctly when every timestamp is UTC with the
 * same precision. The merge therefore kept the *older* entry, and it is a
 * whole entry: `wasUp`, the status code, the certificate days, the uptime
 * counters and the age all rolled back to the older pass and were written
 * onward. A site that had recovered to UP read as DOWN again, and
 * `watch --status` reported the older age.
 *
 * Timezones and precision are also what make it reachable rather than
 * theoretical. `toISOString()` always writes `…THH:mm:ss.sssZ`, which is why
 * DeskUptime's own writes happened to sort correctly — but a state file
 * restored from a backup, hand-edited, or written by another tool carries
 * offsets or second precision, and a second-precision stamp is a *second*
 * wrong in the same way: `…:00Z` sorts after `…:00.500Z` while being older.
 *
 * An unreadable timestamp is not a time at all, so it can never displace a
 * readable one. It used to: letters sort after digits, so a hand-edited
 * `lastChecked: "yes"` won the merge over a real timestamp and hid a genuine
 * pass.
 */
export function isNewerPass(candidate, reference) {
  const candidateTime = passTime(candidate);
  const referenceTime = passTime(reference);
  if (candidateTime === null) return false;
  if (referenceTime === null) return true;
  return candidateTime > referenceTime;
}

/**
 * The one decision behind every status word in this product: what does the
 * state file say about a site?
 *
 * It used to be written twice, byte for byte, in `readEntry` below and in
 * `siteStatus()` in the client report — and the report cannot call `readEntry`
 * for it, because the report also needs `addedAt` and the counters that
 * `readEntry` does not read. Two identical owners is a bug waiting to happen:
 * the report would have kept saying UP for a state file the terminal calls
 * `unknown`, in the one document a bureau forwards to a customer.
 *
 * Only the two booleans count. `"true"`, `1`, `null` and a missing field are
 * all `unknown`, because a state file that was hand-edited, restored from a
 * backup or half-written cannot be read as a claim about the site.
 *
 * The five surfaces then word this one decision five ways — `✅ up`/`❔ unknown`
 * (watch --status), `✅`/`·` (watch), `UP (200)`/`not checked yet` (the client
 * report), `✅ UP` (the Action's job summary) and `up`/`down`/`unknown` in both
 * JSON payloads. Those are layouts, not rival claims: the Action's summary and
 * `report --json` are read outside this repo, so unifying the *wording* would
 * break consumers while fixing nothing. What must stay single is the decision.
 */
export function verdictFor(wasUp) {
  return wasUp === true ? 'up' : wasUp === false ? 'down' : 'unknown';
}

/**
 * One reading of a state-file entry, shared by every surface that prints one.
 *
 * Three facts about a monitored site are all in `state.urls[url]`: whether the
 * last pass was up, which status code it saw, and how many days the certificate
 * has left. Two surfaces print that entry — `deskuptime watch --status` and the
 * URL list on `deskuptime status` — and each used to decide those facts on its
 * own instead of asking the rules above. Measured on a state file, that gave:
 *
 *   - a pass from 41 days ago printing `✅ up` with no age, while the client
 *     report built from the same file said `⚠️ stale — last check 41 d ago`;
 *   - a certificate with 9 days left printing `SSL 9d` in plain text, while
 *     `check`, `watch` and the report all warn inside the 14-day window;
 *   - `sslValidDays` interpolated straight into the terminal, so escape bytes in
 *     a hand-edited or restored state file printed as themselves (`^[[2J`), and
 *     an unusable value printed as a bare `SSL -2d` where the report shows `—`.
 *
 * So the claims are decided here, once, and only the layout is left to each
 * surface: a caller picks its own icon and separator and cannot re-decide
 * whether a certificate is expiring or how old a pass is.
 *
 * Every value returned is a fixed word or a checked number — nothing from the
 * state file is carried through as text — so an unusable field can only become
 * `null`, never a claim the caller did not check.
 */
export function readEntry(entry, { now = new Date() } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const ssl = readSslState({
    days: value.sslValidDays,
    expired: value.sslExpired,
    expiredDays: value.sslExpiredDays,
  });
  const stale = isCheckStale(value.lastChecked, now);
  const ageDays = checkAgeDays(value.lastChecked, now);
  const neverChecked = !value.lastChecked;

  return {
    verdict: verdictFor(value.wasUp),
    // "No pass has ever run" and "the last pass ran but its verdict cannot be
    // read" are different facts that used to print identically, in both
    // terminal lists and in the report. The two surfaces now ask for the same
    // sentence, so neither can discover the difference on its own.
    neverChecked,
    unknownNote: unknownNote({ lastChecked: value.lastChecked, ageDays }),
    statusCode: readStatusCode(value.lastStatus),
    sslDays: ssl.days,
    sslExpired: ssl.expired,
    // Without a leading separator: the two surfaces punctuate differently, but
    // neither can change what is being said about the certificate.
    sslNote: ssl.expired
      ? `SSL 🔴 ${expiredNote(ssl.expiredDays)}`
      : ssl.days === null
        ? (ssl.unreadable ? 'SSL —' : '')
        : ssl.expiringSoon ? `SSL ⚠️ ${ssl.days}d — renew soon` : `SSL ${ssl.days}d`,
    ageDays,
    stale,
    staleNote: stale ? staleAgeNote(ageDays) : '',
  };
}

/**
 * How many redirects `deskuptime headers` will follow before it gives up.
 * Browsers give up too (Chrome at 20, Firefox at 20), so this is a ceiling, not
 * a licence to keep going.
 */
export const REDIRECT_LIMIT = 10;

/** Stop reasons the redirect-following checker can report. */
export const CHAIN_STOP = {
  /** The ceiling above was reached with a redirect still in front of us. */
  MAX_REDIRECTS: 'max_redirects',
  /** The next hop was a URL the chain had already visited. */
  LOOP: 'loop',
  /** A 3xx whose `Location` was absent or could not be resolved. */
  NO_LOCATION: 'no_location',
};

/**
 * The fixed wording for a redirect chain that did not end where we were sent,
 * in one place.
 *
 * `no_location` gets its own sentence even though the reading is complete: a 301
 * with no usable `Location` is a broken site, and the old output said nothing
 * about it — it printed `Final: <url> (301)` and five "missing header" lines as
 * if the URL had resolved.
 *
 * @param {object} [state] — `{ stopReason, statusCode, redirectCount, limit }`
 * @returns {string} the sentence, or `''` when the chain ended on a real response
 */
export function chainStopNote({ stopReason, statusCode, redirectCount, limit } = {}) {
  const code = Number.isInteger(statusCode) ? ` (${statusCode})` : '';
  switch (stopReason) {
    case CHAIN_STOP.MAX_REDIRECTS:
      return `gave up after ${limit} redirects — still redirecting${code}`;
    case CHAIN_STOP.LOOP:
      return `redirect loop — the chain came back to a URL it had already visited, after ${redirectCount} hop${redirectCount === 1 ? '' : 's'}${code}`;
    case CHAIN_STOP.NO_LOCATION:
      return `stopped on a redirect with no usable Location${code}`;
    default:
      return '';
  }
}

/**
 * One reading of a redirect chain, shared by every surface that shows one.
 *
 * `deskuptime headers` follows redirects by hand so it can print the chain, and
 * measured against the same URLs that `deskuptime check` calls DOWN, it printed
 * the opposite verdict with exit 0 and no note:
 *
 *   /loop       (redirects to itself)
 *     check    →  ❌ DOWN — redirect count exceeded            (exit 2)
 *     headers  →  Final: /loop (301) — redirected
 *                 HTTPS forced: ❌ no — site served over plain HTTP
 *                 ⬜ missing: strict-transport-security
 *                 ⬜ missing: content-security-policy      … alle fem
 *                (exit 0)
 *
 *   /helt-sikker-efter-redirect   (301 → the same site, one hop later)
 *     headers  →  ✅ alle fem security headers
 *
 * Three claims in one block, all read off a response that is not the site's:
 *
 *   1. `Final:` — the chain was abandoned with a redirect still pending, so there
 *      was no final URL to print. The checker walked 10 hops of a 15-hop chain
 *      and called hop 10's *pending redirect* the final answer.
 *   2. The `✅`/`⬜` security lines — taken from a 301, which is what a load
 *      balancer sends. A bureau running the free tool against a hardened site
 *      behind a redirect was told the site was missing all five headers, and
 *      nothing said where that reading came from.
 *   3. `healthy` / the exit code — a chain we refused to follow is a failure,
 *      which is why `check` says `redirect count exceeded` and exits 2. `headers`
 *      said the same site was healthy and exited 0.
 *
 * So the facts are decided here, once: `complete` is false exactly when a
 * redirect was left to follow or no response was ever received, and only a
 * complete reading may speak for the site's headers. The checker records the raw
 * fact (`stopReason`, `statusCode`) and asks here; the terminal asks here.
 * Neither can re-decide it.
 *
 * @param {object} [chain] — `{ stopReason, statusCode, steps, limit }` from
 *   `checkHeaders`.
 */
export function readChain({ stopReason = null, statusCode = null, steps = [], limit = REDIRECT_LIMIT } = {}) {
  const count = Array.isArray(steps) ? steps.length : 0;
  // A `Location` we could not resolve leaves the same dead end a browser hits,
  // and the 3xx is still the site's own response, so the reading is complete.
  const pending = stopReason === CHAIN_STOP.MAX_REDIRECTS || stopReason === CHAIN_STOP.LOOP;
  // No response at all is the other way a reading can be unfinished, and the
  // checker records it as a missing status code: refused, timed out, unresolvable.
  // `stopReason` alone cannot see it, because a failed request stops for no
  // redirect reason at all — so it answered "complete, measured" for a site that
  // was never reached, and `headers --json` published five `null` security headers
  // for it. A site that says nothing has no security posture to report.
  const responded = Number.isInteger(statusCode);
  return {
    complete: !pending && responded,
    // Only a complete reading may be presented as a finding about the site.
    measured: !pending && responded,
    redirectCount: count,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    note: chainStopNote({ stopReason, statusCode, redirectCount: count, limit }),
    finalUrlNote: pending ? '— (redirect chain not followed)' : '',
    securityNote: pending
      ? 'Security headers: not measured — the chain never reached the final response'
      : '',
  };
}

/**
 * The change an event claims, in three words a webhook receiver can branch on.
 *
 * `observed` is only for a transition DeskUptime actually watched happen: the
 * previous pass is recent enough that the two readings are one monitoring loop's
 * worth of evidence. `unobserved` means the event is a comparison against a pass
 * that is missing or older than the staleness window, and `none` is every event
 * that is not a transition at all.
 */
export const TRANSITION = {
  OBSERVED: 'observed',
  UNOBSERVED: 'unobserved',
  NONE: 'none',
};

/** The event types that assert a change of state between two passes. */
const TRANSITION_TYPES = new Set(['up', 'down']);

/**
 * The fixed sentence for a transition DeskUptime did not watch happen, in one
 * place: the desktop notification, the terminal and the webhook payload all say
 * it or none of them do.
 *
 * @param {number|null} ageDays — age of the previous pass, or null when the
 *   state file does not say when it ran
 * @param {'absent'|'unreadable'} [reason] — why there is no age
 */
export function unobservedNote(ageDays, reason) {
  const when = reason === 'absent'
    ? 'no previous check is on record'
    : reason === 'unreadable'
      ? 'the previous check is at an unreadable time'
      : `the last check was ${ageDays} d ago`;
  return `⚠️ not an observed transition — ${when}`;
}

/**
 * One reading of a watch event, shared by every surface that sends one.
 *
 * The webhook payload is the only place in DeskUptime that states a time, and it
 * stated the wrong one. Measured against a real `runPass`, a pass with two sites
 * — one answering instantly, one timing out 800 ms later — produced:
 *
 *   {"type":"down","url":"…/quick","message":"is DOWN — …","timestamp":"…11.849Z"}
 *   {"type":"down","url":"…/slow", "message":"is DOWN — …","timestamp":"…13.870Z"}
 *
 * Both checks *started* at `…11.042Z`; `timestamp` is when the POST body was
 * built, after `printPass` and after the receiver's own latency. A customer whose
 * channel renders that field reads it as "the site broke at 14:26", and nothing
 * in the payload is the time of a measurement.
 *
 * Worse, the same payload asserted a change DeskUptime never saw. With a state
 * file whose last pass was 41 days old — the loop had died, the site was very
 * probably never down — the pass produced:
 *
 *   {"type":"up","url":"https://kunde.dk","message":"is UP (200) — 12ms"}
 *
 * `type: "up"` is a machine-readable claim that the site transitioned. The
 * transition is measured against a 41-day-old reading. On that same state file
 * `deskuptime status` says `stale — last check 41 d ago` and the client report
 * says the same, so the two human surfaces had the age and the payload — the one
 * a machine reads — did not.
 *
 * So the facts are decided here, once. `runPass` records the raw truth of what it
 * saw (`measuredAt`, the pass's own time; `previousChecked`, the time of the
 * reading a transition is compared against) and asks here for the sentence. The
 * payload asks here too, with the *pass's* time as the reference so the message
 * and the payload can never disagree about how old the previous check is.
 *
 * @param {object} [event] — `{ type, measuredAt, previousChecked }`
 * @param {Date}   [now]  — defaults to the event's own `measuredAt`, so every
 *   reader of the same event gets the same answer
 */
export function readEvent(event = {}, now) {
  const value = event && typeof event === 'object' ? event : {};
  const reference = now instanceof Date ? now
    : (typeof value.measuredAt === 'string' && !Number.isNaN(Date.parse(value.measuredAt)) ? new Date(value.measuredAt) : new Date());
  if (!TRANSITION_TYPES.has(value.type)) {
    return { transition: TRANSITION.NONE, ageDays: null, note: '' };
  }
  // Observed needs a previous pass that is *present* and *recent*. Note the
  // difference from the client report: `isCheckStale` deliberately treats an
  // absent timestamp as "not stale", because the report already says "not
  // checked yet" and flagging twice says nothing. An event has no such second
  // surface — a `down` fired against `wasUp: true` with no pass behind it (a
  // hand-edited or half-written state file) compares against nothing at all, and
  // measured, that is exactly what `transition: "observed"` used to claim.
  const hasPrevious = typeof value.previousChecked === 'string' && value.previousChecked.length > 0;
  const reason = !hasPrevious ? 'absent'
    : Number.isNaN(Date.parse(value.previousChecked)) ? 'unreadable'
      : null;
  const ageDays = checkAgeDays(value.previousChecked, reference);
  const observed = reason === null && !isCheckStale(value.previousChecked, reference);
  return {
    transition: observed ? TRANSITION.OBSERVED : TRANSITION.UNOBSERVED,
    ageDays,
    note: observed ? '' : unobservedNote(ageDays, reason),
  };
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function invalidHttpUrls(urls) {
  return urls.filter(url => !isHttpUrl(url));
}

export function assertValidHttpUrls(urls) {
  const invalidUrls = invalidHttpUrls(urls);
  if (invalidUrls.length > 0) {
    throw new TypeError(`Invalid URL: ${invalidUrls.join(', ')}`);
  }
}

export function isHealthyStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400;
}

export function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;

  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { errorType: 'timeout', error: 'Request timed out' };
  }
  if (code === 'ECONNREFUSED') {
    return { errorType: 'connection_refused', error: 'Connection refused' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { errorType: 'dns_error', error: cause.message || 'Host could not be resolved' };
  }

  return {
    errorType: 'network_error',
    error: cause?.message || error?.message || 'Network request failed',
  };
}
