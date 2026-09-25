/**
 * DeskUptime — Pro license activation and validation
 *
 * Talks to the Mahope license server (https://mahope.tools/api/license/*).
 * Licenses are bought via Stripe: https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01
 * No secrets are needed client-side — the endpoints are public and keyed by
 * the license key + a stable device id.
 *
 * Network errors and 5xx answers are treated as transient: a previously
 * validated Pro status is kept for OFFLINE_GRACE_MS so a server outage never
 * locks paying customers out.
 */

import { hostname } from 'os';
import { PRODUCT } from './features.js';

// Product key, purchase link and API base are version-controlled in
// src/features.js, so no customer surface can quote a different product.
export const LICENSE_API_BASE = PRODUCT.licenseApiBase;
export const PRODUCT_KEY = PRODUCT.key;
export const BUY_URL = PRODUCT.buyUrl;
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard total budget for one license call. A hanging server must not hang the CLI. */
export const LICENSE_TIMEOUT_MS = 10_000;

/**
 * The five states `deskuptime status` can report. Mirrored in
 * docs/license-lifecycle.md.
 *
 * UNVERIFIED is the honest word for a key the server never got to judge: the
 * license server was unreachable for longer than the grace period. Calling that
 * `invalid` (as this CLI did) reads as "your key was rejected", and a customer
 * who believes that buys a second license.
 */
export const LICENSE_STATUS = {
  ACTIVE: 'active',
  CACHED: 'cached',
  UNVERIFIED: 'unverified',
  INVALID: 'invalid',
  FREE: 'free',
};

/** The states that entitle the machine to Pro. Everything else is free tier. */
export const PRO_STATUSES = [LICENSE_STATUS.ACTIVE, LICENSE_STATUS.CACHED];

const KEY_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Answers that carry no verdict. Paying customers keep cached Pro for
 * OFFLINE_GRACE_MS, so back-pressure and server faults are never a verdict.
 */
const TRANSIENT_HTTP = new Set([408, 425, 429]);

const STATUS_MESSAGES = {
  400: 'Invalid license key format',
  403: 'License key is expired, revoked or for another product',
  404: 'Unknown license key',
  409: 'Device limit reached — deactivate another machine first',
  408: 'License server timed out — try again later',
  429: 'License server is rate limiting requests — try again later',
  503: 'License server temporarily unavailable — try again later',
};

/** Trim + lowercase, as the license server expects. */
export function normalizeKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

/**
 * Strip secrets from anything that can reach a terminal or a log file.
 * Server errors and fetch messages can echo the submitted key or the machine
 * name, so every error string we return passes through here.
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/[a-f0-9]{32}/gi, '«key»')
    .replace(/deskuptime-[a-z0-9._-]+/gi, 'deskuptime-«device»');
}

/**
 * Stable per-machine id. Same scheme as the desktop app, so the CLI and the
 * desktop app on one machine share a single activation seat.
 *
 * On native Windows we must prefer COMPUTERNAME. `os.hostname()` returns the
 * NetBIOS name there, which Windows truncates to 15 characters, so a machine
 * called `WORKSTATION-NORD-01` would get `deskuptime-workstatio-nord-01` from
 * the CLI while the desktop app — which reads COMPUTERNAME — sends
 * `deskuptime-workstation-nord-01`. Two ids, one machine, two of three seats.
 *
 * Arguments are injectable so the scheme can be pinned by a golden fixture
 * (test/fixtures/device-id.golden.json) that the desktop repo can also run.
 */
export function getDeviceId({ platform = process.platform, env = process.env, host = hostname() } = {}) {
  const fromEnv = String(env?.COMPUTERNAME ?? '').trim();
  const name = platform === 'win32' && fromEnv ? fromEnv : host;
  return `deskuptime-${String(name ?? '').trim().toLowerCase() || 'unknown'}`.slice(0, 128);
}

/**
 * One license API call, always bounded in time.
 *
 * A 200 whose body is not a JSON object with `ok: true` is NOT a verdict: a
 * captive portal, a Cloudflare HTML page or a truncated proxy answer must not
 * read as "revoked", because that would switch Pro off for a paying customer.
 * Those answers come back as `malformed: true` and are treated as transient.
 *
 * @returns {Promise<{status:number, data:object, transient:boolean, malformed:boolean, error:?string}>}
 */
