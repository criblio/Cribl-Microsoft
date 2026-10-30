// Which Live Preview init script the dev server injects into a page load.
//
// Cribl's Live Preview loads the dev server as
// `http://localhost:5173/?init=<leader>/app-ui/__local__/init.js?...`. That
// init script belongs to ONE Live Preview session - it carries that session's
// data - so it must come from the request being served. The plugin used to
// remember the first ?init= it ever saw and inject it into every later load,
// which booted a second browser with the first browser's session: its KV
// reads did not answer as its own and it fell into the setup flow, until a
// dev server restart cleared the cache (DBT-146).
//
// The remembered value stays only as a fallback for a load that carries no
// ?init= at all (a reload that dropped the query), where injecting nothing
// would leave the app with no platform bridge.

/**
 * The init script URL to inject: the request's own when it has one,
 * otherwise the last one seen. null when neither exists.
 *
 * @param {string | null} requested the ?init= of the page load being served
 * @param {string | null} remembered the last ?init= the dev server saw
 * @returns {string | null}
 */
export function initScriptUrlFor(requested, remembered) {
  if (requested) {
    return requested;
  }
  return remembered || null;
}
