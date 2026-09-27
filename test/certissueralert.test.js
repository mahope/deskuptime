/**
 * P1-66 — the paid channel could not say *who* vouched for the name, so a domain
 * that changed hands read as routine maintenance in the one place a bureau watches.
 *
 * P1-64 made a changed authority visible in the paid client report, and P1-65 in
 * the two free lists. Both named the same next surface, and it is the one that is
 * *sold*: `cert_rotated`, the `POST` to the customer's Slack, Discord or Teams
 * channel and the desktop notification behind it.
 *
 * Measured 2026-09-27, real `runPass`, real state file, a real HTTP receiver and
 * the real `sendWebhook`, before any code changed. Two passes over a site that
 * answers 200 in both; the only difference is which certificate — and which
 * authority — answered the second time:
 *
 *   cert_rotated  SSL certificate replaced — certificate rotated since the
 *                 certificate seen today
 *   state.json    sslIssuer=Rogue Cert BV  certIssuerBefore=Ganske Cloud A/S
 *
 * The report named both authorities (P1-64), both free lists named them (P1-65),
 * and the channel a paying customer reads said "the certificate was replaced"
 * and stopped. The day count argues against noticing: a reissued certificate
 * usually has *more* days left than the one it replaced, so a hijacked domain
 * arrives in the channel looking like the healthier of the two.
 *
 * The fix is the least one available: no new event type, no new payload field,
 * no new state. `readCertRotationAlert` takes the authority's own sentence from
 * `readCertIssuerState` — the same owner the report and both lists ask — and
 * places it as its own clause after the rotation's. Two facts, two sentences: a
 * routine 90-day renewal rotates the certificate from the *same* authority and
 * must still say nothing but "replaced", which is why the clause is not folded
 * into the rotation's wording.
 *
 * The owner is asked *after* `sslIssuer` is written and *before* the rotation is
 * compared, and that order is load-bearing rather than tidy. Asked before the
 * write, `readCertIssuerState` names the change as `sslIssuer` is the previous
 * value — measured on this fix's own first run, a channel told a customer the
 * authority had changed to itself: `(Ganske Cloud A/S → Ganske Cloud A/S)`. That
 * run is why the "→ the *new* authority" test below exists, and why the hoisting
 * is a sibling of the rotation branch and not a step inside it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeOutbox, getStateFile, printPass, runPass, sendWebhook } from '../src/watch.js';
import { CERT_ALERT_MIN_GAP_MS, readCertIssuerState, readCertRotationAlert } from '../src/status.js';
import { tempHome } from './helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SITE = 'https://kunde.dk/';
const BASE = new Date(Date.now() + 60_000);
const HOUR = 60 * 60 * 1000;
const OLD_AUTHORITY = 'Ganske Cloud A/S';
const NEW_AUTHORITY = 'Rogue Cert BV';
/** 64 hex characters, which is what `checkSSL` actually stores. */
const FINGERPRINT_A = 'aa'.repeat(32);
const FINGERPRINT_B = 'bb'.repeat(32);
const FINGERPRINT_C = 'cc'.repeat(32);

const at = ms => new Date(BASE.getTime() + ms);
const rotated = pass => pass.events.find(event => event.type === 'cert_rotated');
const messageOf = pass => rotated(pass)?.message ?? '';

/** A rotation reading, as the pass hands it over. */
const rotation = { verdict: 'rotated', compared: true, rotated: true, note: 'certificate rotated since the certificate seen today' };

/** A stubbed checker: one authority and one certificate per pass, in order. */
function checkAnswering(passes) {
  let n = 0;
  return url => {
    const reading = passes[Math.min(n, passes.length - 1)];
    n += 1;
    return {
      url,
      reachable: true,
      healthy: true,
      statusCode: 200,
      responseTimeMs: 12,
      finalUrl: url,
      content: { fetched: true, contentLength: 132, hash: `hash-${n}`, changed: null, title: 'Kunde' },
      ssl: {
        valid: true,
        validDays: 89,
        issuer: reading.issuer,
        fingerprint256: reading.fingerprint,
        serialNumber: '01',
      },
    };
  };
}

