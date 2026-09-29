/**
 * P1-114 — `unwatch` sagde "alt gik" om et kald, hvor en adresse ikke var overvåget.
 *
 * Målt 2026-09-29 med rigtig CLI, rigtig state-fil, egen HOME, ingen kode ændret.
 * Bureauet har tre af de tre gratis-pladser i brug og afmelder tre kunder — den
 * tredje adresse med en skrivefejl:
 *
 *   $ deskuptime unwatch http://k1.dk/ http://k2.dk/ http://k3.dk/.typo
 *   ✅ No longer monitoring: http://k1.dk/
 *   ✅ No longer monitoring: http://k2.dk/
 *      1 URL(s) still monitored. Its uptime history is kept (35 days) …
 *   ❌ Error: not monitored: http://k3.dk/.typo
 *
 *   exit-kode ...................... 0   (0 = alt gik)
 *   pladser faktisk frigjort ....... 2 af 3
 *
 * **Det er det sjette skikkelse af den sygdom planen har målt fem gange:**
 * bygget kode ingen kunde kan se (P1-91), et flag ingen flade nævner (P1-108), en
 * ref der ikke findes (P1-107), en tabelrække der står i stedet for en
 * demonstration (P1-111), en tabelrække koden modstår (P1-113) — og nu en
 * exit-kode der modsiger den fejl den står lige over sig.
 *
 * **De to andre kommandoer med flere URL'er har allerede reglen.** Samme måling,
 * samme spørgsmål, kun den tredje kommando:
 *
 *   check   (1 op, 1 død) ............. exit 2
 *   headers (1 op, 1 død) ............. exit 2
 *   unwatch (1 fjernet, 1 ukendt) ..... exit 0   <-- den afvigende
 *
 * `src/cli.js` gør det med én linje: `removed.length > 0 ? 0 : 1`. Den spørger
 * *kom der noget fjernet* i stedet for *blev alle fjernet*, så **den mindst
 * alvorlige udgang bestemmer koden** — præcis den fejl P1-113 rettede i `headers`,
 * hvor den sidste URL's domme havde stået for alle.
 *
 * **Hvad det koster kunden.** `unwatch` er den eneste vej ud af en brugt plads.
 * Et bureau-script der afmelder en kunde ad gangen og tæller frie pladser på
 * exit-koden regner nu 3 pladser frigjort, når der er frigjort 2, og den næste
 * `watch` bliver afvist af gratisvæggen med en fejl der peger på *overvågning*
 * — altså på den kommando de lige kørte korrekt. De to gratis-lister siger
 * ellers hvor tæt brugeren er på væggen (P1-109); det er den her sti, hvor
 * brugeren ikke får at vide at de regner forkert.
 *
 * **Reglen der låses, i klare ord:** `unwatch` er exit 0 kun når **alle** de
 * bedte adresser faktisk holdt op at være overvåget. Går ét af dem ikke, er
 * koden den `check` og `headers` allerede bruger — **2** — fordi kommandoen
 * kørte, gjorde sit arbejde for den del den kunne, og **noget** i kaldet fejlede.
 * Exit 1 er uændret: den betyder "ingenting blev fjernet", og den låses også her,
 * fordi den er den anden halvdel af samme sandhed.
 *
 * Låsen er adfærdsmålt, ikke en påstand om en linje kildekode: rigtig CLI,
 * rigtig state-fil, rigtige exit-koder læst af `execFile`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

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

/** Tre overvågede sites i en temp HOME — den gratis tiers fulde kapacitet. */
function withThree(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-unwatchpartial-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const urls = ['http://k1.dk/', 'http://k2.dk/', 'http://k3.dk/'];
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({
    urls: Object.fromEntries(urls.map(url => [url, { addedAt: new Date().toISOString(), wasUp: true, checks: 3, checksUp: 3 }])),
  }));
  return { home, urls, dir: join(home, '.deskuptime') };
}

