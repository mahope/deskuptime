/**
 * watch.js — background monitoring loop for the deskuptime CLI
 *
 * Stores state in ~/.deskuptime/state.json (content hashes + last status),
 * prints status changes to the terminal, and (Pro) sends system notifications.
 *
 * Free tier: up to 3 URLs, 60s minimum interval.
 * Pro tier (activated license): unlimited URLs, intervals down to 30s,
 * desktop notifications via osascript (macOS) where available.
 * Those numbers come from src/features.js — the same source the README,
 * --help and docs/pro-alerts.md matrix are generated from.
 */

import { checkUrl } from './engine.js';
import { activateLicense, refreshLicense, normalizeLicense, describeLicense, proGateMessage, LICENSE_STATUS, PRO_STATUSES } from './license.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, statSync, chmodSync } from 'fs';
import { dirname, posix, win32 } from 'path';
import { homedir } from 'os';
import { createHash, randomUUID } from 'crypto';
import { assertValidHttpUrls, expiredNote, findUrlKey, isNewerPass, partitionUsableUrls, readCertIdentity, readCertRotation, readCertRotationAlert, readContentChange, readContentChangeAlert, readEntry, readEvent, readRedirectTarget, readSslIssuer, readTransitionAlert, queuedAgeMs, readSslState, STALE_AFTER_DAYS, unusableUrlNote, urlIdentity, withoutCredentials } from './status.js';
import { recordPass } from './report.js';
import { formatMs, safeText } from './display.js';
import { historyFileFrom, pruneHistory, readHistoryFile, recordHistoryPass, saveHistory, historyWriteErrorMessage } from './history.js';
import { FREE, PRO, PRODUCT } from './features.js';

const LICENSE_RECHECK_MS = 24 * 60 * 60 * 1000;
const STATE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 10_000;
// How many times one alert may be POSTed, and how long to wait between the
// attempts. Measured 2026-09-26: one 5xx from the receiver lost the alert for
// good, because the pass had already latched the change. Every attempt shares
// WEBHOOK_TIMEOUT_MS, so these bounds cannot make the loop slower than it was.
export const WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_RETRY_DELAY_MS = 500;
// An alert the receiver never took is kept instead of being lost, and tried again
// on the next pass — measured 2026-09-26: a receiver answering 503 through the
// whole budget got three attempts, and then the alert was gone for good, because
// the pass had latched the change, the next pass raised no event, and the state
// file held no memory of it. Bounded on all three axes, so an outage that never
// ends cannot grow the state file or the work per pass. See docs/pro-alerts.md §2.
export const OUTBOX_LIMIT = 20;
export const OUTBOX_MAX_AGE_MS = 30 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 3;
const OUTBOX_MESSAGE_MAX = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a receiver's own answer is worth asking again.
 *
 * 5xx is the receiver failing at its own end, 429 is it asking for time. Every
 * other non-2xx is a verdict — a dead token, a URL that no longer exists, a
 * payload it refuses — and asking a second time cannot change the answer, so a
 * misconfigured webhook fails in milliseconds instead of three times.
 */
function webhookRetryable(status) {
  return status === 429 || status >= 500;
}
// The limits and the buy link live in src/features.js, so the free/Pro claims in
// README, --help and docs/pro-alerts.md cannot drift from what is enforced here.
export const PRO_BUY_URL = PRODUCT.buyUrl;

/**
 * One upgrade path, used wherever a free user hits a Pro-only limit.
 * Kept in sync with docs/pro-alerts.md and docs/agency-report.md.
 */
export function upgradeHint(feature) {
  return `Pro unlocks ${feature}: ${PRO_BUY_URL} — then "deskuptime activate <key>".`;
}

/**
 * The single free-tier refusal, so `--once` and the watch loop tell the user the
 * same thing — including where to buy Pro.
 */
export function freeLimitMessage(url) {
  return `Free tier monitors ${FREE.urlLimit} URLs. ${url} not added. ${upgradeHint(`unlimited URLs and a ${PRO.minIntervalSeconds}s interval`)}`;
}

/**
 * One sentence for "you asked for a faster interval than this tier runs".
 *
 * Measured 2026-09-27 with the real CLI: a free user who typed `--interval 30`
 * — the exact value the matrix and `upgradeHint` above advertise as the Pro one
 * — got a silent 60s and nothing else. The other two Pro walls (the URL limit
 * and `--webhook`) both name the upgrade path, so the interval was the only Pro
 * limit the product refused in silence, and silence is the worst answer here:
 * the user typed what the sales page says and the tool disagreed without saying
 * so.
 *
 * A paying customer who asks below Pro's own minimum gets the same honesty
 * without the checkout — they have paid, and a second buy link there is the
 * reply P1-19 exists to prevent.
 */
export function intervalRaisedMessage(asked, minInterval, { pro = false } = {}) {
  const floor = pro
    ? `below the ${minInterval}s minimum for Pro`
    : `below the free tier's ${minInterval}s minimum`;
  const raised = `--interval ${asked} is ${floor}, so this loop runs every ${minInterval}s instead.`;
  return pro ? raised : `${raised} ${upgradeHint(`a ${PRO.minIntervalSeconds}s interval`)}`;
}

export function getStateFile({ env = process.env, platform = process.platform } = {}) {
  const home = platform === 'win32'
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || homedir();
  const path = platform === 'win32' ? win32 : posix;
  return path.join(home, '.deskuptime', 'state.json');
}

function emptyState() {
  return { urls: {} };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.urls || typeof value.urls !== 'object' || Array.isArray(value.urls)) {
    return emptyState();
  }
  const urls = Object.fromEntries(
    Object.entries(value.urls).filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry)),
  );
  const state = { ...value, urls };
  // A license record is only trusted if it validates: a hand-edited or
  // half-written state file must not hand out Pro, and must not crash the CLI.
  const license = normalizeLicense(state.license);
  if (license) state.license = license;
  else delete state.license;
  // Undelivered alerts are read the same defensive way, and only through the
  // field list below: a restored or hand-edited file must not be able to put
  // anything else in the outbox — a webhook URL is a token, and this file is
  // copied around more than the user thinks.
  const outbox = normalizeOutbox(state.outbox);
  if (outbox.length > 0) state.outbox = outbox;
  else delete state.outbox;
  return state;
}

function stateFileFrom(options) {
  return options.stateFile || getStateFile(options);
}

function unreadableStateFile(stateFile) {
  if (!existsSync(stateFile)) return null;
  try {
    JSON.parse(readFileSync(stateFile, 'utf-8'));
    return null;
  } catch (error) {
    return { code: error?.code || 'invalid JSON' };
  }
}

/**
 * A state file we cannot write is a fact the user has to see — and it is not a
 * reason to stop monitoring.
 *
 * Measured 2026-09-26 with the real CLI, a real `--webhook` receiver and a
 * `~/.deskuptime` that could not be written (a full disk, a read-only mount or
 * a quota — here an immutable directory, so the errno is EPERM and nothing else
 * was touched): the process died with a raw Node stack trace, exit 1, and the
 * receiver got **zero** deliveries while a monitored site answered 500. The
 * throw came out of `saveState()` — first from `recheckLicense()` before the
 * loop had even started, and from `runPass()` once it had. So the customer who
 * pays for alerts got none, learned nothing except a stack trace naming a temp
 * file, and their monitoring was over.
 *
 * The state file holds the counters; the events hold the alert. When only the
 * first can be written, the second is the one worth keeping — the same rule
 * `saveHistory()` below already follows for the same reason, and the same
 * comment. What is lost is named here and in the message: this pass's counters
 * and its day in the report, until the file can be written again. In the loop
 * the in-memory entry survives, so a site that stays down is not re-announced
 * every interval; across a restart it is, because without a saved verdict we
 * cannot know it was already said. Announcing twice beats staying silent about
 * an outage.
 *
 * One owner for the sentence, so the loop, a `--once` pass and a license
 * re-check cannot each describe the same failure differently.
 */
/**
 * One sentence for "DeskUptime cannot write its own state", so a cron pass, a
 * running loop and `unwatch` cannot each hand the user a different stack trace.
 * It names the file and the errno because those are the two things the user can
 * act on, and says what is broken — nothing is remembered — rather than leaving
 * it to be guessed from a temp filename.
 */
export function stateWriteErrorMessage(error, stateFile) {
  // A file we cannot read is not a write problem, and saying "check free disk
  // space" about a truncated file sends the user to the wrong place. Same
  // owner as the surfaces that only read it, so the loop and `status` cannot
  // describe one broken file three ways.
  if (error?.code === ESTATE_UNREADABLE) return stateReadErrorMessage(error.readError, stateFile);
  return `Could not write the monitoring state — ${error?.code || error?.message || 'unknown error'} — ${stateFile}. Nothing is remembered while this lasts: check free disk space and that the file and its folder are writable.`;
}

