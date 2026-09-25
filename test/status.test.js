import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkUrls } from '../src/engine.js';
import { getStateFile, loadState, runOnce, runPass } from '../src/watch.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REQUEST_TIMEOUT = '2000';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function statusServer(t, redirectTarget, onRequest = () => {}) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    onRequest(req);
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/hang') return;

    if (pathname === '/redirect') {
      res.writeHead(302, { location: '/status/200' });
      res.end();
      return;
    }

    if (pathname === '/redirect-error') {
      res.writeHead(302, { location: '/status/500' });
      res.end();
      return;
    }

    if (pathname === '/redirect-refused' && redirectTarget) {
      res.writeHead(302, { location: redirectTarget });
      res.end();
      return;
    }

    const match = pathname.match(/^\/status\/(\d{3})$/);
    if (match) {
      const status = Number(match[1]);
      if (status === 500) res.statusMessage = 'SERVER CONTROLLED STATUS TEXT';
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(status === 204 ? undefined : `<html><title>${status}</title><body>${status}</body></html>`);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await close(server);
  });
  return `http://127.0.0.1:${port}`;
}

function statusLines(stdout) {
  return new Map(
    stdout
      .split('\n')
      .filter(line => line.startsWith('✅ ') || line.startsWith('❌ '))
      .map(line => {
        const healthy = line.startsWith('✅ ');
        return [line.slice(2), healthy];
      })
  );
}

function actionScript() {
  const lines = readFileSync(join(ROOT, 'action.yml'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === 'run: |');
  assert.notEqual(start, -1);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith('        ')) break;
    body.push(line.slice(8));
  }
  return body.join('\n');
}

test('cli: status matrix agrees across JSON, human output and exit code', async (t) => {
  const baseUrl = await statusServer(t);
  const expectedReachability = [
    true, true, true, true, true, true, true, true, false, false,
  ];
  const expectedHealth = [
    true, true, false, false, false, false, true, false, false, false,
  ];
  const urls = [
    ...[200, 204, 400, 404, 410, 500].map(status => `${baseUrl}/status/${status}`),
    `${baseUrl}/redirect`,
    `${baseUrl}/redirect-error`,
    `${baseUrl}/hang`,
    `http://127.0.0.1:${await unusedPort()}`,
  ];

  await assert.rejects(
    run(process.execPath, [CLI, 'check', ...urls, '--json', '--timeout', REQUEST_TIMEOUT]),
    (error) => {
      assert.equal(error.code, 2);
      const results = JSON.parse(error.stdout);
      assert.equal(results.length, urls.length);
      assert.deepEqual(results.map(result => result.healthy), expectedHealth);
      assert.deepEqual(results.map(result => result.reachable), expectedReachability);
      assert.deepEqual(results.slice(0, 6).map(result => result.statusCode), [200, 204, 400, 404, 410, 500]);
      assert.equal(results[6].statusCode, 200);
      assert.equal(results[7].statusCode, 500);
      assert.deepEqual(
        results.filter(result => result.errorType === 'http_error').map(result => result.statusCode),
        [400, 404, 410, 500, 500],
      );
      assert.deepEqual(results.slice(2, 6).map(result => result.contentHash), [null, null, null, null]);
      assert.equal(results[7].contentHash, null);
      assert.deepEqual(
        results.slice(8).map(result => result.errorType),
        ['timeout', 'connection_refused'],
      );
      assert.equal(results.some(result => 'statusText' in result), false);
      assert.doesNotMatch(error.stdout, /SERVER CONTROLLED STATUS TEXT/);
      return true;
    }
  );

  await assert.rejects(
    run(process.execPath, [CLI, 'check', ...urls, '--timeout', REQUEST_TIMEOUT]),
    (error) => {
      assert.equal(error.code, 2);
      const humanResults = statusLines(error.stdout);
      assert.deepEqual(
        urls.map(url => humanResults.get(url)),
        expectedHealth,
      );
      return true;
    }
  );
});