// ------------------------------------------------------------- the owner

test('uden en udsteder-sætning er alarmen tegn for tegn som før', () => {
  const before = 'SSL certificate replaced — certificate rotated since the certificate seen today';
  for (const issuerNote of [undefined, '', null, 0, false, {}, []]) {
    assert.equal(
      readCertRotationAlert({ rotation, issuerNote, now: at(0) }).message,
      before,
      `a routine renewal must not grow a clause: ${JSON.stringify(issuerNote)}`,
    );
  }
  // Whitespace is not a sentence — `certIssuerChangeNote` never returns one, but
  // the alert must not print a bare separator if a caller ever passes it.
  const padded = readCertRotationAlert({ rotation, issuerNote: '   ', now: at(0) }).message;
  assert.doesNotMatch(padded, /·\s*·|·\s*\(/, 'a separator with nothing after it is not a sentence');
});

test('en fornyelse fra SAMME udsteder siger intet om udstederen', () => {
  // The most common rotation there is: 90 days, same authority. It must read
  // exactly as it did before this iteration, or every renewal in every channel
  // becomes an alert about an authority that never changed.
  const entry = { sslIssuer: OLD_AUTHORITY, certIssuerBefore: OLD_AUTHORITY, certIssuerChangedAt: at(-2 * 86_400_000).toISOString() };
  assert.equal(readCertIssuerState(entry, { now: at(0) }).note, '', 'a stamp whose "before" is the current authority is not a change');
  const alert = readCertRotationAlert({ rotation, issuerNote: readCertIssuerState(entry, { now: at(0) }).note, now: at(0) });
  assert.equal(alert.message, 'SSL certificate replaced — certificate rotated since the certificate seen today');
});

test('et hijack-alarmenavner begge autoriteter, og den nye er den NUVÆRENDE', () => {
  // The regression the measurement caught: `sslIssuer` is written after the
  // comparison, so an owner asked too early names the old authority twice.
  const entry = {
    sslIssuer: NEW_AUTHORITY,
    certIssuerBefore: OLD_AUTHORITY,
    certIssuerChangedAt: at(0).toISOString(),
  };
  const note = readCertIssuerState(entry, { now: at(0) }).note;
  const message = readCertRotationAlert({ rotation, issuerNote: note, now: at(0) }).message;

  assert.equal(message, `SSL certificate replaced — certificate rotated since the certificate seen today · ${note}`);
  assert.match(message, new RegExp(`\\(${OLD_AUTHORITY} → ${NEW_AUTHORITY}\\)`), 'both names, in that order');
  assert.doesNotMatch(message, new RegExp(`\\(${NEW_AUTHORITY} → ${NEW_AUTHORITY}\\)`), 'an authority does not change to itself');
  assert.doesNotMatch(message, new RegExp(`\\(${OLD_AUTHORITY} → ${OLD_AUTHORITY}\\)`));
});

test('sætningen er ejeren ordret og ikke en ny sætning', () => {
  // Four surfaces, one sentence. The wording lives in `certIssuerChangeNote` and
  // nowhere else, so a customer reading their channel and a customer reading the
  // report their bureau forwards are reading the same words about the same event.
  const status = readFileSync(join(ROOT, 'src', 'status.js'), 'utf8');
  assert.equal(
    (status.match(/certificate answers from a different issuer/g) || []).length,
    2,
    'only the owner may write the sentence, once per form',
  );
  for (const file of ['watch.js', 'report.js', 'cli.js']) {
    const source = readFileSync(join(ROOT, 'src', file), 'utf8');
    assert.doesNotMatch(source, /certificate answers from a different issuer/, `${file} must not build the sentence itself`);
  }
  const watch = readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8');
  assert.match(watch, /readCertIssuerState\(entry, \{ now \}\)/, 'the pass asks the owner');
  assert.match(watch, /issuerNote: issuerState\.note/, 'and hands its words to the alert');
  // …and the words have to be read *after* the current issuer is stored, or the
  // sentence names the old authority on both sides.
  assert.ok(
    watch.indexOf('if (issuer) entry.sslIssuer = issuer;') < watch.indexOf('readCertIssuerState(entry, { now })'),
    'sslIssuer must be written before the owner is asked',
  );
});

test('et ur-skævt stempel skifter ikke ordet — det er stadig et urproblem', () => {
  // A stamp from the future is a clock problem, and the owner says so in its own
  // words. The alert does not get to tidy it into a confident "today".
  const ahead = at(6 * HOUR).toISOString();
  const note = readCertIssuerState({ sslIssuer: NEW_AUTHORITY, certIssuerBefore: OLD_AUTHORITY, certIssuerChangedAt: ahead }, { now: at(0) }).note;
  const message = readCertRotationAlert({ rotation, issuerNote: note, now: at(0) }).message;
  assert.match(message, /6 h ahead of this machine's clock/);
  assert.doesNotMatch(message, /answers from a different issuer today/);
});

test('en ulæselig læsning siger det samme som på rapporten', () => {
  const note = readCertIssuerState({ sslIssuer: NEW_AUTHORITY, certIssuerBefore: OLD_AUTHORITY, certIssuerChangedAt: 'not a date' }, { now: at(0) }).note;
  assert.equal(note, `🏢 certificate answers from a different issuer at an unreadable time (${OLD_AUTHORITY} → ${NEW_AUTHORITY})`);
  assert.match(readCertRotationAlert({ rotation, issuerNote: note, now: at(0) }).message, /at an unreadable time/);
});

test('en halv påstand er ingen påstand, så alarmen tier om udstederen', () => {
  // Same two rules as the report: a stamp with no earlier authority cannot say
  // *what* changed, and an earlier authority with no stamp says only what the
  // last pass saw. Neither alone is a change.
  for (const entry of [
    { sslIssuer: NEW_AUTHORITY, certIssuerChangedAt: at(0).toISOString() },
    { sslIssuer: NEW_AUTHORITY, certIssuerBefore: OLD_AUTHORITY },
  ]) {
    assert.equal(readCertIssuerState(entry, { now: at(0) }).note, '');
    assert.doesNotMatch(readCertRotationAlert({ rotation, issuerNote: readCertIssuerState(entry, { now: at(0) }).note, now: at(0) }).message, /issuer/);
  }
});

test('en navnløs autoritet får ingen opdigtet myndighed', () => {
  const note = readCertIssuerState({ certIssuerBefore: OLD_AUTHORITY, certIssuerChangedAt: at(0).toISOString() }, { now: at(0) }).note;
  assert.match(note, /an unnamed authority/, 'the owner already refuses to invent a name');
  assert.match(readCertRotationAlert({ rotation, issuerNote: note, now: at(0) }).message, /an unnamed authority/);
});

// ------------------------------------------- the pass, end to end

test('fire rigtige pass skelner baseline → uændret → fornyelse → ny udsteder', async t => {
  // The state file is read back from disk after each pass, so what the next pass
  // compares against is the file the last one wrote — the same round trip the
  // lists and the report take.
  const { home } = tempHome(t);
  const stateFile = getStateFile({ env: { HOME: home } });
  const state = { urls: { [SITE]: {} } };
  const check = checkAnswering([
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_B },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_B },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_C },
  ]);

  const first = await runPass(state, { home, stateFile, now: at(0), check, returnResults: true });
  assert.equal(messageOf(first), '', 'a baseline is not a rotation');

  const second = await runPass(readBack(stateFile), { home, stateFile, now: at(30_000), check, returnResults: true });
  assert.equal(messageOf(second), '', 'the same certificate is not a rotation');

  const third = await runPass(readBack(stateFile), { home, stateFile, now: at(60_000), check, returnResults: true });
  assert.equal(
    messageOf(third),
    'SSL certificate replaced — certificate rotated since the certificate seen today',
    'a renewal from the same authority says nothing about the authority',
  );

  // The authority changes hands on a pass where the *certificate* stays the one
  // that just answered — a hijack does not have to rotate twice, and a pass that
  // only compared certificates says nothing at all here.
  const fourth = await runPass(readBack(stateFile), { home, stateFile, now: at(90_000), check, returnResults: true });
  assert.equal(messageOf(fourth), '', 'a changed authority with the same certificate raises no rotation of its own');

  // …and the next real rotation carries it, from the stored fact, long after the
  // pass that measured the change.
  const stored = readBack(stateFile).urls[SITE];
  assert.equal(stored.sslIssuer, NEW_AUTHORITY);
  assert.equal(stored.certIssuerBefore, OLD_AUTHORITY);
  assert.notEqual(readCertIssuerState(stored, { now: at(0) }).note, '', 'the fact outlived the pass that measured it');

  // A day later, so the age in the sentence can only come from the stamp the
  // hijacking pass wrote — never from the rotation that happens to ride on it.
  const fifth = await runPass(readBack(stateFile), { home, stateFile, now: at(25 * HOUR), check, returnResults: true });
  assert.match(
    messageOf(fifth),
    new RegExp(`\\(${OLD_AUTHORITY} → ${NEW_AUTHORITY}\\)`),
    'a later rotation still names the authority that is not the customer’s',
  );
  assert.match(messageOf(fifth), /different issuer 1 d ago/, 'and the age is the age of the change, not of this pass');
});

