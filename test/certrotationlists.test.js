/**
 * P1-62 — the two free lists were silent about a certificate that had been
 * replaced, while the paid report named it.
 *
 * P1-60 made a rotation visible in `check` and on the paid webhook. P1-61 closed
 * the first of the two surfaces it left open: `report`, the document a bureau
 * forwards to the customer. This is the second, and the one that is left after
 * that: `status` and `watch --status` — the two commands anyone actually runs to
 * find out whether their monitoring works.
 *
 * Measured 2026-09-27, real CLI, real `runPass`, two state files written by real
 * passes over a site that answers 200 in both. The only difference between them
 * is which certificate answered on the second day:
 *
 *   uændret certifikat         →  ✅ https://kunde.dk/ (200) — SSL 89d
 *   certifikatet byttet i dag  →  ✅ https://kunde.dk/ (200) — SSL 89d
 *
 * Two rows, character for character equal, and a report over the same file that
 * said `**1 site has its certificate replaced since monitoring …**`. So the fact
 * existed only where it is sold. And the day count cannot stand in for it: a
 * reissued certificate usually has *more* days left than the one it replaced, so
 * a hijacked domain reads as the healthier of the two.
 *
 * `readCertRotationState` was already the one owner (P1-61); these two lists
 * simply never asked. `readEntry` asks now, next to the page reading (P1-57), and
 * each list places the sentence. A replaced certificate is not a verdict — most
 * hosts reissue every 90 days — so no status, exit code or uptime number moves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPass } from '../src/watch.js';
import { getStateFile } from '../src/watch.js';
import { readCertRotationState, readEntry } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const SITE = 'https://kunde.dk/';
const OTHER_SITE = 'https://to.dk/';
const BASE = '2026-09-27T09:00:00.000Z';
const SHA256 = 'a'.repeat(64);
const NEW_SHA256 = 'b'.repeat(64);

function daysAgo(days) {
  return new Date(new Date(BASE).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A site a real pass measured: 200, a certificate, and nothing else claimed. */
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
    ...overrides,
  };
}

/** A throwaway HOME with a real state file the CLI will find. */
function homeWith(t, urls) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certrotlists-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ urls }, null, 2));
  return { home, stateFile, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function strip(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A command and its exit code together.
 *
 * `promisify(execFile)` resolves only when the command exits 0 and rejects
 * otherwise, so "it resolved" is the exit-code lock — but a lock nobody can read
 * is a lock nobody trusts. This returns both, so a test can assert the number.
 */
function runExit(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

// --------------------------------------------------------------- the owner

test('readEntry læser rotationen med samme ejer som rapporten', () => {
  const now = new Date(BASE);
  const rotated = readEntry(healthy({ lastCertRotatedAt: daysAgo(3) }), { now, url: SITE });
  assert.equal(rotated.cert.rotated, true);
  assert.equal(rotated.certNote, '🔑 certificate replaced 3 d ago');

  // The two states the rows must not confuse: a site whose certificate was never
  // replaced has a stored identity and no stamp, and a site with no identity at
  // all was never measured. Both are silent, and both stay `up`.
  const quiet = readEntry(healthy(), { now, url: SITE });
  assert.equal(quiet.cert.rotated, false);
  assert.equal(quiet.certNote, '', 'ingen sætning er bedre end en der ligner en kendsgerning');
  const never = readEntry(healthy({ lastCertFingerprint: null, certBaselineSeenAt: null }), { now, url: SITE });
  assert.equal(never.certNote, '');
  assert.equal(never.verdict, 'up');

  // A hand-written stamp that cannot be placed is named as such rather than aged
  // into "today" — the rule `passAge` owns everywhere else.
  const unreadable = readEntry(healthy({ lastCertRotatedAt: 'not a date' }), { now, url: SITE });
  assert.equal(unreadable.certNote, '🔑 certificate replaced at an unreadable time');
  // …and a stamp ahead of this clock is a clock problem, not a fact about the
  // certificate.
  const ahead = readEntry(healthy({ lastCertRotatedAt: daysAgo(-3) }), { now, url: SITE });
  assert.match(ahead.certNote, /ahead of this machine's clock/);
  assert.equal(ahead.cert.ageDays, null);
});

test('ejeren på de to lister er readCertRotationState, ikke en anden læsning', () => {
  // Measured: the marked sentence — the one a row carries — is written in exactly
  // one function, and it writes it in its two forms, the ordinary one and the
  // clock-skew one, exactly as `contentChangeNote` writes three. A second author
  // is how the report and the lists drifted apart in P1-61, so the count is
  // locked rather than the string.
  //
  // The lock is on the marked form, not on the words: the watch loop has its own
  // event text for the paid channel (`SSL certificate replaced — …`, P1-60),
  // which is a pass announcing something, not a list reading a state file.
  const status = strip(readFileSync(join(ROOT, 'src', 'status.js'), 'utf8'));
  assert.equal((status.match(/🔑 certificate replaced/g) || []).length, 2, 'only the owner may write the sentence, once per form');
  assert.match(status, /const cert = readCertRotationState\(value, \{ now \}\);/, 'readEntry must ask the owner');
  assert.match(status, /certNote: cert\.note/);

  for (const [file, name] of [['cli.js', 'status'], ['watch.js', 'watch --status']]) {
    const source = strip(readFileSync(join(ROOT, 'src', file), 'utf8'));
    assert.doesNotMatch(source, /🔑 certificate replaced/, `${name} must not build the sentence itself`);
    assert.match(source, /certNote/, `${name} must place the owner's sentence`);
  }
});

// ------------------------------------------------------------- the two lists

test('begge lister navner et certifikat, der er blevet byttet', async (t) => {
  const { env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: daysAgo(2) }) });

  const status = await run(process.execPath, [CLI, 'status'], { env });
  assert.ok(
    status.stdout.includes('🔑 certificate replaced 2 d ago'),
    `status row: ${status.stdout}`,
  );
  // The age travels with the fact, so a list opened days after the pass does not
  // read "replaced" as "this morning".
  assert.doesNotMatch(status.stdout, /🔑 certificate replaced(?! [\d|today])/, status.stdout);

  const list = await run(process.execPath, [CLI, 'watch', '--status'], { env });
  assert.ok(
    list.stdout.includes('🔑 certificate replaced 2 d ago'),
    `watch --status row: ${list.stdout}`,
  );
});

test('et uændret certifikat tier begge lister', async (t) => {
  // The stamp is written only when a pass saw a different certificate, so its
  // absence is the ordinary case — nine of ten passes on a healthy site. A note
  // here would train the reader to scroll past the one that matters.
  const { env } = homeWith(t, { [SITE]: healthy() });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.doesNotMatch(stdout, /certificate/, `${args.join(' ')}: ${stdout}`);
    assert.match(stdout, /kunde\.dk/, stdout);
  }
});

