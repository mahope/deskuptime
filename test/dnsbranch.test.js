/**
 * P1-73 — the one function that turns a `fetch` failure into a sentence threw
 * instead of describing, and its DNS redaction had no lock.
 *
 * P1-72 measured its own mutations and found one that survived: removing
 * `scrubUrlCredentials()` from `describeFetchError`'s `dns_error` branch kills
 * no test. That is a *missing lock* rather than a bug — but the plan asked for
 * the question to be answered by measurement first, and the measurement turned
 * up a real defect three lines above the lock.
 *
 * ── Målt 2026-09-28, nul kode ændret, rigtig `fetch` på Node 22.23.2 og 26.7.0 ──
 *
 * *Spørgsmålet fra P1-73: kan en `ENOTFOUND`/`EAI_AGAIN`-sætning overhovedet
 * citere en URL med credentials i?* Svaret er **nej**, og det er målt på to
 * uafhængige måder:
 *
 *   1. Sætningen citerer kun værten. `fetch('http://kunde.dk/')` mod en adresse
 *      der ikke findes giver `cause.code = 'ENOTFOUND'` og
 *      `cause.message = 'getaddrinfo ENOTFOUND kunde.dk'` — ingen adresse, ingen
 *      sti, ingen query. Værten kan heller ikke *rumme* credentials: `new URL()`
 *      flytter alt før det sidste `@` over i `username`/`password`, så det der
 *      står tilbage i `message` er præcis det, `getaddrinfo` fik at slå op.
 *   2. En credentialed adresse bliver aldrig spurgt om i resolveren. En adresse
 *      brugeren *skrev* bliver afvist, før der laves noget som helst:
 *      `TypeError: Request cannot be constructed from a URL that includes
 *      credentials: …` — uden `cause`, uden kode, ingen DNS. En adresse vi kun
 *      når ved at følge et redirect bliver afvist af `undici`s cross-origin-gate
 *      (P1-72), også før der connectes. P1-45 lukker desuden den skrevne adresse
 *      på alle fire kommandoer, så der er ingen vej ind.
 *
 * Altså: skrubningen i denne gren er i dag en no-op på begge runtimes. Den bliver
 * **beholdt som lås** — den er P1-71's, den koster intet, og «det kan ikke ske»
 * er præcis den begrundelse, der fjerner et lås lige før den runtime der bryder
 * det kommer. Den første test her dør, hvis kaldet forsvinder.
 *
 * ── Og målingen fandt den rigtige fejl ──
 *
 * Koden læste koden fra `cause?.code || error?.code` men sætningen fra
 * `cause.message` — ubeskyttet. Så en fejl, der bærer sin kode på sig selv i
 * stedet for på sin `cause`, fik:
 *
 *   $ node -e "describeFetchError({ code: 'ENOTFOUND' })"
 *   TypeError: Cannot read properties of undefined (reading 'message')
 *
 * ..inde i den funktion, hvis eneste opgave er at beskrive fejl. Og
 * `|| 'Host could not be resolved'` ved siden af kunne aldrig nås: det er den
 * læsning, der skulle have produceret den tomme streng, der kastede først. Den
 * var altså ikke en reservering, den var død kode der læstes som en reservering.
 *
 * Det er **ikke** nået fra CLI'en i dag, og det er målt, ikke håbet: otte rigtige
 * `fetch`-fejl på begge runtimes (refused, to abort-former, uløseligt navn, uløseligt
 * navn efter et hop, TLS mod en plain server, `file:`-skema, redirect til
 * `file:`) har alle en `cause`, og de to der ikke har, er abort-formerne, som er
 * matchet på *navn* længere oppe. Funktionen er eksporteret og skal være
 * total: en funktion der kaster mister sætningen, klassen og dermed hele
 * resultatet, fordi `toNetworkResult()` kaldes *inde i* den `catch` der frembragte
 * fejlen.
 *
 * Hvad der ikke flytter sig: dommen, exit-koden, JSON-formen, `errorType` og de
 * fire egne sætninger. `test/credentialsentence.test.js` låser dem tegn for tegn,
 * og de står urørt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { checkReachability } from '../src/checkers/ping.js';
import { describeFetchError } from '../src/status.js';

const PASSWORD = 'sup3rsecret';

/** Den adresse, `fetch` skriver i sin egen sætning, når resolveren svarer. */
const CREDENTIALED = `http://demo:${PASSWORD}@kunde.dk/staging`;

// ── Låsen på skrubningen i `dns_error`-grenen ─────────────────────────────────