const watched = (dir) => Object.keys(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')).urls);

test('en adresse der ikke var overvåget gør exit 2, selv når de andre blev fjernet', async (t) => {
  const { home, dir } = withThree(t);

  const result = await run(['unwatch', 'http://k1.dk/', 'http://k2.dk/', 'http://k3.dk/.typo'], { env: { HOME: home, USERPROFILE: home } });

  // Fejlen er stadig den samme sætning på stderr, og de to rigtige er stadig
  // fjernet — rettelsen rører hverken sætningen eller arbejdet.
  assert.match(result.stdout, /No longer monitoring: http:\/\/k1\.dk\//);
  assert.match(result.stdout, /No longer monitoring: http:\/\/k2\.dk\//);
  assert.match(result.stderr, /not monitored: http:\/\/k3\.dk\/\.typo/);
  assert.deepEqual(watched(dir).sort(), ['http://k3.dk/']);

  // Det er her låsens kjerne lå: før var dette 0, og et script der tæller frie
  // pladser på exit-koden fik 3 for 2.
  assert.equal(result.code, 2, `exit ${result.code} — et kald hvor en adresse ikke var overvådet må ikke se grønt ud`);
});

test('exit 1 er uændret den betyder "ingenting blev fjernet"', async (t) => {
  const { home, dir } = withThree(t);

  const result = await run(['unwatch', 'http://aldrig1.dk/', 'http://aldrig2.dk/'], { env: { HOME: home, USERPROFILE: home } });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /not monitored: http:\/\/aldrig1\.dk\//);
  assert.match(result.stderr, /not monitored: http:\/\/aldrig2\.dk\//);
  assert.deepEqual(watched(dir).sort(), ['http://k1.dk/', 'http://k2.dk/', 'http://k3.dk/']);
});

test('alle bedte adresser var overvågede: exit 0, som før', async (t) => {
  const { home, dir, urls } = withThree(t);

  const result = await run(['unwatch', ...urls], { env: { HOME: home, USERPROFILE: home } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(watched(dir), []);
});

test('ét site: exit 1 for et ukendt site og exit 0 for et kendt, som før', async (t) => {
  const { home, dir } = withThree(t);

  const unknown = await run(['unwatch', 'http://k1.dk/'], { env: { HOME: { ...process.env, HOME: home } } });
  assert.equal(unknown.code, 1);
  assert.deepEqual(watched(dir).sort(), ['http://k1.dk/', 'http://k2.dk/', 'http://k3.dk/']);

  const known = await run(['unwatch', 'http://k2.dk/'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(known.code, 0);
  assert.deepEqual(watched(dir).sort(), ['http://k1.dk/', 'http://k3.dk/']);
});

test('to delvist fejlede oprydninger efterlader præcis de pladser de frigjorde — og siger det', async (t) => {
  // Den kundemæssige halvdel. Bureauet rydder kunder op i to kald, begge med en
  // skrivefejl i én adresse. Før lavede exit-koden hvert af dem grønt, så
  // scriptet, der tæller frie pladser på exit-koden, fik 4 af 2. Nu må spørgsmålet
  // besvares af `watch --status`, der tæller rigtigt.
  const { home, dir } = withThree(t);

  const first = await run(['unwatch', 'http://k1.dk/', 'http://k2.dk/.typo'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(first.code, 2, `første kald: exit ${first.code}`);
  assert.match(first.stdout, /No longer monitoring: http:\/\/k1\.dk\//);
  assert.match(first.stderr, /not monitored: http:\/\/k2\.dk\/\.typo/);

  const second = await run(['unwatch', 'http://k3.dk/', 'http://gammel-kunde.dk/'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(second.code, 2, `andet kald: exit ${second.code}`);

  // To af de tre pladser er frigjort, og listen siger det — exit-koden lægger
  // ikke længere til, og den sletter heller ikke det arbejde, kommandoen lavede.
  const status = await run(['watch', '--status'], { env: { HOME: home, USERPROFILE: home } });
  assert.equal(status.code, 0);
  assert.match(status.stdout, /📋 1 monitored URL\(s\)/);
  assert.match(status.stdout, /http:\/\/k2\.dk\//);
  assert.doesNotMatch(status.stdout, /k1\.dk|k3\.dk/);
  assert.deepEqual(watched(dir), ['http://k2.dk/']);
});
