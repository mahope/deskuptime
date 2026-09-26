/**
 * display.test.js — text a monitored site can choose must not be able to
 * repaint, reorder or reflow what DeskUptime prints.
 *
 * Measured first, so this test asserts the reachable case and not a fantasy.
 * undici (the client behind `fetch`) rejects a response whose header value
 * contains ESC, BEL, VT, FF or a bare 0x9B — those can never reach a print
 * site, and a test that pretended otherwise would be green for the wrong
 * reason. But the same parser lets U+009B (8-bit CSI), U+0085 (NEL) and DEL
 * through as ordinary characters, because it decodes header bytes as latin1.
 * NEL breaks the one-event-per-line log format that humans and scripts both
 * read, and U+009B is a CSI in a terminal running in 8-bit control mode. The
 * bidi and zero-width classes are swept for the same reason: they render as
 * nothing while still being in the string.
 *
 * The control bytes below are built with String.fromCharCode on purpose — a
 * literal ESC in a source file is invisible in review and easy to "fix" by
 * accident. The fixture is a raw `net` socket rather than `node:http`, because
 * node:http validates *outgoing* header values and would refuse to send what a
 * hostile server would; that refusal is a client-side guard, not proof.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeText } from '../src/display.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

const char = code => String.fromCharCode(code);
const CSI8 = char(0x9b); // 8-bit control sequence introducer — reaches us
const NEL = char(0x85); // next line — reaches us, and some terminals honour it
const RLO = char(0x202e); // right-to-left override
const LRM = char(0x200e);
const ZWSP = char(0x200b);
const BOM = char(0xfeff);
const LRI = char(0x2066);
const PDI = char(0x2069);
// Bytes undici rejects outright, so they can never reach a print site. Kept as
// fixtures for the boundary test that documents it.
const ESC = char(0x1b);
const BEL = char(0x07);
const DEL = char(0x7f);

/** What a hostile site would put in a header value to forge the report below it. */
const FORGED = `${CSI8}[2J${CSI8}[1;31mAll headers present${NEL}missing: nothing`;

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

const SERVERS = [];
const SOCKETS = [];
after(() => {
  // net.Server has no closeAllConnections() (that is http.Server), so the open
  // sockets are tracked and destroyed by hand — otherwise the runner never exits.
  for (const socket of SOCKETS) socket.destroy();
  for (const server of SERVERS) server.close();
});

