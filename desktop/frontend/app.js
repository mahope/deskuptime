const BUY_URL = 'https://buy.stripe.com/7sY9AS9eX3Iu418fJ5bMQ01';
const bridge = typeof window === 'undefined' ? null : window.__TAURI__ ?? null;
const invoke = bridge?.core?.invoke;
const listen = bridge?.event?.listen;

let urls = [];
let checking = new Set();
let licensed = false;
let freeLimit = 3;
let licenseVerifiedAt = null;
let elements = null;

export function normalizeMonitoredUrl(entry) {
  return {
    url: String(entry?.url ?? ''),
    last_result: entry?.last_result ? { ...entry.last_result } : null,
  };
}

export function toCheckResultSummary(
  result,
  lastChecked = result?.timestamp ?? new Date().toISOString(),
) {
  const timing = Number.isFinite(result?.response_time_ms)
    ? `${result.response_time_ms}ms`
    : null;
  return {
    reachable: result?.reachable === true,
    status_code: result?.status_code ?? null,
    response_time: timing,
    ssl: result?.ssl == null ? null : true,
    ssl_days: result?.ssl?.valid_days ?? null,
    ssl_expiring: result?.ssl?.expires_soon === true,
    last_checked: lastChecked,
    error: result?.error ?? null,
  };
}

function appendText(documentRef, parent, value) {
  if (value !== null && value !== undefined && value !== '') {
    parent.append(documentRef.createTextNode(String(value)));
  }
}

function createResultLine(documentRef, className, value) {
  const line = documentRef.createElement('span');
  line.className = className;
  appendText(documentRef, line, value);
  return line;
}

function formatCheckedAt(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString();
}

function setChildren(element, ...children) {
  element.textContent = '';
  element.append(...children);
}

export function createUrlCard(entry, isChecking, documentRef) {
  const result = entry.last_result;
  const card = documentRef.createElement('article');
  card.className = 'url-card';
  card.dataset.url = entry.url;

  const layout = documentRef.createElement('div');
  layout.className = 'url-card-layout';

  const details = documentRef.createElement('div');
  details.className = 'url-card-details';

  const heading = documentRef.createElement('div');
  heading.className = 'url-heading';

  const statusDot = documentRef.createElement('span');
  statusDot.className = `status-dot ${isChecking ? 'is-checking' : result?.reachable ? 'is-up' : result ? 'is-down' : 'is-unchecked'}`;
  statusDot.setAttribute('aria-hidden', 'true');

  const urlText = documentRef.createElement('span');
  urlText.className = 'url-text';
  urlText.textContent = entry.url;
  urlText.title = entry.url;

  const removeButton = documentRef.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'icon-button remove-url';
  removeButton.dataset.url = entry.url;
  removeButton.setAttribute('aria-label', `Remove ${entry.url}`);
  removeButton.textContent = '×';

  heading.append(statusDot, urlText, removeButton);

  if (isChecking) {
    const checkingText = documentRef.createElement('p');
    checkingText.className = 'card-message is-checking-text';
    checkingText.textContent = 'Checking…';
    details.append(heading, checkingText);
  } else if (result) {
    const resultGrid = documentRef.createElement('div');
    resultGrid.className = 'result-grid';
    const statusText = result.reachable ? 'UP' : 'DOWN';
    resultGrid.append(
      createResultLine(documentRef, `result-status ${result.reachable ? 'is-up' : 'is-down'}`, statusText),
      createResultLine(documentRef, 'result-value', result.status_code ?? '—'),
      createResultLine(documentRef, 'result-value', result.response_time ?? '—'),
    );
    if (result.ssl != null) {
      resultGrid.append(createResultLine(
        documentRef,
        `result-value ${result.ssl_expiring ? 'is-warning' : ''}`,
        `SSL ${result.ssl_days ?? '?'} days`,
      ));
    }
    resultGrid.append(createResultLine(documentRef, 'result-time', formatCheckedAt(result.last_checked)));
    details.append(heading, resultGrid);
    if (result.error) {
      const error = documentRef.createElement('p');
      error.className = 'result-error';
      error.textContent = result.error;
      details.append(error);
    }
  } else {
    const pending = documentRef.createElement('p');
    pending.className = 'card-message';
    pending.textContent = 'Not checked yet. Use Check to run a manual check.';
    details.append(heading, pending);
  }

  const checkButton = documentRef.createElement('button');
  checkButton.type = 'button';
  checkButton.className = 'button button-small check-single';
  checkButton.dataset.url = entry.url;
  checkButton.textContent = 'Check';
  checkButton.disabled = isChecking;

  layout.append(details, checkButton);
  card.append(layout);
  return card;
}

function createEmptyState(documentRef) {
  const empty = documentRef.createElement('div');
  empty.className = 'empty-state';
  const title = documentRef.createElement('p');
  title.className = 'empty-title';
  title.textContent = 'No URLs monitored yet';
  const hint = documentRef.createElement('p');
  hint.className = 'empty-hint';
  hint.textContent = 'Add a URL to start monitoring.';
  empty.append(title, hint);
  return empty;
}

