#!/usr/bin/env node
/**
 * An end-to-end measurement: two real local servers, real `runPass` passes over
 * them, a real webhook receiver, and then every surface printed over the state
 * file those passes really wrote. Only the license is a stored record, and it
 * is the one a machine that activated once carries — no call is made.
 *
 *   node tools/measure-e2e.mjs
 *
 * It exists so a claim about a site can be read on one screen across the
 * terminal, the channel and the customer document, before anything is changed.
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPass, sendWebhook } from '../src/watch.js';
import { checkUrl } from '../src/engine.js';
import { tempHome } from '../test/helpers/env.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.js');

function listen(handler) {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const run = (home, args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      err: '',
    };
  } catch (error) {
    return { code: error.status ?? -1, out: error.stdout ?? '', err: error.stderr ?? '' };
  }
};

// ── The servers ──────────────────────────────────────────────────────────────

let title = 'Acme — home';
const { server: site, port: sitePort } = await listen((req, res) => {
  if (req.url === '/gone') {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('unavailable');
    return;
  }
  const body = `<!doctype html><html><head><title>${title}</title></head><body><h1>Acme</h1></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
});

const delivered = [];
const { server: hook, port: hookPort } = await listen((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try { delivered.push(JSON.parse(body)); } catch { delivered.push({ raw: body }); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

const url = `http://127.0.0.1:${sitePort}/`;
const webhook = `http://127.0.0.1:${hookPort}/hook`;

// ── The machine ──────────────────────────────────────────────────────────────

const { home, options: env, dir } = tempHome(null, 'deskuptime-e2e-');
mkdirSync(dir, { recursive: true });
const state = {
  version: 1,
  license: {
    key: '0123456789abcdef0123456789abcdef',
    instance: 'deskuptime-e2e',
    plan: 'pro',
    status: 'active',
    validatedAt: new Date().toISOString(),
  },
  urls: { [url]: { addedAt: new Date().toISOString() } },
};
const writeState = () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
writeState();

async function pass(label) {
  // `env`, not `home`. getStateFile() and getHistoryFile() both read
  // `env.HOME`/`env.USERPROFILE` out of the options they are handed, and a
  // `home` key is read by nothing — so a pass built on it wrote both files into
  // the real `~/.deskuptime` of whoever ran the bench, while the surfaces below
  // read the empty temp HOME. Measured 2026-09-28: `home` left the throwaway
  // HOME empty and filled the real one; `env` does the opposite. The same
  // mistake made the report print `— (last check missing from the history
  // file)` about a site the pass had just recorded three times.
  const result = await runPass(state, { env, now: new Date(), check: checkUrl, returnResults: true });
  writeState();
  console.log(`\n===== pass: ${label} =====`);
  for (const event of result.events) console.log(`  event  ${event.type}: ${event.message}`);
  if (result.events.length === 0) console.log('  (no events)');
  console.log(`  [state] ${JSON.stringify(state.urls[url])}`);
  for (const event of result.events) {
    if (event.type === 'baseline') continue;
    const sent = await sendWebhook(webhook, event);
    console.log(`  posted ${event.type}: ${sent}`);
  }
}

function surfaces(label) {
  console.log(`\n########## surfaces after: ${label} ##########`);
  for (const [name, args] of [
    ['status', ['status']],
    ['watch --status', ['watch', '--status']],
    ['report', ['report']],
  ]) {
    const r = run(home, args);
    console.log(`----- ${name} (exit ${r.code}) -----`);
    // The report's closing paragraph is fixed prose; it is not what is measured.
    console.log(r.out.split('\n').filter(l => !l.startsWith('Uptime is the share')).join('\n').trim());
  }
}

await pass('baseline — the first ever pass');
surfaces('the baseline pass');

await pass('a second, identical pass');
surfaces('an unchanged, healthy site');

title = 'Acme — shop';
await pass('the page changed (the title grew by the width of a price)');
surfaces('the changed page');

console.log('\n########## the paid channel ##########');
for (const event of delivered) console.log(JSON.stringify(event));

site.close();
hook.close();
