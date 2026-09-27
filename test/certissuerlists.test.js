/**
 * P1-65 — the two free lists could not say *who* answered for the customer's name,
 * and a certificate that started answering from a different authority read exactly
 * like a routine renewal.
 *
 * P1-64 made a changed authority visible in the paid client report, and named
 * this as the next surface: `status` and `watch --status` — the two commands
 * anyone actually runs to find out whether their monitoring works. The state file
 * has carried `sslIssuer`, `certIssuerBefore` and `certIssuerChangedAt` since
 * that iteration, so this is a *reading* that was never asked for, not a missing
 * measurement.
 *
 * Measured 2026-09-27, real `runPass`, real state file, real CLI, before any code
 * changed. Two passes over a site that answers 200 in both; the only difference is
 * which certificate — and which authority — answered the second time:
 *
 *   status         ->  ✅ https://kunde.dk/ (200) — SSL 89d · 89 bytes 🔑 certificate replaced today
 *   watch --status ->  ✅ up  https://kunde.dk/ (200, SSL 89d) @ … 🔑 certificate replaced today
 *   rapport        ->  **1 site answers from a certificate authority other than the one …**
 *
 * The rotation was named on all three surfaces; the authority on the one that is
 * sold. Neither free list said `Ganske Cloud A/S`, `Rogue Cert BV` or the word
 * *issuer* at all. And the day count argues against noticing it: a reissued
 * certificate usually has *more* days left than the one it replaced, so a
 * hijacked domain reads as the healthier of the two.
 *
 * `readCertIssuerState` was already the one owner (P1-64); `readEntry` asks it
 * now, beside the rotation and the page, and each list places the sentence. A
 * different authority is not a verdict — moving hosts, or a CA being taken over,
 * produces one for innocent reasons — so no status, exit code or uptime number
 * moves, and a renewal from the *same* authority still says nothing but
 * `🔑 certificate replaced`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getStateFile, runPass } from '../src/watch.js';
import { readEntry } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const SITE = 'https://kunde.dk/';
const OTHER_SITE = 'https://to.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const SHA256 = 'a'.repeat(64);
const NEW_SHA256 = 'b'.repeat(64);
const OLD_AUTHORITY = 'Ganske Cloud A/S';
const NEW_AUTHORITY = 'Rogue Cert BV';
/** The owner's own sentence, so a test never retypes the wording it is testing. */
const CHANGED = `🏢 certificate answers from a different issuer 2 d ago (${OLD_AUTHORITY} → ${NEW_AUTHORITY})`;

