/**
 * P1-83: the client report called a key with a password in it "not a full
 * address" — in three places, and it is a full address.
 *
 * Measured 2026-09-28 with the real `buildReport`/`renderReportMarkdown` over
 * one real `state.json` holding `kunde.dk` and `http://demo:pass@kunde.dk/`,
 * before the fix:
 *
 *   | http://kunde.dk/ | not a full address, so no pass can check it | … |
 *   **3 site(s) · … · 2 not a full address**
 *   **2 listed URLs are not a full address, so no monitoring pass can check them …**
 *
 * Same key, same row, four surfaces, two sentences. `http://demo:pass@kunde.dk/`
 * has a scheme, a host and a path: it is a full address, and the only thing
 * wrong with it is that no pass may send a request to it. `src/status.js` says
 * so in its own comment, and the long note the terminal lists use has said it
 * since P1-40. P1-82 fixed the two free terminal lists, which borrowed the
 * weaker `isHttpUrl()`; the report asked the strict owner — and handed it the
 * *redacted* key, on which `hasUrlCredentials` is `false`. So the one surface a
 * bureau forwards to a paying customer, the only one where a wrong reason costs
 * a customer relationship, was the last to learn the rule.
 *
 * These tests are the same measurement, kept. No HTTP, no license server, and
 * no password may reach any surface: the tests assert that too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCheckableUrl, readEntry, unusableUrlKind, unusableUrlNote } from '../src/status.js';
import { buildReport, renderReportJson, renderReportMarkdown } from '../src/report.js';
import { tempHome } from './helpers/env.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.js');
const KEY = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'hunter2-very-secret';
const CREDENTIALED = `http://demo:${PASSWORD}@kunde.dk/`;
const REDACTED = 'http://kunde.dk/';
const BROKEN = 'kunde.dk';
const NOW = new Date('2026-09-28T06:00:00.000Z');

/**
 * A key no pass may check, with every number a healthy site would have. The
 * numbers are the point: they are what a hand-edited or restored file holds,
 * and none of them is a measurement anything can make.
 */
const claimedHealthy = {
  addedAt: '2026-09-20T10:00:00.000Z',
  lastChecked: '2026-09-27T10:00:00.000Z',
  wasUp: true,
  lastStatus: 200,
  checks: 4,
  checksUp: 4,
  lastResponseMs: 12,
  lastContentLength: 512,
  lastContentReadAt: '2026-09-27T10:00:00.000Z',
};

const license = { key: KEY, instance: 'p183', plan: 'pro', status: 'active', validatedAt: NOW.toISOString() };

function report(urls) {
  return buildReport({ urls, license }, { now: NOW, title: 'Acme' });
}

function withState(t, urls) {
  const { options, dir } = tempHome(t, 'deskuptime-reportkeyreason-');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ urls, license }, null, 2));
  return options;
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

/** The table row for a key, and the paragraph under the table that names it. */
function row(markdown, url) {
  return markdown.split('\n').find(line => line.startsWith(`| ${url} |`)) ?? '';
}

function named(markdown) {
  return markdown.split('\n').find(line => line.includes('listed URL')) ?? '';
}

function summary(markdown) {
  return markdown.split('\n').find(line => line.startsWith('**') && line.includes('site(s)')) ?? '';
}

// ── The owner ──

test('one fact says which of the two reasons a key has', () => {
  assert.equal(unusableUrlKind(CREDENTIALED), 'credentials');
  assert.equal(unusableUrlKind(BROKEN), 'not-address');
  // A user *name* is a credential too, with no password beside it — the same
  // question the sentences answer, so the two cannot drift apart.
  assert.equal(unusableUrlKind('https://kunde.dk@godt.dk/'), 'credentials');
  // A password in the query or the path is not a credential in the address:
  // `fetch` sends those happily, so that key is checkable and the report gives
  // it no reason at all.
  for (const url of ['https://kunde.dk/pw?pass=hunter2', 'https://kunde.dk/']) {
    assert.equal(isCheckableUrl(url), true, url);
  }
  // The words still follow the kind, asked of the one owner, on the raw key.
  assert.match(unusableUrlNote([CREDENTIALED], { brief: true }), /username or password/);
  assert.equal(unusableUrlNote([BROKEN], { brief: true }), 'not a full address, so no pass can check it');
});

