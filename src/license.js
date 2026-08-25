/**
 * DeskUptime — Lemon Squeezy License Key Validation
 *
 * Validates LS license keys against the public LS License API.
 * No API key needed for validation — LS validates license keys
 * via a public POST endpoint.
 */

const LS_LICENSE_API = 'https://api.lemonsqueezy.com/v1/licenses/activate';

/**
 * Validate an LS license key + activate it for this machine
 * @param {string} licenseKey - LS license key from purchase
 * @param {string} instanceName - unique machine identifier
 * @returns {Promise<object>} { valid, activated, error?, meta?, instance? }
 */
export async function activateLicense(licenseKey, instanceName) {
  if (!licenseKey || !instanceName) {
    return { valid: false, activated: false, error: 'licenseKey and instanceName required' };
  }

  try {
    const response = await fetch(LS_LICENSE_API, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: licenseKey,
        instance_name: instanceName,
      }),
    });

    const data = await response.json();

    if (data.activated === true) {
      return {
        valid: true,
        activated: true,
        meta: {
          product: data.meta?.product_name,
          variant: data.meta?.variant_name,
          customer: data.meta?.customer_name,
          email: data.meta?.customer_email,
          expiresAt: data.meta?.expires_at,
        },
        instance: data.instance || null,
      };
    }

    return {
      valid: false,
      activated: false,
      error: data.error || 'License activation failed',
    };
  } catch (err) {
    return {
      valid: false,
      activated: false,
      error: `Network error: ${err.message}`,
    };
  }
}

/**
 * Check if a license key is still valid (no activation)
 * @param {string} licenseKey
 * @returns {Promise<object>} { valid, error?, meta? }
 */
export async function validateLicense(licenseKey) {
  if (!licenseKey) {
    return { valid: false, error: 'licenseKey required' };
  }

  try {
    const response = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey }),
    });

    const data = await response.json();
    return {
      valid: data.valid === true,
      error: data.error || null,
      meta: data.meta || null,
    };
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Deactivate a license key on an instance
 */
export async function deactivateLicense(licenseKey, instanceName) {
  try {
    const response = await fetch('https://api.lemonsqueezy.com/v1/licenses/deactivate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, instance_name: instanceName }),
    });
    const data = await response.json();
    return { deactivated: data.deactivated === true, error: data.error || null };
  } catch (err) {
    return { deactivated: false, error: `Network error: ${err.message}` };
  }
}
