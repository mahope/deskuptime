import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createUrlCard,
  normalizeMonitoredUrl,
  toCheckResultSummary,
} from '../desktop/frontend/app.js';

const root = new URL('../', import.meta.url);
const indexPath = new URL('desktop/frontend/index.html', root);
const appPath = new URL('desktop/frontend/app.js', root);
const configPath = new URL('desktop/src-tauri/tauri.conf.json', root);
const capabilitiesPath = new URL('desktop/src-tauri/capabilities/default.json', root);

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = value === '' ? [] : [new FakeText(value)];
  }

  get textContent() {
    return this._textContent;
  }

  append(...children) {
    this.children.push(...children);
    if (children.length > 0) this._textContent = '';
  }

  replaceChildren(...children) {
    this.children = [...children];
    this._textContent = '';
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createTextNode(text) {
    return new FakeText(text);
  }
}

function elements(node) {
  return [node, ...node.children.flatMap(child => child.nodeType === 1 ? elements(child) : [])];
}

test('desktop config injects the Tauri bridge and blocks remote executable assets', async () => {
  const [index, configText, capabilitiesText] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(configPath, 'utf8'),
    readFile(capabilitiesPath, 'utf8'),
  ]);
  const config = JSON.parse(configText);
  const capabilities = JSON.parse(capabilitiesText);
  assert.equal(config.app.withGlobalTauri, true);
  assert.deepEqual(capabilities.permissions, ['core:event:allow-listen']);
  assert.equal(config.build.devUrl, undefined);
  assert.equal(config.app.security.csp.includes("script-src 'self'"), true);
  assert.equal(config.app.security.csp.includes('unsafe-inline'), false);
  assert.equal(config.app.security.csp.includes('https:'), false);
  assert.doesNotMatch(index, /cdn\.tailwindcss\.com|<style\b|<script(?![^>]*\bsrc=)/i);

  const executableTags = [...index.matchAll(/<(?:script|link)\b[^>]*>/gi)].map(match => match[0]);
  assert.ok(executableTags.length > 0);
  for (const tag of executableTags) {
    assert.doesNotMatch(tag, /https?:\/\//i);
  }
});

test('every frontend element lookup resolves to the packaged HTML', async () => {
  const [index, app] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(appPath, 'utf8'),
  ]);
  const ids = new Set([...index.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of app.matchAll(/\.id\s*=\s*'([^']+)'/g)) {
    ids.add(match[1]);
  }
  const lookups = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
  assert.ok(lookups.length > 0);
  for (const id of lookups) {
    assert.equal(ids.has(id), true, `Missing #${id}`);
  }
});

test('IPC result normalizers keep one snake_case contract', () => {
  const entry = normalizeMonitoredUrl({
    url: 'https://example.com',
    last_result: {
      reachable: true,
      status_code: 204,
      response_time: '12ms',
      ssl: true,
      ssl_days: 42,
      ssl_expiring: false,
      last_checked: '12:00:00',
      error: null,
    },
  });
  assert.equal(entry.last_result.status_code, 204);
  assert.equal(entry.last_result.response_time, '12ms');
  assert.equal('lastResult' in entry, false);

  const summary = toCheckResultSummary({
    reachable: false,
    status_code: null,
    response_time_ms: 17,
    ssl: null,
    error: 'connection refused',
  }, '12:34:56');
  assert.deepEqual(summary, {
    reachable: false,
    status_code: null,
    response_time: '17ms',
    ssl: null,
    ssl_days: null,
    ssl_expiring: false,
    last_checked: '12:34:56',
    error: 'connection refused',
  });
});

test('malicious URL text cannot create DOM nodes or inline handlers', () => {
  const malicious = 'https://example.com/"<img src=x onerror=alert(1)>';
  const card = createUrlCard({ url: malicious, last_result: null }, false, new FakeDocument());
  const nodes = elements(card);
  const textNodes = nodes.flatMap(node => node.children).filter(child => child.nodeType === 3);
  assert.equal(textNodes.filter(node => node.textContent === malicious).length, 1);
  assert.equal(nodes.filter(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0);
  assert.equal(nodes.some(node => Object.hasOwn(node.listeners, 'error')), false);
  assert.equal(card.dataset.url, malicious);
});

test('malicious result text cannot create DOM nodes or inline handlers', () => {
  const malicious = '"><script src=x></script><img onerror=alert(1)>';
  const card = createUrlCard({
    url: 'https://example.com/',
    last_result: {
      reachable: false,
      status_code: null,
      response_time: null,
      ssl: null,
      ssl_days: null,
      ssl_expiring: false,
      last_checked: '2026-09-25T12:00:00Z',
      error: malicious,
    },
  }, false, new FakeDocument());
  const nodes = elements(card);
  const textNodes = nodes.flatMap(node => node.children).filter(child => child.nodeType === 3);
  assert.equal(textNodes.filter(node => node.textContent === malicious).length, 1);
  assert.equal(nodes.filter(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0);
  assert.equal(nodes.some(node => Object.hasOwn(node.listeners, 'error')), false);
});

test('frontend never assigns HTML or caches the raw license key', async () => {
  const app = await readFile(appPath, 'utf8');
  assert.doesNotMatch(app, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(app, /window\._lic|_licVerified|license_key/);
  assert.doesNotMatch(app, /console\.(?:log|error|warn)\([^)]*license/i);
});
