/**
 * The BOOLEAN STRUCTURE of a capture filter: its `&&`, `||` and `!` around
 * operands it does not look inside (DBT-190). captureFilterWarning reads each
 * operand that names `__inputId` with input-id.ts readInputIdTest and decides
 * from the tree; before this file it lifted the clauses out of the text and
 * asked each one alone, so `!(__inputId=='syslog:in_syslog')` and
 * `__inputId=='syslog:in_syslog' || __inputId=='http:in_http'` read the same
 * as the plain clause - silent, while the capture took a mixture.
 *
 * NOT A JAVASCRIPT PARSER, and it does not evaluate anything. It tokenizes
 * just enough - string, template and regex literals, brackets, identifiers -
 * that a `||` inside `/a||b/` or `') || ('` is not read as an operator, then
 * splits on the three boolean operators by precedence. Anything else is an
 * operand it leaves whole.
 *
 * WHEN IT CANNOT TELL, IT SAYS SO (null) rather than guess. A ternary, `??`,
 * comma or assignment binds LOOSER than `||`, so a filter using one outside
 * parentheses splits differently from how it reads; a stray `)` leaves text
 * over. Both come back null and the warning says it could not check the
 * filter. Inside parentheses such an operand is one opaque test, which is
 * exactly what it is. An unclosed `(` is tolerated as an opaque operand, so a
 * half-typed filter is not this file's business (Cribl's compile error is
 * more accurate than anything said here).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

/** A capture filter's boolean structure. */
export type FilterNode =
  | { kind: "and" | "or"; items: readonly FilterNode[] }
  | { kind: "not"; item: FilterNode }
  /**
   * An operand left whole. `namesInputId` says it mentions the `__inputId`
   * field (not a longer name, not a property of something else).
   */
  | { kind: "operand"; text: string; namesInputId: boolean };

interface Token {
  kind: "string" | "regex" | "name" | "punct" | "other";
  text: string;
  start: number;
  end: number;
}

/** Longest first, so `===` is not read as `==` then `=`. */
const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "=>", "++", "--", "+=", "-=",
  "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];

/** Operators that bind looser than `||`: an operand holding one is misread. */
const LOOSER_THAN_OR = new Set([
  "?", ":", "??", ",", "=", "=>", "+=", "-=", "*=", "/=", "%=", "**=", "<<=",
  ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=",
]);

/** After these a `/` starts a regex literal; after anything else it divides. */
const BEFORE_REGEX = new Set(["typeof", "return", "in", "of", "instanceof", "new", "delete", "void", "case"]);

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** The end of a quoted literal starting at `start` (past its closing quote). */
function scanQuoted(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
}

/** The end of a regex literal starting at `start`, flags included. */
function scanRegex(text: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
    } else if (c === "]") {
      inClass = false;
    } else if (c === "/" && !inClass) {
      break;
    }
    i += 1;
  }
  i += 1;
  while (i < text.length && /[a-z]/i.test(text[i])) {
    i += 1;
  }
  return Math.min(i, text.length);
}

function regexMayStart(previous: Token | undefined): boolean {
  if (previous === undefined) {
    return true;
  }
  if (previous.kind === "punct") {
    return !CLOSE.has(previous.text);
  }
  return previous.kind === "name" && BEFORE_REGEX.has(previous.text);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const start = i;
    let kind: Token["kind"];
    if (c === "'" || c === '"' || c === "`") {
      kind = "string";
      i = scanQuoted(text, i);
    } else if (c === "/" && regexMayStart(tokens[tokens.length - 1])) {
      kind = "regex";
      i = scanRegex(text, i);
    } else if (/[A-Za-z_$]/.test(c)) {
      kind = "name";
      while (i < text.length && /[\w$]/.test(text[i])) {
        i += 1;
      }
    } else if (/[0-9]/.test(c)) {
      kind = "other";
      while (i < text.length && /[\w.]/.test(text[i])) {
        i += 1;
      }
    } else {
      kind = "punct";
      const multi = PUNCTUATORS.find((p) => text.startsWith(p, i));
      i += multi?.length ?? 1;
    }
    tokens.push({ kind, text: text.slice(start, i), start, end: i });
  }
  return tokens;
}

/** Thrown inside the parser when the split would misread the filter. */
class Unreadable extends Error {}

/**
 * A parsed piece and what its parent needs to know about it. Both flags are
 * about a BARE operand (not a group, not a join):
 *   loose  - it holds an operator looser than `||` (ternary, `??`, comma,
 *            assignment). Alone it is one opaque test; joined to anything, or
 *            under `!`, the split misreads the filter.
 *   binary - it holds a binary operator, so a `!` in front binds to its first
 *            term only (`!a == b` is `(!a) == b`), not to the whole.
 */
