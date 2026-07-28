/**
 * ARM resource toolkit - the two shapes the lab provisioning engine repeats
 * for (almost) every resource, stated ONCE:
 *
 *   - {@link ensureResource}: GET-first idempotent ensure-or-create. Reuse
 *     on a 2xx GET, create on a miss, greppable error text otherwise. Two
 *     miss policies exist because the legacy engine had both: "404" (the
 *     strict default - any other GET failure is a read error) and
 *     "any-non-2xx" (containers/queues/NSGs/event subscriptions - every GET
 *     miss just tries the PUT).
 *
 *   - {@link pollProvisioningState}: the attempt-bounded provisioningState
 *     poll (sleep -> GET -> parse until the target state or exhaustion).
 *     `seed` carries the state already visible on the PUT body: when it is
 *     provided the loop checks before the first sleep (the seeded engines);
 *     when absent the loop reads first (storage / provider registration).
 *     `keepStateOnFailedRead` mirrors the two legacy sub-variants: ADX/DCR
 *     kept the last seen state across a failed poll GET, the others reset
 *     to "". Failure MESSAGES stay with the callers - each resource names
 *     its own exhaustion text (pinned by the engine tests).
 *
 * Attempt-bounded only, paced by the injected sleep hook - core never reads
 * a clock. Pure orchestration over the AzureManagement port.
 */

import { asString, httpErrorText, is2xx, prop } from "../arm-http";

/** One HTTP exchange as the toolkit sees it. */
export interface ArmExchange {
  status: number;
  body: unknown;
}

/** The outcome of an {@link ensureResource} call. */
export interface EnsureResourceOutcome {
  /** "reused" (2xx GET) | "created" (PUT accepted) | "failed". */
  status: "reused" | "created" | "failed";
  /** The GET body when reused, the PUT body when created. */
  body?: unknown;
  /** Greppable failure text (`read <context>` / `create <context>`). */
  error?: string;
}

/** Input for {@link ensureResource}. */
export interface EnsureResourceOptions {
  get: () => Promise<ArmExchange>;
  put: () => Promise<ArmExchange>;
  /** Names the resource in error text, e.g. `Event Hub namespace 'ns'`. */
  context: string;
  /**
   * When is the resource considered absent (so the PUT runs)?
   *   "404" (default): only a 404 GET; any other non-2xx is a read error.
   *   "any-non-2xx": every non-2xx GET (the legacy lenient sub-resources).
   */
  missOn?: "404" | "any-non-2xx";
}

/** GET-first ensure-or-create; see the module doc for the two miss modes. */
export async function ensureResource(
  options: EnsureResourceOptions,
): Promise<EnsureResourceOutcome> {
  const missOn = options.missOn ?? "404";
  const got = await options.get();
  if (is2xx(got.status)) {
    return { status: "reused", body: got.body };
  }
  if (missOn === "404" && got.status !== 404) {
    return {
      status: "failed",
      error: httpErrorText(`read ${options.context}`, got.status, got.body),
    };
  }
  const created = await options.put();
  if (!is2xx(created.status)) {
    return {
      status: "failed",
      error: httpErrorText(`create ${options.context}`, created.status, created.body),
    };
  }
  return { status: "created", body: created.body };
}

/** Input for {@link pollProvisioningState}. */
export interface PollProvisioningStateOptions {
  /** Issue one poll GET. */
  read: () => Promise<ArmExchange>;
  /** Extract the state from a 2xx body (e.g. parseVnetProvisioningState). */
  parse: (body: unknown) => string;
  /** The state that ends the poll; default "Succeeded". */
  target?: string;
  /**
   * The state already visible on the PUT body. Provided = check it before
   * the first sleep (sleep-first loop); absent = read-first loop.
   */
  seed?: string;
  /** Attempt bound (never wall-clock). */
  attempts: number;
  /** The SHELL-injected sleep hook. */
  sleep: (ms: number) => Promise<void>;
  delayMs: number;
  /** Keep the last seen state when a poll GET fails (default: reset to ""). */
  keepStateOnFailedRead?: boolean;
  /** Called with every 2xx poll body (e.g. to capture the ADX data URI). */
  onBody?: (body: unknown) => void;
}

/**
 * Poll until the target provisioningState or attempt exhaustion; returns
 * the LAST observed state (callers compare it to their target and compose
 * their own exhaustion message).
 */
export async function pollProvisioningState(
  options: PollProvisioningStateOptions,
): Promise<string> {
  const target = options.target ?? "Succeeded";
  if (options.seed === undefined) {
    let state = "";
    for (let poll = 0; poll < options.attempts; poll++) {
      const read = await options.read();
      if (is2xx(read.status)) {
        state = options.parse(read.body);
        options.onBody?.(read.body);
      } else {
        state = options.keepStateOnFailedRead === true ? state : "";
      }
      if (state === target) {
        break;
      }
      await options.sleep(options.delayMs);
    }
    return state;
  }
  let state = options.seed;
  for (let poll = 0; state !== target && poll < options.attempts; poll++) {
    await options.sleep(options.delayMs);
    const read = await options.read();
    if (is2xx(read.status)) {
      state = options.parse(read.body);
      options.onBody?.(read.body);
    } else if (options.keepStateOnFailedRead !== true) {
      state = "";
    }
  }
  return state;
}

/** The generic `properties.provisioningState` reader (ARM's common shape). */
export function armProvisioningState(body: unknown): string {
  return asString(prop(prop(body, "properties"), "provisioningState"));
}
