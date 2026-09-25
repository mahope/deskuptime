/**
 * watch.js — background monitoring loop for the deskuptime CLI
 *
 * Stores state in ~/.deskuptime/state.json (content hashes + last status),
 * prints status changes to the terminal, and (Pro) sends system notifications.
 *
 * Free tier: up to 3 URLs, 60s minimum interval.
 * Pro tier (activated license): unlimited URLs, intervals down to 30s,
 * desktop notifications via osascript (macOS) where available.
 */

import { checkUrl } from './engine.js';
import { activateLicense, refreshLicense, normalizeLicense, LICENSE_STATUS } from './license.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, statSync, chmodSync } from 'fs';
import { dirname, posix, win32 } from 'path';
import { homedir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { assertValidHttpUrls } from './status.js';

const FREE_URL_LIMIT = 3;
const FREE_MIN_INTERVAL = 60;
const PRO_MIN_INTERVAL = 30;
const LICENSE_RECHECK_MS = 24 * 60 * 60 * 1000;
const STATE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;
export const PRO_BUY_URL = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';

/**
 * One upgrade path, used wherever a free user hits a Pro-only limit.
 * Kept in sync with docs/pro-alerts.md.
 */
function upgradeHint(feature) {
  return `Pro unlocks ${feature}: ${PRO_BUY_URL} — then "deskuptime activate <key>".`;
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
 * rejected. A cached (offline) license still counts as Pro, an invalidated one
 * does not — so a revoked key loses its entitlements on the next pass instead
 * of on the next reinstall.
 */
export function isPro(state) {
  const license = state?.license;
  if (!license?.key || !license?.instance) return false;
  return license.status !== LICENSE_STATUS.INVALID;
}

function hashContent(str) {
  return createHash('sha256').update(str).digest('hex');
}

function fmtNow() {
  return new Date().toLocaleTimeString();
}

/**
 * One monitoring pass over all tracked URLs.
 * Returns list of change events: [{ url, type: 'up'|'down'|'ssl_warning'|'content_changed', message }]
 */
export async function runPass(state, opts = {}) {
  const events = [];
  const urls = Object.keys(state.urls);
  assertValidHttpUrls(urls);
  const check = opts.check || checkUrl;

  const results = await Promise.all(urls.map((url) => {
    const entry = state.urls[url];
    return check(url, { contentHash: entry.lastHash || null });
  }));

  for (let index = 0; index < results.length; index++) {
    const url = urls[index];
    const entry = state.urls[url];
    const result = results[index];
    const firstPass = entry.wasUp === null || entry.wasUp === undefined;

    if (firstPass) {
      const status = result.healthy ? 'UP' : 'DOWN';
      const detail = result.healthy
        ? ` (${result.statusCode}) — ${result.responseTimeMs}ms`
        : result.error ? ` — ${result.error}` : '';
      events.push({ url, type: 'baseline', message: `baseline recorded: ${status}${detail}` });
    } else if (result.healthy && entry.wasUp === false) {
      events.push({ url, type: 'up', message: `is UP (${result.statusCode}) — ${result.responseTimeMs}ms` });
    } else if (!result.healthy && entry.wasUp === true) {
      events.push({ url, type: 'down', message: `is DOWN${result.error ? ' — ' + result.error : ''}` });
    }

    const validDays = result.ssl?.validDays;
    if (Number.isFinite(validDays)) {
      entry.sslValidDays = validDays;
      const warningActive = entry.sslWarned === true || typeof entry.sslWarned === 'number';
      if (validDays <= 14 && !warningActive) {
        events.push({ url, type: 'ssl_warning', message: `SSL expires in ${validDays} days ⚠️` });
        entry.sslWarned = true;
      } else if (validDays > 14) {
        entry.sslWarned = false;
      }
    } else {
      delete entry.sslValidDays;
    }

    if (result.content?.changed === true) {
      events.push({ url, type: 'content_changed', message: `content changed (${entry.lastContentLength ?? '?'} → ${result.content.contentLength} bytes)` });
    }

    entry.lastChecked = result.timestamp || new Date().toISOString();
    entry.wasUp = result.healthy;
    entry.lastStatus = result.statusCode;
    if (result.content?.hash) entry.lastHash = result.content.hash;
    if (Number.isFinite(result.content?.contentLength)) entry.lastContentLength = result.content.contentLength;
  }

  saveState(state, opts);
  const pass = {
    events,
    results,
    healthy: results.every(result => result.healthy),
  };
  return opts.returnResults ? pass : events;
}

function eventIcon(type) {
  return { down: '🚨', up: '✅', baseline: '•', ssl_warning: '⚠️ ', content_changed: '🔄' }[type] || '•';
}

export function printPass(pass, { alertUnchangedDown = true } = {}) {
  for (const event of pass.events) {
    console.log(`[${fmtNow()}] ${eventIcon(event.type)} ${event.url} ${event.message}`);
  }

  const reported = new Set(pass.events.filter(event => event.type === 'down' || event.type === 'baseline').map(event => event.url));
  if (!pass.healthy) {
    for (const result of pass.results) {
      if (result.healthy || reported.has(result.url)) continue;
      const message = alertUnchangedDown ? 'is DOWN' : 'remains DOWN';
      console.log(`[${fmtNow()}] ${alertUnchangedDown ? '🚨' : '·'} ${result.url} ${message}${result.error ? ' — ' + result.error : ''}`);
    }
  } else if (pass.events.length === 0) {
    console.log(`[${fmtNow()}] ✓ all monitored sites OK`);
  }
}

export function printStatus(options = {}) {
  const state = loadState(options);
  const entries = Object.entries(state.urls);
  if (entries.length === 0) {
    console.log('No URLs monitored. Start with: deskuptime watch <url>');
    return;
  }
  console.log(`📋 ${entries.length} monitored URL(s):\n`);
  for (const [url, entry] of entries) {
    const status = entry.wasUp === true ? '✅ up' : entry.wasUp === false ? '🚨 down' : '❔ unknown';
    const ssl = entry.sslValidDays != null ? `, SSL ${entry.sslValidDays}d` : '';
    const checked = entry.lastChecked ? ` @ ${entry.lastChecked}` : '';
    console.log(`  ${status}  ${url} (${entry.lastStatus ?? '—'}${ssl})${checked}`);
  }
}

function addMonitoredUrls(state, urls, pro) {
  const limit = pro ? Infinity : FREE_URL_LIMIT;
  let added = 0;
  for (const url of urls) {
    if (state.urls[url]) continue;
    if (Object.keys(state.urls).length >= limit) {
      console.log(pro
        ? `⚠️  Skipping duplicate/extra URL: ${url}`
        : `⚠️  Free tier monitors ${FREE_URL_LIMIT} URLs. ${url} not added. ${upgradeHint('unlimited URLs and a 30s interval')}`);
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
    if (!current || (entry.lastChecked && (!current.lastChecked || entry.lastChecked > current.lastChecked))) {
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
      const available = Math.max(FREE_URL_LIMIT - Object.keys(state.urls).length, 0);
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

  const minInterval = pro ? PRO_MIN_INTERVAL : FREE_MIN_INTERVAL;
  const interval = Math.max(opts.interval || 300, minInterval);
  const added = addMonitoredUrls(state, urls, pro);
  if (added === 0 && Object.keys(state.urls).length === 0) {
    throw new Error('No URLs to monitor.');
  }
  mergePersistedState(state, opts);
  saveState(state, opts);

  console.log(`\n👀 Monitoring ${Object.keys(state.urls).length} URL(s), every ${interval}s.${pro ? ' [Pro]' : ' [free tier]'}.${pro && webhookUrl ? ' Webhook alerts on.' : ''} Ctrl+C to stop.\n`);

  if (webhookUrl && !pro) {
    console.error(`⚠️  --webhook needs an active Pro license, so no webhook was sent yet. ${upgradeHint('webhook alerts')}`);
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
