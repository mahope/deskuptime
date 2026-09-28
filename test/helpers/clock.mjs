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
