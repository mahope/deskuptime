/**
 * Webhook delivery — timeout, fejl, genprøvning og payload.
 * Se docs/pro-alerts.md §2: best-effort, ét 10-s-budget for alle forsøg, 2
 * genprøvninger på en midlertidig fejl, ingen kø, ingen afspilning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { EVENT_TYPES, WEBHOOK_ATTEMPTS, WEBHOOK_EVENT_TYPES, runPass, sendWebhook } from '../src/watch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = readFileSync(join(root, 'docs', 'pro-alerts.md'), 'utf-8');

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

/**
 * P1-41. Measured 2026-09-26 with the real `watch` loop, a real site that
 * answered 500 and a real receiver: one 5xx and the alert was gone for good.
 * The pass had already written `wasUp: false`, so every later pass produced no
 * event and nothing was sent again — the channel that was bought to hear about
 * the outage stayed silent through all of it, and then got `✅ is UP` for a
 * recovery it was never told about. One wrong answer out of thousands is
 * ordinary, so a temporary answer is asked again.
 */
test('en 5xx fra modtageren genprøves, så ét blip ikke mister alarmen', async () => {
  const received = [];
  let attempts = 0;
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      attempts += 1;
      received.push(JSON.parse(body));
      // The first POST is answered wrong — a restarting proxy, a rate limiter —
      // and every later one is accepted, exactly as in the measurement.
      if (attempts === 1) return res.writeHead(500).end('try later');
      res.writeHead(200).end('ok');
    });
  });

  const sent = await withStderr(() => sendWebhook(server.url, {
    type: 'down',
    url: 'https://kunde.dk/',
    message: 'is DOWN — HTTP 500',
    measuredAt: '2026-09-26T20:28:17.000Z',
  }, { retryDelayMs: 0 }));
  await server.close();

  assert.equal(sent, true, 'genprøvningen skal redde alarmen');
  assert.equal(attempts, 2, 'præcis ét genprøvningsforsøg — ikke en storm mod en kasse der er nede');
  // The same body, twice. A retry that reworded or re-timestamped the alert
  // would make a channel show two different stories about one outage.
  assert.deepEqual(received[1], received[0]);
  assert.equal(received[0].type, 'down');
});

test('et svar der ikke er en midlertidig fejl spørges aldrig igen', async () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    let attempts = 0;
    const server = await serve((req, res) => { attempts += 1; res.writeHead(status).end('nope'); });
    const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { retryDelayMs: 0 }));
    await server.close();

    assert.equal(sent, false);
    assert.equal(attempts, 1, `en ${status} er et svar fra modtageren, ikke en fejl i os — den skal ikke genprøves`);
  }
});

test('en 429 er modtageren der beder om tid, så den genprøves', async () => {
  let attempts = 0;
  const server = await serve((req, res) => {
    attempts += 1;
    if (attempts === 1) return res.writeHead(429).end('slow down');
    res.writeHead(200).end('ok');
  });
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { retryDelayMs: 0 }));
  await server.close();

  assert.equal(sent, true);
  assert.equal(attempts, 2);
});

test('en modtager der nægter svar stopper efter WEBHOOK_ATTEMPTS, aldrig flere', async () => {
  let attempts = 0;
  const server = await serve((req, res) => { attempts += 1; res.writeHead(503).end('nope'); });
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { retryDelayMs: 0 }));
  await server.close();

  assert.equal(sent, false);
  assert.equal(attempts, WEBHOOK_ATTEMPTS, 'grænsen skal være en egen konstant, ikke et tilfældigt tal');
});

/**
 * The bound that keeps the fix from becoming a new bug: every attempt shares the
 * one timeout, so three attempts can never hold the watch loop for three times
 * as long. A Pro loop's shortest interval is 30 s.
 */
test('alle forsøg deler ét timeout-budget, så loopet ikke bliver langsomt', async () => {
  const sockets = [];
  let attempts = 0;
  const server = await serve((req) => { attempts += 1; sockets.push(req.socket); });
  const started = Date.now();
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { timeoutMs: 200 }));
  const elapsed = Date.now() - started;
  for (const socket of sockets) socket.destroy();
  await server.close();

  assert.equal(sent, false);
  assert.equal(attempts, 1, 'en pause der spiser hele budgetet giver intet at genprøve med');
  assert.ok(elapsed < 1500, `et hangende endpoint må ikke holde loopet længere end sit eget budget (${elapsed}ms)`);
});

/**
 * The same budget, from the other side: the first attempt gives up *early*, so
 * there is time left in the budget — and that is exactly when a per-attempt
 * timeout that ignored the remainder would hand the retry a second full budget.
 * One slow answer would then cost the loop two budgets instead of one.
 */