export const ESTATE_UNREADABLE = 'ESTATEUNREADABLE';

/**
 * One sentence for "the state file is there and cannot be parsed", so a cron
 * pass, a running loop, `status`, `watch --status` and the report gate cannot
 * each describe the same file differently.
 *
 * This file holds the license key and the monitored URLs, so it is the one file
 * a user must never lose and the one file we must never silently write over: a
 * truncated file still has the readable prefix that holds the key, and a
 * half-written state that gets overwritten takes a paid license with it. The
 * sentence therefore names the file, says that nothing is written over it and
 * nothing is reported from it, and gives the one command that fixes it without
 * destroying anything — `mv`, never `rm`.
 */
export function stateReadErrorMessage(error, stateFile) {
  const why = error?.code === 'ENOENT' ? 'file not found' : (error?.code || 'invalid JSON');
  return `DeskUptime cannot read the monitoring state — ${why} — ${stateFile}. It may still hold your license key and your monitored URLs, so nothing is written over it and nothing is reported from it. Move it aside to start clean: mv "${stateFile}" "${stateFile}.broken" — then run: deskuptime activate <license-key>`;
}

function saveStateOrWarn(state, options, what) {
  try {
    saveState(state, options);
    return true;
  } catch (error) {
    console.error(`⚠️  ${stateWriteErrorMessage(error, stateFileFrom(options))}`);
    console.error(`    ${what}`);
    return false;
  }
}

/**
 * The state file, and whether it could be read at all.
 *
 * An unreadable file used to be an empty one: every command reported "0 URLs",
 * the free tier and the checkout, and the first command that saved wrote a fresh
 * file over the old one — taking a paid license key with it. So the reason is
 * returned next to the state instead of being swallowed here, and the callers
 * that can act on it (the ones that report, and the one that writes) do.
 */
export function readStateFile(options = {}) {
  const stateFile = stateFileFrom(options);
  if (!existsSync(stateFile)) return { state: emptyState(), unreadable: null };
  try {
    return { state: normalizeState(JSON.parse(readFileSync(stateFile, 'utf-8'))), unreadable: null };
  } catch (error) {
    return { state: emptyState(), unreadable: { code: error?.code || 'invalid JSON', stateFile } };
  }
}

export function loadState(options = {}) {
  return readStateFile(options).state;
}

/**
 * What this process last wrote to the state file: when, and which URLs.
 *
 * A running loop is the one process that keeps its own copy of the state, so
 * this is what lets it tell its own past from somebody else's present. Another
 * writer — `unwatch`, a `watch --once` cron pass, a restore — leaves a file that
 * is *newer* than our last write; a URL we ourselves wrote and the file no
 * longer has was then removed on purpose. See mergePersistedState().
 *
 * A write that failed is deliberately not recorded: the file on disk is then
 * older than we think, so the loop keeps its own truth and monitoring survives
 * an unwritable state file (P1-39).
 */
let lastWrite = { ms: 0, urls: null };

/**
 * State holds the license key and the monitored URLs, so it is written 0600
 * inside a 0700 directory, and swapped in atomically: a crash mid-write can
 * never leave a truncated state file behind.
 */
export function saveState(state, options = {}) {
  const stateFile = stateFileFrom(options);
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* pre-existing dir we may not own */ }
  }
  // Never write over a state file we could not read. A truncated or corrupt file
  // is exactly where a paid license key survives — the key sits in the readable
  // prefix of a file whose tail was lost — and a fresh save would replace that
  // prefix with an empty one, so the customer is left on the free tier holding
  // no key and no way back but their inbox. The caller gets the read sentence
  // (stateWriteErrorMessage maps this code), and the user keeps the file.
  const unreadable = unreadableStateFile(stateFile);
  if (unreadable) {
    const error = new Error(stateReadErrorMessage(unreadable, stateFile));
    error.code = ESTATE_UNREADABLE;
    error.readError = unreadable;
    throw error;
  }
  const temporaryFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporaryFile, stateFile);
    if (process.platform !== 'win32') chmodSync(stateFile, 0o600);
    lastWrite = { ms: stateFileMtimeMs(stateFile), urls: new Set(Object.keys(state.urls || {})) };
  } catch (error) {
    try { unlinkSync(temporaryFile); } catch {}
    throw error;
  }
}

/**
 * When the state file itself was last modified, or 0 when it is not there or
 * cannot be read. 0 is deliberately the "we know nothing" answer: it is older
 * than any write we ever recorded, so an unknown file is never treated as
 * somebody else's news.
 */
