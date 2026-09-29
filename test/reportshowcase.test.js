/**
 * P1-111 — the flagship paid feature was the one thing no customer could see.
 *
 * `deskuptime report` is what a bureau opens when it has decided to pay: it is
 * the document the customer receives, and the reason the $19 buys something
 * nobody else does. Measured 2026-09-29, on the real files, nothing stubbed:
 *
 *   $ grep -c "deskuptime report" README.md
 *   0
 *   $ grep -n "report" README.md
 *   104:| Shareable status page / customer report (`report`, Markdown + JSON) | — | ✅ | Pro only |
 *   $ grep -rn "agency-report" README.md docs/pro-alerts.md
 *   (nothing)
 *   $ deskuptime --help | grep -c "deskuptime report"
 *   3
 *
 * One mention in the whole README, and it is a table cell — the free/Pro matrix
 * that is generated from `src/features.js`, so it says the feature *exists* and
 * nothing about what it *produces*. `--help` names the command three times, and
 * the npm page is generated from the same source, which is how 0.2.8 was
 * published without a buyer ever seeing a line of the document they are paying
 * for.
 *
 * This is the same failure the repository has now measured four times, in four
 * different shapes: a constant with no consumer (P1-91), a flag with no
 * documentation (P1-108), a ref that does not exist (P1-107), a table row
 * standing in for a demonstration. The rule each time is the same — a built
 * capability that a customer cannot see does not exist, and the fix is not more
 * prose but a **pasted real run**, so there is something to check the prose
 * against.
 *
 * Which is the whole reason these tests run the command. A hand-written
 * assertion that the README contains the string `| Site | Status |` would pass
 * against a table describing a feature that was never built, and would keep
 * passing after the columns were renamed. So the showcase below is *generated*:
 * the fixture is a real state file and a real history file, the report comes out
 * of the real `report` command, and the tests below require the README to
 * contain the output it actually produced. A column that is renamed, a counter
 * that changes, a row that reorders — all of them turn this red, which is the
 * point: the README must not drift into a picture of a report the tool no
 * longer makes.
 *
 * The fixture is written the way `runPass` writes it, not the way that would be
 * convenient. That matters for the same reason P1-79's scenario `expect` does:
 * a showcase measured from a state shape the code never produces is a
 * screenshot of a fiction. `test/regime` below re-derives the numbers the
 * fixture should produce and fails if the fixture does not produce them, so a
 * report that quietly stops reading real state is caught here rather than
 * shipped as a picture of one.
 *
 * Everything is local: a temp HOME, a hand-written state file, and the report
 * command, which never opens a socket.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const SPEC = join(ROOT, 'docs', 'agency-report.md');

const DAY_MS = 86_400_000;
const MS_PER_CHECK = 0.1;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}
function dayKey(msAgo) {
  return iso(msAgo).slice(0, 10);
}

/**
 * The showcase fixture: two sites over 30 recorded days, one of them DOWN.
 *
 * A single green site would make a demonstration that hides the reason the
 * report is worth reading. The DOWN row is the point — it is what a bureau
 * forwards, and a showcase in which everything is green teaches the reader
 * nothing about how failures look.
 */
function showcaseState() {
  const now = Date.now();
  return {
    version: 1,
    license: {
      key: '0123456789abcdef0123456789abcdef',
      instance: 'deskuptime-showcase',
      plan: 'pro',
      status: 'active',
      validatedAt: new Date(now).toISOString(),
    },
    urls: {
      'https://kunde.dk/': {
        url: 'https://kunde.dk/',
        wasUp: true,
        lastStatus: 200,
        lastChecked: iso(20 * 60_000),
        addedAt: iso(30 * DAY_MS),
        lastResponseMs: 142,
        lastContentLength: 18_402,
        lastContentReadAt: iso(20 * 60_000),
        checks: 1204,
        checksUp: 1203,
      },
      'https://shop.kunde.dk/': {
        url: 'https://shop.kunde.dk/',
        wasUp: false,
        lastStatus: 503,
        lastChecked: iso(20 * 60_000),
        addedAt: iso(30 * DAY_MS),
        lastResponseMs: 890,
        checks: 1204,
        checksUp: 1201,
      },
    },
  };
}

/** 30 days of daily buckets, in the shape `runPass` writes into history.json. */
function showcaseHistory() {
  const urls = {};
  for (const [url, checks, failures] of [
    ['https://kunde.dk/', 40, 0],
    ['https://shop.kunde.dk/', 40, 2],
  ]) {
    const days = {};
    for (let i = 0; i < 30; i++) {
      days[dayKey(i * DAY_MS)] = { checks, failures };
    }
    urls[url] = days;
  }
  return { version: 1, urls };
}

