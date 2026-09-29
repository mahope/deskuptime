/**
 * P1-110 — one state file, three numbers, two screens, and the user cannot tell
 * which one the limit is enforced with.
 *
 * P1-109 put the free tier's ceiling where the user could see it:
 * `Free tier: 1 of 3 URL slots in use.` That line is measured against
 * `monitoredCount()`, the same owner `addMonitoredUrls()` refuses on, because
 * the two spellings of one site are two saved keys and one site. What the
 * measurement also showed — and P1-109's fix made *more* visible, not less — is
 * that both list headers still printed the other number. Real CLI, one site
 * saved in both spellings a browser's address bar produces:
 *
 *   $ deskuptime watch --status
 *   📋 2 monitored URL(s):
 *     ✅ up  https://kunde.dk (—) @ 2026-09-29T00:00:00.000Z
 *     ✅ up  https://kunde.dk/ (—) @ 2026-09-29T00:00:00.000Z
 *   Free tier: 1 of 3 URL slots in use.
 *
 *   $ deskuptime status
 *   Monitored URLs (2):
 *     ✅ https://kunde.dk
 *     ✅ https://kunde.dk/
 *
 * A header reading `2` sits directly above a line reading `1 of 3`, and a
 * customer reading the header concludes the board is two-thirds full when the
 * wall is a third full — the same "a number that is a limit, printed as a plain
 * count" that P1-104 and P1-109 removed from two other screens.
 *
 * The fix is one owner, `monitoredSizeNote()` in `src/watch.js`, next to
 * `monitoredCount()`. It returns `null` when the two counts agree, so a normal
 * file — one key per site — prints byte-for-byte what it printed before; only a
 * file that disagrees names both numbers and says which is which.
 *
 * The lock below is deliberately behavioural: it runs the real CLI against a
 * real state file and requires the two screens and the wall to agree, so a fix
 * that hardcodes one of the numbers cannot pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FREE } from '../src/features.js';
import { getStateFile, monitoredCount, monitoredSizeNote } from '../src/watch.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** One site, two spellings: the trailing slash is what an address bar shows. */
const A = 'https://kunde.dk/';
const A_NOSLASH = 'https://kunde.dk';
const B = 'https://kunde.dk/b/';
/** Not an address at all — P1-40 made it a row, and it holds no slot. */
const NOT_A_URL = 'kunde.dk';

function healthy() {
  const at = new Date().toISOString();
  return {
    wasUp: true,
    lastStatus: 200,
    lastChecked: at,
    addedAt: at,
    checks: 12,
    checksUp: 12,
    lastContentReadAt: at,
    lastHash: 'a'.repeat(64),
    lastContentLength: 4096,
    sslValidDays: 89,
  };
}

const urls = list => Object.fromEntries(list.map(url => [url, healthy()]));

function homeWith(t, keys) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-listsize-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 1, urls: urls(keys) }, null, 2));
  return { ...process.env, HOME: home, USERPROFILE: home };
}

function run(env, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

// ───────────────────────────────────── den målte mangel, låst på de rigtige flader

test('begge lister navnginer begge tal, når de er uenige', async (t) => {
  const env = homeWith(t, [A, A_NOSLASH, B]);

  const list = await run(env, ['watch', '--status']);
  const status = await run(env, ['status']);

  for (const [name, out] of [['watch --status', list.stdout], ['status', status.stdout]]) {
    assert.match(out, /3 saved entries — 2 monitored sites/,
      `${name} skrev ikke hvad filen indeholder: ${out}`);
    // The number that holds a slot has to be in the header too, or the user is
    // back to guessing which of the two the wall uses.
    assert.match(out, new RegExp(`2 of ${FREE.urlLimit} URL slots|2 monitored sites`),
      `${name} nævner ikke site-antallet: ${out}`);
  }
});

test('den normale fil er uændret — én nøgle pr. site skriver det den altid har', async (t) => {
  const env = homeWith(t, [A, B]);

  const list = await run(env, ['watch', '--status']);
  const status = await run(env, ['status']);

  assert.match(list.stdout, /^📋 2 monitored URL\(s\):/m,
    `listens overskrift ændrede sig uden grund: ${list.stdout}`);
  assert.match(status.stdout, /^Monitored URLs \(2\):$/m,
    `status' overskrift ændrede sig uden grund: ${status.stdout}`);
});

test('en nøgle der ikke er en adresse tælles ikke som et site, og siger det', async (t) => {
  const env = homeWith(t, [A, NOT_A_URL]);

  const list = await run(env, ['watch', '--status']);

  assert.match(list.stdout, /📋 2 saved entries — 1 monitored site:/,
    `en ubrugelig nøgle blev trykt som et overvåget site: ${list.stdout}`);
  // Unchanged: the slot line was already right about this one, and it must not
  // be the header that now claims two monitored URLs.
  assert.match(list.stdout, new RegExp(`Free tier: 1 of ${FREE.urlLimit} URL slots in use`),
    `slotlinjen og overskriften kan ikke være uenige: ${list.stdout}`);
});

// ───────────────────────────────────────────── de to tal kommer fra én ejer

test('overskriften, slotlinjen og afvisningen er tre flader af én tæller', async (t) => {
  // The strongest form of the lock: it never reads the numbers out of the output
  // to decide what they should be. `monitoredCount()` is the owner the wall
  // enforces with, so every surface has to print that number — whichever way the
  // file was spelled.
  const cases = [
    { keys: [A, A_NOSLASH, B, 'https://anden.dk/'], entries: 4, sites: 3 },
    { keys: [A, A_NOSLASH, NOT_A_URL], entries: 3, sites: 1 },
    { keys: [A, B], entries: 2, sites: 2 },
  ];

  for (const { keys, entries, sites } of cases) {
    const env = homeWith(t, keys);
    const state = { urls: urls(keys) };
    assert.equal(monitoredCount(state), sites, `ejeren er ikke ${sites} for ${keys.join(', ')}`);

    const note = monitoredSizeNote(state);
    if (entries === sites) {
      assert.equal(note, null, `enige tal skal ikke få en note: ${note}`);
    } else {
      assert.equal(note, `${entries} saved entries — ${sites} monitored site${sites === 1 ? '' : 's'}`,
        `ejeren skrev "${note}" for ${keys.join(', ')}`);
    }

    const list = await run(env, ['watch', '--status']);
    const status = await run(env, ['status']);
    // The wall never uses the entry count, and it never claims the ceiling is
    // reached while `deskuptime watch` would still accept a URL.
    const atWall = sites >= FREE.urlLimit;
    // `freeSlotsNote` has two forms for the same owner: a count below the
    // ceiling, and the wall itself. Both carry the same number.
    const wall = new RegExp(atWall
      ? `all ${FREE.urlLimit} URL slots in use`
      : `Free tier: ${sites} of ${FREE.urlLimit} URL slots in use`);
    assert.match(list.stdout, wall,
      `slotlinjen tæller ikke som ejeren for ${keys.join(', ')}: ${list.stdout}`);
    if (!atWall) {
      assert.ok(!new RegExp(`all ${FREE.urlLimit} URL slots`).test(list.stdout),
        `væggen erklæret på ${sites} af ${FREE.urlLimit} pladser: ${list.stdout}`);
    }
    for (const [name, out] of [['watch --status', list.stdout], ['status', status.stdout]]) {
      assert.ok(out.includes(String(sites)) && out.includes(String(entries)),
        `${name} nævner ikke begge tal for ${keys.join(', ')}: ${out}`);
    }
  }
});
