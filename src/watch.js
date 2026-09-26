/**
 * watch.js — background monitoring loop for the deskuptime CLI
 *
 * Stores state in ~/.deskuptime/state.json (content hashes + last status),
 * prints status changes to the terminal, and (Pro) sends system notifications.
 *
 * Free tier: up to 3 URLs, 60s minimum interval.
 * Pro tier (activated license): unlimited URLs, intervals down to 30s,
 * desktop notifications via osascript (macOS) where available.
 * Those numbers come from src/features.js — the same source the README,
 * --help and docs/pro-alerts.md matrix are generated from.
 */

import { checkUrl } from './engine.js';
import { activateLicense, refreshLicense, normalizeLicense, proGateMessage, LICENSE_STATUS, PRO_STATUSES } from './license.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, statSync, chmodSync } from 'fs';
import { dirname, posix, win32 } from 'path';
import { homedir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { assertValidHttpUrls, expiredNote, isNewerPass, readEntry, readSslState, STALE_AFTER_DAYS } from './status.js';
import { recordPass } from './report.js';
import { formatMs, safeText } from './display.js';
import { loadHistory, pruneHistory, recordHistoryPass, saveHistory } from './history.js';
import { FREE, PRO, PRODUCT } from './features.js';

const LICENSE_RECHECK_MS = 24 * 60 * 60 * 1000;
const STATE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;
// The limits and the buy link live in src/features.js, so the free/Pro claims in
// README, --help and docs/pro-alerts.md cannot drift from what is enforced here.
export const PRO_BUY_URL = PRODUCT.buyUrl;

/**
 * One upgrade path, used wherever a free user hits a Pro-only limit.
 * Kept in sync with docs/pro-alerts.md and docs/agency-report.md.
 */
export function upgradeHint(feature) {
  return `Pro unlocks ${feature}: ${PRO_BUY_URL} — then "deskuptime activate <key>".`;
}

/**
 * The single free-tier refusal, so `--once` and the watch loop tell the user the
 * same thing — including where to buy Pro.
 */
export function freeLimitMessage(url) {
  return `Free tier monitors ${FREE.urlLimit} URLs. ${url} not added. ${upgradeHint(`unlimited URLs and a ${PRO.minIntervalSeconds}s interval`)}`;
}

export function getStateFile({ env = process.env, platform = process.platform } = {}) {
  const home = platform === 'win32'
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || homedir();
  const path = platform === 'win32' ? win32 : posix;
  return path.join(home, '.deskuptime', 'state.json');
}

function emptyState() {
  return { urls: {} };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.urls || typeof value.urls !== 'object' || Array.isArray(value.urls)) {
    return emptyState();
  }
  const urls = Object.fromEntries(
    Object.entries(value.urls).filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry)),
  );
  const state = { ...value, urls };
  // A license record is only trusted if it validates: a hand-edited or
  // half-written state file must not hand out Pro, and must not crash the CLI.
  const license = normalizeLicense(state.license);
  if (license) state.license = license;
  else delete state.license;
  return state;
}

function stateFileFrom(options) {
  return options.stateFile || getStateFile(options);
}

export function loadState(options = {}) {
  const stateFile = stateFileFrom(options);
  if (!existsSync(stateFile)) return emptyState();
  try {
    return normalizeState(JSON.parse(readFileSync(stateFile, 'utf-8')));
  } catch {
    return emptyState();
  }
}

/**
 * State holds the license key and the monitored URLs, so it is written 0600
 * inside a 0700 directory, and swapped in atomically: a crash mid-write can
 * never leave a truncated state file behind.
 */
export function saveState(state, options = {}) {
  const stateFile = stateFileFrom(options);
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* pre-existing dir we may not own */ }
  }
  const temporaryFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporaryFile, stateFile);
    if (process.platform !== 'win32') chmodSync(stateFile, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}

/**
 * Pro requires a *usable* license: a valid record that the server has not
 * rejected. A cached (offline) license still counts as Pro, an unverified or
 * invalidated one does not — so a rejected or long-unreachable key loses its
 * entitlements on the next pass instead of on the next reinstall. The check is
 * an allow-list plus the legacy case, so a new status can never hand out Pro by
 * accident while an installation that predates the status field keeps working.
 */
