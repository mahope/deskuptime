import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The curl/Homebrew install path ships exactly what tools/make_tarball.sh packs.
// A hand-maintained file list silently dropped src/status.js and
// src/checkers/headers.js, so every installed CLI died with ERR_MODULE_NOT_FOUND
// on the first command — and make_tarball.sh's own self-check failed. These tests
// run the real script against a local server and then run the extracted CLI.

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const skip = process.platform === 'win32' ? 'kræver sh, tar og gzip' : false;

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body>ok</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const SITE = `http://127.0.0.1:${server.address().port}/`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const WORK = mkdtempSync(join(tmpdir(), 'deskuptime-tarball-'));
const TARBALL_DIR = join(WORK, 'out');
const EXTRACTED = join(WORK, 'extracted');
const CLI = join(EXTRACTED, 'src', 'cli.js');
const TARBALL = join(TARBALL_DIR, `deskuptime-${VERSION}.tar.gz`);

if (!skip) {
  await run('bash', ['tools/make_tarball.sh'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DESKUPTIME_TARBALL_DIR: TARBALL_DIR,
      DESKUPTIME_SELFCHECK_URL: SITE
    }
  });
  run('mkdir', ['-p', EXTRACTED]);
  await run('tar', ['-xzf', TARBALL, '-C', EXTRACTED]);
}

function cli(args, env = {}) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: join(WORK, 'home'), USERPROFILE: join(WORK, 'home'), ...env }
  });
}

test('make_tarball.sh bygger en tarball uden fejl', { skip }, () => {
  assert.ok(existsSync(TARBALL), 'tarball mangler');
  assert.ok(existsSync(`${TARBALL}.sha256`), 'checksum-sidecar mangler');
});

test('tarball indeholder hele src/-træet plus package.json, README og LICENSE', { skip }, () => {
  const packed = listFiles(EXTRACTED).map(p => p.split(sep).join('/')).sort();
  const source = listFiles(join(ROOT, 'src')).sort();
  const missing = source.filter(f => !packed.includes(`src/${f}`));
  assert.deepEqual(missing, [], `filer mangler i tarball: ${missing.join(', ')}`);
  for (const rootFile of ['package.json', 'README.md', 'LICENSE']) {
    assert.ok(packed.includes(rootFile), `${rootFile} mangler i tarball`);
  }
  assert.ok(packed.includes('src/checkers/headers.js'), 'src/checkers/headers.js mangler i tarball');
  assert.ok(packed.includes('src/status.js'), 'src/status.js mangler i tarball');
});

test('checksum-sidecar matcher tarball', { skip }, () => {
  const actual = createHash('sha256').update(readFileSync(TARBALL)).digest('hex');
  const sidecar = readFileSync(`${TARBALL}.sha256`, 'utf8').trim();
  assert.equal(sidecar, `${actual}  deskuptime-${VERSION}.tar.gz`);
});

test('udpakket CLI kører --version med pakkens version', { skip }, async () => {
  const { stdout } = await cli(['--version']);
  assert.ok(stdout.includes(VERSION), `--version skrev "${stdout.trim()}"`);
});

test('udpakket CLI kører check mod en lokal server', { skip }, async () => {
  const { stdout } = await cli(['check', SITE, '--json', '--timeout', '2000']);
  const results = JSON.parse(stdout);
  assert.equal(results.length, 1);
  assert.equal(results[0].healthy, true, `check rapporterede ikke healthy: ${stdout}`);
});

test('udpakket CLI kører headers --json', { skip }, async () => {
  const { stdout } = await cli(['headers', SITE, '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.finalUrl, SITE);
  assert.equal(result.healthy, true);
});

test('udpakket CLI kører watch --once og derefter read-only watch --status', { skip }, async () => {
  const pass = await cli(['watch', SITE, '--once']);
  assert.match(pass.stdout, /baseline|OK|healthy|UP/i, `watch --once skrev: ${pass.stdout}`);

  const status = await cli(['watch', '--status']);
  assert.match(status.stdout, new RegExp(SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('udpakket CLI viser hjælp med Pro-vejledning', { skip }, async () => {
  const { stdout } = await cli(['--help']);
  assert.match(stdout, /PRO FEATURES/);
  assert.match(stdout, /docs\/pro-alerts\.md/);
});

test('oprydning', { skip }, () => {
  rmSync(WORK, { recursive: true, force: true });
});
