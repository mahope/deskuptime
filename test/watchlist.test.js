/**
 * P1-43 — a running loop has to hear that a URL was unwatched.
 *
 * Measured 2026-09-26 with the real CLI, a real paid loop
 * (`watch a b --webhook … --interval 30`), a real state file and a real
 * `deskuptime unwatch b` in a second process, on a local fixture that answers
 * 200 for both URLs:
 *
 *   deskuptime unwatch b  →  ✅ No longer monitoring: http://…/b
 *   state.json            →  [ a ]                      ← the file agrees
 *   …one loop pass later…
 *   state.json            →  [ a, b ]                   ← the loop put it back
 *   deskuptime status     →  Monitored URLs (2)
 *
 * Nothing in the loop could have known: `mergePersistedState()` merged the
 * file's entries *into* the loop's copy and never dropped one, so the loop's
 * memory — the only other copy of the list — was the one that survived, and the
 * write at the end of the pass put the URL back on disk. The command said the
 * site had stopped being monitored, and thirty seconds later it was being
 * monitored again, with the file, `status` and the client report all agreeing
 * on the wrong answer. On the free tier it is worse than a wrong answer: the
 * freed slot is gone again, so the next `watch <url>` answers "Free tier
 * monitors 3 URLs" and the only way back is hand-editing the file that holds
 * the license key.
 *
 * The signal that separates "somebody removed this on purpose" from "the file
 * on disk is our own past" is the file's mtime against the loop's own last
 * write — and the URLs the loop wrote itself, so a URL named on the command
 * line can never be talked out of existence by a file. These tests are all
 * local files: no network, no timers, no loop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergePersistedState, saveState, stateFileMtimeMs } from '../src/watch.js';

const A = 'https://a.dk/';
const B = 'https://b.dk/';
const C = 'https://c.dk/';
const PASSED = '2026-09-26T21:00:00.000Z';

const entry = (lastChecked = PASSED) => ({ wasUp: true, lastChecked, checks: 4, checksUp: 4 });

function stateFile() {
  return join(mkdtempSync(join(tmpdir(), 'deskuptime-list-')), 'state.json');
}

/** The loop's own copy of the state, and the file it writes from it. */
function loopWith(urls, file) {
  const state = { urls: Object.fromEntries(urls.map(url => [url, entry()])) };
  saveState(state, { stateFile: file });
  return state;
}

/** What `deskuptime unwatch` (or a cron pass, or a restore) leaves behind. */
function anotherWriterKeeps(file, urls) {
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  onDisk.urls = Object.fromEntries(urls.map(url => [url, onDisk.urls[url] || entry()]));
  writeFileSync(file, JSON.stringify(onDisk, null, 2));
}

test('a URL the file no longer has is dropped from the running loop', () => {
  const file = stateFile();
  const state = loopWith([A, B], file);
  anotherWriterKeeps(file, [A]);

  mergePersistedState(state, { stateFile: file });

  assert.deepEqual(Object.keys(state.urls), [A], 'the unwatched URL left the loop');
});

test('a file that is older than the loop\'s own last write removes nothing', () => {
  // The unwritable state file of P1-39: the file on disk is behind, so it is
  // the loop's past, not somebody's present. Deleting here would throw away
  // the only copy of a monitored site because a disk was full for a while.
  const file = stateFile();
  const state = loopWith([A, B], file);
  anotherWriterKeeps(file, [A]);
  const past = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(file, past, past);
  assert.ok(stateFileMtimeMs(file) < Date.now(), 'the file really is older than the write');

  mergePersistedState(state, { stateFile: file });

  assert.deepEqual(Object.keys(state.urls).sort(), [A, B], 'both URLs are still monitored');
});

test('a URL the loop has not written yet is never removed', () => {
  // `deskuptime watch c` while a loop is running: the URL is in the loop's
  // memory and not yet on disk. The file is newer (the loop wrote it), and the
  // URL must survive that — otherwise starting a loop would refuse to monitor
  // the URL it was asked to monitor.
  const file = stateFile();
  const state = loopWith([A], file);
  state.urls[C] = entry();
  anotherWriterKeeps(file, [A]);

  mergePersistedState(state, { stateFile: file });

  assert.deepEqual(Object.keys(state.urls).sort(), [A, C]);
});

test('a removal is adopted, and the entries of the URLs that stay are still merged', () => {
  const file = stateFile();
  const state = loopWith([A, B], file);
  // Somebody else's newer pass for A, and B is gone.
  anotherWriterKeeps(file, [A]);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  onDisk.urls[A].lastChecked = '2026-09-26T21:30:00.000Z';
  onDisk.urls[A].checks = 9;
  writeFileSync(file, JSON.stringify(onDisk, null, 2));

  mergePersistedState(state, { stateFile: file });

  assert.deepEqual(Object.keys(state.urls), [A]);
  assert.equal(state.urls[A].checks, 9, 'the newer pass for the URL that stayed was merged');
  assert.equal(state.urls[A].lastChecked, '2026-09-26T21:30:00.000Z');
});

test('an older pass on disk still does not roll an entry back', () => {
  // isNewerPass() stays the one owner of that decision: a file that carries an
  // *older* reading of a URL we still monitor must not undo ours.
  const file = stateFile();
  const state = loopWith([A], file);
  state.urls[A] = entry('2026-09-26T22:00:00.000Z');
  saveState(state, { stateFile: file });
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  onDisk.urls[A].lastChecked = '2026-09-26T20:00:00.000Z';
  onDisk.urls[A].checks = 1;
  writeFileSync(file, JSON.stringify(onDisk, null, 2));

  mergePersistedState(state, { stateFile: file });

  assert.equal(state.urls[A].lastChecked, '2026-09-26T22:00:00.000Z');
  assert.equal(state.urls[A].checks, 4);
});