test('en genprøvning efter et tidligt svar får kun resten af budgettet', async () => {
  const sockets = [];
  let attempts = 0;
  const server = await serve((req, res) => {
    attempts += 1;
    if (attempts === 1) return setTimeout(() => res.writeHead(500).end('nope'), 300);
    sockets.push(req.socket);
  });
  const started = Date.now();
  const sent = await withStderr(() => sendWebhook(server.url, { type: 'up', url: 'https://yoursite.com', message: 'is up' }, { timeoutMs: 1000, retryDelayMs: 0 }));
  const elapsed = Date.now() - started;
  for (const socket of sockets) socket.destroy();
  await server.close();

  assert.equal(sent, false);
  assert.equal(attempts, 2, 'budgetet er brugt op efter den anden, så der skal ikke være en tredje');
  assert.ok(elapsed < 1200, `to forsøg må ikke få to budgetter (${elapsed}ms for et budget på 1000ms)`);
});

test('en advarsel om en tabt levering siger at beskeden ikke sendes igen', async () => {
  const server = await serve((req, res) => res.writeHead(500).end('nope'));
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await sendWebhook(server.url, { type: 'down', url: 'https://kunde.dk/', message: 'is DOWN' }, { retryDelayMs: 0 });
  } finally {
    console.error = original;
    await server.close();
  }

  const warning = lines.join('\n');
  assert.match(warning, /not delivered/, 'en tabt levering skal hedde tabt, ikke lyde som om intet skete');
  assert.match(warning, /500/, 'grunden skal stå i advarslen');
  assert.match(warning, new RegExp(`${WEBHOOK_ATTEMPTS} attempts`), 'antal forsøg skal stå i advarslen');
  assert.match(warning, /resends|Nothing resends it/, 'kunden skal vide at ingen sender beskeden igen — det er den fælde målingen fandt');
});

/**
 * The measured journey, end to end through the real loop: two passes, a site
 * that is down in both, and a receiver that answers the first POST wrong. The
 * second pass is where the alert used to die — it raises no event of its own, so
 * the delivery belongs to the first one.
 */
test('to pass med ét blip: den anden pass skal ikke sende, den første skal', async () => {
  const state = { urls: { 'http://kunde.dk/': { wasUp: true, lastChecked: '2026-09-26T20:00:00.000Z', lastStatus: 200 } } };
  const delivered = [];
  let attempts = 0;
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      attempts += 1;
      if (attempts === 1) return res.writeHead(500).end('try later');
      delivered.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });

  const down = { timestamp: '2026-09-26T20:28:17.000Z', statusCode: 500, responseTimeMs: 4, healthy: false, error: 'HTTP 500' };
  const pass1 = await runPass(state, { check: async () => down });
  for (const event of pass1.filter(e => e.type !== 'baseline')) {
    await withStderr(() => sendWebhook(server.url, event, { retryDelayMs: 0 }));
  }
  const pass2 = await runPass(state, { check: async () => down });
  for (const event of pass2.filter(e => e.type !== 'baseline')) {
    await withStderr(() => sendWebhook(server.url, event, { retryDelayMs: 0 }));
  }
  await server.close();

  assert.equal(delivered.length, 1, 'ét nedbrud skal give præcis én besked i kanalen, ikke to og ikke nul');
  assert.equal(delivered[0].type, 'down');
  assert.deepEqual(pass2, [], 'den anden pass skal ikke rejse en ny begivenhed for et nedbrud der allerede er meldt');
});

/**
 * P1-27. A cross-host answer is not DOWN, so the event type cannot carry it: a
 * customer's domain that expired and got parked, or was hijacked and now points
 * at a phishing page, reached a paying customer's Slack channel as a green `up`.
 * The channel had nothing to branch on, and the fix must not be "compare the
 * hosts yourself in every channel" — that is the rule `readRedirectTarget` was
 * made the single owner of in P1-26.
 */
test('payloaden fortæller hvilken vært der svarede, så en kanal ikke skal gætte', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });

  // The parked/hijacked case: a 200 that came from somewhere else entirely.
  await withStderr(() => sendWebhook(server.url, {
    type: 'up',
    url: 'https://kunde.dk/',
    message: 'is UP (200) — 41ms',
    measuredAt: '2026-09-26T09:00:00.000Z',
    previousChecked: '2026-09-26T08:59:00.000Z',
    finalUrl: 'http://parked.example/lander',
  }));

  // The ordinary case: a path redirect on the site's own host. Both fields must
  // be present and say "nothing happened here", so a channel needs no branch
  // order and an existing receiver that ignores them is unaffected.
  await withStderr(() => sendWebhook(server.url, {
    type: 'up',
    url: 'https://kunde.dk/gammel',
    message: 'is UP (200) — 12ms',
    measuredAt: '2026-09-26T09:01:00.000Z',
    previousChecked: '2026-09-26T09:00:00.000Z',
    finalUrl: 'https://kunde.dk/ny',
  }));

  // A pass where nothing answered at all: no final URL was ever measured.
  await withStderr(() => sendWebhook(server.url, {
    type: 'down',
    url: 'https://kunde.dk/',
    message: 'is DOWN — Request timed out',
    measuredAt: '2026-09-26T09:02:00.000Z',
    previousChecked: '2026-09-26T09:01:00.000Z',
  }));
  await server.close();

  assert.equal(received[0].offHostRedirect, true, 'en Pro-kanal skal kunne se skiftet uden at regne på værter');
  assert.equal(received[0].finalUrl, 'http://parked.example/lander');
  assert.equal(received[0].type, 'up', 'en cross-host svar er stadig ikke DOWN');
  assert.equal(received[1].offHostRedirect, false, 'www → apex er ikke nyheder');
  assert.equal(received[1].finalUrl, 'https://kunde.dk/ny');
  assert.equal(received[2].offHostRedirect, false);
  assert.equal(received[2].finalUrl, null, 'intet svar, intet finalUrl — ikke den gamle start-URL');
  // `type`, `message` and `timestamp` keep their old meaning in all three.
  assert.equal(received[0].message, 'is UP (200) — 41ms');
  assert.equal(received[0].transition, 'observed');
});

