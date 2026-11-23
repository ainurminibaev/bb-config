/**
 * A short token that names one evaluation of this plugin's bundle.
 *
 * The plugin imports a second copy of bb's thread list with this token in its
 * URL. The token follows the plugin bundle's own URL, which bb derives from the
 * bundle's content: the same build gives the same token on every page load, so
 * the browser serves the list from its cache; a rebuilt or hot-reloaded plugin
 * gets a new URL, so it never picks up the copy bound to the previous load.
 * Without a usable URL it falls back to the time, as before.
 */
export function loadToken(moduleUrl: unknown, now: () => number = Date.now): string {
  if (typeof moduleUrl !== "string" || moduleUrl === "") return now().toString(36);
  // FNV-1a, 32 bit: short, stable, no crypto needed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < moduleUrl.length; i++) {
    hash ^= moduleUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `u${hash.toString(36)}`;
}
