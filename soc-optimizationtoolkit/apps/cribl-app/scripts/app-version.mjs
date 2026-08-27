// The version string the LIVE PREVIEW footer shows.
//
// WHY THIS IS ITS OWN MODULE. The app reports its version twice, from two
// different places, and only one of them is right in any given shell:
//
//   - `__APP_VERSION__` is a build-time define, frozen when Vite loads its
//     config. It is authoritative for an INSTALLED .tgz, whose package.json
//     never changes after the build.
//   - `window.__APP_VERSION_RUNTIME__` is injected per dev request from
//     package.json on disk. It is authoritative in LIVE PREVIEW, where the
//     package script bumps the version underneath a long-running server.
//
// The footer prefers the runtime value and falls back to the define
// (`App.tsx`). That fallback is the hazard: when the read fails, nothing is
// injected, the frozen define wins, and the footer shows a STALE version with
// no indication that it is stale. Reading a version off the screen is how you
// check which build you are driving, so a silently stale one sends you
// debugging the wrong code - which is exactly what happened on 2026-08-27,
// where a footer reading v1.11.2 was taken as evidence of a missing component
// when it was really evidence of the wrong shell.
//
// Returning null rather than undefined-or-throwing is what lets the caller
// SKIP the injection deliberately instead of writing `window.X = undefined`
// and rendering "vundefined".

/**
 * The version from a package.json's text, or null when there is not a usable
 * one. Never throws: the caller runs inside a Vite hook on every request.
 *
 * @param {string} text raw package.json contents
 * @returns {string | null}
 */
export function appVersionFrom(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const version = parsed.version;
  // A non-string (or blank) version is not usable. Injecting it would put
  // `window.__APP_VERSION_RUNTIME__ = 42` or `= ""` in front of the footer's
  // `??`, which only guards null and undefined - so `""` would render as a
  // bare "v" and 42 as "v42", both of them silently wrong.
  if (typeof version !== "string" || version.trim() === "") return null;
  return version;
}