function daysAgo(days) {
  return new Date(new Date(BASE).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A site a real pass measured: 200, a certificate, and one known authority. */
function healthy(overrides = {}) {
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: daysAgo(0),
    addedAt: daysAgo(30),
    checks: 100,
    checksUp: 100,
    sslValidDays: 89,
    sslExpired: false,
    lastCertFingerprint: NEW_SHA256,
    certBaselineSeenAt: daysAgo(7),
    sslIssuer: NEW_AUTHORITY,
    ...overrides,
  };
}

/** A site whose certificate now answers from an authority it did not answer from. */
function hijacked(overrides = {}) {
  return healthy({
    lastCertRotatedAt: daysAgo(2),
    certIssuerBefore: OLD_AUTHORITY,
    certIssuerChangedAt: daysAgo(2),
    ...overrides,
  });
}

/** A throwaway HOME with a real state file the CLI will find. */
function homeWith(t, urls) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certissuerlists-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ urls }, null, 2));
  return { home, stateFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

/**
 * A command and its exit code together.
 *
 * `promisify(execFile)` resolves only when the command exits 0, so "it resolved"
 * is the exit-code lock — but a lock nobody can read is a lock nobody trusts.
 */
function runExit(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function strip(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// --------------------------------------------------------------- the owner

test('readEntry læser udstederen med samme ejer som rapporten', () => {
  const now = new Date(BASE);
  const changed = readEntry(hijacked(), { now, url: SITE });
  assert.equal(changed.certIssuer.changed, true);
  assert.equal(changed.certIssuer.issuer, NEW_AUTHORITY, 'hvem der udstedte det der svarer nu');
  assert.equal(changed.certIssuer.previous, OLD_AUTHORITY, 'og hvem der gjorde det før — ellers er påstanden tom');
  assert.equal(changed.certIssuerNote, CHANGED, 'alderen rejser med, og begge navne er med');

  // The case that must stay silent, and it is the common one: a host that
  // reissues every 90 days from the same authority. The row says the certificate
  // was replaced and stops there, or a note that is on nearly every row a year
  // trains the reader to scroll past the one that means something.
  const renewed = readEntry(healthy({ lastCertRotatedAt: daysAgo(2) }), { now, url: SITE });
  assert.equal(renewed.certNote, '🔑 certificate replaced 2 d ago');
  assert.equal(renewed.certIssuer.changed, false);
  assert.equal(renewed.certIssuerNote, '', 'en fornyelse fra samme udsteder siger intet om udstederen');
  assert.equal(renewed.certIssuer.issuer, NEW_AUTHORITY, 'men hvem der udstedte det, er stadig sandt');

  // A first reading establishes the baseline and is not a change — and a site
  // whose certificate was never read has no authority to name at all.
  const baseline = readEntry(healthy({ sslIssuer: OLD_AUTHORITY }), { now, url: SITE });
  assert.equal(baseline.certIssuerNote, '');
  const never = readEntry(healthy({ sslIssuer: null }), { now, url: SITE });
  assert.equal(never.certIssuer.issuer, null);
  assert.equal(never.certIssuerNote, '');

  // A stamp that cannot be placed, and one ahead of this clock: the same two
  // states every other reading owns, and the same two words.
  const unreadable = readEntry(hijacked({ certIssuerChangedAt: 'whenever' }), { now, url: SITE });
  assert.match(unreadable.certIssuerNote, /at an unreadable time/, unreadable.certIssuerNote);
  assert.doesNotMatch(unreadable.certIssuerNote, /today/, 'et uflytbart tidspunkt må ikke alderes til i dag');
  const ahead = readEntry(hijacked({ certIssuerChangedAt: daysAgo(-3) }), { now, url: SITE });
  assert.match(ahead.certIssuerNote, /ahead of this machine's clock/, ahead.certIssuerNote);
  assert.equal(ahead.certIssuer.ageDays, null);
});

test('ejeren på de to lister er readCertIssuerState, ikke en anden læsning', () => {
  // Measured: the marked sentence — the one a row carries — is written in exactly
  // one function, and it writes it in its two forms, the ordinary one and the
  // clock-skew one. A second author is how the report and the lists drifted apart
  // in P1-64, so the count is locked rather than the string.
  const status = strip(readFileSync(join(ROOT, 'src', 'status.js'), 'utf8'));
  assert.equal(
    (status.match(/certificate answers from a different issuer/g) || []).length,
    2,
    'only the owner may write the sentence, once per form',
  );
  assert.match(status, /const certIssuer = readCertIssuerState\(value, \{ now \}\);/, 'readEntry must ask the owner');
  assert.match(status, /certIssuerNote: certIssuer\.note/);

  // The report asks the same owner rather than writing a second wording, so the
  // lock covers every surface that shows the fact — not just the two lists.
  const report = strip(readFileSync(join(ROOT, 'src', 'report.js'), 'utf8'));
  assert.match(report, /readCertIssuerState\(entry, \{ now \}\)/);

  for (const [file, name] of [['cli.js', 'status'], ['watch.js', 'watch --status']]) {
    const source = strip(readFileSync(join(ROOT, 'src', file), 'utf8'));
    assert.doesNotMatch(source, /certificate answers from a different issuer/, `${name} must not build the sentence itself`);
    assert.match(source, /certIssuerNote/, `${name} must place the owner's sentence`);
  }
});

// ------------------------------------------------------------- the two lists

test('begge lister navner den udsteder, der har overtaget', async (t) => {
  const { env } = homeWith(t, { [SITE]: hijacked() });

  const status = await run(process.execPath, [CLI, 'status'], { env });
  assert.ok(status.stdout.includes(CHANGED), `status row: ${status.stdout}`);

  const list = await run(process.execPath, [CLI, 'watch', '--status'], { env });
  assert.ok(list.stdout.includes(CHANGED), `watch --status row: ${list.stdout}`);

  // Both names, because "the issuer changed" without saying from what to what
  // leaves the reader to go and look it up. Locked here rather than trusted.
  for (const [name, stdout] of [['status', status.stdout], ['watch --status', list.stdout]]) {
    assert.ok(stdout.includes(OLD_AUTHORITY), `${name} names the authority it left: ${stdout}`);
    assert.ok(stdout.includes(NEW_AUTHORITY), `${name} names the authority that answers: ${stdout}`);
  }
});

test('en fornyelse fra samme udsteder tier begge lister om udstederen', async (t) => {
  // The most common certificate event there is. Measured on the real CLI, a note
  // here would sit on the row roughly every 90 days per site, and the row it has
  // to be found on is a hijack.
  const { env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: daysAgo(5) }) });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.ok(stdout.includes('🔑 certificate replaced 5 d ago'), `${args.join(' ')}: ${stdout}`);
    assert.doesNotMatch(stdout, /different issuer/, `${args.join(' ')}: ${stdout}`);
    assert.ok(!stdout.includes(NEW_AUTHORITY), `${args.join(' ')} nævner ingen udsteder overhovedet: ${stdout}`);
  }
});