export function isPro(state) {
  const license = state?.license;
  if (!license?.key || !license?.instance) return false;
  return license.status == null || PRO_STATUSES.includes(license.status);
}

function hashContent(str) {
  return createHash('sha256').update(str).digest('hex');
}

function fmtNow() {
  return new Date().toLocaleTimeString();
}

/**
 * One monitoring pass over all tracked URLs.
 * Returns list of change events: [{ url, type: 'up'|'down'|'ssl_warning'|'ssl_expired'|'content_changed', message }]
 */
export async function runPass(state, opts = {}) {
  const events = [];
  const urls = Object.keys(state.urls);
  assertValidHttpUrls(urls);
  const check = opts.check || checkUrl;
  // Daily counters for the client report's "last 30 days" column. Recorded for
  // every tier: history is two integers per site per day, and a free user who
  // upgrades should not start a 30-day report with an empty month.
  const now = opts.now instanceof Date ? opts.now : new Date();
  const history = loadHistory(opts);

  const results = await Promise.all(urls.map((url) => {
    const entry = state.urls[url];
    return check(url, { contentHash: entry.lastHash || null });
  }));

  for (let index = 0; index < results.length; index++) {
    const url = urls[index];
    const entry = state.urls[url];
    const result = results[index];
    // The previous verdict, read through readEntry() like every other surface.
    // This used to compare the raw `entry.wasUp` to `true`/`false` itself, so a
    // hand-edited, restored or half-written `wasUp: "yes"` (or `1`, or "false")
    // matched none of the three branches below and the pass produced *no event
    // at all* — and since notify() and sendWebhook() fire only from events, a
    // paying customer got no desktop notification and no webhook about a site
    // that was down, while the terminal said "remains DOWN" on the same pass.
    const previous = readEntry(entry).verdict;
    // A baseline is "this site has never been checked", not "the last verdict
    // is unreadable" — an entry that already has a pass behind it must not be
    // announced as a first observation, and its DOWN state must reach the
    // customer. wasUp is rewritten from the fresh result at the end of the
    // pass, so the entry repairs itself and the alert is not repeated.
    const firstPass = previous === 'unknown' && !entry.lastChecked;

    if (firstPass) {
      const status = result.healthy ? 'UP' : 'DOWN';
      const detail = result.healthy
        ? ` (${result.statusCode}) — ${formatMs(result.responseTimeMs)}`
        : result.error ? ` — ${result.error}` : '';
      events.push({ url, type: 'baseline', message: `baseline recorded: ${status}${detail}` });
    } else if (result.healthy && previous === 'down') {
      events.push({ url, type: 'up', message: `is UP (${result.statusCode}) — ${formatMs(result.responseTimeMs)}` });
    } else if (!result.healthy && (previous === 'up' || previous === 'unknown')) {
      // An unreadable previous verdict cannot prove a transition, but the site
      // is down *now* and the customer is paying to hear about it. Silence here
      // is the bug; the wording claims nothing about when it broke.
      events.push({ url, type: 'down', message: `is DOWN${result.error ? ' — ' + result.error : ''}` });
    }

    // One reading of the certificate, so the event, the persisted entry and
    // every later report agree. The writer used `Number.isFinite(validDays)`
    // alone — a weaker gate than every reader had — so a negative day count was
    // announced as "SSL expires in -3 days ⚠️", pushed to the desktop
    // notification and the customer's webhook, and persisted into every report
    // afterwards. A lapsed certificate is now its own event and its own fact.
    const ssl = readSslState({
      days: result.ssl?.validDays,
      expired: result.ssl?.isExpired,
      expiredDays: result.ssl?.expiredDays,
    });
    if (ssl.expired) {
      delete entry.sslValidDays;
      entry.sslExpired = true;
      if (ssl.expiredDays !== null) entry.sslExpiredDays = ssl.expiredDays;
      if (entry.sslExpiredWarned !== true) {
        events.push({ url, type: 'ssl_expired', message: `SSL certificate ${expiredNote(ssl.expiredDays)} 🔴` });
        entry.sslExpiredWarned = true;
      }
      entry.sslWarned = false;
    } else if (ssl.days !== null) {
      delete entry.sslExpired;
      delete entry.sslExpiredDays;
      entry.sslExpiredWarned = false;
      entry.sslValidDays = ssl.days;
      const warningActive = entry.sslWarned === true || typeof entry.sslWarned === 'number';
      if (ssl.expiringSoon && !warningActive) {
        events.push({ url, type: 'ssl_warning', message: `SSL expires in ${ssl.days} days ⚠️` });
        entry.sslWarned = true;
      } else if (!ssl.expiringSoon) {
        entry.sslWarned = false;
      }
    } else {
      delete entry.sslValidDays;
      delete entry.sslExpired;
      delete entry.sslExpiredDays;
      entry.sslExpiredWarned = false;
    }

    if (result.content?.changed === true) {
      events.push({ url, type: 'content_changed', message: `content changed (${entry.lastContentLength ?? '?'} → ${result.content.contentLength} bytes)` });
    }

    entry.lastChecked = result.timestamp || new Date().toISOString();
    entry.wasUp = result.healthy;
    entry.lastStatus = result.statusCode;
    // Uptime counters for the client report. Two integers per URL, so the
    // state file cannot grow with the length of the monitoring history.
    recordPass(entry, result);
    recordHistoryPass(history, url, result, { now });
    if (result.content?.hash) entry.lastHash = result.content.hash;
    if (Number.isFinite(result.content?.contentLength)) entry.lastContentLength = result.content.contentLength;
  }

  saveState(state, opts);
  try {
    // Pruned on write, so the history file is bounded no matter how long the
    // loop runs. A failure here must never take down monitoring: the state file
    // above is the source of truth, and a missing day only costs the report one
    // column, while a throw here would stop every URL from being checked.
    saveHistory(pruneHistory(history, { now }), opts);
  } catch (error) {
    console.error(`⚠️  Could not write the uptime history: ${error.message}`);
  }
  const pass = {
    events,
    results,
    healthy: results.every(result => result.healthy),
  };
  return opts.returnResults ? pass : events;
}

