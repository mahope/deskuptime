/**
 * report.js — a client-ready uptime report, generated locally from the state
 * the watch loop already keeps.
 *
 * Why this is a product feature and not a script: a bureau monitoring a
 * customer's site needs something they can send to the customer, and the data
 * is already there. The report is the deliverable — no account, no hosting, no
 * upload, and nothing that identifies the machine.
 *
 * Privacy rules, enforced by test/report.test.js:
 *   - only `state.urls` and the counters in `history` are read. The license
 *     record (key, device id) is never passed in, so it cannot leak into a
 *     report that leaves the machine;
 *   - no page content, no response headers, no content hash, no IP addresses;
 *   - nothing is written and no request is made — the report is a read of the
 *     last completed pass, so it works offline and cannot be a health check in
 *     disguise. Because nothing is re-checked, the age of that pass is part of
 *     the claim: a site with no pass within `STALE_AFTER_DAYS` is marked stale
 *     and is not counted as up. Run `deskuptime watch <url> --once` for a fresh
 *     pass.
 *
 * The counters this renders are two integers per URL (see `recordPass`) plus
 * two integers per URL per day (`src/history.js`), so neither file can grow
 * with the length of the monitoring history.
 */

import { PRODUCT } from './features.js';
import { DEFAULT_WINDOW_DAYS, windowCoverage, windowSummary } from './history.js';
import { markdownCell as cell } from './display.js';
import { PASS_AGE, SSL_WARN_DAYS, STALE_AFTER_DAYS, clockAheadNote, contentBytesNote, expiredNote, httpDownKind, httpDownNote, isCheckStale, isCheckableUrl, passAge, readCertIssuerState, readCertRotationState, readContentChangeState, readPassTime, readRedirectTarget, readResponseMs, readSslState, readStatusCode, sslLapsedNote, staleAgeNote, unknownNote, unusableUrlKind, unusableUrlNote, verdictFor, withoutCredentials } from './status.js';

export const DEFAULT_REPORT_TITLE = 'Website uptime report';
const MAX_TITLE_LENGTH = 120;

/** A hand-edited or half-written state file must not be able to produce NaN. */
export function intOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * A measured quantity, when it is one — otherwise `null`, meaning unknown.
 *
 * The same rule as `intOrZero` and `readSslState`, for the numbers that describe
 * a pass rather than count it. `Number.isFinite` alone let a negative through,
 * and a state file can hold one (hand-edited, restored, written by another
 * tool). Measured, in the report an agency forwards:
 *
 *   `"contentBytes": -999`                               ← --json
 *
 * `lastResponseMs: -5` is not a site that answered in five *negative*
 * milliseconds either, so the Response column reads its number through
 * `readResponseMs` — which also refuses a positive value the last pass never
 * measured. A negative byte count is the same lie about a document size, and it
 * is the number an agency would quote.
 *
 * `null` is kept rather than coerced to `0`: the report distinguishes "no
 * measurement" from "measured zero", and a report that claims a 0-byte
 * document is as false as one that claims a negative one.
 */
export function nonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The counter pair, read as one consistent set.
 *
 * `checksUp > checks` is not a site that is more than up — it is a state file
 * that was hand-edited, restored from a backup, or written by another tool.
 * Unclamped it renders "250 % uptime" and "−2 failed" in the one document a
 * bureau forwards to a customer, so the ceiling is applied here: the single
 * place the writer, the report and the percentage all read these numbers.
 * `src/history.js` clamps its daily buckets for the same reason, and a state
 * file that is out of step is repaired by the next pass (see `recordPass`)
 * rather than staying wrong in every later report.
 */
export function counters(entry) {
  const checks = intOrZero(entry?.checks);
  const checksUp = Math.min(intOrZero(entry?.checksUp), checks);
  return { checks, checksUp, failures: checks - checksUp };
}

/**
 * Fold one completed pass into a URL entry: how many checks ran, how many of
 * them answered UP, and the last response time. Uptime is deliberately
 * defined here and nowhere else, so the writer and the reader cannot disagree.
 *
 * The previous counters are read through `counters()`, which is also what
 * repairs a state file whose `checksUp` is above its `checks`: the write below
 * then carries the repaired pair forward instead of preserving the error.
 *
 * @param {object} entry — state.urls[url], mutated in place
 * @param {object} result — a result from engine.checkUrl()
 * @returns {{ checks: number, failures: number }}
 */
export function recordPass(entry, result) {
  const previous = counters(entry);
  const checks = previous.checks + 1;
  const checksUp = previous.checksUp + (result?.healthy === true ? 1 : 0);
  entry.checks = checks;
  entry.checksUp = checksUp;
  if (Number.isFinite(result?.responseTimeMs)) entry.lastResponseMs = result.responseTimeMs;
  return { checks, failures: checks - checksUp };
}

/** Share of completed passes that answered UP, or null when none has run yet. */
export function uptimePercent(entry) {
  const { checks, checksUp } = counters(entry);
  if (checks === 0) return null;
  return Number(((checksUp / checks) * 100).toFixed(2));
}

/**
 * Status words for a verdict the state file cannot read.
 *
 * The wording lives in `unknownNote` (src/status.js) because three surfaces now
 * print one: the Status column here, the `status` URL list and `watch --status`.
 * It used to live only here, which is why the two terminal lists said nothing at
 * all about it — see that function for the measurement.
 *
 * "not checked yet" is a claim about history, and this used to make it for every
 * `unknown` site. Measured on a state file that was hand-edited or restored from
 * a backup, one row said all three of these at once:
 *
 *   | https://kunde.dk | not checked yet | 75% (4 checks, 1 failed) | … | 2026-09-25 23:00 UTC |
 *
 * A customer reads that as "this site was never monitored" while the same row
 * carries four completed passes and a timestamp from an hour ago.
 */

const STATUS_RANK = { down: 0, unknown: 1, up: 2 };