function collectElements() {
  elements = {
    urlList: document.getElementById('urlList'),
    addForm: document.getElementById('addForm'),
    urlInput: document.getElementById('urlInput'),
    btnAddUrl: document.getElementById('btnAddUrl'),
    btnAddConfirm: document.getElementById('btnAddConfirm'),
    btnAddCancel: document.getElementById('btnAddCancel'),
    btnCheckAll: document.getElementById('btnCheckAll'),
    intervalSelect: document.getElementById('intervalSelect'),
    monitorBadge: document.getElementById('monitorBadge'),
    appMessage: document.getElementById('appMessage'),
    licenseFree: document.getElementById('licenseFree'),
    licenseForm: document.getElementById('licenseForm'),
    licenseActive: document.getElementById('licenseActive'),
    licenseInput: document.getElementById('licenseInput'),
    licenseError: document.getElementById('licenseError'),
    licenseVerified: document.getElementById('licenseVerified'),
    btnShowLicense: document.getElementById('btnShowLicense'),
    btnActivate: document.getElementById('btnActivate'),
    btnCancelLicense: document.getElementById('btnCancelLicense'),
    btnDeactivate: document.getElementById('btnDeactivate'),
    licenseTitle: document.getElementById('licenseTitle'),
  };
}

function setHidden(element, hidden) {
  element.hidden = hidden;
  element.classList.toggle('hidden', hidden);
}

function setMessage(message, isError = false) {
  elements.appMessage.textContent = message;
  elements.appMessage.classList.toggle('is-error', isError);
}

function clearBanner() {
  document.getElementById('limitBanner')?.remove();
}

function showBanner(message) {
  clearBanner();
  const banner = document.createElement('div');
  banner.id = 'limitBanner';
  banner.className = 'inline-banner';
  banner.setAttribute('role', 'alert');
  const upgradeAt = message.indexOf('Upgrade to Pro');
  if (upgradeAt >= 0) {
    banner.append(document.createTextNode(`${message.slice(0, upgradeAt).trim()} `));
    const link = document.createElement('a');
    link.href = BUY_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Buy Pro for $19';
    banner.append(link);
  } else {
    banner.textContent = message;
  }
  elements.addForm.insertAdjacentElement('afterend', banner);
}

function showLicenseError(message) {
  elements.licenseError.textContent = message;
  setHidden(elements.licenseError, false);
  elements.licenseInput.focus();
}

function render() {
  if (urls.length === 0) {
    setChildren(elements.urlList, createEmptyState(document));
    return;
  }
  setChildren(
    elements.urlList,
    ...urls.map(entry => createUrlCard(entry, checking.has(entry.url), document)),
  );
}

function renderLicenseUI() {
  setHidden(elements.licenseFree, licensed);
  setHidden(elements.licenseForm, true);
  setHidden(elements.licenseActive, !licensed);
  if (licensed) {
    elements.licenseVerified.textContent = licenseVerifiedAt
      ? `Last verified ${licenseVerifiedAt.slice(0, 10)}`
      : 'Licensed on this machine';
  }
}

function applyLicenseState(license) {
  licensed = license?.active === true;
  licenseVerifiedAt = license?.validated_at ?? null;
  renderLicenseUI();
}

async function loadInterval() {
  try {
    const interval = await invoke('get_monitor_interval');
    elements.intervalSelect.value = String(interval);
  } catch (error) {
    setMessage(`Could not load the monitoring interval: ${String(error)}`, true);
  }
}

async function loadLicense() {
  try {
    freeLimit = await invoke('get_free_limit') || freeLimit;
    elements.licenseTitle.textContent = `DeskUptime Free (up to ${freeLimit} URLs)`;
    applyLicenseState(await invoke('get_license_state'));
  } catch (error) {
    setMessage(`Could not load the license status: ${String(error)}`, true);
  }
}

async function loadUrls() {
  try {
    const stored = await invoke('get_urls');
    urls = Array.isArray(stored) ? stored.map(normalizeMonitoredUrl) : [];
    render();
    if (urls.length > 0) void checkAll();
  } catch (error) {
    setMessage(`Could not load monitored URLs: ${String(error)}`, true);
  }
}

async function checkUrl(targetUrl) {
  const entry = urls.find(item => item.url === targetUrl);
  if (!entry) return;
  checking.add(targetUrl);
  render();
  try {
    let result;
    try {
      result = await invoke('check_url', { url: targetUrl });
    } catch (error) {
      result = {
        reachable: false,
        status_code: null,
        response_time_ms: null,
        ssl: null,
        error: String(error),
      };
    }
    const summary = toCheckResultSummary(result);
    try {
      const persisted = await invoke('update_url_result', { url: targetUrl, result: summary });
      const currentEntry = urls.find(item => item.url === targetUrl);
      if (currentEntry) {
        currentEntry.last_result = normalizeMonitoredUrl({ last_result: persisted }).last_result;
      }
    } catch {
      setMessage('The check completed, but its result could not be saved.', true);
    }
  } finally {
    checking.delete(targetUrl);
    render();
  }
}

