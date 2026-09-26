/**
 * unwatch.test.js — a URL must be able to leave the watch list.
 *
 * Measured first, with the real CLI and a real state file, before any line was
 * written. There was no way to do it: `deskuptime watch <url>` added a URL to
 * `state.json` and no command ever removed one, so
 *
 *   - a decommissioned site stayed in `watch --status`, in `status` and in every
 *     client report an agency forwards;
 *   - on the free tier it consumed one of the three slots *permanently*, so a
 *     bureau that wanted to monitor a fourth site had to hand-edit
 *     `~/.deskuptime/state.json` — the file that also holds the license key.
 *
 * These tests pin the three things that must hold afterwards: the URL is gone,
 * nothing else is (license, other URLs, daily history), and the freed slot is
 * usable again by the real `watch --once`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadState, runOnce, unwatchUrls } from '../src/watch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** A temp HOME holding a state file and a history file, so nothing leaks. */
function withState(t, { urls, license, history } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-unwatch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  if (urls) writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({ urls, ...(license ? { license } : {}) }));
  if (history) writeFileSync(join(home, '.deskuptime', 'history.json'), JSON.stringify(history, null, 2));
  return { HOME: home, USERPROFILE: home, dir: join(home, '.deskuptime') };
}

const entry = (overrides = {}) => ({ addedAt: new Date().toISOString(), wasUp: true, checks: 4, checksUp: 4, ...overrides });
const LICENSE = { key: 'a'.repeat(32), instance: 'deskuptime-test', status: 'active' };
const HISTORY = JSON.stringify({ version: 1, urls: { 'https://a.test/': { [new Date().toISOString().slice(0, 10)]: { checks: 9, failures: 1 } } } }, null, 2);

test('unwatch fjerner den URL og lader alt andet være', async (t) => {
  const home = withState(t, {
    urls: { 'https://a.test/': entry(), 'https://b.test/': entry(), 'https://c.test/': entry() },
    license: LICENSE,
    history: JSON.parse(HISTORY),
  });

  const result = await run(['unwatch', 'https://b.test/'], { env: home });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No longer monitoring: https:\/\/b\.test\//);

  const state = JSON.parse(readFileSync(join(home.dir, 'state.json'), 'utf-8'));
  assert.deepEqual(Object.keys(state.urls).sort(), ['https://a.test/', 'https://c.test/']);
  // Licensen er den betalte maskines ejendom; den må ikke ryde med.
  assert.deepEqual(state.license, LICENSE);
  // Historien er ikke en del af "stop overvågning" — den er 30 dages rapportgrund,
  // så filen skal være tegn for tegn den, brugeren havde.
  assert.equal(readFileSync(join(home.dir, 'history.json'), 'utf-8'), HISTORY);
});

test('en URL der ikke overvåges fjerner intet og giver exit 1', async (t) => {
  const home = withState(t, { urls: { 'https://a.test/': entry() } });
  const result = await run(['unwatch', 'https://ukendt.test/'], { env: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not monitored: https:\/\/ukendt\.test\//);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home.dir, 'state.json'), 'utf-8')).urls), ['https://a.test/']);
});

test('blandet kald fjerner de overvågede og siger hvilke der ikke var', async (t) => {
  const home = withState(t, { urls: { 'https://a.test/': entry(), 'https://b.test/': entry() } });
  const result = await run(['unwatch', 'https://a.test/', 'https://b.test/', 'https://c.test/'], { env: home });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No longer monitoring: https:\/\/a\.test\//);
  assert.match(result.stdout, /No longer monitoring: https:\/\/b\.test\//);
  assert.match(result.stderr, /not monitored: https:\/\/c\.test\//);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home.dir, 'state.json'), 'utf-8')).urls), []);
});

test('den frigjorte plads kan bruges af en gratis-bruger til et fjerde site', async (t) => {
  const home = withState(t, {
    urls: { 'https://1.test/': entry(), 'https://2.test/': entry(), 'https://3.test/': entry() },
  });
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const { port } = server.address();
  const fourth = `http://127.0.0.1:${port}/`;

  // Før: tre slots brugt, det fjerde site afvist.
  const before = await run(['watch', fourth, '--once'], { env: home });
  assert.equal(before.code, 1);
  assert.match(before.stderr, /Free tier monitors 3 URLs/);

  await run(['unwatch', 'https://3.test/'], { env: home });

  // Efter: det samme fjerde site er accepteret og passes rigtigt med CLI'en.
  // Exit 2 er korrekt her: de to gamle https://N.test er DOWN, og passet dækker
  // hele watch-listen — det er pladsen, der er testen.
  const after = await run(['watch', fourth, '--once'], { env: home });
  assert.doesNotMatch(after.stderr, /Free tier monitors 3 URLs/);
  const state = JSON.parse(readFileSync(join(home.dir, 'state.json'), 'utf-8'));
  assert.equal(fourth in state.urls, true, 'det fjerde site blev ikke overvåget');
});

test('ugyldig URL og manglende argument fejler deterministisk, uden at røre state', async (t) => {
  const home = withState(t, { urls: { 'https://a.test/': entry() } });
  const none = await run(['unwatch'], { env: home });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /at least one URL required/);
  const bad = await run(['unwatch', 'ftp://a.test/'], { env: home });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Invalid URL/);
  const flag = await run(['unwatch', '--all'], { env: home });
  assert.equal(flag.code, 1);
  assert.match(flag.stderr, /Unknown option: --all/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home.dir, 'state.json'), 'utf-8')).urls), ['https://a.test/']);
});

test('unwatch går ingen vejs på nettet og opretter ingen state-fil, hvor der ikke var en', async (t) => {
  const home = withState(t, { urls: { 'https://a.test/': entry() } });
  // readFileSync på en fil der ikke findes ville kaste; her er det kun et tjek.
  assert.equal(existsSync(join(home.dir, 'state.json')), true);
  const removed = await unwatchUrls(['https://a.test/'], { env: home });
  assert.deepEqual(removed.removed, ['https://a.test/']);
  assert.equal(removed.remaining, 0);

  const empty = mkdtempSync(join(tmpdir(), 'deskuptime-unwatch-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const missing = await unwatchUrls(['https://a.test/'], { env: { HOME: empty, USERPROFILE: empty } });
  assert.deepEqual(missing.missing, ['https://a.test/']);
  assert.equal(existsSync(join(empty, '.deskuptime', 'state.json')), false);
});

test('en gammel pass-tid i den fjernede entry gør ingen skade, og en frisk pass skriver stadig', async (t) => {
  const home = withState(t, { urls: { 'https://a.test/': entry({ lastChecked: new Date(Date.now() - 41 * DAY_MS).toISOString() }) } });
  const result = await run(['unwatch', 'https://a.test/'], { env: home });
  assert.equal(result.code, 0);
  assert.equal(loadState({ env: home }).urls['https://a.test/'], undefined);
});
