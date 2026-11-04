/**
 * Native <select> elements, as a gate rather than a rule someone has to remember.
 *
 * Standard: standards/capra-ui.md — "Dropdowns have a filter box".
 *
 * The failure it stops: the house dropdown (a combobox with a filter box and a bounded, scrollable
 * list) exists, but its rule lives somewhere the author of a NEW screen never reads - one app kept it
 * only in the component's header comment - so every new screen reaches for a native <select>. The
 * native element cannot be typed to filter, and a picker over Azure namespaces, worker groups or
 * subscriptions in a shared tenant runs to dozens of rows. Found 2026-11: 36 native selects in 22
 * files, months after the component shipped.
 *
 * Comments are blanked first, keeping every offset, so prose that names `<select>` - including the
 * combobox's own explanation of what it replaces - does not trip the gate, and line numbers stay
 * true. Quotes are deliberately NOT parsed: JSX text is full of apostrophes ("Don't"), and a quote
 * tracker that mistook one for a string would hide a real tag. The cost is that `//` after code on a
 * line is treated as a comment only when it is not part of `://` (URLs), which is the case that
 * matters in .tsx.
 *
 * Pure: give it file texts. `nativeSelects.test.template.ts` is the copy-me test that reads src/.
 */

export interface SourceFile {
  /** Path relative to the scanned root, '/'-separated. */
  path: string;
  /** Raw file text. */
  text: string;
}

export interface NativeSelectUse {
  path: string;
  /** 1-based line of the `<select` in the file. */
  line: number;
}

/** A JSX `<select` opening tag: followed by whitespace, `>` or `/`; never `<selection` or `<SelectX`. */
const OPEN_TAG = /<select(?=[\s>/])/g;

/** Same-length text with block and line comments replaced by spaces (newlines kept). */
export function blankComments(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/gm, (_m, before: string, comment: string) => before + blank(comment));
}

/**
 * Every native `<select` opening tag in the given files, outside comments. `allow` names files (by
 * `path`) that may contain one - keep it empty unless a file genuinely cannot use the combobox, and
 * say why beside the entry.
 */
export function findNativeSelects(files: readonly SourceFile[], allow: readonly string[] = []): NativeSelectUse[] {
  const allowed = new Set(allow);
  const out: NativeSelectUse[] = [];
  for (const f of files) {
    if (allowed.has(f.path)) continue;
    const text = blankComments(f.text);
    for (const m of text.matchAll(OPEN_TAG)) {
      out.push({ path: f.path, line: text.slice(0, m.index).split('\n').length });
    }
  }
  return out;
}

/** One line per use, for a failure message that says where to look. */
export function formatNativeSelects(uses: readonly NativeSelectUse[]): string {
  return uses.map((u) => `${u.path}:${u.line} - native <select>; use the filterable combobox`).join('\n');
}
