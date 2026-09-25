/**
 * Content change detector
 * Fetches page content and generates a hash for comparison.
 * Used to detect if a website's content has changed since last check.
 *
 * The body read is bounded twice, because both bounds can be hit by a site the
 * user simply wants to watch:
 *
 * - `MAX_CONTENT_BYTES` stops a large or endless body from being buffered in
 *   memory. The watch loop reads every URL on every pass, so one page serving a
 *   multi-gigabyte file would take the whole CLI down with it. Past the cap we
 *   report no content signal instead — the site is not called DOWN, because a
 *   big page is not an outage.
 * - The abort stays armed until the body has been read. A server that sends
 *   headers and then stalls would otherwise have no deadline at all, and one
 *   such site hangs the watch loop forever.
 */

import crypto from 'crypto';

/** Enough for any real page's markup and <title>; far below a memory hazard. */
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

const CONTENT_TIMEOUT_MS = 20_000;

/** Best-effort charset, so the hash matches what `response.text()` would decode. */
function charsetOf(response) {
  const declared = /charset=["']?([\w-]+)/i.exec(response.headers.get('content-type') ?? '');
  if (!declared) return 'utf-8';
  try {
    new TextDecoder(declared[1]);
    return declared[1];
  } catch {
    return 'utf-8';
  }
}

/**
 * Read at most `limit` bytes. Returns `truncated: true` — without a text — when
 * the body is larger, so the caller never hashes a partial page.
 */
async function readCapped(response, limit) {
  if (!response.body) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        return { text: null, bytes, truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder(charsetOf(response)).decode(Buffer.concat(chunks)), bytes, truncated: false };
}

export async function checkContentChange(url, previousHash, { maxBytes = MAX_CONTENT_BYTES, timeoutMs = CONTENT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      return {
        fetched: false,
        error: `HTTP ${response.status}`,
        statusCode: response.status,
      };
    }

    // A server that declares an oversized body is telling us up front — skip the
    // read rather than streaming a gigabyte to throw it away.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return { fetched: false, tooLarge: true, contentLength: declared, error: `Page is ${declared} bytes — over the ${maxBytes}-byte content-check limit, so no content signal this check` };
    }

    const { text, bytes, truncated } = await readCapped(response, maxBytes);
    if (truncated) {
      return { fetched: false, tooLarge: true, contentLength: bytes, error: `Page is over the ${maxBytes}-byte content-check limit, so no content signal this check` };
    }

    const currentHash = crypto.createHash('sha256').update(text).digest('hex');
    // Real bytes on the wire, not UTF-16 code units: this number is printed as
    // "bytes" in the CLI and in the content-changed event.
    const contentLength = bytes;

    const changed = previousHash ? currentHash !== previousHash : null;

    const result = {
      fetched: true,
      contentLength,
      hash: currentHash,
      changed,
      previousHash: previousHash || null,
      title: extractTitle(text),
    };

    if (previousHash && changed) {
      result.changeType = 'content_updated';
      result.note = 'Content differs from last check — hash mismatch';
    } else if (previousHash && !changed) {
      result.changeType = 'unchanged';
    }

    return result;
  } catch (err) {
    return {
      fetched: false,
      error: err.name === 'AbortError' ? `Page did not send its body within ${timeoutMs}ms` : err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}