test('et certifikat der skifter autoritet uden at rotere sig giver ingen alarm', async t => {
  // The one case where the fact exists and no alert is raised: the certificate is
  // the same one, so `cert_rotated` is not the honest event type — inventing one
  // would double the POSTs on a CDN mid-rollout. The fact is still written, which
  // is what the report and both lists read.
  const { home } = tempHome(t);
  const stateFile = getStateFile({ env: { HOME: home } });
  const state = { urls: { [SITE]: {} } };
  const check = checkAnswering([
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_A },
  ]);

  await runPass(state, { home, stateFile, now: at(0), check, returnResults: true });
  const second = await runPass(readBack(stateFile), { home, stateFile, now: at(30_000), check, returnResults: true });
  assert.equal(second.events.length, 0, 'nothing is announced, and nothing is invented');
  assert.equal(readBack(stateFile).urls[SITE].certIssuerBefore, OLD_AUTHORITY, 'but the change is not lost');
});

test('et hijack på den første rotation efter en stille time høres med begge navne', async t => {
  // The first rotation after a quiet hour is always sent (P1-63), so a domain
  // that changed hands is the one case that must never be held back — and it is
  // the case that used to arrive as a routine renewal.
  const { home } = tempHome(t);
  const state = { urls: { [SITE]: {} } };
  const check = checkAnswering([
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_B },
  ]);

  await runPass(state, { home, now: at(0), check, returnResults: true });
  const hijack = await runPass(state, { home, now: at(30_000), check, returnResults: true });

  assert.equal(
    messageOf(hijack),
    `SSL certificate replaced — certificate rotated since the certificate seen today · 🏢 certificate answers from a different issuer today (${OLD_AUTHORITY} → ${NEW_AUTHORITY})`,
  );
  // …and the two facts are recorded independently, so a later reader of the
  // report still has both even though only one of them was in the alert.
  assert.ok(state.urls[SITE].lastCertRotatedAt, 'the rotation is a fact of its own');
  assert.equal(state.urls[SITE].certIssuerBefore, OLD_AUTHORITY);
});

