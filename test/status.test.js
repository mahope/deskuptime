import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, checkUrls } from '../src/engine.js';

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

async function statusServer(t, redirectTarget) {
  const sockets = new Set();
  const server = createServer((req, res) => {
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
