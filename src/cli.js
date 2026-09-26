#!/usr/bin/env node

/**
 * deskuptime CLI — run website checks from the terminal
 *
 * Usage:
 *   deskuptime check <url> [url2 url3 ...]
 *   deskuptime headers <url>          Redirect chain + security headers
 *   deskuptime watch <url> [--interval 300] [--webhook URL]  Monitor URLs
 *   deskuptime --version
 *   deskuptime --help
 */

import { checkUrls, summarize } from './engine.js';
import { startWatch, runOnce, printStatus, printPass, loadState, saveState, freeLimitMessage, isPro } from './watch.js';
import { buildReport, renderReportJson, renderReportMarkdown } from './report.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { invalidHttpUrls } from './status.js';
import { safeText } from './display.js';
import { DEFAULT_WINDOW_DAYS, HISTORY_DAYS, loadHistory } from './history.js';
import { FREE, PRODUCT, renderHelpPro } from './features.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const MAX_WATCH_INTERVAL = 2_147_483;

const args = process.argv.slice(2);
const command = args[0];

// ── Help ──
function showHelp() {
  const title = `  deskuptime v${pkg.version} — Website Monitor CLI`;
  const rule = '═'.repeat(title.length);
  console.log(`
╔${rule}╗
║${title}║
╚${rule}╝

USAGE:
  deskuptime check <urls...> [--json] [--timeout ms]  Check one or more URLs (--timeout budgets the whole check)
  deskuptime headers <url>      Redirect chain, HTTPS enforcement + security headers
  deskuptime watch <url> [--interval 300] [--webhook URL]  Monitor in background (free: up to ${FREE.urlLimit} URLs)
  deskuptime watch <url> --once                      Run one monitoring pass and exit
  deskuptime watch --status                         Show status without network checks
  deskuptime report [--title "Client"] [--days 30] [--json]  Client-ready uptime report (Pro)
  deskuptime activate <key>     Unlock Pro with your license key
  deskuptime deactivate         Free this machine's Pro seat (${PRODUCT.machines} machines per license)
  deskuptime status             Show license state (active/cached/unverified/invalid/free) + monitored URLs
  deskuptime --version          Show version
  deskuptime --help             This help

EXAMPLES:
  deskuptime check https://example.com
  deskuptime check https://site1.com https://site2.com
  deskuptime watch https://mystore.com --interval 300
  deskuptime report --title "Acme — uptime September" > acme-september.md
  deskuptime report --days 7 --title "Acme — this week" > acme-week.md

  watch --once exits 0 when all URLs are healthy, 2 when any is DOWN, and 1 for invalid usage.

FEATURES:
  • Uptime check (HTTP status code + response time)
  • SSL certificate validation + expiry countdown
  • Content change detection (SHA-256 hash)
  • JSON output with --json for scripting/CI
  • Zero dependencies — Node 24+, any OS

${renderHelpPro()}
`.trim());
}

// ── Version ──
if (command === '--version' || command === '-v') {
  console.log(`deskuptime v${pkg.version}`);
  process.exit(0);
}

// ── Help ──
if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

