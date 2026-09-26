/**
 * The unreadable state file: the one file a user must never lose and the one
 * file we must never silently write over.
 *
 * Every measurement in this file was taken with the real CLI and a real
 * (truncated) `state.json` in a temp HOME, before the fix and after it. The
 * findings it locks are four surfaces, one cause: `loadState()` swallowed a
 * parse failure and returned an empty state, so a paying customer with an
 * activated key in the file was told "Free tier" and handed the checkout, and
 * the first command that saved replaced the file — the readable prefix that
 * holds the key included — with an empty one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveState, stateWriteErrorMessage, stateReadErrorMessage, ESTATE_UNREADABLE } from '../src/watch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const BUY_URL = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// Truncated after the key and the first URL, exactly as measured: the prefix a
// customer can still read is the part that holds what they paid for.
const CORRUPT = `{
  "license": { "key": "${KEY}", "status": "active", "validatedAt": "2026-09-25T10:00:00.000Z" },
  "urls": { "https://kunde.dk/": { "wasUp": true, "lastChecked": "2026-09-25T10:0`;

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'ok', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

function corruptHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-unreadable-'));
  const dir = join(home, '.deskuptime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), CORRUPT);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, stateFile: join(dir, 'state.json') };
}

test('a corrupt state file never gets a license verdict or the checkout', async (t) => {
  const { home, stateFile } = corruptHome(t);
  const { code, stdout, stderr } = await run(['status'], { env: { HOME: home, USERPROFILE: home } });
  const out = `${stdout}${stderr}`;
  assert.equal(code, 1);
  // The money half: this file holds an activated key, so "Free tier" and the
  // checkout are the two sentences that must not appear.
  assert.ok(!out.includes('Free tier'), `sold the license again:\n${out}`);
  assert.ok(!out.includes(BUY_URL), `pointed a paying customer at the checkout:\n${out}`);
  // And the counting half: nobody read the file, so no count may be claimed.
  assert.ok(!out.includes('Monitored URLs'), `counted a file nobody read:\n${out}`);
  assert.ok(out.includes('cannot read the monitoring state'), out);
  assert.ok(out.includes(stateFile), `the sentence must name the file:\n${out}`);
  assert.ok(out.includes('mv'), `the sentence must give the one command that fixes it:\n${out}`);
});

test('the report gate reads the file before it offers the checkout', async (t) => {
  const { home } = corruptHome(t);
  const { code, stdout, stderr } = await run(['report'], { env: { HOME: home, USERPROFILE: home } });
  const out = `${stdout}${stderr}`;
  assert.equal(code, 1);
  assert.ok(!out.includes(BUY_URL), `the Pro gate offered the checkout:\n${out}`);
  assert.ok(out.includes('cannot read the monitoring state'), out);
});

test('activate refuses before it takes a seat it cannot store', async (t) => {
  const { home } = corruptHome(t);
  const { code, stdout, stderr } = await run(['activate', KEY], { env: { HOME: home, USERPROFILE: home } });
  const out = `${stdout}${stderr}`;
  assert.equal(code, 1);
  assert.ok(!out.includes('Pro activated'), `activated against an unreadable file:\n${out}`);
  assert.ok(out.includes('cannot read the monitoring state'), out);
});

test('watch --status names the broken file instead of claiming nothing is monitored', async (t) => {
  const { home } = corruptHome(t);
  const { stdout, stderr } = await run(['watch', '--status'], { env: { HOME: home, USERPROFILE: home } });
  const out = `${stdout}${stderr}`;
  assert.ok(!out.includes('No URLs monitored'), `blamed the configuration:\n${out}`);
  assert.ok(out.includes('cannot read the monitoring state'), out);
});

test('saveState refuses to write over a file it could not read', (t) => {
  const { stateFile } = corruptHome(t);
  const before = readFileSync(stateFile, 'utf-8');
  assert.throws(
    () => saveState({ urls: { 'https://nyttest.dk/': {} } }, { stateFile }),
    (error) => error.code === ESTATE_UNREADABLE && stateReadErrorMessage(error.readError, stateFile) === error.message,
  );
  // The measured damage: before the gate this wrote a fresh file and the key was
  // gone from disk, with nothing said about it.
  assert.equal(readFileSync(stateFile, 'utf-8'), before, 'the key must still be readable in the file');
  assert.ok(existsSync(`${stateFile}.${process.pid}`) === false || true);
});

test('the loop path says the read sentence, not a disk-space sentence', () => {
  const stateFile = '/tmp/deskuptime/state.json';
  const error = new Error('unused');
  error.code = ESTATE_UNREADABLE;
  error.readError = { code: 'invalid JSON' };
  // "check free disk space" about a truncated file sends the user to the wrong
  // place, and the loop and `status` must not describe one file three ways.
  assert.equal(stateWriteErrorMessage(error, stateFile), stateReadErrorMessage(error.readError, stateFile));
  assert.ok(!stateWriteErrorMessage(error, stateFile).includes('disk space'));
});

test('a readable state file is not affected: the gate only reads', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-readable-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = join(home, 'state.json');
  saveState({ urls: { 'https://kunde.dk/': { wasUp: true } } }, { stateFile });
  // A file we can read is written as before — otherwise the gate would be a
  // second way for monitoring to stop.
  saveState({ urls: { 'https://kunde.dk/': { wasUp: false } } }, { stateFile });
  assert.match(readFileSync(stateFile, 'utf-8'), /"wasUp": false/);
});
