// Types for init-script-url.mjs, which vite.config.ts imports. Same seam as
// app-version.d.mts: the implementation stays .mjs so it runs unchanged in
// the Vite config and under vitest.

/**
 * The init script URL to inject: the request's own ?init= when it has one,
 * otherwise the last one seen (DBT-146). null when neither exists.
 */
export function initScriptUrlFor(requested: string | null, remembered: string | null): string | null;