if (command === 'check') {
  const rawArgs = args.slice(1);
  const allowedFlags = new Set(['--json', '--timeout']);
  const unknownFlag = rawArgs.find(value => value.startsWith('--') && !allowedFlags.has(value));
  if (unknownFlag) {
    console.error(`❌ Error: Unknown option: ${unknownFlag}`);
    process.exit(1);
  }

  const timeoutArg = args.indexOf('--timeout');
  const timeoutValue = timeoutArg !== -1 ? args[timeoutArg + 1] : null;
  const timeoutMs = timeoutValue == null ? undefined : Number(timeoutValue);
  if (timeoutArg !== -1 && (!timeoutValue || timeoutValue.startsWith('--') || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    console.error('❌ Error: --timeout must be a positive integer');
    process.exit(1);
  }

  const urls = args.slice(1).filter((value, index) =>
    !value.startsWith('--') && index !== timeoutArg
  );

  if (urls.length === 0) {
    console.error('❌ Error: at least one URL required');
    console.error('Usage: deskuptime check <url> [url2 url3 ...]');
    process.exit(1);
  }

  const invalidUrls = invalidHttpUrls(urls);
  if (invalidUrls.length > 0) {
    for (const url of invalidUrls) {
      console.error(`❌ Error: Invalid URL: ${url}`);
    }
    process.exit(1);
  }

  const json = args.includes('--json');
  const results = await checkUrls(urls, { timeoutMs });

  if (json) {
    // Machine-readable output: stdout is pure JSON for piping into jq/CI
    const out = results.map(r => ({
      url: r.url,
      reachable: r.reachable,
      healthy: r.healthy,
      statusCode: r.statusCode,
      responseTimeMs: r.responseTimeMs,
      sslDaysRemaining: r.ssl?.validDays ?? null,
      sslError: r.ssl?.error ?? null,
      contentLength: r.content?.contentLength ?? null,
      contentHash: r.content?.hash ?? null,
      errorType: r.errorType,
      error: r.error,
    }));
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.some(r => !r.healthy) ? 2 : 0;
  } else {
    console.log(`🔍 Checking ${urls.length} URL(s)...\n`);

    for (const result of results) {
      const summary = summarize(result);
      const statusSymbol = result.healthy ? '✅' : '❌';
      const sslEmoji = result.ssl?.validDays <= 14 ? '⚠️' : result.ssl?.validDays > 0 ? '🔒' : result.ssl?.error ? '🔓' : '—';
      const changedEmoji = result.content?.changed === true ? '🔄' : result.content?.changed === false ? '⏸️' : '—';
      const httpStatus = result.statusCode || 'N/A';

      // Everything below except our own labels can be chosen by the site being
      // checked, so it goes through safeText() — see src/display.js.
      console.log(`${statusSymbol} ${safeText(result.url, { max: 0 })}`);
      console.log(`   Status:   ${httpStatus} — ${result.healthy ? 'UP' : 'DOWN'}`);
      console.log(`   Response: ${result.responseTimeMs}ms`);
      console.log(`   ${sslEmoji} SSL:     ${safeText(summary.ssl, { max: 0 })}`);
      if (result.content?.fetched) {
        console.log(`   ${changedEmoji} Content: ${result.content.contentLength.toLocaleString()} bytes`);
      }
      if (result.error) {
        console.log(`   ⚠️  Error:  ${safeText(result.error, { max: 0 })}`);
      }
      console.log('');
    }

    process.exitCode = results.some(r => !r.healthy) ? 2 : 0;
  }
}

// ── Headers (redirect chain + security headers) ──
if (command === 'headers') {
  const url = args[1];
  if (!url) {
    console.error('❌ Error: a URL is required');
    console.error('Usage: deskuptime headers <url> [--json]');
    process.exit(1);
  }
  const invalidUrls = invalidHttpUrls([url]);
  if (invalidUrls.length > 0) {
    console.error(`❌ Error: Invalid URL: ${url}`);
    process.exit(1);
  }

  const rawArgs = args.slice(2);
  const allowedFlags = new Set(['--json', '--timeout']);
  const unknownFlag = rawArgs.find(value => value.startsWith('--') && !allowedFlags.has(value));
  if (unknownFlag) {
    console.error(`❌ Error: Unknown option: ${unknownFlag}`);
    process.exit(1);
  }

  const optionTimeoutIndex = rawArgs.indexOf('--timeout');
  const unexpectedArg = rawArgs.find((value, index) => {
    if (value === '--json' || value === '--timeout') return false;
    if (optionTimeoutIndex !== -1 && index === optionTimeoutIndex + 1) return false;
    return true;
  });
  if (unexpectedArg) {
    const label = unexpectedArg.startsWith('-') ? 'Unknown option' : 'Unexpected argument';
    console.error(`❌ Error: ${label}: ${unexpectedArg}`);
    process.exit(1);
  }

  const timeoutArg = args.indexOf('--timeout');
  const timeoutValue = timeoutArg !== -1 ? args[timeoutArg + 1] : null;
  const timeoutMs = timeoutValue == null ? undefined : Number(timeoutValue);
  if (timeoutArg !== -1 && (!timeoutValue || timeoutValue.startsWith('--') || !Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    console.error('❌ Error: --timeout must be a positive integer');
    process.exit(1);
  }

  const { checkHeaders } = await import('./checkers/headers.js');
  const r = await checkHeaders(url, 10, { timeoutMs });

  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.healthy) process.exitCode = 2;
  } else if (r.error) {
    console.log(`🧭 ${safeText(url, { max: 0 })}`);
    console.log(`   Final: ${safeText(r.finalUrl, { max: 0 })} (${r.statusCode || 'n/a'})`);
    console.log(`   ⚠️  Error: ${safeText(r.error, { max: 0 })}`);
    process.exitCode = 2;
  } else {
  console.log(`🧭 ${safeText(url, { max: 0 })}`);
  for (const s of r.steps) {
    console.log(`   ${s.status} → ${safeText(s.location, { max: 0 })}`);
  }
  console.log(`   Final: ${safeText(r.finalUrl, { max: 0 })} (${r.statusCode || 'n/a'})${r.redirected ? ' — redirected' : ''}`);
  if (r.startedHttp) {
    console.log(`   HTTPS forced: ${r.forcesHttps ? '✅ yes' : '❌ no — site served over plain HTTP'}`);
  }
  if (r.poweredBy) {
    console.log(`   ⚠️  X-Powered-By exposed: ${safeText(r.poweredBy, { max: 0 })}`);
  }
  const missing = Object.entries(r.security).filter(([, v]) => !v).map(([k]) => k);
  const present = Object.entries(r.security).filter(([, v]) => v);
  for (const [k, v] of present) {
    // max 60 is the historical cap and is kept, so a normal header prints as before.
    console.log(`   ✅ ${k}: ${safeText(v)}`);
  }
  for (const k of missing) {
    console.log(`   ⬜ missing: ${k}`);
  }
  }
}

