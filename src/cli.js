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
import { startWatch, runOnce, printStatus, printPass, loadState, saveState } from './watch.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { invalidHttpUrls } from './status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const MAX_WATCH_INTERVAL = 2_147_483;

const args = process.argv.slice(2);
const command = args[0];

// ── Help ──
function showHelp() {
  console.log(`
╔═══════════════════════════════════════════╗
║  deskuptime v${pkg.version} — Website Monitor CLI        ║
╚═══════════════════════════════════════════╝

USAGE:
  deskuptime check <urls...> [--json] [--timeout ms]  Check one or more URLs
  deskuptime headers <url>      Redirect chain, HTTPS enforcement + security headers
  deskuptime watch <url> [--interval 300] [--webhook URL]  Monitor in background (free: up to 3 URLs)
  deskuptime watch <url> --once                      Run one monitoring pass and exit
  deskuptime watch --status                         Show status without network checks
  deskuptime activate <key>     Unlock Pro with your license key
  deskuptime deactivate         Free this machine's Pro seat (3 machines per license)
  deskuptime status             Show license + monitored URLs
  deskuptime --version          Show version
  deskuptime --help             This help

EXAMPLES:
  deskuptime check https://example.com
  deskuptime check https://site1.com https://site2.com
  deskuptime watch https://mystore.com --interval 300

  watch --once exits 0 when all URLs are healthy, 2 when any is DOWN, and 1 for invalid usage.

FEATURES:
  • Uptime check (HTTP status code + response time)
  • SSL certificate validation + expiry countdown
  • Content change detection (SHA-256 hash)
  • JSON output with --json for scripting/CI
  • Zero dependencies — Node 24+, any OS

PRO FEATURES (license key):
  • Webhook alerts: deskuptime watch <url> --webhook https://hooks.example.com/xyz
  • Desktop app with system tray + native notifications
  • More than 3 monitored URLs
  • Email/push alerts on status changes
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

      console.log(`${statusSymbol} ${result.url}`);
      console.log(`   Status:   ${httpStatus} — ${result.healthy ? 'UP' : 'DOWN'}`);
      console.log(`   Response: ${result.responseTimeMs}ms`);
      console.log(`   ${sslEmoji} SSL:     ${summary.ssl}`);
      if (result.content?.fetched) {
        console.log(`   ${changedEmoji} Content: ${result.content.contentLength.toLocaleString()} bytes`);
      }
      if (result.error) {
        console.log(`   ⚠️  Error:  ${result.error}`);
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
    console.log(`🧭 ${url}`);
    console.log(`   Final: ${r.finalUrl} (${r.statusCode || 'n/a'})`);
    console.log(`   ⚠️  Error: ${r.error}`);
    process.exitCode = 2;
  } else {
  console.log(`🧭 ${url}`);
  for (const s of r.steps) {
    console.log(`   ${s.status} → ${s.location}`);
  }
  console.log(`   Final: ${r.finalUrl} (${r.statusCode || 'n/a'})${r.redirected ? ' — redirected' : ''}`);
  if (r.startedHttp) {
    console.log(`   HTTPS forced: ${r.forcesHttps ? '✅ yes' : '❌ no — site served over plain HTTP'}`);
  }
  if (r.poweredBy) {
    console.log(`   ⚠️  X-Powered-By exposed: ${r.poweredBy}`);
  }
  const missing = Object.entries(r.security).filter(([, v]) => !v).map(([k]) => k);
  const present = Object.entries(r.security).filter(([, v]) => v);
  for (const [k, v] of present) {
    console.log(`   ✅ ${k}: ${v.length > 60 ? v.slice(0, 57) + '...' : v}`);
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
  const { activateLicense } = await import('./license.js');
  const res = await activateLicense(key);
  // No process.exit() after fetch — see the note at "Unknown command" below.
  if (!res.valid) {
    console.error(`❌ Activation failed: ${res.error}`);
    process.exitCode = 1;
  } else {
    const state = loadState();
    state.license = { key: res.key, instance: res.deviceId, plan: res.meta.plan, validatedAt: new Date().toISOString() };
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
    console.error(`❌ Deactivation failed: ${res.error}`);
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
      for (const url of pass.rejected) console.error(`❌ Error: Free tier monitors 3 URLs. ${url} not added.`);
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
  const state = loadState();
  const urls = Object.keys(state.urls);
  if (state.license?.key) {
    const verified = state.license.validatedAt ? `, last verified ${state.license.validatedAt.slice(0, 10)}` : '';
    console.log(`Pro license: active${verified}`);
  } else {
    console.log('Free tier. Activate Pro: deskuptime activate <license-key>');
  }
  console.log(`Monitored URLs (${urls.length}):`);
  for (const u of urls) {
    const e = state.urls[u];
    const up = e.wasUp === true ? '✅' : e.wasUp === false ? '❌' : '·';
    console.log(`  ${up} ${u}${e.lastStatus ? ' (' + e.lastStatus + ')' : ''}${e.sslValidDays != null ? ' — SSL ' + e.sslValidDays + 'd' : ''}`);
  }
  process.exit(0);
}

// ── Unknown command ──
// check/headers/activate/deactivate fall through here after setting process.exitCode instead of calling
// process.exit(): exiting while an undici fetch handle is still closing trips a libuv
// assertion on Windows (src/win/async.c), so the event loop must drain naturally.
if (!['check', 'headers', 'activate', 'deactivate', 'watch'].includes(command)) {
  console.error(`Unknown command: "${command}"`);
  console.error('Run "deskuptime --help" for usage.');
  process.exit(1);
}