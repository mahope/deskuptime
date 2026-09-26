/**
 * A monitoring pass that cannot be written must still be delivered.
 *
 * Measured 2026-09-26 with the real CLI, a real `--webhook` receiver and a
 * `~/.deskuptime` that could not be written: the process died with a Node stack
 * trace, exit 1, and the receiver got nothing at all while a monitored site
 * answered 500. The state file holds the counters; the events hold the alert,
 * and only the second one is what a paying customer is buying.
 *
 * The unwriteable directory here is a file used as a directory
 * (`<tmp>/blocker/state.json`), so `mkdir` fails with ENOTDIR on every platform.
 * A full disk gives ENOSPC and a read-only mount EACCES/EPERM — measured
 * separately with an immutable directory — and none of the three changes which
 * branch is taken.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPass, runOnce, unwatchUrls, stateWriteErrorMessage } from '../src/watch.js';

const UP_URL = 'http://op.example/';
const DOWN_URL = 'http://nede.example/';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'deskuptime-passstate-'));
}

/** A state file whose folder can never be created: `blocker` is a regular file. */
function blockedStateFile(home) {
  const blocker = join(home, 'blocker');
  writeFileSync(blocker, 'not a directory');
  return join(blocker, '.deskuptime', 'state.json');
}

function watchedState(urls) {
  return {
    urls: Object.fromEntries(urls.map(url => [url, {
      addedAt: '2026-09-01T00:00:00.000Z',
      wasUp: true,
      lastChecked: '2026-09-25T12:00:00.000Z',
      checks: 10,
      checksUp: 10,
      sslWarned: false,
    }])),
  };
}

// One down site, one up site, no network: the checker is the thing under test in
// watchalert.test.js, here it only has to produce a verdict.
const stubCheck = (url) => Promise.resolve({
  url,
  timestamp: '2026-09-26T10:00:00.000Z',
  reachable: true,
  healthy: url !== DOWN_URL,
  statusCode: url === DOWN_URL ? 500 : 200,
  responseTimeMs: 12,
  finalUrl: url,
  ssl: null,
  content: null,
  errorType: url === DOWN_URL ? 'http_error' : null,
  error: url === DOWN_URL ? 'HTTP 500' : null,
});

test('a pass that cannot be saved still returns its events', async () => {
  const home = tempHome();
  const stateFile = blockedStateFile(home);
  const pass = await runPass(watchedState([UP_URL, DOWN_URL]), {
    stateFile,
    check: stubCheck,
    returnResults: true,
  });

  assert.equal(pass.stateSaved, false, 'the pass must admit it was not saved');
  assert.equal(pass.results.length, 2, 'both sites were measured');
  assert.deepEqual(
    pass.events.filter(event => event.type === 'down').map(event => event.url),
    [DOWN_URL],
    'the down event a customer pays for survives an unwritable state file',
  );
  assert.equal(pass.healthy, false, 'the pass still knows a site is down');
});

test('a pass that can be saved says so, and is on disk', async () => {
  const home = tempHome();
  const stateFile = join(home, '.deskuptime', 'state.json');
  const pass = await runPass(watchedState([UP_URL]), { stateFile, check: stubCheck, returnResults: true });

  assert.equal(pass.stateSaved, true);
  const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert.equal(saved.urls[UP_URL].checks, 11, 'the counter reached the disk');
});

test('the warning names the file and the reason, not a temp filename', async () => {
  const home = tempHome();
  const stateFile = blockedStateFile(home);
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await runPass(watchedState([DOWN_URL]), { stateFile, check: stubCheck, returnResults: true });
  } finally {
    console.error = original;
  }

  const warning = lines.join('\n');
  assert.match(warning, /Could not write the monitoring state/, warning);
  assert.match(warning, /ENOTDIR/, `the errno has to be visible: ${warning}`);
  assert.ok(warning.includes(stateFile), `the file has to be visible: ${warning}`);
  assert.match(warning, /alerts keep working/i, `what still works has to be said: ${warning}`);
  assert.match(warning, /Nothing is remembered/, `what is lost has to be said: ${warning}`);
  assert.doesNotMatch(warning, /\.tmp/, `a temp name is noise: ${warning}`);
});

test('runOnce reports an unwritable state folder instead of throwing', async () => {
  const home = tempHome();
  const result = await runOnce([UP_URL], { stateFile: blockedStateFile(home) });

  assert.equal(result.busy, undefined, 'a full disk is not a running pass');
  assert.ok(result.stateError, 'the reason is returned, not thrown');
  assert.equal(result.stateError.code, 'ENOTDIR');
  assert.match(stateWriteErrorMessage(result.stateError, blockedStateFile(home)), /disk space|writable/);
});

test('unwatch reports the same reason, and changes nothing', async () => {
  const home = tempHome();
  const stateFile = blockedStateFile(home);
  const result = await unwatchUrls([UP_URL], { stateFile });

  assert.ok(result.stateError, 'the reason is returned, not thrown');
  assert.deepEqual(result.removed, [], 'nothing was removed from a file we cannot write');
  assert.ok(!existsSync(join(home, 'blocker', '.deskuptime')), 'no folder was conjured up');
});

test('one message owns the sentence, so no surface writes its own', () => {
  const message = stateWriteErrorMessage({ code: 'ENOSPC' }, '/home/x/.deskuptime/state.json');
  assert.match(message, /ENOSPC/);
  assert.match(message, /\/home\/x\/\.deskuptime\/state\.json/);
  assert.match(message, /Nothing is remembered/);
});