test('et sundt site uden skift tier helt om certifikatet', async (t) => {
  const { env } = homeWith(t, { [SITE]: healthy() });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.doesNotMatch(stdout, /certificate|issuer/i, `${args.join(' ')}: ${stdout}`);
    assert.match(stdout, /kunde\.dk/, stdout);
  }
});

test('to sites, kun ét med en ny udsteder: den anden række forbliver tavs', async (t) => {
  const { env } = homeWith(t, {
    [SITE]: hijacked(),
    [OTHER_SITE]: healthy({ sslIssuer: OLD_AUTHORITY }),
  });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.equal((stdout.match(/different issuer/g) || []).length, 1, `${args.join(' ')}: ${stdout}`);
    assert.equal((stdout.match(/Ganske Cloud A\/S/g) || []).length, 1, `${args.join(' ')}: ${stdout}`);
  }
});

test('listerne og rapporten siger det samme om det samme state-fil', async (t) => {
  // The whole point: one file, one owner, three surfaces. Before this the report
  // named the authority and the two free lists did not, so the fact that
  // separates a renewal from a hijack was only available to a paying customer.
  const entry = hijacked();
  const { env } = homeWith(t, { [SITE]: entry });
  const markdown = renderReportMarkdown(buildReport({ urls: { [SITE]: entry } }, { now: new Date(BASE) }));
  assert.ok(markdown.includes(CHANGED), markdown);

  for (const [name, stdout] of [
    ['status', (await run(process.execPath, [CLI, 'status'], { env })).stdout],
    ['watch --status', (await run(process.execPath, [CLI, 'watch', '--status'], { env })).stdout],
  ]) {
    assert.ok(stdout.includes(CHANGED), `${name}: ${stdout}`);
  }
});

test('et ulæseligt stempel siger det på listerne uden at opfinde en alder', async (t) => {
  const { env } = homeWith(t, { [SITE]: hijacked({ certIssuerChangedAt: 'whenever' }) });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.match(stdout, /different issuer at an unreadable time/, `${args.join(' ')}: ${stdout}`);
    assert.doesNotMatch(stdout, /different issuer today/, 'et uflytbart tidspunkt må ikke alderes til i dag');
  }
});