// ── Activate (Pro license) ──
if (command === 'activate') {
  const key = args[1];
  if (!key) {
    const { BUY_URL } = await import('./license.js');
    console.error('Usage: deskuptime activate <license-key>');
    console.error(`Buy a license at ${BUY_URL}`);
    process.exit(1);
  }
  console.log('🔑 Activating license...');
  const { activateLicense, LICENSE_STATUS } = await import('./license.js');
  const res = await activateLicense(key);
  // No process.exit() after fetch — see the note at "Unknown command" below.
  if (!res.valid) {
    console.error(`❌ Activation failed: ${res.error}`);
    if (res.transient) console.error('   Nothing was stored. Pro on this machine is unchanged — try again shortly.');
    process.exitCode = 1;
  } else {
    const state = loadState();
    state.license = { key: res.key, instance: res.deviceId, plan: res.meta.plan, status: LICENSE_STATUS.ACTIVE, validatedAt: new Date().toISOString() };
    saveState(state);
    console.log(`✅ Pro activated${res.meta.devicesInUse != null ? ' (' + res.meta.devicesInUse + ' of 3 machines in use)' : ''}.`);
    console.log('   Unlimited monitored URLs, intervals down to 30s, desktop notifications.');
  }
}

// ── Deactivate (free this machine's seat) ──
if (command === 'deactivate') {
  const state = loadState();
  if (!state.license?.key) {
    console.log('No Pro license is active on this machine.');
    process.exit(0);
  }
  const { deactivateLicense } = await import('./license.js');
  const res = await deactivateLicense(state.license.key, state.license.instance);
  if (!res.deactivated) {
    // Local state is only dropped when the server confirms the seat is free —
    // otherwise the machine would look free while still occupying a seat.
    console.error(`❌ Deactivation failed: ${res.error}`);
    console.error('   The seat was NOT released and this machine still counts as activated. Try again shortly.');
    process.exitCode = 1;
  } else {
    delete state.license;
    saveState(state);
    console.log('✅ License deactivated on this machine. The seat can now be used elsewhere.');
  }
}

function watchOptionValue(raw, index, name) {
  const value = raw[index + 1];
  if (!value || (name !== '--interval' && value.startsWith('-'))) {
    console.error(`❌ Error: ${name} requires a value`);
    process.exit(1);
  }
  return value;
}

