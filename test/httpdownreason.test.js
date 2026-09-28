/**
 * P1-84: `HTTP 401` was the whole reason, on every surface — including the one a
 * bureau forwards to the customer the report is about.
 *
 * Measured 2026-09-28 with a real `watch --once` over a real local server
 * answering 200, 401, 403, 429 and 503, then the real client report over the
 * state file that pass wrote, before the fix:
 *
 *   | …/401 | DOWN (401) | 0% (1 check, 1 failed) | … |
 *   **5 site(s) · 1 up · 4 down · 5 checks · 4 failed**
 *
 * Three of the four failures were about *our* access and not about the
 * customer's website: a staged page behind a proxy (401), a site still under a
 * maintenance plugin (403), a CDN throttling an unknown user agent (429). None
 * of them is an outage, and all three read as one on the terminal, in the watch
 * alert a customer pays for, in the Pro webhook payload, and in the document an
 * agency sends to a customer quoting 0 %. The status code is a fact; the
 * sentence behind it was missing, and "HTTP 401" is not a reason.
 *
 * The fix is one owner (`httpDownKind` / `httpDownNote` in `src/status.js`),
 * asked by all three producers of the sentence and by the report. The `HTTP
 * <code> — ` prefix is kept so a consumer that matched on the code keeps
 * matching, and every other status is character for character what it was.
 *
 * These tests are the same measurement, kept: a real local server, the real
 * CLI, the real report, nothing stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { httpDownKind, httpDownLabel, httpDownNote } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';
import { tempHome } from './helpers/env.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NOW = new Date('2026-09-28T06:00:00.000Z');
const LICENSE = { key: '0123456789abcdef0123456789abcdef', instance: 'p184', plan: 'pro', status: 'active', validatedAt: NOW.toISOString() };

/** The three answers that are about our access, and the three that are not. */
const CLOSED = { 401: 'auth-required', 403: 'not-allowed', 429: 'rate-limited' };
const OPEN = [200, 301, 404, 410, 500, 502, 503, null, undefined, '401', 401.5];

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function cli(home, args) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    maxBuffer: 8 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr })).catch(error => ({
    code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
  }));
}

/** A state entry for a site whose last pass answered `status`. */
function failed(status, over = {}) {
  return {
    addedAt: '2026-09-20T10:00:00.000Z',
    lastChecked: '2026-09-27T10:00:00.000Z',
    wasUp: false,
    lastStatus: status,
    checks: 12,
    checksUp: 4,
    lastResponseMs: 12,
    ...over,
  };
}

function report(urls) {
  const built = buildReport({ urls, license: LICENSE }, { now: NOW, title: 'Acme' });
  return { built, markdown: renderReportMarkdown(built) };
}

/**
 * Everything above the methodology footnote. The footnote explains the rule in
 * the same words as the line it explains, so an assertion about whether the
 * document *says* something has to be asked of the part a reader acts on.
 */
function body(markdown) {
  return markdown.split('\nUptime is the share')[0];
}

function line(markdown, needle) {
  return markdown.split('\n').find(l => l.includes(needle)) ?? '';
}

function row(markdown, url) {
  return markdown.split('\n').find(l => l.startsWith(`| ${url} |`)) ?? '';
}

function summary(markdown) {
  return markdown.split('\n').find(l => l.startsWith('**') && l.includes('site(s)')) ?? '';
}

// ── The owner ──

test('the three closed-door statuses say which kind they are, and nothing else does', () => {
  for (const [status, kind] of Object.entries(CLOSED)) {
    assert.equal(httpDownKind(Number(status)), kind, status);
  }
  // 404 and 5xx are the site, and keep the bare code they have always printed.
  for (const status of OPEN) {
    assert.equal(httpDownKind(status), null, String(status));
  }
});

test('the cell label says the same thing in fewer words, and only for a door', () => {
  // `note` is the sentence, `label` is what a table row has room for — the same
  // pair `readRedirectTarget` returns. Three doors, three labels: one label for
  // all three is the failure this owner exists to prevent.
  const labels = new Set();
  for (const status of Object.keys(CLOSED)) {
    const label = httpDownLabel({ statusCode: Number(status) });
    assert.ok(typeof label === 'string' && label.length > 0, `${status} has no label`);
    assert.ok(!label.includes('HTTP '), `the HTTP column already prints the code: ${label}`);
    labels.add(label);
  }
  assert.equal(labels.size, 3, 'two closed doors share one label');
  // A 404 and a 5xx are the site being down or broken. Nothing to add.
  for (const status of OPEN) {
    assert.equal(httpDownLabel({ statusCode: status }), null, String(status));
  }
  assert.equal(httpDownLabel(), null);
  assert.equal(httpDownLabel({}), null);
});

