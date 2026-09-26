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
