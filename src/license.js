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

export const LICENSE_API_BASE = 'https://mahope.tools/api/license';
export const PRODUCT_KEY = 'deskuptime-pro';
export const BUY_URL = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_PATTERN = /^[a-f0-9]{32}$/;

const STATUS_MESSAGES = {
  400: 'Invalid license key format',
  403: 'License key is expired, revoked or for another product',
  404: 'Unknown license key',
  409: 'Device limit reached — deactivate another machine first',
  503: 'License server temporarily unavailable — try again later',
};

/** Trim + lowercase, as the license server expects. */
export function normalizeKey(key) {
  return String(key ?? '').trim().toLowerCase();
}

/**
 * Stable per-machine id. Same scheme as the desktop app, so the CLI and the
 * desktop app on one machine share a single activation seat.
 */
export function getDeviceId() {
  return `deskuptime-${hostname().trim().toLowerCase() || 'unknown'}`.slice(0, 128);
}

async function post(endpoint, body) {
  let response;
  try {
    response = await fetch(`${LICENSE_API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, data: {}, transient: true, error: `Network error: ${err.message}` };
  }
  let data = {};
  try { data = await response.json(); } catch { /* non-JSON body */ }
  const transient = response.status >= 500;
  const error = response.ok
    ? null
    : (data.error || data.message || STATUS_MESSAGES[response.status] || `License server error (HTTP ${response.status})`);
  return { status: response.status, data, transient, error };
}

/**
 * Activate a license key for this machine.
 * @param {string} licenseKey - key from the purchase email
 * @param {string} [deviceId] - defaults to getDeviceId()
 * @returns {Promise<object>} { valid, activated, key, deviceId, meta?, error?, status?, transient? }
 */
export async function activateLicense(licenseKey, deviceId = getDeviceId()) {
  const key = normalizeKey(licenseKey);
  if (!KEY_PATTERN.test(key)) {
    return { valid: false, activated: false, error: 'Invalid license key format (expected 32 hex characters)' };
  }
  const r = await post('activate', { license_key: key, device_id: deviceId, product: PRODUCT_KEY });
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
  return {
    valid: false,
    activated: false,
    status: r.status,
    transient: r.transient,
    error: r.error || 'License activation failed',
  };
}

/**
 * Check whether a license key is still valid for this machine.
 * @returns {Promise<object>} { valid, transient, plan?, expiresAt?, error? }
 *   transient === true means "could not reach a verdict" (network error / 5xx).
 */
export async function validateLicense(licenseKey, deviceId = getDeviceId()) {
  const key = normalizeKey(licenseKey);
  if (!KEY_PATTERN.test(key)) {
    return { valid: false, transient: false, error: 'Invalid license key format' };
  }
  const r = await post('validate', { license_key: key, device_id: deviceId, product: PRODUCT_KEY });
  if (r.status === 200 && r.data.ok === true) {
    return {
      valid: r.data.valid === true,
      transient: false,
      plan: r.data.plan ?? null,
      expiresAt: r.data.expires_at ?? null,
      error: r.data.valid === true ? null : (r.data.reason || 'License is no longer valid'),
    };
  }
  return { valid: false, transient: r.transient, error: r.error || 'License validation failed' };
}

/**
 * Free this machine's activation seat.
 */
export async function deactivateLicense(licenseKey, deviceId = getDeviceId()) {
  const key = normalizeKey(licenseKey);
  const r = await post('deactivate', { license_key: key, device_id: deviceId });
  if (r.status === 200 && r.data.ok === true) {
    return { deactivated: r.data.deactivated === true, devicesInUse: r.data.devices_in_use ?? null, error: null };
  }
  return { deactivated: false, error: r.error || 'License deactivation failed' };
}

/**
 * Re-validate a stored license ({ key, instance, validatedAt }) and decide Pro status.
 * - valid answer        → Pro, validatedAt bumped
 * - definitive invalid  → not Pro
 * - network error / 5xx → Pro only if last successful validation < OFFLINE_GRACE_MS ago
 * The stored key is never discarded here, so a later successful check restores Pro.
 * @returns {Promise<{ pro: boolean, license: object, reason: string|null }>}
 */
export async function refreshLicense(license, { now = Date.now() } = {}) {
  if (!license?.key) return { pro: false, license, reason: 'No license key' };
  const res = await validateLicense(license.key, license.instance || getDeviceId());
  if (res.valid) {
    return { pro: true, license: { ...license, validatedAt: new Date(now).toISOString() }, reason: null };
  }
  if (res.transient) {
    const last = Date.parse(license.validatedAt ?? '');
    const withinGrace = Number.isFinite(last) && now - last < OFFLINE_GRACE_MS;
    return { pro: withinGrace, license, reason: res.error };
  }
  return { pro: false, license, reason: res.error };
}