test('the sentence keeps the code in front, so a consumer matching on it still matches', () => {
  for (const [status, kind] of Object.entries(CLOSED)) {
    const note = httpDownNote({ statusCode: Number(status) });
    assert.ok(note.startsWith(`HTTP ${status} — `), note);
    // Three different facts, three different sentences: one sentence for all
    // three is the failure this owner exists to prevent.
    const others = Object.keys(CLOSED).filter(code => code !== status).map(code => httpDownNote({ statusCode: Number(code) }));
    for (const other of others) assert.notEqual(note, other, `same sentence for ${status} and another closed door`);
    assert.ok(note.length > `HTTP ${status} — `.length, 'a code alone is not a reason');
    assert.ok(!note.includes(kind), 'the kind is a fact for a caller, not a word for a reader');
  }
  for (const status of [404, 500, 503]) {
    assert.equal(httpDownNote({ statusCode: status }), `HTTP ${status}`);
  }
  // No status at all is still a sentence, never `HTTP null`.
  assert.equal(httpDownNote({}), 'HTTP error');
  assert.equal(httpDownNote(), 'HTTP error');
});

test('the sentence cannot carry a URL or a password — it is built from the code alone', () => {
  for (const status of [401, 403, 429]) {
    assert.doesNotMatch(httpDownNote({ statusCode: status }), /https?:|@/);
  }
});

// ── The real CLI, over a real local server ──

test('`check` names the reason for a 401 and still exits 2', async (t) => {
  const server = createServer((req, res) => { res.writeHead(401, { 'www-authenticate': 'Basic realm="kunde"' }); res.end('no'); });
  const port = await listen(server);
  t.after(() => close(server));
  const { home } = tempHome(t, 'deskuptime-p184-');
  const url = `http://127.0.0.1:${port}/staging`;

  const out = await cli(home, ['check', url]);
  assert.equal(out.code, 2);
  assert.match(out.stdout, /HTTP 401 — the site asked for a username and password/);
  // The verdict is untouched: a closed door is still not a healthy reading.
  assert.match(out.stdout, new RegExp(`Status:\\s+401 — DOWN`));
});

test('`check --json` keeps statusCode and carries the reason in `error`', async (t) => {
  const server = createServer((req, res) => { res.writeHead(429, { 'retry-after': '120' }); res.end('slow'); });
  const port = await listen(server);
  t.after(() => close(server));
  const { home } = tempHome(t, 'deskuptime-p184-');
  const url = `http://127.0.0.1:${port}/kunde.dk`;

  const out = await cli(home, ['check', '--json', url]);
  const [result] = JSON.parse(out.stdout);
  assert.equal(result.statusCode, 429);
  assert.equal(result.errorType, 'http_error');
  assert.equal(result.healthy, false);
  assert.equal(result.error, 'HTTP 429 — the site is rate-limiting this monitor, so the check was throttled');
});

test('`headers` names the reason for a 403 as well', async (t) => {
  const server = createServer((req, res) => { res.writeHead(403); res.end('no'); });
  const port = await listen(server);
  t.after(() => close(server));
  const { home } = tempHome(t, 'deskuptime-p184-');

  const out = await cli(home, ['headers', `http://127.0.0.1:${port}/blokeret`]);
  assert.equal(out.code, 2);
  assert.match(out.stdout, /HTTP 403 — the site refused this request, so no pass can read it/);
});

test('a 500 is character for character what it always was', async (t) => {
  const server = createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  const port = await listen(server);
  t.after(() => close(server));
  const { home } = tempHome(t, 'deskuptime-p184-');

  for (const command of [['check'], ['headers']]) {
    const out = await cli(home, [...command, `http://127.0.0.1:${port}/kunde.dk`]);
    assert.match(out.stdout, /Error: +HTTP 500/, command.join(' '));
    assert.doesNotMatch(out.stdout, /refused|password|rate-limiting/, command.join(' '));
  }
});

test('a real `watch --once` writes the reason into the state file, and the next pass reads it back', async (t) => {
  const statuses = { '/staging': 401, '/kunde.dk': 429, '/kunde.dk/gad': 200 };
  const server = createServer((req, res) => {
    const status = statuses[req.url.split('?')[0]];
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(`<h1>${status}</h1>`);
  });
  const port = await listen(server);
  t.after(() => close(server));
  const { home, dir } = tempHome(t, 'deskuptime-p184-');
  const base = `http://127.0.0.1:${port}`;
  const paths = Object.keys(statuses);

  const first = await cli(home, ['watch', ...paths.map(p => base + p), '--once']);
  assert.equal(first.code, 2);
  assert.match(first.stdout, /baseline recorded: DOWN — HTTP 401 — the site asked for a username and password/);
  assert.match(first.stdout, /baseline recorded: DOWN — HTTP 429 — the site is rate-limiting this monitor/);
  assert.match(first.stdout, /baseline recorded: UP \(200\)/);

  // Second pass: the DOWN sites transition, so the reason rides on the alert a
  // paying customer receives, not only on the baseline line.
  const second = await cli(home, ['watch', ...paths.map(p => base + p), '--once']);
  assert.equal(second.code, 2);
  assert.match(second.stdout, /is DOWN — HTTP 401 — the site asked for a username and password/);
  assert.match(second.stdout, /is DOWN — HTTP 429 — the site is rate-limiting this monitor/);
  // The healthy site never gets a reason, because it has no failure.
  assert.doesNotMatch(second.stdout, /\/kunde\.dk\/gad[^\n]*HTTP/);

  // And the report over the file that pass wrote names it in the document.
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const built = buildReport(state, { now: NOW, title: 'Acme' });
  const markdown = renderReportMarkdown(built);
  assert.match(body(markdown), /closed door or a throttle rather than a page/);
  assert.ok(!/about access[^\n]*\/gad/.test(body(markdown)), 'a healthy site is not in the group');
});