export function stateFileMtimeMs(stateFile) {
  try {
    return statSync(stateFile).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Pro requires a *usable* license: a valid record that the server has not
 * rejected. A cached (offline) license still counts as Pro, an unverified or
 * invalidated one does not — so a rejected or long-unreachable key loses its
 * entitlements on the next pass instead of on the next reinstall. The check is
 * an allow-list plus the legacy case, so a new status can never hand out Pro by
 * accident while an installation that predates the status field keeps working.
 */
export function isPro(state, { now = Date.now() } = {}) {
  // `describeLicense` is the one reading of a stored license, and it is the one
  // `deskuptime status` prints. It used to read `license.status` here instead,
  // which meant the gate and the status line could disagree about the same
  // record: a key stored as `active` 41 days ago got Pro in the gate while
  // `status` said the server had not confirmed it for over a month. Ask instead.
  return PRO_STATUSES.includes(describeLicense(state?.license, { now }).status);
}

function hashContent(str) {
  return createHash('sha256').update(str).digest('hex');
}

function fmtNow() {
  return new Date().toLocaleTimeString();
}

/**
 * One monitoring pass over all tracked URLs.
 * Returns list of change events: [{ url, type: 'up'|'down'|'ssl_warning'|'ssl_expired'|'content_changed', message }]
 */
export async function runPass(state, opts = {}) {
  const events = [];
  const urls = Object.keys(state.urls);
  // A key in the saved list that is not an address is skipped and named, not
  // fatal: measured 2026-09-26, one `kunde.dk` among 25 working keys threw
  // `TypeError: Invalid URL` out of runPass and startWatch before the first
  // request, so the pass exited 1 with no output and the other 24 sites were
  // never checked — on the cron path, where the user only ever sees a stack
  // trace in the mail. See partitionUsableUrls() for the measurement.
  const { usable, unusable } = partitionUsableUrls(urls);
  if (unusable.length > 0) {
    console.error(`⚠️  ${unusableUrlNote(unusable, { checked: usable.length })}`);
  }
  const check = opts.check || checkUrl;
  // Daily counters for the client report's "last 30 days" column. Recorded for
  // every tier: history is two integers per site per day, and a free user who
  // upgrades should not start a 30-day report with an empty month.
  const now = opts.now instanceof Date ? opts.now : new Date();
  // The reason comes with the history, because the save at the end of this pass
  // is the one that would replace an unreadable file with a single day (P1-48).
  const { history } = readHistoryFile(opts);

  const results = await Promise.all(usable.map((url) => {
    const entry = state.urls[url];
    return check(url, { contentHash: entry.lastHash || null });
  }));

  for (let index = 0; index < results.length; index++) {
    const url = usable[index];
    const entry = state.urls[url];
    const result = results[index];
    // The previous verdict, read through readEntry() like every other surface.
    // This used to compare the raw `entry.wasUp` to `true`/`false` itself, so a
    // hand-edited, restored or half-written `wasUp: "yes"` (or `1`, or "false")
    // matched none of the three branches below and the pass produced *no event
    // at all* — and since notify() and sendWebhook() fire only from events, a
    // paying customer got no desktop notification and no webhook about a site
    // that was down, while the terminal said "remains DOWN" on the same pass.
    const previous = readEntry(entry).verdict;
    // The time of the pass this one is compared against, and this pass's own
    // time. Both are the raw truth of what was measured; what they *mean* is
    // readEvent()'s decision, so the terminal, the desktop notification and the
    // webhook payload cannot each reach their own conclusion about it. Before
    // this the payload carried no time at all except the moment its POST body was
    // built, and a `up` event compared against a 41-day-old reading still said
    // "is UP" as if DeskUptime had watched the site come back.
    const previousChecked = entry.lastChecked;
    const measuredAt = result.timestamp || new Date().toISOString();
    // Every event carries the two raw facts; the branch that knows its own type
    // asks readEvent() what they mean, and so does the payload for the same
    // event — with the pass's own time as the reference, so the sentence in
    // `message` and the `transition` word can never disagree.
    const event = (type, message) => ({ url, type, message, measuredAt, previousChecked, finalUrl: result.finalUrl ?? null });
    // A baseline is "this site has never been checked", not "the last verdict
    // is unreadable" — an entry that already has a pass behind it must not be
    // announced as a first observation, and its DOWN state must reach the
    // customer. wasUp is rewritten from the fresh result at the end of the
    // pass, so the entry repairs itself and the alert is not repeated.
    const firstPass = previous === 'unknown' && !entry.lastChecked;
    // The transitions this pass measured, before the question of whether they
    // are *announced*: a baseline is not one, and `down`/`up` are decided
    // together so the two read the site's flapping the same way.
    const transitions = [];

    if (firstPass) {
      const status = result.healthy ? 'UP' : 'DOWN';
      const detail = result.healthy
        ? ` (${result.statusCode}) — ${formatMs(result.responseTimeMs)}`
        : result.error ? ` — ${result.error}` : '';
      events.push(event('baseline', `baseline recorded: ${status}${detail}`));
    } else if (result.healthy && previous === 'down') {
      // "is UP" is a claim about a change, and this pass may not be the one that
      // saw it: the loop can have been dead for weeks. The owner decides whether
      // the reading behind the claim is recent enough to stand on.
      const { note } = readEvent({ type: 'up', measuredAt, previousChecked });
      transitions.push({ type: 'up', message: `is UP (${result.statusCode}) — ${formatMs(result.responseTimeMs)}${note ? ' ' + note : ''}` });
    } else if (!result.healthy && (previous === 'up' || previous === 'unknown')) {
      // An unreadable previous verdict cannot prove a transition, but the site
      // is down *now* and the customer is paying to hear about it. Silence here
      // is the bug; the wording claims nothing about when it broke. The note
      // names the age of the *previous* check, never the moment it broke.
      const { note } = readEvent({ type: 'down', measuredAt, previousChecked });
      transitions.push({ type: 'down', message: `is DOWN${result.error ? ' — ' + result.error : ''}${note ? ' ' + note : ''}` });
    }

    // Whether an alert about the site's *condition* is sent is a third question,
    // and it has one owner too: a site that flaps — up, down, up, down — raises
    // a transition on every pass, and every transition used to become an alert,
    // a POST to the paid channel and a desktop notification 30 s apart for as
    // long as the loop ran. Measured 2026-09-27: six alerts out of eight passes,
    // 5 760 a day at the shortest Pro interval, per site — the same harm as the
    // content flood one class over, and the fix is deliberately NOT the same
    // rule: a customer buys this to hear the moment a site breaks, so a plain
    // per-window cap could spend that window in silence on a real outage. The
    // throttle only engages on a site that is already flapping. See
    // readTransitionAlert(). The transition itself is recorded either way, so
    // the state file and the report count it whether or not it was announced.
    if (transitions.length > 0) {
      for (const transition of transitions) {
        const alerted = readTransitionAlert({
          type: transition.type,
          message: transition.message,
          recentAt: entry.transitions,
          previousAlertedAt: entry.transitionAlerts?.[transition.type]?.at ?? null,
          counted: entry.transitionAlerts?.[transition.type]?.held ?? 0,
          now,
        });
        if (alerted) {
          events.push(event(transition.type, alerted.message));
          entry.transitionAlerts = {
            ...entry.transitionAlerts,
            [transition.type]: { at: now.toISOString(), held: 0 },
          };
        } else {
          // Held, not dropped: the count rides on the next alert that is sent.
          const previous = entry.transitionAlerts?.[transition.type] ?? {};
          entry.transitionAlerts = {
            ...entry.transitionAlerts,
            [transition.type]: { at: previous.at ?? null, held: (Number.isInteger(previous.held) ? previous.held : 0) + 1 },
          };
        }
        // When it happened is kept, so "how often has this site flapped" is
        // measured from the file rather than assumed. The owner prunes the list
        // to its own window and caps it, so a site that flaps for a week cannot
        // grow the state file — and the pass never ages a time itself.
        if (alerted) entry.transitions = alerted.transitions;
        else entry.transitions = [...(Array.isArray(entry.transitions) ? entry.transitions : []), now.toISOString()].slice(-24);
      }
    }


    // Where the answer came from. The engine measured this on every pass and the
    // state file threw it away, so `watch --status`, `status` and the client
    // report all read a site that another host had answered as a plain `UP` —
    // the four paid surfaces `check` could not name (P1-27). Asked of the one
    // owner, kept as a raw fact, and announced once per change: a domain that
    // stays parked must not send a paying customer a notification every minute,
    // which is why this is latched the way the SSL warning is, and why the latch
    // key is the *host* that answered rather than the URL (a redirect path can
    // change every pass — a signed link, a rotating path — and that is not news).
    const redirect = readRedirectTarget({ url, finalUrl: result.finalUrl });
    if (redirect.finalUrl) entry.lastFinalUrl = redirect.finalUrl;
    else delete entry.lastFinalUrl;
    if (redirect.offHost) {
      if (entry.answeredBy !== redirect.answeredHost) {
        events.push(event('redirect', redirect.note));
      }
      entry.answeredBy = redirect.answeredHost;
    } else {
      delete entry.answeredBy;
    }

    // One reading of the certificate, so the event, the persisted entry and
    // every later report agree. The writer used `Number.isFinite(validDays)`
    // alone — a weaker gate than every reader had — so a negative day count was
    // announced as "SSL expires in -3 days ⚠️", pushed to the desktop
    // notification and the customer's webhook, and persisted into every report
    // afterwards. A lapsed certificate is now its own event and its own fact.
    const ssl = readSslState({
      days: result.ssl?.validDays,
      expired: result.ssl?.isExpired,
      expiredDays: result.ssl?.expiredDays,
    });
    if (ssl.expired) {
      delete entry.sslValidDays;
      entry.sslExpired = true;
      if (ssl.expiredDays !== null) entry.sslExpiredDays = ssl.expiredDays;
      if (entry.sslExpiredWarned !== true) {
        events.push(event('ssl_expired', `SSL certificate ${expiredNote(ssl.expiredDays)} 🔴`));
        entry.sslExpiredWarned = true;
      }
      entry.sslWarned = false;
    } else if (ssl.days !== null) {
      delete entry.sslExpired;
      delete entry.sslExpiredDays;
      entry.sslExpiredWarned = false;
      entry.sslValidDays = ssl.days;
      const warningActive = entry.sslWarned === true || typeof entry.sslWarned === 'number';
      if (ssl.expiringSoon && !warningActive) {
        events.push(event('ssl_warning', `SSL expires in ${ssl.days} days ⚠️`));
        entry.sslWarned = true;
      } else if (!ssl.expiringSoon) {
        entry.sslWarned = false;
      }
    } else {
      delete entry.sslValidDays;
      delete entry.sslExpired;
      delete entry.sslExpiredDays;
      entry.sslExpiredWarned = false;
    }

    // Is this still the certificate the customer had? The serial number and the
    // certificate hash have been measured on every SSL check since P0-3 and
    // nothing could read them, so a domain handed to a new owner — a hijack, an
    // expired domain that got bought — answered 200 with a valid certificate and
    // every surface called it healthy: the countdown counted down, the issuer
    // was named, the coverage matched. None of those three can see that the
    // certificate is a different one. The comparison and its sentence come from
    // the one owner, and the alert is only for a real rotation: a first reading
    // is a baseline, not an event, exactly as a first reading of the page is.
    const identity = readCertIdentity(result.ssl);
    // Who issued the certificate that answered. `readSslIssuer` has measured this
    // since P1-53 and only `check` ever asked, so nothing stored it: the client's
    // report could not answer "who issues my certificate?" — and could not see
    // the one thing that separates a renewal from a domain that changed hands, an
    // authority that is not the one the customer had. Measured 2026-09-27, real
    // passes and a real report: the document said `🔑 certificate replaced` and
    // had no idea where the new certificate came from. Stored below, next to the
    // identity it belongs to; the comparison is made before it is overwritten.
    const issuer = readSslIssuer(result.ssl);
    if (identity?.fingerprint) {
      const rotation = readCertRotation({
        fingerprint: identity.fingerprint,
        baselineFingerprint: entry.lastCertFingerprint,
        seenAt: entry.lastCertSeenAt,
        now,
      });
      if (rotation.compared && rotation.rotated) {
        // Whether the rotation is *sent* is a second question, and it has one
        // owner too: a name that answers with one certificate on one server and
        // another on the next is a rotation on every pass, and every rotation
        // used to become an alert — a POST to the paid channel and a desktop
        // notification every 30 s, for as long as the loop ran. Measured
        // 2026-09-27; see readCertRotationAlert(). The comparison still runs on
        // every pass, and the rotation below is still written on every pass:
        // this decides what a customer *hears*, not what is true.
        const alert = readCertRotationAlert({
          rotation,
          previousAlertedAt: entry.certAlertedAt,
          counted: entry.certRotationsHeld,
          now,
        });
        if (alert) {
          events.push(event('cert_rotated', alert.message));
          entry.certAlertedAt = now.toISOString();
          entry.certRotationsHeld = 0;
        } else {
          // Held, not dropped: the count rides on the next alert that is sent.
          entry.certRotationsHeld = (Number.isInteger(entry.certRotationsHeld) ? entry.certRotationsHeld : 0) + 1;
        }
        // When the certificate last changed. The line above is the alarm; this is
        // the *fact*, and it is the only copy that survives: the pass overwrites
        // `lastCertFingerprint` with the new identity, so measured 2026-09-27, a
        // state file 1 d after a domain changed owner was byte-for-byte
        // indistinguishable from one where nothing had ever happened — and the
        // client report, the document a bureau forwards, said `UP (200) | 100%`
        // about both. Same rule as the page (`lastContentChangedAt`, P1-56), and
        // for the same reason it cannot ride on the alert above: a throttle that
        // dropped the fact would take the knowledge out of the report, which is
        // where P1-61 put it.
        entry.lastCertRotatedAt = measuredAt;
      }
      // …and whether the certificate now answers from a *different* authority than
      // the one the customer had. A routine renewal keeps its issuer, so this is
      // the difference between "the certificate was replaced" and "something else
      // vouches for this name now" — and it can only be seen against the issuer of
      // the pass before, which is why it is stamped here and not derived later.
      // No earlier issuer means no claim: the first reading establishes the
      // baseline, exactly as the first certificate reading does.
      //
      // The comparison stands on its own rather than riding on the rotation above.
      // A different authority does mean a different certificate in the real world,
      // so the two almost always happen together — but a fact that is only written
      // inside a branch is a fact that silently disappears when a reading takes the
      // other path, and the price of the comparison is one string.
      if (issuer && entry.sslIssuer && entry.sslIssuer !== issuer) {
        entry.certIssuerBefore = entry.sslIssuer;
        entry.certIssuerChangedAt = measuredAt;
      }
      entry.lastCertFingerprint = identity.fingerprint;
      entry.lastCertSeenAt = measuredAt;
      if (identity.serial) entry.lastCertSerial = identity.serial;
      // The issuer of the certificate that answered *now* — written on every pass,
      // so the next one can compare against it and a later reader can name who
      // issued what the report counts down from. A certificate that reported no
      // issuer leaves the previous one alone rather than blanking it: an unnamed
      // certificate is not an unnamed authority, and forgetting the last known
      // one would destroy the comparison.
      if (issuer) entry.sslIssuer = issuer;
    }

    if (result.content?.changed === true) {
      // The sentence, the title and the size are all one decision, asked of the
      // one owner. This used to be built here from two numbers, which printed
      // `124 → 124 bytes` for a change whose two sides are the same size.
      const change = readContentChange({
        previousLength: entry.lastContentLength,
        length: result.content.contentLength,
        previousTitle: entry.lastTitle,
        title: result.content.title,
      });
      // Whether the change is *sent* is a second question, and it has one owner
      // too: a page that renders a per-request value (a CSRF nonce, a
      // cache-buster, a live counter) differs on every pass, and every difference
      // used to become an alert — a POST to the paid channel and a desktop
      // notification every 30 s, forever. Measured 2026-09-26; see
      // readContentChangeAlert(). The change itself is still hashed, counted and
      // written on every pass, and the first change after a quiet hour is sent
      // as before, so a defaced or redesigned page is still reported.
      const alert = readContentChangeAlert({
        change,
        previousAlertedAt: entry.contentAlertedAt,
        counted: entry.contentChangesHeld,
        now,
      });
      if (alert) {
        events.push(event('content_changed', alert.message));
        entry.contentAlertedAt = now.toISOString();
        entry.contentChangesHeld = 0;
      } else {
        // Held, not dropped: the count rides on the next alert that is sent.
        entry.contentChangesHeld = (Number.isInteger(entry.contentChangesHeld) ? entry.contentChangesHeld : 0) + 1;
      }
    }

    // The same reading of this pass's time the events carry, so the state file
    // and the alert a customer receives cannot disagree about when it ran.
    entry.lastChecked = measuredAt;
    entry.wasUp = result.healthy;
    entry.lastStatus = result.statusCode;
    // Uptime counters for the client report. Two integers per URL, so the
    // state file cannot grow with the length of the monitoring history.
    recordPass(entry, result);
    recordHistoryPass(history, url, result, { now });
    if (result.content?.hash) entry.lastHash = result.content.hash;
    if (Number.isFinite(result.content?.contentLength)) entry.lastContentLength = result.content.contentLength;
    // When the page was last *read*, separate from when it last *changed*. The
    // two are different facts and the report needs both: `content.js` skips a
    // page over 2 MiB, so a byte count can survive a pass that never looked at
    // the body, and a report that printed it as a measurement of this check was
    // quoting a pass it could not name. Stamped only where a hash was actually
    // written, so it can never be newer than the hash it belongs to.
    if (result.content?.hash) entry.lastContentReadAt = measuredAt;
    // When the page last changed, whether or not the alert was sent. The
    // throttle above decides what a *customer hears*; this is what *happened*,
    // and a throttled change was still a change — measured 2026-09-27, where a
    // page rewritten while the hour-long gap was open left no trace anywhere the
    // client report could read, so the document a bureau forwards said `UP (200) |
    // 100%` about a page that had been replaced.
    if (result.content?.changed === true) entry.lastContentChangedAt = measuredAt;
    // The title, so the next pass can say *what* changed and not only that the
    // bytes differ. `content.js` has always measured it; this is the first
    // surface to keep it. Only overwritten when the page still offers one, so a
    // pass that could not read a title does not erase the last real one.
    if (typeof result.content?.title === 'string' && result.content.title.trim() !== '') entry.lastTitle = result.content.title.trim();
  }

  // The counters go to disk here; the alerts this pass just produced are already
  // decided. A write that fails must not take them with it — see saveStateOrWarn.
  const stateSaved = saveStateOrWarn(state, opts, 'Monitoring and alerts keep working, but this pass is not remembered: the uptime counters and the report will miss it until the file can be written again.');
  try {
    // Pruned on write, so the history file is bounded no matter how long the
    // loop runs. A failure here must never take down monitoring: the state file
    // above is the source of truth, and a missing day only costs the report one
    // column, while a throw here would stop every URL from being checked.
    saveHistory(pruneHistory(history, { now }), opts);
  } catch (error) {
    console.error(`⚠️  ${historyWriteErrorMessage(error, historyFileFrom(opts))}`);
  }
  const pass = {
    events,
    results,
    // `[] .every()` is true, so a list of nothing but unusable keys would have
    // reported a green pass for a pass that measured nothing — the one thing
    // this tool must never do. A pass over at least one address keeps the
    // ordinary rule; a pass that had addresses and could check none of them is
    // not healthy, so a cron job's exit code still says "look at me".
    healthy: urls.length > 0 && results.length === 0 ? false : results.every(result => result.healthy),
    // False when the pass ran but could not be written — the caller can say so
    // instead of inferring it from a missing counter.
    stateSaved,
  };
  return opts.returnResults ? pass : events;
}

// One owner of the event vocabulary. Measured 26/9 with the real CLI and a real
// receiver: a paid channel receives down, up, redirect, ssl_warning, ssl_expired
// and content_changed — and docs/pro-alerts.md §2, the contract a Slack/Discord
// adapter is written against, named five of them. The icon table was a second,
// hand-kept copy of the same list, and `eventIcon`'s `|| '•'` fallback made a
// sixth type render as an ordinary bullet instead of failing. The spec and the
// sender are now locked to this list by test/webhook.test.js.
const EVENT_ICONS = {
  down: '🚨',
  up: '✅',
  baseline: '•',
  redirect: '🔀',
  ssl_warning: '⚠️ ',
  ssl_expired: '🔴 ',
  content_changed: '🔄',
  cert_rotated: '🔑 ',
};

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_ICONS));

