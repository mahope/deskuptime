/**
 * P1-51 — the client report counted in the wrong plural.
 *
 * Measured 2026-09-27 with the real CLI, a real Pro license stub (never a call
 * to mahope.tools) and a real `state.json` + `history.json` holding one site
 * monitored once — the state of a bureau that added a customer's site yesterday
 * and sends the first report the next morning:
 *
 *   | http://one.test/ | UP | 100% (1 checks) | 100% (1 recorded d, 1 checks) | … |
 *   **1 site(s) · 1 up · 0 down · 1 checks · 0 failed**
 *
 * Three of the seven columns' worth of prose, on the report that is the paid
 * product: the number was right and the English was not, on the exact row a
 * customer reads when a site is new. Nothing else on the surface was wrong — the
 * counts, the partition, the window coverage and the JSON were all correct, and
 * the same report for a site with four checks already read `4 checks`.
 *
 * The first tests are about what must not change: every multi-count form, the
 * `failed` wording, the deliberately uninflected `site(s)` and the whole JSON
 * contract. The last test is the lock, and it is the one that matters: a new
 * counted noun in this document is a fourth place to get it wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderReportMarkdown, buildReport, siteBuckets } from '../src/report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const STUB = join(ROOT, 'test', 'fixtures', 'license-stub.mjs');
const KEY = '0123456789abcdef0123456789abcdef';
const license = { key: KEY, instance: 'p151', plan: 'pro', status: 'active', validatedAt: new Date().toISOString() };

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', STUB, CLI, ...args], {
      env: { ...process.env, DUB_STUB_SCENARIO: 'passthrough', ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

/** A home holding the exact shape `watch` writes: a Pro license and these counters. */
function home(t, { urls, history = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-grammar-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.deskuptime'), { recursive: true });
  writeFileSync(join(dir, '.deskuptime', 'state.json'), JSON.stringify({
    license,
    urls: Object.fromEntries(Object.entries(urls).map(([url, e]) => [url, {
      wasUp: e.checksUp > 0,
      lastChecked: new Date().toISOString(),
      lastResponseMs: 12,
      lastStatus: e.checksUp > 0 ? 200 : 500,
      addedAt: new Date().toISOString(),
      ...e,
    }])),
  }, null, 2));
  if (Object.keys(history).length > 0) {
    writeFileSync(join(dir, '.deskuptime', 'history.json'), JSON.stringify({ version: 1, urls: history }, null, 2));
  }
  return { HOME: dir, USERPROFILE: dir };
}

const day = new Date().toISOString().slice(0, 10);

test('one check is one check, in every column that counts', async t => {
  // The measured journey: a site added yesterday, report the next morning.
  const site = 'http://one.test/';
  const { stdout } = await run(['report', '--title', 'Acme'], home(t, {
    urls: { [site]: { checks: 1, checksUp: 1 } },
    history: { [site]: { [day]: { checks: 1, failures: 0 } } },
  }));
  const row = stdout.split('\n').find(line => line.startsWith(`| ${site}`));
  assert.ok(row, `the site must have a row, got:\n${stdout}`);
  assert.match(row, /100% \(1 check\)/, 'Uptime (all) says check, not checks');
  assert.match(row, /100% \(1 recorded d, 1 check\)/, 'Uptime (window) agrees with it');
  assert.doesNotMatch(row, /1 checks/, 'the measured defect, in no column');
});

test('the summary line under the table counts the same way', async t => {
  const site = 'http://one.test/';
  const { stdout } = await run(['report', '--title', 'Acme'], home(t, {
    urls: { [site]: { checks: 1, checksUp: 1 } },
    history: { [site]: { [day]: { checks: 1, failures: 0 } } },
  }));
  const line = stdout.split('\n').find(l => l.startsWith('**'));
  assert.match(line, /· 1 check ·/, `the summary line counts one check, got: ${line}`);
  assert.doesNotMatch(line, /1 checks/, 'the measured defect, on the first line a client reads');
});

test('a single failure is still "1 failed", not "1 faileds"', async t => {
  // The wording is not the defect and must not drift into one. `1 failed` is a
  // correct label beside a count; the fix was never to re-inflect it.
  const site = 'http://two.test/';
  const { stdout } = await run(['report', '--title', 'Acme'], home(t, {
    urls: { [site]: { checks: 1, checksUp: 0 } },
    history: { [site]: { [day]: { checks: 1, failures: 1 } } },
  }));
  const row = stdout.split('\n').find(line => line.startsWith(`| ${site}`));
  assert.match(row, /0% \(1 check, 1 failed\)/, 'one check, one failure, both correct');
});

test('a site measured many times is unchanged, in every form', async t => {
  // The regression the fix must not cause: everything that was already right.
  const site = 'http://busy.test/';
  const { stdout } = await run(['report', '--title', 'Acme'], home(t, {
    urls: { [site]: { checks: 40, checksUp: 39 } },
    history: { [site]: { [day]: { checks: 40, failures: 3 } } },
  }));
  const row = stdout.split('\n').find(line => line.startsWith(`| ${site}`));
  assert.match(row, /97\.5% \(40 checks, 1 failed\)/, 'plural check and failure, unchanged');
  const line = stdout.split('\n').find(l => l.startsWith('**'));
  assert.match(line, /1 site\(s\) · 1 up · 0 down · 40 checks · 1 failed/, 'summary plural unchanged, site(s) still deliberately uninflected');
});

test('the JSON contract is untouched: the counts were never the problem', async t => {
  // A consumer scripts against these numbers, and they were always right. The
  // fix is prose, so nothing here may move — not even the key order.
  const site = 'http://one.test/';
  const { stdout } = await run(['report', '--json'], home(t, {
    urls: { [site]: { checks: 1, checksUp: 1 } },
    history: { [site]: { [day]: { checks: 1, failures: 0 } } },
  }));
  const json = JSON.parse(stdout);
  assert.equal(json.summary.sites, 1);
  assert.equal(json.summary.checks, 1);
  assert.equal(json.summary.failures, 0);
  assert.equal(json.sites[0].checks, 1, 'a machine never learns a grammar rule');
  assert.equal(json.partition.up, 1);
});

test('no counted noun in the document can drift back to a fixed plural', () => {
  // The lock. A new counted noun added to the report later is a fourth place to
  // get this wrong, and it is the only test here that looks at the document as a
  // whole rather than at one measured line.
  const sites = [
    { url: 'http://a.test/', status: 'up', uptimePercent: 100, checks: 1, checksUp: 1, failures: 0, lastChecked: new Date().toISOString(), passRecorded: true, stale: false, window: { uptimePercent: 100, days: 1, checks: 1, failures: 0 } },
    { url: 'http://b.test/', status: 'up', uptimePercent: 100, checks: 2, checksUp: 2, failures: 0, lastChecked: new Date().toISOString(), passRecorded: true, stale: false, window: { uptimePercent: 100, days: 1, checks: 1, failures: 0 } },
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    sites,
    summary: { sites: 2, checks: 3, failures: 0 },
    partition: siteBuckets(sites),
  };
  const markdown = renderReportMarkdown(report);
  assert.doesNotMatch(markdown, /\b1 checks\b/, 'no "1 checks" anywhere in the document');
  assert.doesNotMatch(markdown, /\b1 faileds\b/, 'nor "1 faileds"');
  assert.doesNotMatch(markdown, /\b1 recorded days\b/, 'nor "1 recorded days"');
  assert.match(markdown, /1 check\b/, 'and the singular is actually there');
  assert.match(markdown, /\b2 checks\b|\b3 checks\b/, 'while the plural still reads');
});

test('buildReport keeps the counts it has always reported', () => {
  // The unit under the prose: one site, one check, one share.
  const site = 'http://one.test/';
  const report = buildReport(
    { urls: { [site]: { wasUp: true, checks: 1, checksUp: 1, lastChecked: new Date().toISOString() } } },
    { history: { version: 1, urls: { [site]: { [day]: { checks: 1, failures: 0 } } } }, windowDays: 30 },
  );
  const row = report.sites.find(s => s.url === site);
  assert.equal(row.checks, 1);
  assert.equal(row.uptimePercent, 100);
  assert.equal(row.window.checks, 1);
});