test('to sites, kun ét byttet: den anden række forbliver tavs', async (t) => {
  const { env } = homeWith(t, {
    [SITE]: healthy({ lastCertRotatedAt: daysAgo(1) }),
    [OTHER_SITE]: healthy({ lastCertFingerprint: SHA256 }),
  });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.equal((stdout.match(/certificate replaced/g) || []).length, 1, `${args.join(' ')}: ${stdout}`);
  }
});

test('listerne og rapporten siger det samme om det samme state-fil', async (t) => {
  // The whole point of the task: one file, one owner, three surfaces. Before this
  // the report said it and the two free lists did not, so the fact was only
  // available to a paying customer.
  const { env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: daysAgo(4) }) });
  const entry = healthy({ lastCertRotatedAt: daysAgo(4) });
  const markdown = renderReportMarkdown(buildReport({ urls: { [SITE]: entry } }, { now: new Date(BASE) }));
  assert.ok(markdown.includes('🔑 certificate replaced 4 d ago'), markdown);

  const status = await run(process.execPath, [CLI, 'status'], { env });
  const list = await run(process.execPath, [CLI, 'watch', '--status'], { env });
  for (const [name, stdout] of [['status', status.stdout], ['watch --status', list.stdout]]) {
    assert.ok(stdout.includes('🔑 certificate replaced 4 d ago'), `${name}: ${stdout}`);
  }
});

test('et ulæseligt stempel siger det på listerne uden at opfinde en alder', async (t) => {
  const { env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: 'whenever' }) });
  for (const args of [['status'], ['watch', '--status']]) {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env });
    assert.ok(stdout.includes('🔑 certificate replaced at an unreadable time'), `${args.join(' ')}: ${stdout}`);
    assert.doesNotMatch(stdout, /replaced today/, 'et uflytbart tidspunkt må ikke alderes til i dag');
  }
});

// ----------------------------------------------------------------- the locks

