/**
 * Webhook delivery — timeout, fejl og payload.
 * Se docs/pro-alerts.md §2: best-effort, 10s timeout, ingen retry, ingen kø.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runPass, sendWebhook } from '../src/watch.js';

function serve(handler) {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/hook`, close: () => new Promise(done => server.close(done)) });
    });
  });
}

function withStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  return Promise.resolve(fn()).finally(() => { console.error = original; });
}

test('webhook sender payloaden fra specen', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ contentType: req.headers['content-type'], method: req.method, body: JSON.parse(body) });
      res.writeHead(200).end('ok');
    });
  });

  const sent = await withStderr(() => sendWebhook(server.url, {
    type: 'down', url: 'https://yoursite.com', message: 'is DOWN — HTTP 503',
  }));
  await server.close();

  assert.equal(sent, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].contentType, 'application/json');
  assert.equal(received[0].body.product, 'deskuptime');
  assert.equal(received[0].body.type, 'down');
  assert.equal(received[0].body.url, 'https://yoursite.com');
  assert.match(received[0].body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!('license' in received[0].body), 'payloaden må ikke indeholde licensdata');
  assert.ok(!('device' in received[0].body), 'payloaden må ikke indeholde device-id');
});

/**
 * P1-17. The payload used to carry exactly one time — the moment the POST body
 * was built — and that is not the time of a measurement. Measured on a real pass
 * with two sites, one answering instantly and one timing out 800 ms later, the
 * two payloads said:
 *
 *   quick  timestamp …11.849Z      slow  timestamp …13.870Z
 *
 * while both checks had *started* at …11.042Z. A channel that renders that field
 * reads it as "the site broke at 14:26". The payload now says when the site was
 * measured, and says which reading the transition rests on.
 */
test('payloaden siger hvornår sitet blev målt, ikke hvornår den blev sendt', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      // A slow receiver, which is what made the gap visible in the first place.
      setTimeout(() => res.writeHead(200).end('ok'), 250);
    });
  });

  // End to end, through the real pass: a site whose last reading is 41 days old.
  const stateFile = join(mkdtempSync(join(tmpdir(), 'deskuptime-hook-')), 'state.json');
  const lastChecked = new Date(Date.now() - 41 * 24 * 3600 * 1000).toISOString();
  const pass = await runPass({
    urls: { 'https://yoursite.com': { wasUp: 'yes', lastChecked } },
  }, {
    stateFile,
    returnResults: true,
    check: async url => ({ url, healthy: false, statusCode: 503, error: 'HTTP 503', errorType: 'http_error', timestamp: new Date().toISOString() }),
  });
  const event = pass.events.find(e => e.type === 'down');
  assert.ok(event, 'the site is down now, so the pass raises a down event');

  await withStderr(() => sendWebhook(server.url, event));
  await server.close();

  const body = received[0];
  assert.equal(body.type, 'down');
  assert.equal(body.measuredAt, event.measuredAt, 'målingstidspunktet skal med i payloaden');
  assert.equal(body.previousChecked, lastChecked);
  assert.equal(body.transition, 'unobserved', 'et 41 dage gammelt forudgående pass er ikke en observeret overgang');
  // The delivery time is still there and still means delivery — no receiver
  // breaks — but it is no longer the only time in the payload, and the gap the
  // slow receiver added is now visible instead of being all the customer gets.
  assert.ok(Date.parse(body.timestamp) > Date.parse(body.measuredAt), 'timestamp er stadig leveringstidspunktet');
  // The sentence and the word cannot disagree: the payload carries exactly the
  // message the terminal and the desktop notification showed.
  assert.equal(body.message, event.message);
  assert.match(body.message, /not an observed transition — the last check was 41 d ago/);
});

test('et frisk forudgående pass giver observed og ingen advarsel i beskeden', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
  });

  await withStderr(() => sendWebhook(server.url, {
    type: 'up',
    url: 'https://yoursite.com',
    message: 'is UP (200) — 42ms',
    measuredAt: '2026-09-26T14:00:00.000Z',
    previousChecked: '2026-09-26T13:59:30.000Z',
  }));
  // An event built before this change has no facts at all — it must still send,
  // and must not claim a transition it knows nothing about.
  await withStderr(() => sendWebhook(server.url, {
    type: 'up', url: 'https://yoursite.com', message: 'is UP (200) — 42ms',
  }));
  await server.close();

  assert.equal(received[0].transition, 'observed');
  assert.equal(received[0].measuredAt, '2026-09-26T14:00:00.000Z');
  assert.equal(received[1].measuredAt, null);
  assert.equal(received[1].transition, 'unobserved');
  assert.equal(received[1].previousChecked, null);
});

test('en ikke-overgang-hændelse har ingen overgang at erklære', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
  });

  await withStderr(() => sendWebhook(server.url, {
    type: 'ssl_warning',
    url: 'https://yoursite.com',
    message: 'SSL expires in 9 days ⚠️',
    measuredAt: '2026-09-26T14:00:00.000Z',
    previousChecked: '2026-08-16T14:00:00.000Z',
  }));
  await server.close();

  assert.equal(received[0].transition, 'none', 'et SSL-advarsel er ikke en tilstandsovergang');
  assert.equal(received[0].measuredAt, '2026-09-26T14:00:00.000Z', 'tiden måles stadig, også uden overgang');
});


test('et hangende endpoint brydes af timeout', async () => {
  const sockets = [];
  const server = await serve((req) => { sockets.push(req.socket); });
  const started = Date.now();
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { timeoutMs: 150 }));
  const elapsed = Date.now() - started;
  for (const socket of sockets) socket.destroy();
  await server.close();

  assert.equal(sent, false);
  assert.ok(elapsed < 3000, `timeout blev ikke overholdt (${elapsed}ms)`);
});

test('en fejlende endpoint giver en advarsel, men kaster ikke', async () => {
  const server = await serve((req, res) => res.writeHead(500).end('nope'));
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }));
  await server.close();
  assert.equal(sent, false);
});

test('en utilgængelig endpoint kaster ikke', async () => {
  const sent = await withStderr(() => sendWebhook('http://127.0.0.1:1/hook', { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { timeoutMs: 500 }));
  assert.equal(sent, false);
});
