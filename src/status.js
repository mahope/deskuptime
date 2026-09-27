import net from 'node:net';

import { safeText } from './display.js';

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
    // Never with credentials in it. This string is published to a customer's own
    // channel (the paid webhook body) and stored in the state file beside the
    // license key, and the redirect that produced it is the one thing on the web
    // that we did not write. Measured 2026-09-27: a `Location:` header carrying a
    // password reached stdout, `--json` and this field; `fetch` itself refuses
    // to build such a request, so the host comparison was never affected (P1-71).
    finalUrl: typeof finalUrl === 'string' && finalUrl ? withoutCredentials(finalUrl) : null,
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

  // The two titles are quoted verbatim, and every surface that prints this
  // sentence flattens the text to one line first — `printPass()` on the terminal
  // and the macOS notification, both through `safeText()`. A title carrying a
  // newline therefore printed the *same* string on both sides of the arrow,
  // which is the sentence contradicting itself, measured 2026-09-27 with the real
  // loop and a real page title holding one line break:
  //
  //   🔄 https://kunde.dk/ content changed — page title: "Free iPhone!!" → "Free iPhone!!"
  //
  // A customer reads that as "the title did not change", while the sentence says
  // it did — and a multi-line `<title>` is ordinary (a template that wraps, a
  // title assembled from two strings). The difference is real and the bytes
  // still differ, so the change is still reported; only the pair of titles is
  // replaced by what a reader can actually see. `safeText()` is the one owner of
  // what a screen shows, so the two sides are compared through it rather than
  // with a second, weaker idea of "printable".
  const pairReadable = !titleChanged || safeText(before, { max: 0 }) !== safeText(after, { max: 0 });

  if (sameSize) {
    return {
      titleChanged,
      message: titleChanged
        ? pairReadable
          ? `content changed — page title: "${before}" → "${after}" (same size, ${length} bytes)`
          : `content changed — page title changed, but the two titles differ only in whitespace or characters a screen cannot show (same size, ${length} bytes)`
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

/**
 * How long one site waits between two *sent* content-change alerts. One hour.
 */
export const CONTENT_ALERT_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * One content-change alert per site per hour — the throttle, and the sentence
 * that accounts for what it held back. `null` means "measured, but not sent".
 *
 * `content_changed` is raised from a hash of the page's bytes, so any page that
 * renders a per-request value — a CSRF nonce, a cache-buster, a "last updated"
 * timestamp, a live counter — differs on *every* pass, and every difference used
 * to become an alert: a POST to the paid channel and a desktop notification,
 * every 30 s, for as long as the loop ran. Measured 2026-09-26 with the real
 * loop over a page carrying a per-request token: three passes, three alerts, and
 * not one of them about anything a customer can act on. The damage is not the
 * volume in itself but what the volume buys — a channel and a notification centre
 * that cry wolf 2 880 times a day get muted, and the muting is what then hides
 * the real `is DOWN`.
 *
 * So the change is still read, hashed, counted and recorded on every pass: this
 * decides what is *sent*, not what is true. The first change after a quiet hour
 * is sent as before, which is what a defaced or redesigned page needs — a
 * defacement is a change, and it is the first change since the last alert. What
 * the throttle held back is counted, never dropped, and the next sent alert says
 * how many changes it stands for, so the silence is accounted for rather than
 * merely quiet.
 *
 * A clock that jumped backwards does not suppress anything: this reads elapsed
 * time, and a negative span is the same clock problem the pass already names
 * (`clockAhead`), not evidence about the page.
 */
export function readContentChangeAlert({ change, previousAlertedAt = null, counted = 0, now = new Date(), minGapMs = CONTENT_ALERT_MIN_GAP_MS } = {}) {
  const last = typeof previousAlertedAt === 'string' ? Date.parse(previousAlertedAt) : Number.NaN;
  const elapsed = now.getTime() - last;
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minGapMs) return null;
  const held = Number.isInteger(counted) && counted > 0 ? counted : 0;
  return {
    message: held > 0
      ? `${change.message} (${held} earlier change${held === 1 ? '' : 's'} since the last alert, not sent)`
      : change.message,
    held,
  };
}

/**
 * The *content* of a monitored site, as one report reads it — and the one place
 * that decides what a surface may say about a change.
 *
 * The feature matrix promises "content-change detection" in both tiers, and the
 * detector has worked since P0-3: `content.js` hashes every page on every pass,
 * `runPass` raises `content_changed`, the terminal prints it and the webhook
 * POSTs it to the paid channel. What no surface could do was *report* it. The
 * client report — the document a bureau forwards to the customer it monitors —
 * had no content column, no content line and no content count. Measured 2026-09-27
 * with the real CLI, a real Pro record and a real page swapped for
 * `<title>Free iPhone!!</title>`:
 *
 *   pass    →  🔄 http://kunde.dk/ content changed (70 → 91 bytes)
 *   report  →  | http://kunde.dk/ | UP (200) | 100% (7 checks) | … | 51 ms | — | … |
 *              **1 site(s) · 1 up · 0 down · 7 checks · 0 failed**
 *
 * One document said the page changed, the other said nothing — and the second is
 * the one the customer receives. A defaced homepage, a hacked site and a
 * redirect-in-disguise all read as `UP (200) | 100%` to the recipient, which is
 * the same failure the report already fixed twice for certificates: a fact that
 * is measured, kept in `state.json` (`lastHash`, `lastContentLength`,
 * `lastTitle`) and then thrown away before the paid surface.
 *
 * So the reading is made here, once, and the report asks for it. Two facts, kept
 * apart on purpose:
 *
 * - `changed` is the *last measured* change and `changedAt` when it happened. A
 *   change is a fact about the past, not about now, so it ages: a site whose page
 *   changed 40 days ago and has been quiet since is not "changed" in the sense
 *   the reader would take it. `ageDays` is what the report prints next to it, and
 *   it is asked of `passAge` — the one owner of a recorded time — so this cannot
 *   become a second, disagreeing clock.
 * - `bytes` is the size the last pass read, and it is `null` unless a pass
 *   actually read the body. `content.js` skips a page over 2 MiB and leaves
 *   `lastContentLength` untouched, so without this the report would print the size
 *   from an *earlier* pass as if it described the page now. Measured: a pass that
 *   skipped a 3 MiB page still published `contentBytes: 70` from the pass before
 *   it, with nothing on the surface saying the reading was not from this check.
 *
 * `titleChanged`/`title` are what `readContentChange` above already extracted and
 * no surface could print: the page's own `<title>`, which is the part a customer
 * recognises in a screenshot.
 *
 * @param {object} entry — one `state.urls[...]` entry.
 * @param {object} [options] — `{ now }`, so a test can place the reading.
 */
export function readContentChangeState(entry, { now = new Date() } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  // A site whose page was never hashed has no content claim at all. `null`, not
  // `false`: `false` would be a statement about a page nobody read.
  const changed = typeof value.lastContentChangedAt === 'string' && value.lastContentChangedAt !== '';
  // Asked of the one owner, so a hand-edited time ahead of this clock cannot be
  // aged into "changed today" here and something else there (P1-31's rule).
  const reading = passAge(changed ? value.lastContentChangedAt : null, now);
  // A change in the future is a clock problem, not a fact about the page, so it
  // is never printed as one: no age, and the caller's own clock note says why.
  const ageDays = reading.state === PASS_AGE.AGED ? reading.ageDays : null;
  return {
    changed,
    changedAt: changed ? value.lastContentChangedAt : null,
    ageDays,
    aheadMs: reading.aheadMs,
    // The size of the page as the *last reading that measured it* saw it, and
    // when that reading was taken — so a surface can tell a fresh size from one
    // that has outlived the check that produced it.
    bytes: byteCount(value.lastContentLength),
    bytesReadAt: typeof value.lastContentReadAt === 'string' && value.lastContentReadAt !== '' ? value.lastContentReadAt : null,
    title: titleText(value.lastTitle),
    // The sentence, built here from exactly the fields just decided, so a
    // caller cannot assemble it from a different set. Measured: the first
    // version had the report hand a *site* object to a function that read the
    // *reader's* field names, and the named line rendered as
    // `https://kunde.dk/ ()` — the sentence and the column had stopped being
    // the same decision.
    note: contentChangeNote({ changed, ageDays, aheadMs: reading.aheadMs, title: value.lastTitle }),
  };
}

/**
 * What a surface says about a site's content, in one sentence.
 *
 * A changed page is named with its age, because "the page changed" without a
 * date reads as "the page changed this morning" — and a report is read once,
 * often days after the pass that produced it. An unchanged page says nothing
 * rather than "no change": that would be the false all-clear P1-21 removed from
 * `check --json`, and a page nobody has read deserves no sentence at all.
 */
export function contentChangeNote({ changed = false, ageDays = null, aheadMs = 0, title = null } = {}) {
  if (changed !== true) return '';
  if (Number.isFinite(aheadMs) && aheadMs > 0) return `🔄 content changed — last change ${clockAheadNote(aheadMs)}`;
  const when = ageDays === null ? 'at an unreadable time' : ageDays === 0 ? 'today' : `${ageDays} d ago`;
  const named = titleText(title) === null ? '' : ` — page title: "${titleText(title)}"`;
  return `🔄 content changed ${when}${named}`;
}

/**
 * How long one site waits between two *sent* alerts of the same kind, once it
 * is flapping. Fifteen minutes — see {@link readTransitionAlert} for why this
 * window is a quarter of the content-change one.
 */
export const TRANSITION_ALERT_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * How many up/down transitions a site may show in the window before its alerts
 * are throttled at all. Four.
 */
export const TRANSITION_FLAP_THRESHOLD = 4;

/**
 * Whether a site's `is DOWN` / `is UP` alert is *sent*, and the sentence that
 * accounts for what it held back. `null` means "measured, but not sent".
 *
 * A site that flaps — up, down, up, down — raises a transition on every pass,
 * and every transition became an alert: a POST to the paid channel and a desktop
 * notification, 30 s apart, for as long as the loop ran. Measured 2026-09-27
 * with the real `runPass` and a real receiver against a site that alternated 200
 * and 500: six alerts out of eight passes, and at the shortest Pro interval
 * 5 760 a day, per site. The harm is the one the content throttle was written
 * for, in the sibling class: a channel that screams all day is muted, and the
 * muting is what then hides a real `is DOWN`.
 *
 * So an alert about uptime is *not* throttled on a timer alone. A customer buys
 * this product to hear the moment a site breaks, and a per-window cap on
 * `down` — with no other condition — can spend the window in silence: a site
 * that flapped twice, went down at 14:30 and stayed down would have its outage
 * held until the next window, and the customer would be told nothing at all.
 * So the throttle only engages on a site that is *already* flapping —
 * {@link TRANSITION_FLAP_THRESHOLD} transitions inside the window before this
 * one. Below that, every transition is sent exactly as before: the single
 * outage, the outage that recurs twice a day and the outage that recurs four
 * times an hour are all untouched, and the promise the customer paid for is
 * unchanged.
 *
 * Above the threshold, one alert of each kind per window, and what was held is
 * counted, never dropped: the next alert that is sent says how many it stands
 * for. `down` and `up` keep separate windows and separate counts, so a flapping
 * site still hears that it is up.
 *
 * **The price, stated plainly:** once a site is flapping, a genuine outage can
 * wait up to {@link TRANSITION_ALERT_MIN_GAP_MS} to be announced, and the
 * customer sees the count on the next alert rather than at the moment. That is
 * the trade the shorter window buys down from an hour to fifteen minutes, and it
 * is why the threshold exists at all — the question of whether a flapping site
 * should instead get a dedicated "this site is flapping" alert is open for Mads.
 *
 * A clock that jumped backwards does not suppress anything: a negative span is
 * the clock problem the pass already names (`clockAhead`), not evidence about
 * the site.
 *
 * @param {object} args
 * @param {'up'|'down'} args.type — which transition this is.
 * @param {string} args.message — the sentence the pass already built.
 * @param {string[]} [args.recentAt] — when this site's earlier transitions
 *   happened, oldest first, as the state file records them.
 * @param {string|null} [args.previousAlertedAt] — when this kind of alert was
 *   last *sent* for this site.
 * @param {number} [args.counted] — how many were held since then.
 */
export function readTransitionAlert({ type, message, recentAt = [], previousAlertedAt = null, counted = 0, now = new Date(), minGapMs = TRANSITION_ALERT_MIN_GAP_MS, threshold = TRANSITION_FLAP_THRESHOLD } = {}) {
  const at = now.getTime();
  const stamp = now.toISOString();
  const inWindow = (value) => {
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    const elapsed = at - ms;
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minGapMs;
  };
  // Measured, not guessed: how many transitions this site has already shown
  // inside the window. A hand-edited or restored file can only make this list
  // shorter or unreadable, never longer than the timestamps it carries.
  const earlier = (Array.isArray(recentAt) ? recentAt : []).filter(inWindow);
  // The list the pass records, so "how often has this site flapped" stays a fact
  // read from the file and the state cannot grow without bound. Pruning and
  // ageing live here, not in the pass: a surface that did it itself is how this
  // repo got a clock 6 h fast wrong twice (P1-32).
  const transitions = [...earlier, stamp].slice(-24);
  if (earlier.length < threshold) return { message, held: 0, flapping: false, transitions };
  const last = typeof previousAlertedAt === 'string' ? Date.parse(previousAlertedAt) : Number.NaN;
  const elapsed = at - last;
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minGapMs) return null;
  const held = Number.isInteger(counted) && counted > 0 ? counted : 0;
  const noun = type === 'up' ? 'recovery' : 'outage';
  return {
    message: held > 0
      ? `${message} (${held} earlier ${noun}${held === 1 ? '' : 's'} since the last alert, not sent)`
      : message,
    held,
    flapping: true,
    transitions,
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
 *   - `mayHaveExpired` is the reading's own *age*. A day count is a countdown,
 *     and a countdown is only a claim while it still counts down: `validDays` was
 *     true at the pass that read it, and nothing about it stays true. Callers
 *     that read a stored `sslValidDays` hand in `measuredAt` (the pass time) and
 *     `now`, and the certificate's own deadline is checked against them. Without
 *     a `measuredAt` there is no claim to make — that is the freshly measured
 *     case, where `check` and the watch loop call in.
 *   - `expiringSoon` is false for a certificate that may already be gone, for
 *     the same reason it is false for a lapsed one: "renew soon" is a statement
 *     about the future, and there may be no future left to renew into.
 *
 * A lapsed reading (`expired`) is deliberately *not* aged: a certificate that had
 * expired at the pass has not un-expired since, so an old lapse claim errs in the
 * safe direction and needs no correction.
 *
 * @param {object} ssl — `{ days, expired, expiredDays, measuredAt, now }`; `days`
 *   is the checker's `validDays` or the state entry's `sslValidDays`.
 */
export function readSslState(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : {};
  const days = Number.isFinite(value.days) && value.days >= 0 ? Math.floor(value.days) : null;
  const expiredDays = expiredDaysCount(value.expiredDays);
  const expired = value.expired === true || expiredDays !== null;
  // A certificate was read when it left us one fact: a day count, or a lapse.
  const measured = days !== null || expired;
  const reading = readSslReadingAge(days, { measuredAt: value.measuredAt, now: value.now, expired });
  return {
    days,
    expired,
    expiredDays,
    measured,
    // Not `false` for a URL with no certificate: see above. The `expired` and the
    // `mayHaveExpired` cases are measured, and stay false — a lapsed certificate
    // is not "renew soon".
    expiringSoon: !measured ? null : (!expired && !reading.mayHaveExpired && isSslExpiringSoon(days)),
    // A field that was present but unreadable is reported as unknown; a field
    // that was never there says nothing at all, so plain-HTTP monitoring does
    // not grow a column of dashes.
    unreadable: value.days !== undefined && value.days !== null && days === null && !expired,
    // How old the reading is in whole days, and whether the certificate may have
    // lapsed since. Both `null`/`false` when the caller did not say when the
    // reading was taken, so a surface that just measured the certificate is
    // untouched.
    readingAgeDays: reading.ageDays,
    mayHaveExpired: reading.mayHaveExpired,
  };
}

/**
 * A certificate day count is a countdown, and a countdown expires.
 *
 * The measurement is the checker's own: `validDays = Math.round((validTo - now) /
 * DAY)` at the pass (src/checkers/ssl.js). So the deadline the reading implies is
 * not one instant but a half-day-wide interval, and the *earliest* end of it is
 * what a client report must plan around. Once the clock has passed that earliest
 * end, the certificate may be gone even though every surface still printed a
 * number. Measured through the real `report`, no code changed, one state file
 * whose newest pass was 36 h old and had read `sslValidDays: 1`:
 *
 *   | https://kunde.dk/ | UP (200) | … | ⚠️ 1 d — renew soon | 2026-09-25 03:04 UTC |
 *   **1 site(s) · 1 up · 0 down · 1200 checks · 50 failed · 1 SSL expiring soon**
 *   **SSL certificate expiring within 14 days — renewal needed:** https://kunde.dk/ (1 d)
 *
 * A day count that reads "1 d left" is at most half a day of a promise, and the
 * promise was made 36 hours ago: the certificate had almost certainly lapsed
 * before the report was written. A bureau forwards that line to a client, the
 * client renews "in a day", and the site is broken in the meantime — the one
 * output the paid tier exists for.
 *
 * The bound is deliberately the permissive one (the earliest instant the
 * reading's own rounding allows) and it only engages once the reading is at
 * least a day old: below that the number is the ordinary countdown every surface
 * has always printed, and an hour-old reading of `0 d` must not start shouting.
 * `passAge` decides whether the reading can be placed at all, so a never,
 * unreadable or future-dated pass time produces no claim in either direction.
 */
function readSslReadingAge(days, { measuredAt, now = new Date(), expired }) {
  if (days === null || expired) return { ageDays: null, mayHaveExpired: false };
  if (typeof measuredAt !== 'string' || !measuredAt) return { ageDays: null, mayHaveExpired: false };
  // Asked of the one owner of a pass time, so a pass dated ahead of this
  // machine's clock cannot be aged here a second way (P1-31's lock). `null` for
  // a pass time that cannot be placed — no pass, unreadable, or ahead — and an
  // unplaceable reading makes no claim in either direction: it is not proof that
  // the certificate is fine.
  const pass = passAge(measuredAt, now);
  if (pass.ageMs === null || pass.state === PASS_AGE.AHEAD) return { ageDays: null, mayHaveExpired: false };
  const mayHaveExpired = pass.ageMs >= MS_PER_DAY && pass.ageMs >= (days - 0.5) * MS_PER_DAY;
  return { ageDays: pass.ageDays, mayHaveExpired };
}

/**
 * Who issued the certificate, as one line of text — or `null` when no
 * certificate was read.
 *
 * `src/checkers/ssl.js` has measured `issuer` on every SSL check since P0-3 and
 * **no surface could read it**: not `check`, not `check --json`, not either
 * status list, not the client report. Meanwhile the feature matrix — the source
 * of truth behind the README table, `--help`, the npm description and
 * `docs/pro-alerts.md` — promises "issuer" in *both* tiers, so the claim was
 * locked by `test/claims.test.js` while nothing delivered it. "Who issued this
 * certificate?" is the first question an agency is asked about a customer's
 * site, and the answer was in the data the whole time.
 *
 * `O` before `CN`, because a modern public certificate puts the authority in
 * `O` and leaves `CN` as a rotating short code (`R11`), which is not a name. A
 * self-signed or private certificate often has no `O` at all and only `CN`.
 * A string is kept as it came: older Node hands back the flattened
 * `C=…, O=…, CN=…` form, and inventing a second spelling of that would be a
 * second owner of the same fact.
 *
 * The value is chosen by whoever issued the certificate, so a terminal surface
 * must pass it through `safeText()` — see src/display.js.
 */
export function readSslIssuer(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : null;
  const issuer = value?.issuer;
  if (typeof issuer === 'string') return issuer.trim() || null;
  if (!issuer || typeof issuer !== 'object') return null;
  for (const key of ['O', 'CN']) {
    const name = issuer[key];
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

/** One socket-supplied name, trimmed, or `null` for anything that is not one. */
function readNegotiatedName(name) {
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * The TLS version and cipher suite the connection actually negotiated — or
 * `null` for each, when no handshake was read.
 *
 * `src/checkers/ssl.js` has measured `protocol` and `cipher` on every SSL check
 * since P0-3 and **no surface could read them**: `check` printed the days and the
 * issuer, `check --json` had no field, and neither status list, the client report
 * nor the action summary carried them. "Which TLS version does the customer's
 * site speak, and with which cipher?" is a line a bureau has to be able to
 * produce — it is the first thing a security questionnaire asks and the cheapest
 * thing to prove, and the answer was in the data the whole time.
 *
 * `null` per field rather than a whole object, because the two facts are read
 * independently: a handshake can complete and report a protocol while the cipher
 * is absent, and a surface must not print an empty half of the line. Neither
 * value is a judgement — no TLS version is flagged here, because Node will not
 * complete a handshake below TLS 1.2, so an old protocol is an error on this
 * surface rather than a value to grade. See the `expiresSoon` note above for the
 * other place where one threshold lives, and `readSslIssuer` for the sibling fact.
 *
 * Both values are chosen by the server, so a terminal surface must pass them
 * through `safeText()` — see src/display.js.
 */
export function readSslTls(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : null;
  return {
    protocol: readNegotiatedName(value?.protocol),
    cipher: readNegotiatedName(value?.cipher),
  };
}

/** How many certificate names a sentence may name before it counts the rest. */
const CERT_NAMES_IN_NOTE = 4;

/**
 * The host names a certificate carries, with the `subjectAltName` prefixes
 * removed, in the order the certificate lists them.
 *
 * Node hands every entry over as `"DNS:name"`, `"IP Address:1.2.3.4"` or
 * `"othername:…"`. Only the two that are host names are kept: an `email:` or
 * `URI:` entry is not a name the connection could be validated against, so
 * counting it would invent a certificate that covers the host.
 */
function readCertNames(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : null;
  const entries = value?.subjectAltName;
  // An array is what the checker measures. Anything else is a shape we have
  // never read, and guessing at it would be the one owner deciding what a
  // certificate says.
  if (!Array.isArray(entries)) return [];
  const names = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    const name = trimmed.startsWith('DNS:')
      ? trimmed.slice(4)
      : trimmed.startsWith('IP Address:')
        ? trimmed.slice(11)
        : '';
    const clean = name.trim();
    if (!clean) continue;
    if (names.some(seen => comparableHost(seen) === comparableHost(clean))) continue;
    names.push(clean);
  }
  return names;
}

/**
 * A host reduced to the shape a comparison can be sure of: lower case, no
 * trailing root dot, and in punycode when the certificate was written in
 * unicode. `new URL()` is the parser the URL validator already uses, so an
 * IDN name cannot be compared in one form and requested in another.
 */
function comparableHost(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim().toLowerCase();
  if (!name) return null;
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (!name) return null;
  if (/^[\x00-\x7f]*$/.test(name)) return name;
  try {
    return new URL(`https://${name}`).hostname || name;
  } catch {
    return name;
  }
}

/**
 * Whether one certificate name covers one host, the way a browser decides it.
 *
 * A wildcard covers exactly one label: `*.a.dk` covers `b.a.dk`, and neither
 * `a.dk` (nothing is left of the wildcard) nor `x.b.a.dk` (two labels are).
 * Getting this wrong is not a detail — measured against real certificates, a
 * literal comparison calls `www.npmjs.com` uncovered, because that
 * certificate names `*.npmjs.com`. That is a false alarm on one of the largest
 * sites on the internet, which is why this is a rule and not a `includes()`.
 */
function certNameCoversHost(certName, host) {
  if (certName === host) return true;
  if (!certName.startsWith('*.')) return false;
  const suffix = certName.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

/**
 * Does the certificate cover the host we asked about — and what does it name?
 *
 * `src/checkers/ssl.js` has read `subjectaltname` on every SSL check since P0-3
 * and **no surface could read it**. "Does the certificate cover the hostname we
 * monitor?" is the question a bureau gets when a client's site warns in one
 * browser and not another, and the answer was in the data the whole time. The
 * check is silent either way today, because the handshake runs with
 * `rejectUnauthorized: false`: a wrong certificate is reported as a healthy site.
 *
 * `coversHost` is a judgement, so it is `null` — not `false` — whenever there
 * is nothing to judge: no certificate was read, the URL does not name a host, or
 * the certificate carries no host names at all. A certificate with an empty
 * `subjectAltName` is old, and the verdict for one is a browser's, not ours.
 * `false` therefore means the certificate was read, it names hosts, and none of
 * them is this one.
 *
 * The host compared is the one the checker asked for — the certificate served
 * for the redirect target is somebody else's certificate and is measured by
 * checking that host. No exit code, no stored state and no event changes: this
 * is a fact for the surface that already reads the certificate, not a verdict
 * about the site.
 *
 * The names come from the certificate, so a terminal surface must pass the note
 * through `safeText()` — see src/display.js.
 *
 * @param {object} ssl — the checker's result, or nothing at all
 * @param {string} url — the URL the certificate was asked for
 */
export function readCertCoverage(ssl, url) {
  const names = readCertNames(ssl);
  let host = null;
  try {
    host = typeof url === 'string' ? comparableHost(new URL(url).hostname) : null;
  } catch {
    host = null;
  }
  const unknown = { coversHost: null, names, note: null };
  if (!host || names.length === 0) return unknown;

  // A wildcard can never cover an address; only the exact `IP Address:` entry can.
  const address = net.isIP(host) !== 0;
  const coversHost = names.some((name) => {
    const certName = comparableHost(name);
    if (!certName) return false;
    return certName === host || (!address && certNameCoversHost(certName, host));
  });
  if (coversHost) {
    return { coversHost: true, names, note: `Certificate covers ${host}` };
  }
  const shown = names.slice(0, CERT_NAMES_IN_NOTE);
  const rest = names.length - shown.length;
  const list = shown.join(', ');
  return {
    coversHost: false,
    names,
    note: `Certificate does not cover ${host} — it names: ${list}${rest > 0 ? `, and ${rest} more` : ''}`,
  };
}

/**
 * The identity of a certificate: the serial number the issuer assigned, and the
 * hash of the certificate itself.
 *
 * `checkSSL` has read both since P0-3 and no surface could read them, so the two
 * fields that answer "is this still *my customer's* certificate?" were measured
 * on every check and thrown away. Together with `readSslIssuer` (who issued it)
 * and `readCertCoverage` (does it cover the host), identity is the third leg of
 * the same question, and it is the leg a bureau asks about after a hijack: a
 * parked domain answers 200 with *someone else's* certificate.
 *
 * The hash is `fingerprint256`, not the legacy `fingerprint`. SHA-1 is
 * collision-broken and this is a security tool; the SHA-1 field is left exactly
 * as Node produced it so nothing that read it silently changes meaning.
 *
 * Both are normalised to lower-case hex without separators, because they are
 * compared against a stored value and the stored value was written by a person
 * or an older build: `89:9C:…` and `899c…` are the same certificate, and a
 * comparison that failed on punctuation would report a rotation that never
 * happened. `null` per field, never a made-up value — `readCertIdentity({})` on
 * a site with no certificate is `null`, which is a fact.
 *
 * @param {object} ssl — the checker's result, or nothing at all
 * @returns {{serial: string|null, fingerprint: string|null}|null}
 */
export function readCertIdentity(ssl) {
  const value = ssl && typeof ssl === 'object' ? ssl : null;
  if (!value) return null;
  const hex = input => (typeof input === 'string' ? input.replace(/[^0-9a-fA-F]/g, '').toLowerCase() : null) || null;
  const serial = hex(value.serialNumber);
  const fingerprint = hex(value.fingerprint256);
  if (serial === null && fingerprint === null) return null;
  return { serial, fingerprint };
}

/** The three things a comparison against a stored certificate can conclude. */
export const CERT_VERDICT = {
  /** A stored certificate was compared with, and this is a different one. */
  ROTATED: 'rotated',
  /** A stored certificate was compared with, and this is the same one. */
  SAME: 'same',
  /** There was no stored certificate, so nothing was concluded. */
  NO_BASELINE: 'no-baseline',
};

/**
 * What a certificate comparison concluded, and how old the certificate it was
 * compared with is. One owner, so `check`, the watch loop and every future
 * surface cannot answer the same question two ways.
 *
 * The age is the second half of the claim, for the same reason it is on
 * `readContentComparison`: "the same certificate" is true of two readings and
 * says nothing about the span between them. A domain that was hijacked and
 * handed back between two passes presents the same certificate at both ends.
 * So an unchanged verdict names the reading it was compared with, and a stored
 * certificate whose time cannot be placed says so instead of being rounded into
 * "today" — the same rule as the certificate countdown (P1-36), the page size
 * on the lists (P1-57) and the content comparison (P1-59).
 *
 * The baseline is the watch loop's certificate, never `check`'s own: `check`
 * stays read-only, so a one-off command never becomes a writer.
 *
 * @param {object} [input] — `{ fingerprint, seenAt, now }`
 * @param {string|null} [input.fingerprint] — the certificate just read
 * @param {unknown} [input.baselineFingerprint] — the state's `lastCertFingerprint`
 * @param {unknown} [input.seenAt] — when that stored certificate was read
 * @param {Date} [input.now]
 * @returns {{verdict: string, compared: boolean, rotated: boolean|null,
 *   ageDays: number|null, aheadMs: number, note: string}}
 */
export function readCertRotation({ fingerprint = null, baselineFingerprint = null, seenAt = null, now = new Date() } = {}) {
  const current = typeof fingerprint === 'string' && fingerprint !== '' ? fingerprint : null;
  const baseline = typeof baselineFingerprint === 'string' && baselineFingerprint !== ''
    ? baselineFingerprint.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    : null;
  if (current === null || baseline === null) {
    return {
      verdict: CERT_VERDICT.NO_BASELINE,
      compared: false,
      rotated: null,
      ageDays: null,
      aheadMs: 0,
      note: 'no earlier certificate to compare against',
    };
  }
  const reading = passAge(seenAt, now);
  const rotated = current !== baseline;
  const when = reading.state === PASS_AGE.AHEAD
    ? `a certificate seen ${clockAheadNote(reading.aheadMs)}`
    : reading.state === PASS_AGE.AGED
      ? `the certificate seen ${reading.ageDays === 0 ? 'today' : `${reading.ageDays} d ago`}`
      : 'a certificate of unknown age';
  return {
    verdict: rotated ? CERT_VERDICT.ROTATED : CERT_VERDICT.SAME,
    compared: true,
    rotated,
    ageDays: reading.state === PASS_AGE.AGED ? reading.ageDays : null,
    aheadMs: reading.aheadMs,
    note: rotated ? `certificate rotated since ${when}` : `same certificate as ${when}`,
  };
}

/**
 * A *stored* certificate rotation, as a later surface reads it: the client's
 * report, and any other document written for someone who was not there when the
 * pass ran.
 *
 * The comparison above is a decision made inside one pass; this is the fact that
 * outlasts it. Both halves are needed, and the state file carried neither: on a
 * rotation `runPass` overwrites `lastCertFingerprint` with the new identity, so a
 * day later the file could not tell a domain that had changed owner from one where
 * the certificate had never been replaced. Measured 2026-09-27 with the real CLI,
 * two state files written by real passes, the only difference between them the
 * certificate the site answered with:
 *
 *   uændret certifikat        ->  | kunde.dk | UP (200) | 100% | … | 88 d | …
 *   certifikatet byttet i dag ->  | kunde.dk | UP (200) | 100% | … | 89 d | …
 *
 * No line, no count, no JSON field. And the day count is not even a signal: a
 * replaced certificate usually has *more* days left than the one it replaced, so
 * the hijack reads as the healthier of the two.
 *
 * So the same shape as `readContentChangeState`, and the same rule: the rotation
 * is a fact about the past and it ages, `ageDays` is asked of `passAge` so a
 * hand-written stamp cannot be aged into "today" here and something else there,
 * and a stamp ahead of this machine's clock is named as a clock problem instead of
 * being printed as a fact about the certificate.
 *
 * `false` means "this site has a stored certificate and it has not been replaced" —
 * which is a claim about every pass since the baseline, so it needs a baseline to
 * exist. A site with no stored identity at all says `false` here too, because
 * "no rotation" is not a measurement of a certificate that was never read; the
 * surfaces that need the difference ask `readCertRotation`, which is where
 * "nothing to compare against" is one of three verdicts.
 *
 * @param {object} entry — one `state.urls[...]` entry
 * @param {{now?: Date, withSerial?: boolean}} [options]
 * @param {boolean} [withSerial] — put the certificate's serial number in the
 *   note. The field `serial` is always returned; only the *sentence* is the
 *   caller's choice, because only one surface has a use for an unshortened
 *   serial. The state file has carried it since P0-3 (`lastCertSerial`) and
 *   nothing read it: measured 2026-09-27, a hijack-then-reissue where the report
 *   named the rotation, the count and both authorities, and no document carried
 *   the number the customer's security review asks for.
 * @returns {{rotated: boolean, rotatedAt: string|null, ageDays: number|null,
 *   aheadMs: number, rotations: number, serial: string|null, note: string}}
 */
export function readCertRotationState(entry, { now = new Date(), withSerial = false } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  // A site whose certificate was never replaced has no rotation to report. The
  // stamp is written only where a pass saw a different certificate than the one it
  // had stored, so its absence is the ordinary case and not a missing reading.
  const rotated = typeof value.lastCertRotatedAt === 'string' && value.lastCertRotatedAt !== '';
  const reading = passAge(rotated ? value.lastCertRotatedAt : null, now);
  const ageDays = reading.state === PASS_AGE.AGED ? reading.ageDays : null;
  const rotations = certRotationCount(value.certRotationCount);
  const serial = certSerialNumber(value.lastCertSerial);
  return {
    rotated,
    rotatedAt: rotated ? value.lastCertRotatedAt : null,
    ageDays,
    aheadMs: reading.aheadMs,
    rotations,
    serial,
    note: certRotationStateNote({ rotated, ageDays, aheadMs: reading.aheadMs, rotations, serial: withSerial ? serial : null }),
  };
}

/**
 * How many times a certificate has been replaced, from a state file that may
 * have been hand-edited, restored from a backup or half-written by a crash.
 *
 * One integer, read the same way everywhere, for the same reason
 * `readPassTime` exists: the value is only a number when it is a number, and
 * anything else is the absence of a count rather than a count of something.
 * Zero is a real answer — a site that was added and never rotated — and it is
 * the answer for every state file written before this counter existed, so no
 * upgrade invents a rotation.
 *
 * @param {unknown} value — the raw `certRotationCount` from the state file
 * @returns {number} a non-negative integer
 */
export function certRotationCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * The serial number the issuer gave the certificate that answered last, from a
 * state file that may have been hand-edited, restored from a backup or
 * half-written by a crash.
 *
 * One string, canonicalised, for the same reason `certRotationCount` above is an
 * integer: the value is a serial number when it is one and the absence of one
 * otherwise. RFC 5280 caps a serial at 20 octets, so 40 hex characters is the
 * format's real maximum — a longer run is not a serial we failed to shorten, it
 * is a value nobody can look up, and printing it would put a number in a customer
 * document that answers to nothing.
 *
 * Only the separators a serial is *written* with are removed — whitespace, the
 * colons from `openssl x509 -serial`, a `0x` prefix — and what is left must be hex
 * and nothing else. Removing every non-hex character instead would turn the word
 * `not-a-serial` into the serial `aeae`: measured here, on the first version of
 * this function, and the reason it now rejects rather than filters. What survives
 * is lowercase hex alone, which is what makes the string safe to put in a document
 * a bureau forwards — after this, it cannot contain a newline, a pipe or a
 * markdown escape, so it needs no escaping of its own. The one-off `check`
 * prints the same canonical form, so the two never disagree about which
 * certificate they are naming.
 *
 * @param {unknown} value — the raw `lastCertSerial` from the state file
 * @returns {string|null}
 */
export function certSerialNumber(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^0x/i, '').replace(/[\s:]/g, '');
  return /^[0-9a-f]{1,40}$/i.test(hex) ? hex.toLowerCase() : null;
}

/**
 * What a surface says about a replaced certificate, in one sentence.
 *
 * A rotation is not a verdict — a certificate is reissued every 90 days by most
 * hosts, and a new one is still a valid certificate for the right name — so the
 * sentence states the fact and nothing more. It carries the age, because a report
 * is read once and often days after the pass that produced it, and "the
 * certificate was replaced" without a date reads as "this morning".
 *
 * The count rides along for one and only one case: a certificate that has been
 * replaced *more than once*. One replacement is the ordinary renewal every host
 * does every 90 days, and naming it would put a number in a client document that
 * means nothing. Many is not ordinary — a name that answers with a different
 * certificate on every pass is a CDN mid-rollout, a canary deploy, or a domain
 * rotating certificates to stay ahead of a blocklist, and those are findings a
 * bureau can bill for. Measured 2026-09-27, the report printed the same line for
 * a site that had renewed once and for a site that had rotated 47 times in 24 h.
 *
 * So the sentence is byte-for-byte what it always was for a single rotation and
 * for no rotation at all, and only a second one changes it.
 *
 * The serial number rides along on exactly one caller's request, `withSerial`
 * below, and never for another reason. It is a number a reader can act on — a
 * security questionnaire asks for the serial behind the issuer, and the report is
 * the document that gets asked — while the two terminal lists print a line the
 * reader glances at, where an unshortened 40-character number teaches nothing.
 * That difference is a decision about where the number is *used*, not about
 * whether it is true, so it lives in the call and not in this sentence.
 */
export function certRotationStateNote({ rotated = false, ageDays = null, aheadMs = 0, rotations = 0, serial = null } = {}) {
  if (rotated !== true) return '';
  // More than one, and never fewer: the ordinary renewal stays exactly as it was,
  // because a client who reads "1 replacement" learns nothing they did not have.
  const many = certRotationCount(rotations) > 1 ? ` · ${certRotationCount(rotations)} replacements since the site was added` : '';
  const number = certSerialNumber(serial);
  const named = number === null ? '' : ` · serial ${number}`;
  if (Number.isFinite(aheadMs) && aheadMs > 0) return `🔑 certificate replaced — ${clockAheadNote(aheadMs)}${many}${named}`;
  const when = ageDays === null ? 'at an unreadable time' : ageDays === 0 ? 'today' : `${ageDays} d ago`;
  return `🔑 certificate replaced ${when}${many}${named}`;
}

/**
 * What a surface says about a certificate that now answers from a *different
 * authority*, in one sentence.
 *
 * The word is *different*, never *unknown* or *rogue*: the same name renewed by
 * the same CA is the ordinary case, and a customer who moved hosts sees a new
 * issuer for entirely innocent reasons. Both names are in the sentence, because
 * "the issuer changed" without saying from what to what leaves the reader to go
 * and look it up in the one document that must not require it. The age rides
 * along for the same reason as on the rotation: a report is read once, days after
 * the pass that produced it.
 */
export function certIssuerChangeNote({ changed = false, ageDays = null, aheadMs = 0, previous = null, issuer = null } = {}) {
  if (changed !== true) return '';
  const from = typeof previous === 'string' && previous.trim() ? previous.trim() : 'an unnamed authority';
  const to = typeof issuer === 'string' && issuer.trim() ? issuer.trim() : 'an unnamed authority';
  const names = ` (${from} → ${to})`;
  if (Number.isFinite(aheadMs) && aheadMs > 0) return `🏢 certificate answers from a different issuer${names} — ${clockAheadNote(aheadMs)}`;
  const when = ageDays === null ? 'at an unreadable time' : ageDays === 0 ? 'today' : `${ageDays} d ago`;
  return `🏢 certificate answers from a different issuer ${when}${names}`;
}

/**
 * A *changed certificate issuer*, as a later surface reads it: the client's
 * report, and any other document written for someone who was not there when the
 * pass ran.
 *
 * `readSslIssuer` has answered "who issued this certificate?" since P1-53 — and
 * only `check` ever asked. Nothing stored it, so the document a bureau forwards
 * to a customer could not answer the first question a security questionnaire
 * asks, and could not see the one signal that separates a routine renewal from a
 * domain that changed hands: a *different authority*. Measured 2026-09-27, real
 * passes, real state file, real CLI — a site whose certificate was replaced by
 * one from another issuer:
 *
 *   | https://kunde.dk/ | UP (200) | 100% | … | 89 d | … |
 *   **1 site has its certificate replaced …** https://kunde.dk/ (🔑 certificate replaced today)
 *
 * It named the rotation and nothing else. The state file had no issuer at all,
 * so even a later `check` could not say from *which* authority the change came —
 * and a hijack reads exactly like a renewal, because the new certificate is
 * usually the healthier of the two.
 *
 * So the same shape as `readCertRotationState`, and the same rules: the fact
 * ages and its age is asked of `passAge`, so a hand-written stamp cannot be aged
 * into "today" here and something else there; a stamp ahead of this machine's
 * clock is named as a clock problem rather than printed as a fact about the
 * certificate; and `null` names are never invented — a certificate that reported
 * no issuer stays unnamed instead of being given a placeholder authority.
 *
 * The change is only a fact when there *was* an earlier issuer to change from.
 * The first reading establishes it, exactly as the first certificate reading
 * establishes a baseline, so `changed` is `false` for every site whose issuer has
 * never moved.
 *
 * Nor is it a fact when the two names are the same one. The pass only stamps a
 * change when the authority it just read differs from the one it had, so a real
 * state file cannot hold that — but a hand-written, merged or restored one can,
 * and then every surface named a change to nothing: `🏢 certificate answers from a
 * different issuer 2 d ago (Ganske Cloud A/S → Ganske Cloud A/S)`. Measured
 * 2026-09-27 while giving the same sentence to the alert channel, where the
 * channel told a customer the authority had changed to itself.
 *
 * @param {object} entry — one `state.urls[...]` entry
 * @param {{now?: Date}} [options]
 * @returns {{issuer: string|null, changed: boolean, changedAt: string|null,
 *   previous: string|null, ageDays: number|null, aheadMs: number, note: string}}
 */
export function readCertIssuerState(entry, { now = new Date() } = {}) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const name = field => (typeof field === 'string' && field.trim() ? field.trim() : null);
  const issuer = name(value.sslIssuer);
  const previous = name(value.certIssuerBefore);
  // Both halves are needed for the claim: a stamp with no earlier authority
  // cannot say *what* changed, and an earlier authority with no stamp says only
  // what the last pass saw. Neither alone is a change — and an authority that
  // changed to itself did not change.
  const changed = previous !== null && previous !== issuer && typeof value.certIssuerChangedAt === 'string' && value.certIssuerChangedAt !== '';
  const reading = passAge(changed ? value.certIssuerChangedAt : null, now);
  const ageDays = reading.state === PASS_AGE.AGED ? reading.ageDays : null;
  return {
    issuer,
    changed,
    changedAt: changed ? value.certIssuerChangedAt : null,
    previous,
    ageDays,
    aheadMs: reading.aheadMs,
    note: certIssuerChangeNote({ changed, ageDays, aheadMs: reading.aheadMs, previous, issuer }),
  };
}

/**
 * How long one site waits between two *sent* certificate-rotation alerts. One
 * hour — the same window as the content-change throttle, for the same reason.
 */
export const CERT_ALERT_MIN_GAP_MS = 60 * 60 * 1000;

/**
 * One certificate-rotation alert per site per hour — the throttle, and the
 * sentence that accounts for what it held back. `null` means "measured, but not
 * sent".
 *
 * `cert_rotated` is raised from a comparison with the *previous* pass, so a name
 * that answers with one certificate on one server and another on the next — two
 * regions behind one load balancer, a CDN mid-rollout, a canary deploy — is a
 * rotation on every pass, and every rotation used to become an alert: a POST to
 * the paid channel and a desktop notification, 30 s apart, for as long as the
 * loop ran. Measured 2026-09-27 with the real loop over such a site: five
 * `cert_rotated` alerts out of six passes, 2 880 a day per site — the same harm
 * as the content flood one class over, and the same mute that then hides the
 * real `is DOWN`.
 *
 * So the comparison still runs and the rotation is still written on every pass:
 * this decides what is *sent*, not what is true. That is the difference from a
 * throttled `down` (P1-49), and it is what keeps the cost of this rule at zero —
 * `lastCertRotatedAt` is the only surviving record of a rotation, and P1-61
 * exists because the pass overwrites the fingerprint, so a fact dropped here
 * would be gone from the client report as well as from the channel. The first
 * rotation after a quiet hour is sent as before, which is what a domain handed
 * to a new owner needs, and what a certificate reissued after 90 days gets for
 * free. What the throttle holds back is counted, never dropped, and the next
 * sent alert says how many rotations it stands for.
 *
 * A clock that jumped backwards does not suppress anything: this reads elapsed
 * time, and a negative span is the same clock problem the pass already names
 * (`clockAhead`), not evidence about a certificate.
 *
 * What the alert *says* is the caller's to hand over, never this one's to invent:
 * the rotation's wording from `readCertRotation`, and — when the authority
 * changed too — the issuer's own sentence from `readCertIssuerState`, as a
 * separate clause. Both are facts about the same pass, and neither is derivable
 * from the other: a routine 90-day renewal rotates the certificate from the same
 * authority, and a domain that changed hands rotates it from one that is not
 * the customer's, and only the second sentence tells those apart.
 */
export function readCertRotationAlert({ rotation, issuerNote = '', previousAlertedAt = null, counted = 0, now = new Date(), minGapMs = CERT_ALERT_MIN_GAP_MS } = {}) {
  const last = typeof previousAlertedAt === 'string' ? Date.parse(previousAlertedAt) : Number.NaN;
  const elapsed = now.getTime() - last;
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < minGapMs) return null;
  const held = Number.isInteger(counted) && counted > 0 ? counted : 0;
  // The sentence is the rotation's own, so this cannot announce a rotation with
  // another rotation's wording.
  const said = typeof rotation?.note === 'string' && rotation.note !== '' ? rotation.note : 'certificate replaced';
  // And the authority's sentence is the authority's own — `readCertIssuerState`'s,
  // asked of the same entry the report and the two lists ask, so the words in a
  // customer's channel are the words in the document the bureau forwards. It
  // rides here as its own clause rather than inside `said`, because it is a
  // different fact: a renewal from the same authority rotates the certificate and
  // says nothing about who vouches for the name, and a different authority is
  // exactly the case where every other number on the line still reads healthy.
  //
  // Measured 2026-09-27, real passes and a real receiver — a site whose
  // certificate was replaced by one from another authority:
  //
  //   cert_rotated  SSL certificate replaced — certificate rotated since the
  //                 certificate seen today
  //   state.json    sslIssuer=Rogue Cert BV  certIssuerBefore=Ganske Cloud A/S
  //
  // The report named both authorities and both lists did, and the one channel a
  // *paying* customer reads said "the certificate was replaced" and stopped — so
  // a domain that changed hands read as routine maintenance in the channel where
  // a bureau is watching. An empty string is not a claim and adds nothing; the
  // caller passes the owner's note or nothing at all. Trimmed too, so a caller
  // that hands over whitespace cannot leave a separator standing on its own.
  const issuer = typeof issuerNote === 'string' ? issuerNote.trim() : '';
  return {
    message: `SSL certificate replaced — ${said}${issuer ? ` · ${issuer}` : ''}${held > 0 ? ` (${held} earlier rotation${held === 1 ? '' : 's'} since the last alert, not sent)` : ''}`,
    held,
  };
}

/**
 * The fixed wording for a certificate whose reading is too old to renew against.
 *
 * One sentence for every surface, and it carries the two numbers a reader needs
 * to act: what the certificate had left when it was measured, and how long ago
 * that was. `—` in place of a number means the state file cannot say.
 */
export function sslLapsedNote({ days = null, ageDays = null } = {}) {
  const reading = days === null ? 'reading unknown' : `${days} d left`;
  const when = ageDays === null ? 'at an unreadable time' : `${ageDays} d ago`;
  return `may be expired — last reading: ${reading}, checked ${when}`;
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
 * A response time, but only if a response is what produced it — else `null`.
 *
 * `readStatusCode`'s sibling, and the one owner of "did the last pass actually
 * get an answer". The value alone cannot say: `lastResponseMs` is a plain
 * non-negative number in the state file, and a pass that reached *nothing* used
 * to write one anyway, so `5` was a legitimate reading of a site whose
 * connection was refused and `15002` a legitimate reading of a site that timed
 * out. `checkers/ping.js` no longer writes a number in that case (measured
 * 2026-09-26 — `Response: 15ms` next to `Status: N/A — DOWN`, and `5 ms` /
 * `15002 ms` in two rows of the client report), but the *older* number stays in
 * the state file, because `recordPass` writes a measurement and there was no new
 * measurement. Left alone, the report's Response cell would then quote a real
 * duration from an earlier pass in a row whose every other cell describes the
 * latest one — a customer reads the row, not the provenance.
 *
 * So the cell is empty unless the last pass got a status code. That is the same
 * rule the row already applies everywhere else: no status code means no response,
 * and a pass that got no response has no response time. `null` is what every
 * sibling cell prints for a number we do not have (`— SSL:`, `— Response:`,
 * `— (no completed pass)`), so the honest answer is already the house style.
 *
 * @param {object} entry — state.urls[url]
 * @returns {number|null} the measured milliseconds, or `null` when unmeasured
 */
export function readResponseMs(entry) {
  if (readStatusCode(entry?.lastStatus) === null) return null;
  const ms = entry?.lastResponseMs;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
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
 * How a terminal list row names the size of a page, and how old that size is.
 *
 * The size is a measurement of one reading, and a reading ages. `content.js`
 * skips a body over the 2 MiB limit and leaves `lastContentLength` alone, so a
 * pass can advance `lastChecked` while the byte count on the row is left over
 * from an earlier pass — measured 2026-09-27, where a page read once and then
 * served at 3 MiB kept publishing the size of the version we read. A row that
 * printed that number bare would be quoting a pass it cannot name, which is the
 * same defect P1-21 removed from `check --json` and P1-36 removed from the
 * report's SSL column. A list row carries no room for a second timestamp, so the
 * size carries its own age instead, asked of the one owner of a recorded time.
 *
 * A reading from today needs no words: that is the ordinary case and the row
 * should stay short. Everything else says how old the number is, and a time that
 * cannot be placed says so rather than being rounded into "today".
 *
 * @param {unknown} bytes — the state's `lastContentLength`
 * @param {unknown} readAt — the state's `lastContentReadAt`
 * @param {Date} now
 * @returns {string} the fragment, or `''` when the size was never measured
 */
function byteCountNote(bytes, readAt, now) {
  const size = `${byteCount(bytes)} bytes`;
  const reading = passAge(readAt, now);
  if (reading.state === PASS_AGE.AGED && reading.ageDays === 0) return size;
  if (reading.state === PASS_AGE.AGED) return `${size}, read ${reading.ageDays} d ago`;
  if (reading.state === PASS_AGE.AHEAD) return `${size}, read ${clockAheadNote(reading.aheadMs)}`;
  return `${size}, read at an unknown time`;
}

/** The three things a comparison against a stored reading can conclude. */
export const CONTENT_VERDICT = {
  /** A stored reading was compared with, and the page differs from it. */
  CHANGED: 'changed',
  /** A stored reading was compared with, and the page is identical to it. */
  UNCHANGED: 'unchanged',
  /** There was no reading to compare with, so nothing was concluded. */
  NO_BASELINE: 'no-baseline',
};

/**
 * What a content comparison concluded, and how old the thing it was compared with
 * is. One owner, so `check` and every future surface cannot answer the same
 * question two ways.
 *
 * `check` never compared content until 2026-09-27. It called
 * `checkContentChange(url, undefined)`, so `previousHash` was never set,
 * `content.js` answered `changed: null` on every run, and the two branches that
 * print a verdict — `🔄` and `⏸️` — were unreachable. Measured with the real CLI
 * against a local page whose stored `lastHash` was a perfect match, and then
 * against one that was deliberately wrong:
 *
 *   matchende lastHash   -> — Content: 89 bytes
 *   afvigende lastHash   -> — Content: 89 bytes
 *
 * Two different states, one sentence, and a bare `—` that already meant
 * something else one line up (`— SSL: N/A` is "no certificate was read"). The
 * matrix row `ssl-content` promises "content-change detection" in the **free**
 * tier, and `check` is the free tier's front door.
 *
 * The age is not decoration, it is the second half of the claim. "Unchanged" is
 * true of two readings and says nothing about the span between them: a page
 * rewritten and rewritten back between two passes hashes identically at both
 * ends. So an unchanged verdict always names the reading it was compared with,
 * and a baseline whose time cannot be placed says so instead of being rounded
 * into "today" — the same rule as the certificate countdown (P1-36) and the page
 * size on the two lists (P1-57).
 *
 * A baseline is the watch loop's reading, never `check`'s own. `check` stays
 * read-only, exactly as measured before this change: it did not write
 * `state.json`, and a one-off command that silently became a writer is the
 * change P1-43 spent an iteration undoing for `unwatch`.
 *
 * @param {object} [input] — `{ changed, readAt }`
 * @param {boolean|null} [input.changed] — the checker's own `content.changed`
 * @param {unknown} [input.readAt] — the state's `lastContentReadAt` for the hash
 *   that was compared with, which `runPass` stamps in the same breath as the hash
 * @param {Date} [input.now]
 * @returns {{verdict: string, compared: boolean, ageDays: number|null,
 *   aheadMs: number, note: string}}
 */
export function readContentComparison({ changed = null, readAt = null, now = new Date() } = {}) {
  // `null` is the checker's own word for "there was nothing to compare with", so
  // it is taken at face value rather than read as a falsy `false`.
  if (changed !== true && changed !== false) {
    return {
      verdict: CONTENT_VERDICT.NO_BASELINE,
      compared: false,
      ageDays: null,
      aheadMs: 0,
      note: 'no reading to compare against',
    };
  }
  const reading = passAge(readAt, now);
  const verdict = changed === true ? CONTENT_VERDICT.CHANGED : CONTENT_VERDICT.UNCHANGED;
  // A baseline dated in the future is a clock problem, not a fact about the page:
  // it is named as one, and the age stays out of the sentence.
  const when = reading.state === PASS_AGE.AHEAD
    ? `a reading ${clockAheadNote(reading.aheadMs)}`
    : reading.state === PASS_AGE.AGED
      ? `the reading ${reading.ageDays === 0 ? 'today' : `${reading.ageDays} d ago`}`
      : 'a reading of unknown age';
  return {
    verdict,
    compared: true,
    ageDays: reading.state === PASS_AGE.AGED ? reading.ageDays : null,
    aheadMs: reading.aheadMs,
    note: changed === true ? `changed since ${when}` : `unchanged since ${when}`,
  };
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
 * How long an undelivered alert has been waiting to be delivered.
 *
 * `checkAgeMs` above owns the arithmetic and this owns what it means here, and
 * both live in this file on purpose: `watch.js` is not allowed to decide an age
 * for itself (two locks, for the pass ages), and an alert's waiting time is an
 * age like any other — a queue entry stamped 40 minutes into the future is a
 * clock problem, not an alert that has waited a negative time, so it counts as
 * just queued. An unreadable stamp is treated as "just queued" too, rather than
 * as an alert that may be dropped: the queue only gives up on a *known* age.
 */
export function queuedAgeMs(queuedAt, now = new Date()) {
  const age = checkAgeMs(queuedAt, now);
  return age === null ? 0 : Math.max(0, age);
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
  // The pass time goes in with the day count: a stored `sslValidDays` is a
  // countdown that was true when the pass read it, and these two lists are
  // read-only — so they are exactly where an expired certificate can sit behind
  // a "renew soon" that stopped being true a day ago.
  const ssl = readSslState({
    days: value.sslValidDays,
    expired: value.sslExpired,
    expiredDays: value.sslExpiredDays,
    measuredAt: value.lastChecked,
    now,
  });
  const stale = isCheckStale(value.lastChecked, now);
  const pass = passAge(value.lastChecked, now);
  const ageDays = pass.ageDays;
  const neverChecked = !value.lastChecked;
  // The same reading the client report prints, asked of the same owner, so these
  // two lists cannot say something about a page the report has already called
  // silent — or the other way round. Measured 2026-09-27: a page rewritten to
  // `<title>Free iPhone!!</title>` produced `🔄 … content changed` in the pass
  // and `🔄 content changed … — page title: …` in the report, while both lists
  // below printed `✅ up (200)` about the same file, and these two are the free
  // surfaces a user actually runs.
  const content = readContentChangeState(value, { now });
  // …and the same reading for the certificate, from the owner the client report
  // asks (P1-61). Measured 2026-09-27: a site whose certificate had been
  // replaced two days earlier printed `✅ up (200, SSL 89d)` on both lists below
  // while the report named it in its own line — and these two are the free
  // surfaces a user actually runs, so the replacement existed only in the paid
  // document. The day count is not a signal either way (a reissued certificate
  // has *more* days left than the one it replaced), so the row that says `SSL
  // 89d` is the row that has to name it. The sentence carries its own `🔑`, like
  // the page's `🔄`, so a list places it as it is instead of stacking a second
  // marker on top, and it is empty when nothing was replaced — the ordinary
  // case, because a pass writes the stamp only when it saw a different one.
  const cert = readCertRotationState(value, { now });
  // …and *who* vouched for it. The pass measured the issuer since P1-53, stored it
  // since P1-64, and the client report has named a changed authority since then —
  // but measured 2026-09-27, the two free lists still printed `✅ … (200) — SSL
  // 89d 🔑 certificate replaced today` about a site whose certificate now answers
  // from `Rogue Cert BV` instead of `Ganske Cloud A/S`, with neither name on the
  // row. A rotation is the ordinary case and says only that *something* changed;
  // the authority is the one reading that separates it from a name that is
  // answered for by somebody else, so the row that carries the rotation is the
  // row that has to carry this. Asked of the one owner, like the two above.
  const certIssuer = readCertIssuerState(value, { now });
  // A key that is not an address has no verdict to report. Its stored `wasUp`
  // is whatever a hand-edited file, a botched restore or an old script left
  // behind, and a monitoring pass skips the key entirely (P1-40) — so printing
  // `✅ up` for one told a user their site was healthy on the strength of a
  // value nothing can measure. Asked of the one owner, so the row says the same
  // thing the named line below the list says.
  const uncheckable = url !== '' && !isHttpUrl(url);

  return {
    verdict: uncheckable ? 'unknown' : verdictFor(value.wasUp),
    // "No pass has ever run" and "the last pass ran but its verdict cannot be
    // read" are different facts that used to print identically, in both
    // terminal lists and in the report. The two surfaces now ask for the same
    // sentence, so neither can discover the difference on its own.
    neverChecked,
    uncheckable,
    unknownNote: uncheckable ? unusableUrlNote([url], { brief: true }) : unknownNote({ lastChecked: value.lastChecked, ageDays, clockAhead: clockAheadNote(pass.aheadMs) }),
    statusCode: readStatusCode(value.lastStatus),
    sslDays: ssl.days,
    sslExpired: ssl.expired,
    // A stored day count whose deadline has passed since the pass that read it.
    // The verdict is untouched — an old reading is not proof the certificate is
    // gone — but it is not "renew soon" either, and these lists are where a user
    // decides whether to act today.
    sslMayHaveExpired: ssl.mayHaveExpired,
    sslReadingAgeDays: ssl.readingAgeDays,
    // Without a leading separator: the two surfaces punctuate differently, but
    // neither can change what is being said about the certificate.
    sslNote: ssl.expired
      ? `SSL 🔴 ${expiredNote(ssl.expiredDays)}`
      : ssl.mayHaveExpired
        ? `SSL 🔴 ${sslLapsedNote({ days: ssl.days, ageDays: ssl.readingAgeDays })}`
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
    // The page itself, in the two shapes a row needs. The sentence carries its
    // own `🔄`, so a list places it as it is instead of stacking a second marker
    // on top, and the size is a separate fact with its own age — see
    // `byteCountNote` for why a bare number would be a quote from a pass the row
    // cannot name. A changed page gets the sentence alone, for the same reason
    // the report's Content cell prints `🔄 changed` or `stable · N bytes` and
    // never both: a size read before a change is not the size of what changed.
    // A page nobody has read gets nothing — `—` is for cells, and a row is not
    // a table.
    content,
    contentNote: content.note,
    contentSize: content.changed || content.bytes === null ? '' : byteCountNote(content.bytes, content.bytesReadAt, now),
    // The certificate, in the one shape a row needs. Same rule as the page above:
    // the fact and its age travel together, so "replaced" never reads as
    // "this morning" on a list that is opened days after the pass. Fixed words
    // plus a checked day count, so a row can place it as it is.
    cert,
    certNote: cert.note,
    // The authority, in the same two shapes as the rotation above: the reading a
    // caller can branch on, and the owner's own sentence. It is a second fact
    // rather than a second wording of the first — a renewal from the same
    // authority rotates the certificate and changes nothing here, and an
    // authority that changes hands is exactly the case where every number on the
    // row still looks healthy — so a row that has both says both, and a caller
    // cannot drop one by rebuilding the other.
    certIssuer,
    certIssuerNote: certIssuer.note,
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

/**
 * The credentials embedded in a URL, in words, or `''` when there are none.
 *
 * Measured 2026-09-26, real CLI and a real client report: `http://demo:pass@…`
 * is a perfectly valid address, so it passed every check, and Node's `fetch`
 * then refused to build a request for it (`Request cannot be constructed from a
 * URL that includes credentials`). The site answered 200 the whole time and
 * DeskUptime called it DOWN — forever, every pass. The same URL was written to
 * `state.json` and printed in the report a bureau sends to its customer, under
 * a line promising that no secret is in the document. A password typed on a
 * command line is the one secret that reaches all three by accident.
 */
export function urlCredentials(value) {
  try {
    const { username, password } = new URL(String(value));
    const parts = [username ? 'a username' : '', password ? 'a password' : ''].filter(Boolean);
    return parts.join(' and ');
  } catch {
    return '';
  }
}

export function hasUrlCredentials(value) {
  return urlCredentials(value) !== '';
}

/** The same URL without its credentials, for every place that shows a URL. */
export function withoutCredentials(value) {
  const text = String(value);
  if (!hasUrlCredentials(text)) return text;
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return text.replace(/\/\/[^/@]*@/, '//');
  }
}

/**
 * The credentials taken out of every URL inside a *sentence*, for every place
 * that shows text we did not write.
 *
 * `withoutCredentials` is the owner for one address; this is its sibling for the
 * strings that quote an address — and the measured leak (P1-71) was in exactly
 * those, never in the address a user typed. A site that answers
 * `Location: http://demo:pass@…` put the password into `undici`'s own error
 * sentence, `Request cannot be constructed from a URL that includes credentials:
 * http://demo:pass@…`, and that sentence is what `describeFetchError` publishes
 * as `error` on stdout, in `--json`, in the alert that goes to the customer's
 * channel and in the state file next to the license key.
 *
 * Only an absolute `http(s)` URL with a userinfo is touched, so a relative
 * `Location: /@handle/` and a `mailto:` address keep their own text.
 */
export function scrubUrlCredentials(value) {
  return String(value).replace(/(https?:\/\/)[^/\s@]+@/gi, '$1');
}

/**
 * Can a pass send a request to this address? One decision, so a key that the
 * pass skips can never be fatal at a command line (the P1-40 rule) and a key a
 * command line accepts can never be a site we report as down.
 */
export function isCheckableUrl(value) {
  return isHttpUrl(value) && !hasUrlCredentials(value);
}

/**
 * The one form two addresses are compared in, so "is this the same site?" has a
 * single answer everywhere.
 *
 * Measured 2026-09-26, real CLI, real state file and a real client report: the
 * free tier counts three saved keys, and `https://kunde.dk` and `https://kunde.dk/`
 * were two of them. The second one is the same site — `new URL()` says so, and a
 * browser's address bar only ever shows the second form, so the duplicate is the
 * form a user copies — and it took a slot, was requested again on every pass, and
 * got its own row with its own numbers in the report a bureau sends to a
 * customer, under a summary that read `2 site(s) · 2 up`. One customer site, two
 * rows and one free slot gone.
 *
 * `new URL()` is the parser the validator already uses, so this cannot disagree
 * with `isHttpUrl()`. It lowercases scheme and host, drops a default port, and
 * gives an empty path its `/` — a redirect's worth of normalisation, none of
 * which changes which server answers. A string that is not an address compares
 * as itself, so the P1-40 class (`kunde.dk`) is untouched: two unusable keys are
 * still two keys, because neither can be measured anyway.
 */
export function urlIdentity(value) {
  const text = String(value).trim();
  try {
    return new URL(text).toString();
  } catch {
    return text;
  }
}

/** Are these two addresses the same site, in any of the forms it can be typed? */
export function sameUrl(a, b) {
  return a === b || urlIdentity(a) === urlIdentity(b);
}

/**
 * The saved key this address is already stored under, or `null`.
 *
 * An exact hit wins over a normalised one, so `unwatch` of a key that exists
 * verbatim removes that key — which is what keeps a state file that holds both
 * forms repairable by hand instead of guessing which half to drop.
 */
export function findUrlKey(urls, url) {
  if (Object.hasOwn(urls, url)) return url;
  const identity = urlIdentity(url);
  return Object.keys(urls).find((key) => urlIdentity(key) === identity) ?? null;
}

/** The one sentence for an address we refuse, so it never prints a password. */
export function invalidUrlMessage(url) {
  if (hasUrlCredentials(url)) {
    return `URL with ${urlCredentials(url)}: ${withoutCredentials(url)} — no pass can send a request with credentials in the URL, and a password there is stored in ~/.deskuptime/state.json and printed in the client report. Monitor the site without credentials.`;
  }
  return `Invalid URL: ${url}`;
}

export function invalidHttpUrls(urls) {
  return urls.filter(url => !isCheckableUrl(url));
}

export function assertValidHttpUrls(urls) {
  const invalidUrls = invalidHttpUrls(urls);
  if (invalidUrls.length > 0) {
    throw new TypeError(invalidUrls.map(invalidUrlMessage).join(' '));
  }
}

/**
 * Split a list of addresses into the ones we can send a request to and the ones
 * we cannot — one decision, asked everywhere it is needed.
 *
 * Measured 2026-09-26, real CLI and a real `state.json` with two working sites
 * and one key `kunde.dk`: `runPass()` called `assertValidHttpUrls()` on *every*
 * key before the first request, so `new URL('kunde.dk')` threw
 * `TypeError: Invalid URL: kunde.dk` — exit 1, empty stdout, and **zero** of the
 * other sites checked. One half-written key (a hand edit, a botched restore, a
 * `urls` map that a script rewrote) therefore ended the monitoring of every
 * other site, and it did so on `deskuptime watch --once` — the documented cron
 * path — where the only trace is a stack trace in the cron mail. A site we
 * cannot even address is not a site that is down: the customer paid for alerts
 * about the other 24, and a løgn about their own site is worse than saying
 * nothing.
 *
 * So the pass splits instead of throwing. `assertValidHttpUrls()` stays where
 * the *caller* is at fault and can be told: the `check` command, and the
 * arguments typed on a `watch`/`unwatch` line.
 */
export function partitionUsableUrls(urls) {
  const usable = [];
  const unusable = [];
  for (const url of urls) {
    (isCheckableUrl(url) ? usable : unusable).push(url);
  }
  return { usable, unusable };
}

/** Why a saved key can never be checked, in words, without its credentials. */
function unusableUrlReason(url) {
  return hasUrlCredentials(url)
    ? `has ${urlCredentials(url)} in it, which is never sent and never stored`
    : 'is not a full address';
}

/**
 * The one sentence for "this saved key is not an address we can check", so the
 * pass, `watch --status`, `status` and the client report cannot each describe
 * the same broken key differently — the rule the stale block and the window
 * line already follow. It names the keys (flattened, because they come from a
 * file we did not write), says what did *not* happen — nothing about the
 * customer's own site is claimed — and gives the command that removes it.
 */
export function unusableUrlNote(unusable, { checked = null, brief = false } = {}) {
  const keys = unusable.map(url => safeText(withoutCredentials(String(url)), { max: 0 })).join(', ');
  // The short form is the same fact as the long one, for a place that already
  // names the key itself: a row in a status list, a cell in a client report.
  // `kunde.dk` is not a full address; `http://demo:pass@…` very much is, so the
  // sentence names the real reason instead of calling both the same thing.
  if (brief) return unusable.some(hasUrlCredentials)
    ? 'has a username or password in it, so no pass can check it — and the password is neither sent nor stored'
    : 'not a full address, so no pass can check it';
  const skipped = unusable.length === 1 ? '1 saved URL' : `${unusable.length} saved URLs`;
  const others = checked === null
    ? ''
    : checked === 0
      ? ' No monitored site could be checked on this pass.'
      : ` The other ${checked} monitored site${checked === 1 ? '' : 's'} ${checked === 1 ? 'was' : 'were'} checked as usual.`;
  return `Cannot be checked — not a site that is down: ${skipped} ${unusable.map(unusableUrlReason).join(', ')} (${keys}).${others} Fix the key, or drop it: deskuptime unwatch ${unusable.map(url => `'${safeText(withoutCredentials(String(url)), { max: 0 })}'`).join(' ')}`;
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
    return { errorType: 'dns_error', error: scrubUrlCredentials(cause.message || 'Host could not be resolved') };
  }

  // The sentence comes from `fetch`, not from us, and it quotes the URL that
  // failed — so a site that redirects to a URL with a password in it hands us a
  // sentence with that password in it (P1-71). This is the one place an error
  // becomes a claim, on six surfaces, so the redaction belongs here and not in
  // each of them.
  return {
    errorType: 'network_error',
    error: scrubUrlCredentials(cause?.message || error?.message || 'Network request failed'),
  };
}

/**
 * Is the certificate still worth reading, after the request leg failed?
 *
 * The request leg and the certificate leg are two connections, and they fail for
 * different reasons. A request that never got an answer is usually not a
 * certificate problem at all: a refused connection and a name that does not
 * resolve never reach a handshake, and a timeout has no certificate to read.
 * Asking anyway costs a doomed connection — up to `SSL_TIMEOUT_MS` on the very
 * sites a watch loop checks most often — and teaches nobody anything.
 *
 * `network_error` is the other half. It is where every certificate failure
 * lands, because `describeFetchError` has no vocabulary for certificates:
 * measured 2026-09-27 against a site serving a certificate that expired 40 days
 * earlier and one serving a certificate for another host, `fetch` refused both
 * handshakes and `describeFetchError` called both `network_error`
 * (`certificate has expired`, `Hostname/IP does not match certificate's
 * altnames: IP: 127.0.0.1 is not in the cert's list`). The certificate is
 * sitting right there on the wire, and the SSL leg — which accepts any
 * certificate on purpose — is the only leg that can read it.
 *
 * So a `network_error` on an `https` URL costs one extra connection and buys
 * the whole certificate reading: days left, issuer, TLS version and whether the
 * certificate covers the host at all. The verdict cannot move — `healthy` is
 * the request leg's answer — so this can add a fact, never a verdict. A
 * non-TLS `network_error` (a reset socket, an abrupt close) simply reads no
 * certificate and is reported as before.
 *
 * @param {object} [failure] — `{ reachable, errorType }` from the request leg
 * @returns {boolean}
 */
export function canReadCertificate(failure) {
  const { reachable = false, errorType = null } = failure && typeof failure === 'object' ? failure : {};
  if (reachable) return true;
  return errorType === 'network_error';
}
