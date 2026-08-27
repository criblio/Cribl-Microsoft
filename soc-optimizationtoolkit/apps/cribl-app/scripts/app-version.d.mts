// Types for app-version.mjs, which vite.config.ts imports.
//
// The implementation stays .mjs so the same file runs unchanged in the Vite
// config (Node ESM, no build step) and under vitest as scripts/*.test.mjs,
// which is how every other script in this directory is written and pinned.
// TypeScript will not infer types across that boundary without a declaration,
// so this file is the seam.

/**
 * The version from a package.json's text, or null when there is not a usable
 * one. Never throws.
 */
export function appVersionFrom(text: string): string | null;