test('cli: one invalid URL rejects the whole check before any request', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('ok');
  });
  const port = await listen(server);
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => close(server));

  await assert.rejects(
    run(process.execPath, [CLI, 'check', `http://127.0.0.1:${port}`, 'not-a-url', '--json']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Invalid URL: not-a-url/);
      assert.equal(requests, 0);
      return true;
    }
  );

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', `http://127.0.0.1:${port}`, 'not-a-url'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
    (error) => error.code === 1 && /Invalid URL: not-a-url/.test(error.stderr)
  );
  assert.equal(requests, 0);
});

test('cli: unknown options fail instead of being ignored', async () => {
  await assert.rejects(
    run(process.execPath, [CLI, 'check', 'https://example.com', '--jsonn']),
    (error) => error.code === 1 && /Unknown option: --jsonn/.test(error.stderr)
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'check', 'https://example.com', '--timeout=50']),
    (error) => error.code === 1 && /Unknown option: --timeout=50/.test(error.stderr)
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'headers', 'https://example.com', 'stray']),
    (error) => error.code === 1 && /Unexpected argument: stray/.test(error.stderr)
  );
  await assert.rejects(
    run(process.execPath, [CLI, 'headers', 'https://example.com', '-x']),
    (error) => error.code === 1 && /Unknown option: -x/.test(error.stderr)
  );
});

test('engine: checkUrls validates the complete batch before any request', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));

  await assert.rejects(
    checkUrl('not-a-url'),
    /Invalid URL: not-a-url/
  );
  await assert.rejects(
    checkUrls([`http://127.0.0.1:${port}`, 'not-a-url']),
    /Invalid URL: not-a-url/
  );
  assert.equal(requests, 0);
});

test('action: down-count uses the CLI health decision', async (t) => {
  const baseUrl = await statusServer(t);
  const urls = [
    `${baseUrl}/status/200`,
    `${baseUrl}/status/204`,
    `${baseUrl}/status/400`,
    `${baseUrl}/status/404`,
    `${baseUrl}/status/410`,
    `${baseUrl}/status/500`,
    `${baseUrl}/redirect`,
    `${baseUrl}/redirect-error?glob=*`,
    `${baseUrl}/hang`,
    `http://127.0.0.1:${await unusedPort()}`,
  ];
  const temp = mkdtempSync(join(tmpdir(), 'deskuptime-action-'));
  const outputFile = join(temp, 'github-output');
  const summaryFile = join(temp, 'github-summary');
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: {
      ...process.env,
      DU_URLS: urls.join(' '),
      DU_FAIL_ON_DOWN: 'false',
      DU_SSL_DAYS: '0',
      DU_SUMMARY: 'false',
      DU_TIMEOUT: REQUEST_TIMEOUT,
      GITHUB_ACTION_PATH: ROOT,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
  });

  const output = readFileSync(outputFile, 'utf8');
  assert.match(output, /^down=7$/m);
  assert.match(output, /json<<EOF_JSON/);
  assert.match(output, /glob=\*/);
});

test('headers: connection refusal returns a structured error without crashing', async (t) => {
  const url = `http://127.0.0.1:${await unusedPort()}`;
  const redirectTarget = `https://127.0.0.1:${await unusedPort()}`;
  const redirectUrl = `${await statusServer(t, redirectTarget)}/redirect-refused`;

  await assert.rejects(
    run(process.execPath, [CLI, 'headers', url, '--json']),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout);
      assert.equal(result.reachable, false);
      assert.equal(result.healthy, false);
      assert.equal(result.statusCode, null);
      assert.equal(result.errorType, 'connection_refused');
      assert.deepEqual(result.steps, []);
      assert.equal(Object.keys(result.security).length, 5);
      return true;
    }
  );

  await assert.rejects(
    run(process.execPath, [CLI, 'headers', redirectUrl, '--json', '--timeout', REQUEST_TIMEOUT]),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout);
      assert.equal(result.reachable, false);
      assert.equal(result.healthy, false);
      assert.equal(result.redirected, true);
      assert.equal(result.startedHttp, true);
      assert.equal(result.errorType, 'connection_refused');
      assert.equal(result.steps.length, 1);
      return true;
    }
  );

  await assert.rejects(
    run(process.execPath, [CLI, 'headers', url]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /Error: Connection refused/);
      assert.doesNotMatch(error.stderr, /TypeError/);
      return true;
    }
  );
});