test('et udsteder-navn er certifikatets egen tekst, og fladens ligesom', async (t) => {
  // The two names in the sentence are chosen by whoever answers for the name — a
  // hijack chooses them, and so does a misconfigured TLS terminator. The lists
  // flatten every other value that comes from a site (the URL, the page title);
  // this one is the newest, so it is measured rather than assumed.
  const ESC = String.fromCharCode(27);
  const hostile = `Evil${ESC}[2J CA`;
  const { env } = homeWith(t, { [SITE]: hijacked({ sslIssuer: hostile }) });
  for (const args of [['status'], ['watch', '--status']]) {
    const { code, stdout } = await runExit(args, env);
    assert.equal(code, 0, `${args.join(' ')}: ${stdout}`);
    // Flattened, not dropped: the name is still readable as `Evil CA`, and the
    // escape sequence is gone — the lists print the sentence *as* it is, they do
    // not repaint the terminal with a name the certificate chose.
    assert.ok(stdout.includes(`(Ganske Cloud A/S → Evil CA)`), `${args.join(' ')}: ${stdout}`);
    assert.ok(!stdout.includes(ESC), `${args.join(' ')} passed an escape byte through: ${JSON.stringify(stdout)}`);
    assert.ok(!stdout.includes('[2J'), `${args.join(' ')} passed the sequence through: ${JSON.stringify(stdout)}`);
  }
});

// ----------------------------------------------------------------- the locks

