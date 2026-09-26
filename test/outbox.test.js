/**
 * P1-42 — the undelivered-alert outbox.
 *
 * Measured 2026-09-26 with the real loop, a real state file, a real local site
 * answering 500 and a real receiver answering 503 through the whole retry
 * budget: the receiver got three POSTs and then nothing. The pass had latched
 * `wasUp: false`, so the next pass raised no event, nothing in the loop sent
 * again, and `state.json` held no memory of the alert — a customer paying for
 * alerts to hear about an outage they were not sitting in front of, hearing
 * nothing, and then receiving `is UP` for a recovery they were never told about.
 *
 * These tests are about the queue's rules (dedupe, bounds, age, what is and is
 * not stored) and about the one promise that matters: a real receiver that was
 * down gets the alert when it comes back, with the pass's own `measuredAt`, so a
 * late delivery looks late instead of fresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  enqueueOutbox,
  flushOutbox,
  normalizeOutbox,
  outboxDroppedNote,
  outboxExpired,
  outboxWaitingNote,
  sendWebhook,
  webhookBody,
  OUTBOX_LIMIT,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ATTEMPTS,
} from '../src/watch.js';
import { queuedAgeMs } from '../src/status.js';

const ROOT = join(import.meta.dirname, '..');

const DOWN_EVENT = Object.freeze({
  url: 'https://kunde.dk/',
  type: 'down',
  message: 'is DOWN — HTTP 500',
  measuredAt: '2026-09-26T19:10:47.000Z',
  previousChecked: '2026-09-25T19:10:00.000Z',
  finalUrl: null,
});

const minutes = n => n * 60 * 1000;
const at = ms => new Date(Date.parse('2026-09-26T20:00:00.000Z') - ms);

test('an alert that was not delivered is kept, once per site and kind', () => {
  const state = { urls: {} };
  assert.equal(enqueueOutbox(state, DOWN_EVENT, { now: at(0) }), true);
  // The same site going down again is not news — and the older alert is the one
  // that says when the outage began, so it is the one that stays.
  assert.equal(enqueueOutbox(state, { ...DOWN_EVENT, message: 'is DOWN — HTTP 503' }, { now: at(0) }), false);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].message, 'is DOWN — HTTP 500');
  // A different kind for the same site is its own alarm, and another site too.
  assert.equal(enqueueOutbox(state, { ...DOWN_EVENT, type: 'ssl_expired' }), true);
  assert.equal(enqueueOutbox(state, { ...DOWN_EVENT, url: 'https://to.dk/' }), true);
  assert.equal(state.outbox.length, 3);
});

test('the queue is bounded, and the oldest is what goes', () => {
  const state = { urls: {} };
  for (let i = 0; i < OUTBOX_LIMIT + 5; i++) {
    enqueueOutbox(state, { ...DOWN_EVENT, url: `https://kunde${i}.dk/` }, { now: at(0) });
  }
  assert.equal(state.outbox.length, OUTBOX_LIMIT);
  assert.equal(state.outbox[0].url, 'https://kunde5.dk/', 'the five oldest were given up first');
});

test('what is stored is the alert — never the address it goes to', () => {
  const state = { urls: {} };
  enqueueOutbox(state, DOWN_EVENT, { now: at(0) });
  const stored = JSON.stringify(state.outbox);
  // A webhook URL is a token in Slack, Discord and Teams, and state.json is the
  // file users attach to a bug report. The queue must not become a place where
  // that token lives on disk.
  assert.doesNotMatch(stored, /webhook|hook/);
  assert.deepEqual(Object.keys(state.outbox[0]).sort(), [
    'attempts', 'finalUrl', 'measuredAt', 'message', 'previousChecked', 'queuedAt', 'type', 'url',
  ]);
  // A site's own error text rides along in `message`, so it is capped: a server
  // must not get to decide how big the state file grows.
  const long = { ...DOWN_EVENT, url: 'https://lang.dk/', message: 'x'.repeat(5000) };
  enqueueOutbox(state, long, { now: at(0) });
  assert.equal(state.outbox.at(-1).message.length, 500);
});

test('a hand-edited or half-written outbox cannot smuggle anything in', () => {
  const now = at(0);
  const list = normalizeOutbox([
    { url: 'https://kunde.dk/', type: 'down', message: 'is DOWN', queuedAt: now.toISOString() },
    { url: '', type: 'down', queuedAt: now.toISOString() },
    { type: 'down', queuedAt: now.toISOString() },
    { url: 'https://kunde.dk/', type: 'down' },
    { url: 'https://kunde.dk/', type: 'down', queuedAt: 'not a time' },
    { url: 'https://kunde.dk/', type: 'down', queuedAt: now.toISOString(), attempts: 99 },
    'nonsense',
    { url: 'https://kunde.dk/', type: 'down', queuedAt: now.toISOString(), webhook: 'https://hooks.slack.com/T/B/SECRET' },
  ]);
  assert.equal(list.length, 2, 'only the two entries that could actually be sent survive');
  assert.equal(list[0].attempts, 0);
  assert.equal(JSON.stringify(list[1]).includes('SECRET'), false);
  assert.equal(normalizeOutbox('nonsense').length, 0);
  assert.equal(normalizeOutbox(undefined).length, 0);
});

test('an alert is given up after its tries or its age, and the give-up is said', async () => {
  const state = { urls: {} };
  enqueueOutbox(state, DOWN_EVENT, { now: at(0) });
  let sent = 0;
  const failing = async () => { sent += 1; return false; };
  const persist = [];

  // Three tries in total, across passes — the third failure is the give-up, so
  // a receiver that is down for three passes costs three POSTs, not one per pass
  // for half an hour.
  for (let pass = 1; pass < OUTBOX_MAX_ATTEMPTS; pass++) {
    const result = await flushOutbox('https://hooks.example/x', state, { now: at(pass * 1000), send: failing, persist: c => persist.push(c) });
    assert.equal(result.dropped, 0, `still trying after pass ${pass}`);
    assert.equal(result.waiting, 1);
  }
  const final = await flushOutbox('https://hooks.example/x', state, { now: at(60 * 1000), send: failing, persist: () => {} });
  assert.equal(sent, OUTBOX_MAX_ATTEMPTS);
  assert.equal(persist.every(Boolean), true, 'the loop is told to write the new state');
  assert.equal(final.dropped, 1);
  assert.equal(final.waiting, 0);
  assert.equal(state.outbox.length, 0, 'a silent drop is indistinguishable from a delivery, so there is none');
  // The sentence has to tell the customer their channel got nothing.
  const note = outboxDroppedNote({ ...DOWN_EVENT, queuedAt: at(minutes(30)).toISOString(), attempts: 3 }, { now: at(0) });
  assert.match(note, /never delivered/);
  assert.match(note, /received nothing/);
  assert.match(note, /waited 30 min, 3 tries/);
});

test('an alert older than its age is never even sent — it is already too late', async () => {
  const state = { urls: {} };
  enqueueOutbox(state, DOWN_EVENT, { now: at(0) });
  let sent = 0;
  const result = await flushOutbox('https://hooks.example/x', state, {
    now: at(-(OUTBOX_MAX_AGE_MS + 1000)),
    send: async () => { sent += 1; return true; },
    persist: () => {},
  });
  assert.equal(sent, 0, 'a receiver that comes back after 30 minutes does not get a 30-minute-old "is DOWN"');
  assert.equal(result.dropped, 1);
  assert.equal(outboxExpired(normalizeOutbox([{ ...DOWN_EVENT, queuedAt: at(OUTBOX_MAX_AGE_MS).toISOString() }])[0], { now: at(0) }), true);
});

test('the customer sees what is waiting, and for how long', () => {
  const entries = normalizeOutbox([{ ...DOWN_EVENT, queuedAt: at(minutes(12)).toISOString(), attempts: 1 }]);
  const note = outboxWaitingNote(entries, { now: at(0) });
  assert.match(note, /1 alert still waiting/);
  assert.match(note, /waiting 12 min, 1 try\b/);
  assert.match(note, /kunde\.dk/);
  assert.match(outboxWaitingNote(entries.map(e => ({ ...e, attempts: 2 })), { now: at(0) }), /2 tries/);
  // A future stamp is a clock problem, not a negative wait.
  assert.equal(queuedAgeMs(at(-5000).toISOString(), at(0)), 0);
});

test('a real receiver that was down gets the alert when it answers, with the pass\'s own time', async (t) => {
  const received = [];
  let answering = 503;
  const receiver = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(answering).end(answering === 200 ? 'ok' : 'down'); });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  t.after(() => { receiver.closeAllConnections?.(); receiver.close(); });
  const hook = `http://127.0.0.1:${receiver.address().port}/services/T/B/SECRET`;

  // The measured customer journey: the pass raises the alarm, the receiver is
  // down through the whole budget, and the alert is kept rather than lost.
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  // A budget the three fast local attempts always fit inside. The assertion
  // below is about the *attempts*, not about wall-clock: with a 900 ms budget
  // this test failed on a loaded machine (`2 !== 3`) because the third attempt
  // fell outside the budget — correct behaviour, wrong question. The budget
  // stays the budget, so the other tests still hold it to that.
  const delivered = await sendWebhook(hook, DOWN_EVENT, { timeoutMs: 5000, retryDelayMs: 20, kept: true });
  console.error = realError;
  assert.equal(delivered, false);
  assert.equal(received.length, 3, 'the three attempts inside the budget');
  assert.match(errors.join('\n'), /Kept in the outbox/, 'the message tells the truth about what happens next');
  assert.doesNotMatch(errors.join('\n'), /Nothing resends it/, 'and does not claim nothing will');

  // It is queued, the file gets it, and the queue survives a round trip through
  // `normalizeState` — which is what a restart looks like.
  const state = { urls: {} };
  enqueueOutbox(state, DOWN_EVENT);
  assert.equal(state.outbox.length, 1);
  assert.equal(normalizeOutbox(state.outbox).length, 1);
  assert.equal(JSON.stringify(state).includes('SECRET'), false, 'the token never reaches the disk copy');

  // The receiver comes back on the next pass: the alert arrives, carrying the
  // time it was measured — not the time it was delivered.
  answering = 200;
  received.length = 0;
  const flushed = await flushOutbox(hook, state, { persist: () => {} });
  assert.deepEqual(flushed, { delivered: 1, dropped: 0, waiting: 0 });
  assert.equal(received.length, 1);
  assert.equal(received[0].measuredAt, DOWN_EVENT.measuredAt, 'a late delivery still says when it was measured');
  assert.equal(received[0].previousChecked, DOWN_EVENT.previousChecked);
  assert.equal(received[0].type, 'down');
  assert.equal(received[0].message, DOWN_EVENT.message);
  assert.equal(received[0].transition, 'observed');
  assert.equal(state.outbox.length, 0);
  // And the payload is the contract the docs publish: same fields, same values,
  // whether the alert went out now or a pass later.
  const fresh = JSON.parse(webhookBody(DOWN_EVENT, { now: new Date('2026-09-26T20:30:00.000Z') }));
  const late = JSON.parse(webhookBody(state.outbox[0] ?? { ...DOWN_EVENT, queuedAt: at(0).toISOString() }, { now: new Date('2026-09-26T20:30:00.000Z') }));
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(late).sort());
  assert.equal(fresh.transition, late.transition);
});

test('the loop sends what is waiting before what it just raised', () => {
  // The ordering is the reason the flush runs first: a channel reads its alerts
  // in the order they happened, not in the order the receiver came back.
  const source = readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8');
  const loop = source.slice(source.indexOf('while (true) {'));
  assert.ok(loop.indexOf('flushOutbox(') < loop.indexOf('sendWebhook(webhookUrl, event'),
    'the waiting alerts are flushed before this pass\'s own events');
  // …and an undelivered event is queued in the same loop, not dropped.
  assert.match(loop, /!sent && enqueueOutbox\(state, event\)/);
});
