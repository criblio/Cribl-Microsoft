/**
 * DBT-188: the shell's inline options save (App.tsx persistOperation), pinned
 * where the frame cannot reach it.
 *
 * The Integrate DCE toggle is the only control that saves options, and while
 * the appOptions read is unreadable or retrying the shell withholds its
 * onOperationChange - so no click can reach the save in that state, and
 * App.dom.test.tsx can only show the toggle is read-only. The save's OWN
 * refusal (planOptionsSave inside it) is the second guard, and it is what
 * stops a defaults document being PUT over the operator's options if the
 * toggle wiring ever regresses. App.tsx calls saveOperationOptions and
 * nothing else, so pinning it here pins what the frame runs.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_OPTIONS, serializeAppOptions } from '@soc/core';
import type { OperationOptions } from '@soc/core';
import {
  OPTIONS_LOADING,
  OPTIONS_UNREADABLE_NOTICE,
  beginOptionsRetry,
  optionsReadFromSettled,
} from '@soc/ui';
import type { OptionsRead } from '@soc/ui';
import { saveOperationOptions } from './options-save';

const KEY = 'appOptions';
const TOGGLED: OperationOptions = { ...DEFAULT_APP_OPTIONS.operation, createDCE: true };
const UNREADABLE = optionsReadFromSettled({ status: 'rejected', reason: new Error('HTTP 500') });
const LOADED = optionsReadFromSettled({
  status: 'fulfilled',
  value: serializeAppOptions(DEFAULT_APP_OPTIONS),
});

function harness(read: OptionsRead, set = vi.fn().mockResolvedValue(undefined)) {
  let current = read;
  const notices: (string | null)[] = [];
  const run = () =>
    saveOperationOptions({
      read,
      operation: TOGGLED,
      store: { set },
      key: KEY,
      setRead: (update) => {
        current = update(current);
      },
      setNotice: (notice) => notices.push(notice),
    });
  return { run, set, notices, current: () => current };
}

describe('saveOperationOptions (DBT-158 refusal, DBT-188 pin)', () => {
  it('an UNREADABLE read writes nothing, even after the save settles, and says why', async () => {
    const h = harness(UNREADABLE);
    await h.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.set).not.toHaveBeenCalled();
    expect(h.notices).toEqual([OPTIONS_UNREADABLE_NOTICE]);
    expect(h.current()).toBe(UNREADABLE);
  });

  it('a RETRYING read writes nothing either', async () => {
    const retrying = beginOptionsRetry(UNREADABLE)!;
    const h = harness(retrying);
    await h.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.set).not.toHaveBeenCalled();
    expect(h.notices).toEqual([OPTIONS_UNREADABLE_NOTICE]);
  });

  it('a LOADING read writes nothing', async () => {
    const h = harness(OPTIONS_LOADING);
    await h.run();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).not.toBeNull();
  });

  it('a LOADED read PUTs the change once and becomes the loaded read of what was written', async () => {
    const h = harness(LOADED);
    await h.run();
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls[0]![0]).toBe(KEY);
    const written = JSON.parse(h.set.mock.calls[0]![1] as string) as {
      operation: { createDCE: boolean };
    };
    expect(written.operation.createDCE).toBe(true);
    expect(h.current().state).toBe('loaded');
    expect(h.current().options.operation.createDCE).toBe(true);
    expect(h.notices).toEqual([null, null]);
  });

  it('a failed PUT keeps the read as it was and says the change was not saved', async () => {
    const h = harness(LOADED, vi.fn().mockRejectedValue(new Error('HTTP 503')));
    await h.run();
    expect(h.current()).toBe(LOADED);
    expect(h.notices[0]).toBeNull();
    expect(h.notices[1]).toContain('HTTP 503');
  });
});