function eventIcon(type) {
  return { down: '🚨', up: '✅', baseline: '•', ssl_warning: '⚠️ ', ssl_expired: '🔴 ', content_changed: '🔄' }[type] || '•';
}

export function printPass(pass, { alertUnchangedDown = true } = {}) {
  // The URL and the error text printed next to a DOWN line come from the site
  // being watched, so they are flattened to one inert line each: a server that
  // sends escape sequences must not be able to repaint our own output.
  for (const event of pass.events) {
    console.log(`[${fmtNow()}] ${eventIcon(event.type)} ${safeText(event.url, { max: 0 })} ${safeText(event.message, { max: 0 })}`);
  }

  const reported = new Set(pass.events.filter(event => event.type === 'down' || event.type === 'baseline').map(event => event.url));
  if (!pass.healthy) {
    for (const result of pass.results) {
      if (result.healthy || reported.has(result.url)) continue;
      const message = alertUnchangedDown ? 'is DOWN' : 'remains DOWN';
      console.log(`[${fmtNow()}] ${alertUnchangedDown ? '🚨' : '·'} ${safeText(result.url, { max: 0 })} ${message}${result.error ? ' — ' + safeText(result.error, { max: 0 }) : ''}`);
    }
  } else if (pass.events.length === 0) {
    console.log(`[${fmtNow()}] ✓ all monitored sites OK`);
  }
}

const VERDICT_ICON = { up: '✅ up', down: '🚨 down', unknown: '❔ unknown' };

