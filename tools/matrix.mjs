/**
 * matrix.mjs — write (or verify) the generated free/Pro blocks in the docs.
 *
 * Usage:
 *   node tools/matrix.mjs            rewrite the generated blocks in place
 *   node tools/matrix.mjs --check    fail (exit 1) when a committed block drifts
 *
 * The source of truth is src/features.js. Blocks are delimited by
 * `<!-- BEGIN GENERATED: name -->` / `<!-- END GENERATED: name -->`.
 * test/matrix.test.js runs the --check mode, so a hand-edited table cannot
 * silently contradict the CLI.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderMatrixTable, renderLicenseDataTable, renderLicenseDataLine, renderNpmDescription } from '../src/features.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    file: 'README.md',
    blocks: {
      matrix: () => renderMatrixTable('en', { implementedOnly: true }),
      'license data': () => `${renderLicenseDataLine('en')}\n\n${renderLicenseDataTable('en')}`,
    },
  },
  {
    file: join('docs', 'pro-alerts.md'),
    blocks: {
      matrix: () => renderMatrixTable('da'),
      'license data': () => `${renderLicenseDataLine('da')}\n\n${renderLicenseDataTable('da')}`,
    },
  },
  {
    // The npm listing is a customer surface with no BEGIN/END markers, so it is
    // patched as JSON instead: description in, description out.
    file: 'package.json',
    json: { description: renderNpmDescription },
  },
];

function blockPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!-- BEGIN GENERATED: ${escaped} -->[\\s\\S]*?<!-- END GENERATED: ${escaped} -->`);
}

function updateBlock(text, name, body) {
  const pattern = blockPattern(name);
  if (!pattern.test(text)) {
    throw new Error(`Missing generated block: ${name}. Add the BEGIN/END markers first.`);
  }
  return text.replace(pattern, `<!-- BEGIN GENERATED: ${name} -->\n${body}\n<!-- END GENERATED: ${name} -->`);
}

const check = process.argv.includes('--check');
const drifted = [];

for (const target of TARGETS) {
  const path = join(root, target.file);
  const original = readFileSync(path, 'utf-8');
  let updated = original;
  if (target.json) {
    const pkg = JSON.parse(original);
    for (const [key, render] of Object.entries(target.json)) {
      pkg[key] = render();
    }
    updated = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  for (const [name, render] of Object.entries(target.blocks ?? {})) {
    updated = updateBlock(updated, name, render());
  }
  if (updated === original) continue;
  if (check) {
    drifted.push(target.file);
  } else {
    writeFileSync(path, updated);
    console.log(`Opdaterede genererede blokke i ${target.file}`);
  }
}

if (drifted.length > 0) {
  console.error(`Genererede blokke afviger fra src/features.js:\n  ${drifted.join('\n  ')}\nKør: node tools/matrix.mjs`);
  process.exit(1);
}