test('en DNS-sætning med credentials i bliver renset — låsen på P1-71 i denne gren', () => {
  // Kan ikke ske med `fetch` i dag (målt ovenfor, og på begge runtimes) — det er
  // netop derfor den skal låses: et kald, der intet kan se, bliver fjernet af
  // næste person der læser «det kan ikke ske» og stoler på det.
  const described = describeFetchError({
    name: 'TypeError',
    message: 'fetch failed',
    cause: { code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${CREDENTIALED}` },
  });
  assert.equal(described.errorType, 'dns_error', 'klassen er et navn der ikke findes, uanset hvad sætningen citerer');
  assert.equal(described.error, 'getaddrinfo ENOTFOUND http://kunde.dk/staging', 'kun brugerinfo forsvinder — resten af sætningen er resolverens');
  assert.doesNotMatch(described.error, new RegExp(PASSWORD), 'adgangskoden må ikke nå de seks flader');

  // Samme gren, kode på fejlen i stedet for på `cause` — den form der lige var en
  // TypeError. Den skal renses lige såvel som klassificeres.
  const onTheError = describeFetchError({ code: 'EAI_AGAIN', message: `getaddrinfo EAI_AGAIN ${CREDENTIALED}` });
  assert.equal(onTheError.errorType, 'dns_error');
  assert.doesNotMatch(onTheError.error, new RegExp(PASSWORD));
});

// ── Beskriveren kaster aldrig ─────────────────────────────────────────────────

test('en fejl vi kun kan læse koden i, beskrives stadig', () => {
  // Før: TypeError inde i `describeFetchError`. Nu: klassen fra koden og den
  // reserverede sætning, der aldrig kunne nås.
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    assert.deepEqual(
      describeFetchError({ code }),
      { errorType: 'dns_error', error: 'Host could not be resolved' },
      `${code} på fejlen uden nogen sætning`,
    );
    assert.deepEqual(
      describeFetchError({ code, cause: null }),
      { errorType: 'dns_error', error: 'Host could not be resolved' },
      `${code} med en cause, der er null`,
    );
  }
  assert.deepEqual(describeFetchError({ code: 'ENOTFOUND', cause: { message: '' } }), { errorType: 'dns_error', error: 'Host could not be resolved' });
});

test('de klasser, der ikke læser sætningen, er urørt', () => {
  // De to afbrydelsesformer bærer deres kode som et *tal* (DOMException 23/20,
  // målt) og ingen `cause` overhovedet. De er matchet på navn, og det skal
  // fortsat være dem, der afgør dommen — ikke et tal der ligner en kode.
  assert.deepEqual(describeFetchError({ name: 'TimeoutError', code: 23 }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ name: 'AbortError', code: 20 }), { errorType: 'timeout', error: 'Request timed out' });
  assert.deepEqual(describeFetchError({ code: 'ECONNREFUSED' }), { errorType: 'connection_refused', error: 'Connection refused' });
  assert.deepEqual(describeFetchError({ code: 'UND_ERR_CONNECT_TIMEOUT' }), { errorType: 'timeout', error: 'Request timed out' });
});

// ── Den målte kunderejse: rigtig `fetch` gennem den rigtige checker ───────────

test('et navn der ikke findes, stadig hedder dns_error gennem checkReachability', async (t) => {
  // `.invalid` er reserveret i RFC 2606 og kan aldrig findes, så dette er en rigtig
  // resolverfejl og ikke en stub. Går den gennem et rigtigt hop, så det er præcis
  // den kode `check` sender i hverdagen, der beskrives — ikke en håndlavet fejl.
  const hop = createServer((req, res) => {
    res.writeHead(302, { location: 'http://nonexistent-host-zzz.invalid/staging' });
    res.end();
  });
  t.after(() => hop.close());
  const port = await new Promise((r) => hop.listen(0, '127.0.0.1', () => r(hop.address().port)));

  const result = await checkReachability(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 });

  if (result.errorType === 'timeout') {
    // Uden resolver overhovedet (et lukket CI-miljø) siger fejlen ingenting om
    // klassen. Så springes den, og låsen ovenfor står alene.
    t.skip('ingen resolver i dette miljø — klassen kan ikke måles');
    return;
  }

  assert.equal(result.reachable, false, 'der kom aldrig et svar, så sitet er umålbart');
  assert.equal(result.healthy, false);
  assert.equal(result.errorType, 'dns_error', `klassen skal være dns_error:\n${result.error}`);
  assert.match(result.error, /^getaddrinfo (ENOTFOUND|EAI_AGAIN) /, `resolverens egen sætning er den informative:\n${result.error}`);
  assert.doesNotMatch(result.error, new RegExp(PASSWORD));
  assert.equal(result.responseTimeMs, null, 'vi ventede ikke på svar — der kom ikke et');
});