test('den dæmpede rotation holder kun Rotationen tilbage, ikke autoriteten', async t => {
  // A name that flapped between two servers raised an alert on every pass
  // (P1-63). The first alert after a quiet hour is sent, and it has to carry
  // both facts — otherwise a hijack that lands inside the quiet hour is announced
  // one rotation late and without the authority.
  const { home } = tempHome(t);
  const state = { urls: { [SITE]: {} } };
  const check = checkAnswering([
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_B },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: NEW_AUTHORITY, fingerprint: FINGERPRINT_B },
  ]);

  await runPass(state, { home, now: at(0), check, returnResults: true });
  await runPass(state, { home, now: at(30_000), check, returnResults: true });
  const held = await runPass(state, { home, now: at(60_000), check, returnResults: true });
  assert.equal(rotated(held), undefined, 'inside the hour nothing is sent');

  const sent = await runPass(state, { home, now: at(CERT_ALERT_MIN_GAP_MS + 60_000), check, returnResults: true });
  const message = messageOf(sent);
  assert.match(message, new RegExp(`\\(${OLD_AUTHORITY} → ${NEW_AUTHORITY}\\)`), 'the authority rides on the alert that is sent');
  assert.match(message, /1 earlier rotation since the last alert, not sent/, 'and the count keeps its own place');
  assert.ok(
    message.indexOf('different issuer') < message.indexOf('earlier rotation'),
    'the fact comes before the delivery note',
  );
});