function watchResult(overrides = {}) {
  return {
    url: 'http://watch.test/',
    timestamp: new Date().toISOString(),
    reachable: true,
    healthy: true,
    statusCode: 200,
    responseTimeMs: 1,
    ssl: null,
    content: { fetched: true, contentLength: 10, hash: 'stable', changed: null },
    errorType: null,
    error: null,
    ...overrides,
  };
}

function watchState(url) {
  return {
    urls: {
      [url]: {
        addedAt: '2026-09-25T00:00:00.000Z',
        wasUp: null,
        lastHash: null,
        lastContentLength: null,
        sslWarned: false,
      },
    },
  };
}

test('watch --once completes one pass and reports a healthy baseline', async (t) => {
  let requests = 0;
  const baseUrl = await statusServer(t, undefined, () => { requests++; });
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-once-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const url = `${baseUrl}/status/200`;
  const stateFile = getStateFile({ env: { HOME: home } });
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  const { stdout } = await run(process.execPath, [CLI, 'watch', url, '--once'], { env });
  assert.match(stdout, /baseline recorded: UP/);
  assert.doesNotMatch(stdout, /Monitoring \d+ URL/);
  assert.equal(requests, 2);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.urls[url].wasUp, true);
  assert.equal(state.urls[url].lastStatus, 200);
});

test('watch --once without a URL or saved state exits 1', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-once-empty-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', '--once'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /at least one URL required/);
      return true;
    },
  );
});

test('watch --once exits 2 for DOWN and never claims all sites are OK', async (t) => {
  const baseUrl = await statusServer(t);
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-once-down-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const url = `${baseUrl}/status/500`;
  const stateFile = getStateFile({ env: { HOME: home } });
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', url, '--once'], { env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /baseline recorded: DOWN/);
      assert.doesNotMatch(error.stdout, /all monitored sites OK/);
      return true;
    }
  );
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.urls[url].wasUp, false);
  assert.equal(state.urls[url].lastStatus, 500);

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', url, '--once'], { env }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /is DOWN/);
      assert.doesNotMatch(error.stdout, /all monitored sites OK/);
      return true;
    }
  );
});

