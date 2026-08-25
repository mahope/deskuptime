/**
 * HTTP/HTTPS reachability checker
 * Uses native fetch (Node 18+) — no external dependencies.
 */

export async function checkReachability(url) {
  const start = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)',
      },
    });

    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    return {
      reachable: true,
      statusCode: response.status,
      statusText: response.statusText,
      responseTimeMs: elapsed,
      finalUrl: response.url,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (err) {
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    // Fallback: try GET if HEAD fails (some servers reject HEAD)
    if (err.name === 'AbortError' || err.message?.includes('HEAD')) {
      try {
        const getController = new AbortController();
        const getTimeout = setTimeout(() => getController.abort(), 15000);

        const getResponse = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: getController.signal,
          headers: {
            'User-Agent': 'Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)',
          },
        });

        clearTimeout(getTimeout);
        const getElapsed = Date.now() - start;

        return {
          reachable: true,
          statusCode: getResponse.status,
          statusText: getResponse.statusText,
          responseTimeMs: getElapsed,
          finalUrl: getResponse.url,
          headers: Object.fromEntries(getResponse.headers.entries()),
          note: 'HEAD failed, used GET fallback',
        };
      } catch (getErr) {
        return {
          reachable: false,
          responseTimeMs: elapsed,
          error: getErr.message,
        };
      }
    }

    return {
      reachable: false,
      responseTimeMs: elapsed,
      error: err.message,
    };
  }
}