test('the sentences are built from the kind, not from a second rule', () => {
  // A source scan, deliberately: both sentences are correct today, and only
  // the source can tell whether they are still asking the fact above. A second
  // `hasUrlCredentials` in either would be the drift this locks.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'status.js'), 'utf8');
  const body = source.slice(source.indexOf('function unusableUrlReason('));
  const reason = body.slice(0, body.indexOf('\n}\n'));
  const note = source.slice(source.indexOf('export function unusableUrlNote('));
  assert.match(reason, /unusableUrlKind\(url\) === 'credentials'/);
  assert.doesNotMatch(reason, /hasUrlCredentials/);
  assert.match(note, /unusable\.some\(url => unusableUrlKind\(url\) === 'credentials'\)/);
  assert.doesNotMatch(note, /hasUrlCredentials/);
});

// ── The report ──

test('the report names the real reason for a key with a password in it', () => {
  const built = report({ [CREDENTIALED]: claimedHealthy });
  const site = built.sites[0];
  // P1-40's fields, unchanged: they were right before this fix and are right now.
  assert.equal(site.status, 'unknown');
  assert.equal(site.uncheckable, true);
  assert.equal(site.url, REDACTED);
  // …and the reason, on the row, in the owner's words.
  assert.equal(site.uncheckableKind, 'credentials');
  assert.match(site.uncheckableNote, /username or password/);
  assert.doesNotMatch(site.uncheckableNote, /not a full address/);
  assert.doesNotMatch(site.uncheckableNote, new RegExp(PASSWORD));
});

test('every surface of the report says the real reason', () => {
  const markdown = renderReportMarkdown(report({ [CREDENTIALED]: claimedHealthy, [BROKEN]: {} }));
  // The row, the line under the table, and the counts in the summary: three
  // places, one key, one reason each.
  assert.match(row(markdown, REDACTED), /has a username or password in it/);
  assert.doesNotMatch(row(markdown, REDACTED), /not a full address/);
  assert.match(row(markdown, BROKEN), /not a full address/);
  assert.match(named(markdown), new RegExp(`${REDACTED.replace(/[/.]/g, '\\$&')} — has a username or password in it`));
  // The `kunde.dk` key keeps its own reason *in the same line* — a group with
  // two reasons names both, instead of the lead-in's reason being read as the
  // reason for every key under it.
  assert.match(named(markdown), /kunde\.dk — not a full address/);
  assert.match(summary(markdown), /1 not a full address · 1 with a username or password in it/);
  // The footnote that explains the row must cover both forms, or it teaches the
  // reader the wrong rule for the row above it.
  assert.match(markdown, /A listed URL that no pass can send a request to can never be measured at all/);
  assert.doesNotMatch(markdown, /A listed URL that is not a full address can never be measured/);
});

test('the password reaches no surface of the document', () => {
  const built = report({ [CREDENTIALED]: claimedHealthy });
  for (const text of [renderReportMarkdown(built), renderReportJson(built)]) {
    assert.doesNotMatch(text, new RegExp(PASSWORD));
  }
});

test('the report and the terminal row cannot disagree about the same key', () => {
  // The cross-surface lock P1-82 left open: it proved both read the key as
  // `unknown`, and it could not see this — the report had its own sentence
  // three lines further down. Same owner, same words, asked of the same key.
  const built = report({ [CREDENTIALED]: claimedHealthy, [BROKEN]: claimedHealthy });
  for (const [url, kind] of [[CREDENTIALED, /username or password/], [BROKEN, /not a full address/]]) {
    const rowEntry = readEntry(claimedHealthy, { url }).unknownNote;
    const cell = built.sites.find(site => site.url === (url === CREDENTIALED ? REDACTED : url)).uncheckableNote;
    assert.match(rowEntry, kind, url);
    assert.match(cell, kind, url);
    // …and each surface's sentence is about its own key, not the other's.
    assert.doesNotMatch(rowEntry, url === CREDENTIALED ? /not a full address/ : /username or password/);
    assert.doesNotMatch(cell, url === CREDENTIALED ? /not a full address/ : /username or password/);
  }
});

// ── No regression ──