// `baseline` is a first observation, not a change: the loop never POSTs it, and
// the spec says so. Everything else is delivered exactly as the loop raises it.
export const WEBHOOK_EVENT_TYPES = Object.freeze(EVENT_TYPES.filter(type => type !== 'baseline'));

function eventIcon(type) {
  return EVENT_ICONS[type] || '•';
}

export function printPass(pass, { alertUnchangedDown = true } = {}) {
  // The URL and the error text printed next to a DOWN line come from the site
  // being watched, so they are flattened to one inert line each: a server that
  // sends escape sequences must not be able to repaint our own output.
  for (const event of pass.events) {
    console.log(`[${fmtNow()}] ${eventIcon(event.type)} ${safeText(event.url, { max: 0 })} ${safeText(event.message, { max: 0 })}`);
  }

  const reported = new Set(pass.events.filter(event => event.type === 'down' || event.type === 'baseline').map(event => event.url));
  if (!pass.healthy) {
    for (const result of pass.results) {
      if (result.healthy || reported.has(result.url)) continue;
      const message = alertUnchangedDown ? 'is DOWN' : 'remains DOWN';
      console.log(`[${fmtNow()}] ${alertUnchangedDown ? '🚨' : '·'} ${safeText(result.url, { max: 0 })} ${message}${result.error ? ' — ' + safeText(result.error, { max: 0 }) : ''}`);
    }
  } else if (pass.events.length === 0) {
    console.log(`[${fmtNow()}] ✓ all monitored sites OK`);
  }
}

