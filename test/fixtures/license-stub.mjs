/**
 * A stub license API for the seat tests, preloaded into the real CLI with
 * `node --import`. The CLI must be the real one — the harm this file exists for
 * is in what the terminal says after `deactivate` — but the license server must
 * not be: these tests never write to mahope.tools.
 *
 * Scenario: DUB_STUB_SCENARIO=ok      activate 200 (3 of 3 in use), deactivate 200 (2 of 3 left)
 *           DUB_STUB_SCENARIO=limit   activate 409 (device limit reached)
 *           DUB_STUB_SCENARIO=trap    any call exits 9, so read-only surfaces can be proven offline
 */

const SCENARIO = process.env.DUB_STUB_SCENARIO || 'ok';

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (url) => {
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
  return json(500, { ok: false, error: `unexpected endpoint ${endpoint}` });
};