function parseWatchArgs(raw) {
  const options = {
    urls: [],
    interval: 300,
    intervalProvided: false,
    activateKey: null,
    webhookUrl: null,
    once: false,
    status: false,
  };

  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (!value.startsWith('-')) {
      options.urls.push(value);
      continue;
    }

    switch (value) {
      case '--once':
        options.once = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--interval': {
        if (options.intervalProvided) {
          console.error('❌ Error: --interval may only be provided once');
          process.exit(1);
        }
        const interval = Number(watchOptionValue(raw, index, '--interval'));
        if (!Number.isInteger(interval) || interval < 1 || interval > MAX_WATCH_INTERVAL) {
          console.error(`❌ Error: --interval must be between 1 and ${MAX_WATCH_INTERVAL} seconds`);
          process.exit(1);
        }
        options.interval = interval;
        options.intervalProvided = true;
        index++;
        break;
      }
      case '--activate':
        options.activateKey = watchOptionValue(raw, index, '--activate');
        index++;
        break;
      case '--webhook':
        options.webhookUrl = watchOptionValue(raw, index, '--webhook');
        index++;
        break;
      default:
        console.error(`❌ Error: Unknown option: ${value}`);
        process.exit(1);
    }
  }

  if (options.once && options.status) {
    console.error('❌ Error: --once and --status cannot be combined');
    process.exit(1);
  }
  if (options.status && (options.urls.length > 0 || options.activateKey || options.webhookUrl || options.intervalProvided)) {
    console.error('❌ Error: --status does not accept URLs or monitoring options');
    process.exit(1);
  }
  if (options.once && (options.activateKey || options.webhookUrl || options.intervalProvided)) {
    console.error('❌ Error: --once cannot be combined with monitoring options');
    process.exit(1);
  }
  return options;
}

// ── Watch (background monitoring) ──
if (command === 'watch') {
  const options = parseWatchArgs(args.slice(1));
  const invalidUrls = invalidHttpUrls(options.urls);
  if (invalidUrls.length > 0) {
    for (const url of invalidUrls) {
      console.error(`❌ Error: Invalid URL: ${url}`);
    }
    process.exit(1);
  }

  if (options.status) {
    printStatus();
    process.exitCode = 0;
  } else if (options.once) {
    const pass = await runOnce(options.urls, { interval: options.interval });
    if (pass.busy) {
      console.error('❌ Error: another watch pass is already running. Try again after it finishes.');
      process.exitCode = 1;
    } else if (pass.rejected) {
      for (const url of pass.rejected) console.error(`❌ Error: ${freeLimitMessage(url)}`);
      process.exitCode = 1;
    } else if (pass.empty) {
      console.error('❌ Error: at least one URL required');
      console.error('Usage: deskuptime watch <url> --once');
      process.exitCode = 1;
    } else {
      printPass(pass);
      process.exitCode = pass.healthy ? 0 : 2;
    }
  } else {
    const state = loadState();
    if (options.urls.length === 0 && Object.keys(state.urls).length === 0) {
      console.error('❌ Error: at least one URL required');
      console.error('Usage: deskuptime watch <url> [--interval 300]');
      console.error('       deskuptime watch            (resume previously monitored URLs)');
      process.exit(1);
    }
    await startWatch(options.urls, {
      interval: options.interval,
      activateKey: options.activateKey,
      webhookUrl: options.webhookUrl,
    });
  }
}

// ── Status ──
if (command === 'status') {
  const { describeLicense, LICENSE_STATUS, BUY_URL } = await import('./license.js');
  const state = loadState();
  const urls = Object.keys(state.urls);
  const license = describeLicense(state.license);
  if (license.status === LICENSE_STATUS.FREE) {
    console.log('Free tier. Activate Pro: deskuptime activate <license-key>');
  } else if (license.status === LICENSE_STATUS.ACTIVE) {
    console.log(`Pro license: active${license.detail ? `, ${license.detail}` : ''}`);
  } else if (license.status === LICENSE_STATUS.CACHED) {
    console.log(`Pro license: cached/offline — ${license.detail}`);
  } else if (license.status === LICENSE_STATUS.UNVERIFIED) {
    // No buy link here on purpose: this customer already paid. Pointing at the
    // checkout is how people end up buying a second license for a key that works.
    console.log(`Pro license: unverified — ${license.detail}`);
    console.log('  The key is still stored. Re-check it with: deskuptime activate <license-key>');
  } else {
    // The key is kept on disk, so support and a later `activate` still work.
    console.log(`Pro license: invalid — ${license.detail}`);
    console.log('  The key is still stored. Re-check it with: deskuptime activate <license-key>');
    console.log(`  If you have not bought yet: ${BUY_URL}`);
  }
  console.log(`Monitored URLs (${urls.length}):`);
  for (const u of urls) {
    const e = state.urls[u];
    const up = e.wasUp === true ? '✅' : e.wasUp === false ? '❌' : '·';
    console.log(`  ${up} ${safeText(u, { max: 0 })}${e.lastStatus ? ' (' + safeText(e.lastStatus, { max: 0 }) + ')' : ''}${e.sslValidDays != null ? ' — SSL ' + e.sslValidDays + 'd' : ''}`);
  }
  process.exit(0);
}