const VERDICT_ICON = { up: '✅ up', down: '🚨 down', unknown: '❔ unknown' };

export function printStatus(options = {}) {
  const { state, unreadable } = readStateFile(options);
  const entries = Object.entries(state.urls);
  if (unreadable) {
    // "No URLs monitored. Start with: deskuptime watch <url>" was a lie here: the
    // URLs are in the file, we just cannot read them, and this is the command a
    // user runs to find out whether monitoring works.
    console.error(`⚠️  ${stateReadErrorMessage(unreadable, unreadable.stateFile)}`);
    return;
  }
  if (entries.length === 0) {
    console.log('No URLs monitored. Start with: deskuptime watch <url>');
    return;
  }
  // readEntry() is the same reading `check`, `watch` and the client report use,
  // so a pass from six weeks ago cannot print here as a site that is up now,
  // and a certificate inside the warning window cannot print as routine. This
  // command makes no request — which is exactly why the age of the last pass is
  // part of what it says.
  const now = options.now instanceof Date ? options.now : new Date();
  const { usable, unusable } = partitionUsableUrls(entries.map(([url]) => url));
  // The row shows the key without its credentials, like the report and `status`
  // do: a hand-edited or restored key must not print a password on the list a
  // user runs to see whether their monitoring works (P1-45).
  const rows = entries.map(([url, entry]) => ({ url: withoutCredentials(url), entry, ...readEntry(entry, { now, url }) }));

  console.log(`📋 ${rows.length} monitored URL(s):\n`);
  for (const row of rows) {
    const code = row.statusCode === null ? '—' : row.statusCode;
    const ssl = row.sslNote ? `, ${row.sslNote}` : '';
    // lastChecked is state-file text, so it is flattened like the URL beside it.
    const checked = row.entry.lastChecked ? ` @ ${safeText(row.entry.lastChecked, { max: 0 })}` : '';
    // …and the same row says when that timestamp is not a time this machine can
    // vouch for. `readEntry` owns the sentence, so this list and the client
    // report cannot describe the same skew differently. It is a note, not a
    // verdict: the row keeps `✅ up`/`🚨 down` and the exit code is unchanged,
    // because a machine with the wrong clock has a clock problem, not a site
    // that stopped answering.
    const ahead = row.clockAhead ? ` ⚠️ ${row.clockAhead}` : '';
    // A bare `❔ unknown` used to cover both "never monitored" and "a pass ran
    // but its verdict is unreadable", and this is the command a user runs to
    // find out whether their monitoring works at all.
    const unknown = row.verdict === 'unknown' ? ` — ${row.unknownNote}` : '';
    const stale = row.staleNote ? ` ⚠️ ${row.staleNote}` : '';
    // The same reading `check` prints on its own row, asked of the same owner
    // through readEntry: a site whose last answer came from another host is
    // named here too, and an ordinary redirect on its own host says nothing.
    const redirect = row.redirect.label ? ` ⚠️ ${row.redirect.label}` : '';
    // The page, from the same owner the client report asks, so the list cannot
    // print a defaced site as a healthy `✅ up (200)` — this is the command a
    // user runs to find out whether their monitoring works, and until P1-57 a
    // homepage replaced with a fake form passed it. The title is text the
    // monitored site chose, so the sentence is flattened like the URL above it.
    const content = row.contentNote
      ? ` ${safeText(row.contentNote, { max: 0 })}`
      : row.contentSize ? ` · ${row.contentSize}` : '';
    // …and the certificate, from the same owner the client report asks, for the
    // same reason: this is the command a user runs to find out whether their
    // monitoring works, and a domain that changed hands kept answering `✅ up
    // (200, SSL 89d)` here — the new certificate counts *down* from more days
    // than the old one had, so the row never moved — while the report named the
    // replacement. The sentence is fixed words and a checked day count.
    const cert = row.certNote ? ` ${row.certNote}` : '';
    console.log(`  ${VERDICT_ICON[row.verdict]}  ${safeText(row.url, { max: 0 })} (${code}${ssl})${checked}${ahead}${unknown}${stale}${redirect}${content}${cert}`);
  }

  // A stale site is the reader's most consequential line and a per-row marker
  // is easy to miss in a list, so the dead ones are named — the same "say it
  // once, out loud" rule the client report follows. This is also the only
  // command that can tell the user their *monitoring* stopped, which is the
  // question this command exists to answer.
  const staleRows = rows.filter(row => row.stale);
  if (staleRows.length > 0) {
    console.log(`\n⚠️  No monitoring pass in the last ${STALE_AFTER_DAYS} days for ${staleRows.length} of ${rows.length} site(s) — the numbers above are that old, not now:`);
    for (const row of staleRows) {
      console.log(`    ${safeText(row.url, { max: 0 })} (last pass ${row.ageDays === null ? 'at an unreadable time' : `${row.ageDays} d ago`})`);
    }
    console.log('    Monitoring has probably stopped. Run: deskuptime watch <url> --once');
  }

  // A URL that has never been checked is the other half of the same question:
  // the watch list says it is monitored, and nothing has ever measured it. A
  // stale pass is named because the numbers are old; this is named because there
  // are no numbers at all, and a per-row `not checked yet` is easy to scroll
  // past. Disjoint from the block above: a site with no pass is not stale.
  const neverRows = rows.filter(row => row.neverChecked);
  if (neverRows.length > 0) {
    console.log(`\n⚠️  Never checked: ${neverRows.length} of ${rows.length} site(s) are on the list but no pass has ever measured them:`);
    for (const row of neverRows) {
      console.log(`    ${safeText(row.url, { max: 0 })}`);
    }
    console.log('    Run: deskuptime watch <url> --once');
  }

  // The list above prints every key in the state file, and a key that is not an
  // address prints like any other — as a site that is merely unknown, which is
  // what the row for a half-written `kunde.dk` did until P1-40. It was never
  // measured and never can be, and this is the command whose whole job is to
  // say whether the monitoring works. Named out loud, with the owner's sentence.
  if (unusable.length > 0) {
    console.log(`\n⚠️  ${unusableUrlNote(unusable, { checked: usable.length })}`);
  }

  // The same queue the watch loop prints, here because this is the command that
  // has to answer "is my alerting working?" — including after a restart, when
  // the loop that raised the alert is gone and the alert is still owed to a
  // channel nobody is sitting at.
  const waitingAlerts = normalizeOutbox(state.outbox).filter(entry => !outboxExpired(entry, { now }));
  if (waitingAlerts.length > 0) {
    console.log(`\n${outboxWaitingNote(waitingAlerts, { now })}`);
  }
}

/**
 * How many of the saved keys are addresses we can actually monitor, counting
 * each site once.
 *
 * A key that is not an address cannot be checked, so it must not hold one of the
 * free tier's three slots: it used to, and the only way to get the slot back was
 * to hand-edit `state.json` — the file that also holds the license key.
 *
 * Two keys for the same site are one site, and they are counted as one for the
 * same reason: `https://kunde.dk` and `https://kunde.dk/` took two of the three
 * slots, so a customer could not add their third site (measured 2026-09-26).
 * `addMonitoredUrls()` no longer writes the second form, so this only counts
 * apart for a file written before that, or hand-edited.
 */
export function monitoredCount(state) {
  const identities = new Set();
  for (const url of partitionUsableUrls(Object.keys(state?.urls ?? {})).usable) {
    identities.add(urlIdentity(url));
  }
  return identities.size;
}

function addMonitoredUrls(state, urls, pro) {
  const limit = pro ? PRO.urlLimit : FREE.urlLimit;
  let added = 0;
  for (const url of urls) {
    if (state.urls[url]) continue;
    // The same site in another spelling — `https://kunde.dk` and
    // `https://kunde.dk/`, the form a browser's address bar shows — used to be
    // saved a second time: it took a second of the free tier's three slots, was
    // requested again on every pass, and got a second row with its own numbers
    // in the client report. It is the same site, so it says so and names the key
    // it is already stored under, which is also the spelling `unwatch` needs.
    const sameSite = findUrlKey(state.urls, url);
    if (sameSite) {
      console.log(`⚠️  Already monitoring this site as ${sameSite} — ${url} not added.`);
      continue;
    }
    // A saved key that is not an address cannot be monitored, so it must not
    // hold a slot: on the free tier it used to consume one of the three, and
    // the only way to get the slot back was to hand-edit `state.json` — the
    // file that also holds the license key. `unwatch <key>` is the way out.
    if (monitoredCount(state) >= limit) {
      console.log(pro
        ? `⚠️  Skipping duplicate/extra URL: ${url}`
        : `⚠️  ${freeLimitMessage(url)}`);
      continue;
    }
    state.urls[url] = {
      addedAt: new Date().toISOString(),
      wasUp: null,
      lastHash: null,
      lastContentLength: null,
      sslWarned: false,
    };
    added++;
  }
  return added;
}

