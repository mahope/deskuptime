import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkUrls } from '../src/engine.js';
import { checkReachability } from '../src/checkers/ping.js';
import { getStateFile, loadState, runPass, saveState, isPro } from '../src/watch.js';
import { readChain, readDisclosure, readEntry, readHttpsState, readRedirectTarget, readSecurityHeaders, SECURITY_HEADER, urlScheme } from '../src/status.js';
import { buildReport, renderReportMarkdown } from '../src/report.js';

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
  // The summary table reaches the real cell escaper and the real certificate
  // reading, so the stub has to carry the real ones — a hand-written copy would
  // let the stub pass on rules the action does not apply.
  copyFileSync(join(ROOT, 'src', 'display.js'), join(root, 'src', 'display.js'));
  copyFileSync(join(ROOT, 'src', 'status.js'), join(root, 'src', 'status.js'));
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

/**
 * The step summary is the fifth surface, and it was the only one that still
 * decided on its own whether a number was a number. Measured on one payload
 * the CLI cannot produce (a hand-edited result, a restored file, another tool
 * writing the JSON), before the fix:
 *
 *   | URL             | Status | HTTP | Response | SSL days |
 *   | https://negativ.dk/ | ✅ UP | 200 | -5ms     | -2       |
 *   | https://streng.dk/   | ✅ UP | 200 | —ms      | 9        |
 *
 * `-2` is exactly what P1-7 found and removed from the two terminal lists, and
 * `-5ms` is what P1-11 removed from the client report — in the one table a
 * customer reads in their own CI run, and can paste into a status page. The
 * summary had been swept for hostile *text* (markdownCell) but never for
 * unusable *numbers*.
 */
async function summaryFor(t, payload, extra = {}) {
  const { root, temp } = stubAction(t, JSON.stringify(payload));
  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: actionEnv({
      DU_URLS: payload.map(x => x.url).join(' '),
      DU_FAIL_ON_DOWN: 'false',
      DU_SSL_DAYS: '0',
      DU_SUMMARY: 'true',
      GITHUB_ACTION_PATH: root,
      ...extra,
    }, temp),
  });
  return readFileSync(join(temp, 'github-summary'), 'utf8');
}

test('action: the step summary reads the day count and the duration through the one owner', async (t) => {
  const summary = await summaryFor(t, [
    { url: 'https://negativ.dk/', healthy: true, statusCode: 200, responseTimeMs: -5, sslDaysRemaining: -2, sslExpiringSoon: false },
    { url: 'https://streng.dk/', healthy: true, statusCode: 200, responseTimeMs: null, sslDaysRemaining: '9', sslExpiringSoon: false },
    { url: 'https://sandt.dk/', healthy: true, statusCode: 200, responseTimeMs: 0, sslDaysRemaining: 40, sslExpiringSoon: false },
  ]);

  // Unknown is unknown — the same `—` the terminal lists and the report print.
  assert.match(summary, /\| https:\/\/negativ\.dk\/ \| ✅ UP \| 200 \| — \| — \|/);
  assert.match(summary, /\| https:\/\/streng\.dk\/ \| ✅ UP \| 200 \| — \| — \|/);
  assert.doesNotMatch(summary, /-5ms|—ms|\| -2 \||\| 9 \|/);

  // A real measurement still survives: 0 ms is a measurement, not an absence,
  // and a 40-day certificate is not a renewal.
  assert.match(summary, /\| https:\/\/sandt\.dk\/ \| ✅ UP \| 200 \| 0ms \| 40 \|/);
});

test('action: a lapsed certificate uses the same sentence as every other surface', async (t) => {
  const summary = await summaryFor(t, [
    { url: 'https://forfalden.dk/', healthy: true, statusCode: 200, responseTimeMs: 42, sslDaysRemaining: 0, sslExpired: true, sslExpiredDays: 12 },
    { url: 'https://uden-dato.dk/', healthy: true, statusCode: 200, responseTimeMs: 42, sslDaysRemaining: 0, sslExpired: true },
  ]);

  assert.match(summary, /🔴 expired 12d ago/);
  // Known to be lapsed, unknown when — the report, `check` and the status lists
  // all say exactly this, and none of them says a bare "expired".
  assert.match(summary, /🔴 expired — expiry date unknown/);
});

test('action: the summary and the SSL counter cannot disagree about an unusable value', async (t) => {
  // `sslDaysRemaining: "9"` is inside a 14-day window as a *string*. The old
  // counter happened to guard it with its own `typeof` check; now the same
  // reading decides the cell and the count, so neither can call it a day.
  const { root, temp } = stubAction(t, JSON.stringify([
    { url: 'https://streng.dk/', healthy: true, statusCode: 200, responseTimeMs: 5, sslDaysRemaining: '9', sslExpiringSoon: false },
  ]));
  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: actionEnv({
      DU_URLS: 'https://streng.dk/',
      DU_FAIL_ON_DOWN: 'false',
      DU_SSL_DAYS: '14',
      DU_SUMMARY: 'true',
      GITHUB_ACTION_PATH: root,
    }, temp),
  });
  assert.equal(readFileSync(join(temp, 'github-summary'), 'utf8').includes('| 9 |'), false);
});

