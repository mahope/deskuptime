#!/usr/bin/env node

/**
 * deskuptime CLI — run website checks from the terminal
 *
 * Usage:
 *   deskuptime check <url> [url2 url3 ...]
 *   deskuptime headers <url>          Redirect chain + security headers
 *   deskuptime watch <url> [--interval 300] [--webhook URL]  Monitor URLs
 *   deskuptime unwatch <url> [url2 ...]  Stop monitoring URLs
 *   deskuptime --version
 *   deskuptime --help
 */

import { checkUrls, summarize } from './engine.js';
import { startWatch, runOnce, printStatus, printPass, loadState, readStateFile, saveState, freeLimitMessage, isPro, unwatchUrls, getStateFile, stateWriteErrorMessage, stateReadErrorMessage } from './watch.js';
import { buildReport, renderReportJson, renderReportMarkdown } from './report.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { invalidHttpUrls, invalidUrlMessage, partitionUsableUrls, readCertCoverage, readCertIdentity, readCertRotation, readChain, readContentComparison, readContentState, readDisclosure, readEntry, readHeaderSource, readRedirectTarget, readSecurityHeaders, readSslIssuer, readSslState, readSslTls, contentSkipNote, unusableUrlNote, withoutCredentials, CERT_VERDICT, CONTENT_VERDICT, SECURITY_HEADER, STALE_AFTER_DAYS } from './status.js';
import { formatMs, machinesInUse, safeText } from './display.js';
import { DEFAULT_WINDOW_DAYS, HISTORY_DAYS, historyReadErrorMessage, readHistoryFile } from './history.js';
import { FREE, PRODUCT, proExtras, renderHelpPro } from './features.js';

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
  deskuptime unwatch <url> [url2 ...]  Stop monitoring URLs and free the slot
  deskuptime watch --status                         Saved status, no network calls (marks a pass older than ${STALE_AFTER_DAYS} d as stale)
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
      console.error(`❌ Error: ${invalidUrlMessage(url)}`);
    }
    process.exit(1);
  }

  const json = args.includes('--json');
  // What each site was last read as, so `check` can compare instead of only
  // measuring. Read-only, and measured to be read-only before it was added: this
  // command does not write `state.json`, and it must not start — a one-off check
  // that quietly became a writer is the change P1-43 spent an iteration undoing
  // for `unwatch`. A site the user never watched, or an unreadable state file,
  // simply has no baseline, and the line says so.
  const stored = readStateFile().state;
  const contentHashes = new Map();
  const baselineReadAt = new Map();
  const baselineCerts = new Map();
  for (const url of urls) {
    const entry = stored.urls[url];
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.lastHash === 'string' && entry.lastHash !== '') contentHashes.set(url, entry.lastHash);
    if (typeof entry.lastContentReadAt === 'string' && entry.lastContentReadAt !== '') baselineReadAt.set(url, entry.lastContentReadAt);
    if (typeof entry.lastCertFingerprint === 'string' && entry.lastCertFingerprint !== '') baselineCerts.set(url, { fingerprint: entry.lastCertFingerprint, seenAt: entry.lastCertSeenAt ?? null });
  }
  const results = await checkUrls(urls, { timeoutMs, contentHashes });

  // The one owner of the comparison, asked once per result so the JSON and the
  // terminal line cannot be built from two different readings of the same fields.
  const contentVerdict = r => readContentComparison({
    changed: r.content?.changed ?? null,
    readAt: baselineReadAt.get(r.url) ?? null,
  });

  // The same for the certificate: the one owner of the rotation verdict, asked
  // once per result, so `check`'s line and its JSON cannot disagree.
  const certRotation = r => {
    const baseline = baselineCerts.get(r.url) ?? null;
    return readCertRotation({
      fingerprint: readCertIdentity(r.ssl)?.fingerprint ?? null,
      baselineFingerprint: baseline?.fingerprint ?? null,
      seenAt: baseline?.seenAt ?? null,
    });
  };

  if (json) {
    // Machine-readable output: stdout is pure JSON for piping into jq/CI
    const out = results.map(r => {
      const content = readContentState(r.content);
      const redirect = readRedirectTarget({ url: r.url, finalUrl: r.finalUrl });
      const ssl = readSslState({
        days: r.ssl?.validDays,
        expired: r.ssl?.isExpired,
        expiredDays: r.ssl?.expiredDays,
      });
      const tls = readSslTls(r.ssl);
      const coverage = readCertCoverage(r.ssl, r.url);
      return {
        url: r.url,
        reachable: r.reachable,
        healthy: r.healthy,
        statusCode: r.statusCode,
        responseTimeMs: r.responseTimeMs,
        // Where the response actually came from. The engine measured this on
        // every check since P0-3 and no surface could read it, so a URL that
        // redirects to another host was reported as a plain 200 — the same UP
        // for a parked domain, a hijacked domain and a typo. `offHostRedirect`
        // is the sentence the JSON could not say; `finalUrl` is the raw fact.
        // Both additive, so nothing that reads the old fields changes.
        finalUrl: redirect.finalUrl,
        offHostRedirect: redirect.offHost,
        sslDaysRemaining: r.ssl?.validDays ?? null,
        sslExpired: r.ssl?.isExpired ?? false,
        sslExpiredDays: r.ssl?.expiredDays ?? null,
        // Asked of the one owner rather than re-derived here. This was
        // `isSslExpiringSoon(r.ssl?.validDays) && r.ssl?.isExpired !== true` — a
        // third copy of the renewal-window rule beside `summarize()`'s, and it
        // agreed only because the checker happens to round the day count. A
        // lapsed certificate must never read as "renew soon" in either shape.
        //
        // `null` where no certificate was read: `false` claimed the certificate
        // had been measured and was fine, for a plain-HTTP site, an unreachable
        // one, or a scheme written in capitals. `sslChecked` says it outright.
        sslExpiringSoon: ssl.expiringSoon,
        sslChecked: ssl.measured,
        sslError: r.ssl?.error ?? null,
        // Who signed the certificate, from the one owner. The checker measured
        // this on every SSL check and no consumer could read it, while the
        // matrix — the source of truth behind the README table, `--help` and the
        // npm description — promises "issuer" in both tiers. `null` means no
        // certificate was read, exactly like `sslChecked: false` above, so a
        // plain-HTTP or unreachable URL is never read as "issued by nobody".
        sslIssuer: readSslIssuer(r.ssl),
        // The TLS version and cipher this connection really negotiated, from the
        // one owner. The checker has measured both since P0-3 and no surface could
        // read them, while a security questionnaire about a customer's site asks
        // for exactly these two. `null` per field means the handshake reported
        // nothing for that one — never an empty string, which would read as "we
        // looked and there was none".
        sslProtocol: tls.protocol,
        sslCipher: tls.cipher,
        // Whether the certificate covers the host we asked about, and every name
        // it does cover, from the one owner. The checker has read
        // `subjectaltname` on every SSL check since P0-3 and no surface could
        // read it, while the handshake deliberately accepts a wrong
        // certificate — so a client whose domain is parked behind someone
        // else's certificate read as a healthy site with a valid certificate.
        // `null` where there is nothing to judge: no certificate was read, or
        // the certificate names no hosts at all (an old certificate, whose
        // verdict belongs to a browser).
        sslCoversHost: coverage.coversHost,
        sslCertNames: coverage.names,
        // The content facts, from the one owner. `contentLength` was the byte
        // count our own reader had reached when it gave up on an oversized page
        // — a number no server sent, and a different one on every run — so it
        // is null unless it describes the page, and `contentChecked` /
        // `contentSkipped` say why there is no hash.
        contentChecked: content.measured,
        contentSkipped: content.skipped,
        contentLength: content.length,
        contentHash: r.content?.hash ?? null,
        // The verdict the comparison actually reached, and the reading it was
        // reached against. Both additive. Before this, `check` compared with
        // nothing and `contentHash` was the only content fact a script could
        // read — so a CI job holding two of these had to diff the hashes itself
        // and had no way to ask how old the one it diffed against was. `null`
        // for `contentChanged` means "no reading to compare with", not `false`.
        contentChanged: contentVerdict(r).compared ? contentVerdict(r).verdict === CONTENT_VERDICT.CHANGED : null,
        contentBaselineReadAt: baselineReadAt.get(r.url) ?? null,
        // The certificate's own identity, and whether this is still the one the
        // watch loop last saw. `sslIssuer` says who issued it, `sslCoversHost`
        // says whether it covers the host, and neither says whether it is *the
        // same one*: a domain handed to a new owner answers 200 with a valid
        // certificate from a different authority, and the two fields above look
        // healthy. `certRotated` is `null` — not `false` — when there is no
        // stored certificate to compare with, which is every site the user has
        // never watched.
        certSerial: readCertIdentity(r.ssl)?.serial ?? null,
        certFingerprint: readCertIdentity(r.ssl)?.fingerprint ?? null,
        certRotated: certRotation(r).compared ? certRotation(r).verdict === CERT_VERDICT.ROTATED : null,
        certBaselineSeenAt: baselineCerts.get(r.url)?.seenAt ?? null,
        errorType: r.errorType,
        error: r.error,
      };
    });
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = out.some(r => !r.healthy) ? 2 : 0;
  } else {
    console.log(`🔍 Checking ${urls.length} URL(s)...\n`);

    for (const result of results) {
      const summary = summarize(result);
      const content = readContentState(result.content);
      const identity = readCertIdentity(result.ssl);
      const redirect = readRedirectTarget({ url: result.url, finalUrl: result.finalUrl });
      const statusSymbol = result.healthy ? '✅' : '❌';
      const sslEmoji = summary.sslIcon;
      // The icon and the sentence come from the one owner, so the two cannot
      // disagree. Before this, the icons were read off `content.changed` here and
      // the sentence did not exist: both verdict branches were unreachable, and
      // the `—` that stood in for them is the same glyph `— SSL: N/A` uses one
      // line up for "no certificate was read".
      const contentVerdictForResult = contentVerdict(result);
      const changedEmoji = contentVerdictForResult.verdict === CONTENT_VERDICT.CHANGED
        ? '🔄'
        : contentVerdictForResult.verdict === CONTENT_VERDICT.UNCHANGED ? '⏸️' : '—';
      const httpStatus = result.statusCode || 'N/A';

      // Everything below except our own labels can be chosen by the site being
      // checked, so it goes through safeText() — see src/display.js.
      console.log(`${statusSymbol} ${safeText(result.url, { max: 0 })}`);
      console.log(`   Status:   ${httpStatus} — ${result.healthy ? 'UP' : 'DOWN'}`);
      // A 200 is a claim about whoever answered, and the answer is not always the
      // URL that was asked. Named here, on the free surface that decides the exit
      // code, so "UP" can no longer mean "somebody answered 200".
      if (redirect.offHost) {
        console.log(`   ⚠️  ${safeText(redirect.note, { max: 0 })}`);
      }
      console.log(`   Response: ${formatMs(result.responseTimeMs)}`);
      console.log(`   ${sslEmoji} SSL:     ${safeText(summary.ssl, { max: 0 })}`);
      // The authority behind the same certificate, on the surface that decides
      // the exit code. The checker has measured it since P0-3 and the matrix has
      // promised it in both tiers, but `check` could not answer the first
      // question an agency is asked about a customer's site. A certificate
      // authority is chosen by whoever issued the certificate, so it goes
      // through safeText like every other value on these lines.
      if (summary.sslIssuer) {
        console.log(`   🏷️ Issuer: ${safeText(summary.sslIssuer, { max: 0 })}`);
      }
      if (summary.sslCoverage.note) {
        // Does the certificate cover the host we asked about? The checker has
        // measured the names on every SSL check and the handshake accepts a
        // wrong certificate on purpose, so a parked or hijacked domain reads as
        // a healthy site with a valid certificate. Silent when there is nothing
        // to judge — no certificate, or one that names no hosts. The names come
        // from the certificate, so the line goes through safeText like the rest.
        console.log(`   ${summary.sslCoverage.coversHost ? '📜' : '⚠️ '} ${safeText(summary.sslCoverage.note, { max: 0 })}`);
      }
      // What the connection really negotiated. The checker has measured both
      // since P0-3 and no surface could read them, so a bureau could not answer
      // the first two questions a security questionnaire asks about a customer's
      // site. Only the half that was measured is printed: a handshake that
      // reported a version without a cipher suite does not get a blank to stand
      // in for the missing one. Both values are the server's, so the line goes
      // through safeText like the issuer above.
      const tlsLine = [summary.sslTls.protocol, summary.sslTls.cipher].filter(Boolean).join(' — ');
      if (tlsLine) {
        console.log(`   🔐 TLS: ${safeText(tlsLine, { max: 0 })}`);
      }
      // Is this still the customer's certificate? The checker has measured the
      // serial number and the certificate hash since P0-3 and nothing could read
      // them, so the question "the domain answers 200, is it still *mine*?" had
      // no answer on any surface. It is asked against the certificate the watch
      // loop last stored, never against `check`'s own — this command stays
      // read-only — and the sentence names how old that stored certificate is,
      // because "the same certificate" is true of two readings and says nothing
      // about the span between them. Owner's sentence, and the values it is
      // built from are the certificate's, so the serial goes through safeText.
      if (identity) {
        const rotation = certRotation(result);
        const rotationEmoji = rotation.verdict === CERT_VERDICT.ROTATED
          ? '🔑'
          : rotation.verdict === CERT_VERDICT.SAME ? '⏸️' : '—';
        const serialText = identity.serial ? ` — serial ${identity.serial.slice(0, 12)}…` : '';
        console.log(`   ${rotationEmoji} Cert:    ${safeText(rotation.note + serialText, { max: 0 })}`);
      }
      if (content.measured) {
        const bytes = content.length === null ? 'size unknown' : `${content.length.toLocaleString('en-US')} bytes`;
        // The owner always speaks, verdict or not. A silent `—` is what made this
        // invisible: the identical glyph one line up (`— SSL: N/A`) means "no
        // certificate was read", so the old line could not say whether the page
        // had been compared with anything. Measured 2026-09-27, where a stored
        // `lastHash` that matched exactly and one that was deliberately wrong
        // both printed `— Content: 89 bytes`.
        console.log(`   ${changedEmoji} Content: ${bytes} — ${contentVerdictForResult.note}`);
      } else if (content.skipped) {
        // A page we declined to read used to print no Content line at all, so
        // "we deliberately did not look" was indistinguishable from "nothing to
        // report" — and the checker had written the reason down before dropping
        // it. Naming the skip is what makes the absent hash honest.
        console.log(`   ⏭️  Content: ${contentSkipNote(content)}`);
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
    console.error(`❌ Error: ${invalidUrlMessage(url)}`);
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

  // One reading of the walk, asked once and handed to both surfaces: the terminal
  // prints from it, and `--json` publishes its verdict. The JSON was the only
  // surface that could lie, because a site that never answered has no security
  // reading to print — five `null` headers look exactly like a site that is
  // missing all five, and a bureau pipes this output straight into a client's
  // report. `securityChecked` is the sentence the JSON could not say.
  const chain = readChain({ stopReason: r.stopReason, statusCode: r.statusCode, steps: r.steps });
  // Whose response the five headers and the two stack fields came from. A walk
  // that left the host read them off the *answering* host, so a parked or
  // hijacked client domain reported the stranger's HSTS and the stranger's
  // `X-Powered-By` as findings about the client, in a sheet byte-identical to
  // the one for the stranger itself (measured 2026-09-28 — see
  // `readHeaderSource`). The site's own first response is the only reading that
  // belongs to the site, so a crossed walk reads that instead. A redirect inside
  // one host keeps the final reading: same site, same answer.
  const source = readHeaderSource({ url, finalUrl: chain.measured ? r.finalUrl : null, measured: chain.measured });
  const reading = source.crossed && r.ownReading ? r.ownReading : { security: r.security, server: r.server, poweredBy: r.poweredBy };
  // Same deal for the five headers: one reading, asked once, and both surfaces
  // read it. The terminal could not say "sent with no value" and the JSON could
  // not either, because an empty value had been collapsed into `null` — the very
  // value a header that never arrived has.
  const security = readSecurityHeaders(reading.security);
  // And the two fields that say what a site is built on, read the same way: one
  // reading, asked once. `X-Powered-By exposed` is a warning a bureau puts in a
  // client's report, and an empty value used to make it vanish — the site sent
  // the header and the tool said it sent nothing.
  const disclosure = readDisclosure({ server: reading.server, poweredBy: reading.poweredBy });
  // And the one fact the walk itself produced: did *another host* answer? `headers`
  // is the only surface that follows the chain by hand, and it is the one surface
  // that never asked the owner of that question — measured 2026-09-28, a site
  // 301ing to a parked page on another host printed `Final: … — redirected` and
  // exited 0, while `check` on the same URL named the host change. One reading,
  // asked once, both surfaces, and the same field name `check --json` publishes,
  // so one rule answers it for a bureau's script.
  //
  // `chain.measured` is the bar the five security headers are held to, and it is
  // the owner's own rule for an unmeasurable reading: a host that never answered
  // cannot be said to have answered at all. A chain we declined to follow has a
  // `finalUrl` — the last address we *asked* — so passing it would claim a
  // crossing nobody saw.
  const redirect = readRedirectTarget({ url, finalUrl: chain.measured ? r.finalUrl : null });

  if (args.includes('--json')) {
    // `headersFrom` is the sentence the JSON could not say about *whose* sheet
    // this is. A script compares it with the host it asked; it differs exactly
    // when another host answered, and it is `null` when there is no reading at
    // all. Positive, not a boolean, so it is usable without knowing the rule.
    //
    // The three published fields are the *chosen* reading, not whatever the last
    // response carried — otherwise this branch would keep shipping the
    // stranger's `security` next to a `headersFrom` naming the client, which is
    // the same lie one field over. `ownReading` is the walk's internal bookkeeping
    // and is dropped: the two readings must not both be in the document.
    const { ownReading, ...rest } = r;
    console.log(JSON.stringify({
      ...rest,
      server: reading.server,
      poweredBy: reading.poweredBy,
      security: reading.security,
      offHostRedirect: redirect.offHost,
      headersFrom: source.host,
      securityChecked: chain.measured,
      securityEmpty: security.empty,
      disclosureEmpty: disclosure.empty,
    }, null, 2));
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
  if (chain.note) {
    console.log(`   ⚠️  ${chain.note}`);
  }
  // A chain that was abandoned with a redirect still pending has no final URL,
  // and printing the last hop as one is what told a bureau that a site missing
  // all five security headers was in fact missing none of them — the reading
  // came off a 301. `—` and the reason are honest; a made-up "Final" is not.
  const finalPart = chain.finalUrlNote
    || `${safeText(r.finalUrl, { max: 0 })} (${r.statusCode || 'n/a'})${r.redirected ? ' — redirected' : ''}`;
  console.log(`   Final: ${finalPart}`);
  // The owner's sentence, not a fourth description of the same fact: `check`,
  // both lists, the report row and the alert line all print this one (P1-26/27).
  // A redirect is still not a failure, so the exit code and the verdict stay.
  if (redirect.offHost) {
    console.log(`   ⚠️  ${safeText(redirect.note, { max: 0 })}`);
  }
  if (source.note) {
    console.log(`   ⚠️  ${safeText(source.note, { max: 0 })}`);
  }
  if (!chain.measured) {
    console.log(`   ⬜ ${chain.securityNote}`);
  } else {
    if (r.startedHttp) {
      console.log(`   HTTPS forced: ${r.forcesHttps ? '✅ yes' : '❌ no — site served over plain HTTP'}`);
    }
    if (disclosure.poweredBy.state === SECURITY_HEADER.PRESENT) {
      console.log(`   ⚠️  X-Powered-By exposed: ${safeText(disclosure.poweredBy.value, { max: 0 })}`);
    } else if (disclosure.poweredBy.state === SECURITY_HEADER.EMPTY) {
      // Sent, and naming nothing. A smaller finding than a version string, and
      // not the same as a site that does not send it: the site publishes the
      // marker, so a bureau can say so instead of guessing.
      console.log('   ⚠️  X-Powered-By sent with no value — the site sends the header, but it names no stack');
    }
    const missing = security.absent;
    for (const [k, v] of security.present) {
      // max 60 is the historical cap and is kept, so a normal header prints as before.
      console.log(`   ✅ ${k}: ${safeText(v)}`);
    }
    for (const k of security.empty) {
      // The header is there and does nothing, which is not the same as a header
      // the site never sent — and not a pass either. Its own line, saying so.
      console.log(`   ⚠️  sent with no value: ${k}`);
    }
    for (const k of missing) {
      console.log(`   ⬜ missing: ${k}`);
    }
  }
  // Same rule as `--json` and as `check`: a verdict the tool could not reach is
  // not a pass. Before this, `headers` on a redirect loop printed a clean sheet
  // and exited 0 while `check` on the same URL called it DOWN and exited 2.
  if (!r.healthy) process.exitCode = 2;
  }
}

// ── Activate (Pro license) ──
if (command === 'activate') {
  // Before the key is even read, and before the server is called: activating
  // takes a seat on the server, and a state file we cannot read is a file we
  // cannot write the key into. Doing it anyway costs the customer a seat and
  // then loses the key that seat belongs to.
  const unreadableAtActivate = readStateFile().unreadable;
  if (unreadableAtActivate) {
    console.error(`❌ Error: ${stateReadErrorMessage(unreadableAtActivate, unreadableAtActivate.stateFile)}`);
    process.exit(1);
  }
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
    // The one failure that is not a server fault and not a bad key: the license
    // is fine, this machine is simply the (N+1)th. The server's sentence says
    // "deactivate another machine" without naming the command or the number of
    // seats, so a customer who bought three machines and is adding a fourth has
    // nothing to act on and no way to tell whether a seat is really taken.
    if (res.status === 409) {
      console.error(`   ${PRODUCT.proName} covers ${PRODUCT.machines} machines. To free one, run "deskuptime deactivate" on a machine that no longer needs Pro,`);
      console.error('   then run this command again here with the same license key.');
    }
    process.exitCode = 1;
  } else {
    const state = loadState();
    state.license = {
      key: res.key,
      instance: res.deviceId,
      plan: res.meta.plan,
      status: LICENSE_STATUS.ACTIVE,
      validatedAt: new Date().toISOString(),
      // The server's own answers about the license, kept so `status` can show
      // them later instead of only in this line. Both are optional: a server
      // that omits them leaves the record exactly as it was.
      ...(Number.isSafeInteger(res.meta.devicesInUse) && res.meta.devicesInUse >= 0 ? { machinesInUse: res.meta.devicesInUse } : {}),
      ...(typeof res.meta.expiresAt === 'string' && Number.isFinite(Date.parse(res.meta.expiresAt)) ? { expiresAt: res.meta.expiresAt } : {}),
    };
    saveState(state);
    console.log(`✅ Pro activated (${machinesInUse(res.meta.devicesInUse)} of ${PRODUCT.machines} machines in use).`);
    console.log('   Unlimited monitored URLs, intervals down to 30s, desktop notifications.');
  }
}

// ── Deactivate (free this machine's seat) ──
if (command === 'deactivate') {
  // Same gate as `activate`, for the same reason: the receipt is written to this
  // file, and a released seat nobody can store is a seat released for nothing.
  const unreadableAtDeactivate = readStateFile().unreadable;
  if (unreadableAtDeactivate) {
    console.error(`❌ Error: ${stateReadErrorMessage(unreadableAtDeactivate, unreadableAtDeactivate.stateFile)}`);
    process.exit(1);
  }
  const state = loadState();
  const { deactivateLicense, describeLicense, releaseReceipt, LICENSE_STATUS } = await import('./license.js');
  if (!state.license?.key) {
    // A released seat is not an absent license: the machine gave its seat up on
    // purpose, so it must not be answered as if it had never bought anything.
    const released = describeLicense(state.license);
    if (released.status === LICENSE_STATUS.RELEASED) {
      console.log(`Pro license: ${released.detail}.`);
      console.log('  To use Pro on this machine again, run: deskuptime activate <license-key>');
    } else {
      console.log('No Pro license is active on this machine.');
    }
    process.exit(0);
  }
  const res = await deactivateLicense(state.license.key, state.license.instance);
  if (!res.deactivated) {
    // Local state is only dropped when the server confirms the seat is free —
    // otherwise the machine would look free while still occupying a seat.
    console.error(`❌ Deactivation failed: ${res.error}`);
    console.error('   The seat was NOT released and this machine still counts as activated. Try again shortly.');
    process.exitCode = 1;
  } else {
    // A receipt, not a deleted license: the key is gone (it was released), but
    // the machine remembers that it is a paying customer's machine, so no
    // surface here can offer it the checkout again.
    const receipt = releaseReceipt({ plan: state.license.plan, machinesInUse: res.devicesInUse });
    state.license = receipt;
    saveState(state);
    const released = describeLicense(receipt);
    console.log(`✅ License deactivated — ${released.detail}.`);
    console.log('   To use Pro on the new machine, run: deskuptime activate <license-key>');
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
      console.error(`❌ Error: ${invalidUrlMessage(url)}`);
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
    } else if (pass.stateError) {
      // A full disk or a read-only folder, found before a single site was
      // checked. A stack trace naming a lock file is not something the user of
      // a cron job can act on.
      console.error(`❌ Error: ${stateWriteErrorMessage(pass.stateError, getStateFile())}`);
      process.exitCode = 1;
    } else if (pass.rejected?.length) {
      // The sites that fitted were measured, so the pass is printed first: the
      // refusal names only the URLs that did not fit, and a user who saw just
      // that had no way to know whether the other three were being watched (they
      // were not — see runOnce). Exit 2 still means "a site is DOWN", which is
      // the signal a cron job watches for, so it wins over the refusal; exit 1
      // keeps meaning "the command could not do everything it was asked to".
      if (pass.results?.length) printPass(pass);
      for (const url of pass.rejected) console.error(`❌ Error: ${freeLimitMessage(url)}`);
      process.exitCode = pass.results?.length ? (pass.healthy ? 1 : 2) : 1;
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

// ── Unwatch (stop monitoring) ──
if (command === 'unwatch') {
  const rawArgs = args.slice(1);
  const unknownFlag = rawArgs.find(value => value.startsWith('--'));
  if (unknownFlag) {
    console.error(`❌ Error: Unknown option: ${unknownFlag}`);
    process.exit(1);
  }
  if (rawArgs.length === 0) {
    console.error('❌ Error: at least one URL required');
    console.error('Usage: deskuptime unwatch <url> [url2 ...]');
    process.exit(1);
  }
  // A saved key that is not an address is still a key this command has to be
  // able to remove — it is the way out of a state file a script or a half-write
  // left with `kunde.dk` in it, and the alternative is hand-editing the file
  // that also holds the license key. So the address check only rejects an
  // argument that is *not* one of the saved keys: a typo on the command line is
  // still a typo, a broken key in the file is a real row to delete.
  const savedKeys = Object.keys(loadState().urls);
  const invalidUrls = invalidHttpUrls(rawArgs).filter(url => !savedKeys.includes(url));
  if (invalidUrls.length > 0) {
    for (const url of invalidUrls) console.error(`❌ Error: ${invalidUrlMessage(url)}`);
    process.exit(1);
  }
  const result = await unwatchUrls(rawArgs);
  if (result.busy) {
    console.error('❌ Error: another watch pass is already running. Try again after it finishes.');
    process.exitCode = 1;
  } else if (result.stateError) {
    console.error(`❌ Error: ${stateWriteErrorMessage(result.stateError, getStateFile())}`);
    console.error('       Nothing was changed.');
    process.exitCode = 1;
  } else {
    for (const url of result.removed) console.log(`✅ No longer monitoring: ${safeText(url, { max: 0 })}`);
    for (const url of result.missing) console.error(`❌ Error: not monitored: ${safeText(url, { max: 0 })}`);
    if (result.removed.length > 0) {
      console.log(`   ${result.remaining} URL(s) still monitored. Its uptime history is kept (${HISTORY_DAYS} days) — monitoring it again starts the counters from zero.`);
    }
    // Nothing removed means nothing changed, so the caller gets a failure code
    // instead of a green run that removed nothing.
    process.exitCode = result.removed.length > 0 ? 0 : 1;
  }
}

// ── Status ──
if (command === 'status') {
  const { describeLicense, LICENSE_STATUS, BUY_URL } = await import('./license.js');
  const { state, unreadable } = readStateFile();
  if (unreadable) {
    // Read before the license block on purpose. This file holds the key, so an
    // unreadable one is the one state where "Free tier" and the checkout are
    // both wrong: the customer paid, the key is in the file we cannot parse, and
    // the one thing we must not do is sell it to them again (the same rule that
    // keeps `released` and `unverified` off the checkout). Nothing is counted
    // either — "Monitored URLs (0)" would be a claim about a file nobody read.
    console.error(`❌ Error: ${stateReadErrorMessage(unreadable, unreadable.stateFile)}`);
    process.exit(1);
  }
  const urls = Object.keys(state.urls);
  const license = describeLicense(state.license);
  if (license.status === LICENSE_STATUS.RELEASED) {
    // Read before the free tier, because this machine is not one: it gave a
    // paid seat up on purpose. The only thing to do here is activate again.
    console.log(`Pro license: ${license.detail}.`);
    console.log('  Nothing to buy — the license is yours. To use Pro on this machine again: deskuptime activate <license-key>');
  } else if (license.status === LICENSE_STATUS.FREE) {
    // A free user running `status` is asking what they have and what to do next,
    // and the old line dead-ended at `activate <license-key>` — a key they cannot
    // have without buying first. Every other place a free user meets the Pro
    // boundary (--help, README, the 4th URL, `proGateMessage`) points at the
    // checkout, and this is the first command such a user runs.
    console.log(`Free tier. ${PRODUCT.proName} (${PRODUCT.priceLong}, ${PRODUCT.machines} machines) adds ${proExtras()}`);
    console.log(`  Buy: ${BUY_URL}`);
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
  // Same reading as `watch --status` and the client report, so the two lists
  // cannot say different things about the same state file: a stale pass is
  // marked with its age, a certificate inside the warning window is marked, and
  // an unusable `sslValidDays` reads as unknown instead of printing itself.
  for (const u of urls) {
    const e = readEntry(state.urls[u], { url: u });
    const up = e.verdict === 'up' ? '✅' : e.verdict === 'down' ? '❌' : '·';
    const code = e.statusCode === null ? '' : ` (${e.statusCode})`;
    const ssl = e.sslNote ? ` — ${e.sslNote}` : '';
    // A `·` used to be the whole row, so "never monitored" and "the last pass
    // ran but its verdict cannot be read" printed identically. The sentence is
    // the report's, read from readEntry, and it is fixed words plus a checked
    // day count, so it cannot carry anything out of the state file.
    const unknown = e.verdict === 'unknown' ? ` — ${e.unknownNote}` : '';
    const stale = e.staleNote ? ` ⚠️ ${e.staleNote}` : '';
    // The host that answered, read by the same owner `check` and `watch --status`
    // ask. Without it a parked or hijacked domain printed as a plain `✅` here,
    // on the list a user runs to see whether their monitoring works.
    const redirect = e.redirect.label ? ` ⚠️ ${e.redirect.label}` : '';
    // A recorded pass time ahead of this machine's clock, with the owner's
    // sentence. This list does not print timestamps at all, so before this it
    // was silent about a wrong clock while `watch --status` and the client
    // report showed the impossible date. The verdict is untouched.
    const ahead = e.clockAhead ? ` ⚠️ ${e.clockAhead}` : '';
    // The page, read by the same owner the client report asks. Without it a
    // defaced or replaced homepage printed as a plain `✅` here while every
    // uptime number on the row stayed perfect — and this is the free surface,
    // so the paid report was not the only place a customer could meet a silent
    // answer. The title comes from the site itself, so the sentence goes through
    // safeText like every other value on this line.
    const content = e.contentNote
      ? ` ${safeText(e.contentNote, { max: 0 })}`
      : e.contentSize ? ` · ${e.contentSize}` : '';
    // And the certificate, read by the same owner the client report asks. Without
    // it a domain that changed hands answered `✅ (200) — SSL 89d` here — a
    // reissued certificate has *more* days left than the one it replaced, so the
    // row looked healthier than before the change — while the paid report named
    // the same state file's rotation in a line of its own. The sentence is fixed
    // words and a checked day count, so it needs no flattening, and it is empty
    // when no certificate has been replaced.
    const cert = e.certNote ? ` ${e.certNote}` : '';
    // And *who* answers for the name now. The rotation above is the ordinary
    // case — a host reissues every 90 days — and it says only that something
    // changed; the authority is the reading that tells a renewal from a name
    // somebody else now answers for, and the day count argues against noticing
    // it, because the new certificate usually has *more* days left than the one it
    // replaced. Measured 2026-09-27: this list said `🔑 certificate replaced
    // today` and nothing about `Ganske Cloud A/S → Rogue Cert BV`, so the one
    // signal a security questionnaire asks for existed only in the paid report.
    // Both names are the *certificate's* own text — a hijack chooses them — so
    // the sentence is flattened like the page title above it.
    const certIssuer = e.certIssuerNote ? ` ${safeText(e.certIssuerNote, { max: 0 })}` : '';
    // A key we never could check is shown without its credentials, like every
    // other surface: a password in a hand-edited or restored key must not be
    // printed on the list a user reads to see whether monitoring works (P1-45).
    console.log(`  ${up} ${safeText(withoutCredentials(u), { max: 0 })}${code}${ssl}${unknown}${stale}${redirect}${ahead}${content}${cert}${certIssuer}`);
  }
  // A key that is not an address prints above like any other row — as a site
  // whose verdict is merely unknown — although it was never measured and never
  // can be, and a monitoring pass skips it. Named here with the owner's
  // sentence, so this list cannot claim a broken key is a quiet customer site.
  const { usable, unusable } = partitionUsableUrls(urls);
  if (unusable.length > 0) {
    console.log(`⚠️  ${unusableUrlNote(unusable, { checked: usable.length })}`);
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

  const { state, unreadable } = readStateFile();
  if (unreadable) {
    // Before the Pro gate, because the gate would answer for a license it cannot
    // see and hand a customer the checkout for a key that sits in this file.
    console.error(`❌ Error: ${stateReadErrorMessage(unreadable, unreadable.stateFile)}`);
    process.exit(1);
  }
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
  // Read the history the same way the state file is read, and gate on it the
  // same way: an unreadable history would leave every window column saying
  // "no pass in the last 30 d" — a claim about the client's site, in a document
  // the client reads, about data that exists but could not be opened (P1-48).
  const { history: uptimeHistory, unreadable: unreadableHistory } = readHistoryFile();
  if (unreadableHistory) {
    console.error(`❌ Error: ${historyReadErrorMessage(unreadableHistory, unreadableHistory.historyFile)}`);
    process.exit(1);
  }
  const report = buildReport(state, { title, history: uptimeHistory, windowDays });
  console.log(args.includes('--json') ? renderReportJson(report) : renderReportMarkdown(report));
}

// ── Unknown command ──
// check/headers/activate/deactivate fall through here after setting process.exitCode instead of calling
// process.exit(): exiting while an undici fetch handle is still closing trips a libuv
// assertion on Windows (src/win/async.c), so the event loop must drain naturally.
if (!['check', 'headers', 'activate', 'deactivate', 'watch', 'unwatch', 'report'].includes(command)) {
  console.error(`Unknown command: "${command}"`);
  console.error('Run "deskuptime --help" for usage.');
  process.exit(1);
}