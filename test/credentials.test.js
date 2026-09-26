/**
 * P1-45: a URL that carries a username or a password is not a site we can
 * monitor, and the password must never reach disk, a terminal, JSON or the
 * client report.
 *
 * Measured 2026-09-26 with the real CLI, a real local site answering 200 and a
 * real Pro license: `deskuptime watch http://demo:sup3rsecret@127.0.0.1:PORT/`
 * started a loop, and Node's `fetch` then refused to build a request for it
 * (`Request cannot be constructed from a URL that includes credentials`), so
 * every pass answered DOWN for a site that was up. The same URL was written to
 * `~/.deskuptime/state.json` and printed in the client report — the document a
 * bureau forwards to its customer, under a line promising no secret is in it.
 * `deskuptime check` reported the same site as DOWN with the password in clear
 * text, on stdout and in `--json`.
 *
 * So a password typed on a command line was the one secret that reached the
 * state file, the terminal and the customer document by accident. The tests
 * below are the same measurement, kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasUrlCredentials, invalidHttpUrls, invalidUrlMessage, isCheckableUrl, partitionUsableUrls, urlCredentials, unusableUrlNote, withoutCredentials } from '../src/status.js';
import { buildReport, renderReportMarkdown, renderReportJson } from '../src/report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'sup3rsecret';

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-credentials-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  return { HOME: home, USERPROFILE: home };
}

function fixture(t) {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><title>hej</title>hei</html>'); });
  t.after(() => server.close());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const license = { key: KEY, instance: 'p145', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };
const credUrl = (port) => `http://demo:${PASSWORD}@127.0.0.1:${port}/staging`;

// ── The owner: one decision about an address a pass can send a request to ──

test('credentials in a URL are named, and never printed', () => {
  assert.equal(urlCredentials('https://a.dk/'), '');
  assert.equal(urlCredentials('kunde.dk'), '');
  assert.equal(urlCredentials('https://demo@a.dk/'), 'a username');
  assert.equal(urlCredentials(`https://:${PASSWORD}@a.dk/`), 'a password');
  assert.equal(urlCredentials(`https://demo:${PASSWORD}@a.dk/`), 'a username and a password');
  assert.equal(urlCredentials(`https://demo:${PASSWORD}@a.dk/`).includes(PASSWORD), false);
  assert.equal(hasUrlCredentials('https://a.dk/'), false);
  assert.equal(hasUrlCredentials(`https://demo:${PASSWORD}@a.dk/`), true);
  assert.equal(withoutCredentials(`https://demo:${PASSWORD}@a.dk/x?y=1`), 'https://a.dk/x?y=1');
  // A URL we did not write keeps its own text: redaction must not eat a path.
  assert.equal(withoutCredentials('https://a.dk/'), 'https://a.dk/');
  assert.equal(withoutCredentials('kunde.dk'), 'kunde.dk');
});

test('a URL with credentials is not an address a pass can check', () => {
  assert.equal(isCheckableUrl('https://a.dk/'), true);
  assert.equal(isCheckableUrl(`https://demo:${PASSWORD}@a.dk/`), false);
  // The P1-40 rule still holds: what a pass skips is exactly what a command
  // line refuses, so a key can never pass here and be fatal there.
  const urls = ['https://a.dk/', 'kunde.dk', 'ftp://c.dk/', `https://demo:${PASSWORD}@a.dk/`];
  const { usable, unusable } = partitionUsableUrls(urls);
  assert.deepEqual(usable, ['https://a.dk/']);
  assert.deepEqual(unusable, invalidHttpUrls(urls));
  assert.deepEqual(unusable, ['kunde.dk', 'ftp://c.dk/', `https://demo:${PASSWORD}@a.dk/`]);
});

test('the refusal names the reason and not the password', () => {
  const message = invalidUrlMessage(`https://demo:${PASSWORD}@a.dk/`);
  assert.match(message, /URL with a username and a password/);
  assert.match(message, /https:\/\/a\.dk\//);
  assert.doesNotMatch(message, new RegExp(PASSWORD));
  // An address we simply cannot parse keeps the sentence it always had.
  assert.equal(invalidUrlMessage('kunde.dk'), 'Invalid URL: kunde.dk');
});

test('the shared sentence for a saved key never prints a password', () => {
  const note = unusableUrlNote([`https://demo:${PASSWORD}@a.dk/`, 'kunde.dk'], { checked: 1 });
  assert.match(note, /not a site that is down/);
  assert.match(note, /has a username and a password in it, which is never sent and never stored/);
  assert.match(note, /is not a full address/);
  assert.doesNotMatch(note, new RegExp(PASSWORD));
  // The short form is a cell in the client report, so it has to fit and to be
  // true: `http://demo:…@a.dk` *is* a full address.
  const brief = unusableUrlNote([`https://demo:${PASSWORD}@a.dk/`], { brief: true });
  assert.match(brief, /username or password/);
  assert.doesNotMatch(brief, new RegExp(PASSWORD));
  assert.equal(unusableUrlNote(['kunde.dk'], { brief: true }), 'not a full address, so no pass can check it');
});

// ── The measured surfaces ──

test('no command accepts a URL with credentials, and none of them prints the password', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const url = credUrl(port);
  for (const args of [['check', url], ['check', url, '--json'], ['headers', url, '--json'], ['watch', url], ['unwatch', url]]) {
    const r = await run(args, { env: home });
    const out = r.stdout + r.stderr;
    assert.notEqual(r.code, 0, `${args[0]} accepted ${url}`);
    assert.doesNotMatch(out, new RegExp(PASSWORD), `${args[0]} printed the password`);
    assert.match(out, /username and a password|username or a password/);
  }
  // The site itself is untouched by all of that: it answered 200 throughout.
  const ok = await run(['check', `http://127.0.0.1:${port}/`], { env: home });
  assert.equal(ok.code, 0);
  assert.doesNotMatch(ok.stdout, /DOWN/);
});

test('a refused URL leaves no password in the state file — it is never written', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const r = await run(['watch', credUrl(port), '--once'], { env: home });
  assert.notEqual(r.code, 0);
  let state = null;
  try {
    state = readFileSync(join(home.HOME, '.deskuptime', 'state.json'), 'utf-8');
  } catch (error) {
    assert.equal(error.code, 'ENOENT', 'the refusal wrote a state file at all');
  }
  if (state !== null) assert.doesNotMatch(state, new RegExp(PASSWORD));
});

test('a credentialed key that is already in the file is skipped, not reported down', async (t) => {
  const port = await fixture(t);
  const home = tempHome(t);
  const url = credUrl(port);
  writeFileSync(join(home.HOME, '.deskuptime', 'state.json'), JSON.stringify({
    urls: {
      [url]: { addedAt: '2026-09-20T00:00:00.000Z', wasUp: false, lastChecked: new Date().toISOString(), checks: 3, checksUp: 0, sslWarned: false },
    },
    license,
  }, null, 2));

  const pass = await run(['watch', '--once'], { env: home });
  const watched = pass.stdout + pass.stderr;
  assert.doesNotMatch(watched, new RegExp(PASSWORD));
  assert.match(watched, /not a site that is down/);
  assert.doesNotMatch(watched, /is DOWN|down\s+http/);

  for (const args of [['status'], ['watch', '--status'], ['report'], ['report', '--json']]) {
    const r = await run(args, { env: home });
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, new RegExp(PASSWORD), `${args.join(' ')} printed the password`);
  }
});

test('the client report redacts a credentialed key and counts it apart from the sites', () => {
  const url = `https://demo:${PASSWORD}@kunde.dk/`;
  const report = buildReport({
    urls: { [url]: { addedAt: '2026-09-01T00:00:00.000Z', wasUp: false, lastChecked: '2026-09-26T10:00:00.000Z', checks: 4, checksUp: 1 } },
    license,
  }, { now: new Date('2026-09-26T12:00:00.000Z') });

  assert.equal(report.sites[0].url, 'https://kunde.dk/');
  assert.equal(report.sites[0].uncheckable, true);
  assert.equal(report.sites[0].status, 'unknown');
  for (const text of [renderReportMarkdown(report), renderReportJson(report)]) {
    assert.doesNotMatch(text, new RegExp(PASSWORD));
    assert.match(text, /kunde\.dk/);
  }
  // A working key next to it is still measured and still reported: the broken
  // one cannot take the report down with it (P1-40).
  const both = buildReport({
    urls: {
      [url]: { addedAt: '2026-09-01T00:00:00.000Z', wasUp: false, lastChecked: '2026-09-26T10:00:00.000Z', checks: 4, checksUp: 1 },
      'https://kunde.dk/': { addedAt: '2026-09-01T00:00:00.000Z', wasUp: true, lastChecked: '2026-09-26T10:00:00.000Z', checks: 4, checksUp: 4 },
    },
    license,
  }, { now: new Date('2026-09-26T12:00:00.000Z') });
  assert.equal(both.sites.length, 2);
  assert.equal(both.summary.sites, 2);
  assert.equal(both.summary.uncheckable, 1);
  assert.doesNotMatch(renderReportMarkdown(both), new RegExp(PASSWORD));
});
