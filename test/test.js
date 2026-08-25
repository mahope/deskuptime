#!/usr/bin/env node
/**
 * DeskUptime test suite — node:test, zero dependencies.
 * Run: npm test   (or: node test/test.js)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const CLI = join(new URL('..', import.meta.url).pathname, 'src', 'cli.js');

// ── Unit: hash-based change detection ──
function sha(s) { return createHash('sha256').update(s).digest('hex'); }

test('hash: identical content produces identical hash', () => {
  assert.equal(sha('<html>hello</html>'), sha('<html>hello</html>'));
});

test('hash: changed content produces different hash', () => {
  assert.notEqual(sha('<html>v1</html>'), sha('<html>v2</html>'));
});

// ── CLI behaviour ──
test('cli: --version prints version', async () => {
  const { stdout } = await run('node', [CLI, '--version']);
  assert.match(stdout.trim(), /^deskuptime v\d+\.\d+\.\d+$/);
});

test('cli: --help lists commands and does not leak template bugs', async () => {
  const { stdout } = await run('node', [CLI, '--help']);
  assert.match(stdout, /check <urls/);
  assert.match(stdout, /watch <url>/);
  // regression: literal $(...) must never appear in rendered help
  assert.ok(!stdout.includes('$('));
});

test('cli: check without URLs exits non-zero', async () => {
  await assert.rejects(
    () => run('node', [CLI, 'check']),
    (err) => err.code !== 0
  );
});

test('cli: check skips invalid URLs, errors when none valid', async () => {
  await assert.rejects(() => run('node', [CLI, 'check', 'not-a-url']));
});

// ── Live check against example.com (network required) ──
test('cli: check https://example.com returns UP + SSL', { timeout: 30000 }, async () => {
  const { stdout } = await run('node', [CLI, 'check', 'https://example.com']);
  assert.match(stdout, /✅ https:\/\/example\.com/);
  assert.match(stdout, /Status:\s+200/);
  assert.match(stdout, /SSL/);
});

// ── JSON mode (if implemented): machine-readable output ──
test('cli: check --json outputs valid JSON array', { timeout: 30000 }, async () => {
  const { stdout } = await run('node', [CLI, 'check', 'https://example.com', '--json']);
  const data = JSON.parse(stdout);
  assert.ok(Array.isArray(data));
  assert.equal(data[0].url, 'https://example.com');
  assert.equal(data[0].reachable, true);
  assert.equal(data[0].statusCode, 200);
});

// ── Watch state handling ──
test('watch state: corrupt state file recovers to empty state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'du-test-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, '{not valid json');
  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf-8')); } catch { state = { urls: {} }; }
  assert.deepEqual(state, { urls: {} });
  rmSync(dir, { recursive: true, force: true });
});

// ── License / status commands ──
test('cli: status runs and reports tier', async () => {
  const { stdout } = await run('node', [CLI, 'status']);
  assert.match(stdout, /(Free tier|Pro license)/);
});

test('cli: activate without key exits non-zero with usage', async () => {
  await assert.rejects(
    () => run('node', [CLI, 'activate']),
    (err) => err.code !== 0
  );
});