async function startHostileServer({ status = '200 OK', headers = {}, body = 'ok' } = {}) {
  const lines = [`HTTP/1.1 ${status}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  const response = Buffer.from(
    `${lines.join('\r\n')}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    'latin1',
  );
  const server = createServer(sock => {
    SOCKETS.push(sock);
    sock.on('data', () => sock.end(response));
    sock.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  SERVERS.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** Nothing a site sends may put a control or invisible character in the output. */
function assertInert(output, label) {
  // LF and CR are the separators DeskUptime writes itself, so they are the one
  // part of the C0 range that is not smuggling.
  const ranges = [[0x00, 0x09], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029],
    [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
  const pattern = new RegExp(`[${ranges.map(([a, b]) =>
    a === b ? char(a) : `${char(a)}-${char(b)}`).join('')}]`, 'g');
  const smuggled = output.match(pattern);
  assert.equal(smuggled, null,
    `${label}: output still contains ${smuggled ? JSON.stringify([...new Set(smuggled)]) : ''}`);
}

// ── The sanitizer itself ──

test('display: benign text is returned unchanged', () => {
  const csp = "default-src 'self'; script-src 'none'; frame-ancestors 'none'";
  assert.equal(safeText(csp, { max: 0 }), csp);
  assert.equal(safeText('https://example.com/path?a=1&b=2'), 'https://example.com/path?a=1&b=2');
  assert.equal(safeText('PHP/8.2.1'), 'PHP/8.2.1');
  assert.equal(safeText('max-age=31536000; includeSubDomains'), 'max-age=31536000; includeSubDomains');
  assert.equal(safeText('DENY'), 'DENY');
  assert.equal(safeText('SAMEORIGIN'), 'SAMEORIGIN');
  assert.equal(safeText('no-sniff'), 'no-sniff');
  // The default cap is the one the headers report has always used.
  assert.equal(safeText('a'.repeat(60)), 'a'.repeat(60));
});

test('display: an escape sequence is removed whole, not just its ESC byte', () => {
  // The sequence goes, so the visible residue `[2J` is not left behind either.
  assert.equal(safeText(`Totally fine${ESC}[2J`), 'Totally fine');
  assert.equal(safeText(`${ESC}[2JAll headers present`), 'All headers present');
  assert.equal(safeText(`a${ESC}[1;31mred${ESC}[0mb`), 'aredb');
  // An 8-bit CSI is introducer + one final byte, exactly as a terminal reads it,
  // so `2J` is left as the ordinary text a terminal would also have shown.
  assert.equal(safeText(`${CSI8}[2Jonly`), '2Jonly');
  assert.equal(safeText(`${CSI8}[2J`), '2J');
});

test('display: OSC can no longer set the window title', () => {
  assert.equal(safeText(`x-powered-by${ESC}]0;pwned${BEL}`), 'x-powered-by');
  // Terminated by ST (ESC \) instead of BEL — the other legal way to end it.
  assert.equal(safeText(`value${ESC}]0;pwned${ESC}\\`), 'value');
});

test('display: the bytes that really do reach us are swept', () => {
  // Measured through fetch: everything from 0x80 up survives, because undici
  // decodes header bytes as latin1 and only rejects 0x00-0x1f and 0x7f.
  assert.equal(safeText(`X${CSI8}[2J`), 'X2J');
  assert.equal(safeText(`line one${NEL}line two`), 'line one line two');
  assert.equal(safeText(`del${char(0x7f)}char`), 'del char');
  assert.equal(safeText('GET / HTTP/1.1\r\nX-Injected: yes'), 'GET / HTTP/1.1 X-Injected: yes');
  assert.equal(safeText('line one\nline two'), 'line one line two');
  assert.equal(safeText('tab\there'), 'tab here');
});

test('display: zero-width and bidi characters cannot hide or reorder text', () => {
  assert.equal(safeText(`secure${RLO}yrenamoc.ecexe`), 'secureyrenamoc.ecexe');
  assert.equal(safeText(`zero${ZWSP}width`), 'zerowidth');
  assert.equal(safeText(`bom${BOM}marker`), 'bommarker');
  assert.equal(safeText(`ltr${LRM}rtl`), 'ltrrtl');
  assert.equal(safeText(`isolate${LRI}x${PDI}`), 'isolatex');
});

test('display: length cap and nullish fallback match the old inline cap', () => {
  const long = 'a'.repeat(100);
  assert.equal(safeText(long), `${'a'.repeat(57)}...`);
  assert.equal(safeText('a'.repeat(60)), 'a'.repeat(60));
  assert.equal(safeText('short'), 'short');
  assert.equal(safeText(long, { max: 0 }), long);
  assert.equal(safeText(null), '');
  assert.equal(safeText(undefined), '');
  assert.equal(safeText(null, { fallback: '—' }), '—');
  assert.equal(safeText(200), '200');
  assert.equal(safeText(0), '0');
});

// ── End to end, against a site that tries ──

test('cli: headers cannot be made to print a forged security report', { timeout: 30000 }, async () => {
  const url = await startHostileServer({
    headers: {
      'x-powered-by': `PHP${FORGED}`,
      'content-security-policy': `default-src 'self'${CSI8}[2J`,
    },
  });

  const { code, stdout } = await run(['headers', url]);
  assert.equal(code, 0, 'a 200 must still exit 0');
  assertInert(stdout, 'headers');

  // The attacker's text survives as ordinary, visible characters...
  assert.match(stdout, /All headers present/);
  // ...but the forged "missing: nothing" is text inside a value, and the honest
  // findings are all still there, one per line.
  const missing = stdout.split('\n').filter(line => line.includes('⬜ missing:'));
  assert.equal(missing.length, 4, `expected 4 real missing headers, got ${JSON.stringify(missing)}`);
  for (const name of ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert.ok(missing.some(line => line.includes(name)), `missing-header line for ${name} was lost`);
  }
  assert.match(stdout, /X-Powered-By exposed/);
  assert.match(stdout, /Final: http:\/\/127\.0\.0\.1:\d+ \(200\)/);
  assert.equal(stdout.includes('[2J'), false, 'CSI residue leaked into the output');
});

test('cli: a redirect target is neutralised by URL parsing, before it is printed', { timeout: 30000 }, async () => {
  // Measured, not assumed: checkHeaders resolves a Location through `new URL()`,
  // which percent-encodes the C1 controls, so the chain line cannot carry a raw
  // one. Asserted so a future change to that resolution cannot reopen it.
  const url = await startHostileServer({
    status: '302 Found',
    headers: { location: `http://127.0.0.1:65000/${FORGED}` },
  });
  const { stdout } = await run(['headers', url]);
  assertInert(stdout, 'headers redirect');
  // The redirect was followed and refused, so the chain shows up in the final URL
  // — percent-encoded, which is the property under test.
  assert.match(stdout, /Final: http:\/\/127\.0\.0\.1:65000\/%C2%9B/);
  assert.match(stdout, /Error: Connection refused/);
});

test('cli: headers --json stays lossless, because JSON is a machine format', { timeout: 30000 }, async () => {
  const url = await startHostileServer({ headers: { 'x-powered-by': `PHP${CSI8}[2J` } });
  const { code, stdout } = await run(['headers', url, '--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  // Rewriting bytes in a machine format would be the bigger lie: whoever renders
  // the JSON is the one that has to escape it. So the raw value is preserved.
  assert.equal(parsed.poweredBy, `PHP${CSI8}[2J`);
});

test('cli: a header value undici rejects is reported, never printed raw', { timeout: 30000 }, async () => {
  // The measured boundary: ESC, BEL and DEL in a header value make undici refuse
  // the response outright, so the classic escape-sequence vector is closed at the
  // parser. DeskUptime must still surface that as an error — not swallow it, and
  // not print anything the site dictated.
  for (const byte of [ESC, BEL, DEL]) {
    const url = await startHostileServer({ headers: { 'x-powered-by': `PHP${byte}[31mOWNED` } });
    const { code, stdout } = await run(['headers', url]);
    assertInert(stdout, `headers with ${byte.charCodeAt(0)}`);
    assert.equal(stdout.includes('OWNED'), false, 'content of a rejected response was printed');
    assert.match(stdout, /Error/);
    assert.equal(code, 2, 'a response we cannot parse is not a healthy one');
  }
});

test('watch: a DOWN line survives a site that tries to reflow the log', { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-display-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, USERPROFILE: home };
  const healthy = await startHostileServer({ headers: { 'x-powered-by': `PHP${FORGED}` } });
  const broken = await startHostileServer({ status: '500 Internal Server Error', body: 'boom' });

  // Baseline (healthy) first, then a failing pass, so watch has to report DOWN.
  await run(['watch', healthy, '--once'], { env });
  await run(['watch', broken, '--once'], { env });
  const { code, stdout } = await run(['watch', broken, '--once'], { env });

  assert.equal(code, 2, 'a DOWN pass must still exit 2');
  assertInert(stdout, 'watch --once');
  assert.match(stdout, /is DOWN/);
  // The DOWN verdict is the last line, so nothing could have pushed it away.
  const lines = stdout.trim().split('\n');
  assert.match(lines[lines.length - 1], /is DOWN/);
});

test('status: a hand-edited state file cannot repaint the URL list', { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-display-status-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({
    urls: { [`https://sneaky.example${NEL} UP`]: { wasUp: true, lastStatus: 200 } },
  }));

  const { stdout } = await run(['status'], { env: { HOME: home, USERPROFILE: home } });
  assertInert(stdout, 'status');
  // The NEL did not become a line break, so the URL and its verdict stay together.
  assert.match(stdout, /sneaky\.example UP \(200\)/);
  assert.equal(stdout.split('\n').filter(line => line.includes('sneaky.example')).length, 1);
});
