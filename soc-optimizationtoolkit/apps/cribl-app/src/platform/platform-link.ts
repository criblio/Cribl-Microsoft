/**
 * What the consolidated platform-link poll says about Cribl reachability.
 *
 * The poll stores a display string: 'checking...' until its first run, then
 * 'ok', or `failed - <error>` with the error appended. Every reader used to
 * compare that string itself, and two of them tested `!== 'failed'`, which no
 * value the poll produces ever equals - so the capability audit and the setup
 * wizard always saw Cribl as reachable while the badge said failed (DBT-147).
 * This module is the one place the string is read.
 *
 * Pure: no IO, no React.
 */

/** The poll's state, with the error text dropped. */
export type PlatformLinkState = 'ok' | 'checking' | 'failed';

/** The display string the poll holds before its first run. */
export const PLATFORM_LINK_CHECKING = 'checking...';

/** Read the poll's display string. Anything that is not 'ok' or still checking is a failure. */
export function platformLinkState(link: string): PlatformLinkState {
  if (link === 'ok') {
    return 'ok';
  }
  if (link === PLATFORM_LINK_CHECKING) {
    return 'checking';
  }
  return 'failed';
}

/**
 * Reachable unless the poll has FAILED. An unresolved poll counts as
 * reachable, so Cribl verdicts stay 'unknown' instead of briefly claiming
 * 'unreachable' on every load.
 */
export function criblReachableUnlessFailed(link: string): boolean {
  return platformLinkState(link) !== 'failed';
}

/** The tri-state form: true when ok, false when failed, undefined while checking. */
export function criblReachability(link: string): boolean | undefined {
  const state = platformLinkState(link);
  return state === 'ok' ? true : state === 'failed' ? false : undefined;
}