function shortTime(iso) {
  if (typeof iso !== 'string' || !iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * A title is user input that ends up in a file someone forwards to a customer,
 * so it is flattened to a single short line instead of being trusted.
 */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return DEFAULT_REPORT_TITLE;
  const flat = title.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_REPORT_TITLE;
  return flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
}

/**
 * Build the report from state.urls and the daily history counters only.
 * `state.license` is not read, not copied and not reachable from the result.
 *
 * `windowDays` is the reporting window (default 30). A site with no recorded
 * day inside it gets `window: null`, which renders as — and never as 100 %.
 */
export function buildReport(state, { title, now = new Date(), history, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  // A key in the saved list that is not an address still gets a row — dropping
  // it would move `summary.sites` and every other number — but it can never be
  // measured, so the row says "status unknown" with the reason and the key is
  // counted apart from the sites (P1-40).
  const sites = Object.entries(state?.urls ?? {})
    .filter(([url, entry]) => typeof url === 'string' && url && entry && typeof entry === 'object')
    .map(([url, entry]) => {
      const { checks, failures } = counters(entry);
      // One reading of the raw key, for the three fields that answer "can a
      // pass send a request to this at all" — asked once, on the key as it is
      // stored, because the document's own `url` is the redacted form and the
      // shape cannot be seen through it (P1-83).
      const checkable = isCheckableUrl(url);
      // One reading of the certificate, from the one owner — the same call the
      // terminal surfaces make. The report used to carry its own copy of the
      // day-count rule, and it had no way to say a certificate had *lapsed*:
      // `sslValidDays` is clamped to 0, so an expired certificate and one
      // expiring tonight both read "renew soon" in the document a customer reads.
      const ssl = readSslState({
        days: entry.sslValidDays,
        expired: entry.sslExpired,
        expiredDays: entry.sslExpiredDays,
        // When that day count was measured. Without it the column printed a
        // countdown as if it were running now: a pass 36 h old that read "1 d
        // left" produced `⚠️ 1 d — renew soon` and a named renewal line in the
        // document a client reads, for a certificate that had almost certainly
        // lapsed in the meantime.
        measuredAt: entry.lastChecked,
        now,
      });
      const sslDaysRemaining = ssl.days;
      // …and whether the certificate is still the one the customer had. The pass
      // that saw a different certificate raised `cert_rotated` and stamped the
      // time, and then overwrote the stored identity with the new one — so before
      // this, nothing a later reader could ask could tell a domain that had
      // changed owner from one whose certificate was simply renewed. Measured
      // 2026-09-27 with the real CLI, two state files written by real passes, and
      // a client report that was identical in every part that matters: `UP (200)`,
      // `100%` and a day count that is *larger* after a hijack than before it. A
      // replaced certificate is not a verdict — most hosts reissue every 90 days —
      // so it is a fact with an age, named under the table like the page change.
      const cert = readCertRotationState(entry, { now, withSerial: true });
      // …and who issued the certificate it counts down from. A rotation tells
      // the recipient that something changed; it does not say whether the new
      // certificate comes from the same authority as the one the customer had,
      // and that is the difference between a renewal and a name that answers for
      // someone else now. `readSslIssuer` measured this since P1-53 and only
      // `check` asked, so the state file carried no issuer at all — measured
      // 2026-09-27, the report over a hijacked-then-renewed site named the
      // rotation and nothing about where the new certificate came from. Asked of
      // the one owner, like every other reading in this document.
      const certIssuer = readCertIssuerState(entry, { now });
      // The page itself, read by the one owner, the same way the certificate is.
      // The state file has kept the hash, the size and the title since P0-3, and
      // nothing in this document could read any of them: a page replaced with a
      // defacement or a phishing form measured `UP (200) | 100%` here, while the
      // terminal and the customer's webhook both said the content had changed.
      const content = readContentChangeState(entry, { now });
      // The report is a read of the last completed pass and re-checks nothing, so
      // "how old is that pass" is part of the claim. A site whose newest pass is
      // older than the window keeps its observed status — the pass really did
      // answer 200 — but is marked stale so it is never counted as currently up.
      const stale = isCheckStale(entry.lastChecked, now);
      // Which of the four recorded-time states this site is in, asked of the one
      // owner. A pass dated ahead of this machine's clock used to reach this
      // document as an ordinary current pass: `ageDays: 0` in `--json`, counted
      // in `up`, and `2026-10-15` in the Last check column of a report generated
      // on 2026-09-26. The verdict is not touched — a wrong clock is not an
      // outage, and P1-6 locked that — but the age is no longer invented and the
      // skew is named, so the recipient is not told a check happened that this
      // machine's clock says has not happened yet.
      const pass = passAge(entry.lastChecked, now);
      const clockAhead = clockAheadNote(pass.aheadMs);
      // Where the last pass's answer came from, asked of the one owner. The pass
      // measured it, the state file now keeps it, and the document an agency
      // forwards used to read `UP (200)` for a domain that was answering from a
      // registrar's parking page — a customer's dead site, priced at 100 %.
      //
      // Only the *host* travels into the report, never the full `finalUrl`: a
      // redirect path can carry a token, and this document is written to be sent
      // to someone outside the agency. The host is the actionable part — it says
      // whose server answered.
      const redirect = readRedirectTarget({ url, finalUrl: typeof entry.lastFinalUrl === 'string' ? entry.lastFinalUrl : null });
      // The status the last pass read, once, so the cell, the line under the
      // table and `--json` cannot each read a different one out of the file.
      const statusCode = readStatusCode(entry.lastStatus);
      const window = windowSummary(history, url, { days: windowDays, now, uptimePercent, lastChecked: entry.lastChecked });
      const monitoringSince = readPassTime(entry.addedAt);
      const coverage = windowCoverage({ window, history, monitoringSince, days: windowDays, now });
      return {
        // The key as the *document* may show it. A URL that carries a username
        // or a password is one nobody can send a request to (P1-40's class), and
        // a hand-placed or restored key of that kind used to reach every cell
        // below with the password in clear text — in a file a bureau forwards to
        // its customer, under a line promising that no secret is in it. The
        // history file is still read with the real key above: the redacted form
        // is what a reader sees, not what we look up.
        url: withoutCredentials(url),
        // A key that is not an address can never be measured, and its stored
        // `wasUp` is whatever the file says — so a client report said `UP` for a
        // `kunde.dk` that no pass has ever been able to check (P1-40). The row is
        // "status unknown" with the reason, and the key is counted apart from
        // the sites.
        uncheckable: !checkable,
        // The reason, asked of the one owner — and asked here, on the **raw**
        // key, which is the only place in this document the shape can still be
        // seen. Measured 2026-09-28 (P1-83): every cell below asked the owner
        // about the *redacted* key from the line above, `hasUrlCredentials` is
        // `false` on that form, and this document called
        // `http://demo:pass@kunde.dk/` "not a full address" in three places — a
        // full address, and the same sentence the two terminal lists were
        // measured past in P1-82. The raw key stops here: both fields are the
        // owner's own words, and neither carries the password.
        uncheckableNote: checkable ? null : unusableUrlNote([url], { brief: true }),
        uncheckableKind: checkable ? null : unusableUrlKind(url),
        status: checkable ? verdictFor(entry?.wasUp) : 'unknown',
        stale,
        ageDays: pass.ageDays,
        statusCode,
        // The two additive fields for the same failure, asked of the one owner
        // that words it: a 401/403/429 is a closed door or a throttle in front
        // of *this* monitor, not a measurement of the customer's website, and
        // the row plus the counted failure say exactly that. The status cell
        // cannot carry a sentence, so the line under the table names it.
        httpDownKind: httpDownKind(statusCode),
        httpDownNote: statusCode === null ? null : httpDownNote({ statusCode }),
        // The two additive fields for the same fact: the boolean a CI job or an
        // agency's own system can branch on (same name as `check --json`), and
        // the owner's own short sentence, so the cell below never re-describes
        // the host change in its own words.
        offHostRedirect: redirect.offHost,
        offHostNote: redirect.label,
        uptimePercent: uptimePercent(entry),
        // Why that share is `null`, as a fact a consumer can branch on instead of
        // reading the Markdown cell: a pass is on the row and the counter that
        // would count it is not in the state file. Asked of the one owner, so the
        // cell and `--json` cannot disagree. Always present.
        counterNotRecorded: counterNotRecorded({
          passRecorded: typeof entry.lastChecked === 'string' && entry.lastChecked !== '',
          checks: entry.checks,
          checksUp: entry.checksUp,
        }),
        window,
        // The two additive fields for the same window: how many of its days the
        // site actually has, and whether that is fewer than the column claims.
        // Asked of the one owner (`windowCoverage`), so the named line below and
        // `--json` cannot disagree about it. A site added inside the window is
        // not a gap — the owner needs both facts, and it has them.
        windowRecordedDays: coverage.recordedDays,
        windowGap: coverage.gap,
        windowMissingDays: coverage.missingDays,
        // The same two files disagreeing in the other direction: recorded days
        // that postdate the newest pass the state file knows about. Asked of the
        // one owner, like `passNotRecorded`, so the named line below cannot
        // describe a disagreement `--json` does not report.
        windowPassesAfter: window?.passesAfterLastPass ?? 0,
        checks,
        failures,
        responseMs: readResponseMs(entry),
        sslDaysRemaining,
        // The same window `check` and `watch` use, so a certificate that is
        // urgent in the terminal cannot read as routine in the report a client
        // receives. A site with no known expiry is never "expiring", and a
        // lapsed certificate is never "expiring soon" — it is expired.
        sslExpiringSoon: ssl.expiringSoon,
        sslExpired: ssl.expired,
        sslExpiredDays: ssl.expiredDays,
        // The two additive fields for the reading's own age, so the machine
        // surface can say what the column says: `sslMayHaveExpired` is the
        // certificate whose deadline has passed since the pass that read it —
        // not measured as expired, which is what `sslExpired` still means — and
        // `sslReadingAgeDays` says how old the reading is.
        sslMayHaveExpired: ssl.mayHaveExpired,
        sslReadingAgeDays: ssl.readingAgeDays,
        // The same treatment for the certificate's identity, and for the same
        // reason: the SSL column counts down from the certificate the last pass
        // read, so it cannot show that this is not the one the client had last
        // time. `certRotated` is the fact and `certRotatedAt` when it happened,
        // beside the age the report prints it with.
        certRotated: cert.rotated,
        certRotatedAt: cert.rotatedAt,
        certRotatedAgeDays: cert.ageDays,
        // How many times the certificate has been replaced since the site was
        // added. `certRotated` above answers *whether*, and its two siblings
        // answer *when* — none of the three can say *how often*, so a site that
        // renewed once and a site whose certificate was replaced 47 times in
        // 24 h were the same two lines in this document. Additive, and `0` for
        // every state file written before the counter existed, so no upgrade
        // invents a rotation.
        certRotationCount: cert.rotations,
        // Which certificate answered last, by the number the issuer gave it. The
        // state file has kept it since P0-3 and nothing read it, so the document a
        // bureau forwards could name the issuer behind the customer's certificate
        // (P1-66) and the fact that it had been replaced (P1-61, P1-68) — and not
        // the one number a security questionnaire asks for beside the issuer. The
        // field is additive and `null` for every state file without a serial, so
        // the sentence below is unchanged for those.
        certSerial: cert.serial,
        // The authority behind that certificate, and whether it is the one the
        // customer's site answered with before. Additive: the SSL cell above is
        // untouched, so a report that was parsed for its day count still is.
        sslIssuer: certIssuer.issuer,
        certIssuerChanged: certIssuer.changed,
        certIssuerChangedAt: certIssuer.changedAt,
        certIssuerChangedPrevious: certIssuer.previous,
        certIssuerChangedAgeDays: certIssuer.ageDays,
        certIssuerChangedNote: certIssuer.note,
        // The same treatment for the page itself. `contentBytes` is the size the
        // last reading that *measured* the body saw — `content.js` skips a page
        // over 2 MiB and leaves the old number behind, so a report that printed
        // it as this pass's measurement was quoting a pass it could not name.
        // `contentReadAt` says when that reading was taken, `contentChanged` is
        // the last measured change with `contentChangedAgeDays` beside it, and
        // the title is the part a customer recognises in a screenshot.
        contentBytes: content.bytes,
        contentReadAt: content.bytesReadAt,
        contentChanged: content.changed,
        contentChangedAt: content.changedAt,
        contentChangedAgeDays: content.ageDays,
        contentTitle: content.title,
        // The title the page carried before that change, when the pass that
        // measured the change kept it. `contentTitle` alone is the page as it is
        // now, so a consumer that renders it next to `contentChanged` can only
        // say the page's title is that — the same one-sided reading `contentNote`
        // had until the pair was kept. Additive and `null` for every state file
        // written before the pair existed, so nothing a consumer reads moves.
        contentTitleBefore: content.previousTitle,
        // The owner's own sentence, carried through rather than rebuilt. The
        // first version had the report assemble it from the site's fields, and
        // the two sets of names did not match — the line rendered as
        // `https://kunde.dk/ ()` while the column said `🔄 changed`.
        contentNote: content.note,
        // The certificate's sentence, carried through for the same reason: a
        // caller must not rebuild it from a different set of field names.
        certRotatedNote: cert.note,
        // The two timestamps go through the one reading of a recorded time, so
        // `--json` can never forward a string the Markdown column has already
        // shown as `—`. See `readPassTime`.
        lastChecked: readPassTime(entry.lastChecked),
        // Additive, and the reason the Last check cell can say something true
        // about a machine whose clock is wrong: which of the four states the
        // recorded time is in, and the owner's own sentence when that time lies
        // ahead of this machine's clock. Empty string for an ordinary pass, so a
        // consumer can print it unconditionally.
        passState: pass.state,
        clockAhead,
        monitoringSince,
        // …and "a pass was recorded at all" is a *different* fact, kept on its
        // own so a `null` time (unreadable) cannot be read as "no pass" by the
        // summary line or by `unknownNote`. Measured: canonicalising the time
        // alone made the summary line claim the site had never been checked,
        // while its own row named the time unreadable — the same collapse P1-14
        // was written to prevent.
        passRecorded: typeof entry.lastChecked === 'string' && entry.lastChecked !== '',
      };
    })
    // Problems first: a report that opens with a DOWN site is the one a client reads.
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.url.localeCompare(b.url));

  const buckets = siteBuckets(sites);

  const summary = {
    sites: sites.length,
    // "up" is a claim about now, so a stale pass is not one of them — the
    // observed result stays on the site as `status`, and `stale` says why it is
    // not counted. DOWN is deliberately not filtered the same way: a customer
    // must still see a site that was last seen down.
    up: sites.filter(site => site.status === 'up' && !site.stale && !isPassAhead(site)).length,
    down: sites.filter(site => site.status === 'down').length,
    unknown: sites.filter(site => site.status === 'unknown').length,
    stale: sites.filter(site => site.stale).length,
    // Additive, so an agency reading `up`/`down`/`unknown`/`stale` gets the
    // same numbers as before. These three are what makes the overlap above
    // readable instead of a puzzle: the stale sites' share of `down` and
    // `unknown`, and how many of the unknown sites never had a pass at all.
    staleDown: sites.filter(site => site.stale && site.status === 'down').length,
    staleUnknown: sites.filter(site => site.stale && site.status === 'unknown').length,
    // Additive, and disjoint from the four above: a pass whose recorded time is
    // later than this machine's own clock. `passAge` already refuses to call such
    // a pass "checked today", so counting it as a current `up` here was the only
    // place left that treated a reading from the future as a reading from now.
    ahead: buckets.ahead,
    neverChecked: buckets.neverChecked,
    checks: sites.reduce((total, site) => total + site.checks, 0),
    failures: sites.reduce((total, site) => total + site.failures, 0),
    sslExpiringSoon: sites.filter(site => site.sslExpiringSoon).length,
    sslExpired: sites.filter(site => site.sslExpired).length,
    // Additive, and disjoint from the two above: a certificate whose deadline
    // passed since the pass that read it is neither expiring nor measured as
    // expired, and it is the one a client most needs to hear about.
    sslMayHaveExpired: sites.filter(site => site.sslMayHaveExpired).length,
    // Additive, and disjoint from the three above: a certificate that was
    // *replaced* rather than one that is running out. Every SSL number above can
    // look better after a domain changes hands than before it — a fresh 90-day
    // certificate replaces a 3-day-old warning — so this count is the only one
    // that can move the other way.
    certRotated: sites.filter(site => site.certRotated).length,
    // Additive, and the strongest of the certificate counts: a certificate that
    // now answers from an authority the customer never had. Disjoint from the
    // ones above — a renewal keeps its issuer, and an expiry keeps it too — so
    // this is the only count that can move when the *name* changed hands rather
    // than the certificate.
    certIssuerChanged: sites.filter(site => site.certIssuerChanged).length,
    // Additive, and disjoint from the two above: a window column that quotes a
    // share for a period shorter than the one it names. Measured: 28 recorded
    // days printed as `95.83%` next to "the last 30 days", with the shortfall
    // visible only as the word "recorded" inside the cell.
    windowGaps: sites.filter(site => site.windowGap).length,
    // Additive: how many of the listed URLs are not addresses at all. They are
    // counted in `sites` above (removing them would move every other number),
    // so before this the document gave a client a row of dashes for a key that
    // no monitoring pass has ever been able to check.
    uncheckable: sites.filter(site => site.uncheckable).length,
  };

  return {
    generatedAt: now.toISOString(),
    title: normalizeTitle(title),
    tool: `${PRODUCT.proName} (${PRODUCT.name} CLI)`,
    windowDays,
    summary,
    // The disjoint partition, exported so the machine surface can say the same
    // thing as the customer line. `buildReport` computed it, used one field of
    // it, and dropped the rest; `summary.up`/`down`/`unknown` are the older,
    // deliberately overlapping numbers, and `renderReportMarkdown` recomputed
    // the partition from `sites` a second time. Measured on one state file with
    // seven sites — one up, one down, one stale, one never checked, one with an
    // unreadable verdict, two with a mangled status code — the line a customer
    // reads was a partition that added up:
    //
    //   **7 site(s) · 3 up · 1 down · 1 not checked · 1 status unknown · … · 1 stale**
    //
    // and `--json`, from the same state file, was not:
    //
    //   "sites": 7, "up": 3, "down": 1, "unknown": 2, "stale": 1  →  3+1+2 = 6
    //
    // The four numbers a CI job or an agency's own system reads do not add up to
    // the number of sites, and the partition that does — the one the report's
    // own footnote defines — was nowhere in the JSON. A consumer could not
    // reproduce the line the customer was sent. Additive: `summary` keeps every
    // key and value it had, so nothing that reads the old numbers breaks.
    partition: buckets,
    sites,
  };
}

/** Machine-readable form: pure JSON on stdout, for CI and for agencies' own systems. */
export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}

