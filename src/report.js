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
 *   - only `state.urls` is read. The license record (key, device id) is never
 *     passed in, so it cannot leak into a report that leaves the machine;
 *   - no page content, no response headers, no content hash, no IP addresses;
 *   - nothing is written and no request is made — the report is a read of the
 *     last completed pass, so it works offline and cannot be a health check in
 *     disguise. Run `deskuptime watch <url> --once` for a fresh pass.
 *
 * The counters this renders are two integers per URL (see `recordPass`), so the
 * state file stays bounded no matter how long the watch loop runs.
 */

import { PRODUCT } from './features.js';

export const DEFAULT_REPORT_TITLE = 'Website uptime report';
const MAX_TITLE_LENGTH = 120;

/** A hand-edited or half-written state file must not be able to produce NaN. */
export function intOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Fold one completed pass into a URL entry: how many checks ran, how many of
 * them answered UP, and the last response time. Uptime is deliberately
 * defined here and nowhere else, so the writer and the reader cannot disagree.
 *
 * @param {object} entry — state.urls[url], mutated in place
 * @param {object} result — a result from engine.checkUrl()
 * @returns {{ checks: number, failures: number }}
 */
export function recordPass(entry, result) {
  const checks = intOrZero(entry.checks) + 1;
  const checksUp = intOrZero(entry.checksUp) + (result?.healthy === true ? 1 : 0);
  entry.checks = checks;
  entry.checksUp = checksUp;
  if (Number.isFinite(result?.responseTimeMs)) entry.lastResponseMs = result.responseTimeMs;
  return { checks, failures: checks - checksUp };
}

/** Share of completed passes that answered UP, or null when none has run yet. */
export function uptimePercent(entry) {
  const checks = intOrZero(entry?.checks);
  if (checks === 0) return null;
  return Number(((intOrZero(entry.checksUp) / checks) * 100).toFixed(2));
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
 * Build the report from state.urls only. `state.license` is not read, not
 * copied and not reachable from the returned object.
 */
export function buildReport(state, { title, now = new Date() } = {}) {
  const sites = Object.entries(state?.urls ?? {})
    .filter(([url, entry]) => typeof url === 'string' && url && entry && typeof entry === 'object')
    .map(([url, entry]) => {
      const checks = intOrZero(entry.checks);
      const checksUp = intOrZero(entry.checksUp);
      return {
        url,
        status: siteStatus(entry),
        statusCode: Number.isInteger(entry.lastStatus) ? entry.lastStatus : null,
        uptimePercent: uptimePercent(entry),
        checks,
        failures: checks - checksUp,
        responseMs: Number.isFinite(entry.lastResponseMs) ? entry.lastResponseMs : null,
        sslDaysRemaining: Number.isFinite(entry.sslValidDays) ? entry.sslValidDays : null,
        contentBytes: Number.isFinite(entry.lastContentLength) ? entry.lastContentLength : null,
        lastChecked: typeof entry.lastChecked === 'string' ? entry.lastChecked : null,
        monitoringSince: typeof entry.addedAt === 'string' ? entry.addedAt : null,
      };
    })
    // Problems first: a report that opens with a DOWN site is the one a client reads.
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.url.localeCompare(b.url));

  const summary = {
    sites: sites.length,
    up: sites.filter(site => site.status === 'up').length,
    down: sites.filter(site => site.status === 'down').length,
    unknown: sites.filter(site => site.status === 'unknown').length,
    checks: sites.reduce((total, site) => total + site.checks, 0),
    failures: sites.reduce((total, site) => total + site.failures, 0),
  };

  return {
    generatedAt: now.toISOString(),
    title: normalizeTitle(title),
    tool: `${PRODUCT.proName} (${PRODUCT.name} CLI)`,
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
  if (site.status === 'up') return `UP${site.statusCode ? ` (${site.statusCode})` : ''}`;
  if (site.status === 'down') return `DOWN${site.statusCode ? ` (${site.statusCode})` : ''}`;
  return 'not checked yet';
}

const HEADERS = ['Site', 'Status', 'Uptime', 'Response', 'SSL', 'Last check'];

export function renderReportMarkdown(report) {
  const rows = report.sites.map(site => {
    const cells = [
      cell(site.url),
      cell(statusCell(site)),
      cell(uptimeCell(site)),
      cell(site.responseMs === null ? '—' : `${site.responseMs} ms`),
      cell(site.sslDaysRemaining === null ? '—' : `${site.sslDaysRemaining} d`),
      cell(shortTime(site.lastChecked)),
    ];
    return `| ${cells.join(' | ')} |`;
  });

  const since = report.sites
    .map(site => site.monitoringSince)
    .filter(Boolean)
    .sort()[0];

  return [
    `# ${cell(report.title)}`,
    '',
    `Generated ${shortTime(report.generatedAt)} by ${report.tool}.`,
    '',
    `| ${HEADERS.join(' | ')} |`,
    `|${' --- |'.repeat(HEADERS.length)}`,
    ...(rows.length > 0 ? rows : ['| _no monitored sites_ | — | — | — | — | — |']),
    '',
    `**${report.summary.sites} site(s) · ${report.summary.up} up · ${report.summary.down} down · ${report.summary.checks} checks · ${report.summary.failures} failed**`,
    '',
    `Uptime is the share of completed monitoring passes that answered HTTP 200–399, counted per site${since ? ` since it was added (earliest ${shortTime(since)})` : ''}. A site with no completed pass yet shows — rather than 100%.`,
    '',
    `Generated on one machine, without an account: no page content, response headers or license data is included, and nothing was uploaded.`,
  ].join('\n');
}
