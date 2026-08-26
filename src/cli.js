#!/usr/bin/env node

/**
 * deskuptime CLI — run website checks from the terminal
 *
 * Usage:
 *   deskuptime check <url> [url2 url3 ...]
 *   deskuptime watch <url>            (stub for Pro)
 *   deskuptime --version
 *   deskuptime --help
 */

import { checkUrls, summarize } from './engine.js';
import { startWatch, loadState, saveState } from './watch.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const args = process.argv.slice(2);
const command = args[0];

// ── Help ──
function showHelp() {
  console.log(`
╔═══════════════════════════════════════════╗
║  deskuptime v${pkg.version} — Website Monitor CLI        ║
╚═══════════════════════════════════════════╝

USAGE:
  deskuptime check <urls...>    Check one or more URLs
  deskuptime watch <url> [--interval 300] [--webhook URL]  Monitor in background (free: up to 3 URLs)
  deskuptime activate <key>     Unlock Pro with your license key
  deskuptime status             Show license + monitored URLs
  deskuptime --version          Show version
  deskuptime --help             This help

EXAMPLES:
  deskuptime check https://example.com
  deskuptime check https://site1.com https://site2.com
  deskuptime watch https://mystore.com --interval 300

FEATURES:
  • Uptime check (HTTP status code + response time)
  • SSL certificate validation + expiry countdown
  • Content change detection (SHA-256 hash)
  • JSON output with --json for scripting/CI
  • Zero dependencies — Node 18+, any OS

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

// ── Check ──
if (command === 'check') {
  const urls = args.slice(1).filter(a => !a.startsWith('--'));

  if (urls.length === 0) {
    console.error('❌ Error: at least one URL required');
    console.error('Usage: deskuptime check <url> [url2 url3 ...]');
    process.exit(1);
  }

  // Validate URLs
  const validUrls = urls.filter(u => {
    try {
      new URL(u);
      return true;
    } catch {
      console.error(`⚠️  Invalid URL skipped: ${u}`);
      return false;
    }
  });

  if (validUrls.length === 0) {
    process.exit(1);
  }

  const json = args.includes('--json');
  const results = await checkUrls(validUrls);

  if (json) {
    // Machine-readable output: stdout is pure JSON for piping into jq/CI
    const out = results.map(r => ({
      url: r.url,
      reachable: r.reachable,
      statusCode: r.statusCode,
      responseTimeMs: r.responseTimeMs,
      sslDaysRemaining: r.ssl?.validDays ?? null,
      sslError: r.ssl?.error ?? null,
      contentLength: r.content?.contentLength ?? null,
      contentHash: r.content?.hash ?? null,
      error: r.error,
    }));
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.some(r => !r.reachable) ? 2 : 0);
  }

  console.log(`🔍 Checking ${validUrls.length} URL(s)...\n`);

  for (const result of results) {
    const summary = summarize(result);

    const statusSymbol = result.reachable ? '✅' : '❌';
    const sslEmoji = result.ssl?.validDays <= 14 ? '⚠️' : result.ssl?.validDays > 0 ? '🔒' : result.ssl?.error ? '🔓' : '—';
    const changedEmoji = result.content?.changed === true ? '🔄' : result.content?.changed === false ? '⏸️' : '—';

    console.log(`${statusSymbol} ${result.url}`);
    console.log(`   Status:   ${result.statusCode || 'N/A'} ${result.statusCode === 200 ? 'OK' : ''}`);
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

  process.exit(results.some(r => !r.reachable) ? 2 : 0);
}

// ── Activate (Pro license) ──
if (command === 'activate') {
  const key = args[1];
  if (!key) {
    console.error('Usage: deskuptime activate <license-key>');
    console.error('Buy a license at https://hermes-passiv.pages.dev/deskuptime/');
    process.exit(1);
  }
  const { hostname } = await import('os');
  console.log('🔑 Activating license...');
  const { activateLicense } = await import('./license.js');
  const res = await activateLicense(key, `deskuptime-cli-${hostname()}`);
  if (!res.valid) {
    console.error(`❌ Activation failed: ${res.error}`);
    process.exit(1);
  }
  const state = loadState();
  state.license = { key, instance: res.instance || hostname(), email: res.meta?.email || null };
  saveState(state);
  console.log(`✅ Pro activated${res.meta?.email ? ' (' + res.meta.email + ')' : ''}.`);
  console.log('   Unlimited monitored URLs, intervals down to 30s, desktop notifications.');
  process.exit(0);
}

// ── Watch (background monitoring) ──
if (command === 'watch') {
  const raw = args.slice(1);
  const intervalArg = raw.indexOf('--interval');
  let interval = intervalArg !== -1 ? parseInt(raw[intervalArg + 1], 10) : 300;
  const activateArg = raw.indexOf('--activate');
  const activateKey = activateArg !== -1 ? raw[activateArg + 1] : null;
  const hookArg = raw.indexOf('--webhook');
  const webhookUrl = hookArg !== -1 ? raw[hookArg + 1] : null;
  const urls = raw.filter((a, i) =>
    !a.startsWith('--') &&
    !(intervalArg !== -1 && i === intervalArg + 1) &&
    !(activateArg !== -1 && i === activateArg + 1) &&
    !(hookArg !== -1 && i === hookArg + 1)
  );

  if (urls.length === 0 && !existsSync(join(process.env.HOME || '', '.deskuptime', 'state.json'))) {
    console.error('❌ Error: at least one URL required');
    console.error('Usage: deskuptime watch <url> [--interval 300]');
    console.error('       deskuptime watch            (resume previously monitored URLs)');
    process.exit(1);
  }

  await startWatch(urls, { interval, activateKey, webhookUrl });
}

// ── Status ──
if (command === 'status') {
  const state = loadState();
  const urls = Object.keys(state.urls);
  if (state.license?.key) {
    console.log(`Pro license: active${state.license.email ? ' (' + state.license.email + ')' : ''}`);
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
console.error(`Unknown command: "${command}"`);
console.error('Run "deskuptime --help" for usage.');
process.exit(1);