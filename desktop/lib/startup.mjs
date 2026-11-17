// Chromium switches the shell sets before the app is ready (docs/desktop.md "无障碍"). Pure: takes an env object.

/**
 * Renderer accessibility is off by default: once some program reads the window's UI structure, the accessibility
 * events for everything the page renders can stall the whole desktop. ORRERY_DESKTOP_ACCESSIBILITY=1/true/on keeps it.
 */
export function chromiumSwitches(env) {
  const keep = /^(1|true|on)$/i.test(String(env.ORRERY_DESKTOP_ACCESSIBILITY ?? '').trim());
  return keep ? [] : ['disable-renderer-accessibility'];
}
