/**
 * P1-108 — the one owner of "which flags a command accepts".
 *
 * `--help` documents the flags a customer can pass. Every command in this CLI
 * that takes a flag has one usage line, and `headers` is the outlier: it accepts
 * `--json` and `--timeout`, both of which work, and neither appeared anywhere in
 * the USAGE block. Measured before the fix, with the real CLI and a local
 * server:
 *
 *   $ deskuptime headers http://127.0.0.1:60229/ --json
 *   { "finalUrl": …, "security": { "strict-transport-security": null, … } }   exit 0
 *   $ deskuptime headers http://127.0.0.1:60229/ --timeout 2000
 *   ⚠️  Error: Request timed out                                                  exit 2
 *   $ deskuptime --help | grep headers
 *   deskuptime headers <url>      Redirect chain, HTTPS enforcement + security headers
 *
 * A bureau that pipes `headers --json` into its own scanner — the exact job the
 * agency report is built for — had to find the flag by reading the source. The
 * command's own error line knew about it (`Usage: deskuptime headers <url>
 * [--json]`, `src/cli.js`), which is how a second owner of the same fact ended
 * up disagreeing with the first: it listed `--json` and not `--timeout`.
 *
 * The lock is behavioural rather than a hand-written list, because a list would
 * only ever prove it agreed with itself. Each entry below is *run*, and has to
 * come back without `Unknown option` and with the marker that shows the command
 * actually got past parsing — then `--help` has to name the same flag on that
 * command's usage line. A flag that stops working fails the first half; a flag
 * that works but is undocumented fails the second. Adding a flag to the code
 * without adding it to `--help` therefore fails here rather than in a support
 * question three weeks later.
 *
 * Every probe is offline and stops before any network call: an absent URL, the
 * Pro gate, or a port on the loopback interface that nothing listens on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

// Nothing listens here, so the request is refused in milliseconds. It is a real
// address, so `invalidHttpUrls` lets it past and the flags are parsed.
const DEAD = 'http://127.0.0.1:59999/';
const KEY = '0123456789abcdef0123456789abcdef';

/**
 * For each command: the flags it accepts, and for each one a probe plus the
 * marker that shows parsing finished and the command moved on. The probe has to
 * be a real invocation — the point is to ask the CLI, not a list.
 *
 * `usageProbe` is the invocation that makes the command print its own
 * `Usage: deskuptime …` line, which is the second place the same flags are
 * written down. `report` needs a stray argument: called with nothing it reaches
 * the Pro gate first, which is correct behaviour and prints no usage line.
 */
const COMMANDS = [
  {
    command: 'check',
    usageProbe: [],
    flags: [
      { flag: '--json', probe: ['--json'], reached: /at least one URL required/ },
      { flag: '--timeout', probe: ['--timeout', '5000'], reached: /at least one URL required/ },
    ],
  },
  {
    command: 'headers',
    usageProbe: [],
    flags: [
      { flag: '--json', probe: [DEAD, '--json'], reached: /"finalUrl"/ },
      { flag: '--timeout', probe: [DEAD, '--timeout', '5000'], reached: /Connection refused/ },
    ],
  },
  {
    command: 'watch',
    usageProbe: [],
    flags: [
      { flag: '--once', probe: ['--once'], reached: /at least one URL required/ },
      { flag: '--status', probe: ['--status'], reached: /No URLs monitored/ },
      { flag: '--interval', probe: ['--interval', '300'], reached: /at least one URL required/ },
      { flag: '--webhook', probe: ['--webhook', 'https://example.com/hook'], reached: /at least one URL required/ },
      { flag: '--activate', probe: ['--activate', KEY], reached: /at least one URL required/ },
    ],
  },
  {
    command: 'report',
    usageProbe: ['stray'],
    flags: [
      { flag: '--json', probe: ['--json'], reached: /needs an active Pro license/ },
      { flag: '--title', probe: ['--title', 'Acme'], reached: /needs an active Pro license/ },
      { flag: '--days', probe: ['--days', '7'], reached: /needs an active Pro license/ },
    ],
  },
];

/** The USAGE lines `--help` prints, keyed by the command they document. */
async function usageLines() {
  const { stdout } = await run(process.execPath, [CLI, '--help'], { env: { ...process.env } });
  const block = stdout.slice(stdout.indexOf('USAGE:'), stdout.indexOf('EXAMPLES:'));
  const byCommand = new Map();
  for (const line of block.split('\n')) {
    const match = line.match(/^\s+deskuptime ([a-z]+)\b/);
    if (!match) continue;
    // `watch` is documented on three lines; they all belong to one command.
    const existing = byCommand.get(match[1]) || '';
    byCommand.set(match[1], `${existing}\n${line}`);
  }
  return byCommand;
}

test('check, watch og report: --help navner hvert flag kommandoen accepterer', async () => {
  const usage = await usageLines();
  for (const { command, flags } of COMMANDS) {
    const line = usage.get(command);
    assert.ok(line, `--help har ingen USAGE-linje for \`${command}\``);
    for (const { flag } of flags) {
      assert.ok(line.includes(flag),
        `--help's \`${command}\`-linje nævner ikke ${flag}, som kommandoen accepterer:\n${line.trim()}`);
    }
  }
});

test('hvert flag virker stadig: kommandoen afviser det ikke som ukendt', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-helpflags-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  for (const { command, flags } of COMMANDS) {
    for (const { flag, probe, reached } of flags) {
      const result = await run(process.execPath, [CLI, command, ...probe], { env }).catch(error => error);
      const output = `${result.stdout || ''}${result.stderr || ''}`;
      assert.ok(!/Unknown option/.test(output),
        `\`${command} ${flag}\` afvises som ukendt flag:\n${output.trim()}`);
      assert.match(output, reached,
        `\`${command} ${flag}\` nåede ikke forbi flag-parsingen:\n${output.trim()}`);
    }
  }
});

test('kommandoens egen usage-linje og --help siger det samme om dens flag', async (t) => {
  // The second owner. `headers` said `[--json]` on its error line while
  // `--help` said nothing at all — so both have to be checked against the same
  // list. Every command here prints a `Usage: deskuptime …` line when it is
  // called with no work to do; the flag names in it are compared with the ones
  // `--help` shows for the same command.
  const home = mkdtempSync(join(tmpdir(), 'deskuptime-helpflags-usage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  const usage = await usageLines();
  for (const { command, usageProbe } of COMMANDS) {
    const result = await run(process.execPath, [CLI, command, ...usageProbe], { env }).catch(error => error);
    const errorLine = `${result.stderr || ''}`.split('\n').find(l => l.startsWith('Usage: deskuptime '));
    assert.ok(errorLine, `\`${command}\` printer ingen egen usage-linje, så den kan ikke sammenlignes`);
    for (const mentioned of errorLine.match(/--[a-z-]+/g) || []) {
      assert.ok(usage.get(command).includes(mentioned),
        `\`${command}\`'s egen usage-linje nævner ${mentioned}, som --help's linje ikke gør:\n` +
        `${errorLine}\n${usage.get(command).trim()}`);
    }
  }
});