/**
 * What the loop learns from the file on disk before every pass.
 *
 * Entries are merged one by one and the newer pass wins — isNewerPass()'s
 * decision, not a string compare (see its doc comment for the two timestamp
 * pairs that sort the wrong way). A URL is only ever *added* that way, and that
 * is the whole bug this function was measured with on 2026-09-26:
 *
 *   `deskuptime watch a b --webhook … --interval 30`   (a paid loop, running)
 *   `deskuptime unwatch b`  →  ✅ No longer monitoring: …/b
 *   …one pass later…       →  state.json holds a and b again, the site is
 *                              measured again, and `status` lists 2 URLs.
 *
 * Nothing in the loop could know better: its own copy of the list is the one
 * that still has b, the pass had already latched the verdict, and the write at
 * the end of the pass put b back — so the tool said it had stopped monitoring a
 * site, and thirty seconds later it was monitoring it again and had said so on
 * disk. On the free tier that is worse than an annoyance: the freed slot is
 * taken again, so the next `watch <url>` answers "Free tier monitors 3 URLs"
 * and the only remaining way to get it back is hand-editing the file that holds
 * the license key.
 *
 * The file is believed only when it is *newer than our own last write* and the
 * URL is one we ourselves wrote — which is also what keeps the unwritable state
 * file honest: a write that failed (P1-39) never recorded anything, so the
 * stale file is older than our last successful one and the loop keeps its own
 * list, exactly as it did before. A URL the user just named on the command line
 * is not in that set either, so starting a loop can never delete what it was
 * asked to monitor.
 *
 * What this does not close: a removal that lands between the loop's read and
 * its write is undone by that one pass, and honoured on the next. Taking the
 * state lock for the length of a pass would mean holding it forever, so the
 * window stays and is named here rather than papered over.
 */
export function mergePersistedState(state, options) {
  const persisted = loadState(options);
  for (const [url, entry] of Object.entries(persisted.urls)) {
    const current = state.urls[url];
    // Which pass is newer is isNewerPass()'s decision, not a string compare —
    // see its doc comment for the two timestamp pairs that sort the wrong way
    // and the whole entry that rolled back because of it.
    if (!current || isNewerPass(entry.lastChecked, current.lastChecked)) {
      state.urls[url] = entry;
    }
  }
  // Somebody wrote after us and their list is shorter: the URL is gone on
  // purpose, and the loop's memory is the only thing left that would bring it
  // back. Only the URLs we wrote ourselves are candidates, so nothing else in
  // memory can be talked out of existence by a file on disk.
  if (lastWrite.urls && stateFileMtimeMs(stateFileFrom(options)) > lastWrite.ms) {
    for (const url of lastWrite.urls) {
      if (!Object.hasOwn(persisted.urls, url)) delete state.urls[url];
    }
  }
  if (Object.hasOwn(persisted, 'license')) state.license = persisted.license;
  return state;
}

function removeStaleStateLock(lockFile) {
  let modifiedAt;
  try {
    modifiedAt = statSync(lockFile).mtimeMs;
  } catch (error) {
    return error.code === 'ENOENT';
  }

  let owner = null;
  try {
    owner = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    if (Date.now() - modifiedAt < 30_000) return false;
  }

  if (owner && Date.now() - modifiedAt <= STATE_LOCK_MAX_AGE_MS) {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid === process.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
  }

  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

/**
 * The state lock keeps two passes from writing over each other. It is taken
 * before anything is measured, so a directory we cannot write to is discovered
 * here first — and it used to be discovered as a throw: `watch --once`, the
 * command a cron job runs, died with a raw stack trace naming the *lock* file
 * (measured 2026-09-26 with a read-only `~/.deskuptime`: `EACCES … state.json.lock`,
 * exit 1, no site checked). "Another pass is running" and "this disk is full"
 * are different problems with different fixes, so they stay different answers:
 * a reason instead of an exception.
 */
function acquireStateLock(stateFile) {
  const lockFile = `${stateFile}.lock`;
  const token = randomUUID();
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
  } catch (error) {
    return { error };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token }), { flag: 'wx', mode: 0o600 });
      return {
        release: () => {
          try {
            const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
            if (owner.token === token) unlinkSync(lockFile);
          } catch {}
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') return { error };
      if (attempt === 0 && removeStaleStateLock(lockFile)) continue;
      return { busy: true };
    }
  }
  return { busy: true };
}

export async function runOnce(urls, opts = {}) {
  assertValidHttpUrls(urls);
  const lock = acquireStateLock(stateFileFrom(opts));
  if (lock.error) return { events: [], results: [], healthy: false, added: 0, stateError: lock.error };
  if (lock.busy) return { events: [], results: [], healthy: false, added: 0, busy: true };

  try {
    const state = loadState(opts);
    const pro = isPro(state);
    if (!pro) {
      const available = Math.max(FREE.urlLimit - monitoredCount(state), 0);
      const rejected = [...new Set(urls)].filter(url => !state.urls[url]).slice(available);
      if (rejected.length > 0) return { events: [], results: [], healthy: false, added: 0, rejected };
    }
    const added = addMonitoredUrls(state, urls, pro);
    if (Object.keys(state.urls).length === 0) return { events: [], results: [], healthy: false, added, empty: true };
    const pass = await runPass(state, { ...opts, returnResults: true });
    return { ...pass, added };
  } finally {
    lock.release();
  }
}

/**
 * Stop monitoring URLs, and free the slot they held.
 *
 * Monitoring used to be a one-way street: `watch <url>` added a URL to
 * `state.json` and nothing ever took it out again. A site that was decommissioned,
 * a project that ended or a typo that got added by mistake stayed in the watch
 * list, in `watch --status`, in `deskuptime status` and in every client report —
 * and on the free tier it permanently consumed one of the three slots, so the
 * only way to monitor a fourth site was to hand-edit `state.json`, the file that
 * also holds the license key. A stopped URL is a real thing a user needs to be
 * able to do, so it gets a command.
 *
 * Only `state.urls` changes: the license record and every other URL are written
 * back untouched, and the daily history in `history.json` is left alone, because
 * it ages out on its own (HISTORY_DAYS) and it is what a report of the last 30
 * days is built from. Re-adding the URL with `watch <url> --once` starts its
 * counters again, which the caller says out loud rather than letting the user
 * discover it as an unexplained uptime reset.
 *
 * The state lock is the same one `runOnce` takes, so unwatching during a cron
 * pass cannot be overwritten by that pass's save.
 *
 * A running `watch` loop holds no lock — it runs for hours — and it keeps its
 * own copy of the list, so before P1-43 it undid this command one pass later:
 * measured with the real loop, the URL was back in the file, measured again and
 * listed by `status` within 30 seconds. mergePersistedState() now takes the
 * removal from the file when the file is newer than the loop's own last write.
 * What is not closed, and is named there: a removal that lands between the
 * loop's read and its write is undone by that one pass and honoured by the next.
 */
export function unwatchUrls(urls, opts = {}) {
  const wanted = [...new Set(urls)];
  const lock = acquireStateLock(stateFileFrom(opts));
  if (lock.error) return { removed: [], missing: wanted, busy: false, stateError: lock.error };
  if (lock.busy) return { removed: [], missing: wanted, busy: true, remaining: null };
  try {
    const state = loadState(opts);
    const removed = [];
    const missing = [];
    for (const url of wanted) {
      // The key the site is actually stored under, in any spelling: the address
      // bar says `https://kunde.dk/` and the file says `https://kunde.dk`, and
      // "not monitored" for the same site would send the user off to hand-edit
      // the file that holds the license key. An exact key still wins, so a file
      // that holds both forms loses one of them and keeps the other.
      const key = findUrlKey(state.urls, url);
      if (key) {
        delete state.urls[key];
        removed.push(key);
      } else {
        missing.push(url);
      }
    }
    if (removed.length > 0) saveState(state, opts);
    return { removed, missing, busy: false, remaining: Object.keys(state.urls).length };
  } finally {
    lock.release();
  }
}

/**
 * Send a desktop notification when possible (Pro only).
 * macOS: osascript. Other platforms: silently skipped for now.
 */
async function notify(title, message) {
  if (process.platform !== 'darwin') return;
  try {
    const { execFile } = await import('child_process');
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await new Promise((resolve) => {
      execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], () => resolve());
    });
  } catch {
    // notifications are best-effort
  }
}

