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
import { DEFAULT_WINDOW_DAYS, windowSummary } from './history.js';
import { SSL_WARN_DAYS, STALE_AFTER_DAYS, checkAgeDays, expiredNote, isCheckStale, readSslState } from './status.js';

export const DEFAULT_REPORT_TITLE = 'Website uptime report';
const MAX_TITLE_LENGTH = 120;

/** A hand-edited or half-written state file must not be able to produce NaN. */
export function intOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * A measured quantity, when it is one — otherwise `null`, meaning unknown.
 *
 * The same rule as `intOrZero` and `readSslState`, for the two numbers that
 * describe a pass rather than count it. `Number.isFinite` alone let a negative
 * through, and a state file can hold one (hand-edited, restored, written by
 * another tool). Measured, in the report an agency forwards:
 *
 *   `| https://a.test | UP | 75% (4 checks) | -5 ms |`   ← Response column
 *   `"contentBytes": -999`                               ← --json
 *
 * `lastResponseMs: -5` is not a site that answered in five *negative*
 * milliseconds; it is a value we cannot read, and the report already had the
 * honest answer for that — `—`, which is what every sibling cell prints when
 * the number is missing. A negative byte count is the same lie about a
 * document size, and it is the number an agency would quote.
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

function siteStatus(entry) {
  if (entry?.wasUp === true) return 'up';
  if (entry?.wasUp === false) return 'down';
  return 'unknown';
}

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
      });
      const sslDaysRemaining = ssl.days;
      // The report is a read of the last completed pass and re-checks nothing, so
      // "how old is that pass" is part of the claim. A site whose newest pass is
      // older than the window keeps its observed status — the pass really did
      // answer 200 — but is marked stale so it is never counted as currently up.
      const stale = isCheckStale(entry.lastChecked, now);
      return {
        url,
        status: siteStatus(entry),
        stale,
        ageDays: checkAgeDays(entry.lastChecked, now),
        statusCode: Number.isInteger(entry.lastStatus) ? entry.lastStatus : null,
        uptimePercent: uptimePercent(entry),
        window: windowSummary(history, url, { days: windowDays, now, uptimePercent }),
        checks,
        failures,
        responseMs: nonNegative(entry.lastResponseMs),
        sslDaysRemaining,
        // The same window `check` and `watch` use, so a certificate that is
        // urgent in the terminal cannot read as routine in the report a client
        // receives. A site with no known expiry is never "expiring", and a
        // lapsed certificate is never "expiring soon" — it is expired.
        sslExpiringSoon: ssl.expiringSoon,
        sslExpired: ssl.expired,
        sslExpiredDays: ssl.expiredDays,
        contentBytes: nonNegative(entry.lastContentLength),
        lastChecked: typeof entry.lastChecked === 'string' ? entry.lastChecked : null,
        monitoringSince: typeof entry.addedAt === 'string' ? entry.addedAt : null,
      };
    })
    // Problems first: a report that opens with a DOWN site is the one a client reads.
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.url.localeCompare(b.url));

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
    checks: sites.reduce((total, site) => total + site.checks, 0),
    failures: sites.reduce((total, site) => total + site.failures, 0),
    sslExpiringSoon: sites.filter(site => site.sslExpiringSoon).length,
    sslExpired: sites.filter(site => site.sslExpired).length,
  };

  return {
    generatedAt: now.toISOString(),
    title: normalizeTitle(title),
    tool: `${PRODUCT.proName} (${PRODUCT.name} CLI)`,
    windowDays,
    summary,
    sites,
  };
}

/** Machine-readable form: pure JSON on stdout, for CI and for agencies' own systems. */
export function renderReportJson(report) {
  return JSON.stringify(report, null, 2);
}

/**
 * Markdown for a mail or a ticket. A cell cannot break the table: newlines are
 * flattened, pipes are escaped, and angle brackets are entity-encoded, so a
 * hostile URL is shown as one cell of text instead of becoming extra rows or
 * markup in whatever renders the report.
 */
function cell(value) {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

function uptimeCell(site) {
  if (site.uptimePercent === null) return '— (no completed pass)';
  const failures = site.failures > 0 ? `, ${site.failures} failed` : '';
  return `${site.uptimePercent}% (${site.checks} checks${failures})`;
}

function statusCell(site) {
  const observed = site.status === 'up'
    ? `UP${site.statusCode ? ` (${site.statusCode})` : ''}`
    : site.status === 'down'
      ? `DOWN${site.statusCode ? ` (${site.statusCode})` : ''}`
      : 'not checked yet';
  return site.stale ? `${observed} ⚠️ ${staleNote(site)}` : observed;
}

/** How the age is worded, or null when it cannot be known. */
function staleNote(site) {
  return site.ageDays === null ? 'stale — last check unreadable' : `stale — last check ${site.ageDays} d ago`;
}

function windowCell(site, windowDays) {
  const window = site.window;
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
  if (site.sslDaysRemaining === null) return '—';
  return site.sslExpiringSoon ? `⚠️ ${site.sslDaysRemaining} d — renew soon` : `${site.sslDaysRemaining} d`;
}

const HEADERS = ['Site', 'Status', 'Uptime (all)', 'Uptime (window)', 'Response', 'SSL', 'Last check'];

export function renderReportMarkdown(report) {
  const windowDays = report.windowDays || DEFAULT_WINDOW_DAYS;
  const rows = report.sites.map(site => {
    const cells = [
      cell(site.url),
      cell(statusCell(site)),
      cell(uptimeCell(site)),
      cell(windowCell(site, windowDays)),
      cell(site.responseMs === null ? '—' : `${site.responseMs} ms`),
      cell(sslCell(site)),
      cell(shortTime(site.lastChecked)),
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

  return [
    `# ${cell(report.title)}`,
    '',
    `Generated ${shortTime(report.generatedAt)} by ${report.tool}.`,
    '',
    `| ${HEADERS.join(' | ')} |`,
    `|${' --- |'.repeat(HEADERS.length)}`,
    ...(rows.length > 0 ? rows : [`| ${['_no monitored sites_', '—', '—', '—', '—', '—', '—'].join(' | ')} |`]),
    '',
    `**${report.summary.sites} site(s) · ${report.summary.up} up · ${report.summary.down} down · ${report.summary.checks} checks · ${report.summary.failures} failed${expiring.length > 0 ? ` · ${expiring.length} SSL expiring soon` : ''}${expired.length > 0 ? ` · ${expired.length} SSL EXPIRED` : ''}${stale.length > 0 ? ` · ${stale.length} stale (no check in the last ${STALE_AFTER_DAYS} d)` : ''}**`,
    ...expiredLines,
    ...attention,
    ...staleLines,
    '',
    `Uptime is the share of completed monitoring passes that answered HTTP 200–399. "Uptime (all)" counts every pass since the site was added${since ? ` (earliest ${shortTime(since)})` : ''}; "Uptime (window)" counts the passes recorded in the last ${windowDays} days. A site with no completed pass yet shows — rather than 100%. "Up" in the summary counts sites checked within the last ${STALE_AFTER_DAYS} days; a site whose monitoring stopped is listed as stale with the age of its last pass.`,
    '',
    `Generated on one machine, without an account: no page content, response headers or license data is included, and nothing was uploaded.`,
  ].join('\n');
}