test('en rotation flytter hverken status, exit-kode eller de øvrige felter', async (t) => {
  // Lock, not a claim: an unissued certificate is still a valid certificate for
  // the right name, so nothing on a row may move because of it. `readEntry` is
  // deep-equal apart from the two new fields, the row keeps its `✅` and its
  // `SSL 89d`, and the exit code is still 0.
  const now = new Date(BASE);
  const quiet = readEntry(healthy(), { now, url: SITE });
  const rotated = readEntry(healthy({ lastCertRotatedAt: daysAgo(1) }), { now, url: SITE });
  const { cert, certNote, ...restQuiet } = quiet;
  const { cert: _cert2, certNote: _note2, ...restRotated } = rotated;
  assert.deepEqual(restRotated, restQuiet, 'kun de additive felter er nye');
  assert.equal(rotated.verdict, 'up');
  assert.equal(rotated.sslNote, 'SSL 89d');
  assert.equal(rotated.sslMayHaveExpired, false);

  const { env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: daysAgo(1) }) });
  const result = await runExit(['status'], env);
  assert.equal(result.code, 0, `en byttet identitet er ikke et nedet site: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /✅ https:\/\/kunde\.dk\/ \(200\) — SSL 89d/, result.stdout);
  const list = await runExit(['watch', '--status'], env);
  assert.equal(list.code, 0, `heller ikke på den anden liste: ${list.stdout}${list.stderr}`);
});

test('et pass skriver stemplet, og listerne læser det samme pass', async (t) => {
  // The measured journey rather than a hand-written file: baseline → same
  // certificate → a different one, with the state file read back from disk after
  // each pass. The lists and the report then see the file the pass actually
  // wrote, not one built to please a test.
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-certrotpass-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  let call = 0;
  const check = url => {
    const fingerprint = [SHA256, SHA256, NEW_SHA256][Math.min(call, 2)];
    call += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      ssl: { validDays: 89, isExpired: false, serialNumber: '01EEE6AABB', fingerprint256: fingerprint, subject: { CN: 'kunde.dk' }, issuer: { O: 'Test CA' } },
      content: { fetched: true, contentLength: 89, hash: 'h1', changed: false, title: 'Kunde' },
    };
  };

  const reads = [];
  for (let i = 0; i < 3; i += 1) {
    const onDisk = existsSyncSafe(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { urls: { [SITE]: {} } };
    await runPass(onDisk, { stateFile, check, returnResults: true });
    reads.push(JSON.parse(readFileSync(stateFile, 'utf8')).urls[SITE]);
  }
  assert.equal(reads[0].lastCertRotatedAt, undefined, 'en baseline er ikke en rotation');
  assert.equal(reads[1].lastCertRotatedAt, undefined, 'det samme certifikat er ikke en rotation');
  assert.equal(typeof reads[2].lastCertRotatedAt, 'string', 'men en ny identitet skriver hvornår');

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const status = await run(process.execPath, [CLI, 'status'], { env });
  assert.ok(/🔑 certificate replaced today/.test(status.stdout), status.stdout);
  const list = await run(process.execPath, [CLI, 'watch', '--status'], { env });
  assert.ok(/🔑 certificate replaced today/.test(list.stdout), list.stdout);
});

function existsSyncSafe(file) {
  try {
    return readFileSync(file, 'utf8').length > 0;
  } catch {
    return false;
  }
}

test('en rotation er ikke en hændelse: listerne læser, de alarmerer ikke', async (t) => {
  // `printStatus` is not a pass, and a read-only list must not be able to raise
  // an alarm or spend a Pro slot. The only thing this task adds is a sentence;
  // the event belongs to the pass (P1-60), and a list that also emitted one would
  // make `status` a writer — the same rule that keeps `check` read-only.
  const watch = strip(readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8'));
  const start = watch.indexOf('export function printStatus');
  const printer = watch.slice(start, watch.indexOf('\nexport ', start + 1));
  assert.ok(start > 0 && printer.length > 0, 'the list must still be a named function of its own');
  assert.doesNotMatch(printer, /cert_rotated|sendWebhook|runPass|saveState/, 'a list must not raise the event or write state');
  // The pass still owns the event, and it is read from the same owner.
  assert.match(watch, /events\.push\(event\('cert_rotated'/, 'the pass still announces the rotation');

  // Measured rather than asserted: reading a rotation on a list leaves the file
  // byte for byte as it was. A list that stamped, re-saved or alerted would move
  // it, and the stamp is the one thing in this task that writes.
  const { stateFile, env } = homeWith(t, { [SITE]: healthy({ lastCertRotatedAt: daysAgo(1) }) });
  const before = readFileSync(stateFile, 'utf8');
  for (const args of [['status'], ['watch', '--status']]) {
    const { code } = await runExit(args, env);
    assert.equal(code, 0, args.join(' '));
    assert.equal(readFileSync(stateFile, 'utf8'), before, `${args.join(' ')} must not write the state file`);
  }
  assert.equal(readCertRotationState({ lastCertRotatedAt: daysAgo(1) }, { now: new Date(BASE) }).rotated, true);
});
