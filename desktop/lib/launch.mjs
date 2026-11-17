// Starting a supported app that is not running, from a click in the "+" strip (docs/desktop.md "启动应用"): what
// happens after the click. Where the app is started from is looked up read-only by lib/locate.mjs locateApp, and the
// shell's one launch function (shell.mjs launchApp) does the starting. Pure; nothing here starts anything.

/** How long the shell watches for the started app's new window, and how long it waits for others appearing with it. */
export const WATCH_MS = 20_000;
export const SETTLE_MS = 800;

/**
 * Watches for the started app's windows that were not there before the click (`before`: their handles). Each `tick`
 * gets the app's current candidate windows. Only windows first seen before the deadline (start + WATCH_MS) count; one
 * seen after it is ignored, also when a poll comes late. When counted windows are there, it waits SETTLE_MS from the
 * first of them for others appearing with them (this may end up to SETTLE_MS after the deadline), then answers: one →
 * { add }, several → { choose } (the user picks). When none is there at or after the deadline → { none }. Once it has
 * answered, it is done; it never starts anything again.
 * @template {{ hwnd: number }} C
 * @param {Set<number>} before @param {number} start
 */
export function createWatch(before, start) {
  const deadline = start + WATCH_MS;
  const counted = new Set();   // windows first seen before the deadline
  let seen = null;
  let done = false;
  return {
    get done() { return done; },
    /** @param {C[]} list @param {number} now @returns {{ add: C } | { choose: C[] } | { none: true } | null} */
    tick(list, now) {
      if (done) return null;
      if (now < deadline) for (const c of list) if (!before.has(c.hwnd)) counted.add(c.hwnd);
      const fresh = list.filter((c) => counted.has(c.hwnd));
      if (!fresh.length) {
        seen = null;   // one came and went (a splash screen): wait for the real one
        if (now < deadline) return null;
        done = true;
        return { none: true };
      }
      seen ??= now;
      if (now - seen < SETTLE_MS) return null;
      done = true;
      return fresh.length === 1 ? { add: fresh[0] } : { choose: fresh };
    },
  };
}
