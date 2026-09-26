/**
 * A stub license API for the seat tests, preloaded into the real CLI with
 * `node --import`. The CLI must be the real one — the harm this file exists for
 * is in what the terminal says after `deactivate` — but the license server must
 * not be: these tests never write to mahope.tools.
 *
 * Scenario: DUB_STUB_SCENARIO=ok           activate 200 (3 of 3 in use), deactivate 200 (2 of 3 left)
 *           DUB_STUB_SCENARIO=limit        activate 409 (device limit reached)
 *           DUB_STUB_SCENARIO=trap         any call exits 9, so read-only surfaces can be proven offline
 *           DUB_STUB_SCENARIO=passthrough  the three license endpoints are stubbed, every
 *                                          other request is the real fetch
 *
 * `passthrough` exists because this file used to *replace* `globalThis.fetch`
 * wholesale and answered 500 to anything that was not a license endpoint. That
 * is correct for a command which makes no requests of its own, and wrong for
 * every command that does: two iterations in a row (P1-34, P1-35) measured
 * `watch` and `report` with this fixture, got `is DOWN — HTTP 500` and
 * `Webhook responded 500` on healthy fixtures, and briefly concluded the
 * monitoring path was broken. A measurement harness that cannot tell a stubbed
 * endpoint from a real one reports the stub, not the code. Anything not listed
 * here is now passed through untouched.
 */

const SCENARIO = process.env.DUB_STUB_SCENARIO || 'ok';
const realFetch = globalThis.fetch;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url, ...rest) => {
  const endpoint = String(url);
  if (SCENARIO === 'trap') {
    process.stderr.write(`STUB TRAP: unexpected license call to ${endpoint}\n`);
    process.exit(9);
  }
  if (endpoint.endsWith('/activate')) {
    if (SCENARIO === 'limit') return json(409, { ok: false, error: 'Device limit reached' });
    return json(200, { ok: true, activated: true, plan: 'pro', expires_at: '2027-09-26T00:00:00.000Z', devices_in_use: 3 });
  }
  if (endpoint.endsWith('/validate')) {
    return json(200, { ok: true, valid: true, plan: 'pro', expires_at: '2027-09-26T00:00:00.000Z' });
  }
  if (endpoint.endsWith('/deactivate')) {
    return json(200, { ok: true, deactivated: true, devices_in_use: 2 });
  }
  if (SCENARIO === 'passthrough') return realFetch(url, ...rest);
  return json(500, { ok: false, error: `unexpected endpoint ${endpoint}` });
};
