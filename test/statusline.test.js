/**
 * statusline.test.js — the two surfaces that list every monitored site must not
 * claim more than the state file knows.
 *
 * Measured first, on a real `state.json`, before any line was changed:
 *
 *   deskuptime watch --status
 *     ✅ up  https://stale.dk/ (200, SSL 9d) @ 2026-08-16T01:25:33.000Z
 *     ✅ up  https://inject.dk/ (200, SSL ^[[2J^[[5mOWNED-BY-STATE-FILE^[[0md)
 *
 *   deskuptime status
 *     ✅ https://stale.dk/ (200) — SSL 9d
 *     ✅ https://inject.dk/ (200) — SSL ^[[2J^[[5mOWNED-BY-STATE-FILE^[[0md
 *
 * Three defects, one cause: both surfaces decided the claims themselves instead
 * of asking src/status.js, which `check`, `watch` and the client report have
 * been using since P1-2b and P1-6.
 *
 *   1. a pass from 41 days ago printed as `✅ up` with no age anywhere, while the
 *      report built from the same file said `⚠️ stale — last check 41 d ago`;
 *   2. a certificate with 9 days left printed as plain `SSL 9d`, where the other
 *      three surfaces warn inside the 14-day window;
 *   3. `sslValidDays` was concatenated into the terminal, so escape bytes in a
 *      hand-edited or restored state file printed as themselves — the one print
 *      site P2-1 del C did not cover — and an unusable value printed as `SSL -2d`
 *      where the report prints `—`.
 *
 * The CLI runs on the real clock, so the ages asserted below are computed from
 * the same clock rather than hardcoded: the property under test is that the
 * number printed is the true age of the timestamp in the state file, which stays
 * true on any day this test runs.
 *
 * The control bytes are built with String.fromCharCode, like display.test.js:
 * a literal ESC in a source file is invisible in review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEntry, SSL_WARN_DAYS, STALE_AFTER_DAYS } from '../src/status.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

const char = code => String.fromCharCode(code);
const ESC = char(0x1b);
const NEL = char(0x85);
const OWNED = `${ESC}[2J${ESC}[5mOWNED-BY-STATE-FILE${ESC}[0m`;

const NOW = new Date('2026-09-26T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = days => new Date(Date.now() - days * DAY_MS).toISOString();
/** Whole days the CLI will compute for a timestamp, from the same clock. */
const ageDays = iso => Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/** A temp HOME with a state file, so no test can touch the real one. */
function withState(t, urls) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-statusline-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({ urls }));
  return { HOME: home, USERPROFILE: home };
}

/**
 * The site row for `host`. Only the first match: `watch --status` deliberately
 * names a stale site a second time in the attention block below the list.
 */
function line(stdout, host) {
  const found = stdout.split('\n').filter(row => row.includes(host));
  assert.ok(found.length > 0, `no line for ${host} in ${JSON.stringify(stdout)}`);
  return found[0];
}