test('en ny udsteder flytter hverken status, exit-kode eller de øvrige felter', async (t) => {
  // Lock, not a claim: a different authority does not make the certificate
  // invalid for the right name, so nothing on a row may move because of it.
  // `readEntry` is deep-equal apart from the two certificate readings (the
  // hijacked entry also carries a rotation, so all four fields come off), the row
  // keeps its `✅` and its `SSL 89d`, and both commands still exit 0.
  const now = new Date(BASE);
  const quiet = readEntry(healthy(), { now, url: SITE });
  const changed = readEntry(hijacked(), { now, url: SITE });
  const { cert, certNote, certIssuer, certIssuerNote, ...restQuiet } = quiet;
  const { cert: _cert, certNote: _certNote, certIssuer: _issuer, certIssuerNote: _note, ...restChanged } = changed;
  assert.equal(certIssuerNote, '');
  assert.equal(certNote, '');
  assert.deepEqual(restChanged, restQuiet, 'kun de additive felter er nye');
  assert.equal(changed.verdict, 'up');
  assert.equal(changed.sslNote, 'SSL 89d');
  assert.equal(changed.sslMayHaveExpired, false);
  assert.equal(changed.certNote, '🔑 certificate replaced 2 d ago', 'rotationen siges stadig, den forsvinder ikke');

  const { env } = homeWith(t, { [SITE]: hijacked() });
  for (const args of [['status'], ['watch', '--status']]) {
    const { code, stdout } = await runExit(args, env);
    assert.equal(code, 0, `en anden udsteder er ikke et nedet site: ${args.join(' ')}: ${stdout}`);
    assert.match(stdout, /✅.*kunde\.dk.*\(200.*SSL 89d/, stdout);
  }
});

test('et pass skriver stemplet, og listerne læser det samme pass', async (t) => {
  // The measured journey rather than a hand-written file: one authority for two
  // passes, then a certificate replaced by the same authority, then one replaced
  // by another. The state file is read back from disk after each pass, so the
  // lists and the report see the file the pass actually wrote.
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certissuerpass-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  const readings = [
    { fingerprint: SHA256, issuer: { O: OLD_AUTHORITY } },
    { fingerprint: SHA256, issuer: { O: OLD_AUTHORITY } },
    { fingerprint: NEW_SHA256, issuer: { O: OLD_AUTHORITY } },
    { fingerprint: 'c'.repeat(64), issuer: { O: NEW_AUTHORITY } },
  ];
  let call = 0;
  const check = url => {
    const reading = readings[Math.min(call, readings.length - 1)];
    call += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      ssl: {
        validDays: 89,
        isExpired: false,
        serialNumber: '01EE',
        fingerprint256: reading.fingerprint,
        subject: { CN: 'kunde.dk' },
        issuer: reading.issuer,
      },
      content: { fetched: true, contentLength: 89, hash: 'h1', changed: false, title: 'Kunde' },
    };
  };

  const reads = [];
  for (let i = 0; i < readings.length; i += 1) {
    const onDisk = existsSyncSafe(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { urls: { [SITE]: {} } };
    await runPass(onDisk, { stateFile, check, returnResults: true });
    reads.push(JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE]);
  }
  assert.equal(reads[0].sslIssuer, OLD_AUTHORITY, 'en baseline er et navn, ikke et skift');
  assert.equal(reads[0].certIssuerChangedAt, undefined);
  assert.equal(reads[1].certIssuerChangedAt, undefined, 'det samme certifikat fra samme udsteder er ikke et skift');
  assert.equal(reads[1].lastCertRotatedAt, undefined);
  assert.equal(reads[2].certIssuerChangedAt, undefined, 'en fornyelse fra samme udsteder er ikke et skift');
  assert.equal(typeof reads[2].lastCertRotatedAt, 'string', 'men rotationen er skrevet');
  assert.equal(typeof reads[3].certIssuerChangedAt, 'string', 'en anden udsteder skriver hvornår');
  assert.equal(reads[3].certIssuerBefore, OLD_AUTHORITY, 'og hvilken den forlod');

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const status = await run(process.execPath, [CLI, 'status'], { env });
  const list = await run(process.execPath, [CLI, 'watch', '--status'], { env });
  for (const [name, stdout] of [['status', status.stdout], ['watch --status', list.stdout]]) {
    assert.match(stdout, /different issuer today \(Ganske Cloud A\/S → Rogue Cert BV\)/, `${name}: ${stdout}`);
    // Both facts, in the report's two sentences — the rotation is not replaced by
    // the stronger reading, and the stronger reading does not erase it.
    assert.match(stdout, /🔑 certificate replaced today/, `${name}: ${stdout}`);
  }
});

function existsSyncSafe(file) {
  try {
    return readFileSync(file, 'utf8').length > 0;
  } catch {
    return false;
  }
}

test('en ny udsteder er ikke en hændelse: listerne læser, de alarmerer ikke', async (t) => {
  // `printStatus` is not a pass, and a read-only list must not raise an alarm or
  // spend a Pro slot. Measured rather than asserted: reading leaves the state
  // file byte for byte as it was.
  const { stateFile, env } = homeWith(t, { [SITE]: hijacked() });
  const before = readFileSync(stateFile, 'utf8');
  for (const args of [['status'], ['watch', '--status']]) {
    const { code } = await runExit(args, env);
    assert.equal(code, 0, args.join(' '));
    assert.equal(readFileSync(stateFile, 'utf8'), before, `${args.join(' ')} must not write the state file`);
  }

  // The event itself is still the pass's, and it still belongs to the paid
  // channel: this task adds a sentence to two lists, not a new event type.
  const watch = strip(readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8'));
  const start = watch.indexOf('export function printStatus');
  const printer = watch.slice(start, watch.indexOf('\nexport ', start + 1));
  assert.ok(start > 0 && printer.length > 0, 'the list must still be a named function of its own');
  assert.doesNotMatch(printer, /certIssuerChangedAt\s*=|sendWebhook|runPass|saveState/, 'a list must not stamp or alert');
  assert.doesNotMatch(watch, /'cert_issuer[a-z_]*'/, 'a new event type is not part of this');
});
