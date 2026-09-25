import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, chmodSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The curl install path is a shell script nobody runs in CI, so it drifted:
// it pinned VERSION="0.1.4" while package.json was 0.2.8, and it unpacked the
// download without ever checking a checksum. These tests run the real
// tools/install.sh against a local HTTP server, so version resolution, checksum
// verification and the install layout are all deterministic and offline.

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INSTALLER = join(ROOT, 'tools', 'install.sh');
const INSTALLER_SRC = readFileSync(INSTALLER, 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const skip = process.platform === 'win32' ? 'kræver sh, curl og tar' : false;

const WORK = mkdtempSync(join(tmpdir(), 'deskuptime-install-'));
const SERVERS = [];
after(() => {
  for (const server of SERVERS) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(WORK, { recursive: true, force: true });
});

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// A minimal but real payload: install.sh extracts src/, package.json, README.md
// and LICENSE, and then runs the installed cli.js --version.
function makeTarball(version) {
  const stage = join(WORK, `stage-${version}`);
  mkdirSync(join(stage, 'src'), { recursive: true });
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: '@mahope/deskuptime', version }));
  writeFileSync(join(stage, 'README.md'), '# DeskUptime\n');
  writeFileSync(join(stage, 'LICENSE'), 'MIT\n');
  writeFileSync(
    join(stage, 'src', 'cli.js'),
    '#!/usr/bin/env node\nconst v = require("../package.json").version;\nconsole.log(`deskuptime v${v}`);\n'
  );
  const out = join(WORK, `deskuptime-${version}.tar.gz`);
  return run('tar', ['-czf', out, 'package.json', 'README.md', 'LICENSE', 'src'], { cwd: stage })
    .then(() => readFileSync(out));
}

function release(tag, version, { asset = true, draft = false, prerelease = false } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease,
    assets: asset ? [{ name: `deskuptime-${version}.tar.gz` }] : []
  };
}

async function startServer(feed, tarballs) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/releases') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(feed));
      return;
    }
    const file = tarballs[path];
    if (file) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(file);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  SERVERS.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function runInstaller(home, env) {
  return run('sh', [INSTALLER], {
    cwd: ROOT,
    env: {
      ...process.env,
      // The installer checks "node" on PATH, so hand it the very binary running
      // the tests instead of whatever the developer's shell happens to prefer.
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: home,
      USERPROFILE: home,
      DESKUPTIME_API_URL: 'http://127.0.0.1:1/releases',
      ...env
    }
  });
}