test('kvitteringen, outboxen og payloaden bærer den lange sætning uændret', async () => {
  // The message is capped in the outbox (500) and rebuilt for the POST. A hijack
  // message is ~170 characters, so nothing truncates it — measured here rather
  // than assumed, because a truncated sentence would name an authority and stop
  // before the arrow.
  const hijack = await realDelivery();
  assert.ok(hijack.body.message.length < 500, `the outbox cap must not bite: ${hijack.body.message.length}`);
  assert.doesNotMatch(hijack.body.message, /\.\.\.$/, 'nothing is elided');

  const keys = Object.keys(hijack.body).sort();
  assert.deepEqual(keys, [
    'finalUrl', 'measuredAt', 'message', 'offHostRedirect', 'previousChecked',
    'product', 'timestamp', 'transition', 'type', 'url',
  ], 'the payload contract is unchanged — no new field, no new event type');

  const [queued] = normalizeOutbox([{ ...hijack.event, queuedAt: hijack.body.timestamp, attempts: 0 }]);
  assert.equal(queued.message, hijack.body.message, 'what the outbox stores is what the receiver gets');
  assert.equal(queued.type, 'cert_rotated');
});

test('et fjendtligt autoritetsnavn kan ikke tegne i terminalen', async t => {
  // Both names are chosen by whoever answers for the name, so they are as
  // untrusted as the URL printed next to them. The lists flatten it at the print
  // boundary (P1-65); the same boundary handles the alert line, and the message
  // survives the outbox and the JSON with the escape byte gone from the terminal.
  const { home } = tempHome(t);
  const state = { urls: { [SITE]: {} } };
  const evil = `Evil CA[2J`;
  const check = checkAnswering([
    { issuer: OLD_AUTHORITY, fingerprint: FINGERPRINT_A },
    { issuer: evil, fingerprint: FINGERPRINT_B },
  ]);

  await runPass(state, { home, now: at(0), check, returnResults: true });
  const hijack = await runPass(state, { home, now: at(30_000), check, returnResults: true });
  assert.match(messageOf(hijack), /Evil CA/, 'the name is still named');
  assert.match(messageOf(hijack), new RegExp(`${OLD_AUTHORITY} → Evil CA`), 'and it does not hide the change');

  const printed = printPassLines(hijack);
  assert.match(printed, /Evil CA/, 'the printed line names the authority too');
  assert.doesNotMatch(printed, /\[2J/, 'and the escape byte that would repaint the terminal is gone');
  assert.equal(printed.split('\n').length, 1, 'flattened to one inert line');
});

/** The state file as the last pass left it — never the live object. */
function readBack(stateFile) {
  return existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : { urls: { [SITE]: {} } };
}

/** The lines `printPass` writes for a pass, captured instead of printed. */
function printPassLines(pass) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    printPass(pass);
  } finally {
    console.log = log;
  }
  return lines.join('\n');
}

/** A real receiver, a real `sendWebhook`, and the body it was sent. */
async function realDelivery() {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end('ok'); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const event = {
    url: SITE,
    type: 'cert_rotated',
    message: `SSL certificate replaced — certificate rotated since the certificate seen today · 🏢 certificate answers from a different issuer today (${OLD_AUTHORITY} → ${NEW_AUTHORITY})`,
    measuredAt: at(0).toISOString(),
    previousChecked: at(-30_000).toISOString(),
    finalUrl: SITE,
  };
  await sendWebhook(`http://127.0.0.1:${server.address().port}/hook`, event);
  const body = received[0];
  server.close();
  return { body, event };
}
