/**
 * Content change detector
 * Fetches page content and generates a hash for comparison.
 * Used to detect if a website's content has changed since last check.
 */

import crypto from 'crypto';

export async function checkContentChange(url, previousHash) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

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

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        fetched: false,
        error: `HTTP ${response.status}`,
        statusCode: response.status,
      };
    }

    const html = await response.text();
    const currentHash = crypto.createHash('sha256').update(html).digest('hex');
    const contentLength = html.length;

    const changed = previousHash ? currentHash !== previousHash : null;

    const result = {
      fetched: true,
      contentLength,
      hash: currentHash,
      changed,
      previousHash: previousHash || null,
      title: extractTitle(html),
    };

    if (previousHash && changed) {
      result.changeType = 'content_updated';
      result.note = 'Content differs from last check — hash mismatch';
    } else if (previousHash && !changed) {
      result.changeType = 'unchanged';
    }

    return result;
  } catch (err) {
    clearTimeout(timeout);
    return {
      fetched: false,
      error: err.message,
    };
  }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}