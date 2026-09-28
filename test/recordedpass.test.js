/**
 * P1-104: "no `lastChecked`" was read as "no pass has ever run", on a state file
 * whose own counter said 50 passes had.
 *
 * Measured 2026-09-28 with the real CLI, a real local server and a real state
 * file. One site, checked 50 times by a real pass, with only the *time* of the
 * last pass gone — what a hand-edited file, a restore from a backup and a merge
 * between two tools all produce, because `lastChecked` is the only one of the
 * three fields a pass writes that can be lost on its own:
 *
 *   status    · https://kunde.dk/ (200) — SSL 89d — not checked yet
 *   watch     ⚠️  Never checked: no pass has ever measured them
 *   report    | https://kunde.dk/ | not checked yet | 100% (50 checks) | … |
 *              ^ the same row, in the document an agency forwards, saying both
 *
 * And a site that *was* checked and is merely unplaceable in time said nothing
 * at all: no age, no stale marker, no warning that monitoring may have stopped —
 * because the one reason for leaving it out of the stale block was that the
 * report already called it "not checked yet", and that call was the false one.
 *
 * The cause is that one question — has a pass ever run here? — was answered from
 * one of the three fields that answer it. `wasUp` (the verdict a pass measured)
 * and `checks` (the counter `recordPass` keeps) both survive a missing stamp;
 * neither can exist without a pass. So the fix is a single owner,
 * `hasRecordedPass`, asked by both row builders instead of by the field, and
 * `isCheckStale` learns the same fact so the second half follows: a pass we
 * cannot place in time is stale, never "never checked".
 *
 * The tests below run the real CLI over a real pass and a real state file,
 * because the bug is a *claim about the past* made in prose: only the surfaces
 * can show it, and only a file a real pass wrote shows what a real pass leaves
 * behind when one field is lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRecordedPass, isCheckStale } from '../src/status.js';
import { tempHome } from './helpers/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');

function run(args, options) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, ...options, DUB_STUB_SCENARIO: 'passthrough' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

/**
 * A Pro record, so the paid surface can be read too. The stored record is all
 * the client report asks for — `validate` is never called, which is exactly what
 * a machine that activated once carries. No license API is contacted.
 */
function asPro(state) {
  state.license = {
    key: '0123456789abcdef0123456789abcdef',
    instance: 'deskuptime-p104',
    plan: 'pro',
    status: 'active',
    validatedAt: new Date().toISOString(),
  };
  return state;
}

/** A site that answers 200, on a port that lives as long as the test. */
async function site(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Kunde</title></head><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/`;
}

/**
 * A real pass over a real site, then the one field that can be lost on its own
 * taken away — the state file the rest of these tests read.
 */
async function passWithoutItsTime(t, origin) {
  const { home, options, dir } = tempHome(t, 'deskuptime-p104-');
  const first = await run(['watch', origin, '--once'], options);
  assert.equal(first.code, 0, `watch fejlede: ${first.stdout}${first.stderr}`);

  const state = asPro(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')));
  const key = Object.keys(state.urls)[0];
  assert.equal(typeof state.urls[key].lastChecked, 'string', 'en rigtig pass skriver et tidspunkt');
  assert.equal(state.urls[key].checks, 1, 'og en tæller, der tæller passet med');
  delete state.urls[key].lastChecked;
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return { home, options, url: key };
}

test('de to lister siger ikke "not checked yet" om et site de har tjekket 50 gange', async t => {
  const origin = await site(t);
  const { options, url } = await passWithoutItsTime(t, origin);

  const status = await run(['status'], options);
  const watch = await run(['watch', '--status'], options);

  assert.match(status.stdout, new RegExp(`.*${url}.*`), `status skrev ikke rækken: ${status.stdout}`);
  assert.doesNotMatch(status.stdout, new RegExp(`${url}[^\\n]*not checked yet`),
    `status sagde "not checked yet" om et site der lige blev tjekket: ${status.stdout}`);
  assert.doesNotMatch(watch.stdout, new RegExp(`Never checked:[\\s\\S]*${url}`),
    `watch --status satte sitet i "Never checked": ${watch.stdout}`);

  // …and it is not silent either: a pass we cannot place in time is the one
  // thing the stale block exists for, and the second half of the same fix.
  assert.match(status.stdout, new RegExp(`${url}[^\\n]*stale — last check unreadable`),
    `status sagde intet om et pass den ikke kan placere: ${status.stdout}`);
  assert.match(watch.stdout, new RegExp(`No monitoring pass in the last 2 days[\\s\\S]*${url}`),
    `watch --status advarede ikke om et pass det ikke kan placere: ${watch.stdout}`);
});

test('kundenapporten kan ikke læse "not checked yet" og "100% (50 checks)" i den samme række', async t => {
  const origin = await site(t);
  const { options } = await passWithoutItsTime(t, origin);

  const report = await run(['report'], options);
  const row = report.stdout.split('\n').find(line => line.startsWith('| http'));
  assert.ok(row, `rapporten skrev ingen rækker: ${report.stdout}`);

  assert.doesNotMatch(row, /not checked yet/,
    `rækken siger både "not checked yet" og dens egen uptime: ${row}`);
  assert.match(row, /stale — last check unreadable/,
    `rækken siger heller ikke, at passet ikke kan placeres: ${row}`);

  const json = await run(['report', '--json'], options);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.summary.neverChecked, 0,
    `JSON'en tæller sitet som aldrig tjekket: ${json.stdout}`);
  assert.equal(parsed.summary.stale, 1, `og ikke som forældet: ${json.stdout}`);
  assert.equal(parsed.sites[0].passRecorded, true, `og JSON'en siger der var ingen passer: ${json.stdout}`);
  // The counter is the reason the claim was false, so it is the lock: if a pass
  // ever stops writing it, this test would pass for the wrong reason.
  assert.equal(parsed.sites[0].checks, 1);
});