test('action: the step summary has no certificate or duration rule of its own', () => {
  // A behavioural test cannot prove a surface stopped owning a fact — the
  // duplicates P1-13 and P1-14 measured returned identical answers in every
  // test. So the rule itself is pinned: the table must reach the owners.
  const source = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  assert.match(source, /require\(process\.env\.DU_ACTION_PATH \+ "\/src\/status\.js"\)/);
  assert.match(source, /require\(process\.env\.DU_ACTION_PATH \+ "\/src\/display\.js"\)/);
  assert.match(source, /readSslState\(\{ days: x\.sslDaysRemaining/);
  assert.match(source, /formatMs\(x\.responseTimeMs\)/);
  assert.doesNotMatch(source, /String\(x\.sslDaysRemaining\)/);
  assert.doesNotMatch(source, /x\.responseTimeMs \?\? /);
  assert.doesNotMatch(source, /typeof x\.sslDaysRemaining/);

  // `check --json`'s renewal flag is the third copy of the same window rule.
  // Comments are stripped first: the fix quotes the expression it replaced, so
  // a source scan would otherwise match the explanation of the bug.
  const cli = readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(cli, /isSslExpiringSoon\(r\.ssl/);
  // The owner is read once per result and the field is its answer verbatim
  // (P1-22 moved the call out of the field so `sslChecked` can use the same
  // reading; the test follows the shape, not the old inline call).
  assert.match(cli, /const ssl = readSslState\(\{/);
  assert.match(cli, /sslExpiringSoon: ssl\.expiringSoon/);
  assert.match(cli, /sslChecked: ssl\.measured/);
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

// ── headers: the redirect chain (P1-16) ──────────────────────────────────────
//
// Each test below builds a server whose redirect behaviour is under its own
// control, so each stop reason can be produced for real: a chain longer than the
// ceiling, a self-redirect, a 301 with no Location, and a site that answers with
// all five security headers — reached directly or through one hop, so the same
// site can be measured twice.

test('headers: a redirect chain that was abandoned is not a healthy site', async (t) => {
  const server = createServer((req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (pathname === '/kade') {
      res.writeHead(301, { location: `/kade?n=${Number(searchParams.get('n') || 0) + 1}` });
      res.end();
      return;
    }
    if (pathname === '/loop') {
      res.writeHead(301, { location: '/loop' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  for (const [name, path, reason, note] of [
    ['ceiling reached', '/kade', 'max_redirects', /gave up after 10 redirects — still redirecting \(301\)/],
    ['redirect loop', '/loop', 'loop', /redirect loop .* after 1 hop \(301\)/],
  ]) {
    const url = `${base}${path}`;

    // Measured before the fix: `headers` printed a clean sheet and exited 0
    // while `check` on the same URL said DOWN and exited 2.
    await assert.rejects(
      run(process.execPath, [CLI, 'headers', url, '--timeout', REQUEST_TIMEOUT]),
      (error) => {
        assert.equal(error.code, 2, `${name}: headers must not exit 0`);
        const out = error.stdout;
        assert.match(out, note, `${name}: the reason the walk stopped is not named`);
        assert.match(out, /Final: — \(redirect chain not followed\)/, `${name}: printed a final URL it never reached`);
        assert.match(out, /Security headers: not measured/, `${name}: presented a 301 as a security finding`);
        assert.doesNotMatch(out, /missing: content-security-policy/, `${name}: reported headers off a redirect`);
        assert.doesNotMatch(out, /HTTPS forced:/, `${name}: reported the site's scheme off a redirect`);
        return true;
      },
      name,
    );

    // The two surfaces must not disagree about the same site any more.
    await assert.rejects(
      run(process.execPath, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT]),
      (error) => {
        assert.equal(error.code, 2, `${name}: check must agree that the site is down`);
        assert.match(error.stdout, /redirect count exceeded/, name);
        return true;
      },
      name,
    );

    const json = await new Promise((resolve, reject) => {
      run(process.execPath, [CLI, 'headers', url, '--json', '--timeout', REQUEST_TIMEOUT])
        .then(() => reject(new Error(`${name}: headers --json exited 0 on an unfinished chain`)))
        .catch((error) => {
          assert.equal(error.code, 2, `${name}: headers --json must not exit 0`);
          resolve(JSON.parse(error.stdout));
        });
    });
    assert.equal(json.stopReason, reason, name);
    assert.equal(json.healthy, false, name);
    assert.equal(json.reachable, true, `${name}: a response did arrive`);
    assert.equal(json.error, null, `${name}: an unfinished reading is not a request error`);
  }
});

test('headers: a chain that reaches a real response reads it exactly as before', async (t) => {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/til-helt-sikker') {
      res.writeHead(301, { location: '/helt-sikker' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html',
      'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;

  // The control that the finding turned on: the same site, reached directly and
  // through one hop, must give the same security answer.
  const direct = await run(process.execPath, [CLI, 'headers', `${base}/helt-sikker`, '--timeout', REQUEST_TIMEOUT]);
  const viaHop = await run(process.execPath, [CLI, 'headers', `${base}/til-helt-sikker`, '--timeout', REQUEST_TIMEOUT]);

  for (const securityHeader of ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert.match(direct.stdout, new RegExp(`✅ ${securityHeader}:`), `${securityHeader} missing when reached directly`);
    assert.match(viaHop.stdout, new RegExp(`✅ ${securityHeader}:`), `${securityHeader} missing through one redirect`);
  }
  assert.match(viaHop.stdout, /— redirected/, 'a followed redirect still says so');
  assert.doesNotMatch(viaHop.stdout, /not measured/, 'a completed chain is measured');
  assert.doesNotMatch(viaHop.stdout, /⚠️  redirect/, 'a completed chain has nothing to warn about');

  const result = JSON.parse((await run(process.execPath, [CLI, 'headers', `${base}/til-helt-sikker`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(result.stopReason, null);
  assert.equal(result.healthy, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.steps.map(s => s.status), [301]);
});

test('headers: a 301 with no usable Location names the dead end without hiding the reading', async (t) => {
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://localhost').pathname === '/uden-location') {
      res.writeHead(301);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${port}`;
  const url = `${base}/uden-location`;

  // The response is still the site's own, so the security reading stands and the
  // verdict matches `check` (which sees the same 301 and calls it UP).
  const { stdout } = await run(process.execPath, [CLI, 'headers', url, '--timeout', REQUEST_TIMEOUT]);
  assert.match(stdout, /⚠️  stopped on a redirect with no usable Location \(301\)/);
  assert.match(stdout, /Final: http:\/\/127\.0\.0\.1:\d+\/uden-location \(301\)/);
  assert.match(stdout, /⬜ missing: content-security-policy/);
  assert.doesNotMatch(stdout, /not measured/);

  const result = JSON.parse((await run(process.execPath, [CLI, 'headers', url, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(result.stopReason, 'no_location');
  assert.equal(result.healthy, true);

  const checked = await run(process.execPath, [CLI, 'check', url, '--timeout', REQUEST_TIMEOUT]);
  assert.match(checked.stdout, /301 — UP/, 'check and headers must agree that a 301 is up');
});

test('headers: the chain rules have one owner, like the certificate rules', () => {
  // As in the P1-13/P1-14/P1-15 measurements, a behavioural test cannot prove a
  // surface stopped owning a fact: the duplicated rule returned identical
  // answers in every test. So the ownership itself is pinned.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const status = strip(readFileSync(join(ROOT, 'src', 'status.js'), 'utf8'));
  const cli = strip(readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8'));
  const checker = strip(readFileSync(join(ROOT, 'src', 'checkers', 'headers.js'), 'utf8'));

  for (const sentence of [
    'redirect chain not followed',
    'the chain never reached the final response',
    'still redirecting',
    'no usable Location',
  ]) {
    const owners = [status, cli, checker].filter(source => source.includes(sentence));
    assert.equal(owners.length, 1, `"${sentence}" must be written in exactly one place, found ${owners.length}`);
  }

  // The checker records the fact and applies the rule; it does not re-decide it.
  assert.match(checker, /readChain\(\{/);
  assert.match(checker, /const healthy = chain\.complete && isHealthyStatus\(r\.status\)/);
  assert.doesNotMatch(checker, /const healthy = isHealthyStatus\(r\.status\);/);

  // The terminal may read the stop reason exactly once — to hand it to the
  // owner. Measured: a second decision written as `r.stopReason !== null` in
  // cli.js survived an `=== ` scan, so the lock counts the reads instead.
  assert.equal(cli.split('r.stopReason').length - 1, 1, 'the terminal must not re-decide the chain');
  assert.doesNotMatch(cli, /stopReason\s*[!=]==?/);
  assert.doesNotMatch(cli, /chain\.\w+ =/);
});

// ── headers: the site that was never read (P1-23) ─────────────────────────────
//
// Measured with a real CLI against a closed port, before any code changed:
//
//   headers --json http://127.0.0.1:<closed>/    ->  security: { five × null }
//                                                    stopReason: null
//                                                    reachable: false
//
// Five nulls is what a live site missing all five headers also looks like, and
// the terminal never showed them (it stops at the error line) — so `--json`, the
// surface a bureau pipes into a client report, stated a security posture for a
// site that had not said a word. The same held after a redirect, where the chain
// died on hop two and `stopReason: null` made the reading look complete.

test('headers: the reading knows a site that never answered was never read', () => {
  // The finding turned on `stopReason` being the only thing that could end a
  // walk "unfinished", and a failed request stops for no redirect reason at all.
  assert.equal(readChain({ statusCode: null, stopReason: null }).measured, false);
  assert.equal(readChain({ statusCode: null, stopReason: null }).complete, false);
  assert.equal(readChain({}).measured, false, 'no arguments is no reading either');

  // Everything P1-16 decided is unchanged: a response that arrived still counts,
  // including the 301 that is a dead end rather than an unfinished walk.
  for (const state of [
    { statusCode: 200, stopReason: null },
    { statusCode: 301, stopReason: 'no_location' },
    { statusCode: 301, stopReason: 'max_redirects' },
    { statusCode: 301, stopReason: 'loop' },
  ]) {
    const expected = state.statusCode !== null && !['max_redirects', 'loop'].includes(state.stopReason);
    assert.equal(readChain(state).measured, expected, JSON.stringify(state));
  }
});

test('headers --json: a site that never answered cannot be read as a security finding', async (t) => {
  const closedPort = await unusedPort();
  const redirectTarget = `https://127.0.0.1:${closedPort}/gone`;
  const redirectUrl = `${await statusServer(t, redirectTarget)}/redirect-refused`;

  for (const [name, url] of [
    ['refused outright', `http://127.0.0.1:${closedPort}/`],
    ['refused after one hop', redirectUrl],
  ]) {
    const result = await new Promise((resolve, reject) => {
      run(process.execPath, [CLI, 'headers', url, '--json', '--timeout', REQUEST_TIMEOUT])
        .then(() => reject(new Error(`${name}: headers --json exited 0 on a site it never reached`)))
        .catch((error) => {
          assert.equal(error.code, 2, name);
          resolve(JSON.parse(error.stdout));
        });
    });
    assert.equal(result.reachable, false, `${name}: no response arrived`);
    assert.equal(result.securityChecked, false, `${name}: the JSON must be able to say the site was not read`);
    // The five nulls stay — a consumer reading the keys must not crash — but the
    // sentence beside them is what makes them not a claim.
    assert.equal(Object.keys(result.security).length, 5, name);
  }

  // The control the flag turned on: a site that did answer is measured, so the
  // field cannot be a constant that is merely present.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const live = JSON.parse((await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${port}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(live.securityChecked, true);
  assert.equal(live.security['x-frame-options'], 'DENY');
});

// ── headers: the scheme of the URL as written (P1-23) ────────────────────────
//
// Measured with a real CLI against one local server, before any code changed:
//
//   http://127.0.0.1:PORT/ok  ->  startedHttp: true   forcesHttps: false
//     HTTPS forced: ❌ no — site served over plain HTTP
//   HTTP://127.0.0.1:PORT/ok  ->  startedHttp: false  forcesHttps: null
//     (no HTTPS line at all)
//
// The same family as P1-22's `HTTPS://`: the validator goes through `new URL()`
// and the checkers spelled the rule themselves, so one capital letter silenced
// the HTTPS verdict instead of getting it wrong.

test('headers: the scheme is read from the URL, not from its capital letters', () => {
  assert.equal(urlScheme('HTTPS://acme.dk/'), 'https:');
  assert.equal(urlScheme('HTTP://acme.dk/'), 'http:');
  assert.equal(urlScheme('not a url'), null);
  assert.equal(urlScheme(undefined), null);

  // One capital letter, same site, same verdict.
  assert.deepEqual(
    readHttpsState({ startUrl: 'http://acme.dk/', finalUrl: 'http://acme.dk/' }),
    readHttpsState({ startUrl: 'HTTP://acme.dk/', finalUrl: 'HTTP://acme.dk/' }),
  );

  // Only a plain-HTTP start can be told anything about forcing HTTPS, and only
  // a walk that reached a response can be told what it did.
  assert.deepEqual(readHttpsState({ startUrl: 'https://acme.dk/', finalUrl: 'https://acme.dk/' }), { startedHttp: false, forcesHttps: null });
  assert.deepEqual(readHttpsState({ startUrl: 'http://acme.dk/', finalUrl: null }), { startedHttp: true, forcesHttps: null });
  assert.deepEqual(readHttpsState({ startUrl: 'http://acme.dk/', finalUrl: 'https://acme.dk/' }), { startedHttp: true, forcesHttps: true });
  assert.deepEqual(readHttpsState(), { startedHttp: false, forcesHttps: null });
});

test('headers: HTTP:// gets the same HTTPS verdict as http://', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const base = `127.0.0.1:${port}/`;

  const lower = await run(process.execPath, [CLI, 'headers', `http://${base}`, '--timeout', REQUEST_TIMEOUT]);
  const upper = await run(process.execPath, [CLI, 'headers', `HTTP://${base}`, '--timeout', REQUEST_TIMEOUT]);
  assert.match(lower.stdout, /HTTPS forced: ❌ no — site served over plain HTTP/);
  assert.match(upper.stdout, /HTTPS forced: ❌ no — site served over plain HTTP/, 'a site serving plain HTTP must be told so in any spelling');

  const json = JSON.parse((await run(process.execPath, [CLI, 'headers', `HTTP://${base}`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(json.startedHttp, true);
  assert.equal(json.forcesHttps, false);
  assert.equal(json.securityChecked, true);

  // Pinned ownership: the checker must not recognise the schemes itself. As in the
  // P1-13…P1-16 measurements, a behavioural test cannot prove a surface stopped
  // owning a rule — the duplicated `startsWith` returned identical answers in
  // every test above.
  const checker = readFileSync(join(ROOT, 'src', 'checkers', 'headers.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(checker, /startsWith\(['"]http/, 'the checker must ask readHttpsState(), not recognise http itself');
  assert.match(checker, /readHttpsState\(\{/);
  // The JSON's sentence is the owner's verdict, handed over — not decided twice.
  const cli = readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(cli, /securityChecked: chain\.measured/);
  assert.doesNotMatch(cli, /securityChecked:\s*r\./, 'the terminal must not decide it from the result');
});

// ── headers: a header sent with no value is not a header that is missing (P1-24) ──
//
// Measured with a real CLI against one local server, before any code changed:
//
//   x-frame-options:            (no value)
//     headers        ->  ⬜ missing: x-frame-options
//     headers --json ->  "x-frame-options": null
//
// The checker wrote `h[name] || null`, so an empty string became the same value
// as a header that never arrived. Same fault as P1-21's discarded number: two
// different errors became indistinguishable, and a bureau is told a customer's
// site lacks a header the site is sending. An empty value protects nothing, so
// it is not a pass either — it is a third state and it needs a line of its own.

test('headers: sent-with-no-value, never-sent and sent are three different things', () => {
  const security = {
    'strict-transport-security': 'max-age=31536000',
    'content-security-policy': null,
    'x-content-type-options': '',
    'x-frame-options': 'DENY',
    // A caller may hand us a value the HTTP layer never produced.
    'referrer-policy': '   ',
  };
  const reading = readSecurityHeaders(security);
  assert.deepEqual(reading.present, [['strict-transport-security', 'max-age=31536000'], ['x-frame-options', 'DENY']]);
  assert.deepEqual(reading.empty, ['x-content-type-options', 'referrer-policy']);
  assert.deepEqual(reading.absent, ['content-security-policy']);

  // The one the finding turned on: the same key, two different values, two
  // different verdicts.
  assert.deepEqual(readSecurityHeaders({ 'x-frame-options': '' }).empty, ['x-frame-options']);
  assert.deepEqual(readSecurityHeaders({ 'x-frame-options': null }).absent, ['x-frame-options']);
  assert.deepEqual(readSecurityHeaders({}).present, []);

  // A key the object does not carry is not a header the site sent.
  assert.deepEqual(readSecurityHeaders({ 'x-frame-options': undefined }).absent, ['x-frame-options']);
  assert.deepEqual(readSecurityHeaders().present, []);
  assert.deepEqual(readSecurityHeaders(null).empty, []);
});

test('headers: a header sent with no value gets its own line and its own JSON value', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-content-type-options': 'nosniff',
      // Sent, and carrying nothing.
      'x-frame-options': '',
    });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${port}/`;

  const out = (await run(process.execPath, [CLI, 'headers', url, '--timeout', REQUEST_TIMEOUT])).stdout;
  assert.match(out, /⚠️  sent with no value: x-frame-options/);
  assert.doesNotMatch(out, /missing: x-frame-options/, 'a header the site sent must never be called missing');
  // Everything the fix does not touch still prints exactly as before.
  assert.match(out, /✅ x-content-type-options: nosniff/);
  assert.match(out, /⬜ missing: strict-transport-security/);

  const json = JSON.parse((await run(process.execPath, [CLI, 'headers', url, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(json.security['x-frame-options'], '', 'the JSON must keep the empty value, not flatten it to null');
  assert.equal(json.security['content-security-policy'], null, 'a header that never arrived stays null');
  assert.deepEqual(json.securityEmpty, ['x-frame-options']);
  assert.equal(json.securityChecked, true);
  // Five keys still, so a consumer reading the keys does not crash (P1-23).
  assert.equal(Object.keys(json.security).length, 5);
});

test('headers: a normal header and a silent site are unchanged by the empty case', async (t) => {
  const normal = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
    res.end('ok');
  });
  const normalPort = await listen(normal);
  t.after(() => close(normal));
  const out = (await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${normalPort}/`, '--timeout', REQUEST_TIMEOUT])).stdout;
  assert.match(out, /✅ x-frame-options: DENY/);
  assert.match(out, /✅ referrer-policy: no-referrer/);
  assert.doesNotMatch(out, /sent with no value/, 'a header with a value is a header with a value');

  const silent = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  const silentPort = await listen(silent);
  t.after(() => close(silent));
  const silentOut = (await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${silentPort}/`, '--timeout', REQUEST_TIMEOUT])).stdout;
  for (const name of ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert.match(silentOut, new RegExp(`⬜ missing: ${name}`));
  }
  assert.doesNotMatch(silentOut, /sent with no value/, 'a site that sent nothing sent nothing');

  const silentJson = JSON.parse((await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${silentPort}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.deepEqual(silentJson.securityEmpty, [], 'an empty list, not a list of everything');
});

test('headers: the three-state reading has exactly one owner', () => {
  // A behavioural test cannot prove a surface stopped owning the rule — as in
  // P1-13…P1-23, the duplicated `|| null` answers identically in every test above.
  const checker = readFileSync(join(ROOT, 'src', 'checkers', 'headers.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(checker, /security\[name\] = h\[name\] \?\? null/, 'the checker must keep an empty value');
  assert.doesNotMatch(checker, /h\[name\] \|\|/, 'the checker must not collapse an empty value back into "not sent"');

  const cli = readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(cli, /readSecurityHeaders\(/);
  assert.match(cli, /securityEmpty: security\.empty/);
  assert.doesNotMatch(cli, /filter\(\(\[, v\]\) => !v\)/, 'the terminal must not re-decide it with falsiness');
});

// ── headers: a disclosure header sent with no value is not a silent site (P1-25) ──
//
// Measured with a real CLI against one local server, before any code changed:
//
//   x-powered-by:          (no value)
//     headers        ->  no line at all
//     headers --json ->  "poweredBy": null, "server": null
//
// The last of the three `|| null` that P1-24 found by grep. `X-Powered-By
// exposed` is a named warning a bureau puts in a client's report, and an empty
// value deleted it: the site was sending the header, and the tool said the site
// disclosed no stack. An empty value here is not the same as a header that never
// arrived — it names no stack, which is a smaller finding, and a third thing.

test('disclosure: sent-with-no-value, never-sent and sent are three different things', () => {
  const reading = readDisclosure({ server: 'nginx/1.24.0', poweredBy: '' });
  assert.equal(reading.server.state, SECURITY_HEADER.PRESENT);
  assert.equal(reading.server.value, 'nginx/1.24.0');
  assert.equal(reading.poweredBy.state, SECURITY_HEADER.EMPTY);
  assert.equal(reading.poweredBy.value, '', 'the empty value is kept, not flattened to null');

  // The one the finding turned on: the same field, two values, two verdicts.
  assert.equal(readDisclosure({ poweredBy: 'PHP/8.2.1' }).poweredBy.state, SECURITY_HEADER.PRESENT);
  assert.equal(readDisclosure({ poweredBy: '' }).poweredBy.state, SECURITY_HEADER.EMPTY);
  assert.equal(readDisclosure({ poweredBy: null }).poweredBy.state, SECURITY_HEADER.ABSENT);
  assert.equal(readDisclosure({ poweredBy: undefined }).poweredBy.state, SECURITY_HEADER.ABSENT);
  // The HTTP layer strips optional whitespace, so a value that is only spaces
  // arrives as '' — the same case as a judged header (P1-24).
  assert.equal(readDisclosure({ server: '   ' }).server.state, SECURITY_HEADER.EMPTY);

  // A site that sent neither discloses nothing, and says so with an empty list.
  assert.deepEqual(readDisclosure({}).empty, []);
  assert.deepEqual(readDisclosure(null).empty, []);
  // Named by the wire name, so a consumer reads the same spelling as the header.
  assert.deepEqual(readDisclosure({ server: '', poweredBy: '' }).empty, ['server', 'x-powered-by']);
  assert.deepEqual(readDisclosure({ server: 'nginx', poweredBy: '' }).empty, ['x-powered-by']);
});

test('headers: a disclosure header sent with no value is reported, not swallowed', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      // Sent, and carrying nothing — a site that publishes the marker without
      // naming a stack.
      'x-powered-by': '',
      server: '  ',
      'x-frame-options': 'DENY',
    });
    res.end('ok');
  });
  const port = await listen(server);
  t.after(() => close(server));
  const url = `http://127.0.0.1:${port}/`;

  const out = (await run(process.execPath, [CLI, 'headers', url, '--timeout', REQUEST_TIMEOUT])).stdout;
  assert.match(out, /⚠️  X-Powered-By sent with no value/);
  assert.doesNotMatch(out, /X-Powered-By exposed: \s*$/m, 'an empty value is not a stack name');
  // Everything the fix does not touch still prints exactly as before.
  assert.match(out, /✅ x-frame-options: DENY/);
  assert.match(out, /⬜ missing: strict-transport-security/);

  const json = JSON.parse((await run(process.execPath, [CLI, 'headers', url, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(json.poweredBy, '', 'the JSON must keep the empty value, not flatten it to null');
  assert.equal(json.server, '');
  assert.deepEqual(json.disclosureEmpty, ['server', 'x-powered-by']);
  assert.equal(json.securityChecked, true);
  // The five judged headers and their own list are untouched by this fix.
  assert.equal(Object.keys(json.security).length, 5);
  assert.deepEqual(json.securityEmpty, []);
});

test('headers: a real stack name and a silent site are unchanged by the empty case', async (t) => {
  const named = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'PHP/8.2.1', server: 'nginx/1.24.0' });
    res.end('ok');
  });
  const namedPort = await listen(named);
  t.after(() => close(named));
  const namedOut = (await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${namedPort}/`, '--timeout', REQUEST_TIMEOUT])).stdout;
  assert.match(namedOut, /⚠️  X-Powered-By exposed: PHP\/8\.2\.1/);
  assert.doesNotMatch(namedOut, /sent with no value/, 'a header with a value is a header with a value');
  const namedJson = JSON.parse((await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${namedPort}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(namedJson.poweredBy, 'PHP/8.2.1');
  assert.equal(namedJson.server, 'nginx/1.24.0');
  assert.deepEqual(namedJson.disclosureEmpty, []);

  const silent = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  });
  const silentPort = await listen(silent);
  t.after(() => close(silent));
  const silentOut = (await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${silentPort}/`, '--timeout', REQUEST_TIMEOUT])).stdout;
  assert.doesNotMatch(silentOut, /X-Powered-By/, 'a site that sends no X-Powered-By has said nothing');
  const silentJson = JSON.parse((await run(process.execPath, [CLI, 'headers', `http://127.0.0.1:${silentPort}/`, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(silentJson.poweredBy, null, 'a header that never arrived stays null');
  assert.equal(silentJson.server, null);
  assert.deepEqual(silentJson.disclosureEmpty, [], 'an empty list, not a list of everything');
});

test('headers: the three-state disclosure reading has exactly one owner', () => {
  // A behavioural test cannot prove a surface stopped owning the rule — as in
  // P1-13…P1-24, the duplicated `|| null` answers identically in every test above.
  const checker = readFileSync(join(ROOT, 'src', 'checkers', 'headers.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(checker, /server: h\['server'\] \?\? null/, 'the checker must keep an empty value');
  assert.match(checker, /poweredBy: h\['x-powered-by'\] \?\? null/);
  assert.doesNotMatch(checker, /h\['server'\] \|\|/, 'the checker must not collapse an empty value back into "not sent"');
  assert.doesNotMatch(checker, /h\['x-powered-by'\] \|\|/);

  const cli = readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(cli, /readDisclosure\(/);
  assert.match(cli, /disclosureEmpty: disclosure\.empty/);
  assert.doesNotMatch(cli, /if \(r\.poweredBy\)/, 'the terminal must not re-decide it with falsiness');
});

test('watch: an empty lastHash is no baseline, which is not the same code as a header', async (t) => {
  // P1-25 measured the other two `||` this task listed, on a hand-written
  // `state.json`, and left them alone — the asymmetry has a reason. An empty
  // `X-Powered-By` is something a real server sends on the wire, so losing it
  // falsifies a measurement. An empty `lastHash` is something DeskUptime has
  // never written: `watch` only ever stores a 64-hex sha256. It is a corrupt or
  // restored file, and "we had no baseline" is the honest reading of one.
  //
  // Measured with the real CLI on a monitored site, `lastHash: ""`, `null` and a
  // real baseline respectively: the first two behaved identically — no event, no
  // change claim — and both were repaired to the real hash by that same pass,
  // while a genuine baseline reported "content changed".
  const url = 'http://watch.test/empty-hash';
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-hash-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { env: { HOME: home, USERPROFILE: home } };
  const hash = 'a'.repeat(64);
  const seen = [];

  for (const lastHash of ['', null]) {
    const state = watchState(url);
    state.urls[url].wasUp = true;
    state.urls[url].lastHash = lastHash;
    const pass = await runPass(state, {
      ...options,
      check: async (_url, { contentHash }) => {
        seen.push(contentHash);
        return watchResult({ content: { fetched: true, contentLength: 10, hash, changed: contentHash ? contentHash !== hash : null, previousHash: contentHash } });
      },
      returnResults: true,
    });
    // No false "content changed" for a file that never had a usable baseline:
    // the site is up and stays up, so the pass has nothing to report.
    assert.deepEqual(pass.events.map(event => event.type), [], `lastHash ${JSON.stringify(lastHash)} must not claim a change`);
    // And the same pass repairs it, so the next pass has a real baseline.
    assert.equal(loadState(options).urls[url].lastHash, hash);
  }

  // Both readings reach the checker as the same thing: "no baseline".
  assert.deepEqual(seen, [null, null]);
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

test('a license the server rejected loses Pro, and a Pro word nobody re-checked loses it too', () => {
  const base = { key: LICENSE_KEY, instance: 'deskuptime-maskine' };
  const fresh = new Date().toISOString();
  const fortyOneDays = new Date(Date.now() - 41 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isPro({ license: { ...base, status: 'invalid' } }), false);
  assert.equal(isPro({ license: { ...base, status: 'cached', validatedAt: fresh } }), true);
  assert.equal(isPro({ license: { ...base, status: 'active', validatedAt: fresh } }), true);
  // An unverified key is not Pro either, even though it was never rejected.
  assert.equal(isPro({ license: { ...base, status: 'unverified' } }), false);
  // Legacy state without a status keeps working — but only while something says
  // when it was last confirmed. `active` and `cached` are claims about a check,
  // and a record whose last confirmation is 41 days old has been contradicted by
  // time, not by the server: `status` reads the same record as `unverified`.
  assert.equal(isPro({ license: { ...base, validatedAt: fresh } }), true);
  assert.equal(isPro({ license: base }), false, 'a license with no confirmation time is not Pro');
  assert.equal(isPro({ license: { ...base, status: 'active', validatedAt: fortyOneDays } }), false);
  assert.equal(isPro({ license: { ...base, status: 'cached', validatedAt: fortyOneDays } }), false);
  // …and a rejection is not a measurement that goes stale, so it keeps its word.
  assert.equal(isPro({ license: { ...base, status: 'invalid', validatedAt: fortyOneDays } }), false);
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

  // A free user gets a way to buy, not just a way to be told they are free:
  // `deskuptime status` is the first command such a user runs, and the old line
  // ended at `activate <license-key>` — a key they cannot have without buying.
  const free = await withLicense(null);
  assert.match(free, /Free tier\./);
  assert.match(free, /buy\.stripe\.com/, 'en gratisbruger får ingen vej til at købe');
  assert.doesNotMatch(free, new RegExp(LICENSE_KEY));

  assert.match(await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'active', validatedAt: yesterday }), /Pro license: active, last verified/);
  assert.match(await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'cached', validatedAt: yesterday }), /Pro license: cached\/offline/);

  // P1-18: a Pro word is a claim about a check. `status` is read-only, so a word
  // whose last confirmation is 41 days old is a claim about a check that never
  // happened — the same sentence the identical record already got as `cached`.
  const fortyOneDays = new Date(Date.now() - 41 * 86_400_000).toISOString();
  const staleActive = await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'active', validatedAt: fortyOneDays });
  const staleCached = await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'cached', validatedAt: fortyOneDays });
  assert.match(staleActive, /Pro license: unverified/);
  assert.match(staleActive, /not verified for 41 days/);
  assert.doesNotMatch(staleActive, /buy\.stripe\.com/, 'denne kunde har betalt');
  assert.equal(
    staleActive.split('\n')[0],
    staleCached.split('\n')[0],
    'to state-filer der kun adskiller sig ved ét gemt ord må ikke få modsatte domme',
  );
  // And a record with no confirmation time at all cannot say "active, not
  // verified yet" in one line.
  const neverConfirmed = await withLicense({ key: LICENSE_KEY, instance: 'deskuptime-maskine', status: 'active' });
  assert.match(neverConfirmed, /Pro license: unverified/);
  assert.match(neverConfirmed, /never verified/);
  assert.doesNotMatch(neverConfirmed, /Pro license: active/);

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

test('action: the certificate window is the CLI window, and a lapsed certificate fails', async (t) => {
  // `check`, `watch` and the client report all warn at exactly `days` remaining,
  // and the Action used `< days`, so a certificate on the boundary passed here
  // and failed everywhere else. `sslDaysRemaining` is clamped to 0, so the window
  // alone could not express "expired" either — a lapsed certificate and one
  // expiring tonight both read 0.
  const site = (extra) => ({
    url: 'https://acme.dk/', healthy: true, statusCode: 200, responseTimeMs: 20,
    sslError: null, sslDaysRemaining: null, ...extra,
  });
  const cases = [
    { name: 'exactly on the boundary warns', payload: [site({ sslDaysRemaining: 14 })], fail: true },
    { name: 'one day outside the window does not', payload: [site({ sslDaysRemaining: 15 })], fail: false },
    { name: 'inside the window fails', payload: [site({ sslDaysRemaining: 9 })], fail: true },
    { name: 'a lapsed certificate fails', payload: [site({ sslDaysRemaining: 0, sslExpired: true, sslExpiredDays: 30 })], fail: true },
    { name: 'zero days left is the boundary case', payload: [site({ sslDaysRemaining: 0, sslExpired: false })], fail: true },
    { name: 'an unusable value is unknown, not urgent', payload: [site({ sslDaysRemaining: '9' })], fail: false },
    { name: 'a negative value is not urgent either', payload: [site({ sslDaysRemaining: -3 })], fail: false },
    { name: 'an unreadable certificate is a failure', payload: [site({ sslError: 'handshake failed' })], fail: true },
    { name: 'a healthy certificate passes', payload: [site({ sslDaysRemaining: 63 })], fail: false },
  ];

  for (const { name, payload, fail } of cases) {
    const { root, temp } = stubAction(t, JSON.stringify(payload));
    const env = actionEnv({
      DU_URLS: 'https://acme.dk/',
      DU_FAIL_ON_DOWN: 'false',
      DU_SSL_DAYS: '14',
      GITHUB_ACTION_PATH: root,
    }, temp);
    const error = await run('bash', ['-c', actionScript()], { cwd: temp, env }).catch((e) => e);
    // `run` rejects on a non-zero exit, so a resolved call has already passed.
    const code = error.code ?? 0;
    if (fail) {
      assert.equal(code, 3, `${name}: expected exit 3`);
      assert.match(`${error.stdout}${error.stderr}`, /SSL certificates expiring/, name);
    } else {
      assert.equal(code, 0, `${name}: expected exit 0, got ${code}: ${error.stdout}${error.stderr}`);
    }
  }
});

// ── P1-9 punkt 9: rå interpolation i step-summary ──
// `summary: true` er den eneste menneske-flade, der hverken gik gennem
// safeText eller rapportens cell(). Målt før rettelsen: en URL med ét `|` og
// ét linjeskift skrev to rækker i $GITHUB_STEP_SUMMARY, hvoraf den anden så
// ud som en målt DOWN-række for et site, der aldrig blev tjekket.

function summaryRows(text) {
  // How a Markdown reader sees it: one row per line, cells split on unescaped pipes.
  return text
    .split('\n')
    .filter(line => line.startsWith('| '))
    .map(line => line.replace(/\\\|/g, '\u0000').split('|').length);
}

test('action: a hostile URL cannot forge a row in the step summary', async (t) => {
  const hostile = 'https://evil.test/a|<script>alert(1)</script>|\n| forged-row | https://b.test | DOWN | 500 |';
  const { root, temp } = stubAction(t, JSON.stringify([
    { url: hostile, healthy: true, statusCode: 200, responseTimeMs: 12, sslDaysRemaining: 90, sslExpiringSoon: false },
  ]));

  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: actionEnv({
      DU_URLS: 'https://evil.test/',
      DU_FAIL_ON_DOWN: 'true',
      DU_SUMMARY: 'true',
      GITHUB_ACTION_PATH: root,
    }, temp),
  });

  const summary = readFileSync(join(temp, 'github-summary'), 'utf8');
  const widths = new Set(summaryRows(summary));
  // The header and exactly one measured row. A URL that splits its own cell
  // adds a row, which is the whole failure: measured before the fix, this same
  // payload wrote 3 — the header, the half-row, and a forged `| forged-row |`.
  assert.equal(summaryRows(summary).length, 2, `summary had extra rows:\n${summary}`);
  assert.equal(widths.size, 1, `rows have different widths ${[...widths]}:\n${summary}`);
  assert.doesNotMatch(summary, /<script>/, 'markup from a URL reached the summary');
  assert.match(summary, /forged-row/, 'the hostile text is still visible — as one cell, not as a row');
  assert.doesNotMatch(summary, /^\| forged-row/m, 'a URL forged its own table row');
});

test('action: the summary cannot be broken by a value the CLI does not produce', async (t) => {
  // statusCode and responseTimeMs are numbers from our own CLI. A payload from
  // another version, or a hand-edited results file, is not — and a pipe in any
  // of them splits the row just as a pipe in the URL does.
  const { root, temp } = stubAction(t, JSON.stringify([
    { url: 'https://a.test/', healthy: true, statusCode: '200|forged', responseTimeMs: '1|2', sslDaysRemaining: '9|9' },
  ]));

  await run('bash', ['-c', actionScript()], {
    cwd: temp,
    env: actionEnv({
      DU_URLS: 'https://a.test/',
      DU_FAIL_ON_DOWN: 'true',
      DU_SUMMARY: 'true',
      GITHUB_ACTION_PATH: root,
    }, temp),
  });

  const summary = readFileSync(join(temp, 'github-summary'), 'utf8');
  assert.equal(new Set(summaryRows(summary)).size, 1, `rows have different widths:\n${summary}`);
  assert.doesNotMatch(summary, /200\|forged|1\|2|9\|9/, 'a raw value reached the table unescaped');
});

test('action: a payload whose sslExpiringSoon is not a boolean fails the step', async (t) => {
  // The validation block existed so a payload the step cannot count fails loudly
  // instead of turning into a green run. `healthy` and `url` were checked;
  // `sslExpiringSoon` was not, so a CLI version that sent a string passed.
  const { root, temp } = stubAction(t, JSON.stringify([
    { url: 'https://acme.dk/', healthy: true, sslExpiringSoon: 'yes', sslDaysRemaining: 3 },
  ]));

  await assert.rejects(
    run('bash', ['-c', actionScript()], {
      cwd: temp,
      env: actionEnv({
        DU_URLS: 'https://acme.dk/',
        DU_FAIL_ON_DOWN: 'true',
        GITHUB_ACTION_PATH: root,
      }, temp),
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(`${error.stdout}${error.stderr}`, /sslExpiringSoon/, 'the error does not name the field');
      return true;
    },
  );
});

// ── check: a 200 from another host is not a 200 from the site (P1-26) ──
//
// Measured with the real CLI against a local site that 301s to a *different*
// host and answers 200 there — a registrar's parking page, or a domain pointed
// at one — before any code changed:
//
//   $ deskuptime check http://127.0.0.1:58853/
//   ✅ http://127.0.0.1:58853/
//      Status:   200 — UP                                     ← exit 0
//   $ deskuptime headers http://127.0.0.1:58853/
//      301 → http://127.0.0.1:58851/lander
//      Final: http://127.0.0.1:58851/lander (200) — redirected
//
// `finalUrl` was measured by `checkReachability` on every check and died in the
// engine: not the terminal, not `--json`, not `watch`, not the client report. So
// "UP" was a claim about a URL nobody asked about — and a client's domain that
// expires and gets parked answers 200, which is 100 % uptime in a bureau's
// report for a site that has not existed for a month.

test('redirect target: the host that answered is read once, and only when it can be', () => {
  // The same host, spelled the way a redirect spells it: a path and a default
  // port are not another host. `http://a.dk` and `http://a.dk:80/` are one host.
  const same = readRedirectTarget({ url: 'http://acme.dk/gammel', finalUrl: 'http://acme.dk:80/ny' });
  assert.equal(same.offHost, false);
  assert.equal(same.askedHost, 'acme.dk');
  assert.equal(same.answeredHost, 'acme.dk');
  assert.equal(same.note, '');

  // An http → https upgrade is the site's own doing, not another host, and
  // `readHttpsState` already has a verdict about it (`forcesHttps`).
  assert.equal(readRedirectTarget({ url: 'http://acme.dk/', finalUrl: 'https://acme.dk/' }).offHost, false);

  // A different port is a different server, and `host` (not `hostname`) says so.
  assert.equal(readRedirectTarget({ url: 'http://acme.dk/', finalUrl: 'http://acme.dk:8080/' }).offHost, true);

  // The finding: the 200 came from somewhere else, and it is named.
  const off = readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: 'http://parked.example/lander' });
  assert.equal(off.offHost, true);
  assert.equal(off.finalUrl, 'http://parked.example/lander');
  assert.match(off.note, /parked\.example/);
  assert.match(off.note, /kunde\.dk/);

  // A rule that cannot be measured claims nothing — the bar `readSslState` and
  // `readContentState` are held to. No response, or an unparseable URL, is not
  // a host change.
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: null }).offHost, false);
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/' }).offHost, false);
  assert.equal(readRedirectTarget({ url: 'kunde.dk', finalUrl: 'https://andet.dk/' }).offHost, false);
  assert.equal(readRedirectTarget({}).offHost, false);
  assert.equal(readRedirectTarget({ url: 'https://kunde.dk/', finalUrl: '' }).finalUrl, null);
});

test('check: a response from another host is named, and a redirect on the same host is not', async (t) => {
  // Two hosts, as two ports: the monitored site 301s off to the second one.
  const parked = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>This domain may be for sale</title></html>');
  });
  const parkedPort = await listen(parked);
  t.after(() => close(parked));

  const site = createServer((req, res) => {
    if (req.url === '/flyttet') {
      res.writeHead(301, { location: `http://127.0.0.1:${parkedPort}/lander` });
      res.end();
      return;
    }
    // A redirect on its own host — the ordinary kind, which must stay quiet.
    if (req.url === '/gammel') {
      res.writeHead(301, { location: '/ny' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Client site</title></html>');
  });
  const sitePort = await listen(site);
  t.after(() => close(site));

  // The harm: a domain that is now a parking page reads as a healthy site.
  const hijacked = `http://127.0.0.1:${sitePort}/flyttet`;
  const human = await run(process.execPath, [CLI, 'check', hijacked, '--timeout', REQUEST_TIMEOUT]);
  assert.match(human.stdout, /⚠️  answered by another host/, human.stdout);
  assert.match(human.stdout, new RegExp(String(parkedPort)), 'the note must name the host that answered');
  // A redirect is not a DOWN: `www.acme.dk → acme.dk` is the most ordinary
  // redirect on the web, and failing it would be a false alarm on a healthy site.
  assert.match(human.stdout, /200 — UP/, human.stdout);

  const json = JSON.parse((await run(process.execPath, [CLI, 'check', hijacked, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(json[0].healthy, true, 'the verdict itself is unchanged');
  assert.equal(json[0].offHostRedirect, true);
  assert.equal(json[0].finalUrl, `http://127.0.0.1:${parkedPort}/lander`);
  // Everything the fix does not touch is byte-identical, so no existing consumer
  // of `check --json` changes.
  assert.equal(json[0].url, hijacked);
  assert.equal(json[0].statusCode, 200);

  // The control: the same site, reached by a path redirect on its own host.
  const own = `http://127.0.0.1:${sitePort}/gammel`;
  const quiet = await run(process.execPath, [CLI, 'check', own, '--timeout', REQUEST_TIMEOUT]);
  assert.doesNotMatch(quiet.stdout, /answered by another host/, quiet.stdout);
  const quietJson = JSON.parse((await run(process.execPath, [CLI, 'check', own, '--json', '--timeout', REQUEST_TIMEOUT])).stdout);
  assert.equal(quietJson[0].offHostRedirect, false);
  assert.equal(quietJson[0].finalUrl, `http://127.0.0.1:${sitePort}/ny`);
});

test('check: the host comparison has one owner', () => {
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const cli = strip(readFileSync(join(ROOT, 'src', 'cli.js'), 'utf8'));
  assert.match(cli, /readRedirectTarget\(/, 'cli.js must ask the owner, not compare hosts itself');
  assert.match(cli, /offHostRedirect: redirect\.offHost/);
  assert.match(cli, /if \(redirect\.offHost\)/);
  // The engine already measured this; a second reader of `finalUrl` in the
  // terminal is a second rule that can drift from the JSON's.
  assert.doesNotMatch(cli, /\.host\s*[!=]==?\s*/, 'the terminal must not compare hosts on its own');
});

// ── P1-27: the same fact on the four surfaces that decide something for money ──
//
// P1-26 gave `check` a line for a response that came from another host. Measured
// in the same run, and unchanged by that fix, all four of these still reported a
// parked or hijacked domain as a plain UP:
//
//   watch --once ->  baseline recorded: UP (200)
//   watch --status, status ->  ✅ up … (200)
//   report       ->  | https://kunde.dk | UP (200) | 100% (1 checks) | … |
//   webhook      ->  {"type":"up","message":"is UP (200) — 41ms"}
//
// All four are paid or bureau-used, and a cross-host answer is not DOWN — so the
// event type cannot carry it and a channel has nothing to branch on. The engine
// measured `finalUrl` on every pass; `runPass` threw it away, so nothing after
// the pass could see it. Now it is kept, asked of the one owner, and named.

test('watch: en pass gemmer hvem der svarede, og siger det når værten ændrer sig', async () => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-offhost-'));
  const opts = { stateFile: join(home, 'state.json'), home, now: new Date('2026-09-26T09:00:00.000Z') };
  const url = 'https://kunde.dk/';
  const state = { urls: { [url]: { addedAt: opts.now.toISOString(), wasUp: null } } };
  const parked = { healthy: true, statusCode: 200, responseTimeMs: 41, finalUrl: 'http://parked.example/lander', content: { hash: 'a'.repeat(64) }, timestamp: opts.now.toISOString() };
  const parkedAgain = { ...parked, finalUrl: 'http://parked.example/lander?session=2' };
  const hijacked = { ...parked, finalUrl: 'http://phishing.example/' };
  const ownHost = { ...parked, finalUrl: 'https://kunde.dk/ny' };

  let pass = await runPass(state, { ...opts, check: async () => parked });
  assert.equal(state.urls[url].lastFinalUrl, 'http://parked.example/lander', 'den målte kendsgerning skal overleve passet');
  const redirects = pass.filter(e => e.type === 'redirect');
  assert.equal(redirects.length, 1, 'et kunde-domæne der er parkeret skal sige det én gang');
  assert.match(redirects[0].message, /answered by another host/);
  assert.match(redirects[0].message, /parked\.example/);
  assert.equal(redirects[0].finalUrl, 'http://parked.example/lander', 'hændelsen bærer den rå kendsgerning, så kanalen ikke skal gætte');
  // Not DOWN, and not a recovery either: the verdict is untouched.
  assert.equal(state.urls[url].wasUp, true);
  assert.equal(pass.some(e => e.type === 'down'), false);

  // A second pass where the *same* other host answers with a different path —
  // a signed link, a rotating path. Not news: a paying customer must not get a
  // notification every 60 seconds because a domain is parked.
  pass = await runPass(state, { ...opts, check: async () => parkedAgain });
  assert.equal(pass.filter(e => e.type === 'redirect').length, 0, 'samme fremmede vært igen er ikke en ny hændelse');

  // A different other host *is* news — that is a hijack after a parking page.
  pass = await runPass(state, { ...opts, check: async () => hijacked });
  assert.equal(pass.filter(e => e.type === 'redirect').length, 1);

  // The ordinary case: `www → apex` and any path redirect on the site's own host.
  // Stays silent on every surface, and the latch is released so a later
  // cross-host answer is announced again instead of being swallowed.
  pass = await runPass(state, { ...opts, check: async () => ownHost });
  assert.equal(pass.filter(e => e.type === 'redirect').length, 0, 'en redirect på egen vært tier');
  assert.equal(state.urls[url].lastFinalUrl, 'https://kunde.dk/ny', 'også på egen vært gemmes den, så rækker kan vise hvor svaret kom fra');
  assert.equal(state.urls[url].answeredBy, undefined, 'låsen skal frigives, så næste fremmede vært høres');
  pass = await runPass(state, { ...opts, check: async () => parked });
  assert.equal(pass.filter(e => e.type === 'redirect').length, 1, 'efter en stille pass skal et nyt skift stadig høres');

  // readEntry is the one reading the two terminal lists share, and the state's
  // key is not in the entry — so the URL has to be handed in. Without it the
  // reading is unmeasured, and an unmeasured rule says nothing.
  const offHost = readEntry(state.urls[url], { url, now: opts.now });
  assert.equal(offHost.redirect.offHost, true);
  assert.match(offHost.redirect.label, /parked\.example/);
  assert.match(offHost.redirect.label, /asked kunde\.dk/, 'sætningen skal sige hvem der blev spurgt');
  assert.equal(readEntry(state.urls[url], { now: opts.now }).redirect.offHost, false, 'uden URL må intet påstås');
  assert.equal(readEntry({ lastFinalUrl: 'ikke-en-url' }, { url }).redirect.offHost, false, 'en ulæselig værts-streng tier');
});

test('de fire betalte flader kan se skiftet, og de tier på en redirect på egen vært', async (t) => {
  // The harm, unchanged: a domain that expired and got parked, or was hijacked
  // and now points somewhere else. A 200 either way, so nothing but the recorded
  // measurement can tell the two apart.
  const parked = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>This domain may be for sale</title></html>');
  });
  const parkedPort = await listen(parked);
  t.after(() => close(parked));

  const site = createServer((req, res) => {
    if (req.url === '/flyttet') {
      res.writeHead(301, { location: `http://127.0.0.1:${parkedPort}/lander` });
      res.end();
      return;
    }
    if (req.url === '/gammel') {
      res.writeHead(301, { location: '/ny' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Client site</title></html>');
  });
  const sitePort = await listen(site);
  t.after(() => close(site));

  const hijacked = `http://127.0.0.1:${sitePort}/flyttet`;
  const own = `http://127.0.0.1:${sitePort}/gammel`;
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-offhost-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const cli = (...args) => run(process.execPath, [CLI, ...args], { env });

  // A real pass against both fixtures. The terminal line is the owner's sentence,
  // so it must name the host that answered.
  const once = await cli('watch', hijacked, own, '--once');
  assert.match(once.stdout, new RegExp(String(parkedPort)), once.stdout);
  assert.match(once.stdout, /answered by another host/, once.stdout);
  assert.doesNotMatch(once.stdout, /gammel.*answered by another host/, 'egen-vært-redirecten skal ikke sige noget');

  const state = JSON.parse(readFileSync(getStateFile({ env }), 'utf-8'));
  assert.equal(state.urls[hijacked].lastFinalUrl, `http://127.0.0.1:${parkedPort}/lander`);
  assert.equal(state.urls[own].lastFinalUrl, `http://127.0.0.1:${sitePort}/ny`);

  // 1. `watch --status`
  const watchStatus = await cli('watch', '--status');
  assert.match(watchStatus.stdout, new RegExp(`answered by 127\\.0\\.0\\.1:${parkedPort}`), watchStatus.stdout);
  assert.doesNotMatch(watchStatus.stdout, new RegExp(`answered by 127\\.0\\.0\\.1:${sitePort} \\(asked`), 'egen vært: ingen linje');

  // 2. `status` — the other list, same state file
  const status = await cli('status');
  assert.match(status.stdout, new RegExp(`answered by 127\\.0\\.0\\.1:${parkedPort}`), status.stdout);
  assert.match(status.stdout, /\/gammel \(200\)/, 'kontrolrækken er der stadig');
  const statusQuiet = status.stdout.split('\n').find(line => line.includes('/gammel'));
  assert.doesNotMatch(statusQuiet, /answered by/, statusQuiet);

  // 3. `report` — the document an agency forwards. Rendered from the same state
  // file through the real report code; the command itself is Pro-gated, so the
  // gate is not simulated here.
  const report = buildReport(state, { now: new Date() });
  const crossed = report.sites.find(site => site.url === hijacked);
  const quiet = report.sites.find(site => site.url === own);
  assert.equal(crossed.offHostRedirect, true);
  assert.match(crossed.offHostNote, new RegExp(String(parkedPort)));
  assert.equal(quiet.offHostRedirect, false);
  assert.equal(quiet.offHostNote, '', 'en stille række får ingen note');
  assert.equal(quiet.status, 'up', 'verdikten er uændret — en redirect er ikke DOWN');

  const markdown = renderReportMarkdown(report);
  assert.match(markdown, new RegExp(`\\| UP \\(200\\) ⚠️ answered by 127\\.0\\.0\\.1:${parkedPort}`), markdown);
  assert.match(markdown, /answered by another host — the monitored URL no longer serves the site itself/, 'den skal siges højt, som et udløbet certifikat');
  assert.match(markdown, /1 answered by another host/, 'og tælles i opsummeringen');
  const quietRow = markdown.split('\n').find(line => line.includes(own));
  assert.doesNotMatch(quietRow, /answered by/, quietRow);
  // A parked page is the site's content, not the customer's — the report must not
  // forward a full redirect URL, whose path can carry a token.
  assert.ok(!markdown.includes('/lander'), 'rapporten må ikke sende hele finalUrl videre');

  // 4. The webhook payload, on the same measured facts.
  const received = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('ok'); });
  });
  const hookPort = await listen(hook);
  t.after(() => close(hook));
  const { sendWebhook } = await import('../src/watch.js');
  await sendWebhook(`http://127.0.0.1:${hookPort}/hook`, {
    type: 'baseline',
    url: hijacked,
    message: `baseline recorded: UP (200) — 12ms`,
    measuredAt: state.urls[hijacked].lastChecked,
    finalUrl: state.urls[hijacked].lastFinalUrl,
  });
  assert.equal(received[0].offHostRedirect, true, 'Pro-kanalen skal se skiftet uden at regne på værter');
  assert.equal(received[0].finalUrl, `http://127.0.0.1:${parkedPort}/lander`);
});

test('værtssammenligningen har stadig kun én ejer', () => {
  const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const name of ['watch.js', 'report.js']) {
    const source = strip(readFileSync(join(ROOT, 'src', name), 'utf8'));
    assert.doesNotMatch(source, /\.host\s*[!=]==?\s*/, `${name} må ikke sammenligne værter selv`);
  }
  const report = strip(readFileSync(join(ROOT, 'src', 'report.js'), 'utf8'));
  assert.match(report, /readRedirectTarget\(/, 'rapporten skal spørge ejeren');
  const watch = strip(readFileSync(join(ROOT, 'src', 'watch.js'), 'utf8'));
  assert.match(watch, /readRedirectTarget\(/, 'watch skal spørge ejeren');
  assert.match(watch, /redirect\.note/, 'watch-gen skal bruge ejerens sætning, ikke sin egen');
});