/**
 * P1-34. The webhook is the only surface a machine reads, and §2 is the contract
 * a Slack/Discord adapter is written against. Measured 26/9 with the real CLI, a
 * real watch loop and a real receiver, the channel received six types — down, up,
 * redirect, ssl_warning, ssl_expired, content_changed — while the spec named
 * five, and the payload example was missing the two fields that carry the fact.
 *
 * The drift was invisible to the existing tests because every one of them
 * hand-wrote its event and typed the cross-host case `up` on purpose ("a
 * cross-host answer is not DOWN"). Nothing ever took the event `runPass` builds
 * for a parked domain out to a receiver, so the sixth type could not be seen.
 */
test('et cross-host svar går hele vejen ud som type "redirect"', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end('ok');
    });
  });

  // A real pass: one site that redirects to another host and answers 200 there.
  // The receiver is closed in `finally`, not on the happy path: an assertion that
  // fails before the close leaves a listening server behind, and `node --test`
  // then waits for it instead of reporting the failure. A gate that hangs is worse
  // than a gate that is red.
  const stateFile = join(mkdtempSync(join(tmpdir(), 'deskuptime-redirect-')), 'state.json');
  const url = 'https://kunde.dk/';
  const state = { urls: { [url]: { wasUp: true, lastStatus: 200, lastChecked: '2026-09-26T09:00:00.000Z', checks: 9, checksUp: 9 } } };
  const pass = await runPass(state, {
    stateFile,
    returnResults: true,
    check: async () => ({ healthy: true, statusCode: 200, finalUrl: 'http://parked.example/lander', responseTimeMs: 12, content: { contentLength: 40, hash: 'a'.repeat(64) }, ssl: null, timestamp: '2026-09-26T09:01:00.000Z' }),
  });

  assert.deepEqual(pass.events.map(event => event.type), ['redirect'], 'et cross-host svar er sin egen hændelse');

  try {
    for (const event of pass.events) {
      if (event.type === 'baseline') continue;
      await withStderr(() => sendWebhook(server.url, event));
    }
  } finally {
    await server.close();
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'redirect');
  assert.equal(received[0].offHostRedirect, true);
  assert.equal(received[0].finalUrl, 'http://parked.example/lander');
  assert.equal(received[0].url, url, 'den bestilte URL er den kunden skal se, ikke parkeringssiden');
  assert.match(received[0].message, /another host/);
  assert.equal(received[0].transition, 'none', 'et cross-host svar er ingen tilstandsovergang');
});

/**
 * The lock: the spec a Pro channel is written against, and the sender, must name
 * the same types and the same fields. A type added to the loop without a line in
 * §2 — exactly what `redirect` was for 26/9 — fails here.
 */
test('specens payload og type-liste er målt mod det, der faktisk sendes', async () => {
  const received = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
  });
  try {
    await withStderr(() => sendWebhook(server.url, { type: 'down', url: 'https://yoursite.com', message: 'is DOWN — HTTP 503' }));
  } finally {
    await server.close();
  }

  const payloadSection = spec.split('Payload:')[1];
  const example = JSON.parse(payloadSection.match(/```json\n([\s\S]*?)```/)[1]);

  assert.deepEqual(
    Object.keys(example).sort(),
    Object.keys(received[0]).sort(),
    'docs/pro-alerts.md §2 skal vise præcis de felter der sendes — hverken færre (en kanal gætter) eller flere (en kanal læser et felt der ikke findes)',
  );
  assert.deepEqual(
    example.type.split('|').map(part => part.trim()).sort(),
    [...WEBHOOK_EVENT_TYPES].sort(),
    'docs/pro-alerts.md §2 skal liste præcis de typer loopet sender',
  );
  for (const type of EVENT_TYPES) {
    assert.ok(spec.includes(`\`${type}\``), `docs/pro-alerts.md nævner ikke type "${type}", som koden kan sende`);
  }
  assert.ok(!WEBHOOK_EVENT_TYPES.includes('baseline'), 'baseline er en første iagttagelse og sendes ikke');
});