/**
 * POST an event to a user-supplied webhook URL (Pro only).
 * Best-effort, bounded, retried on a temporary failure — see docs/pro-alerts.md §2.
 * Bounded by a hard timeout so a hanging endpoint cannot stall the watch loop.
 *
 * The payload used to carry exactly one time — the moment this body was built,
 * a second or more after the pass that produced the event, growing with the
 * length of the pass and the receiver's own latency. A channel that renders that
 * field read it as "the site broke at 14:26", and the real reading was nowhere
 * in the payload. It also asserted `type: "up"` / `"down"` — a state change —
 * without saying how old the reading it was compared against was, so a recovery
 * measured against a 41-day-old pass looked identical to one DeskUptime watched
 * happen. So the payload now carries the measurement itself and asks
 * `readEvent()` for the verdict, with the pass's own time as the reference: the
 * note in `message` and the `transition` word cannot disagree.
 *
 * `timestamp` keeps its old meaning (when this POST was built) so no existing
 * receiver breaks; the new fields are additive.
 *
 * Measured 2026-09-26 with the real loop and a real receiver: one 5xx and the
 * alert was gone for good. The pass had already latched the change, so the next
 * pass produced no event and nothing was sent again — the customer's channel
 * stayed silent through the whole outage and then received `✅ is UP` for a
 * recovery it was never told about. A receiver that answers one request wrong
 * out of thousands (a restarting proxy, a rate limiter, a dropped connection) is
 * ordinary, not exceptional, so a temporary answer is now asked again — the same
 * rule the license client has used since P2-1 del B, and a 4xx is still a
 * verdict that is never re-asked.
 *
 * **All attempts share the one timeout budget.** The first answer gets it, a
 * retry only what is left of it. Three 10 s attempts would hold the watch loop
 * for 30 s — longer than the shortest interval a Pro loop may use — so a hanging
 * endpoint costs what it has always cost and a blip costs one extra round trip.
 */
export async function sendWebhook(webhookUrl, event, {
  timeoutMs = WEBHOOK_TIMEOUT_MS,
  attempts = WEBHOOK_ATTEMPTS,
  retryDelayMs = WEBHOOK_RETRY_DELAY_MS,
  kept = false,
  wait = sleep,
} = {}) {
  // Built once: a retry must deliver the same body, so the `timestamp` still
  // says when this alert was raised and not when the last attempt was made. The
  // outbox delivers the same shape a day later, which is why the body is the
  // event's and never the pass's.
  const body = webhookBody(event);

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let reason = 'no attempt was made';
  for (;;) {
    const left = deadline - Date.now();
    if (attempt > 0 && left <= retryDelayMs) break;
    attempt += 1;
    let retryable = false;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.max(left, 1)),
      });
      if (res.ok) return true;
      // The receiver answered and the answer was "no". 4xx is a verdict — a dead
      // token, a wrong URL, a payload the receiver refuses — and asking again
      // cannot change it. 429 is the exception: it asks for time, not for a
      // different request.
      retryable = webhookRetryable(res.status);
      reason = `the receiver responded ${res.status}`;
    } catch (err) {
      // No verdict at all, so nothing is known about the request: a timeout, a
      // refused connection or a DNS failure is worth one more try.
      retryable = true;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      reason = timedOut ? `no response within the ${timeoutMs}ms budget` : err.message;
    }
    if (!retryable || attempt >= attempts) break;
    await wait(retryDelayMs);
  }

  // One warning, and it has to say the truth about the consequence: the pass
  // already recorded this change, so nothing *in this pass* resends it. The
  // terminal keeps reporting the site, but a channel that was set up *because*
  // nobody sits at the terminal has now missed the alert — unless the caller is
  // the outbox, which is the one place that does send it again.
  console.error(`⚠️  Webhook alert not delivered — ${reason} (${attempt} attempt${attempt === 1 ? '' : 's'}).`);
  // `kept` is the caller's promise, not ours: the watch loop and the outbox
  // flush both put a failed alert back for a later pass, and a message claiming
  // nothing resends it would then be the one false thing a customer reads.
  console.error(kept
    ? '    Kept in the outbox: it is sent again on a later pass, up to 3 tries over 30 minutes.'
    : '    Nothing resends it: this pass already recorded the change. Check this terminal for what was missed.');
  return false;
}

/**
 * The one body every delivery is built from — the pass's own alert and an alert
 * the outbox kept from an earlier pass alike. It has to be one function: a
 * second copy of this object is how a payload and its documentation start
 * disagreeing about which fields exist.
 */
export function webhookBody(event, { now = new Date() } = {}) {
  const reading = readEvent(event);
  // The same two additive fields `check --json` publishes, asked of the same
  // owner, so one name for the fact holds across every surface. A Pro channel
  // that had to compare hosts itself to notice that a parked page answered
  // instead of the customer's site would be re-implementing the one rule
  // `readRedirectTarget` exists to own — and every channel would get it wrong
  // separately. `type`, `message` and `timestamp` keep their old meaning, and in
  // the ordinary case (no cross-host answer) both new fields are `null`/`false`.
  const redirect = readRedirectTarget({ url: event.url, finalUrl: event.finalUrl });
  return JSON.stringify({
    product: 'deskuptime',
    type: event.type,
    url: event.url,
    message: event.message,
    timestamp: now.toISOString(),
    // When the site was actually measured — the pass's own time, the same
    // one written to the state file and shown by `deskuptime status`. An alert
    // the outbox delivers later still carries the time of the pass that measured
    // it, so a late delivery is visibly late instead of looking fresh.
    measuredAt: typeof event.measuredAt === 'string' ? event.measuredAt : null,
    // The reading a transition is compared against, and whether DeskUptime
    // watched the change or merely found it already so.
    previousChecked: typeof event.previousChecked === 'string' ? event.previousChecked : null,
    transition: reading.transition,
    // Where the response came from. A cross-host answer is not DOWN, so the
    // channel cannot learn it from the event type; without these two fields
    // a customer's parked or hijacked domain reached Slack as a green "up".
    finalUrl: redirect.finalUrl,
    offHostRedirect: redirect.offHost,
  });
}

/**
 * The undelivered-alert queue. See docs/pro-alerts.md §2 for the spec; the
 * bounds live in the constants above so the spec, the code and the tests read
 * the same numbers.
 *
 * What is stored is the *event* — the alert as the pass raised it — and never the
 * address it was sent to. A webhook URL is a token in Slack, Discord and Teams,
 * and `state.json` is the file users attach to a bug report. The receiver's own
 * answer is not stored either: it can echo anything back, and it is not needed to
 * retry. `message` is capped, because for a `down` event it carries the site's
 * error text and an unbounded one would let a site decide how big the state file
 * gets.
 */
const OUTBOX_EVENT_FIELDS = ['url', 'type', 'message', 'measuredAt', 'previousChecked', 'finalUrl'];

function isoOrNull(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function normalizeOutbox(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => {
      const kept = {};
      for (const field of OUTBOX_EVENT_FIELDS) {
        const raw = entry[field];
        kept[field] = field === 'measuredAt' || field === 'previousChecked'
          ? isoOrNull(raw)
          : typeof raw === 'string' ? raw : (field === 'message' ? '' : null);
      }
      kept.message = kept.message.slice(0, OUTBOX_MESSAGE_MAX);
      kept.queuedAt = isoOrNull(entry.queuedAt);
      kept.attempts = Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 0;
      // An entry without a URL, a type or a queue time cannot be sent or aged,
      // and a stored attempt count above the bound is not something we wrote.
      return kept.url && kept.type && kept.queuedAt && kept.attempts <= OUTBOX_MAX_ATTEMPTS ? kept : null;
    })
    .filter(Boolean);
}

function outboxKey(entry) {
  return `${entry.url}\n${entry.type}`;
}

function outboxAgeMs(entry, now) {
  // `queuedAgeMs` is the owner of this age, in status.js with the other ages —
  // watch.js is not allowed to decide one for itself, and an alert's waiting time
  // is an age like any other.
  return queuedAgeMs(entry.queuedAt, now);
}