/** A throwaway HOME holding the showcase fixture, and the report it produces. */
function showcase(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-showcase-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, '.deskuptime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(showcaseState(), null, 2));
  writeFileSync(join(dir, 'history.json'), JSON.stringify(showcaseHistory(), null, 2));
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home } };
}

function report(env, args = []) {
  return run(process.execPath, [CLI, 'report', ...args], { env });
}

/**
 * The one thing in a report row that moves on its own: the clock.
 *
 * `Generated …` and the `Last check` cell are the report's own `now`, and the
 * fixture is stamped relative to the wall clock, so both advance every second.
 * A lock that pinned them would be a lock that goes red by itself — P1-93's
 * lesson, in the other direction: that one froze a literal so an age would not
 * drift, and this one would pin a live timestamp and go stale overnight.
 *
 * So the *clock* is normalized out and everything else is compared verbatim.
 * That is the honest division: a column that is renamed, a counter that
 * changes, a row that reorders, a cell that starts reading differently — all
 * of those are drift, and all of them still turn this red. Only the fact that
 * the report was generated at some moment on some day is let go.
 */
function withoutClock(text) {
  return text.replace(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})? UTC/g, '<time>');
}

test('showcase-fixturen er den tilstand den er kaldt', async (t) => {
  const { env } = showcase(t);
  const { stdout } = await report(env, ['--json']);
  const data = JSON.parse(stdout);

  // The fixture is only a demonstration if the report read it. A state shape the
  // command ignores would render a picture of a report the tool cannot make, and
  // the tests below would then lock that picture in as though it were real.
  const byUrl = new Map(data.sites.map(s => [s.url, s]));
  const up = byUrl.get('https://kunde.dk/');
  const down = byUrl.get('https://shop.kunde.dk/');
  assert.ok(up && down, `fixtureen er ikke læst: ${data.sites.map(s => s.url).join(', ')}`);

  assert.equal(up.status, 'up');
  assert.equal(down.status, 'down');
  assert.equal(down.statusCode, 503);
  assert.equal(up.windowRecordedDays, 30, 'kunde.dk skal have 30 registrerede døgn');
  // 30 days x 40 checks, 2 of them failing.
  assert.equal(down.window.checks, 1200);
  assert.equal(down.window.failures, 60);
  assert.equal(up.window.failures, 0);
  // The counts came out of the counters the fixture wrote, not out of thin air.
  // `failures` is the field the report reads; `checksUp` is written by the pass
  // but the report derives the share from `failures`, so a fixture that only
  // got `checksUp` right would look right here and print 100% on a failing site.
  assert.equal(up.checks, 1204);
  assert.equal(up.failures, 1);
  assert.equal(down.failures, 3);
  assert.equal(down.uptimePercent, 99.75);
});

test('README viser den rapport, kommandoen faktisk laver', async (t) => {
  const { env } = showcase(t);
  const { stdout } = await report(env, ['--title', 'Acme — uptime September']);
  const lines = stdout.split('\n');
  const readme = withoutClock(README);

  // Read every line the showcase pastes, not just the table. A report's own
  // provenance line — who made it, and that it was the Pro build — is the one
  // thing a reader cannot check for themselves, because the whole point is that
  // they did not run it. So it is compared like the rest: measured once, M8
  // showed that dropping `Pro` from `DeskUptime Pro (DeskUptime CLI)` left this
  // file entirely green, which would have let a paid document go out wearing
  // the free product's name without a sound.
  //
  // Scoped to the report's *head*: title, `Generated` line and the summary.
  // The long explanatory paragraph that follows the table is not pasted, and
  // this is not a licence to check it — the README summarises it in prose
  // instead, so the lock is on the lines a reader would check against a run.
  const showcaseStart = README.indexOf('A real run, pasted as it came:');
  assert.ok(showcaseStart > -1, 'README har ingen indsat rapport');
  const block = README.slice(showcaseStart);
  const blockEnd = block.indexOf('```', block.indexOf('```') + 3);
  const pasted = withoutClock(block.slice(0, blockEnd));
  const tableStart = lines.findIndex(l => l.startsWith('| Site | Status |'));
  assert.ok(tableStart > -1, `rapporten har ingen tabel:\n${stdout}`);
  for (const line of lines.slice(0, tableStart)) {
    if (!line.trim()) continue;
    assert.ok(
      pasted.includes(withoutClock(line)),
      `README's eksempel er ikke den rapporten laver. Mangler linjen:\n${line}`,
    );
  }

  // The whole table, verbatim, table header included. A README that renames a
  // column, drops a row or reorders them stops matching here.
  const table = lines.slice(tableStart, tableStart + 4);
  for (const line of table) {
    assert.ok(
      readme.includes(withoutClock(line)),
      `README's eksempel er ikke den rapporten laver. Mangler linjen:\n${line}\n\n` +
      `Lav den rigtige med: deskuptime report --title "Acme — uptime September"`,
    );
  }
  assert.equal(table.length, 4, `forventede overskrift + separator + 2 rækker, fik ${table.length}`);

  // Both sites, so the showcase cannot quietly drop the failing one — that row
  // is the reason a bureau forwards the document.
  assert.ok(README.includes('https://shop.kunde.dk/'), 'README mangler det nedbrudte site');
  assert.ok(README.includes('DOWN (503)'), 'README viser ikke et nedbrud, så eksemplet lærer intet');
  // And the cells a bureau reads first: a response time and a content reading.
  // A showcase that only ever prints `—` teaches the reader that the columns
  // are empty, which is the opposite of what a mature report looks like.
  assert.match(readme, /\|\s*142 ms\s*\|/, 'README viser ingen målt responsetid');
  assert.match(readme, /18,?402 bytes|18402 bytes/, 'README viser ingen læst sidestørrelse');

  // The summary line, which is the first thing read and the last thing a bureau
  // is asked to defend. It is the one line that survives being pasted into an
  // email, so it is the one most likely to drift away from what the tool says.
  const summary = lines.find(l => /^\*\*\d+ site\(s\)/.test(l));
  assert.ok(summary, `rapporten har ingen resumelinje:\n${stdout}`);
  assert.ok(
    readme.includes(withoutClock(summary)),
    `README's resumelinje er ikke den rapporten laver:\n${summary}`,
  );
});