function freshHome(name) {
  const home = join(WORK, `home-${name}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function libDir(home) {
  return join(home, '.local', 'lib', 'deskuptime');
}

test('install.sh løser nyeste v*-cli-release med tarball-asset og verificerer checksum', { skip }, async () => {
  const version = '0.2.10';
  const tarball = await makeTarball(version);
  const base = await startServer(
    // Out of order on purpose: highest semver must win, and a -cli release
    // without the tarball asset must be skipped.
    [
      release('v0.2.10-cli', '0.2.10'),
      release('v0.3.0-cli', '0.3.0', { asset: false }),
      release('v0.2.9-cli', '0.2.9'),
      release('v0.4.0-desktop', '0.4.0'),
      release('v0.5.0-alpha', '0.5.0'),
      release('v0.6.0-cli', '0.6.0', { draft: true }),
      release('v1', '1.0.0')
    ],
    {
      [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
      [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
        Buffer.from(`${sha256(tarball)}  deskuptime-${version}.tar.gz\n`)
    }
  );

  const home = freshHome('resolve');
  const { stdout } = await runInstaller(home, {
    DESKUPTIME_API_URL: `${base}/releases`,
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  });

  assert.match(stdout, /Resolved newest published CLI release: v0\.2\.10-cli\./, stdout);
  assert.match(stdout, /Checksum verified \(sha256 [0-9a-f]{64}\)\./, stdout);
  assert.match(stdout, new RegExp(`Installed deskuptime ${version.replace(/\./g, '\\.')}`), stdout);
  assert.equal(
    readFileSync(join(libDir(home), 'package.json'), 'utf8').includes(version), true,
    'installeret package.json har ikke den løste version'
  );
  assert.ok(existsSync(join(libDir(home), 'src', 'cli.js')), 'src/cli.js mangler efter install');
  assert.ok(existsSync(join(home, '.local', 'bin', 'deskuptime')), 'bin/deskuptime mangler efter install');
  assert.ok(readFileSync(join(libDir(home), 'src', 'cli.js'), 'utf8').includes('../package.json'));
});

test('install.sh afviser en manipuleret checksum og installerer intet', { skip }, async () => {
  const version = '0.2.11';
  const tarball = await makeTarball(version);
  const base = await startServer(
    [release(`v${version}-cli`, version)],
    {
      [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
      [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
        Buffer.from(`${'0'.repeat(64)}  deskuptime-${version}.tar.gz\n`)
    }
  );

  const home = freshHome('badsum');
  const result = await runInstaller(home, {
    DESKUPTIME_API_URL: `${base}/releases`,
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  }).then(() => null, err => err);

  assert.ok(result, 'afvigende checksum gav exit 0');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /checksum mismatch for deskuptime-0\.2\.11\.tar\.gz/);
  assert.match(result.stderr, /Nothing was installed\./);
  assert.equal(existsSync(join(home, '.local')), false, 'der må ikke ske noget på disk før verifikation');
});

test('install.sh advarser om manglende sidecar, men installerer (strengt valg fejler)', { skip }, async () => {
  const version = '0.2.12';
  const tarball = await makeTarball(version);
  const base = await startServer([release(`v${version}-cli`, version)], {
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball
  });
  const env = {
    DESKUPTIME_API_URL: `${base}/releases`,
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  };

  const lenient = freshHome('nosha');
  const { stdout } = await runInstaller(lenient, env);
  assert.match(stdout, /has no published \.sha256 — this download is unverified\./, stdout);
  assert.ok(existsSync(join(libDir(lenient), 'src', 'cli.js')), 'uverificeret download bør installere som standard');

  const strict = freshHome('nosha-strict');
  const failed = await runInstaller(strict, { ...env, DESKUPTIME_REQUIRE_CHECKSUM: '1' })
    .then(() => null, err => err);
  assert.ok(failed, 'DESKUPTIME_REQUIRE_CHECKSUM=1 fejlede ikke');
  assert.match(failed.stderr, /no published \.sha256/);
  assert.equal(existsSync(join(strict, '.local')), false, 'streng modus må ikke installere');
});

test('install.sh bruger DESKUPTIME_VERSION uden at læse releasefeedet', { skip }, async () => {
  const version = '0.2.13';
  const tarball = await makeTarball(version);
  const base = await startServer([], {
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
      Buffer.from(`${sha256(tarball)}  deskuptime-${version}.tar.gz\n`)
  });

  const home = freshHome('pinned');
  const { stdout } = await runInstaller(home, {
    DESKUPTIME_VERSION: version,
    DESKUPTIME_API_URL: 'http://127.0.0.1:1/releases',
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  });
  assert.match(stdout, /Installing pinned deskuptime 0\.2\.13/, stdout);
  assert.ok(existsSync(join(libDir(home), 'src', 'cli.js')));
});

test('install.sh falder tilbage til den indbyggede version, når feedet er ulæseligt', { skip }, async () => {
  const version = PKG.version;
  const tarball = await makeTarball(version);
  const base = await startServer([], {
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
      Buffer.from(`${sha256(tarball)}  deskuptime-${version}.tar.gz\n`)
  });

  const home = freshHome('fallback');
  const { stdout } = await runInstaller(home, { DESKUPTIME_RELEASE_BASE: `${base}/download` });
  assert.match(stdout, /could not read the release feed — falling back to/, stdout);
  assert.ok(existsSync(join(libDir(home), 'src', 'cli.js')), 'fallback-versionen blev ikke installeret');
});

test('install.sh erstatter en tidligere installation i stedet for at flette filer', { skip }, async () => {
  const version = '0.2.14';
  const tarball = await makeTarball(version);
  const base = await startServer([release(`v${version}-cli`, version)], {
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
      Buffer.from(`${sha256(tarball)}  deskuptime-${version}.tar.gz\n`)
  });

  const home = freshHome('replace');
  mkdirSync(join(libDir(home), 'src'), { recursive: true });
  writeFileSync(join(libDir(home), 'src', 'stale.js'), '// from an older version\n');

  await runInstaller(home, {
    DESKUPTIME_API_URL: `${base}/releases`,
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  });
  const installed = readdirSync(join(libDir(home), 'src'));
  assert.equal(installed.includes('stale.js'), false, `stale filer overlevede: ${installed.join(', ')}`);
  assert.equal(installed.includes('cli.js'), true);
});

test('install.sh nægter en tarball uden src/cli.js', { skip }, async () => {
  const version = '0.2.15';
  const stage = join(WORK, `stage-${version}`);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(stage, 'README.md'), '#\n');
  writeFileSync(join(stage, 'LICENSE'), 'MIT\n');
  const out = join(WORK, 'broken.tar.gz');
  await run('tar', ['-czf', out, 'package.json', 'README.md', 'LICENSE'], { cwd: stage });
  const tarball = readFileSync(out);
  const base = await startServer([release(`v${version}-cli`, version)], {
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz`]: tarball,
    [`/download/v${version}-cli/deskuptime-${version}.tar.gz.sha256`]:
      Buffer.from(`${sha256(tarball)}  deskuptime-${version}.tar.gz\n`)
  });

  const home = freshHome('nocli');
  const failed = await runInstaller(home, {
    DESKUPTIME_API_URL: `${base}/releases`,
    DESKUPTIME_RELEASE_BASE: `${base}/download`
  }).then(() => null, err => err);
  assert.ok(failed, 'tarball uden src/cli.js blev installeret');
  assert.match(failed.stderr, /contains no src\/cli\.js/);
  assert.equal(existsSync(join(home, '.local', 'bin', 'deskuptime')), false);
});

