/**
 * Feature-matrix conformance — én kilde, ingen drift mellem kundeflader.
 *
 * src/features.js er source of truth for gratis/Pro-claims, pris, links og den
 * data, der forlader maskinen. Denne test fejler, hvis
 *   - en committet flade (README, docs/pro-alerts.md) afviger fra den,
 *   - `--help` ikke gengiver matrixen,
 *   - en kanal, der ikke er bygget, optræder i en kundeflade,
 *   - de håndhævede gratisgrænser i watch.js afviger fra den dokumenterede matrix,
 *   - nøgler, købslink eller donationslink afviger fra kontrakten.
 *
 * De to første fejl er umulige at indføre ved en redigering: en håndredigeret
 * tabel bryder netop denne test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREE, LICENSE_FIELDS, MATRIX, PRODUCT, PRO, renderHelpPro, renderMatrixTable } from '../src/features.js';
import { BUY_URL, LICENSE_API_BASE, PRODUCT_KEY } from '../src/license.js';
import { PRO_BUY_URL } from '../src/watch.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const spec = readFileSync(join(ROOT, 'docs', 'pro-alerts.md'), 'utf8');

// The contract values. Hardcoded on purpose: a changed product key, buy link or
// donation link must be an explicit decision, not a consequence of a refactor.
const CONTRACT = {
  key: 'deskuptime-pro',
  buyUrl: 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01',
  donationUrl: 'https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c',
  licenseApiBase: 'https://mahope.tools/api/license',
};

function generatedBlock(text, name) {
  const match = text.match(new RegExp(`<!-- BEGIN GENERATED: ${name} -->\\n([\\s\\S]*?)\\n<!-- END GENERATED: ${name} -->`));
  assert.ok(match, `mangler genereret blok: ${name}`);
  return match[1];
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'deskuptime-matrix-'));
}

function cli(args, home) {
  return run(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });
}

test('kommiterede flader er genereret fra src/features.js', async () => {
  const { stdout, stderr } = await run(process.execPath, [join(ROOT, 'tools', 'matrix.mjs'), '--check'], { cwd: ROOT });
  assert.equal(stdout.trim(), '', `tools/matrix.mjs --check skrev: ${stdout}${stderr}`);
});

test('README og spec gengiver hver række i matrixen på sit eget sprog', () => {
  assert.ok(readme.includes(renderMatrixTable('en', { implementedOnly: true })), 'README-matrixen afviger fra src/features.js');
  assert.ok(spec.includes(renderMatrixTable('da')), 'docs/pro-alerts.md-matrixen afviger fra src/features.js');
  for (const row of MATRIX) {
    assert.ok(spec.includes(row.da), `docs/pro-alerts.md mangler rækken: ${row.da}`);
    if (row.implemented) assert.ok(readme.includes(row.en), `README mangler rækken: ${row.en}`);
  }
});

test('ikke-byggede kanaler står i specifikationen, men ikke i README eller --help', async () => {
  const { stdout } = await cli(['--help'], tempHome());
  const readmeMatrix = generatedBlock(readme, 'matrix').toLowerCase();
  const notBuilt = MATRIX.filter(row => !row.implemented);
  assert.ok(notBuilt.length > 0, 'matrixen har ingen ikke-implementerede rækker at slå fast');
  for (const row of notBuilt) {
    assert.ok(spec.includes(row.da), `spec'en dokumenterer ikke ${row.id}`);
    assert.ok(!readmeMatrix.includes(row.en.toLowerCase()), `README-matrixen lover ${row.id}: ${row.en}`);
    assert.ok(!stdout.includes(row.en), `--help lover ${row.id}: ${row.en}`);
  }
  for (const channel of ['email alert', 'slack', 'discord', 'teams', 'sms alert', 'push alert']) {
    assert.ok(!readmeMatrix.includes(channel), `README-matrixen nævner "${channel}"`);
    assert.ok(!stdout.toLowerCase().includes(channel), `--help nævner "${channel}"`);
  }
});

test('--help gengiver Pro-matrixen og den data, der sendes til licensserveren', async () => {
  const { stdout } = await cli(['--help'], tempHome());
  assert.ok(stdout.includes(renderHelpPro()), '--help gengiver ikke renderHelpPro() fra src/features.js');
  for (const field of LICENSE_FIELDS) {
    assert.ok(stdout.includes(field.field), `--help nævner ikke licensfeltet ${field.field}`);
  }
  assert.ok(stdout.includes(PRODUCT.buyUrl), '--help nævner ikke købslinket');
  assert.ok(stdout.includes(`${FREE.urlLimit} URLs`), `--help nævner ikke gratisgrænsen på ${FREE.urlLimit} URL'er`);
  assert.ok(stdout.includes(`min. ${PRO.minIntervalSeconds}s interval`), `--help nævner ikke Pro-intervallet på ${PRO.minIntervalSeconds}s`);
});

test('README beskriver præcis hvilke felter der sendes til licensserveren', () => {
  const block = generatedBlock(readme, 'license data');
  for (const field of LICENSE_FIELDS) {
    assert.ok(block.includes(`\`${field.field}\``), `README nævner ikke licensfeltet ${field.field}`);
    assert.ok(block.includes(field.en), `README beskriver ikke ${field.field}: ${field.en}`);
  }
  for (const never of ['URLs', 'page content', 'IP addresses']) {
    assert.ok(block.includes(never), `README nævner ikke, at ${never} aldrig sendes`);
  }
});

test('gratisgrænsen i watch svarer til matrixen og peger på købslinket', async () => {
  const home = tempHome();
  mkdirSync(join(home, '.deskuptime'), { recursive: true });
  // Three URLs already monitored: the fourth must be refused before any request.
  writeFileSync(join(home, '.deskuptime', 'state.json'), JSON.stringify({
    urls: {
      'https://a.example/': {},
      'https://b.example/': {},
      'https://c.example/': {}
    }
  }));
  const error = await cli(['watch', 'https://d.example/', '--once'], home).then(
    () => null,
    err => err
  );
  assert.ok(error, 'watch --once accepterede en fjerde URL på gratisniveauet');
  assert.equal(error.code, 1);
  assert.ok(
    error.stderr.includes(`Free tier monitors ${FREE.urlLimit} URLs`),
    `fejlteksten nævner ikke matrixens grænse på ${FREE.urlLimit} URL'er: ${error.stderr}`
  );
  assert.ok(error.stderr.includes(PRODUCT.buyUrl), 'grænsen peger ikke på købslinket');
  rmSync(home, { recursive: true, force: true });
});

test('gratisintervallet håndhæves som i matrixen', { timeout: 20000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}/`;
  const home = tempHome();
  const child = spawn(process.execPath, [CLI, 'watch', site, '--interval', '5'], {
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`watch skrev aldrig intervallinjen: ${out}`)), 15000);
      child.stdout.on('data', () => {
        if (out.includes('Monitoring')) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`watch afsluttede med ${code}: ${out}`)); });
    });
  } finally {
    child.kill();
    server.closeAllConnections();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
  assert.ok(
    out.includes(`every ${FREE.minIntervalSeconds}s`),
    `--interval 5 blev ikke hævet til matrixens ${FREE.minIntervalSeconds}s: ${out}`
  );
  assert.ok(out.includes('[free tier]'), `watch skrev ikke gratisniveauet: ${out}`);
});

test('produktnøgle, købslink, donationslink og API-base er uændrede', () => {
  assert.equal(PRODUCT.key, CONTRACT.key);
  assert.equal(PRODUCT.buyUrl, CONTRACT.buyUrl);
  assert.equal(PRODUCT.donationUrl, CONTRACT.donationUrl);
  assert.equal(PRODUCT.licenseApiBase, CONTRACT.licenseApiBase);
  // Kunderne møder disse konstanter gennem licenskommandoerne.
  assert.equal(PRODUCT_KEY, CONTRACT.key, 'src/license.js afviger fra matrixen');
  assert.equal(BUY_URL, CONTRACT.buyUrl, 'src/license.js bruger et andet købslink end kontrakten');
  assert.equal(LICENSE_API_BASE, CONTRACT.licenseApiBase, 'src/license.js bruger en anden licens-API');
  assert.equal(PRO_BUY_URL, CONTRACT.buyUrl, 'upgradeHint i src/watch.js peger på et andet købslink');
  const funding = readFileSync(join(ROOT, '.github', 'FUNDING.yml'), 'utf8');
  assert.ok(funding.includes(CONTRACT.donationUrl), '.github/FUNDING.yml peger på et andet donationslink');
});
