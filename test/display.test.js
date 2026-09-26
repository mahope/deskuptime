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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatMs, machinesInUse, markdownCell, safeText } from '../src/display.js';

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

/**
 * formatMs — a duration we may not have.
 *
 * `checkUrl` initialises `responseTimeMs` to `null` and only fills it in on a
 * real response, so a check that threw before it measured has no duration.
 * Interpolated straight into a line it printed the absence of one:
 *
 *   `Response: nullms`       `check`, for a site that could not be reached
 *   `is UP (200) — nullms`   the `up` event: the desktop notification and the
 *                            customer's Pro webhook
 *   `responseTime: "nullms"` `summarize()`, the object every surface reads
 *
 * `—` is what every other unknown number in DeskUptime already prints.
 */
test('formatMs prints a measured duration and admits when there is none', () => {
  assert.equal(formatMs(0), '0ms', 'a measured zero is a measurement');
  assert.equal(formatMs(42), '42ms');
  assert.equal(formatMs(1234), '1234ms');
  // The four values a real check or a hand-edited state file can hold.
  assert.equal(formatMs(null), '—', 'a check that never measured has no duration');
  assert.equal(formatMs(undefined), '—');
  assert.equal(formatMs(NaN), '—');
  assert.equal(formatMs('42'), '—', 'a string is not a measurement, it is state-file text');
  // A negative is a corrupt value, not a fast response — the same rule
  // readSslState() applies to a negative certificate day count.
  assert.equal(formatMs(-5), '—');
  assert.equal(formatMs(-0), '0ms');
});

test('no DeskUptime surface can print a response time it does not have', () => {
  // Source-level, because the four call sites are the risk: a new one added
  // later must use formatMs rather than interpolate the raw value.
  for (const file of ['src/cli.js', 'src/engine.js', 'src/watch.js']) {
    const text = readFileSync(join(ROOT, file), 'utf-8');
    const interpolations = text.match(/\$\{[^}]*responseTimeMs[^}]*\}ms/g) || [];
    assert.deepEqual(interpolations, [], `${file} interpolates a raw responseTimeMs: ${interpolations.join(', ')}`);
  }
});

// ── P1-9 punkt 9: step-summary-tabellen var den eneste uhærdede menneske-flade ──
// Målt før rettelsen: en URL med ét `|` og ét linjeskift fyldte to rækker i
// $GITHUB_STEP_SUMMARY, hvoraf den anden lignede en målt række:
//   | https://evil.test/a|<script>x</script>|
//   | forged-row | https://b.test | DOWN | 500 | | ✅ UP | 200 | 12ms | 90 |
// Rækken er stykket af URL'en alene, så en rapport der siger "alt grønt" kan
// vise en DOWN-række for et site der aldrig blev tjekket.

test('markdownCell: a value cannot become a second table row', () => {
  const hostile = 'https://evil.test/a|<script>x</script>|\n| forged-row | https://b.test | DOWN | 500 |';
  const cell = markdownCell(hostile);

  assert.doesNotMatch(cell, /[\r\n]/, 'a cell must stay on one line, or it becomes its own row');
  assert.doesNotMatch(cell, /<script>/, 'markup from the site must not survive as markup');
  assert.match(cell, /\\\|/, 'a pipe must be escaped or the cell splits the row');
  // The forged row is still *visible* as text — it is just text now, inside
  // one cell of one row, instead of a second row a reader would believe.
  assert.match(cell, /forged-row/);
});

test('markdownCell: the escaped row still parses as one cell of five', () => {
  // How a Markdown reader splits a row: on unescaped pipes.
  const cellsOf = (row) => row.replace(/\\\|/g, '\u0000').split('|').map(c => c.trim());

  const row = `| ${markdownCell('https://a.test/x|extra')} | ✅ UP | 200 | 12ms | 63 |`;
  assert.equal(cellsOf(row).length, 7, `row did not hold its shape: ${row}`);

  const header = '| URL | Status | HTTP | Response | SSL days |';
  assert.equal(cellsOf(header).length, cellsOf(row).length, 'row and header must have the same width');
});

test('markdownCell: entities are encoded once, and control bytes never survive', () => {
  assert.equal(markdownCell('https://a.test/?a=1&b=2'), 'https://a.test/?a=1&amp;b=2');
  // A URL that literally contains "&lt;" must not decode into "<".
  assert.equal(markdownCell('&lt;x&gt;'), '&amp;lt;x&amp;gt;');
  assert.equal(markdownCell(null), '—', 'an absent value prints like every other absent number');
  assert.equal(markdownCell(undefined), '—');

  const esc = String.fromCharCode(0x1b);
  assert.equal(markdownCell(`a${esc}[2Jb`), 'ab', 'a clear-screen must not reach the summary file');
  assert.equal(markdownCell('a\u202Eb'), 'ab', 'a bidi override must not reorder the cell');
  assert.equal(markdownCell('a\u0000\u0007b'), 'a b', 'control bytes become a space, not a gap');
});

test('markdownCell: an ordinary URL is untouched, so no report churns its tables', () => {
  const url = 'https://mahope.dk/da/';
  assert.equal(markdownCell(url), url);
  assert.equal(markdownCell('✅ UP'), '✅ UP');
  assert.equal(markdownCell(200), '200');
  assert.equal(markdownCell('—'), '—');
});

// ── P1-9 punkt 8: devices_in_use var utyperet på den sti, der gemmer en nøgle ──
// Målt før rettelsen, gennem licens.js:228 (`?? null`) og cli.js:271:
//   "7" -> (7 of 3 machines in use)      {seats:7} -> ([object Object] of 3 …)
//   true -> (true of 3 …)                 -1 -> (-1 of 3 …)
//   1.5 -> (1.5 of 3 …)                   [] -> ( of 3 …)

test('machinesInUse: only a count of machines is a count of machines', () => {
  assert.equal(machinesInUse(1), '1');
  assert.equal(machinesInUse(3), '3');
  assert.equal(machinesInUse(0), '0');

  // Everything a malformed, rolled-back or hostile license response can hold.
  assert.equal(machinesInUse('2'), '—', 'a string is response text, not a number of machines');
  assert.equal(machinesInUse(1.5), '—', 'a half machine is not a seat count');
  assert.equal(machinesInUse(-1), '—', 'a negative count is corrupt, not "one seat freed"');
  assert.equal(machinesInUse(NaN), '—');
  assert.equal(machinesInUse(Infinity), '—');
  assert.equal(machinesInUse(true), '—');
  assert.equal(machinesInUse({ seats: 7 }), '—', 'an object must not print as [object Object]');
  assert.equal(machinesInUse([2]), '—', 'an array must not print as an empty or joined string');
  assert.equal(machinesInUse(null), '—');
  assert.equal(machinesInUse(undefined), '—');
});

test('the activate line reads the machine count from features.js, not a literal', () => {
  // PRODUCT.machines is the owner used by --help, the matrix and the npm
  // description. A hardcoded 3 here is a fourth claim that can drift.
  const text = readFileSync(join(ROOT, 'src/cli.js'), 'utf-8');
  assert.doesNotMatch(text, /of 3 machines in use/, 'cli.js hardcodes the machine total');
  assert.match(text, /machinesInUse\(res\.meta\.devicesInUse\)/, 'the typed helper is not used');
  assert.match(text, /\$\{PRODUCT\.machines\} machines in use/, 'PRODUCT.machines is not the source');
});
