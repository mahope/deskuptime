/**
 * P1-93 — the suite's clock, and the reason it is not a literal.
 *
 * Three files wrote `const BASE = '2026-09-27T09:00:00.000Z'` and then let a
 * *real* `deskuptime status` read the state they had stamped from it. The
 * commands age a stamp against the machine's own clock, so the age they printed
 * was measured from two different "now"s: the literal in the file, and whatever
 * time it was when the test ran. Measured 2026-09-28, the day after those files
 * were written, in the full suite on the unchanged tree — 749 of 756:
 *
 *   test expects   🏢 certificate answers from a different issuer 2 d ago (…)
 *   the row says   🏢 certificate answers from a different issuer 3 d ago (…)
 *
 * Seven tests, three files, two doors:
 *
 *   test/certissuerlists.test.js, test/certrotationlists.test.js
 *     a child process ran the real `status` / `watch --status`, so the wall
 *     clock aged the fixture, while the expected sentence held a literal age
 *     counted from `BASE`. Green for 24 hours, red for ever after.
 *
 *   test/oversizedpage.test.js
 *     the other way round: the *report's* `now` was `BASE`, and the pass that
 *     wrote `lastContentReadAt` stamped the real time — so once the wall clock
 *     passed `BASE` the pass was in the future and the row carried
 *     `stable · 70 bytes, read 36 min ahead of this machine's clock`, which is
 *     the report being right and the fixture's `now` being a fiction that had
 *     expired.
 *
 * Nothing here freezes anything. `ANCHOR` is this machine's clock, read once per
 * test process, so a fixture anchored to it says the same thing tomorrow as it
 * says today: the ages in those assertions are the ages the command will print
 * whenever it runs. A literal buys determinism only where the reader's clock is
 * the same one the test holds — the many files that pass `{ now }` into
 * `readEntry` and `buildReport` in-process, and which are correct as they are.
 *
 * `test/clockgate.test.js` is the lock.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * This machine's clock, read once when the test process loads. Deliberately not
 * a literal and deliberately not memoised across files: each test process gets
 * its own, and a fixture that ages from it ages by the same number of days
 * whenever the suite is run.
 */
export const ANCHOR = new Date();

/**
 * An ISO stamp `days` before an instant, the form a state file stores. Whole
 * days, because every age in the product is whole days — `passAge` floors — and
 * a reader that rounds a remainder *up* would print `3 d ago` for a stamp written
 * two days and one second ago. The fixture must not depend on which way the
 * owner rounds, so it writes whole days and lets the owner's own arithmetic
 * decide.
 */
export function daysBefore(days, from = ANCHOR) {
  return new Date(from.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * A Pro license whose `validatedAt` means what the field means: *this machine
 * checked with the license server, and it was recent*.
 *
 * P1-94 — measured, not predicted. The plan expected these fixtures to rot the
 * way P1-93's did, by printing a sentence whose age drifts. They do not. They
 * rot through a different door, one the file never mentions, and it is the
 * product's own contract doing it: `src/license.js` keeps a validated Pro
 * status for `OFFLINE_GRACE_MS` (7 days) so a server outage never locks a
 * paying customer out, and ages `validatedAt` against the *wall* clock. A test
 * that writes a state file and then runs the **real** `report` in a child
 * process therefore hands the command a license that expires in seven days:
 *
 *   $ deskuptime report
 *   ❌ Error: the client report needs an active Pro license. This machine is
 *      unverified with the license server (not verified for 10 days; …)
 *
 * Two files, one test each, both green today and both red from the eighth day
 * on. It never looks like an age: the report is not produced at all, so there is
 * no sentence to drift — the exit code is 1 and stdout is empty. Measured on
 * the unchanged tree by moving every date literal in the file back N days, which
 * is what N days of real time does to a frozen fixture:
 *
 *   +1d   +7d   +30d   +90d   +365d
 *   0     1     1      1      1     test/history.test.js
 *   0     1     1      1      1     test/reportkeyreason.test.js
 *
 * The five other files the plan listed keep a fixed instant and stay green at
 * every horizon, and the reason is worth keeping: they hand the license to
 * `buildReport`, which by its own contract does not read `state.license` at all
 * (src/report.js:152). A fixed `now` for an in-process reader is determinism
 * bought on purpose. It is only the stamp a *child* ages that has to follow
 * the machine.
 *
 * So the two clocks in these files are deliberately different, and the split is
 * the fix: `NOW` stays a literal because `buildReport` is handed it as
 * `{ now }`, and the license comes from here because the wall clock is what
 * ages it.
 */
export function validatedNow({ key = '0123456789abcdef0123456789abcdef', instance = 'deskuptime-test', ...rest } = {}) {
  return { key, instance, plan: 'pro', status: 'active', validatedAt: new Date().toISOString(), ...rest };
}

/**
 * The stamp `runPass` writes when a pass has just measured a site.
 *
 * P1-94, second door in the same test file. `test/history.test.js` wrote a
 * state file whose `lastChecked` was the file's own fixed `NOW` and then ran the
 * real `report` on it, so from the eighth day on the pass fell outside the
 * `--days 7` window the test itself asks for, and the report said
 * `— (no pass in the last 7 d)` — the exact sentence line 357 asserts it must
 * *not* contain. The report was right and the fixture was a fiction that had
 * expired, the same shape as P1-93's `oversizedpage`.
 *
 * So the rule is not "licences follow the clock" but the one underneath both:
 * **a stamp that a child process ages must be this machine's clock.** A literal
 * is only ever safe where the reader is handed the same instant in-process —
 * `buildReport({…}, { now })`, `readEntry({…}, { now })` — and that is the whole
 * reason the twenty files the plan flagged are correct as they are.
 */
export function checkedNow() {
  return new Date().toISOString();
}