test('a key that is not an address keeps every sentence it always had', () => {
  const markdown = renderReportMarkdown(report({ 'https://godt.dk/': claimedHealthy, [BROKEN]: claimedHealthy }));
  assert.ok(row(markdown, BROKEN).length > 0);
  assert.match(row(markdown, BROKEN), /not a full address, so no pass can check it/);
  assert.match(summary(markdown), /1 not a full address/);
  // One reason across the group, so the lead-in keeps its old sentence: the
  // ordinary document a bureau sends must not change wording because a
  // password-carrying key can exist.
  assert.match(named(markdown), /One listed URL is not a full address, so no monitoring pass can check it/);
  // …and it gains no clause or reason about a reason it does not have. (The
  // footnote below the table names *both* forms, by design — the lock is on the
  // row, the line and the counts a client reads, not on the glossary.)
  assert.doesNotMatch(summary(markdown) + named(markdown), /username or password/);
  assert.equal(report({ [BROKEN]: {} }).sites[0].uncheckableKind, 'not-address');
});

test('a working site beside a broken one is still reported as itself', () => {
  const built = report({ 'https://godt.dk/': claimedHealthy, [CREDENTIALED]: claimedHealthy, [BROKEN]: {} });
  const markdown = renderReportMarkdown(built);
  assert.match(row(markdown, 'https://godt.dk/'), /^\| https:\/\/godt\.dk\/ \| UP \(200\)/);
  assert.equal(built.summary.sites, 3);
  assert.equal(built.summary.uncheckable, 2);
  assert.equal(built.partition.neverChecked, 1);
  // `sites` is ordered by status, not by the state file, so it is addressed by
  // its URL — a checkable key carries no reason at all, not an empty one.
  const working = built.sites.find(site => site.url === 'https://godt.dk/');
  assert.equal(working.uncheckableNote, null);
  assert.equal(working.uncheckableKind, null);
});

// ── The measured surfaces ──

test('the real report command says the same thing as the document', async (t) => {
  const options = withState(t, { [CREDENTIALED]: claimedHealthy, [BROKEN]: {} });
  const { code, stdout } = await run(['report'], options);
  assert.equal(code, 0);
  assert.match(row(stdout, REDACTED), /has a username or password in it/);
  assert.doesNotMatch(row(stdout, REDACTED), /not a full address/);
  assert.match(named(stdout), /has a username or password in it/);
  assert.doesNotMatch(stdout, new RegExp(PASSWORD));

  const json = await run(['report', '--json'], options);
  const parsed = JSON.parse(json.stdout);
  const site = parsed.sites.find(entry => entry.url === REDACTED);
  assert.equal(site.status, 'unknown');
  assert.equal(site.uncheckable, true);
  assert.equal(site.uncheckableKind, 'credentials');
  assert.match(site.uncheckableNote, /username or password/);
  assert.equal(parsed.summary.uncheckable, 2);
});

test('the reason is asked of the raw key, and never of the redacted one', () => {
  // A source scan, and the one that matters: the bug was not a wrong sentence,
  // it was a right sentence asked of the wrong string. `site.url` is the
  // redacted form, and the shape cannot be seen through it — so the call may
  // not be moved to the reader, and the field must be built where the raw key
  // is still in hand.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'report.js'), 'utf8');
  assert.match(source, /uncheckableNote: checkable \? null : unusableUrlNote\(\[url\]/);
  assert.doesNotMatch(source, /unusableUrlNote\(\[site\.url\]/, 'never ask the owner about the redacted key');
  // …and the redacted key is still what a reader sees.
  assert.match(source, /url: withoutCredentials\(url\)/);
  // The count of the two reasons comes from the owner's fact, not from a
  // pattern match on the sentence above it.
  assert.match(source, /site\.uncheckableKind !== 'credentials'/);
});

// ── Both forms, one rule ──

test('every form of a key no pass can check is counted and named once', () => {
  const forms = { [BROKEN]: {}, 'ftp://gammel.dk/': {}, [CREDENTIALED]: {}, 'https://demo@godt.dk/': {} };
  const built = report(forms);
  const markdown = renderReportMarkdown(built);
  assert.equal(built.summary.uncheckable, 4);
  assert.match(summary(markdown), /2 not a full address · 2 with a username or password in it/);
  // One line under the table, one reason per key, and the line names all four.
  const line = named(markdown);
  assert.equal(line.split('; ').length, 4, line);
  assert.doesNotMatch(line, /not a full address, so no monitoring pass can check/);
  for (const url of ['ftp://gammel.dk/', REDACTED, 'https://godt.dk/']) {
    assert.ok(line.includes(url), `${url} is missing from: ${line}`);
  }
  // A user name with no password beside it is the same class, and is named the
  // same way — it is a full address too.
  assert.equal(built.sites.find(site => site.url === 'https://godt.dk/').uncheckableKind, 'credentials');
});