async function checkAll() {
  for (const entry of [...urls]) {
    await checkUrl(entry.url);
  }
}

async function addUrl() {
  const input = elements.urlInput.value.trim();
  clearBanner();
  elements.urlInput.removeAttribute('aria-invalid');
  if (!input) {
    elements.urlInput.focus();
    return;
  }
  elements.btnAddConfirm.disabled = true;
  try {
    const canonicalUrl = await invoke('add_url', { url: input });
    urls.push({ url: canonicalUrl, last_result: null });
    elements.urlInput.value = '';
    setHidden(elements.addForm, true);
    render();
    await checkUrl(canonicalUrl);
  } catch (error) {
    elements.urlInput.setAttribute('aria-invalid', 'true');
    showBanner(String(error));
    elements.urlInput.focus();
  } finally {
    elements.btnAddConfirm.disabled = false;
  }
}

async function removeUrl(targetUrl) {
  try {
    await invoke('remove_url', { url: targetUrl });
    urls = urls.filter(entry => entry.url !== targetUrl);
    render();
  } catch (error) {
    setMessage(`Could not remove the URL: ${String(error)}`, true);
  }
}

async function activateLicense() {
  const key = elements.licenseInput.value.trim();
  setHidden(elements.licenseError, true);
  if (!key) {
    showLicenseError('Enter the license key from your purchase email.');
    return;
  }
  elements.licenseInput.value = '';
  elements.btnActivate.disabled = true;
  try {
    applyLicenseState(await invoke('activate_license', { licenseKey: key }));
  } catch (error) {
    showLicenseError(String(error));
  } finally {
    elements.btnActivate.disabled = false;
  }
}

async function deactivateLicense() {
  elements.btnDeactivate.disabled = true;
  try {
    await invoke('deactivate_license');
    applyLicenseState({ active: false, validated_at: null });
  } catch (error) {
    setMessage(`Could not deactivate the license: ${String(error)}`, true);
  } finally {
    elements.btnDeactivate.disabled = false;
  }
}

function bindEvents() {
  elements.btnAddUrl.addEventListener('click', () => {
    clearBanner();
    setHidden(elements.addForm, false);
    elements.urlInput.focus();
  });
  elements.btnAddCancel.addEventListener('click', () => {
    setHidden(elements.addForm, true);
    elements.urlInput.value = '';
    elements.urlInput.removeAttribute('aria-invalid');
    clearBanner();
  });
  elements.btnAddConfirm.addEventListener('click', () => void addUrl());
  elements.urlInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addUrl();
    }
  });
  elements.btnCheckAll.addEventListener('click', () => void checkAll());
  elements.urlList.addEventListener('click', event => {
    const checkButton = event.target.closest('.check-single');
    if (checkButton) {
      void checkUrl(checkButton.dataset.url);
      return;
    }
    const removeButton = event.target.closest('.remove-url');
    if (removeButton) void removeUrl(removeButton.dataset.url);
  });
  elements.intervalSelect.addEventListener('change', event => {
    void invoke('set_monitor_interval', { secs: Number.parseInt(event.target.value, 10) })
      .catch(error => setMessage(`Could not save the interval: ${String(error)}`, true));
  });
  elements.btnShowLicense.addEventListener('click', () => {
    setHidden(elements.licenseForm, false);
    elements.licenseInput.focus();
  });
  elements.btnCancelLicense.addEventListener('click', () => {
    elements.licenseInput.value = '';
    setHidden(elements.licenseError, true);
    setHidden(elements.licenseForm, true);
  });
  elements.btnActivate.addEventListener('click', () => void activateLicense());
  elements.btnDeactivate.addEventListener('click', () => void deactivateLicense());
}

async function init() {
  collectElements();
  if (!invoke || !listen) {
    setMessage('The DeskUptime desktop bridge is unavailable. Reopen the app from DeskUptime.', true);
    elements.btnAddUrl.disabled = true;
    elements.btnCheckAll.disabled = true;
    return;
  }
  bindEvents();
  await listen('monitor-results', event => {
    const payload = event.payload;
    if (Array.isArray(payload?.urls)) {
      urls = payload.urls.map(normalizeMonitoredUrl);
      render();
    }
  });
  await listen('license-changed', () => void loadLicense());
  await listen('status-changed', () => {
    elements.monitorBadge.textContent = 'Status change detected — see notification';
    setHidden(elements.monitorBadge, false);
    window.setTimeout(() => setHidden(elements.monitorBadge, true), 8000);
  });
  await Promise.all([loadUrls(), loadLicense(), loadInterval()]);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
  } else {
    void init();
  }
}