// ── Report (Pro: a client-ready uptime report) ──
if (command === 'report') {
  const raw = args.slice(1);
  const allowedFlags = new Set(['--json', '--title', '--days']);
  const unknownFlag = raw.find(value => value.startsWith('-') && !allowedFlags.has(value));
  if (unknownFlag) {
    console.error(`❌ Error: Unknown option: ${unknownFlag}`);
    process.exit(1);
  }

  const titleIndex = raw.indexOf('--title');
  let title;
  if (titleIndex !== -1) {
    title = raw[titleIndex + 1];
    if (!title || title.startsWith('-')) {
      console.error('❌ Error: --title requires a value');
      process.exit(1);
    }
  }

  // The window a client report covers. Clamped to what is actually kept on
  // disk, so a bigger number can never look like more history than exists.
  let windowDays = DEFAULT_WINDOW_DAYS;
  const daysIndex = raw.indexOf('--days');
  if (daysIndex !== -1) {
    const value = raw[daysIndex + 1];
    const days = Number(value);
    if (value === undefined || value.startsWith('-') || !Number.isInteger(days) || days < 1 || days > HISTORY_DAYS) {
      console.error(`❌ Error: --days must be a whole number between 1 and ${HISTORY_DAYS} (that is how much history is kept)`);
      process.exit(1);
    }
    windowDays = days;
  }

  const unexpectedArg = raw.find((value, index) => {
    if (value === '--json') return false;
    if (titleIndex !== -1 && (index === titleIndex || index === titleIndex + 1)) return false;
    if (daysIndex !== -1 && (index === daysIndex || index === daysIndex + 1)) return false;
    return true;
  });
  if (unexpectedArg) {
    console.error(`❌ Error: Unexpected argument: ${unexpectedArg}`);
    console.error('Usage: deskuptime report [--title "Client name"] [--days N] [--json]');
    process.exit(1);
  }

  const state = loadState();
  if (!isPro(state)) {
    // A free user gets the same one upgrade path as everywhere else in the CLI,
    // and keeps a working alternative: `watch --once` and `status` still print
    // the same numbers as text. A customer whose key was never rejected is told
    // to re-check the key, not to buy again — see proGateMessage().
    const { proGateMessage } = await import('./license.js');
    const gate = proGateMessage(state.license, 'the client report');
    console.error(`❌ Error: ${gate || 'the client report needs an active Pro license'}`);
    process.exit(1);
  }

  if (Object.keys(state.urls).length === 0) {
    console.error('No monitored URLs. Start with: deskuptime watch <url>');
    process.exit(1);
  }

  // Read-only: no request is made, so the report always describes the last
  // completed pass. Run `deskuptime watch <url> --once` first for a fresh one.
  const report = buildReport(state, { title, history: loadHistory(), windowDays });
  console.log(args.includes('--json') ? renderReportJson(report) : renderReportMarkdown(report));
}

// ── Unknown command ──
// check/headers/activate/deactivate fall through here after setting process.exitCode instead of calling
// process.exit(): exiting while an undici fetch handle is still closing trips a libuv
// assertion on Windows (src/win/async.c), so the event loop must drain naturally.
if (!['check', 'headers', 'activate', 'deactivate', 'watch', 'report'].includes(command)) {
  console.error(`Unknown command: "${command}"`);
  console.error('Run "deskuptime --help" for usage.');
  process.exit(1);
}