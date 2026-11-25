/**
 * The shell's inline options save - what App.tsx's persistOperation runs when
 * the Integrate DCE toggle changes (DBT-158, DBT-172, DBT-173).
 *
 * Kept out of App.tsx so the save's own refusal is pinnable (DBT-188): while
 * the appOptions read is unreadable or retrying the shell also withholds the
 * toggle's onOperationChange, so no click reaches this, and a frame test can
 * only see the read-only toggle. This refusal is the second guard - the one
 * that stops a defaults document being PUT over the operator's options if the
 * toggle wiring regresses - and options-save.test.ts pins it.
 *
 * The decisions are @soc/ui's options-read module: planOptionsSave refuses
 * over a read that did not answer and otherwise PATCHES the stored record;
 * settleOptionsSave keeps the read as it was when the PUT fails and says so.
 */

import type { OperationOptions, SecretsStore } from '@soc/core';
import { planOptionsSave, settleOptionsSave } from '@soc/ui';
import type { OptionsRead } from '@soc/ui';

export interface SaveOperationOptionsArgs {
  /** The read the edit was made over. */
  read: OptionsRead;
  /** The edited operation section. */
  operation: OperationOptions;
  /** Where the options document lives. */
  store: Pick<SecretsStore, 'set'>;
  /** The options document's KV key. */
  key: string;
  /** Settle the shell's read against its CURRENT state. */
  setRead: (update: (current: OptionsRead) => OptionsRead) => void;
  /** Why the save did not land, or null when it did (or is in flight). */
  setNotice: (notice: string | null) => void;
}

/**
 * Save an inline OperationOptions edit - only over a read that answered.
 * Refused: says why and PUTs nothing. Otherwise clears the notice, PUTs the
 * patched record, then settles: the read becomes what was written, or stays
 * as it was with a notice when the PUT failed.
 */
export async function saveOperationOptions(args: SaveOperationOptionsArgs): Promise<void> {
  const { read, operation, store, key, setRead, setNotice } = args;
  const plan = planOptionsSave(read, { operation });
  if (plan.kind === 'refused') {
    setNotice(plan.reason);
    return;
  }
  setNotice(null);
  const [result] = await Promise.allSettled([store.set(key, plan.serialized)]);
  // The read settles against the CURRENT state (another save may have landed
  // meanwhile); the notice depends only on the PUT's result.
  setRead((current) => settleOptionsSave(current, plan.serialized, result).read);
  setNotice(settleOptionsSave(read, plan.serialized, result).notice);
}