export function printStatus(options = {}) {
  const state = loadState(options);
  const entries = Object.entries(state.urls);
  if (entries.length === 0) {
    console.log('No URLs monitored. Start with: deskuptime watch <url>');
    return;
  }
  // readEntry() is the same reading `check`, `watch` and the client report use,
  // so a pass from six weeks ago cannot print here as a site that is up now,
  // and a certificate inside the warning window cannot print as routine. This
  // command makes no request — which is exactly why the age of the last pass is
  // part of what it says.
  const now = options.now instanceof Date ? options.now : new Date();
  const rows = entries.map(([url, entry]) => ({ url, entry, ...readEntry(entry, { now }) }));

  console.log(`📋 ${rows.length} monitored URL(s):\n`);
  for (const row of rows) {
    const code = row.statusCode === null ? '—' : row.statusCode;
    const ssl = row.sslNote ? `, ${row.sslNote}` : '';
    // lastChecked is state-file text, so it is flattened like the URL beside it.
    const checked = row.entry.lastChecked ? ` @ ${safeText(row.entry.lastChecked, { max: 0 })}` : '';
    const stale = row.staleNote ? ` ⚠️ ${row.staleNote}` : '';
    console.log(`  ${VERDICT_ICON[row.verdict]}  ${safeText(row.url, { max: 0 })} (${code}${ssl})${checked}${stale}`);
  }

  // A stale site is the reader's most consequential line and a per-row marker
  // is easy to miss in a list, so the dead ones are named — the same "say it
  // once, out loud" rule the client report follows. This is also the only
  // command that can tell the user their *monitoring* stopped, which is the
  // question this command exists to answer.
  const staleRows = rows.filter(row => row.stale);
  if (staleRows.length > 0) {
    console.log(`\n⚠️  No monitoring pass in the last ${STALE_AFTER_DAYS} days for ${staleRows.length} of ${rows.length} site(s) — the numbers above are that old, not now:`);
    for (const row of staleRows) {
      console.log(`    ${safeText(row.url, { max: 0 })} (last pass ${row.ageDays === null ? 'at an unreadable time' : `${row.ageDays} d ago`})`);
    }
    console.log('    Monitoring has probably stopped. Run: deskuptime watch <url> --once');
  }
}

function addMonitoredUrls(state, urls, pro) {
  const limit = pro ? PRO.urlLimit : FREE.urlLimit;
  let added = 0;
  for (const url of urls) {
    if (state.urls[url]) continue;
    if (Object.keys(state.urls).length >= limit) {
      console.log(pro
        ? `⚠️  Skipping duplicate/extra URL: ${url}`
        : `⚠️  ${freeLimitMessage(url)}`);
      continue;
    }
    state.urls[url] = {
      addedAt: new Date().toISOString(),
      wasUp: null,
      lastHash: null,
      lastContentLength: null,
      sslWarned: false,
    };
    added++;
  }
  return added;
}

function mergePersistedState(state, options) {
  const persisted = loadState(options);
  for (const [url, entry] of Object.entries(persisted.urls)) {
    const current = state.urls[url];
    // Which pass is newer is isNewerPass()'s decision, not a string compare —
    // see its doc comment for the two timestamp pairs that sort the wrong way
    // and the whole entry that rolled back because of it.
    if (!current || isNewerPass(entry.lastChecked, current.lastChecked)) {
      state.urls[url] = entry;
    }
  }
  if (Object.hasOwn(persisted, 'license')) state.license = persisted.license;
  return state;
}

function removeStaleStateLock(lockFile) {
  let modifiedAt;
  try {
    modifiedAt = statSync(lockFile).mtimeMs;
  } catch (error) {
    return error.code === 'ENOENT';
  }

  let owner = null;
  try {
    owner = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    if (Date.now() - modifiedAt < 30_000) return false;
  }

  if (owner && Date.now() - modifiedAt <= STATE_LOCK_MAX_AGE_MS) {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid === process.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
  }

  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function acquireStateLock(stateFile) {
  const lockFile = `${stateFile}.lock`;
  const token = randomUUID();
  mkdirSync(dirname(stateFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
          if (owner.token === token) unlinkSync(lockFile);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && removeStaleStateLock(lockFile)) continue;
      return null;
    }
  }
  return null;
}

export async function runOnce(urls, opts = {}) {
  assertValidHttpUrls(urls);
  const release = acquireStateLock(stateFileFrom(opts));
  if (!release) return { events: [], results: [], healthy: false, added: 0, busy: true };

  try {
    const state = loadState(opts);
    const pro = isPro(state);
    if (!pro) {
      const available = Math.max(FREE.urlLimit - Object.keys(state.urls).length, 0);
      const rejected = [...new Set(urls)].filter(url => !state.urls[url]).slice(available);
      if (rejected.length > 0) return { events: [], results: [], healthy: false, added: 0, rejected };
    }
    const added = addMonitoredUrls(state, urls, pro);
    if (Object.keys(state.urls).length === 0) return { events: [], results: [], healthy: false, added, empty: true };
    const pass = await runPass(state, { ...opts, returnResults: true });
    return { ...pass, added };
  } finally {
    release();
  }
}

/**
 * Send a desktop notification when possible (Pro only).
 * macOS: osascript. Other platforms: silently skipped for now.
 */
