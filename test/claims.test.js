/**
 * Claims conformance — kundeflader må ikke love kanaler, der ikke findes.
 *
 * docs/pro-alerts.md er source of truth. Denne test fejler, hvis README eller
 * --help lover en kanal uden implementation, hvis et ubekræftet domæne bruges som
 * download-kilde, eller hvis der opstår et nyt Stripe-betalingslink.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PRO_BUY_URL, freeLimitMessage } from '../src/watch.js';
import { MATRIX } from '../src/features.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf-8');
const spec = readFileSync(join(root, 'docs', 'pro-alerts.md'), 'utf-8');
const help = readFileSync(join(root, 'src', 'cli.js'), 'utf-8');

const PRO_BUY = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';
const DONATION = 'https://donate.stripe.com/7sYeVcbn50wieFM8gDbMQ0c';

// Kundeflader: claim-teksten er det, en kunde faktisk læser.
const surfaces = [
  ['README.md', readme],
  ['--help', help],
];

// Kanaler der ikke findes i koden. Skal nævnes i docs/pro-alerts.md som ikke-implementeret.
const unimplemented = ['email alert', 'slack alert', 'discord', 'teams alert', 'sms alert', 'push alert'];

function claimLines(text) {
  return text.split('\n').filter(line => /^\s*[-|*]|Pro features|PRO FEATURES|^\s*•/i.test(line));
}

test('ingen kundeflade lover en kanal, der ikke er implementeret', () => {
  for (const [name, text] of surfaces) {
    for (const line of claimLines(text)) {
      const lower = line.toLowerCase();
      for (const claim of unimplemented) {
        assert.ok(!lower.includes(claim), `${name} lover "${claim}": ${line.trim()}`);
      }
      assert.ok(!/\bcoming soon\b/i.test(line), `${name} bruger "coming soon" i et claim: ${line.trim()}`);
    }
  }
});

test("spec'en erklærer de uimplementerede kanaler som ikke-implementeret", () => {
  for (const channel of ['Email-alerts', 'Slack / Discord / Teams']) {
    assert.ok(spec.includes(channel), `docs/pro-alerts.md mangler rækken for ${channel}`);
  }
  const matrixRows = spec.split('\n').filter(line => line.startsWith('| ') && line.includes('|'));
  assert.ok(matrixRows.length >= 14, `matrixen har kun ${matrixRows.length} rækker`);
});

test('README peger på det faktiske desktop-download, ikke på et ubekræftet domæne', () => {
  assert.ok(readme.includes('releases/tag/desktop-v0.2.7'), 'README mangler link til desktop-releasen');
  assert.ok(!/deskuptime\.com\/[^\s)]*download/i.test(readme), 'README lover en download fra deskuptime.com');
});

test('kun det aftalte betalingslink og donationslinket forekommer', () => {
  for (const [name, text] of [['README.md', readme], ['docs/pro-alerts.md', spec], ['--help', help]]) {
    const links = [...text.matchAll(/https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+/g)].map(match => match[0]);
    for (const link of links) assert.equal(link, PRO_BUY, `${name} bruger et uaftalt betalingslink: ${link}`);
    const donations = [...text.matchAll(/https:\/\/donate\.stripe\.com\/[A-Za-z0-9]+/g)].map(match => match[0]);
    for (const link of donations) assert.equal(link, DONATION, `${name} bruger et uaftalt donationslink: ${link}`);
  }
  assert.equal(PRO_BUY_URL, PRO_BUY, 'købslinket i koden afviger fra kontrakten');
});

test('upgrade-vejen nævner købslinket, så gratisbrugere ikke sidder fast ved en Pro-grænse', () => {
  // Rendered, not grepped: the message a free user actually reads must carry the link.
  assert.ok(freeLimitMessage('https://yoursite.com/').includes(PRO_BUY), 'URL-grænsen skal pege på det aftalte købslink');
  const watch = readFileSync(join(root, 'src', 'watch.js'), 'utf-8');
  assert.ok(watch.includes('upgradeHint'), 'src/watch.js mangler upgradeHint');
  const hinted = [...watch.matchAll(/upgradeHint\(([^)]*)\)/g)].map(match => match[1]);
  assert.ok(hinted.length >= 2, `upgradeHint bruges kun ${hinted.length} steder`);
  assert.ok(hinted.some(call => call.includes('webhook alerts')), 'webhook-grænsen skal pege på upgradeHint');
});

test('matrixen i README og specen dækker de samme byggede Pro-værdier', () => {
  // Locked against src/features.js, not against hand-typed strings: a Pro value
  // that is added to the matrix must reach both languages or this test fails.
  const proValues = MATRIX.filter(row => row.implemented && row.pro.en !== row.free.en);
  assert.ok(proValues.length >= 3, `matrixen har kun ${proValues.length} rækker, hvor Pro tilføjer noget`);
  for (const row of proValues) {
    assert.ok(readme.includes(row.en), `README mangler Pro-værdi: ${row.en}`);
    assert.ok(spec.includes(row.da), `docs/pro-alerts.md mangler Pro-værdi: ${row.da}`);
  }
});