function formatOutboxWait(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Keep one alert per site and kind. A second `down` for a site that is already
 * waiting is not news — the older alert is the one that says when the outage
 * began, and replacing it with a newer copy would push that fact forward on every
 * pass. Returns whether the state changed, so the caller only writes when it did.
 */
export function enqueueOutbox(state, event, { now = new Date() } = {}) {
  const list = normalizeOutbox(state.outbox);
  const entry = { ...normalizeOutbox([{ ...event, queuedAt: now.toISOString(), attempts: 0 }])[0] };
  if (!entry) return false;
  if (list.some(waiting => outboxKey(waiting) === outboxKey(entry))) return false;
  list.push(entry);
  // Bounded: the oldest goes first, so the queue cannot grow without limit and
  // the oldest news is the first thing to go when it does.
  while (list.length > OUTBOX_LIMIT) list.shift();
  state.outbox = list;
  return true;
}

export function outboxExpired(entry, { now = new Date() } = {}) {
  return outboxAgeMs(entry, now) >= OUTBOX_MAX_AGE_MS;
}

/**
 * What the customer sees while an alert waits, and what they see when it is
 * given up. One owner per sentence, so the loop, `watch --status` and the
 * handover to the next pass cannot describe the same waiting alert differently.
 */
export function outboxWaitingNote(entries, { now = new Date() } = {}) {
  const count = entries.length;
  const lines = entries.map(entry =>
    `    ${safeText(entry.url, { max: 0 })} ${safeText(entry.message, { max: 0 })} (waiting ${formatOutboxWait(outboxAgeMs(entry, now))}, ${entry.attempts} ${entry.attempts === 1 ? 'try' : 'tries'})`);
  return [
    `📬 ${count} alert${count === 1 ? '' : 's'} still waiting for your channel:`,
    ...lines,
    '    They are sent on a later pass. Nothing resends them but this loop.',
  ].join('\n');
}

export function outboxDroppedNote(entry, { now = new Date() } = {}) {
  return `Giving up on an alert that was never delivered: ${safeText(entry.url, { max: 0 })} ${safeText(entry.message, { max: 0 })} (waited ${formatOutboxWait(outboxAgeMs(entry, now))}, ${entry.attempts} ${entry.attempts === 1 ? 'try' : 'tries'}). Your channel received nothing about it. Check the webhook URL and that the receiver is up.`;
}

/**
 * Try everything that is waiting, oldest first, before the pass's own alerts —
 * so a channel receives them in the order they happened.
 *
 * An entry leaves the queue in exactly one of three ways: delivered, given up,
 * or still waiting with one more try against it. It is given up when it has used
 * its tries or outrun its age, and the give-up is said out loud: a silent drop
 * would be indistinguishable from a delivered alert, which is the failure this
 * whole queue exists to remove.
 */
export async function flushOutbox(webhookUrl, state, { now = new Date(), send = sendWebhook, persist } = {}) {
  const list = normalizeOutbox(state.outbox);
  if (list.length === 0) return { delivered: 0, dropped: 0, waiting: 0 };
  // What the queue looked like before this pass tried anything. Whether the loop
  // has to write the file is not a question about how many entries are left — a
  // failed try changes an entry's attempt count in place, so a queue of the same
  // length can still be a different queue.
  const before = JSON.stringify(list);
  const waiting = [];
  const dropped = [];
  let delivered = 0;
  // Oldest first. The timestamps are normalized to ISO above, so a string
  // comparison is the same order a date comparison gives.
  for (const entry of [...list].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))) {
    if (outboxExpired(entry, { now })) {
      dropped.push(entry);
      continue;
    }
    const sent = await send(webhookUrl, entry, { kept: true });
    if (sent) {
      delivered += 1;
      continue;
    }
    const tried = { ...entry, attempts: entry.attempts + 1 };
    if (tried.attempts >= OUTBOX_MAX_ATTEMPTS || outboxExpired(tried, { now })) dropped.push(tried);
    else waiting.push(tried);
  }
  state.outbox = waiting;
  if (persist) persist(JSON.stringify(waiting) !== before);
  for (const entry of dropped) console.error(`⚠️  ${outboxDroppedNote(entry, { now })}`);
  if (waiting.length > 0) console.log(outboxWaitingNote(waiting, { now }));
  return { delivered, dropped: dropped.length, waiting: waiting.length };
}


export async function startWatch(urls, opts = {}) {
  const { webhookUrl } = opts;
  const state = loadState(opts);
  // The typed arguments are still checked strictly — the caller is at fault
  // there and can be told, which is what the CLI's own check does before it
  // gets here — but the *saved* keys are not: a key that is not an address is
  // named and skipped instead of stopping the loop before it has measured
  // anything.
  assertValidHttpUrls(urls);
  const saved = partitionUsableUrls(Object.keys(state.urls));
  if (saved.unusable.length > 0) {
    console.error(`⚠️  ${unusableUrlNote(saved.unusable, { checked: saved.usable.length })}`);
  }
  let pro = false;

  async function recheckLicense() {
    if (!isPro(state)) return false;
    const result = await refreshLicense(state.license);
    state.license = result.license;
    saveStateOrWarn(state, opts, 'The license is still in use on this machine; only the saved copy is behind.');
    if (!result.pro) console.error(`⚠️  Pro license not active: ${result.reason}`);
    return result.pro;
  }
  pro = await recheckLicense();
  let lastLicenseCheck = Date.now();

  if (opts.activateKey && !pro) {
    console.log('🔑 Activating license...');
    const result = await activateLicense(opts.activateKey);
    if (result.valid) {
      state.license = { key: result.key, instance: result.deviceId, plan: result.meta.plan, status: LICENSE_STATUS.ACTIVE, validatedAt: new Date().toISOString() };
      saveState(state, opts);
      pro = true;
      console.log('✅ Pro activated.');
    } else if (result.transient) {
      console.error(`❌ Could not reach the license server: ${result.error}`);
      console.error('    Nothing was changed. Try again when the server answers — your Pro is unchanged.');
    } else {
      console.error(`❌ Activation failed: ${result.error}`);
    }
  }

  const minInterval = pro ? PRO.minIntervalSeconds : FREE.minIntervalSeconds;
  const askedInterval = opts.interval || 300;
  const interval = Math.max(askedInterval, minInterval);
  // Said before the banner, so the number the loop is about to announce is
  // never one the user did not ask for without being told why.
  if (interval > askedInterval) {
    console.error(`⚠️  ${intervalRaisedMessage(askedInterval, minInterval, { pro })}\n`);
  }
  const added = addMonitoredUrls(state, urls, pro);
  if (added === 0 && Object.keys(state.urls).length === 0) {
    throw new Error('No URLs to monitor.');
  }
  mergePersistedState(state, opts);
  // Registers the URLs with the loop even if the file cannot take them yet — the
  // pass below then measures them, and the warning repeats until the write works.
  saveStateOrWarn(state, opts, 'Monitoring starts anyway; the saved copy of this list is behind until the file can be written.');

  console.log(`\n👀 Monitoring ${Object.keys(state.urls).length} URL(s), every ${interval}s.${pro ? ' [Pro]' : ' [free tier]'}.${pro && webhookUrl ? ' Webhook alerts on.' : ''} Ctrl+C to stop.\n`);

  if (webhookUrl && !pro) {
    // Same gate as the other Pro-only surfaces: a key the server never rejected
    // is answered with "re-check the key", never with the checkout.
    console.error(`⚠️  No webhook was sent. ${proGateMessage(state.license, 'webhook alerts') || 'Webhook alerts need an active Pro license.'}`);
    console.error('    Terminal alerts keep working. Monitoring starts now; the webhook activates with the license.\n');
  } else if (pro && !webhookUrl && process.platform !== 'darwin') {
    console.error('ℹ️  Local desktop notifications are macOS-only in the CLI. Use --webhook for alerts on this platform.\n');
  }

  process.on('SIGINT', () => {
    console.log('\n👋 Watch stopped. State saved in ~/.deskuptime/ — run again to resume.');
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const before = new Set(Object.keys(state.urls));
    mergePersistedState(state, opts);
    // A URL the user stopped monitoring has left the loop too. Said out loud,
    // because the alternative — a site quietly vanishing from the output — is
    // indistinguishable from a pass that forgot it.
    for (const url of before) {
      if (!state.urls[url]) console.log(`\n🛑 No longer monitoring: ${url} — removed from the saved list by another command.`);
    }
    if (Date.now() - lastLicenseCheck >= LICENSE_RECHECK_MS) {
      lastLicenseCheck = Date.now();
      pro = await recheckLicense();
    }
    const pass = await runPass(state, { ...opts, returnResults: true });
    printPass(pass, { alertUnchangedDown: false });
    if (pro) {
      // Before this pass's own alerts, so the channel reads them in the order
      // they happened: a waiting alert is older than anything raised now.
      if (webhookUrl) {
        await flushOutbox(webhookUrl, state, {
          persist: changed => {
            if (changed) saveStateOrWarn(state, opts, 'What the channel is still owed will be sent again; the saved copy of it is behind until the file can be written.');
          },
        });
      }
      for (const event of pass.events) {
        if (event.type === 'baseline') continue;
        await notify('DeskUptime', `${event.url} ${event.message}`);
        if (webhookUrl) {
          const sent = await sendWebhook(webhookUrl, event, { kept: true });
          // Not delivered is not lost. The pass latched the change, so without
          // this the next pass raises no event and the channel never hears about
          // an outage it is being paid to hear about.
          if (!sent && enqueueOutbox(state, event)) {
            saveStateOrWarn(state, opts, 'The alert will be sent again on a later pass; the saved copy of it is behind until the file can be written.');
          }
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
  }
}
