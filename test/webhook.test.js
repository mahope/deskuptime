/**
 * Webhook delivery — timeout, fejl og payload.
 * Se docs/pro-alerts.md §2: best-effort, 10s timeout, ingen retry, ingen kø.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { sendWebhook } from '../src/watch.js';

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
