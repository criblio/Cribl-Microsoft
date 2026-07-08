/**
 * SearchableSelect / SearchableMultiSelect - the default control for any list
 * that can grow: a compact combobox that opens a BOUNDED, scrollable popover
 * with a filter box, instead of a native <select> (which balloons the page for
 * long lists and cannot be typed-to-filter). Self-contained (no external combo
 * library - the app ships under a strict CSP), keyboard + mouse driven.
 *
 * All matching/highlight math is the pure searchable-select-filter module; this
 * file is only the DOM shell and interaction wiring.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  clampHighlight,
  filterOptions,
  moveHighlight,
  multiSummary,
  selectedLabel,
} from "./searchable-select-filter";
import type { SelectOption } from "./searchable-select-filter";

export type { SelectOption } from "./searchable-select-filter";

/** Shared open/query/highlight state + dismiss-on-outside-click/Escape. */
function useCombo(options: readonly SelectOption[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterOptions(options, query), [options, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    setHighlight((h) => clampHighlight(h, filtered.length));
  }, [filtered.length]);

  return {
    open,
    setOpen,
    query,
    setQuery,
    highlight,
    setHighlight,
    filtered,
    rootRef,
    inputRef,
    close,
  };
}

interface PopoverProps {
  query: string;
  onQuery: (q: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  ariaLabel: string;
  children: ReactNode;
}

function Popover({ query, onQuery, onKeyDown, inputRef, ariaLabel, children }: PopoverProps) {
  return (
    <div className="searchable-select-popover">
      <input
        ref={inputRef}
        className="searchable-select-search"
        type="text"
        value={query}
        placeholder="Filter..."
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul className="searchable-select-list" role="listbox">
        {children}
      </ul>
    </div>
  );
}

export interface SearchableSelectProps {
  options: readonly SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Single-select combobox: pick one option; the popover closes on selection. */
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  disabled = false,
  ariaLabel,
  className,
}: SearchableSelectProps) {
  const c = useCombo(options);

  const pick = useCallback(
    (v: string) => {
      onChange(v);
      c.close();
    },
    [onChange, c],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      c.setHighlight((h) => moveHighlight(h, 1, c.filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      c.setHighlight((h) => moveHighlight(h, -1, c.filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = c.filtered[c.highlight];
      if (o !== undefined) pick(o.value);
    }
  };

  return (
    <div
      className={`searchable-select${className !== undefined ? ` ${className}` : ""}`}
      ref={c.rootRef}
    >
      <button
        type="button"
        className="searchable-select-control"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={c.open}
        onClick={() => c.setOpen((o) => !o)}
      >
        <span className={value === "" ? "searchable-select-placeholder" : undefined}>
          {selectedLabel(options, value, placeholder)}
        </span>
      </button>
      {c.open && (
        <Popover
          query={c.query}
          onQuery={(q) => {
            c.setQuery(q);
            c.setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          inputRef={c.inputRef}
          ariaLabel={ariaLabel ?? "Filter options"}
        >
          {c.filtered.length === 0 ? (
            <li className="searchable-select-empty">No matches</li>
          ) : (
            c.filtered.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`searchable-select-option${i === c.highlight ? " is-highlighted" : ""}${o.value === value ? " is-selected" : ""}`}
                onMouseEnter={() => c.setHighlight(i)}
                onClick={() => pick(o.value)}
              >
                <span className="searchable-select-option-label">{o.label}</span>
                {o.hint !== undefined && (
                  <span className="searchable-select-option-hint">{o.hint}</span>
                )}
              </li>
            ))
          )}
        </Popover>
      )}
    </div>
  );
}

export interface SearchableMultiSelectProps {
  options: readonly SelectOption[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Multi-select combobox: toggle options; the popover stays open while picking. */
export function SearchableMultiSelect({
  options,
  values,
  onChange,
  placeholder = "Select...",
  disabled = false,
  ariaLabel,
  className,
}: SearchableMultiSelectProps) {
  const c = useCombo(options);
  const selected = useMemo(() => new Set(values), [values]);

  const toggle = useCallback(
    (v: string) => {
      onChange(
        selected.has(v) ? values.filter((x) => x !== v) : [...values, v],
      );
    },
    [onChange, selected, values],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      c.setHighlight((h) => moveHighlight(h, 1, c.filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      c.setHighlight((h) => moveHighlight(h, -1, c.filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = c.filtered[c.highlight];
      if (o !== undefined) toggle(o.value);
    }
  };

  return (
    <div
      className={`searchable-select${className !== undefined ? ` ${className}` : ""}`}
      ref={c.rootRef}
    >
      <button
        type="button"
        className="searchable-select-control"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={c.open}
        onClick={() => c.setOpen((o) => !o)}
      >
        <span className={values.length === 0 ? "searchable-select-placeholder" : undefined}>
          {multiSummary(options, values, placeholder)}
        </span>
      </button>
      {c.open && (
        <Popover
          query={c.query}
          onQuery={(q) => {
            c.setQuery(q);
            c.setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          inputRef={c.inputRef}
          ariaLabel={ariaLabel ?? "Filter options"}
        >
          {c.filtered.length === 0 ? (
            <li className="searchable-select-empty">No matches</li>
          ) : (
            c.filtered.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={selected.has(o.value)}
                className={`searchable-select-option searchable-select-option-multi${i === c.highlight ? " is-highlighted" : ""}${selected.has(o.value) ? " is-selected" : ""}`}
                onMouseEnter={() => c.setHighlight(i)}
                onClick={() => toggle(o.value)}
              >
                <span className="searchable-select-check" aria-hidden="true" />
                <span className="searchable-select-option-label">{o.label}</span>
                {o.hint !== undefined && (
                  <span className="searchable-select-option-hint">{o.hint}</span>
                )}
              </li>
            ))
          )}
        </Popover>
      )}
    </div>
  );
}
