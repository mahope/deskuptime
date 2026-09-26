/**
 * features.js — the single, version-controlled source of truth for what the
 * free tier and Pro do, what they cost, and which data leaves the machine.
 *
 * Every customer-facing surface renders from this file, so a claim cannot be
 * true on one surface and false on another:
 *
 *   - `deskuptime --help`                (src/cli.js, via renderHelpPro)
 *   - README.md "Free vs Pro" + license   (generated block, tools/matrix.mjs)
 *   - docs/pro-alerts.md §1 + §5          (generated block, tools/matrix.mjs)
 *   - the limits enforced in src/watch.js
 *   - the product/URL constants in src/license.js
 *
 * test/matrix.test.js fails when a committed surface drifts from this file.
 * Changing a claim means changing it here, once. Channels that are not built
 * must stay `implemented: false` and are then never rendered as a customer
 * claim — see docs/pro-alerts.md §1.
 */

export const PRODUCT = {
  name: 'DeskUptime',
  proName: 'DeskUptime Pro',
  key: 'deskuptime-pro',
  price: '$19',
  priceLong: '$19 one-time',
  machines: 3,
  buyUrl: 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01',
  donationUrl: 'https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c',
  licenseApiBase: 'https://mahope.tools/api/license',
};

/** Enforced in src/watch.js. Rendered into the matrix so docs cannot drift. */
export const FREE = { urlLimit: 3, minIntervalSeconds: 60 };
export const PRO = { urlLimit: Infinity, minIntervalSeconds: 30 };

const YES = { en: '✅', da: '✅' };
const NO = { en: '—', da: '—' };
const BOTH = { en: 'In both tiers', da: 'I begge' };
const PRO_ONLY = { en: 'Pro only', da: 'Kun Pro' };
const PRIVATE_APP = { en: 'Pro only — private desktop app', da: 'Kun Pro — privat desktopapp' };
const NOT_BUILT = { en: '**Not built**', da: '**Ikke bygget**' };
const PLANNED = { en: 'Planned — not part of the purchase', da: 'Planlagt — ikke en del af købet' };

/**
 * The free/Pro matrix. `implemented: false` rows are documented as not built and
 * are excluded from README and --help, so no surface can promise them.
 */
export const MATRIX = [
  {
    id: 'check',
    en: '`check` and `headers` on any number of URLs',
    da: "`check` og `headers` på vilkårlig mange URL'er",
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'ssl-content',
    en: 'SSL expiry countdown, issuer and content-change detection',
    da: 'SSL-udløbsnedtælling, issuer og content-ændringsdetektion',
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'action',
    en: 'GitHub Action with JSON output, `down-count` and job summary',
    da: 'GitHub Action med JSON-output, `down-count` og job-summary',
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'json',
    en: 'JSON output (`--json`) for scripts and CI',
    da: 'JSON-output (`--json`) til scripts og CI',
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'watch',
    en: '`watch` background monitoring',
    da: '`watch` baggrundsovervågning',
    free: {
      en: `${FREE.urlLimit} URLs, min. ${FREE.minIntervalSeconds}s interval`,
      da: `${FREE.urlLimit} URL'er, min. ${FREE.minIntervalSeconds} s interval`,
    },
    pro: {
      en: `Unlimited URLs, min. ${PRO.minIntervalSeconds}s interval`,
      da: `Ubegrænsede URL'er, min. ${PRO.minIntervalSeconds} s interval`,
    },
    implemented: true,
    status: BOTH,
  },
  {
    id: 'terminal-alerts',
    en: 'Terminal alerts on up/down/SSL/content change',
    da: 'Terminal-udskrift ved UP/DOWN/SSL/content-ændring',
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'status-command',
    en: '`deskuptime status` — license state and monitored URLs, read-only',
    da: "`deskuptime status` — licenstilstand og overvågede URL'er, read-only",
    free: YES,
    pro: YES,
    implemented: true,
    status: BOTH,
  },
  {
    id: 'webhook',
    en: 'Webhook alerts on every event (`--webhook`)',
    da: 'Webhook-alerts ved hver hændelse (`--webhook`)',
    free: NO,
    pro: YES,
    implemented: true,
    status: PRO_ONLY,
  },
  {
    id: 'desktop-notification',
    en: 'Local desktop notification (macOS in the CLI, all platforms in the desktop app)',
    da: 'Lokal desktop-notification (macOS i CLI\'en, alle platforme i desktopappen)',
    free: NO,
    pro: YES,
    implemented: true,
    status: PRO_ONLY,
  },
  {
    id: 'desktop-app',
    en: 'Desktop app: tray, background loop, activity view',
    da: 'Desktop-app: tray, baggrundsloop, aktivitetsoversigt',
    free: NO,
    pro: YES,
    implemented: true,
    status: PRIVATE_APP,
  },
  {
    id: 'email',
    en: 'Email alerts',
    da: 'Email-alerts',
    free: NO,
    pro: NO,
    implemented: false,
    status: NOT_BUILT,
  },
  {
    id: 'slack',
    en: 'Slack / Discord / Teams channel',
    da: 'Slack / Discord / Teams-kanal',
    free: NO,
    pro: NO,
    implemented: false,
    status: NOT_BUILT,
  },
  {
    id: 'status-page',
    en: 'Shareable status page / customer report (`report`, Markdown + JSON)',
    da: 'Delelig status-side / kunderapport (`report`, Markdown + JSON)',
    free: NO,
    pro: YES,
    implemented: true,
    status: PRO_ONLY,
  },
  {
    id: 'batch',
    en: 'Batch jobs, multiple locations, priority support',
    da: 'Batch-job, flere lokationer, prioriteret support',
    free: NO,
    pro: { en: 'Planned', da: 'Planlagt' },
    implemented: false,
    status: PLANNED,
  },
];