/** Nothing a state file says may put a control or invisible character in the output. */
function assertInert(output, label) {
  const ranges = [[0x00, 0x09], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029],
    [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  const pattern = new RegExp(`[${ranges.map(([a, b]) =>
    a === b ? char(a) : `${char(a)}-${char(b)}`).join('')}]`, 'g');
  const smuggled = output.match(pattern);
  assert.equal(smuggled, null,
    `${label}: output still contains ${smuggled ? JSON.stringify([...new Set(smuggled)]) : ''}`);
}

// ── readEntry: the one reading both surfaces ask ──

test('readEntry: a verdict and a status code come from the pass, and only if they are one', () => {
  assert.equal(readEntry({ wasUp: true, lastStatus: 200 }, { now: NOW }).verdict, 'up');
  assert.equal(readEntry({ wasUp: false, lastStatus: 503 }, { now: NOW }).verdict, 'down');
  assert.equal(readEntry({ wasUp: null }, { now: NOW }).verdict, 'unknown');
  assert.equal(readEntry({}, { now: NOW }).verdict, 'unknown');
  assert.equal(readEntry(undefined, { now: NOW }).verdict, 'unknown');
  assert.equal(readEntry('not an entry', { now: NOW }).verdict, 'unknown');
  // A status code is only a status code if it is one: "200" and 20.5 are not,
  // and the caller gets null instead of something to print as if it was seen.
  assert.equal(readEntry({ lastStatus: 200 }, { now: NOW }).statusCode, 200);
  for (const bogus of ['200', 20.5, null, {}, [200], true, Number.NaN]) {
    assert.equal(readEntry({ lastStatus: bogus }, { now: NOW }).statusCode, null, `lastStatus ${String(bogus)}`);
  }
});

test('readEntry: the certificate note uses the same window as check, watch and the report', () => {
  const note = days => readEntry({ sslValidDays: days }, { now: NOW }).sslNote;
  assert.equal(note(SSL_WARN_DAYS), `SSL ⚠️ ${SSL_WARN_DAYS}d — renew soon`, 'the boundary day itself warns');
  assert.equal(note(SSL_WARN_DAYS - 1), `SSL ⚠️ ${SSL_WARN_DAYS - 1}d — renew soon`);
  assert.equal(note(SSL_WARN_DAYS + 1), `SSL ${SSL_WARN_DAYS + 1}d`);
  assert.equal(note(0), 'SSL ⚠️ 0d — renew soon', 'a certificate expiring today is inside the window');
  assert.equal(note(200), 'SSL 200d');
  assert.equal(note(4000), 'SSL 4000d');
});

test('readEntry: a day count that is not one is unknown, never a claim', () => {
  // The report's own rule, applied here for the first time on this surface: a
  // negative number is a corrupt or hand-edited state file, not an expired
  // certificate, and a string is not a day count at all.
  for (const bogus of [-1, -400, '9', '', 'nine', true, {}, [], Number.NaN, Infinity]) {
    const read = readEntry({ sslValidDays: bogus }, { now: NOW });
    assert.equal(read.sslDays, null, `sslValidDays ${String(bogus)}`);
    assert.equal(read.sslNote, 'SSL —', `sslValidDays ${String(bogus)}`);
  }
  // Absent is not the same as unreadable: plain-HTTP monitoring has no expiry to
  // report, and saying so on every line would be noise.
  assert.equal(readEntry({}, { now: NOW }).sslNote, '');
  assert.equal(readEntry({ sslValidDays: null }, { now: NOW }).sslNote, '');
});

test('readEntry: age and staleness come from the same window the report uses', () => {
  const at = iso => new Date(Date.parse(iso)).toISOString();
  const read = lastChecked => readEntry({ wasUp: true, lastChecked }, { now: NOW });
  const before = days => at(new Date(NOW.getTime() - days * DAY_MS).toISOString());

  assert.equal(read(before(0)).stale, false, 'a pass just now is current');
  assert.equal(read(before(0.5)).stale, false);
  assert.equal(read(before(STALE_AFTER_DAYS - 0.01)).stale, false, 'inside the window is current');
  assert.equal(read(before(STALE_AFTER_DAYS + 0.01)).stale, true);
  assert.equal(read(before(41)).staleNote, 'stale — last check 41 d ago');
  assert.equal(read(before(41)).ageDays, 41);
  // A recorded pass whose time cannot be read is stale: a pass happened and we
  // cannot show it is current, which is what a status line must not assume.
  assert.equal(read('not a date').staleNote, 'stale — last check unreadable');
  assert.equal(read('not a date').ageDays, null);
  // Never checked says nothing new, and a future stamp is clock skew, not age.
  assert.equal(read(undefined).stale, false);
  assert.equal(read('').stale, false);
  assert.equal(read(at(new Date(NOW.getTime() + DAY_MS).toISOString())).stale, false);
});

test('readEntry: nothing from the state file is carried through as text', () => {
  // The reason the returned shape is what it is: a caller cannot print a raw
  // field even if it wanted to, because there is no raw field to print.
  const read = readEntry({
    wasUp: 'yes', lastStatus: OWNED, sslValidDays: OWNED, lastChecked: OWNED, addedAt: OWNED,
  }, { now: NOW });
  assert.equal(read.verdict, 'unknown');
  assert.equal(read.statusCode, null);
  assert.equal(read.sslNote, 'SSL —');
  for (const [key, value] of Object.entries(read)) {
    if (typeof value !== 'string') continue;
    assert.equal(value.includes(ESC), false, `${key} carried a raw ESC`);
    assert.equal(value.includes(NEL), false, `${key} carried a raw NEL`);
  }
});

// ── watch --status ──

test('watch --status: a pass from six weeks ago is not presented as a site that is up now', { timeout: 30000 }, async (t) => {
  const old = ago(41);
  const env = withState(t, {
    'https://stale.dk/': { wasUp: true, lastStatus: 200, lastChecked: old, sslValidDays: 200 },
    'https://fresh.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: 200 },
  });

  const { code, stdout } = await run(['watch', '--status'], { env });
  assert.equal(code, 0, 'the exit code is unchanged, so scripts reading it keep working');

  const staleLine = line(stdout, 'stale.dk');
  const freshLine = line(stdout, 'fresh.dk');
  assert.match(staleLine, /✅ up/, 'the observed result is kept — the pass really did answer 200');
  assert.match(staleLine, new RegExp(`⚠️ stale — last check ${ageDays(old)} d ago`));
  assert.match(freshLine, /✅ up/);
  assert.equal(freshLine.includes('stale'), false, 'a site checked 14 minutes ago must not be flagged');
  // The whole point of this command is "is my monitoring alive?", so the dead
  // site is named with its age rather than left to be spotted in a list.
  assert.match(stdout, new RegExp(`No monitoring pass in the last ${STALE_AFTER_DAYS} days for 1 of 2 site`));
  assert.match(stdout, new RegExp(`https://stale\\.dk/ \\(last pass ${ageDays(old)} d ago\\)`));
  assert.match(stdout, /deskuptime watch <url> --once/);
  assert.equal(stdout.includes('fresh.dk/ (last pass'), false, 'a current site was named as stale');
});

test('watch --status: a stale DOWN site is still shown as DOWN', { timeout: 30000 }, async (t) => {
  // Staleness must not hide an outage: a customer has to be able to see a site
  // that was last seen down, however long ago that was.
  const old = ago(200);
  const env = withState(t, { 'https://down.dk/': { wasUp: false, lastStatus: 503, lastChecked: old } });
  const { stdout } = await run(['watch', '--status'], { env });
  assert.match(line(stdout, 'down.dk'), new RegExp(`🚨 down .*\\(503\\).*⚠️ stale — last check ${ageDays(old)} d ago`));
});

test('watch --status: a fresh list can never cry wolf', { timeout: 30000 }, async (t) => {
  const env = withState(t, {
    'https://a.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(1) },
    'https://b.dk/': { wasUp: false, lastStatus: 500, lastChecked: ago(1.5) },
  });
  const { stdout } = await run(['watch', '--status'], { env });
  assert.equal(stdout.includes('stale'), false, 'a daily cron must not be reported as dead monitoring');
  assert.equal(stdout.includes('No monitoring pass'), false);
});

test('watch --status: a certificate inside the warning window is marked', { timeout: 30000 }, async (t) => {
  const env = withState(t, {
    'https://soon.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: 9 },
    'https://fine.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: 200 },
  });
  const { stdout } = await run(['watch', '--status'], { env });
  assert.match(line(stdout, 'soon.dk'), /SSL ⚠️ 9d — renew soon/);
  assert.match(line(stdout, 'fine.dk'), /SSL 200d/);
  assert.equal(line(stdout, 'fine.dk').includes('renew'), false, 'a certificate with 200 days is not urgent');
});

test('watch --status: an unreadable certificate reads as unknown, not as a number', { timeout: 30000 }, async (t) => {
  const env = withState(t, {
    'https://negative.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: -2 },
    'https://stringy.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: '9' },
  });
  const { stdout } = await run(['watch', '--status'], { env });
  assert.equal(stdout.includes('-2d'), false, 'a negative day count must not print as one');
  assert.equal(stdout.includes('SSL 9d'), false, 'a string is not a day count');
  for (const host of ['negative.dk', 'stringy.dk']) assert.match(line(stdout, host), /SSL —/);
});

test('watch --status: a state file cannot drive the terminal', { timeout: 30000 }, async (t) => {
  // Measured before the fix: `^[[2J^[[5mOWNED-BY-STATE-FILE^[[0m` reached the
  // terminal from `sslValidDays`, and `lastChecked` was concatenated raw. The
  // state file is ours, but it is also hand-edited, restored from a backup and
  // merged — so it is input, not trusted output.
  const env = withState(t, {
    'https://ssl.example/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: OWNED },
    'https://time.example/': { wasUp: true, lastStatus: 200, lastChecked: OWNED, sslValidDays: 9 },
    [`https://url${ESC}[5m.example/`]: { wasUp: true, lastStatus: 200, lastChecked: ago(0.01) },
  });
  const { stdout } = await run(['watch', '--status'], { env });
  assertInert(stdout, 'watch --status');
  // The words a state file supplies survive as ordinary visible text — the same
  // bargain display.test.js strikes for a hostile header. What must not survive
  // is the escape sequence that carried them.
  assert.equal(stdout.includes(OWNED), false, 'the escape sequence from the state file was printed');
  assert.equal(stdout.includes(`${ESC}[2J`), false);
  assert.match(line(stdout, 'ssl.example'), /SSL —/);
  assert.match(line(stdout, 'time.example'), /stale — last check unreadable/);
  // The escape in a URL is removed whole — sequence and visible residue alike —
  // so the row is one line and the verdict stays attached to its site.
  assert.match(line(stdout, 'url.example'), /✅ up .*\(200\)/);
});

test('watch --status: an empty state file still explains what to do', { timeout: 30000 }, async (t) => {
  const { code, stdout } = await run(['watch', '--status'], { env: withState(t, {}) });
  assert.equal(code, 0);
  assert.match(stdout, /No URLs monitored\. Start with: deskuptime watch <url>/);
});

test('watch --status: a site that was never checked does not claim a status code', { timeout: 30000 }, async (t) => {
  const { stdout } = await run(['watch', '--status'], { env: withState(t, { 'https://new.dk/': { wasUp: null } }) });
  assert.match(line(stdout, 'new.dk'), /❔ unknown .*https:\/\/new\.dk\/ \(—\)/);
});

// ── deskuptime status: the same reading, which is what keeps the two honest ──

test('status: the URL list says exactly what watch --status says about the same entries', { timeout: 30000 }, async (t) => {
  const urls = {
    'https://stale.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(41), sslValidDays: 200 },
    'https://soon.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: 9 },
    'https://fine.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: 200 },
    'https://inject.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: OWNED },
    'https://broken.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), sslValidDays: -2 },
    'https://down.dk/': { wasUp: false, lastStatus: 503, lastChecked: ago(0.01) },
    'https://new.dk/': { wasUp: null },
  };
  const env = withState(t, urls);
  const [list, watch] = await Promise.all([run(['status'], { env }), run(['watch', '--status'], { env })]);

  for (const { stdout } of [list, watch]) {
    assertInert(stdout, 'status lists');
    assert.equal(stdout.includes(OWNED), false, 'an escape sequence from the state file was printed');
  }
  // The two surfaces lay a line out differently on purpose, so the shared
  // property is the claim itself: every part readEntry puts in a line has to be
  // present in both. That is what stops them drifting apart again.
  for (const [url, entry] of Object.entries(urls)) {
    const claims = readEntry(entry, { now: new Date() });
    for (const { stdout } of [list, watch]) {
      const row = line(stdout, url);
      if (claims.stale) assert.ok(row.includes(claims.staleNote), `${url}: ${claims.staleNote} missing`);
      else assert.equal(row.includes('stale'), false, `${url}: a current site was marked stale`);
      if (claims.sslNote) assert.ok(row.includes(claims.sslNote), `${url}: "${claims.sslNote}" missing`);
      else assert.equal(/\bSSL\b/.test(row), false, `${url}: an SSL claim with nothing to claim`);
      if (claims.statusCode !== null) assert.ok(row.includes(`(${claims.statusCode}`), `${url}: status code missing`);
    }
  }
  // And the concrete claims, so the loop above cannot pass on both being empty.
  assert.match(line(list.stdout, 'stale.dk'), /⚠️ stale — last check 41 d ago/);
  assert.match(line(list.stdout, 'soon.dk'), /SSL ⚠️ 9d — renew soon/);
  assert.match(line(list.stdout, 'fine.dk'), /SSL 200d/);
  assert.match(line(list.stdout, 'broken.dk'), /SSL —/);
  assert.equal(list.stdout.includes('-2d'), false, 'a negative day count printed as one');
  assert.match(line(list.stdout, 'inject.dk'), /SSL —/);
  assert.match(line(list.stdout, 'down.dk'), /❌ https:\/\/down\.dk\/ \(503\)/);
  // The license line is still this command's first job.
  assert.match(list.stdout, /Free tier|Activate Pro/);
});

test('status: a state file cannot start a second line', { timeout: 30000 }, async (t) => {
  const env = withState(t, {
    'https://time.example/': { wasUp: true, lastStatus: 200, lastChecked: `${ago(0.01)}${NEL}second line`, sslValidDays: 9 },
  });
  const { stdout } = await run(['status'], { env });
  assertInert(stdout, 'status');
  assert.equal(stdout.includes('second line'), false, 'a state file printed a second line');
});

// ── A site the state file cannot vouch for (P1-14) ──

/**
 * Measured before any line was changed, on one state file with two entries that
 * are both `unknown` and were not distinguishable in either list:
 *
 *   deskuptime status
 *     · https://never.dk
 *     · https://handedit.dk
 *
 * The first has never been measured. The second has a pass from three hours ago
 * whose verdict cannot be read (a restored or hand-edited state file). A user
 * reading that list cannot tell them apart, and a URL on the watch list that no
 * pass has ever measured is the same silent failure P1-10 measured in the alert
 * channels: nothing says it. The client report has said "not checked yet" since
 * P1-13 — these two surfaces now read the same sentence from `unknownNote`.
 */
test('the two lists name what they cannot vouch for, and never for a site they can', { timeout: 30000 }, async (t) => {
  const urls = {
    'https://never.dk/': { wasUp: null, addedAt: ago(30) },
    'https://handedit.dk/': { wasUp: 'yes', lastStatus: 200, lastChecked: ago(0.125), addedAt: ago(30) },
    'https://fresh.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), addedAt: ago(30) },
  };
  const env = withState(t, urls);
  const [list, watch] = await Promise.all([run(['status'], { env }), run(['watch', '--status'], { env })]);

  for (const { stdout } of [list, watch]) {
    assertInert(stdout, 'unknown rows');
    // Never monitored, and monitored-but-unreadable, are different sentences.
    assert.match(line(stdout, 'never.dk'), /not checked yet/, 'a site with no pass did not say so');
    assert.match(line(stdout, 'handedit.dk'), /status unknown \(last check \d+ d ago\)/,
      'a site with an unreadable verdict did not name the age of its pass');
    // A site we can vouch for is not given either sentence.
    const fresh = line(stdout, 'fresh.dk');
    assert.equal(fresh.includes('not checked yet'), false, 'a fresh up-site was called unchecked');
    assert.equal(fresh.includes('status unknown'), false, 'a fresh up-site was called unknown');
  }
  // The two entries rendered the same line before this change, which is the
  // defect: they are not allowed to collapse back into one another.
  assert.notEqual(line(list.stdout, 'never.dk').replace('never', ''), line(list.stdout, 'handedit.dk').replace('handedit', ''));
});

test('watch --status names the sites no pass has ever measured, once', { timeout: 30000 }, async (t) => {
  const env = withState(t, {
    'https://never.dk/': { wasUp: null, addedAt: ago(30) },
    'https://stale.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(41), addedAt: ago(60) },
    'https://fine.dk/': { wasUp: true, lastStatus: 200, lastChecked: ago(0.01), addedAt: ago(60) },
  });
  const { stdout } = await run(['watch', '--status'], { env });
  // Named out loud, like the stale block: a per-row marker is easy to scroll past
  // and this command exists to answer "is my monitoring working?".
  const blocks = stdout.split('\n\n').filter(block => block.includes('Never checked'));
  assert.equal(blocks.length, 1, 'the never-checked block is missing or repeated');
  assert.match(blocks[0], /1 of 3 site\(s\)/);
  assert.match(blocks[0], /https:\/\/never\.dk\//);
  assert.match(blocks[0], /deskuptime watch <url> --once/);
  // Disjoint from the stale block: a site with no pass is not old data, it is
  // no data — and the two must not both claim it.
  const staleBlock = stdout.split('\n\n').find(block => block.includes('No monitoring pass'));
  assert.equal(staleBlock.includes('never.dk'), false, 'a never-checked site was also reported as stale');
  assert.equal(stdout.split('Never checked').length - 1, 1, 'the block is printed more than once');
  // A site that has been measured is never in that block.
  assert.equal(blocks[0].includes('fine.dk'), false, 'a measured site was named as never checked');
  assert.equal(blocks[0].includes('stale.dk'), false, 'a stale site was named as never checked');
});
