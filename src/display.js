/**
 * display.js — make text that a monitored site can choose safe to show a human.
 *
 * Why this exists: most of what DeskUptime prints is not ours. `X-Powered-By`,
 * a Content-Security-Policy, a redirect target, a page title, a TLS error string
 * — every one of those is chosen by the very site we are monitoring. An HTTP
 * header value may legally contain ESC (0x1B), and one escape sequence can clear
 * the screen, move the cursor up over the lines above, set the window title, or
 * paint green text where a warning should be. A hostile or hijacked site could
 * therefore make `deskuptime headers` print a clean sheet for itself, and
 * `watch` could scroll a DOWN line off the top of the terminal between passes.
 *
 * A monitor that can be made to print something other than what it measured is
 * worse than no monitor: the whole product is the claim that the output is true.
 * So there is exactly one function for it, called at every print site, and it is
 * covered by test/display.test.js against a server that sends escape sequences.
 *
 * Deliberately NOT applied to `--json` output: that is a machine format, where
 * dropping or rewriting bytes is a worse lie than a terminal that needs a reset.
 * A caller that renders the JSON is the one that has to escape it.
 *
 * The same rule — a terminal must never print a measurement we do not have —
 * is why `formatMs` lives here too. It is the one answer to "we have no
 * duration", so the four places that print a response time cannot each invent
 * their own. `--json` keeps the raw `responseTimeMs`, deliberately, for the
 * same reason as above: `null` is honest in a machine format, `nullms` is not
 * in a human one.
 *
 * `markdownCell` and `machinesInUse` are the same idea for two surfaces that
 * are not a terminal. A Markdown table cell is a place a value can stop being
 * one cell: a single `|` splits the row and a newline ends it, so a URL can
 * write the *next* row — including one that claims a site is DOWN. And a
 * license response is a number we did not measure on this machine, so it is
 * held to the same bar as a response time: a value that is not a count is
 * printed as absent, not as text.
 */

/**
 * Consume a whole escape sequence rather than only its ESC byte, so the visible
 * residue (`[2J`, `]0;title`) does not end up in the output as garbage.
 * Covers CSI (`ESC [ … final`), OSC/DCS (`ESC ] … BEL|ST`), and the short
 * two-byte escapes; the remaining control characters are swept below.
 */
const ESCAPE_SEQUENCE = /\u001B\[[0-9;?<>=]*[ -\/]*[@-~]|\u001B[\]P^_][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B[@-Z\\-_]/g;

/**
 * Zero-width and bidirectional-override characters. They render as nothing (or
 * as "reversed text") while still being in the string, so they can hide or
 * reorder what a reader believes they are looking at — the same trick used to
 * spoof a file name. Also U+2028/U+2029, which some terminals treat as a newline.
 */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * The 8-bit form of the same thing (U+009B instead of ESC `[`), which undici
 * lets through in a header value where it decodes bytes as latin1 — so unlike
 * ESC this one really can reach us. Stripped before CONTROL, so the parameter
 * bytes and the final byte go with it instead of being left as `[2J`.
 */
const CSI_8BIT = new RegExp(String.fromCharCode(0x9b) + '[0-9;?<>=]*[ -/]*[@-~]', 'g');

/** C0 controls, DEL, and the C1 range. Squeezed to one space so runs do not gap. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]+/g;

export const DEFAULT_MAX_LENGTH = 60;

/**
 * Flatten one untrusted value to a single line of inert text.
 *
 * @param {unknown} value — anything; non-strings are stringified, nullish becomes `fallback`
 * @param {object} [options]
 * @param {number} [options.max=60] — hard cap in characters, `0` disables it
 * @param {string} [options.fallback=''] — used when the value is nullish
 * @returns {string} safe to interpolate into a line printed to a terminal or file
 */
export function safeText(value, { max = DEFAULT_MAX_LENGTH, fallback = '' } = {}) {
  if (value === null || value === undefined) return fallback;
  const text = String(value)
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CSI_8BIT, '')
    .replace(CONTROL, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max > 0 && text.length > max) return `${text.slice(0, Math.max(0, max - 3))}...`;
  return text;
}

/**
 * Print a duration we may not have.
 *
 * A check that got no response at all leaves `responseTimeMs` as `null` —
 * `checkUrl` initialises it to `null` and `checkers/ping.js` only fills it in
 * from a real response — and a hand-edited or restored state file can hold a
 * negative one. Interpolated straight into a line, both printed the value
 * instead of the absence of one:
 *
 *   Response: nullms            — `check`, for a site that could not be reached
 *   is UP (200) — nullms        — the `up` event, i.e. the desktop notification
 *                                  and the customer's Pro webhook
 *   responseTime: "nullms"      — `summarize()`, the object every surface reads
 *
 * So an unreachable site told the paying customer it answered in "null"
 * milliseconds. `—` is what every other unknown number in DeskUptime prints
 * (`— SSL:`, `— Response:`, `— (no completed pass)`), and it is what the report
 * already used for a missing response time.
 *
 * Only a finite, non-negative number is a duration. A negative is a corrupt
 * value, not a fast response — the same rule `readSslState()` applies to a
 * negative certificate day count.
 *
 * @param {unknown} value — the measured milliseconds, possibly absent
 * @returns {string} `'123ms'`, or `'—'` when there is no duration to report
 */
export function formatMs(value) {
  return Number.isFinite(value) && value >= 0 ? `${value}ms` : '—';
}

/**
 * Make one value safe to interpolate into a single Markdown table cell.
 *
 * Every DeskUptime table is a human surface that renders a URL the monitored
 * site did not choose but the *user* did, and a Markdown table is not a
 * neutral container:
 *
 *   | https://a.test/x|forged | https://b.test | DOWN | 500 | | 200 | 12ms | 63 |
 *
 * One pipe turns one cell into two, so the rest of the hostile value becomes a
 * row of its own — and a newline ends the row early, so the tail lands on the
 * next line where it reads as a measured result. That is how a step summary
 * came to claim a site was DOWN when every real check was UP. Angle brackets
 * and `&` are encoded so markup stays text, and the same control bytes
 * `safeText` sweeps are swept here, because a step summary is a file someone
 * reads and can be rendered as HTML by a job summary viewer.
 *
 * This is the one implementation. The client report and the GitHub Action step
 * summary are the same table in two places, and a second copy of these rules
 * is a second thing to forget — see the P1-9 audit note on two surfaces owning
 * the same fact.
 *
 * @param {unknown} value — anything; nullish becomes `—`
 * @returns {string} safe to place between two `|` in a Markdown table row
 */
export function markdownCell(value) {
  return safeText(value, { max: 0, fallback: '—' })
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
}

/**
 * How many of a license's machines are in use — or `—` when the license server
 * did not say a number.
 *
 * This is printed on the line that stores the license key, and it comes from a
 * response this machine did not produce. Interpolated raw, every value that is
 * not a plain integer printed itself:
 *
 *   ✅ Pro activated (7 of 3 machines in use)         — a string "7"
 *   ✅ Pro activated ([object Object] of 3 machines…)  — an object
 *   ✅ Pro activated ( of 3 machines in use)           — an empty array
 *
 * A customer who reads that has no way to tell a real seat count from a
 * mangled one, and the next sensible thing to do is buy a second license. So
 * only a non-negative safe integer is a count of machines; everything else is
 * absent, and absent prints as `—` like every other number we do not have.
 *
 * @param {unknown} value — the server's `devices_in_use`
 * @returns {string} the count, or `—`
 */
export function machinesInUse(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
}