test('watch --status is read-only and does not contact monitored URLs', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('unexpected');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-status-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${port}/status/200`;
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const state = {
    urls: {
      [url]: { wasUp: true, lastStatus: 200, lastChecked: '2026-09-25T00:00:00.000Z' },
    },
  };
  writeFileSync(stateFile, JSON.stringify(state));
  const before = readFileSync(stateFile, 'utf8');

  const { stdout } = await run(process.execPath, [CLI, 'watch', '--status'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.match(stdout, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(stdout, /200/);
  assert.equal(requests, 0);
  assert.equal(readFileSync(stateFile, 'utf8'), before);
});

test('watch --status with no state does not create a state file', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-status-empty-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });

  const { stdout } = await run(process.execPath, [CLI, 'watch', '--status'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.match(stdout, /No URLs monitored/);
  assert.equal(existsSync(stateFile), false);
});

test('watch state path uses HOME and Windows USERPROFILE', () => {
  const posixHome = '/tmp/deskuptime-home';
  assert.equal(getStateFile({ env: { HOME: posixHome }, platform: 'linux' }), join(posixHome, '.deskuptime', 'state.json'));
  const windowsHome = 'C:\\Users\\deskuptime';
  assert.equal(
    getStateFile({ env: { USERPROFILE: windowsHome, HOME: '/fallback' }, platform: 'win32' }),
    win32.join(windowsHome, '.deskuptime', 'state.json'),
  );
  assert.equal(
    getStateFile({ env: { USERPROFILE: windowsHome, HOME: '/fallback' }, platform: 'linux' }),
    join('/fallback', '.deskuptime', 'state.json'),
  );
});

test('watch status transitions use healthy and preserve DOWN across saved passes', async (t) => {
  const url = 'http://watch.test/status';
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-transitions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  let state = watchState(url);
  const responses = [
    watchResult(),
    watchResult({ reachable: false, healthy: false, statusCode: 500, content: null, error: 'HTTP 500' }),
    watchResult(),
    watchResult({ reachable: false, healthy: false, statusCode: 500, content: null, error: 'HTTP 500' }),
  ];
  const passes = [];

  for (const response of responses) {
    passes.push(await runPass(state, { ...options, check: async () => response, returnResults: true }));
    state = loadState(options);
  }

  assert.deepEqual(passes.map(pass => pass.healthy), [true, false, true, false]);
  assert.deepEqual(passes.map(pass => pass.events.map(event => event.type)), [
    ['baseline'],
    ['down'],
    ['up'],
    ['down'],
  ]);
});

test('watch pass does not mix a concurrent state snapshot into its results', async (t) => {
  const url = 'http://watch.test/concurrent';
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-concurrent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  const stateFile = getStateFile(options);
  const initialEntry = {
    ...watchState(url).urls[url],
    wasUp: true,
    lastStatus: 200,
    lastHash: 'stable',
    lastChecked: '2026-09-25T00:00:00.000Z',
  };
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ urls: { [url]: initialEntry } }));

  const pass = await runOnce([url], {
    ...options,
    check: async () => {
      writeFileSync(stateFile, JSON.stringify({
        urls: {
          [url]: {
            ...initialEntry,
            wasUp: false,
            lastStatus: 503,
            lastChecked: '2099-01-01T00:00:00.000Z',
          },
        },
      }));
      return watchResult({
        url,
        content: { fetched: true, contentLength: 10, hash: 'stable', changed: false },
      });
    },
  });

  const saved = JSON.parse(readFileSync(stateFile, 'utf8')).urls[url];
  assert.deepEqual(pass.events, []);
  assert.equal(pass.healthy, true);
  assert.equal(saved.wasUp, true);
  assert.equal(saved.lastStatus, 200);
});

test('watch content transitions are latched to the saved hash', async (t) => {
  const url = 'http://watch.test/content';
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-content-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  let state = watchState(url);
  const values = [
    { hash: 'hash-a', length: 10 },
    { hash: 'hash-b', length: 20 },
    { hash: 'hash-b', length: 20 },
    { hash: 'hash-a', length: 10 },
  ];
  const passes = [];

  for (const value of values) {
    passes.push(await runPass(state, {
      ...options,
      check: async (_url, { contentHash }) => watchResult({
        content: {
          fetched: true,
          contentLength: value.length,
          hash: value.hash,
          changed: contentHash ? contentHash !== value.hash : null,
          previousHash: contentHash,
        },
      }),
      returnResults: true,
    }));
    state = loadState(options);
  }

  assert.deepEqual(passes.map(pass => pass.events.map(event => event.type)), [
    ['baseline'],
    ['content_changed'],
    [],
    ['content_changed'],
  ]);
  assert.match(passes[1].events[0].message, /10 → 20 bytes/);
});

test('watch SSL warnings latch through unavailable checks until recovery', async (t) => {
  const url = 'https://watch.test/ssl';
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-ssl-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  let state = watchState(url);
  const values = [14, null, 14, 15, 14];
  const passes = [];

  for (const validDays of values) {
    passes.push(await runPass(state, {
      ...options,
      check: async () => watchResult({ ssl: validDays == null ? null : { validDays } }),
      returnResults: true,
    }));
    state = loadState(options);
  }

  const warnings = passes.flatMap(pass => pass.events.filter(event => event.type === 'ssl_warning'));
  assert.equal(warnings.length, 2);
  assert.equal(state.urls[url].sslWarned, true);
});