// ── The client report ──

test('the report names the reason under the table, once per site, and counts it', () => {
  const urls = {
    'https://kunde.dk/': failed(401),
    'https://kunde.dk/staging': failed(429),
    'https://kunde.dk/gad': failed(503),
    'https://kunde.dk/ok': failed(200, { wasUp: true, checksUp: 12 }),
  };
  const { built, markdown } = report(urls);

  const named = line(body(markdown), 'closed door or a throttle rather than a page');
  assert.match(named, /^\*\*2 sites answered with a closed door or a throttle/);
  assert.match(named, /https:\/\/kunde\.dk\/ \(HTTP 401 — the site asked for a username and password/);
  assert.match(named, /https:\/\/kunde\.dk\/staging \(HTTP 429 — the site is rate-limiting this monitor/);
  // 503 is the site's own breakage, and is not in this group.
  assert.doesNotMatch(named, /\/kunde\.dk\/gad/);

  // The row keeps the verdict it has always had, and the failure is still
  // counted: this line explains a failure, it does not excuse it.
  assert.match(row(markdown, 'https://kunde.dk/'), /\| DOWN \(401\) \| 33\.33% \(12 checks, 8 failed\)/);
  assert.match(summary(markdown), /· 3 down/);
  assert.match(summary(markdown), /2 answered with a closed door or a throttle/);
  // Twelve passes, four of them 2xx, on each of the three failing sites.
  assert.equal(built.summary.failures, 24);

  // `--json` gains the two additive fields, and the two existing ones are the
  // same fact they were.
  const site = built.sites.find(s => s.url === 'https://kunde.dk/');
  assert.equal(site.statusCode, 401);
  assert.equal(site.status, 'down');
  assert.equal(site.httpDownKind, 'auth-required');
  assert.equal(site.httpDownNote, 'HTTP 401 — the site asked for a username and password, so no pass can read it');
  assert.equal(built.sites.find(s => s.url === 'https://kunde.dk/gad').httpDownKind, null);
  assert.equal(built.sites.find(s => s.url === 'https://kunde.dk/gad').httpDownNote, 'HTTP 503');
});

test('a report whose sites are all ordinary failures gains no line at all', () => {
  const { built, markdown } = report({
    'https://kunde.dk/': failed(503),
    'https://kunde.dk/gad': failed(404),
  });
  assert.doesNotMatch(body(markdown), /closed door/);
  assert.doesNotMatch(summary(markdown), /answered with/);
  // The summary line itself is character for character what it was.
  assert.equal(summary(markdown), '**2 site(s) · 0 up · 2 down · 24 checks · 16 failed**');
  for (const site of built.sites) {
    assert.equal(site.httpDownKind, null);
    assert.equal(site.httpDownNote, `HTTP ${site.statusCode}`);
  }
});

test('the line under the table prints the owner\'s words, not its own', () => {
  // A site object a consumer built by hand, carrying a note this file never
  // wrote. If the renderer re-described the failure in its own words, the
  // mutated text would not survive into the document.
  const markdown = renderReportMarkdown({
    generatedAt: NOW.toISOString(),
    windowDays: 30,
    summary: { sites: 1, checks: 1, failures: 1 },
    sites: [{
      url: 'https://kunde.dk/',
      status: 'down',
      statusCode: 403,
      httpDownKind: 'not-allowed',
      httpDownNote: 'HTTP 403 — en helt anden sætning fra en anden ejer',
      uptimePercent: 0,
      checks: 1,
      failures: 1,
      responseMs: 10,
    }],
  });
  assert.match(body(markdown), /en helt anden sætning fra en anden ejer/);
});

test('a site object with the kind but no note is left out, not rendered as a broken line', () => {
  const markdown = renderReportMarkdown({
    generatedAt: NOW.toISOString(),
    windowDays: 30,
    summary: { sites: 1, checks: 1, failures: 1 },
    sites: [{
      url: 'https://kunde.dk/',
      status: 'down',
      statusCode: 403,
      httpDownKind: 'not-allowed',
      uptimePercent: 0,
      checks: 1,
      failures: 1,
    }],
  });
  assert.doesNotMatch(body(markdown), /closed door/);
  // No half-written sentence either: the line is built from the note, so a site
  // without one contributes nothing at all.
  assert.doesNotMatch(body(markdown), /HTTP 403 — (?!the site)/);
});
