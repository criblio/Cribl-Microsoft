import { describe, expect, it } from 'vitest';
import { clearNotice } from './clear-notice';

describe('clearNotice', () => {
  it('the identity notice never points at the hidden connect section or asks to re-authenticate', () => {
    const text = clearNotice('identity');
    expect(text).not.toMatch(/section on Setup/i);
    expect(text).not.toMatch(/re-enter|re-authenticate/i);
  });
  it('the secret notice keeps its re-authenticate guidance', () => {
    expect(clearNotice('secret')).toMatch(/re-authenticate/);
  });
});
