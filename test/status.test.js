import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkUrls } from '../src/engine.js';
import { checkReachability } from '../src/checkers/ping.js';
import { getStateFile, loadState, runPass, saveState, isPro } from '../src/watch.js';

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

test('check: a route that answers 404 to HEAD but 200 to GET is UP', async (t) => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    if (req.method === 'HEAD') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${port}/stats`;

  const reachability = await checkReachability(url, { timeoutMs: 2000 });
  assert.equal(reachability.healthy, true);
  assert.equal(reachability.statusCode, 200);
  // checkUrl adds its own content GET, so the fallback is the second request.
  assert.deepEqual(methods, ['HEAD', 'GET']);

  methods.length = 0;
  const result = await checkUrl(url, { timeoutMs: 2000 });
  assert.equal(result.reachable, true);
  assert.equal(result.healthy, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.error, undefined);
  assert.equal(methods[0], 'HEAD');
  assert.ok(methods.includes('GET'));

  methods.length = 0;
  const { stdout } = await run(process.execPath, [CLI, 'check', url, '--json', '--timeout', REQUEST_TIMEOUT]);
  assert.equal(JSON.parse(stdout)[0].statusCode, 200);
  assert.ok(methods.includes('GET'));
});

test('check: HEAD 405 and HEAD 501 also fall back to GET', async (t) => {
  for (const headStatus of [405, 501]) {
    const methods = [];
    const server = createServer((req, res) => {
      methods.push(req.method);
      if (req.method === 'HEAD') {
        res.writeHead(headStatus);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const port = await listen(server);

    const result = await checkReachability(`http://127.0.0.1:${port}/x`, { timeoutMs: 2000 });
    assert.equal(result.healthy, true, `HEAD ${headStatus} should fall back to GET`);
    assert.deepEqual(methods, ['HEAD', 'GET']);

    await close(server);
  }
});

test('check: a route that is 404 for both HEAD and GET is still DOWN', async (t) => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.writeHead(404);
    res.end('not found');
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await checkReachability(`http://127.0.0.1:${port}/missing`, { timeoutMs: 2000 });
  assert.equal(result.reachable, true);
  assert.equal(result.healthy, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'HTTP 404');
  assert.deepEqual(methods, ['HEAD', 'GET']);
});

test('check: a healthy HEAD response is not retried with GET', async (t) => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.writeHead(200);
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const result = await checkReachability(`http://127.0.0.1:${port}/`, { timeoutMs: 2000 });
  assert.equal(result.healthy, true);
  assert.deepEqual(methods, ['HEAD']);
});

