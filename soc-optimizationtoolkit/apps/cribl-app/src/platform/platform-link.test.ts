// Pins for reading the platform-link poll (DBT-147). The failure value
// carries the error text, so a reader comparing against bare 'failed' never
// sees a failure - the case these exist for.

import { describe, expect, it } from 'vitest';
import {
  PLATFORM_LINK_CHECKING,
  criblReachability,
  criblReachableUnlessFailed,
  platformLinkState,
} from './platform-link';

const FAILED = 'failed - TypeError: Failed to fetch';

describe('platformLinkState', () => {
  it('reads the three poll values', () => {
    expect(platformLinkState('ok')).toBe('ok');
    expect(platformLinkState(PLATFORM_LINK_CHECKING)).toBe('checking');
    expect(platformLinkState(FAILED)).toBe('failed');
  });
});

describe('criblReachableUnlessFailed', () => {
  it('is false when the poll failed with an error appended', () => {
    expect(criblReachableUnlessFailed(FAILED)).toBe(false);
  });

  it('counts ok and an unresolved poll as reachable', () => {
    expect(criblReachableUnlessFailed('ok')).toBe(true);
    expect(criblReachableUnlessFailed(PLATFORM_LINK_CHECKING)).toBe(true);
  });
});

describe('criblReachability', () => {
  it('is true, undefined or false for ok, checking and failed', () => {
    expect(criblReachability('ok')).toBe(true);
    expect(criblReachability(PLATFORM_LINK_CHECKING)).toBeUndefined();
    expect(criblReachability(FAILED)).toBe(false);
  });
});