test('install.sh har én Node-kravfejl, og versionerne matcher package.json', { skip }, () => {
  const fallback = /FALLBACK_VERSION="([\d.]+)"/.exec(INSTALLER_SRC);
  const major = /REQUIRED_NODE_MAJOR=(\d+)/.exec(INSTALLER_SRC);
  assert.ok(fallback, 'FALLBACK_VERSION mangler i install.sh');
  assert.ok(major, 'REQUIRED_NODE_MAJOR mangler i install.sh');
  assert.equal(fallback[1], PKG.version, `FALLBACK_VERSION ${fallback[1]} != package.json ${PKG.version}`);
  assert.equal(
    major[1], /(\d+)/.exec(PKG.engines.node)[1],
    `REQUIRED_NODE_MAJOR ${major[1]} != engines ${PKG.engines.node}`
  );

  // Ét sted definerer kravet, og alle fejlstrenge går gennem samme funktion.
  assert.equal(
    (INSTALLER_SRC.match(/die "Node\.js \$\{REQUIRED_NODE_MAJOR\}\+/g) || []).length, 1,
    'Node-kravfejlen skal skrives ét sted'
  );
  assert.equal(/^REQUIRED_NODE_MAJOR=\d+$/m.test(INSTALLER_SRC), true);
});

test('install.sh giver én deterministisk fejl, når Node er for gammel', { skip }, async () => {
  const fakeBin = join(WORK, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  const fakeNode = join(fakeBin, 'node');
  writeFileSync(fakeNode, '#!/bin/sh\nexit 1\n');
  chmodSync(fakeNode, 0o755);

  const home = freshHome('oldnode');
  const failed = await runInstaller(home, { PATH: `${fakeBin}:${process.env.PATH}` })
    .then(() => null, err => err);
  assert.ok(failed, 'gammel Node gav exit 0');
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /^error: Node\.js 24\+ is required/m);
  assert.equal(existsSync(join(home, '.local')), false, 'intet må installeres på for gammel Node');
});
