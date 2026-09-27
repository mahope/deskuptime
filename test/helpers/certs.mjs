/**
 * P1-67 — the one owner of "a certificate that is already expired".
 *
 * The suite needs real, expired certificates: `checkSSL` reads dates out of a
 * certificate the TLS stack actually accepted, and no stub proves that a
 * lapsed certificate is what the code calls a lapsed certificate. Two fixtures
 * built them with `openssl req -x509 -not_before … -not_after …`, and that
 * pair of options only exists in **OpenSSL 3.5 and later**. Measured on the
 * Linux runner, where the suite has been red for 11 merges:
 *
 *   req: Use -help for summary.                     <- -not_before is unknown
 *
 * The flags are not the only way, and the two obvious alternatives are worse:
 * `-days -1` is rejected outright by `req` ("Non-positive number"), and
 * `openssl x509 -req -days -1` builds the certificate and then throws it away
 * ("end date before start date"). `openssl ca -selfsign` takes `-startdate` and
 * `-enddate`, which have been in OpenSSL since 1.0 and need no date arithmetic
 * from us, so a fixture works on the runner, on this machine, and on whatever
 * OpenSSL a contributor has.
 *
 * The cost is a CA database, so `selfSigned()` writes one into the caller's
 * temp directory and takes the whole thing with it afterwards. Nothing here is
 * a secret: the key and the certificate are generated per fixture and deleted
 * with the directory.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;

/** `YYYYMMDDHHMMSSZ`, the format both `-startdate` and `-enddate` take. */
function stamp(date) {
  return `${date.toISOString().replace(/[-:T.]/g, '').slice(0, 14)}Z`;
}

/**
 * A certificate that is valid from `fromDays` until `toDays` days *before*
 * now, so both dates are in the past and no fixture in the repo ever expires.
 */
export function selfSigned(dir, { fromDays, toDays, subject = '/CN=127.0.0.1', sans = 'IP:127.0.0.1' }) {
  const now = Date.now();
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const config = join(dir, 'openssl.cnf');
  const db = join(dir, 'db');

  execFileSync('openssl', [
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', join(dir, 'req.csr'),
    '-subj', subject,
  ], { stdio: 'ignore' });

  // `openssl ca` keeps its state beside the certificate, and it refuses to run
  // without a database — so the fixture brings its own and nothing outside
  // `dir` is touched.
  writeFileSync(config, [
    '[ca]',
    'default_ca = deskuptime_fixture',
    '[deskuptime_fixture]',
    `database = ${db}/index.txt`,
    `new_certs_dir = ${db}/newcerts`,
    `serial = ${db}/serial`,
    'default_md = sha256',
    'policy = policy',
    'email_in_dn = no',
    'unique_subject = no',
    '[policy]',
    'commonName = supplied',
    '[fixture_ext]',
    'basicConstraints = critical,CA:TRUE',
    `subjectAltName = ${sans}`,
    '',
  ].join('\n'));

  mkdirSync(join(db, 'newcerts'), { recursive: true });
  writeFileSync(join(db, 'index.txt'), '');
  writeFileSync(join(db, 'serial'), '1000\n');

  execFileSync('openssl', [
    'ca', '-batch', '-config', config, '-selfsign', '-keyfile', key,
    '-in', join(dir, 'req.csr'), '-out', cert, '-notext',
    '-startdate', stamp(new Date(now - fromDays * DAY)),
    '-enddate', stamp(new Date(now - toDays * DAY)),
    '-extensions', 'fixture_ext',
  ], { stdio: 'ignore' });

  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

/**
 * The same certificate, in a throwaway directory that is removed when the test
 * ends. `t` is a node:test context; passing `null` leaves the directory in
 * place, which only makes sense inside a measurement.
 */
export function selfSignedFixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'deskuptime-cert-'));
  if (t && typeof t.after === 'function') t.after(() => rmSync(dir, { recursive: true, force: true }));
  return selfSigned(dir, options);
}
