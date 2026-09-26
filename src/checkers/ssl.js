/**
 * SSL certificate checker
 * Uses Node's crypto/tls to check certificate details.
 */

import https from 'https';
import tls from 'tls';
import net from 'net';
import { URL } from 'url';

/** Default deadline for the handshake. `--timeout` lowers it, never raises it. */
export const SSL_TIMEOUT_MS = 10_000;

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs] — deadline for this handshake
 */
export function checkSSL(url, { timeoutMs = SSL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      const port = parseInt(parsed.port, 10) || 443;

      // SNI must not be an IP literal (RFC 6066). Node 24+ throws instead of
      // ignoring it, so monitoring a server by IP failed the whole check and
      // reported "SSL handshake error" instead of the certificate expiry.
      const socket = tls.connect(port, hostname, {
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });

      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve({ error: 'SSL handshake timed out' });
        }
      }, timeoutMs);

      socket.on('secureConnect', () => {
        if (settled) return;
        clearTimeout(timeout);

        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();

        if (!cert || Object.keys(cert).length === 0) {
          settled = true;
          socket.destroy();
          resolve({ error: 'No certificate presented' });
          return;
        }

        const now = new Date();
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const validDays = Math.round((validTo - now) / (1000 * 60 * 60 * 24));
        const totalDays = Math.round((validTo - validFrom) / (1000 * 60 * 60 * 24));

        settled = true;
        socket.end();
        resolve({
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          validDays: Math.max(0, validDays),
          totalDays,
          isExpired: now > validTo,
          expiresSoon: validDays <= 30,
          serialNumber: cert.serialNumber,
          fingerprint: cert.fingerprint,
          cipher: cipher.name,
          protocol: cipher.version,
          subjectAltName: cert.subjectaltname?.split(', ').filter(Boolean) || [],
        });
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ error: err.message });
        }
      });

      socket.on('timeout', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          resolve({ error: 'SSL connection timed out' });
        }
      });
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}