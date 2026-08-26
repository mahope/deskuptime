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
import { activateLicense } from './license.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { createHash } from 'crypto';

const FREE_URL_LIMIT = 3;
const FREE_MIN_INTERVAL = 60;
const PRO_MIN_INTERVAL = 30;

const STATE_DIR = join(homedir(), '.deskuptime');
const STATE_FILE = join(STATE_DIR, 'state.json');

export function loadState() {
  if (!existsSync(STATE_FILE)) return { urls: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { urls: {} };
  }
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isPro(state) {
  return Boolean(state?.license?.key && state?.license?.instance);
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
export async function runPass(state) {
  const events = [];
  const urls = Object.keys(state.urls);

  await Promise.all(urls.map(async (url) => {
    const entry = state.urls[url];
    const firstPass = entry.wasUp === null || entry.wasUp === undefined;
    const prevHash = entry.lastHash || null;
    const result = await checkUrl(url, { contentHash: prevHash });

    // Status transition (first pass only establishes baseline — no alarm)
    if (!firstPass) {
      if (result.reachable && !entry.wasUp) {
        events.push({ url, type: 'up', message: `is UP (${result.statusCode}) — ${result.responseTimeMs}ms` });
      } else if (!result.reachable && entry.wasUp) {
        events.push({ url, type: 'down', message: `is DOWN${result.error ? ' — ' + result.error : ''}` });
      }
    }

    // SSL expiry warning
    if (result.ssl?.validDays !== undefined && result.ssl.validDays <= 14) {
      if (!entry.sslWarned || result.ssl.validDays < entry.sslWarned) {
        events.push({ url, type: 'ssl_warning', message: `SSL expires in ${result.ssl.validDays} days ⚠️` });
      }
    }

    // Content changed
    if (result.content?.changed === true) {
      events.push({ url, type: 'content_changed', message: `content changed (${(result.content.previousLength ?? '?')} → ${result.content.contentLength} bytes)` });
    }

    entry.lastChecked = result.timestamp;
    entry.wasUp = result.reachable;
    entry.lastStatus = result.statusCode;
    if (result.content?.hash) entry.lastHash = result.content.hash;
    if (result.ssl?.validDays !== undefined) entry.sslValidDays = result.ssl.validDays;
  }));

  saveState(state);
  return events;
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
 * POST an event to a user-supplied webhook URL (Pro only). Best-effort.
 */
export async function sendWebhook(webhookUrl, event) {
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
    });
    if (!res.ok) console.error(`⚠️  Webhook responded ${res.status}`);
  } catch (err) {
    console.error(`⚠️  Webhook delivery failed: ${err.message}`);
  }
}

/**
 * Start the watch loop. Resolves never — runs until SIGINT.
 */
export async function startWatch(urls, opts = {}) {
  const state = loadState();
  let pro = isPro(state);

  // Optional license activation: deskuptime watch <url> --activate KEY
  if (opts.activateKey && !pro) {
    console.log('🔑 Activating license...');
    const res = await activateLicense(opts.activateKey, `deskuptime-cli-${hostname()}`);
    if (res.valid) {
      state.license = { key: opts.activateKey, instance: res.instance || hostname(), email: res.meta?.email || null };
      saveState(state);
      pro = true;
      console.log(`✅ Pro activated${res.meta?.email ? ' (' + res.meta.email + ')' : ''}.`);
    } else {
      console.error(`❌ Activation failed: ${res.error}`);
    }
  }

  const minInterval = pro ? PRO_MIN_INTERVAL : FREE_MIN_INTERVAL;
  const interval = Math.max(opts.interval || 300, minInterval);
  const urlLimit = pro ? Infinity : FREE_URL_LIMIT;

  let added = 0;
  for (const url of urls) {
    if (state.urls[url]) continue;
    if (Object.keys(state.urls).length >= urlLimit) {
      console.log(pro
        ? `⚠️  Skipping duplicate/extra URL: ${url}`
        : `⚠️  Free tier monitors ${FREE_URL_LIMIT} URLs. Run "deskuptime activate <key>" for Pro (unlimited). ${url} not added.`);
      continue;
    }
    state.urls[url] = { addedAt: new Date().toISOString(), wasUp: null, lastHash: null };
    added++;
  }
  if (added === 0 && Object.keys(state.urls).length === 0) {
    console.error('❌ No URLs to monitor.');
    process.exit(1);
  }
  saveState(state);

  console.log(`\n👀 Monitoring ${Object.keys(state.urls).length} URL(s), every ${interval}s.${pro ? ' [Pro]' : ' [free tier]'}.${webhookUrl ? ' Webhook alerts on.' : ''} Ctrl+C to stop.\n`);

  process.on('SIGINT', () => {
    console.log('\n👋 Watch stopped. State saved in ~/.deskuptime/ — run again to resume.');
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const events = await runPass(state);
    if (events.length === 0) {
      console.log(`[${fmtNow()}] ✓ all monitored sites OK`);
    } else {
      for (const ev of events) {
        const icon = { down: '🚨', up: '✅', ssl_warning: '⚠️ ', content_changed: '🔄' }[ev.type] || '•';
        console.log(`[${fmtNow()}] ${icon} ${ev.url} ${ev.message}`);
        if (pro) {
          await notify('DeskUptime', `${ev.url} ${ev.message}`);
          if (webhookUrl) await sendWebhook(webhookUrl, ev);
        }
      }
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}
