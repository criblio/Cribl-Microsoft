/**
 * PollRegistry - the seam that lets a SCREEN add a poll to the shell's one
 * budgeted poller without the shell knowing the screen exists.
 *
 * useConsolidatedPolling is the only thing in the app that runs timers, and
 * the shell calls it once. Before this registry a screen that wanted to poll
 * had two bad choices: start its own setInterval (a second, unbudgeted
 * poller against the ~100 req/min proxy budget) or have the shell hard-code
 * the screen's poll. Instead:
 *
 *   - PollRegistryProvider wraps the shell (main.tsx wraps <App/>), so the
 *     shell's own hooks sit INSIDE it and can read what screens registered.
 *   - A screen calls useRegisterPoll(poll | null). Non-null registers, null
 *     or unmount removes. Passing null is how a screen says "not now"
 *     (not watching, document hidden, no worker group).
 *   - The shell calls useMergedPolls(staticPolls) and hands the result to its
 *     single useConsolidatedPolling call.
 *
 * The registry itself runs NO timer and makes no request; it only holds the
 * set. Scheduling, budget and priorities stay in useConsolidatedPolling and
 * the pure @soc/core poll-scheduler.
 *
 * A registration is stored behind a stable wrapper whose run() calls the
 * caller's LATEST run, so a screen may pass a fresh object literal on every
 * render without churning the registry. Only id, intervalMs and priority
 * changes re-register.
 *
 * Duplicate ids are a programming error: two screens would overwrite each
 * other's schedule silently. The provider's `duplicates` prop decides what
 * happens - "log" (the DEFAULT, so a shell that passes nothing stays up: the
 * throw would come from a passive effect and unmount the whole React root,
 * and the app has no error boundary) or "throw" (opt-in, for tests and a
 * development shell, e.g. `duplicates={import.meta.env.DEV ? "throw" : "log"}`).
 * The second registration is never stored either way.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { ConsolidatedPoll } from "./use-consolidated-polling";

/** What happens when a second live registration claims an id in use. */
export type DuplicatePollPolicy = "throw" | "log";

interface RegistryActions {
  /** Returns false (and stores nothing) when the id is held by another owner. */
  register: (owner: symbol, poll: ConsolidatedPoll) => boolean;
  /** Removes the id only when `owner` is the one holding it. */
  unregister: (owner: symbol, id: string) => void;
}

const ActionsContext = createContext<RegistryActions | null>(null);
const PollsContext = createContext<readonly ConsolidatedPoll[] | null>(null);

export interface PollRegistryProviderProps {
  children?: ReactNode;
  /** Duplicate-id policy; "log" unless the caller opts into "throw". */
  duplicates?: DuplicatePollPolicy;
  /** Where "log" (and the outside-provider warning) write. Default console.warn. */
  log?: (message: string) => void;
}

const defaultLog = (message: string): void => {
  console.warn(message);
};

export function duplicatePollMessage(id: string): string {
  return `poll-registry: a poll with id "${id}" is already registered; the second registration was ignored`;
}

export const OUTSIDE_PROVIDER_MESSAGE =
  "poll-registry: useRegisterPoll was called outside a PollRegistryProvider; the poll was not registered";

export function PollRegistryProvider(
  props: PollRegistryProviderProps,
): ReactNode {
  const { children, duplicates = "log" } = props;
  const log = props.log ?? defaultLog;

  // The ref is the source of truth for ownership (checked synchronously, so a
  // duplicate is caught even when two registrations land in one commit); the
  // state copy is what renders the merged list.
  const ownersRef = useRef(new Map<string, { owner: symbol; poll: ConsolidatedPoll }>());
  const [registered, setRegistered] = useState<readonly ConsolidatedPoll[]>([]);

  // Initialised from the first render (child effects register BEFORE this
  // component's own effects run on mount), then adopted after every render.
  const policyRef = useRef({ duplicates, log });
  useEffect(() => {
    policyRef.current = { duplicates, log };
  });

  const publish = useCallback(() => {
    setRegistered(Array.from(ownersRef.current.values(), (entry) => entry.poll));
  }, []);

  const actions = useMemo<RegistryActions>(
    () => ({
      register: (owner, poll) => {
        const held = ownersRef.current.get(poll.id);
        if (held !== undefined && held.owner !== owner) {
          const message = duplicatePollMessage(poll.id);
          if (policyRef.current.duplicates === "throw") {
            throw new Error(message);
          }
          policyRef.current.log(message);
          return false;
        }
        ownersRef.current.set(poll.id, { owner, poll });
        publish();
        return true;
      },
      unregister: (owner, id) => {
        const held = ownersRef.current.get(id);
        if (held === undefined || held.owner !== owner) {
          return;
        }
        ownersRef.current.delete(id);
        publish();
      },
    }),
    [publish],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <PollsContext.Provider value={registered}>{children}</PollsContext.Provider>
    </ActionsContext.Provider>
  );
}

/**
 * Register `poll` with the nearest PollRegistryProvider while it is non-null.
 * null (or unmount) removes it. Outside a provider this is a no-op that logs
 * once per hook instance.
 */
export function useRegisterPoll(poll: ConsolidatedPoll | null): void {
  const actions = useContext(ActionsContext);
  const ownerRef = useRef<symbol>(Symbol("poll-owner"));
  const latestRef = useRef<ConsolidatedPoll | null>(poll);
  const warnedRef = useRef(false);

  // Adopt the latest poll before the registration effect below runs, so the
  // stable wrapper always calls the current run().
  useEffect(() => {
    latestRef.current = poll;
  });

  const active = poll !== null;
  const id = poll?.id;
  const intervalMs = poll?.intervalMs;
  const priority = poll?.priority;

  useEffect(() => {
    if (!active || id === undefined || intervalMs === undefined || priority === undefined) {
      return;
    }
    if (actions === null) {
      if (!warnedRef.current) {
        warnedRef.current = true;
        defaultLog(OUTSIDE_PROVIDER_MESSAGE);
      }
      return;
    }
    const owner = ownerRef.current;
    const wrapper: ConsolidatedPoll = {
      id,
      intervalMs,
      priority,
      run: () => latestRef.current?.run(),
    };
    const stored = actions.register(owner, wrapper);
    if (!stored) {
      return;
    }
    return () => actions.unregister(owner, id);
  }, [actions, active, id, intervalMs, priority]);
}

/**
 * The shell's static polls followed by every screen registration, memoized so
 * the array identity changes only when either input does. Outside a provider
 * it returns `staticPolls` itself, so a shell renders in tests without one.
 */
export function useMergedPolls(
  staticPolls: readonly ConsolidatedPoll[],
): readonly ConsolidatedPoll[] {
  const registered = useContext(PollsContext);
  return useMemo(
    () =>
      registered === null || registered.length === 0
        ? staticPolls
        : [...staticPolls, ...registered],
    [staticPolls, registered],
  );
}