async function post(endpoint, body, { timeoutMs = LICENSE_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(`${LICENSE_API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 0,
      data: {},
      transient: true,
      malformed: false,
      error: timedOut
        ? `License server did not answer within ${timeoutMs}ms`
        : `Network error: ${redactSecrets(err?.message ?? err)}`,
    };
  }

  let data = {};
  let parsed = false;
  try {
    const body = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      data = body;
      parsed = true;
    }
  } catch { /* non-JSON body (HTML error page, empty reply, …) */ }

  const transient = TRANSIENT_HTTP.has(response.status) || response.status >= 500;
  const malformed = response.ok && !(parsed && data.ok === true);
  const error = response.ok
    ? null
    : (data.error || data.message || STATUS_MESSAGES[response.status] || `License server error (HTTP ${response.status})`);

  return { status: response.status, data, transient, malformed, error };
}

const MALFORMED_ERROR = 'Unreadable answer from the license server — nothing was changed. Try again.';

/**
 * Activate a license key for this machine.
 * @param {string} licenseKey - key from the purchase email
 * @param {string} [deviceId] - defaults to getDeviceId()
 * @returns {Promise<object>} { valid, activated, key, deviceId, meta?, error?, status?, transient? }
 */
export async function activateLicense(licenseKey, deviceId = getDeviceId(), { timeoutMs } = {}) {
  const key = normalizeKey(licenseKey);
  if (!KEY_PATTERN.test(key)) {
    return { valid: false, activated: false, transient: false, error: 'Invalid license key format (expected 32 hex characters)' };
  }
  const r = await post('activate', { license_key: key, device_id: deviceId, product: PRODUCT_KEY }, { timeoutMs });
  if (r.status === 200 && r.data.ok === true && r.data.activated === true) {
    return {
      valid: true,
      activated: true,
      key,
      deviceId,
      meta: {
        plan: r.data.plan ?? null,
        expiresAt: r.data.expires_at ?? null,
        devicesInUse: r.data.devices_in_use ?? null,
      },
    };
  }
  // A 200 that is not an explicit `activated: true|false` carries no verdict.
  if (r.malformed || (r.status === 200 && typeof r.data.activated !== 'boolean')) {
    return { valid: false, activated: false, status: r.status, transient: true, error: MALFORMED_ERROR };
  }
  return {
    valid: false,
    activated: false,
    status: r.status,
    transient: r.transient,
    error: redactSecrets(r.error || 'License activation failed'),
  };
}

/**
 * Check whether a license key is still valid for this machine.
 * @returns {Promise<object>} { valid, transient, plan?, expiresAt?, error? }
 *   transient === true means "could not reach a verdict" (network error /
 *   timeout / 408 / 429 / 5xx / unreadable 200).
 */
export async function validateLicense(licenseKey, deviceId = getDeviceId(), { timeoutMs } = {}) {
  const key = normalizeKey(licenseKey);
  if (!KEY_PATTERN.test(key)) {
    return { valid: false, transient: false, error: 'Invalid license key format' };
  }
  const r = await post('validate', { license_key: key, device_id: deviceId, product: PRODUCT_KEY }, { timeoutMs });
  // `valid` is the whole point of the call. An answer without it is no verdict,
  // not a silent revocation.
  const verdict = r.status === 200 && r.data.ok === true && typeof r.data.valid === 'boolean';
  if (verdict) {
    return {
      valid: r.data.valid === true,
      transient: false,
      plan: r.data.plan ?? null,
      expiresAt: r.data.expires_at ?? null,
      error: r.data.valid === true ? null : redactSecrets(r.data.reason || 'License is no longer valid'),
    };
  }
  if (r.malformed || r.status === 200) {
    return { valid: false, transient: true, error: MALFORMED_ERROR };
  }
  return { valid: false, transient: r.transient, error: redactSecrets(r.error || 'License validation failed') };
}

/**
 * Free this machine's activation seat. The caller must only drop local state
 * when `deactivated === true` — a seat that is not released server-side is
 * still occupied.
 */
export async function deactivateLicense(licenseKey, deviceId = getDeviceId(), { timeoutMs } = {}) {
  const key = normalizeKey(licenseKey);
  if (!KEY_PATTERN.test(key)) {
    return { deactivated: false, error: 'Stored license key is malformed — nothing was sent to the server' };
  }
  const r = await post('deactivate', { license_key: key, device_id: deviceId }, { timeoutMs });
  if (r.status === 200 && r.data.ok === true) {
    return { deactivated: r.data.deactivated === true, devicesInUse: r.data.devices_in_use ?? null, error: null };
  }
  if (r.malformed) {
    return { deactivated: false, error: MALFORMED_ERROR };
  }
  return { deactivated: false, transient: r.transient, error: redactSecrets(r.error || 'License deactivation failed') };
}

/**
 * Re-validate a stored license ({ key, instance, status, validatedAt }) and
 * decide Pro status.
 *
 * - valid answer        → pro, status 'active', validatedAt bumped
 * - no verdict (timeout / 408 / 429 / 5xx / unreadable 200) → pro only while
 *   the last successful validation is younger than OFFLINE_GRACE_MS, status
 *   'cached'; past that pro is off and the status is 'unverified' — the key was
 *   never judged, so it is not called invalid
 * - definitive invalid (400/403/404/409 or `valid: false`) → pro off at once,
 *   status 'invalid'
 *
 * The stored key is never discarded, so a later successful check restores Pro
 * and support can still tell which key a customer is on.
 *
 * @returns {Promise<{ pro: boolean, license: object, reason: string|null, status: string }>}
 */
export async function refreshLicense(license, { now = Date.now() } = {}) {
  if (!license?.key) return { pro: false, license, reason: 'No license key', status: LICENSE_STATUS.FREE };
  const res = await validateLicense(license.key, license.instance || getDeviceId());
  if (res.valid) {
    return {
      pro: true,
      license: { ...license, status: LICENSE_STATUS.ACTIVE, validatedAt: new Date(now).toISOString() },
      reason: null,
      status: LICENSE_STATUS.ACTIVE,
    };
  }
  if (res.transient) {
    const last = Date.parse(license.validatedAt ?? '');
    const withinGrace = Number.isFinite(last) && now - last < OFFLINE_GRACE_MS;
    if (withinGrace) {
      // Keep the key and the last good timestamp, so a later success — or a
      // restart before the grace runs out — keeps the customer on Pro.
      return { pro: true, license: { ...license, status: LICENSE_STATUS.CACHED }, reason: res.error, status: LICENSE_STATUS.CACHED };
    }
    return { pro: false, license: { ...license, status: LICENSE_STATUS.UNVERIFIED }, reason: res.error, status: LICENSE_STATUS.UNVERIFIED };
  }
  return { pro: false, license: { ...license, status: LICENSE_STATUS.INVALID }, reason: res.error, status: LICENSE_STATUS.INVALID };
}

/**
 * Validate a license object read from disk. Anything that is not a well-formed
 * license record is treated as "no license": a corrupt state file must not
 * hand out Pro, and must not crash the CLI either.
 */
export function normalizeLicense(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = normalizeKey(value.key);
  if (!KEY_PATTERN.test(key)) return null;
  const instance = String(value.instance ?? '').trim();
  if (!instance || instance.length > 128) return null;
  const validatedAt = typeof value.validatedAt === 'string' && Number.isFinite(Date.parse(value.validatedAt))
    ? new Date(value.validatedAt).toISOString()
    : null;
  const status = Object.values(LICENSE_STATUS).includes(value.status) ? value.status : null;
  return {
    key,
    instance,
    ...(status ? { status } : {}),
    ...(validatedAt ? { validatedAt } : {}),
    ...(typeof value.plan === 'string' ? { plan: value.plan } : {}),
  };
}

/**
 * The state `deskuptime status` reports, derived from stored data only —
 * status makes no network call, so it can never lock the CLI up.
 *
 * A state written before this field existed (no `status`) is classified by its
 * age exactly like refreshLicense would classify it: within the grace window
 * it is 'active', past it 'unverified'.
 */
export function describeLicense(license, { now = Date.now() } = {}) {
  const stored = normalizeLicense(license);
  if (!stored) {
    return { status: LICENSE_STATUS.FREE, detail: null, validatedAt: null };
  }
  const validatedAt = stored.validatedAt ?? null;
  const verifiedOn = validatedAt ? validatedAt.slice(0, 10) : null;
  const expired = !withinGrace(stored, now);
  // A cached status is only true until its grace window closes: `status` is
  // read-only, so it must not keep promising Pro that the next check will drop.
  const status = !stored.status
    ? (expired ? LICENSE_STATUS.UNVERIFIED : LICENSE_STATUS.ACTIVE)
    : (stored.status === LICENSE_STATUS.CACHED && expired ? LICENSE_STATUS.UNVERIFIED : stored.status);

  if (status === LICENSE_STATUS.ACTIVE) {
    return {
      status,
      validatedAt,
      detail: verifiedOn ? `last verified ${verifiedOn}` : 'not verified yet — run "deskuptime watch" to re-check',
    };
  }
  if (status === LICENSE_STATUS.CACHED) {
    const until = validatedAt ? new Date(Date.parse(validatedAt) + OFFLINE_GRACE_MS).toISOString().slice(0, 10) : null;
    return {
      status,
      validatedAt,
      detail: `license server unreachable; Pro keeps running on the cached status${until ? ` until ${until}` : ''}`,
    };
  }
  // Never getting a verdict (grace expired) is not the same as being rejected, and
  // saying otherwise would send support chasing a revoked key that still works.
  if (status === LICENSE_STATUS.UNVERIFIED) {
    return {
      status,
      validatedAt,
      detail: stored.status === LICENSE_STATUS.UNVERIFIED
        ? `the license server has not been reachable${verifiedOn ? ` since ${verifiedOn}` : ''}; the key was never rejected`
        : (validatedAt
          ? `not verified for ${Math.floor((now - Date.parse(validatedAt)) / 86_400_000)} days; the key has not been rejected`
          : 'never verified against the license server'),
    };
  }
  return {
    status,
    validatedAt,
    detail: 'the license server rejected this key',
  };
}

function withinGrace(license, now) {
  const last = Date.parse(license?.validatedAt ?? '');
  return Number.isFinite(last) && now - last < OFFLINE_GRACE_MS;
}
