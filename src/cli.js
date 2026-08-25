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
import { startWatch } from './watch.js';
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
  deskuptime watch <url> [--interval 300]  Monitor in background (free: up to 3 URLs)
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
  $(pkg.bin?.deskuptime ? '• Installed as: deskuptime' : '• Run via: npx deskuptime')

PRO FEATURES (license key):
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

  console.log(`🔍 Checking ${validUrls.length} URL(s)...\n`);

  const results = await checkUrls(validUrls);

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

  process.exit(0);
}

// ── Watch (background monitoring) ──
if (command === 'watch') {
  const raw = args.slice(1);
  const intervalArg = raw.indexOf('--interval');
  const interval = intervalArg !== -1 ? parseInt(raw[intervalArg + 1], 10) : 300;
  const urls = raw.filter((a, i) => !a.startsWith('--') && !(intervalArg !== -1 && i === intervalArg + 1));

  if (urls.length === 0 && !existsSync(join(process.env.HOME || '', '.deskuptime', 'state.json'))) {
    console.error('❌ Error: at least one URL required');
    console.error('Usage: deskuptime watch <url> [--interval 300]');
    console.error('       deskuptime watch            (resume previously monitored URLs)');
    process.exit(1);
  }

  await startWatch(urls, { interval });
}

// ── Unknown command ──
console.error(`Unknown command: "${command}"`);
console.error('Run "deskuptime --help" for usage.');
process.exit(1);