test('et site uden ét eneste felt siger stadig "not checked yet", og er ikke forældet', async t => {
  const { home, options, dir } = tempHome(t, 'deskuptime-p104-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(asPro({
    version: 1,
    urls: { 'https://aldrig.dk/': { url: 'https://aldrig.dk/' } },
  }), null, 2));

  const status = await run(['status'], options);
  const watch = await run(['watch', '--status'], options);
  const report = await run(['report'], options);

  assert.match(status.stdout, /https:\/\/aldrig\.dk\/ — not checked yet/,
    `status mistede "not checked yet" for et site der aldrig er tjekket: ${status.stdout}`);
  assert.match(watch.stdout, /Never checked[\s\S]*https:\/\/aldrig\.dk\//,
    `watch --status mistede "Never checked": ${watch.stdout}`);
  assert.doesNotMatch(status.stdout, /https:\/\/aldrig\.dk\/[^\\n]*stale/,
    `et site der aldrig er tjekket, kan ikke være forældet: ${status.stdout}`);
  assert.match(report.stdout, /\| https:\/\/aldrig\.dk\/ \| not checked yet \| — \(no completed pass\)/,
    `rapporten mistede "not checked yet": ${report.stdout}`);
  assert.ok(home);
});

test('et beskadiget tidspunkt siger præcis som før — den har altid været ulæseligt', async t => {
  const { options, dir } = tempHome(t, 'deskuptime-p104-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(asPro({
    version: 1,
    urls: {
      'https://kunde.dk/': {
        url: 'https://kunde.dk/',
        wasUp: true,
        lastStatus: 200,
        lastChecked: 'not a date',
        checks: 50,
        checksUp: 50,
        sslValidDays: 89,
      },
    },
  }), null, 2));

  const status = await run(['status'], options);
  assert.match(status.stdout, /https:\/\/kunde\.dk\/[^\\n]*stale — last check unreadable/,
    `et beskadiget tidspunkt skal stadig være ulæseligt: ${status.stdout}`);
  const json = await run(['report', '--json'], options);
  assert.equal(JSON.parse(json.stdout).summary.neverChecked, 0);
});

test('harRecordedPass: de tre slags bevis, og de to der ikke er bevis', () => {
  // Each of the three is written by the same pass, and each can be the only one
  // left in a file that lost the others.
  assert.equal(hasRecordedPass({ lastChecked: '2026-09-28T10:00:00.000Z' }), true, 'the time itself');
  assert.equal(hasRecordedPass({ wasUp: true }), true, 'a verdict a pass measured');
  assert.equal(hasRecordedPass({ wasUp: false }), true, 'also a DOWN verdict — a pass measured that too');
  assert.equal(hasRecordedPass({ checks: 50, checksUp: 50 }), true, 'the pass counter');
  assert.equal(hasRecordedPass({ checks: 0, checksUp: 0 }), false, 'a counter at zero has counted nothing');

  // `wasUp: null` is what a pass that never ran leaves behind, so it is not
  // evidence; a non-boolean is an unreadable verdict, so the other two fields
  // are all that is left to say whether a pass happened.
  assert.equal(hasRecordedPass({}), false);
  assert.equal(hasRecordedPass({ url: 'https://kunde.dk/' }), false);
  assert.equal(hasRecordedPass({ wasUp: null }), false);
  assert.equal(hasRecordedPass({ wasUp: 'yes', checks: 12 }), true, 'the counter still says a pass ran');
  assert.equal(hasRecordedPass({ wasUp: 'yes' }), false, 'but an unreadable verdict alone does not');
  assert.equal(hasRecordedPass({ lastChecked: '' }), false, 'an empty string is not a time');
  assert.equal(hasRecordedPass(null), false);
  assert.equal(hasRecordedPass('kunde.dk'), false);
});

test('isCheckStale med kun et tidspunkt er uændret — den har altid kendt den gamle regel', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const days = n => new Date(now.getTime() - n * 86_400_000).toISOString();
  // A caller that holds nothing but a timestamp (`readTransitionAlert` asks
  // about a previous pass, not about a site) gets the old answer, and no
  // counter it never saw can overrule it.
  assert.equal(isCheckStale(undefined, now), false, 'no timestamp, no claim');
  assert.equal(isCheckStale('', now), false);
  assert.equal(isCheckStale('not a date', now), true, 'present but unreadable is stale');
  assert.equal(isCheckStale(days(41), now), true);
  assert.equal(isCheckStale(days(0.5), now), false);
  // The evidence only adds the case the old rule could not see.
  assert.equal(isCheckStale(undefined, now, { recorded: true }), true,
    'a pass with no time at all cannot be shown to be current');
  assert.equal(isCheckStale(undefined, now, { recorded: false }), false);
});