async function notify(title, message) {
  if (process.platform !== 'darwin') return;
  try {
    const { execFile } = await import('child_process');
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await new Promise((resolve) => {
      execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], () => resolve());
    });
  } catch {
    // notifications are best-effort
  }
}

/**
 * POST an event to a user-supplied webhook URL (Pro only).
 * Best-effort, no retry, no queue — see docs/pro-alerts.md §2.
 * Bounded by a hard timeout so a hanging endpoint cannot stall the watch loop.
 */
export async function sendWebhook(webhookUrl, event, { timeoutMs = WEBHOOK_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: 'deskuptime',
        type: event.type,
        url: event.url,
        message: event.message,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) console.error(`⚠️  Webhook responded ${res.status}`);
    return res.ok;
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error(`⚠️  Webhook delivery failed: ${timedOut ? `no response within ${timeoutMs}ms` : err.message}`);
    return false;
  }
}

/**
 * Start the watch loop. Resolves never — runs until SIGINT.
 */
export async function startWatch(urls, opts = {}) {
  const { webhookUrl } = opts;
  const state = loadState(opts);
  assertValidHttpUrls([...urls, ...Object.keys(state.urls)]);
  let pro = false;

  async function recheckLicense() {
    if (!isPro(state)) return false;
    const result = await refreshLicense(state.license);
    state.license = result.license;
    saveState(state, opts);
    if (!result.pro) console.error(`⚠️  Pro license not active: ${result.reason}`);
    return result.pro;
  }
  pro = await recheckLicense();
  let lastLicenseCheck = Date.now();

  if (opts.activateKey && !pro) {
    console.log('🔑 Activating license...');
    const result = await activateLicense(opts.activateKey);
    if (result.valid) {
      state.license = { key: result.key, instance: result.deviceId, plan: result.meta.plan, status: LICENSE_STATUS.ACTIVE, validatedAt: new Date().toISOString() };
      saveState(state, opts);
      pro = true;
      console.log('✅ Pro activated.');
    } else if (result.transient) {
      console.error(`❌ Could not reach the license server: ${result.error}`);
      console.error('    Nothing was changed. Try again when the server answers — your Pro is unchanged.');
    } else {
      console.error(`❌ Activation failed: ${result.error}`);
    }
  }

  const minInterval = pro ? PRO.minIntervalSeconds : FREE.minIntervalSeconds;
  const interval = Math.max(opts.interval || 300, minInterval);
  const added = addMonitoredUrls(state, urls, pro);
  if (added === 0 && Object.keys(state.urls).length === 0) {
    throw new Error('No URLs to monitor.');
  }
  mergePersistedState(state, opts);
  saveState(state, opts);

  console.log(`\n👀 Monitoring ${Object.keys(state.urls).length} URL(s), every ${interval}s.${pro ? ' [Pro]' : ' [free tier]'}.${pro && webhookUrl ? ' Webhook alerts on.' : ''} Ctrl+C to stop.\n`);

  if (webhookUrl && !pro) {
    // Same gate as the other Pro-only surfaces: a key the server never rejected
    // is answered with "re-check the key", never with the checkout.
    console.error(`⚠️  No webhook was sent. ${proGateMessage(state.license, 'webhook alerts') || 'Webhook alerts need an active Pro license.'}`);
    console.error('    Terminal alerts keep working. Monitoring starts now; the webhook activates with the license.\n');
  } else if (pro && !webhookUrl && process.platform !== 'darwin') {
    console.error('ℹ️  Local desktop notifications are macOS-only in the CLI. Use --webhook for alerts on this platform.\n');
  }

  process.on('SIGINT', () => {
    console.log('\n👋 Watch stopped. State saved in ~/.deskuptime/ — run again to resume.');
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    mergePersistedState(state, opts);
    if (Date.now() - lastLicenseCheck >= LICENSE_RECHECK_MS) {
      lastLicenseCheck = Date.now();
      pro = await recheckLicense();
    }
    const pass = await runPass(state, { ...opts, returnResults: true });
    printPass(pass, { alertUnchangedDown: false });
    if (pro) {
      for (const event of pass.events) {
        if (event.type === 'baseline') continue;
        await notify('DeskUptime', `${event.url} ${event.message}`);
        if (webhookUrl) await sendWebhook(webhookUrl, event);
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}