interface Part {
  node: FilterNode;
  loose: boolean;
  binary: boolean;
}

function joined(node: FilterNode): Part {
  return { node, loose: false, binary: false };
}

class Parser {
  private pos: number;
  private readonly source: string;
  private readonly tokens: readonly Token[];
  private readonly end: number;

  constructor(source: string, tokens: readonly Token[], start: number, end: number) {
    this.source = source;
    this.tokens = tokens;
    this.pos = start;
    this.end = end;
  }

  /** The whole range as one expression; leftovers (a stray `)`) are unreadable. */
  parseAll(): Part {
    const part = this.parseOr();
    if (this.pos !== this.end) {
      throw new Unreadable();
    }
    return part;
  }

  private peek(): string | undefined {
    return this.pos < this.end ? this.tokens[this.pos].text : undefined;
  }

  private parseOr(): Part {
    return this.parseJoined("||", () => this.parseAnd());
  }

  private parseAnd(): Part {
    return this.parseJoined("&&", () => this.parseUnary());
  }

  private parseJoined(op: "||" | "&&", next: () => Part): Part {
    const parts = [next()];
    while (this.peek() === op) {
      this.pos += 1;
      parts.push(next());
    }
    if (parts.length === 1) {
      return parts[0];
    }
    if (parts.some((part) => part.loose)) {
      throw new Unreadable();
    }
    return joined({ kind: op === "||" ? "or" : "and", items: parts.map((p) => p.node) });
  }

  private parseUnary(): Part {
    if (this.peek() !== "!") {
      return this.parsePrimary();
    }
    const bang = this.tokens[this.pos];
    this.pos += 1;
    const part = this.parseUnary();
    if (part.loose) {
      throw new Unreadable();
    }
    if (part.binary && part.node.kind === "operand") {
      // `!a == b`: the `!` is part of the operand's first term, so the
      // operand stays whole, `!` included, and is not read as negated.
      const last = this.tokens[this.pos - 1];
      return {
        node: {
          kind: "operand",
          text: this.source.slice(bang.start, last.end),
          namesInputId: part.node.namesInputId,
        },
        loose: false,
        binary: true,
      };
    }
    return joined({ kind: "not", item: part.node });
  }

  /**
   * One operand: tokens up to a `&&`, `||` or unmatched `)` at this depth. A
   * run that is exactly one parenthesised group is parsed inside; any other
   * run (a call, a comparison, `(a).b`) is left whole.
   */
  private parsePrimary(): Part {
    const start = this.pos;
    let depth = 0;
    let loose = false;
    let binary = false;
    for (; this.pos < this.end; this.pos += 1) {
      const token = this.tokens[this.pos];
      const t = token.kind === "punct" ? token.text : "";
      if (depth === 0 && (t === "&&" || t === "||" || t === ")")) {
        break;
      }
      if (OPEN.has(t)) {
        depth += 1;
      } else if (CLOSE.has(t)) {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && t !== "") {
        loose ||= LOOSER_THAN_OR.has(t);
        binary ||= ![".", "?.", "!", "~", "++", "--"].includes(t);
      }
    }
    if (this.pos === start) {
      // Nothing between two operators: a filter Cribl will refuse to compile.
      return joined({ kind: "operand", text: "", namesInputId: false });
    }
    const close = this.matchingClose(start);
    if (close === this.pos - 1) {
      // A group: whatever is inside, the parentheses make it one test.
      const inner = new Parser(this.source, this.tokens, start + 1, close).parseAll();
      return joined(inner.node);
    }
    let namesInputId = false;
    for (let i = start; i < this.pos; i += 1) {
      const previous = i > start ? this.tokens[i - 1].text : "";
      if (this.tokens[i].text === "__inputId" && previous !== "." && previous !== "?.") {
        namesInputId = true;
      }
    }
    const text = this.source.slice(this.tokens[start].start, this.tokens[this.pos - 1].end);
    return { node: { kind: "operand", text, namesInputId }, loose, binary };
  }

  /** The index of the `)` closing a `(` at `start` within this operand, or -1. */
  private matchingClose(start: number): number {
    if (this.tokens[start].text !== "(") {
      return -1;
    }
    let depth = 0;
    for (let i = start; i < this.pos; i += 1) {
      const t = this.tokens[i].kind === "punct" ? this.tokens[i].text : "";
      if (OPEN.has(t)) {
        depth += 1;
      } else if (CLOSE.has(t)) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }
}

/** The filter's boolean structure, or null when splitting it would misread it. */
export function readFilterStructure(filter: string): FilterNode | null {
  const tokens = tokenize(filter);
  try {
    return new Parser(filter, tokens, 0, tokens.length).parseAll().node;
  } catch (error) {
    if (error instanceof Unreadable) {
      return null;
    }
    throw error;
  }
}
