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
import { SSL_WARN_DAYS, STALE_AFTER_DAYS, clockAheadNote, expiredNote, isCheckStale, passAge, readPassTime, readRedirectTarget, readResponseMs, readSslState, readStatusCode, sslLapsedNote, staleAgeNote, unknownNote, verdictFor } from './status.js';

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
  const sites = Object.entries(state?.urls ?? {})
    .filter(([url, entry]) => typeof url === 'string' && url && entry && typeof entry === 'object')
    .map(([url, entry]) => {
      const { checks, failures } = counters(entry);
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
      const window = windowSummary(history, url, { days: windowDays, now, uptimePercent, lastChecked: entry.lastChecked });
      const monitoringSince = readPassTime(entry.addedAt);
      const coverage = windowCoverage({ window, history, monitoringSince, days: windowDays, now });
      return {
        url,
        status: verdictFor(entry?.wasUp),
        stale,
        ageDays: pass.ageDays,
        statusCode: readStatusCode(entry.lastStatus),
        // The two additive fields for the same fact: the boolean a CI job or an
        // agency's own system can branch on (same name as `check --json`), and
        // the owner's own short sentence, so the cell below never re-describes
        // the host change in its own words.
        offHostRedirect: redirect.offHost,
        offHostNote: redirect.label,
        uptimePercent: uptimePercent(entry),
        window,
        // The two additive fields for the same window: how many of its days the
        // site actually has, and whether that is fewer than the column claims.
        // Asked of the one owner (`windowCoverage`), so the named line below and
        // `--json` cannot disagree about it. A site added inside the window is
        // not a gap — the owner needs both facts, and it has them.
        windowRecordedDays: coverage.recordedDays,
        windowGap: coverage.gap,
        windowMissingDays: coverage.missingDays,
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
        contentBytes: nonNegative(entry.lastContentLength),
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
    up: sites.filter(site => site.status === 'up' && !site.stale).length,
    down: sites.filter(site => site.status === 'down').length,
    unknown: sites.filter(site => site.status === 'unknown').length,
    stale: sites.filter(site => site.stale).length,
    // Additive, so an agency reading `up`/`down`/`unknown`/`stale` gets the
    // same numbers as before. These three are what makes the overlap above
    // readable instead of a puzzle: the stale sites' share of `down` and
    // `unknown`, and how many of the unknown sites never had a pass at all.
    staleDown: sites.filter(site => site.stale && site.status === 'down').length,
    staleUnknown: sites.filter(site => site.stale && site.status === 'unknown').length,
    neverChecked: buckets.neverChecked,
    checks: sites.reduce((total, site) => total + site.checks, 0),
    failures: sites.reduce((total, site) => total + site.failures, 0),
    sslExpiringSoon: sites.filter(site => site.sslExpiringSoon).length,
    sslExpired: sites.filter(site => site.sslExpired).length,
    // Additive, and disjoint from the two above: a certificate whose deadline
    // passed since the pass that read it is neither expiring nor measured as
    // expired, and it is the one a client most needs to hear about.
    sslMayHaveExpired: sites.filter(site => site.sslMayHaveExpired).length,
    // Additive, and disjoint from the two above: a window column that quotes a
    // share for a period shorter than the one it names. Measured: 28 recorded
    // days printed as `95.83%` next to "the last 30 days", with the shortfall
    // visible only as the word "recorded" inside the cell.
    windowGaps: sites.filter(site => site.windowGap).length,
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

function uptimeCell(site) {
  if (site.uptimePercent === null) return '— (no completed pass)';
  const failures = site.failures > 0 ? `, ${site.failures} failed` : '';
  return `${site.uptimePercent}% (${site.checks} checks${failures})`;
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
  const buckets = { up: 0, down: 0, unknown: 0, stale: 0, neverChecked: 0 };
  for (const site of Array.isArray(sites) ? sites : []) {
    if (!site || typeof site !== 'object') continue;
    // `buildReport` states it as its own fact, because its `lastChecked` is the
    // *readable* time and `null` for both "no pass" and "unreadable". A report
    // object built by hand has no such field, so the readable time is the answer.
    if (!(site.passRecorded ?? !site.lastChecked)) buckets.neverChecked++;
    if (site.stale === true) {
      buckets.stale++;
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
  return `${window.uptimePercent}% (${window.days} recorded d, ${window.checks} checks${failures})`;
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

const HEADERS = ['Site', 'Status', 'Uptime (all)', 'Uptime (window)', 'Response', 'SSL', 'Last check'];

export function renderReportMarkdown(report) {
  const windowDays = report.windowDays || DEFAULT_WINDOW_DAYS;
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

  return [
    `# ${cell(report.title)}`,
    '',
    `Generated ${shortTime(report.generatedAt)} by ${report.tool}.`,
    '',
    `| ${HEADERS.join(' | ')} |`,
    `|${' --- |'.repeat(HEADERS.length)}`,
    ...(rows.length > 0 ? rows : [`| ${['_no monitored sites_', '—', '—', '—', '—', '—', '—'].join(' | ')} |`]),
    '',
    `**${report.summary.sites} site(s) · ${buckets.up} up · ${buckets.down} down${unknownWords(buckets)} · ${report.summary.checks} checks · ${report.summary.failures} failed${expiring.length > 0 ? ` · ${expiring.length} SSL expiring soon` : ''}${expired.length > 0 ? ` · ${expired.length} SSL EXPIRED` : ''}${lapsed.length > 0 ? ` · ${lapsed.length} SSL may be expired` : ''}${stale.length > 0 ? ` · ${stale.length} stale (no check in the last ${STALE_AFTER_DAYS} d)` : ''}${crossed.length > 0 ? ` · ${crossed.length} answered by another host` : ''}${gaps.length > 0 ? ` · ${gaps.length} with an incomplete window` : ''}**`,
    ...expiredLines,
    ...lapsedLines,
    ...attention,
    ...staleLines,
    ...crossedLines,
    ...gapLines,
    '',
    `Uptime is the share of completed monitoring passes that answered HTTP 200–399. "Uptime (all)" counts every pass since the site was added${since ? ` (earliest ${shortTime(since)})` : ''}; "Uptime (window)" counts the passes recorded in the last ${windowDays} days. A site with no completed pass yet shows — rather than 100%. "Uptime (window)" is counted from a separate daily history file, so a row can show a recent check with an empty window column; that column then names the file that is missing the pass rather than claiming the site was not monitored. A site that was already being monitored when the window opened, but has fewer recorded days than the window, is named below the table with both counts, so the share and the period are not read as covering days nobody watched. The counts in the summary line are a partition: every site is in exactly one of up, down, not checked, status unknown or stale. "Up" and "down" describe sites checked within the last ${STALE_AFTER_DAYS} days; a site whose monitoring stopped is counted as stale and keeps the status from its last pass in the table, named with the age of that pass. "Status unknown" means a pass ran but its result cannot be read from the state file. The SSL column is what the last pass read, so its day count is the deadline the certificate had at that moment. A reading less than a day old is shown as measured; one old enough that the certificate may have lapsed since is named as such and is not counted as a renewal to schedule — run \`deskuptime check <url>\` for a fresh reading.`,
    '',
    `Generated on one machine, without an account: no page content, response headers or license data is included, and nothing was uploaded.`,
  ].join('\n');
}