test('README navner report som en kommando, ikke bare som en tabelrække', () => {
  // Before the fix: zero occurrences of the command itself. The matrix row is
  // generated from src/features.js and says the feature exists, not what it is.
  assert.match(README, /deskuptime report\s+--title/, 'README har ingen kommando at kopiere');
  assert.match(README, /deskuptime report\s+--days/, 'README viser ikke hvordan vinduet vælges');
  assert.match(README, /deskuptime report\s+--json/, 'README viser ikke JSON-vejen');
});

test('README peger på rapportspecifikationen, som ingen flade pegede på før', () => {
  // Matched as a real Markdown link, href *and* text. A bare
  // `includes('docs/agency-report.md')` is satisfied by the href alone, so a
  // link whose visible words named a different document still passed — M9
  // measured that, and a reader follows the words, not the target.
  const links = [...README.matchAll(/\[([^\]]*)\]\((docs\/[^)]+|\.\/docs\/[^)]+)\)/g)];
  const toSpec = links.filter(([, , href]) => /docs\/agency-report\.md$/.test(href));
  assert.ok(toSpec.length > 0, 'README har intet link til docs/agency-report.md — 415 linjer spec ingen kundeflade nåede');
  for (const [, text, href] of toSpec) {
    assert.ok(
      text.includes('agency-report'),
      `linket peger på ${href}, men teksten siger "${text}" — en læser følger ordene, ikke målet`,
    );
  }
  // The spec must exist, or the link is a promise about a file that is not there.
  assert.ok(readFileSync(SPEC, 'utf8').includes('# Client report'), 'specifikationen mangler eller er tom');
});

test('eksemplet siger at et vindue fyldes af passes — ikke at et tal altid er 30 dage', () => {
  // A reader who just added a site has one day of history today. If the README
  // implies the window is already full, the first real report they produce
  // reads as a broken product rather than as a young one.
  assert.match(
    README,
    /30 recorded d|recorded d/,
    'README forklarer ikke hvad "recorded d" tæller',
  );
  assert.match(
    README,
    /(fylles|fyldes|hver dag|dag for dag|one more|efter hver)/i,
    'README siger ikke at rapporten vokser med de passes watch laver',
  );
});

test('README rører ikke ved de flader der er genereret', () => {
  // The showcase sits between two GENERATED blocks. If it ever lands inside one,
  // `tools/matrix.mjs` will overwrite it and the README will lose the flagship
  // feature without a word — which is the failure this whole file exists to stop.
  const matrix = README.indexOf('<!-- BEGIN GENERATED: matrix -->');
  const matrixEnd = README.indexOf('<!-- END GENERATED: matrix -->');
  const license = README.indexOf('<!-- BEGIN GENERATED: license data -->');
  const licenseEnd = README.indexOf('<!-- END GENERATED: license data -->');
  assert.ok(matrix > -1 && matrixEnd > matrix, 'matrix-blokken er ikke findelig');
  assert.ok(license > -1 && licenseEnd > license, 'licens-blokken er ikke findelig');

  const showcaseAt = README.indexOf('## Client report (Pro)');
  assert.ok(showcaseAt > -1, 'README har ingen Client report-sektion');
  assert.ok(
    showcaseAt > matrixEnd && showcaseAt < license,
    'Client report-sektionen ligger inde i en genereret blok og bliver overskrevet',
  );
});
