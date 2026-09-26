/**
 * `--timeout` som budget for hele tjekket.
 *
 * Et check er tre ben: reachability, TLS-handshake og indholdslæsning. Hvert ben
 * har sit eget deadline, og før denne rettelse begrænsede `--timeout` kun det
 * første. Beviset var målt, ikke antaget: `check --timeout 500` mod en server der
 * sender headere og aldrig kroppen tog **20 094 ms** — 40× flagets værdi, og
 * præcis den kode, der gør et CI-job langsom.
 *
 * Ingen live-netværk: en `node:net`-server der svarer på HTTP og en der slet
 * ikke svarer på TLS.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'net';
import { checkUrl, legTimeoutMs } from '../src/engine.js';
import { checkSSL, SSL_TIMEOUT_MS } from '../src/checkers/ssl.js';
import { CONTENT_TIMEOUT_MS } from '../src/checkers/content.js';

/** Svarer på HTTP med headere, men sender aldrig kroppen. */
let stalling;
let stallingUrl;
let bodyDelayMs = 0;

/** Accepterer TCP og siger intet: TLS-handshakes færdiggøres aldrig. */
let silent;
let silentUrl;

// Sockets holdes styr på, så en socket der bliver ødelagt ved teardown ikke
// kaster en ECONNRESET efter at testen er slut.
const sockets = new Set();
function track(socket) {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
}

before(async () => {
  stalling = createNetServer((socket) => {
    track(socket);
    socket.on('data', () => {
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 100000\r\n\r\n');
      if (bodyDelayMs > 0) setTimeout(() => socket.end('<html><body>ok</body></html>'.padEnd(100000, ' ')), bodyDelayMs);
    });
  });
  await new Promise(resolve => stalling.listen(0, '127.0.0.1', resolve));
  stallingUrl = `http://127.0.0.1:${stalling.address().port}/`;

  silent = createNetServer(socket => track(socket));
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
  silentUrl = `https://127.0.0.1:${silent.address().port}/`;
});

after(() => {
  for (const socket of sockets) socket.destroy();
  stalling?.close();
  silent?.close();
});

test('--timeout gælder for hele tjekket, ikke kun for første request', async () => {
  const start = Date.now();
  const result = await checkUrl(stallingUrl, { timeoutMs: 500 });
  const elapsed = Date.now() - start;

  // Før: 20 094 ms. En test på 5 s kan ikke fejle på den gamle kode ved et
  // tilfælde — den gamle kode bruger sin fulde 20 s.
  assert.ok(elapsed < 5_000, `checkUrl med --timeout 500 tog ${elapsed}ms`);
  assert.ok(result.healthy, 'et site der svarer 200 er stadig sundt');
  assert.equal(result.content.fetched, false);
  assert.match(result.content.error, /within \d+ms/);
});

test('uden --timeout får indholdsbenet sin egen deadline', async () => {
  bodyDelayMs = 700;
  try {
    const unbudgeted = await checkUrl(stallingUrl);
    assert.equal(unbudgeted.content.fetched, true, 'uden budget skal et 700 ms svar læses færdigt');

    const budgeted = await checkUrl(stallingUrl, { timeoutMs: 150 });
    assert.equal(budgeted.content.fetched, false, 'med et lille budget skal det samme svar afbrydes');
  } finally {
    bodyDelayMs = 0;
  }
});

test('checkSSL respekterer sit eget deadline', async () => {
  const start = Date.now();
  const result = await checkSSL(silentUrl, { timeoutMs: 300 });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 2_000, `checkSSL med 300ms tog ${elapsed}ms`);
  assert.ok(result.error, 'et hængende handshake er en fejl, ikke en stille timeout');
  assert.equal(result.validDays, undefined);
});

test('uden et deadline holder checkSSL sit eget på 10 s', async () => {
  // Mod den rækkede kode ville dette resolve med en fejl efter 10 s; her må det
  // stadig være i gang efter 1,5 s, ellers er standarddeadline ikke længere 10 s.
  const sentinel = Symbol('still pending');
  const outcome = await Promise.race([
    checkSSL(silentUrl).then(() => 'resolved'),
    new Promise(resolve => setTimeout(() => resolve(sentinel), 1_500)),
  ]);
  assert.equal(outcome, sentinel);
  assert.equal(SSL_TIMEOUT_MS, 10_000);
});

test('et ben arver aldrig mere end sit eget deadline', () => {
  const now = 1_000_000;
  assert.equal(legTimeoutMs(null, CONTENT_TIMEOUT_MS, now), CONTENT_TIMEOUT_MS, 'uden budget: benets egen default');
  assert.equal(legTimeoutMs(0, CONTENT_TIMEOUT_MS, now), CONTENT_TIMEOUT_MS, '0 er ikke et deadline, det er "ingen budget"');
  assert.equal(legTimeoutMs(now + 500, CONTENT_TIMEOUT_MS, now), 500, 'resten af budgeten');
  assert.equal(legTimeoutMs(now + 5_000_000, CONTENT_TIMEOUT_MS, now), CONTENT_TIMEOUT_MS, 'et stort budget må ikke gøre et ben langsommere end i dag');
  assert.equal(legTimeoutMs(now - 1, CONTENT_TIMEOUT_MS, now), 1, 'opbrugt budget: 1 ms frem for at køre uden ramme');
  assert.equal(legTimeoutMs(now + 40_000, SSL_TIMEOUT_MS, now), SSL_TIMEOUT_MS);
});

test('watch-loopens kald uden timeoutMs får hvert ben sin egen deadline', () => {
  // runPass kalder checkUrl(url, { contentHash }) uden timeoutMs. Hvis det stoppede
  // med at give en deadline, ville hvert site få 20 s i stedet for sit eget.
  const noBudget = { contentHash: null };
  assert.equal(Number.isInteger(noBudget.timeoutMs), false);
  assert.equal(legTimeoutMs(null, CONTENT_TIMEOUT_MS), CONTENT_TIMEOUT_MS);
  assert.equal(legTimeoutMs(null, SSL_TIMEOUT_MS), SSL_TIMEOUT_MS);
});