/**
 * A counted thing, with the count and the noun agreeing.
 *
 * Measured 2026-09-27, this report is the document a bureau forwards to a
 * paying customer, and it wrote `100% (1 checks)`, `0% (1 checks, 1 failed)` and
 * `1 recorded d, 1 checks` for a site that had been monitored once. The number
 * was right and the English was not, in three of the seven columns' worth of
 * prose, on the exact row a client reads when the site is new — the first
 * report a bureau sends is the one a site added yesterday produces.
 *
 * `site(s)` in the summary line is deliberately left alone: it is an existing,
 * test-locked choice, and the count beside it already reads correctly.
 */
function counted(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Is the check counter *missing* from the state file, rather than zero in it?
 *
 * "no completed pass" is a claim about *history*, and `uptimePercent` returns
 * `null` whenever the counters are zero — which is two different states, and only
 * one of them makes the old sentence true. Measured 2026-09-28 through the real
 * `report`, on a state file with no `checks`/`checksUp` pair in it, the shape a
 * machine gets the first time it runs a pass written by a version that did not
 * have the counters:
 *
 *   | http://127.0.0.1:57311/ | UP (200) | — (no completed pass) | … | 120 ms | stable · 100 bytes | 2026-09-27 02:00 UTC |
 *   **2 site(s) · 1 up · 0 down · 1 not checked · 0 checks · 0 failed**
 *
 * The same row says a pass completed a day ago — status, response time and
 * last-check time all say so — and that no pass ever completed. The next real
 * pass on that same file measured `100% (1 check)`, so the pass in that row did
 * happen: the *counter* was what the file did not have, and the cell said
 * nothing about which of the two was absent.
 *
 * Both facts are needed, and both are asked of the fields that already own them:
 * `passRecorded` is the same one `unknownNote` and the summary line use, so the
 * three surfaces cannot disagree. A site with no recorded pass keeps the old
 * sentence byte for byte — that claim is true there.
 *
 * A counter that is *present and zero* while a pass is on the row is a third
 * state, and it is deliberately not this one: nothing DeskUptime writes can
 * produce it (`recordPass` increments both counters and writes them with the
 * pass), so it is a hand-edited file, which `counters()` already clamps and
 * repairs on the next pass. Naming a missing file there would be a second wrong
 * claim in place of the first, so that row keeps the sentence it always had.
 *
 * @param {object} entry — the state entry's own counter fields plus the owner's
 *   `passRecorded` fact
 * @returns {boolean}
 */
export function counterNotRecorded({ passRecorded = false, checks, checksUp } = {}) {
  const present = Number.isInteger(checks) && checks >= 0 && Number.isInteger(checksUp) && checksUp >= 0;
  return passRecorded === true && !present;
}

function uptimeCell(site) {
  if (site.counterNotRecorded) return '— (no counter in the state file)';
  if (site.uptimePercent === null) return '— (no completed pass)';
  const failures = site.failures > 0 ? `, ${site.failures} failed` : '';
  return `${site.uptimePercent}% (${counted(site.checks, 'check')}${failures})`;
}

/**
 * "The recorded pass is dated ahead of this machine's clock" — one fact, read
 * from the state the pass owner already resolved (`PASS_AGE.AHEAD`).
 *
 * The fallback on `clockAhead` is for a site object built by hand rather than by
 * `buildReport`: the sentence and the state are the same fact, and a hand-built
 * object may carry only the one. It is not a second rule — a report built by
 * `buildReport` always carries both, and the state is the only thing named here
 * (the literal belongs to `PASS_AGE`, which is the one place that may write it).
 *
 * @param {object} site
 * @returns {boolean}
 */
function isPassAhead(site) {
  if (typeof site?.passState === 'string') return site.passState === PASS_AGE.AHEAD;
  return Boolean(site?.clockAhead);
}

/**
 * The disjoint buckets the summary line is written from.
 *
 * The line is the first thing a customer reads and it is the only place the
 * counts and the table have to agree. Measured before this existed, they did
 * not: `up` deliberately excluded a stale pass while `down` deliberately kept
 * one (both are right — a stale site is not *currently* up, and a customer must
 * still see a site last seen down), so the two rules overlapped. A report over
 * one up, one down and one stale-down site read
 *
 *   **3 site(s) · 1 up · 2 down · 9 checks · 4 failed · 1 stale**
 *
 * where 1 + 2 + 1 is four sites out of three, and the stale site is inside
 * both `down` and `stale`. With a site that was never checked, the numbers fell
 * the other way: `summary.unknown` was counted, exported in the JSON — and
 * never printed at all, so a fourth row in the table belonged to no number on
 * the line.
 *
 * So staleness is resolved first and the status words only describe sites whose
 * pass is current. Every site lands in exactly one bucket, which is what makes
 * the line addable — and the stale sites keep their last observed status in the
 * table, named on their own line with the age of that pass, so nothing is lost
 * by moving them here.
 */
export function siteBuckets(sites) {
  const buckets = { up: 0, down: 0, unknown: 0, stale: 0, ahead: 0, neverChecked: 0 };
  for (const site of Array.isArray(sites) ? sites : []) {
    if (!site || typeof site !== 'object') continue;
    // `buildReport` states it as its own fact, because its `lastChecked` is the
    // *readable* time and `null` for both "no pass" and "unreadable". A report
    // object built by hand has no such field, so the readable time is the answer.
    if (!(site.passRecorded ?? !site.lastChecked)) buckets.neverChecked++;
    if (site.stale === true) {
      buckets.stale++;
    } else if (isPassAhead(site)) {
      buckets.ahead++;
    } else if (site.status === 'up') {
      buckets.up++;
    } else if (site.status === 'down') {
      buckets.down++;
    } else {
      buckets.unknown++;
    }
  }
  return buckets;
}

function statusCell(site) {
  const observed = site.status === 'up'
    ? `UP${site.statusCode ? ` (${site.statusCode})` : ''}`
    : site.status === 'down'
      ? `DOWN${site.statusCode ? ` (${site.statusCode})` : ''}`
      // Asked about the fact, not about the readable time — see `unknownNote`.
      // The note itself was measured on the raw key where the document still
      // has it (`uncheckableNote`); this is only the reader's copy of it, and a
      // site object built by hand rather than by `buildReport` has none — so it
      // gets the fact without a reason, never a reason this surface guessed.
      : site.uncheckable
        ? site.uncheckableNote ?? 'cannot be checked'
        : unknownNote({ passRecorded: site.passRecorded, ageDays: site.ageDays, clockAhead: site.clockAhead });
  // A 200 from another host is still a 200 — the row keeps its verdict — but the
  // customer reading this must see whose server answered, or "UP" is a claim
  // about a URL nobody asked about (a parked domain, a hijacked domain, a typo).
  const crossed = site.offHostRedirect ? ` ⚠️ ${site.offHostNote}` : '';
  return site.stale ? `${observed} ⚠️ ${staleAgeNote(site.ageDays)}${crossed}` : `${observed}${crossed}`;
}

/**
 * The unknown bucket, in the customer's words.
 *
 * Two different facts hide in `unknown`, and the summary line used to print
 * neither: a site that was never monitored, and a site whose last pass ran but
 * whose verdict cannot be read (a hand-edited or restored state file). They
 * are separated here because the table already separates them — one says "not
 * checked yet", the other names the age of the pass it cannot read.
 */
function unknownWords(buckets) {
  const unreadable = buckets.unknown - buckets.neverChecked;
  const parts = [];
  if (buckets.neverChecked > 0) parts.push(`${buckets.neverChecked} not checked`);
  if (unreadable > 0) parts.push(`${unreadable} status unknown`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

function windowCell(site, windowDays) {
  const window = site.window;
  // The pass the state file records is inside the window, and the history file
  // has no bucket for it. "No pass in the last N d" would be a claim about the
  // site; the truth is about this one file, and the row next to it already shows
  // the pass. Naming the source is the whole difference (see `emptyWindow`).
  if (window?.passNotRecorded) return '— (last check missing from the history file)';
  if (!window) return `— (no pass in the last ${windowDays} d)`;
  // The two sibling cells have an unknown branch and this one did not, so a
  // window without a computable share printed `null% (1 recorded d, 10 checks)`
  // into the document an agency forwards. Measured as unreachable through
  // `report` (buildReport always passes uptimePercent, and a window with
  // buckets always has a check to divide), so this is the rule stated, not a
  // fix for an observed line.
  if (window.uptimePercent === null || window.uptimePercent === undefined) return `— (no share in the last ${windowDays} d)`;
  const failures = window.failures > 0 ? `, ${window.failures} failed` : '';
  return `${window.uptimePercent}% (${window.days} recorded d, ${counted(window.checks, 'check')}${failures})`;
}

function sslCell(site) {
  if (site.sslExpired) return `🔴 ${expiredNote(site.sslExpiredDays)}`;
  if (site.sslMayHaveExpired) return `🔴 ${sslLapsedNote({ days: site.sslDaysRemaining, ageDays: site.sslReadingAgeDays })}`;
  if (site.sslDaysRemaining === null) return '—';
  return site.sslExpiringSoon ? `⚠️ ${site.sslDaysRemaining} d — renew soon` : `${site.sslDaysRemaining} d`;
}

/**
 * The Last check column, in one place.
 *
 * A bare timestamp is a claim: it says the check happened then. When the
 * recorded time is *ahead* of this machine's clock that claim is not available
 * — the pass may be from yesterday or from a restored backup, and the timestamp
 * cannot say which — so the cell names the skew instead of printing a date the
 * reader would have to notice is impossible. An ordinary pass is unchanged,
 * character for character.
 */
function lastCheckCell(site) {
  if (site.clockAhead) return `${shortTime(site.lastChecked)} ⚠️ ${site.clockAhead}`;
  return shortTime(site.lastChecked);
}

const HEADERS = ['Site', 'Status', 'Uptime (all)', 'Uptime (window)', 'Response', 'SSL', 'Content', 'Last check'];

/**
 * The Content column, in one place.
 *
 * A page that was read and has not changed says `stable`; a page whose bytes were
 * read but cannot be placed in time still says so, because "the size is from
 * whenever we last looked" is a fact and silence would not be. A page nobody ever
 * read says `—`: `content.js` skips a body over 2 MiB, and "no change" about a
 * page we never looked at is the same false all-clear P1-21 removed from
 * `check --json`. The *change* is named under the table, not here — a cell that
 * carries a sentence is a cell nobody reads, which is the reason the report
 * names things out loud instead.
 *
 * The size carries its own age, asked of the one owner the two terminal lists
 * have asked since 2026-09-27. The report was the last surface that printed a
 * bare number, and it printed it in the document a client reads: measured
 * 2026-09-28, a site whose pass was 5 h old and whose page had not been *read*
 * for 5 days — `content.js` skips a body over 2 MiB and leaves the old size
 * behind — read `stable · 3221225 bytes` here while both lists said
 * `3221225 bytes, read 5 d ago` about the same row of the same file. Two cells
 * in one row said the check was 5 hours old and that the page had been looked at
 * five days ago, and neither of them said so. A reading from today keeps the
 * words it has always had, character for character.
 */
function contentCell(site, now) {
  if (site.contentChanged) return '🔄 changed';
  if (site.contentBytes === null) return '—';
  return `stable · ${contentBytesNote(site.contentBytes, site.contentReadAt, now)}`;
}

export function renderReportMarkdown(report) {
  const windowDays = report.windowDays || DEFAULT_WINDOW_DAYS;
  // The clock the cells are rendered against. `buildReport` was handed one and
  // stamped it here as `generatedAt`, so this is that same instant under its other
  // name — a report rendered twice from one report object cannot age a reading one
  // way in the column and another way in the line under the table. `Date` here
  // covers the ISO string `buildReport` writes and the `Date` a hand-built report
  // object in the tests carries.
  const now = new Date(report.generatedAt);
  // The partition `buildReport` already resolved, so the line and the JSON are
  // two renderings of one answer. `siteBuckets` is still the owner — it is only
  // asked again here for a report object built by hand rather than by
  // `buildReport`, which is the one case where nothing resolved it yet.
  const buckets = report.partition ?? siteBuckets(report.sites);
  const rows = report.sites.map(site => {
    const cells = [
      cell(site.url),
      cell(statusCell(site)),
      cell(uptimeCell(site)),
      cell(windowCell(site, windowDays)),
      cell(site.responseMs === null ? '—' : `${site.responseMs} ms`),
      cell(sslCell(site)),
      cell(contentCell(site, now)),
      cell(lastCheckCell(site)),
    ];
    return `| ${cells.join(' | ')} |`;
  });

  const since = report.sites
    .map(site => site.monitoringSince)
    .filter(Boolean)
    .sort()[0];

  // A forwarded report is read once. Naming the certificates that need
  // renewing turns a column of numbers into something the recipient can act on.
  const expired = report.sites.filter(site => site.sslExpired);
  const expiring = report.sites.filter(site => site.sslExpiringSoon);
  // A lapsed certificate comes first and is named separately: "renew soon" about
  // a certificate that has already broken the site is worse than no line at all.
  const expiredLines = expired.length === 0
    ? []
    : [
      '',
      `**🔴 SSL certificate${expired.length === 1 ? ' has' : 's have'} expired — the site is affected:** ${expired.map(site => cell(`${site.url} (${expiredNote(site.sslExpiredDays)})`)).join(', ')}`,
    ];
  const attention = expiring.length === 0
    ? []
    : [
      '',
      `**SSL certificate${expiring.length === 1 ? '' : 's'} expiring within ${SSL_WARN_DAYS} days — renewal needed:** ${expiring.map(site => cell(`${site.url} (${site.sslDaysRemaining} d)`)).join(', ')}`,
    ];

  // The reading that has stopped counting. It belongs under the expired line
  // rather than in it: nothing measured a lapse, so "the site is affected" would
  // be a claim we cannot make — but a certificate that had `1 d` left 36 hours ago
  // is not a renewal to schedule, and this is the one line in the document that
  // can still prevent an outage. Named with both numbers, because one of them
  // alone is what made the old line wrong.
  const lapsed = report.sites.filter(site => site.sslMayHaveExpired);
  const lapsedLines = lapsed.length === 0
    ? []
    : [
      '',
      `**Get a fresh certificate reading before you act on ${lapsed.length === 1 ? 'this' : 'these'}:** ${lapsed.map(site => cell(`${site.url} — ${sslLapsedNote({ days: site.sslDaysRemaining, ageDays: site.sslReadingAgeDays })}`)).join('; ')}`,
      '',
      'Run: deskuptime check <url>',
    ];

  // The certificate itself. A client report that says `UP (200) | 100%` about a
  // domain that was handed to a new owner is the same false all-clear as the one
  // an expired certificate used to be — and here it is not even visible in the
  // column: the SSL cell counts down from whatever certificate answered, and a
  // reissued one has *more* days left than the one it replaced. It is named with
  // the age it had when the report was generated, and the wording is deliberately
  // a fact rather than a verdict: most hosts reissue every 90 days, and the reader
  // is the one who knows whether this site's certificate was supposed to change.
  const rotated = report.sites.filter(site => site.certRotated);
  const rotatedLines = rotated.length === 0
    ? []
    : [
      '',
      `**${counted(rotated.length, 'site has its certificate replaced', 'sites have their certificate replaced')} since monitoring — the SSL column above counts down from the new certificate and does not show this:** ${rotated.map(site => cell(`${site.url} (${site.certRotatedNote})`)).join(', ')}`,
    ];

  // The authority, and the one count in this document that means somebody else
  // may be answering for the customer's name. Every other certificate line is a
  // fact about a certificate that is still valid for the right name — this one is
  // a fact about *who vouched for it*, and a hijack is exactly the case where
  // every other column looks healthy: 100 % uptime, a fresh 90-day certificate
  // and a site that answers. It is named out loud, with both authorities, so the
  // reader does not have to go and look it up in the one document that must not
  // require it.
  const issuerChanged = report.sites.filter(site => site.certIssuerChanged);
  const issuerLines = issuerChanged.length === 0
    ? []
    : [
      '',
      `**${counted(issuerChanged.length, 'site answers from a certificate authority other than the one', 'sites answer from a certificate authority other than the one')} the customer's site answered with when monitoring started — check this before the numbers above are read as healthy:** ${issuerChanged.map(site => cell(`${site.url} (${site.certIssuerChangedNote})`)).join(', ')}`,
    ];

  // The page itself. A report that says `UP (200) | 100%` about a site whose
  // homepage was replaced is the same false all-clear an expired certificate
  // used to be, and the recipient is the one who has to act on it: a defaced or
  // hijacked page is not an uptime problem, so every uptime column in the table
  // above stays at 100 % and looks healthy. The change is named with the age it
  // has earned, because a report is read once and often days after the pass that
  // produced it — "the page changed" without a date reads as "this morning".
  const changedContent = report.sites.filter(site => site.contentChanged);
  const changedLines = changedContent.length === 0
    ? []
    : [
      '',
      `**${changedContent.length === 1 ? 'One site has' : `${changedContent.length} sites have`} had its page content change since monitoring — the uptime columns above do not cover this:** ${changedContent.map(site => cell(`${site.url} (${site.contentNote})`)).join(', ')}`,
    ];

  // Same reasoning for old data: a site whose monitoring stopped is the
  // recipient's most consequential line, and it is invisible in a table unless
  // it is named.
  const stale = report.sites.filter(site => site.stale);
  const staleLines = stale.length === 0
    ? []
    : [
      '',
      `**Monitoring data is stale for ${stale.length} site${stale.length === 1 ? '' : 's'} — no pass in the last ${STALE_AFTER_DAYS} days:** ${stale.map(site => cell(site.ageDays === null ? site.url : `${site.url} (${site.ageDays} d)`)).join(', ')}`,
    ];

  // A pass dated in the future is the one reading whose time cannot be believed:
  // the document's own header can be older than the check it reports, and then
  // "1 up" and "Last check 2026-10-17" describe a check that has not happened yet.
  // Kept out of `up` for that reason, and named here with the owner's own
  // sentence, because the fix is a clock and not a site.
  const ahead = report.sites.filter(site => isPassAhead(site));
  const aheadLines = ahead.length === 0
    ? []
    : [
      '',
      `**${counted(ahead.length, 'site has its last check dated ahead of this machine’s clock', 'sites have their last check dated ahead of this machine’s clock')} — that pass cannot have run yet, so it is not counted as up above:** ${ahead.map(site => cell(`${site.url} (${site.clockAhead || 'last check is in the future'})`)).join('; ')}`,
    ];

  // The same rule for a site that answered, but from somewhere else. Uptime
  // percentages look best precisely because nobody reads them closely, so a row
  // that quietly says "UP (200) ⚠️ answered by …" would pass a glance while the
  // number above it stays 100 % — and the recipient is the one who has to act on
  // it. Named out loud, the way an expired certificate is.
  const crossed = report.sites.filter(site => site.offHostRedirect);
  const crossedLines = crossed.length === 0
    ? []
    : [
      '',
      `**${crossed.length === 1 ? 'One site is' : `${crossed.length} sites are`} answered by another host — the monitored URL no longer serves the site itself:** ${crossed.map(site => cell(site.offHostNote)).join(', ')}`,
    ];

  // The window column quotes a share and a period together. When the site has
  // fewer recorded days than the period, those two disagree and the reader is
  // the customer — so it is named out loud, the way a stale pass is, with the
  // count on both sides. Only sites that were already being monitored when the
  // window opened, so a site added on Tuesday is never called a gap.
  const gaps = report.sites.filter(site => site.windowGap);
  const gapLines = gaps.length === 0
    ? []
    : [
      '',
      `**Fewer days recorded than the window for ${gaps.length} site${gaps.length === 1 ? '' : 's'} — the uptime above covers part of the period, not all of it:** ${gaps.map(site => cell(`${site.url} (${site.windowRecordedDays} of ${site.windowMissingDays + site.windowRecordedDays} d)`)).join(', ')}`,
    ];

  // `emptyWindow` names the case where the history file is missing a pass the
  // state file knows ran. This is the other direction, and it is the one a client
  // reads as a boast: the window column counts checks on days the site has not
  // been checked since, while the summary line says monitoring stopped. Both
  // numbers come from real files, so the document has to say which two disagree
  // rather than print them as one measurement.
  const afterPass = report.sites.filter(site => site.windowPassesAfter > 0);
  const afterPassLines = afterPass.length === 0
    ? []
    : [
      '',
      `**The two sources disagree for ${afterPass.length} site${afterPass.length === 1 ? '' : 's'} — the window column counts checks on days that are newer than the last recorded pass, so the "Last check" column is the one to believe:** ${afterPass.map(site => cell(`${site.url} (${counted(site.windowPassesAfter, 'day')} of recorded checks after the last pass)`)).join(', ')}`,
    ];

  // A failure that is about this monitor's access and not about the customer's
  // website. The row cannot carry a sentence and the counted failure cannot be
  // excused from the summary — the 0 % above it is the truth about what this
  // machine saw — so the reason is named out loud, once, under the table. A
  // staged page behind a proxy, a site still under a maintenance plugin and a
  // CDN that throttles unknown user agents all read as `DOWN (401|403|429)` in
  // the one document an agency forwards, and none of them is an outage.
  const closedDoor = report.sites.filter(site => site.httpDownKind && site.httpDownNote);
  const closedDoorLines = closedDoor.length === 0
    ? []
    : [
      '',
      `**${closedDoor.length === 1 ? 'One site answered with' : `${closedDoor.length} sites answered with`} a closed door or a throttle rather than a page — the failure above is about access, not about the site being down:** ${closedDoor.map(site => cell(`${site.url} (${site.httpDownNote})`)).join('; ')}`,
    ];

  // A key that no pass can check gets a row of dashes in the table, which a
  // client reads as "we checked this site and have nothing to report" — or as a
  // site the agency forgot. It is neither. Named out loud, with the same words
  // the terminal uses for the same key.
  const uncheckable = report.sites.filter(site => site.uncheckable);
  // The two reasons counted apart, so the line and the summary can name the one
  // that applies. `kunde.dk` is not a full address; `http://demo:pass@kunde.dk/`
  // very much is, it is just one no pass may send a request to. A hand-built
  // site object has no kind and keeps the wording it always had.
  const notAddress = uncheckable.filter(site => site.uncheckableKind !== 'credentials').length;
  const credentialed = uncheckable.length - notAddress;
  const uncheckableReason = ' — the row above is empty because nothing was measured, not because the site was quiet:** ';
  // One reason across the group: the lead-in carries it, the keys follow as
  // they always have. Two reasons: the lead-in drops the reason and every key
  // carries **its own** — measured 2026-09-28, this line said "not a full
  // address" for all of them, so a bureau's customer document called a working
  // address broken, and for the wrong reason (P1-83).
  const oneReason = credentialed === 0;
  const uncheckableHead = oneReason
    ? `${uncheckable.length === 1 ? 'One listed URL is' : `${uncheckable.length} listed URLs are`} not a full address, so no monitoring pass can check ${uncheckable.length === 1 ? 'it' : 'them'}`
    : `${counted(uncheckable.length, 'listed URL cannot be checked', 'listed URLs cannot be checked')}`;
  const uncheckableNamed = oneReason
    ? uncheckable.map(site => cell(site.url)).join(', ')
    : uncheckable.map(site => cell(`${site.url} — ${site.uncheckableNote ?? 'no reason given'}`)).join('; ');
  const uncheckableLines = uncheckable.length === 0
    ? []
    : ['', `**${uncheckableHead}${uncheckableReason}${uncheckableNamed}`];

  return [
    `# ${cell(report.title)}`,
    '',
    `Generated ${shortTime(report.generatedAt)} by ${report.tool}.`,
    '',
    `| ${HEADERS.join(' | ')} |`,
    `|${' --- |'.repeat(HEADERS.length)}`,
    ...(rows.length > 0 ? rows : [`| ${['_no monitored sites_', '—', '—', '—', '—', '—', '—', '—'].join(' | ')} |`]),
    '',
    `**${report.summary.sites} site(s) · ${buckets.up} up · ${buckets.down} down${unknownWords(buckets)} · ${counted(report.summary.checks, 'check')} · ${report.summary.failures} failed${expiring.length > 0 ? ` · ${expiring.length} SSL expiring soon` : ''}${expired.length > 0 ? ` · ${expired.length} SSL EXPIRED` : ''}${lapsed.length > 0 ? ` · ${lapsed.length} SSL may be expired` : ''}${rotated.length > 0 ? ` · ${rotated.length === 1 ? '1 certificate replaced' : `${rotated.length} certificates replaced`}` : ''}${issuerChanged.length > 0 ? ` · ${issuerChanged.length} from a new certificate authority` : ''}${changedContent.length > 0 ? ` · ${changedContent.length} content changed` : ''}${stale.length > 0 ? ` · ${stale.length} stale (no check in the last ${STALE_AFTER_DAYS} d)` : ''}${ahead.length > 0 ? ` · ${ahead.length} checked ahead of this machine’s clock` : ''}${crossed.length > 0 ? ` · ${crossed.length} answered by another host` : ''}${closedDoor.length > 0 ? ` · ${closedDoor.length} answered with a closed door or a throttle` : ''}${gaps.length > 0 ? ` · ${gaps.length} with an incomplete window` : ''}${notAddress > 0 ? ` · ${notAddress} not a full address` : ''}${credentialed > 0 ? ` · ${credentialed} with a username or password in it` : ''}**`,
    ...expiredLines,
    ...lapsedLines,
    ...attention,
    ...rotatedLines,
    ...issuerLines,
    ...changedLines,
    ...staleLines,
    ...aheadLines,
    ...crossedLines,
    ...gapLines,
    ...afterPassLines,
    ...closedDoorLines,
    ...uncheckableLines,
    '',
    `Uptime is the share of completed monitoring passes that answered HTTP 200–399. "Uptime (all)" counts every pass since the site was added${since ? ` (earliest ${shortTime(since)})` : ''}; "Uptime (window)" counts the passes recorded in the last ${windowDays} days. A site with no completed pass yet shows — rather than 100%. Where a pass *is* on the row — a status, a response time, a last-check time — the — names the state file's missing check counter instead, because that pass ran and only the counter is not there; \`counterNotRecorded\` in \`--json\` is the same fact as a boolean. "Uptime (window)" is counted from a separate daily history file, so a row can show a recent check with an empty window column; that column then names the file that is missing the pass rather than claiming the site was not monitored. The two files can also disagree the other way, with the history file holding recorded checks on days that are newer than the last pass in the state file; such a site is named below the table with the number of those days, so the window column is never read as checks this machine ran after it stopped watching. A site that was already being monitored when the window opened, but has fewer recorded days than the window, is named below the table with both counts, so the share and the period are not read as covering days nobody watched. The counts in the summary line are a partition: every site is in exactly one of up, down, not checked, status unknown, stale or checked ahead of this machine’s clock. "Up" and "down" describe sites checked within the last ${STALE_AFTER_DAYS} days; a site whose monitoring stopped is counted as stale and keeps the status from its last pass in the table, named with the age of that pass, and a pass dated later than this machine’s own clock is counted the same way, because a check that has not happened yet is not a check today. "Status unknown" means a pass ran but its result cannot be read from the state file. A listed URL that no pass can send a request to can never be measured at all — neither one that is not a full address nor one that carries a username or password, which is a full address the tool may not use: each is named below the table with the reason it cannot be checked and counted separately, so its empty row is never read as a site that was simply quiet. A 401, 403 or 429 is a closed door or a throttle in front of this monitor, not a reading of the site: it is counted as a failure above and named below the table with the reason, so a staged page behind a proxy and a CDN throttling an unknown user agent are not read as an outage. The SSL column is what the last pass read, so its day count is the deadline the certificate had at that moment. A reading less than a day old is shown as measured; one old enough that the certificate may have lapsed since is named as such and is not counted as a renewal to schedule — run \`deskuptime check <url>\` for a fresh reading. A certificate that was replaced since monitoring is named below the table with the age it had when this report was generated; the SSL column counts down from the certificate that answered last, so it cannot show that it is a different one from the client's. The same line carries that certificate's serial number, because the issuer above and the serial are what a security review asks for as a pair, and a renewal that changed nothing else is the one case where the number is still worth reading. A certificate that now answers from an authority other than the one the site answered with when monitoring started is named the same way, with both names: a renewal keeps its issuer, and a hijack keeps every number above looking healthy. \`sslIssuer\` in \`--json\` names the authority behind the certificate the SSL column counts down from. The Content column is what the last pass that actually read the page saw: a page over the content-check limit is never read, so it shows — rather than a size, and a size left by an earlier pass is never presented as this check's measurement. A size that is not from today says how old it is, because the check in the last column can be hours old while the page was last read days ago, and a row that quoted a number without saying when would read as a measurement of now. \`contentReadAt\` in \`--json\` is that time. "Changed" is a change measured since the site was added, and it is named below the table with the age it had when this report was generated — a page that was altered and then left alone is still a page a customer should know about, and the uptime columns do not cover it.`,
    '',
    `Generated on one machine, without an account: no page content, response headers or license data is included, and nothing was uploaded.`,
  ].join('\n');
}
