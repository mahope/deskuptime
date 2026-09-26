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

/**
 * The host part of a URL, or `null` when the string is not a URL.
 *
 * `host` and not `hostname`: a redirect from `http://acme.dk` to
 * `http://acme.dk:8080` is a different server, not a spelling of the same one.
 * It also drops the default port, so `http://acme.dk` and `http://acme.dk:80/`
 * are one host — the thing `new URL()` already normalises for us.
 */
function hostKey(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Which host actually answered, and whether it is the one that was asked.
 *
 * The measurement was already made and thrown away. `checkReachability` reads
 * `response.url` — the URL undici landed on after following redirects — and
 * `checkUrl` copies it into `result.finalUrl`, and there it stopped: not the
 * terminal, not `check --json`, not `watch`, not the client report. Measured
 * with the real CLI against a local site that 301s to a different host and
 * answers 200 there — a registrar's parking page, or a hijacked domain pointed
 * at one:
 *
 *   $ deskuptime check http://127.0.0.1:58853/
 *   ✅ http://127.0.0.1:58853/
 *      Status:   200 — UP                                    ← exit 0
 *   $ deskuptime headers http://127.0.0.1:58853/
 *      301 → http://127.0.0.1:58851/lander
 *      Final: http://127.0.0.1:58851/lander (200) — redirected ← the truth
 *
 * So "UP" was a claim about a URL nobody asked about. A client's domain that
 * expires and gets parked answers 200, and a bureau's report says 100 % uptime
 * for a month; a domain pointed at a phishing page stays green; a typo in the
 * monitored URL lands on a registrar's "did you mean" page and stays green. The
 * one surface that did the walk said so, and the surfaces that decide the verdict
 * could not, because the fact never left the engine.
 *
 * This is a fact, not an alarm. `www.acme.dk → acme.dk` is the most ordinary
 * redirect on the web and it is *reported* here too, on purpose: the tool cannot
 * know which host change is intended, so it names the change and the reader
 * decides. A redirect is never a DOWN — that would be a false alarm on a
 * healthy site.
 *
 * `offHost` is `false` whenever either host cannot be read, because a rule that
 * cannot be measured must not claim anything (the same bar `readSslState` and
 * `readContentState` are held to).
 *
 * `note` is the sentence, `label` the same fact in the few words a table cell,
 * a list row or a notification can carry. Both are written here so a surface
 * cannot reach for `finalUrl` and re-describe the host change in its own words
 * — that is the copy P1-26 removed from `check`, and the four paid surfaces had
 * the same opportunity.
 *
 * @param {object} [state] — `{ url, finalUrl }`; `finalUrl` is null when no
 *   response was received at all.
 * @returns {{ finalUrl: string|null, offHost: boolean, askedHost: string|null, answeredHost: string|null, note: string, label: string }}
 */
export function readRedirectTarget({ url = '', finalUrl = null } = {}) {
  const askedHost = hostKey(url);
  const answeredHost = hostKey(finalUrl);
  const measured = typeof finalUrl === 'string' && finalUrl !== '' && askedHost !== null && answeredHost !== null;
  const offHost = measured && askedHost !== answeredHost;
  return {
    finalUrl: typeof finalUrl === 'string' && finalUrl ? finalUrl : null,
    offHost,
    askedHost,
    answeredHost,
    note: offHost
      ? `answered by another host — the response came from ${answeredHost}, not ${askedHost}`
      : '',
    label: offHost ? `answered by ${answeredHost} (asked ${askedHost})` : '',
  };
}

/** A page title, but only a real one: a string with something in it. */
function titleText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * What a `content_changed` alert can honestly say.
 *
 * Measured 26/9 with the real CLI and a real receiver: a page whose bytes change
 * without changing length — a price, a name, a CSRF token, a timestamp of the
 * same width — produced
 *
 *     🔄 https://kunde.dk/ content changed (124 → 124 bytes)
 *
 * The claim and its own evidence contradict each other. The change is real — the
 * hashes differ, and that is what fired the event — but the one number printed
 * beside it says the page is byte-for-byte the size it was, which is the reading
 * a bureau takes to mean "nothing changed". A same-size change is not an edge
 * case: it is the common case, and it is the case a customer is most likely to
 * want to hear about, because a page that still renders at its old size is often
 * a page that is serving a broken deploy.
 *
 * So the size is only evidence when the size moved. When it did not, the alert
 * says that plainly instead of printing the same number twice, and it names the
 * one part of the page DeskUptime reads anyway: the `<title>`. `content.js` has
 * extracted the title on every pass since the beginning and no surface used it,
 * so the title is a measurement that costs nothing and is thrown away — and it is
 * the human-readable part of the change. A title that changed is the strongest
 * signal here, because a title is what a customer would recognise in a screenshot.
 *
 * Returns the message plus whether the title actually moved, so the caller does
 * not re-derive it. A page with no readable `<title>`, or one whose title did not
 * change, gets the honest size sentence rather than a guess.
 */
export function readContentChange({ previousLength = null, length = null, previousTitle = null, title = null } = {}) {
  const before = titleText(previousTitle);
  const after = titleText(title);
  const titleChanged = before !== null && after !== null && before !== after;
  const sameSize = Number.isFinite(previousLength) && Number.isFinite(length) && previousLength === length;

  if (sameSize) {
    return {
      titleChanged,
      message: titleChanged
        ? `content changed — page title: "${before}" → "${after}" (same size, ${length} bytes)`
        : `content changed — same size (${length} bytes): the page's bytes differ`,
    };
  }

  // The size moved, or one side of it is not a number we can print. The old
  // wording, unchanged, including the `?` for a baseline with no length: it is
  // correct in every case where the numbers actually differ.
  return {
    titleChanged,
    message: `content changed (${Number.isFinite(previousLength) ? previousLength : '?'} → ${Number.isFinite(length) ? length : '?'} bytes)`,
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
 * Which of the three states a header value is in.
 *
 * The one classifier in this file. A measured fact must never be turned into "we
 * saw nothing" because the value happened to be falsy, so both readers below ask
 * this instead of deciding for themselves.
 *
 * @param {unknown} value — a header value as the HTTP layer produced it, `null`
 *   for a header the site never sent, or `undefined` for one a caller omits.
 * @returns {string} one of {@link SECURITY_HEADER}
 */
function headerState(value) {
  if (value === null || value === undefined) return SECURITY_HEADER.ABSENT;
  // `trim()` is belt and braces: the value is always a string here, but a caller
  // that hands us one built from a number must not read as a header with content.
  if (String(value).trim() === '') return SECURITY_HEADER.EMPTY;
  return SECURITY_HEADER.PRESENT;
}

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
    const state = headerState(value);
    if (state === SECURITY_HEADER.ABSENT) absent.push(name);
    else if (state === SECURITY_HEADER.EMPTY) empty.push(name);
    else present.push([name, value]);
  }
  return { present, empty, absent };
}

/**
 * One reading of the two headers that say what a site is built on, shared by
 * every surface that shows them.
 *
 * Measured with a real CLI against a server sending `X-Powered-By: ` and
 * `Server:   `, before any code changed:
 *
 * *   x-powered-by:               (no value)
 *     headers        ->  no line at all
 *     headers --json ->  "poweredBy": null, "server": null
 *
 * The same `|| null` P1-24 removed on the five judged headers, on the two fields a
 * bureau reads as a disclosure finding. `X-Powered-By exposed` is a named warning
 * in `headers`, and an empty value made it disappear: the tool told a bureau that
 * a customer's site discloses no stack, while the site was in fact sending the
 * header — and the JSON it pipes into the customer's own report said `null`, which
 * reads as "we looked, it was not there".
 *
 * An empty value here is not the finding's whole story, so it is not folded into
 * the five judged headers either. The site sends the marker and names no stack,
 * which is a third thing to report: smaller than a version string, and different
 * from never sending it. Callers pick their own sentence; neither may re-decide
 * which of the three states a field is in.
 *
 * @param {object} [disc] — `{ server, poweredBy }` as `checkHeaders` wrote them.
 * @returns {{ server: object, poweredBy: object, empty: string[] }} each field
 *   is `{ state, value }`, and `empty` names the fields sent with no value.
 */
export function readDisclosure(disc = {}) {
  const { server = null, poweredBy = null } = disc && typeof disc === 'object' ? disc : {};
  const read = (value) => ({ state: headerState(value), value: value ?? null });
  const fields = { server: read(server), poweredBy: read(poweredBy) };
  const empty = [];
  if (fields.server.state === SECURITY_HEADER.EMPTY) empty.push('server');
  if (fields.poweredBy.state === SECURITY_HEADER.EMPTY) empty.push('x-powered-by');
  return { ...fields, empty };
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
 * A recorded time, when it is one we can read — otherwise `null`.
 *
 * `readStatusCode`'s sibling, for the two timestamps the client report forwards.
 * They were the last two raw values in `report --json`: the same document
 * printed `—` for an unreadable pass time and named it `stale — last check
 * unreadable` in Markdown, while the machine surface a CI job or an agency's own
 * system reads carried the state's own string. Measured through the real CLI on a
 * hand-edited state file, no code changed:
 *
 *   | https://a.dk/ | UP (200) ⚠️ stale — last check unreadable | … | — |   ← Markdown
 *   "lastChecked": "OWNED"                                                      ← --json
 *   "monitoringSince": "OWNED"
 *
 * So the paid machine surface forwarded, verbatim, a value the human surface had
 * already declared unreadable — and a state file is user input (restored from a
 * backup, hand-edited, written by another tool), which is the whole reason
 * `readStatusCode` clamps and `readSslState` measures before answering. A
 * consumer that feeds `lastChecked` into a dashboard gets `OWNED` on a timeline;
 * one that does `new Date(site.lastChecked)` gets `NaN` and shows "Invalid Date".
 *
 * `null` is the answer the rest of the report already gives, and it is falsy, so
 * a consumer's `if (site.lastChecked)` behaves as it does for a site that was
 * never checked. Readable timestamps are returned canonicalised to ISO, so the
 * JSON carries the same instant the Markdown column prints.
 *
 * @param {*} value — a raw `lastChecked` or `addedAt` from a state file
 */
export function readPassTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
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
 *
 * The negative age is read by `passAge` below, which is the one decision about
 * it. It used to have no reader at all: `checkAgeDays` floored it at 0, so the
 * one path that could see it threw the sign away, and a pass dated 19 days from
 * now was reported as `ageDays: 0` — "checked today".
 */
export function checkAgeMs(lastChecked, now = new Date()) {
  if (typeof lastChecked !== 'string' || !lastChecked) return null;
  const parsed = Date.parse(lastChecked);
  if (Number.isNaN(parsed)) return null;
  return now.getTime() - parsed;
}

/**
 * The four things a recorded pass time can be, in one owner.
 *
 * Every surface that shows a pass asks this, because each of the four used to
 * be decided somewhere else and the two middle ones printed the same words.
 * Measured on one state file, with a pass dated 19 days into the future on a
 * machine whose clock is right:
 *
 *   | http://127.0.0.1:8811/ | UP (200) | 100% | … | 2026-10-15 10:24 UTC |
 *   **2 site(s) · 1 up · 1 down · 2 checks · 1 failed**
 *
 * A document generated 2026-09-26 told a customer their site was last checked
 * on 2026-10-15, counted it as currently up, and `--json` said
 * `"ageDays": 0` — three claims, all of them wrong, in the one file a bureau
 * forwards. The other three states were already distinguished; this one was
 * floored into "today" and lost.
 *
 * `aged` is the ordinary case and is what every other measurement assumes.
 * `never` and `unreadable` are kept apart because they are different facts
 * about *history*, not two ways of saying "unknown" (P1-14). `ahead` is the
 * fourth: a time that reads cleanly and lies about when it was written, which
 * happens when the machine's clock was wrong, when a state file was restored
 * onto a machine in another timezone than it was written in, and when a
 * backup was replayed.
 *
 * P1-6 decided that a future timestamp must not be marked *stale*: a stale
 * marker is a claim that monitoring stopped, and on a machine with a wrong
 * clock that would invent an outage. That decision is kept exactly — `ahead`
 * is not `aged` for the purpose of `isCheckStale`, and no surface here says a
 * site is down, unreachable or unmonitored. What changes is that the age stops
 * being a false `0` and the skew is named instead of being printed as a check
 * that has not happened yet.
 */
export const PASS_AGE = {
  /** No pass has ever been recorded for this site. */
  NEVER: 'never',
  /** A pass was recorded and its time cannot be read at all. */
  UNREADABLE: 'unreadable',
  /** The time reads cleanly and lies: it is later than this machine's clock. */
  AHEAD: 'ahead',
  /** A readable time that is not in the future. The ordinary case. */
  AGED: 'aged',
};

/**
 * How old the newest recorded pass is, as one of the four `PASS_AGE` states.
 *
 * `ageDays` is whole days since the pass, and `null` whenever there is no
 * honest number to give: no pass, an unreadable one, and a pass whose time is
 * in the future. A `0` in `ageDays` is a claim — "checked today" — and it must
 * only ever be reachable by a pass that really did happen today. That is the
 * whole point of this function: `Math.max(0, …)` in `checkAgeDays` made a
 * clock 19 days fast indistinguishable from a check this morning.
 *
 * `aheadMs` is how far ahead the clock is, for the surfaces that name it.
 *
 * `passMs` is *when the pass was recorded*, in epoch ms — the one decision a
 * surface that has to place the pass on a calendar day must not make for
 * itself. It is `null` whenever the time cannot be placed: no pass, an
 * unreadable one, and a pass dated ahead of this machine's clock. The last one
 * matters, because "cannot be placed" is not the same as "is somewhere else":
 * a pass in the future has no day that belongs to a past window, and
 * `history.js` used to decide that for itself by comparing day keys. Measured
 * on a state file whose clock was 6 h fast, next to one whose clock was 23 h
 * fast — the same condition, two sentences in the same column:
 *
 *   — (last check missing from the history file)     ← +6 h, the pass is in the future
 *   — (no pass in the last 1 d)                      ← +23 h, the pass is in the future
 *
 * Only the number of hours separated them. It asked the owner instead.
 */
export function passAge(lastChecked, now = new Date()) {
  const age = checkAgeMs(lastChecked, now);
  if (age === null) {
    // `checkAgeMs` returns null for both "no string" and "no parseable date", so
    // the two are told apart here, by the raw value — the same separation
    // `passRecorded` carries into the report, for the same reason.
    return {
      state: typeof lastChecked === 'string' && lastChecked !== '' ? PASS_AGE.UNREADABLE : PASS_AGE.NEVER,
      ageMs: null,
      ageDays: null,
      aheadMs: 0,
      passMs: null,
    };
  }
  if (age < 0) return { state: PASS_AGE.AHEAD, ageMs: age, ageDays: null, aheadMs: -age, passMs: null };
  return {
    state: PASS_AGE.AGED,
    ageMs: age,
    ageDays: Math.floor(age / MS_PER_DAY),
    aheadMs: 0,
    // The inverse of the subtraction `checkAgeMs` just did, so the sign
    // survives in both directions: a negative age yields an instant after
    // `now`, which is why that branch returns `null` instead.
    passMs: now.getTime() - age,
  };
}

/**
 * The fixed wording for a pass whose time lies ahead of this machine's clock,
 * in one place. Empty string for every other state, so a caller can print it
 * unconditionally and get nothing for an ordinary pass.
 *
 * The unit follows the size, because the two are different problems: a pass
 * 40 seconds ahead is a clock drifting mid-check, and a pass 19 days ahead is
 * a clock that was set wrong, a state file restored from another machine, or a
 * backup replayed. One unit for both would say "0 d ahead" about the first.
 */
export function clockAheadNote(aheadMs) {
  if (!Number.isFinite(aheadMs) || aheadMs <= 0) return '';
  const seconds = Math.round(aheadMs / 1000);
  if (seconds < 90) return `${seconds} s ahead of this machine's clock`;
  const minutes = Math.round(aheadMs / (60 * 1000));
  if (minutes < 90) return `${minutes} min ahead of this machine's clock`;
  const hours = Math.round(aheadMs / (60 * 60 * 1000));
  if (hours < 36) return `${hours} h ahead of this machine's clock`;
  return `${Math.round(aheadMs / MS_PER_DAY)} d ahead of this machine's clock`;
}

/**
 * True only when a pass is known to have run and is older than the window.
 *
 * Absent `lastChecked` is *not* stale: the report already shows such a site as
 * "not checked yet", and flagging it twice would say nothing new. A timestamp
 * that is present but unreadable *is* stale — a pass was recorded and we cannot
 * show that it is current, which is exactly what a client report must not do.
 *
 * A timestamp *ahead* of this machine's clock is neither, and that is P1-6's
 * decision, kept deliberately: a wrong clock is not old data, and a stale
 * marker is a claim that monitoring stopped. The branch is written out rather
 * than left to fall out of a comparison, because the comparison is exactly what
 * hid it — a negative age fails `> STALE_AFTER_DAYS` and read as an ordinary
 * current pass, which is how a machine whose clock was 19 days fast came to
 * report `ageDays: 0` and count as up in a customer document.
 *
 * The window is compared in ms, not in floored days, so `2.9 d` and `2.0 d` do
 * not swap sides when the day-count rounding changes.
 */
export function isCheckStale(lastChecked, now = new Date()) {
  const pass = passAge(lastChecked, now);
  if (pass.state === PASS_AGE.NEVER) return false;
  if (pass.state === PASS_AGE.UNREADABLE) return true;
  if (pass.state === PASS_AGE.AHEAD) return false;
  return pass.ageMs > STALE_AFTER_DAYS * MS_PER_DAY;
}

/**
 * Whole days since the last pass, for display. `null` when there is no honest
 * number — no pass, an unreadable time, or a time ahead of this machine's clock.
 *
 * Asked of `passAge`, so a pass dated in the future cannot come back as `0`.
 * It used to be `Math.max(0, Math.floor(age / MS_PER_DAY))`, which is a fifth
 * answer the four states do not have: a claim that a check happened today,
 * made about a timestamp that says it has not happened yet.
 */
export function checkAgeDays(lastChecked, now = new Date()) {
  return passAge(lastChecked, now).ageDays;
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
 * @param {object} state — `{ lastChecked, ageDays, clockAhead }`; `ageDays` is
 *   `checkAgeDays(lastChecked)`. A caller that only holds the *readable* time
 *   (`readPassTime`, which is `null` both for "no pass" and for "unreadable")
 *   passes `passRecorded` instead, so the two cases cannot collapse into
 *   "not checked yet" — measured: canonicalising `lastChecked` alone made a site
 *   with an unreadable pass time print "not checked yet" in the summary line
 *   while its own row said "stale — last check unreadable".
 *   `clockAhead` is the owner's sentence for a pass dated ahead of this
 *   machine's clock, and it is asked for before the "unreadable" wording:
 *   without it a clean, readable future time reached this function as a `null`
 *   age and was described as a time that could not be read — the same
 *   collapse one level down, on the one state that reads cleanly.
 */
export function unknownNote({ lastChecked, ageDays, clockAhead = '', passRecorded = Boolean(lastChecked) } = {}) {
  if (!passRecorded) return 'not checked yet';
  if (clockAhead) return `status unknown (last check ${clockAhead})`;
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
 *
 * `url` is the state's own key, not something the entry stores, so it has to be
 * handed in: without it the cross-host reading below is unmeasured and says so.
 */
export function readEntry(entry, { now = new Date(), url = '' } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const ssl = readSslState({
    days: value.sslValidDays,
    expired: value.sslExpired,
    expiredDays: value.sslExpiredDays,
  });
  const stale = isCheckStale(value.lastChecked, now);
  const pass = passAge(value.lastChecked, now);
  const ageDays = pass.ageDays;
  const neverChecked = !value.lastChecked;

  return {
    verdict: verdictFor(value.wasUp),
    // "No pass has ever run" and "the last pass ran but its verdict cannot be
    // read" are different facts that used to print identically, in both
    // terminal lists and in the report. The two surfaces now ask for the same
    // sentence, so neither can discover the difference on its own.
    neverChecked,
    unknownNote: unknownNote({ lastChecked: value.lastChecked, ageDays, clockAhead: clockAheadNote(pass.aheadMs) }),
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
    // Which of the four recorded-time states this entry is in, and what to say
    // about it when the time lies ahead of this machine's clock. Added for the
    // same reason the entry above is a single object: the two terminal lists
    // print the pass time themselves, and a time 19 days in the future used to
    // reach both of them as a bare `@ 2026-10-15T10:24:20.661Z` with the age
    // floored to `0`, so a clock that was simply wrong looked like a check that
    // had already happened. The verdict is untouched — a wrong clock is not an
    // outage — and this is the sentence that says so.
    passState: pass.state,
    clockAhead: clockAheadNote(pass.aheadMs),
    // Where the last pass's response came from. The pass measured it, the state
    // file kept it, and the two lists that show an entry could not see it — so a
    // site that had been redirected to another host (a parked domain, a hijacked
    // domain, a typo) printed as a plain `✅ up` here while `check` named the
    // host change. Asked of the one owner, so both lists say the same words and
    // neither compares hosts itself. The `label` is empty unless the answer came
    // from a different host, so an ordinary `www → apex` redirect stays silent.
    redirect: readRedirectTarget({ url, finalUrl: typeof value.lastFinalUrl === 'string' ? value.lastFinalUrl : null }),
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