/** The three fields the license server receives, and nothing else. */
export const LICENSE_FIELDS = [
  { field: 'license_key', en: 'Your 32-character license key', da: 'Din 32-tegns licensnøgle' },
  {
    field: 'device_id',
    en: 'A machine id derived from the computer name (`deskuptime-` + name, max. 128 chars)',
    da: 'Et maskine-id udledt af computerens navn (`deskuptime-` + navn, maks. 128 tegn)',
  },
  { field: 'product', en: `The product key \`${PRODUCT.key}\``, da: `Produktnøglen \`${PRODUCT.key}\`` },
];

/** Explicitly never sent, so the privacy claim is checkable and not just reassuring. */
export const LICENSE_NEVER_SENT = {
  en: 'monitored URLs, page content, check results, IP addresses or history',
  da: 'overvågede URL\'er, sideindhold, kontrolresultater, IP-adresser eller historik',
};

const other = (lang) => (lang === 'da' ? 'da' : 'en');

/** Markdown table of the matrix. `implementedOnly` drops everything not built. */
export function renderMatrixTable(lang = 'en', { implementedOnly = false } = {}) {
  const l = other(lang);
  const rows = implementedOnly ? MATRIX.filter(row => row.implemented) : MATRIX;
  const header = l === 'da'
    ? ['Funktion', 'Gratis (CLI, MIT)', `Pro (${PRODUCT.priceLong}, ${PRODUCT.machines} maskiner)`, 'Status']
    : ['Feature', 'Free CLI (MIT)', `Pro (${PRODUCT.priceLong}, ${PRODUCT.machines} machines)`, 'Status'];
  const line = cells => `| ${cells.join(' | ')} |`;
  return [
    line(header),
    `|${' --- |'.repeat(header.length)}`,
    ...rows.map(row => line([row[l], row.free[l], row.pro[l], row.status[l]])),
  ].join('\n');
}

function row(id) {
  const found = MATRIX.find(entry => entry.id === id);
  if (!found) throw new Error(`Unknown matrix row: ${id}`);
  return found;
}

/** The Pro-only rows that are actually built, for `--help`. */
export function proBullets(lang = 'en') {
  const l = other(lang);
  const bullets = MATRIX
    .filter(entry => entry.implemented && entry.free[l] === NO[l] && entry.pro[l] !== NO[l])
    .map(entry => `  • ${entry[l]}`);
  // The webhook row is the only Pro-only channel with a command, so its example
  // belongs directly under it instead of at the end of the block.
  const webhookIndex = bullets.findIndex(bullet => bullet.includes('`--webhook`'));
  if (webhookIndex !== -1) {
    bullets.splice(webhookIndex + 1, 0, '    Example: deskuptime watch https://yoursite.com --webhook https://hooks.example.com/xyz');
  }
  return bullets;
}

/** The `PRO FEATURES` block of `deskuptime --help`, rendered from the matrix. */
export function renderHelpPro() {
  const watch = row('watch');
  return [
    `PRO FEATURES (${PRODUCT.proName}, ${PRODUCT.priceLong}, ${PRODUCT.machines} machines):`,
    `  watch: ${watch.pro.en} (free: ${watch.free.en})`,
    ...proBullets(),
    '',
    `  Buy: ${PRODUCT.buyUrl} — then "deskuptime activate <key>".`,
    `  License calls send only: ${LICENSE_FIELDS.map(field => field.field).join(', ')} — never your URLs, page content or IP.`,
    '',
    '  Full free/Pro matrix, webhook payload and privacy: docs/pro-alerts.md',
  ].join('\n');
}

/** One prose line naming exactly what leaves the machine. */
export function renderLicenseDataLine(lang = 'en') {
  const l = other(lang);
  return l === 'da'
    ? `Licensserveren modtager pr. kald præcis tre felter: ${LICENSE_FIELDS.map(f => `\`${f.field}\``).join(', ')}. Aldrig: ${LICENSE_NEVER_SENT.da}.`
    : `The license server receives exactly three fields per call: ${LICENSE_FIELDS.map(f => `\`${f.field}\``).join(', ')}. Never: ${LICENSE_NEVER_SENT.en}.`;
}

/** Table form of the same data, for README and docs/pro-alerts.md. */
export function renderLicenseDataTable(lang = 'en') {
  const l = other(lang);
  const line = cells => `| ${cells.join(' | ')} |`;
  const header = l === 'da' ? ['Felt', 'Hvad det er'] : ['Field', 'What it is'];
  return [
    line(header),
    `|${' --- |'.repeat(header.length)}`,
    ...LICENSE_FIELDS.map(field => line([`\`${field.field}\``, field[l]])),
  ].join('\n');
}

/**
 * The npm listing is a customer surface too: it is where a paid searcher lands.
 * Generated from the same constants and matrix, so it cannot promise a channel
 * that is not built, and it drops one automatically when it stops being built.
 */
export function proExtras() {
  const proOnly = new Set(MATRIX.filter(entry => entry.implemented && entry.free.en === NO.en).map(entry => entry.id));
  return [
    PRO.urlLimit === Infinity ? 'unlimited URLs' : `${PRO.urlLimit} URLs`,
    proOnly.has('webhook') && 'webhook alerts',
    proOnly.has('status-page') && 'client reports',
    proOnly.has('desktop-app') && 'the desktop app',
  ].filter(Boolean).join(', ');
}

export function renderNpmDescription() {
  return `Uptime, SSL expiry and content-change alerts from your terminal or CI. Free MIT CLI — ${PRODUCT.proName} (${PRODUCT.priceLong}, ${PRODUCT.machines} machines) adds ${proExtras()}.`;
}