test('check: the GET fallback shares the --timeout budget with the HEAD request', async (t) => {
  let methods = 0;
  const sockets = new Set();
  const server = createServer((req, res) => {
    methods++;
    if (req.method === 'HEAD') {
      res.writeHead(404);
      res.end();
      return;
    }
    // Never answer the GET, so only the shared budget can end the check.
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

  const start = Date.now();
  const result = await checkReachability(`http://127.0.0.1:${port}/hang-after-head`, { timeoutMs: 500 });
  const elapsed = Date.now() - start;

  assert.equal(result.reachable, false);
  assert.equal(result.errorType, 'timeout');
  assert.equal(methods, 2);
  assert.ok(elapsed < 1500, `expected one shared 500ms budget, took ${elapsed}ms`);
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

function actionEnv(extra, temp) {
  return {
    ...process.env,
    DU_SSL_DAYS: '0',
    DU_SUMMARY: 'false',
    DU_TIMEOUT: REQUEST_TIMEOUT,
    GITHUB_OUTPUT: join(temp, 'github-output'),
    GITHUB_STEP_SUMMARY: join(temp, 'github-summary'),
    ...extra,
  };
}

// A stub CLI lets the action be tested against payloads the real CLI does not
// emit today — the cases where counting silently reported down=0 and passed.
function stubAction(t, payload) {
  const root = mkdtempSync(join(tmpdir(), 'deskuptime-stub-'));
  const temp = mkdtempSync(join(tmpdir(), 'deskuptime-stub-run-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.js'), `console.log(${JSON.stringify(payload)});\n`);
  return { root, temp };
}

test('action: a payload that cannot be counted fails the step', async (t) => {
  const cases = [
    { name: 'empty result array', urls: 2, payload: '[]', expected: /returned no results/ },
    { name: 'no boolean healthy field', urls: 1, payload: JSON.stringify([{ url: 'https://a.test/' }]), expected: /no boolean healthy field/ },
    { name: 'result without a url', urls: 1, payload: JSON.stringify([{ healthy: true }]), expected: /without a url field/ },
    { name: 'healthy as a string', urls: 1, payload: JSON.stringify([{ url: 'https://a.test/', healthy: 'yes' }]), expected: /no boolean healthy field/ },
    { name: 'not an array', urls: 2, payload: '{"ok":true}', expected: /expected a JSON array/ },
    { name: 'not JSON at all', urls: 2, payload: 'Error: something went wrong', expected: /did not return valid JSON/ },
  ];

  for (const { name, urls, payload, expected } of cases) {
    const { root, temp } = stubAction(t, payload);
    await assert.rejects(
      run('bash', ['-c', actionScript()], {
        cwd: temp,
        env: actionEnv({
          DU_URLS: Array.from({ length: urls }, (_, i) => `https://url${i}.test/`).join(' '),
          DU_FAIL_ON_DOWN: 'true',
          GITHUB_ACTION_PATH: root,
        }, temp),
      }),
      (error) => {
        assert.equal(error.code, 1, `${name}: expected exit 1`);
        assert.match(`${error.stdout}${error.stderr}`, expected, name);
        return true;
      },
      name,
    );
  }
});

test('action: fewer results than requested URLs fails the step', async (t) => {
  const { root, temp } = stubAction(t, JSON.stringify([{ url: 'https://a.test/', healthy: true }]));
  await assert.rejects(
    run('bash', ['-c', actionScript()], {
      cwd: temp,
      env: actionEnv({
        DU_URLS: 'https://a.test/ https://b.test/',
        DU_FAIL_ON_DOWN: 'false',
        GITHUB_ACTION_PATH: root,
      }, temp),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /returned 1 result\(s\) for 2 URL\(s\)/);
      return true;
    },
  );
});

test('action: fail-on-down=true exits 2 with the down count', async (t) => {
  const baseUrl = await statusServer(t);
  const urls = [`${baseUrl}/status/200`, `${baseUrl}/status/500`, `${baseUrl}/hang`];
  const temp = mkdtempSync(join(tmpdir(), 'deskuptime-action-fail-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  await assert.rejects(
    run('bash', ['-c', actionScript()], {
      cwd: temp,
      env: actionEnv({
        DU_URLS: urls.join(' '),
        DU_FAIL_ON_DOWN: 'true',
        GITHUB_ACTION_PATH: ROOT,
      }, temp),
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(`${error.stdout}${error.stderr}`, /::error::2 URL\(s\) are unhealthy/);
      assert.match(readFileSync(join(temp, 'github-output'), 'utf8'), /^down=2$/m);
      return true;
    },
  );
});

test('action: all healthy URLs exit 0 and report down=0', async (t) => {
  const baseUrl = await statusServer(t);
  const urls = [`${baseUrl}/status/200`, `${baseUrl}/status/204`, `${baseUrl}/redirect`];
  const temp = mkdtempSync(join(tmpdir(), 'deskuptime-action-ok-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: actionEnv({
      DU_URLS: urls.join(' '),
      DU_FAIL_ON_DOWN: 'true',
      GITHUB_ACTION_PATH: ROOT,
    }, temp),
  });
  assert.match(readFileSync(join(temp, 'github-output'), 'utf8'), /^down=0$/m);
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

test('watch --once rejects URLs beyond the free limit before any request', async (t) => {
  let requests = 0;
  const baseUrl = await statusServer(t, undefined, () => { requests++; });
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-once-limit-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const urls = [200, 201, 202, 203].map(status => `${baseUrl}/status/${status}`);

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', ...urls, '--once'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Free tier monitors 3 URLs/);
      assert.match(error.stderr, new RegExp(urls[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
  assert.equal(requests, 0);
});

test('watch --once rejects empty option values before any request', async (t) => {
  let requests = 0;
  const baseUrl = await statusServer(t, undefined, () => { requests++; });
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-once-options-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  for (const option of ['--activate', '--webhook']) {
    await assert.rejects(
      run(process.execPath, [CLI, 'watch', `${baseUrl}/status/200`, '--once', option, ''], { env }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, new RegExp(`${option} requires a value`));
        return true;
      },
    );
  }
  assert.equal(requests, 0);
});

test('watch rejects intervals that cannot be scheduled safely', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-interval-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', '--interval', '2147483648'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--interval must be between 1 and 2147483 seconds/);
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

test('watch --once refuses a concurrent pass without changing state', async (t) => {
  let requests = 0;
  const baseUrl = await statusServer(t, undefined, () => { requests++; });
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-locked-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const url = `${baseUrl}/status/200`;
  const options = { env: { HOME: home, USERPROFILE: home } };
  const stateFile = getStateFile(options);
  const lockFile = `${stateFile}.lock`;
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const state = { urls: { [url]: { wasUp: true, lastStatus: 200 } } };
  const lock = { pid: process.pid, createdAt: Date.now() };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(lockFile, JSON.stringify(lock));
  const stateBefore = readFileSync(stateFile, 'utf8');
  const lockBefore = readFileSync(lockFile, 'utf8');

  await assert.rejects(
    run(process.execPath, [CLI, 'watch', url, '--once'], {
      env: { ...process.env, ...options.env },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /another watch pass is already running/i);
      return true;
    },
  );
  assert.equal(requests, 0);
  assert.equal(readFileSync(stateFile, 'utf8'), stateBefore);
  assert.equal(readFileSync(lockFile, 'utf8'), lockBefore);
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

// ── P0-7: the stored license and the state file that holds it ──
const LICENSE_KEY = '0123456789abcdef0123456789abcdef';

test('state file is 0600 inside a 0700 directory and leaves no temp file', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-mode-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  const stateFile = getStateFile(options);

  saveState({ ...watchState('https://watch.test/'), license: { key: LICENSE_KEY, instance: 'deskuptime-maskine' } }, options);
  assert.equal(statSync(dirname(stateFile)).mode & 0o777, 0o700, 'the directory holds the key');
  assert.equal(statSync(stateFile).mode & 0o777, 0o600, 'the key must not be world-readable');

  // A pre-existing world-readable file is tightened on the next write.
  chmodSync(stateFile, 0o644);
  saveState({ urls: {} }, options);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(stateFile)), ['state.json'], 'atomic swap leaves no temp file');
});

test('loadState drops a corrupt license record instead of granting Pro', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-license-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  const stateFile = getStateFile(options);
  const write = (license) => {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ urls: {}, license }));
  };

  write({ key: 'not-a-key', instance: 'deskuptime-maskine' });
  assert.equal(isPro(loadState(options)), false, 'a malformed key is not Pro');

  write({ key: LICENSE_KEY });
  assert.equal(isPro(loadState(options)), false, 'a license without a device id is not Pro');

  write('just a string');
  assert.equal(loadState(options).license, undefined);

  write({ key: LICENSE_KEY.toUpperCase(), instance: ' deskuptime-maskine ', status: 'active', validatedAt: '2026-09-24T12:00:00Z' });
  const loaded = loadState(options);
  assert.equal(isPro(loaded), true);
  assert.equal(loaded.license.key, LICENSE_KEY, 'the key is normalised on load');
  assert.equal(loaded.license.instance, 'deskuptime-maskine');
});

test('a license the server rejected loses Pro, a cached one keeps it', () => {
  const base = { key: LICENSE_KEY, instance: 'deskuptime-maskine' };
  assert.equal(isPro({ license: { ...base, status: 'invalid' } }), false);
  assert.equal(isPro({ license: { ...base, status: 'cached' } }), true);
  assert.equal(isPro({ license: { ...base, status: 'active' } }), true);
  // An unverified key is not Pro either, even though it was never rejected.
  assert.equal(isPro({ license: { ...base, status: 'unverified' } }), false);
  // Legacy state without a status keeps working until the next re-check.
  assert.equal(isPro({ license: base }), true);
});

test('cli: status names the license state and never prints the key', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-status-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateFile = getStateFile({ env: { HOME: home } });
  mkdirSync(dirname(stateFile), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const withLicense = async (license) => {
    writeFileSync(stateFile, JSON.stringify({ urls: {}, license }));
    const { stdout } = await run(process.execPath, [CLI, 'status'], { env });
    return stdout;
  };
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();

  assert.match(await withLicense(null), /Free tier\. Activate Pro/);
  assert.match(await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'active', validatedAt: yesterday }), /Pro license: active, last verified/);
  assert.match(await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'cached', validatedAt: yesterday }), /Pro license: cached\/offline/);
  const invalid = await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'invalid', validatedAt: yesterday });
  assert.match(invalid, /Pro license: invalid/);
  assert.match(invalid, /still stored/);
  assert.doesNotMatch(invalid, new RegExp(LICENSE_KEY));
  assert.doesNotMatch(invalid, /deskuptime-maskine/);

  // A key the server never got to judge is not a dead key: no checkout link,
  // because this customer already paid and a buy link is how a second license
  // gets bought.
  const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000).toISOString();
  const unverified = await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'unverified', validatedAt: nineDaysAgo });
  assert.match(unverified, /Pro license: unverified/);
  assert.match(unverified, /never rejected/);
  assert.match(unverified, /deskuptime activate <license-key>/);
  assert.doesNotMatch(unverified, /buy\.stripe\.com/, 'an existing customer must not see a checkout link');
  assert.doesNotMatch(unverified, new RegExp(LICENSE_KEY));
  assert.doesNotMatch(unverified, /deskuptime-maskine/);
});
