/**
 * expectedLogTypes - which VENDOR log types a solution's content depends on,
 * derived from the content itself (user request 2026-08-04).
 *
 * WHY THIS IS NOT THE CONNECTOR: decodeConnector yields the DESTINATION TABLE
 * (Palo Alto resolves to CommonSecurityLog, one entry), which says nothing
 * about Traffic vs Threat vs Config. Sentinel content discriminates INSIDE the
 * table - `where DeviceEventClassID == "TRAFFIC"`, `where subtype in ("start",
 * "end")` - so the log types a solution actually needs are recoverable from the
 * literals its analytics rules, parsers, and workbook queries compare against
 * the known discriminator fields.
 *
 * WHY IT MATTERS: every unique log type the operator provides becomes its own
 * route pair, pipeline pair, and sample file in the generated pack
 * (scaffoldPack + generateRouteYml). A log type with no sample gets no route,
 * so its events are never shaped or reduced - and worse, log types that cannot
 * be told apart collapse into overlapping match-all routes where only the first
 * receives events. Knowing what the content expects lets the app ask before the
 * pack is built rather than leaving the gap in a generated YAML comment.
 *
 * HONEST LIMITS - this is a LOWER BOUND, never a vendor catalog:
 *   - rules that filter table-wide contribute nothing;
 *   - ASIM-normalized rules hide the discriminator behind a parser;
 *   - a solution with no shipped detections yields an empty result, which must
 *     read as "nothing to compare against", never as "you have everything".
 * The UI must therefore present this as advisory, matching how rule coverage
 * already behaves.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto/Math.random.
 */

import { DISCRIMINATOR_FIELDS } from "../sample-parsing";
import type { ContentItem } from "./models";

/** One log type a solution's content references, with its provenance. */
export interface ExpectedLogType {
  /** The literal value as written in the content (first-seen casing). */
  value: string;
  /** The discriminator field it was compared against (e.g. DeviceEventClassID). */
  field: string;
  /** Display names of the content items referencing it, first-seen order. */
  referencedBy: string[];
  /**
   * The KINDS of content that reference it, first-seen order.
   *
   * Why this is worth carrying: a solution with thin detections may still be
   * described by its workbooks, and "one workbook mentions this" is a weaker
   * claim than "three analytic rules filter on it". The operator deserves to
   * see which, rather than a single undifferentiated list - especially now that
   * workbooks feed this derivation alongside rules.
   */
  referencedTypes: ContentItem["type"][];
}

/** Expected-vs-provided reckoning for the Sample Data confirmation. */
export interface LogTypeCoverage {
  /** Everything the content references, sorted by descending reference count. */
  expected: ExpectedLogType[];
  /** Expected entries with no provided sample - what the user is asked about. */
  missing: ExpectedLogType[];
  /** Provided log types that matched something expected. */
  matched: string[];
  /**
   * Provided log types no content references. NOT a problem - a vendor emits
   * more than any one solution detects on - so this is reported neutrally and
   * never counted as an error.
   */
  unreferenced: string[];
}

/**
 * Compare log-type names ignoring case and separators: content writes
 * "TRAFFIC", an operator tags "traffic", Elastic splits name it "pan-os
 * traffic". Matching on the collapsed form keeps those the same thing.
 */
export function normalizeLogTypeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Backwards-compatible local alias; the exported name is the shared one. */
const normalize = normalizeLogTypeName;

/**
 * Words that are the GENERIC NOUN for "a log record" and identify no kind of
 * data on their own.
 *
 * Compared against the NORMALIZED form, so "log-type" and "logType" both arrive
 * here as "logtype".
 *
 * DELIBERATELY TIGHT. Every entry has to be a word that could never distinguish
 * one vendor feed from another, because each one costs a real match somewhere:
 * "alert", "audit", "session" and "activity" are all plausibly generic and are
 * all left OUT, because they are also real feed names ("ZIA Alerts", "Azure
 * Activity"). The list is not a stop-word list for English; it is the handful of
 * words a sample tag can carry while telling you nothing.
 */
const GENERIC_LOG_WORDS: ReadonlySet<string> = new Set([
  "event", "events", "eventtype", "eventtypes",
  "log", "logs", "logtype", "logtypes", "logfile", "logfiles",
  "message", "messages", "msg", "msgs",
  "record", "records", "entry", "entries",
  "data", "type", "types",
  "generic", "other", "unknown", "misc", "none",
]);

/**
 * Whether a PROVIDED log-type name covers an EXPECTED one.
 *
 * THE one implementation (2026-08-20 audit found three). Separator- and
 * case-insensitive, and a provided name counts when it CONTAINS the expected
 * token - an operator who tags "panos-traffic" has covered "TRAFFIC".
 *
 * Exported because the log-type merge and the vendor catalog were each
 * re-deriving it, with a comment promising they were "kept identical on
 * purpose". Intent is not a mechanism: they decide the same question, on the
 * same screen, and nothing made them stay in step.
 *
 * `providedNorm` is pre-normalized so a caller comparing many values does not
 * re-normalize the provided list per comparison. That is also why the rule below
 * cannot reach for word boundaries, which would be the obvious fix: by the time
 * a name arrives here its separators are GONE - "panos-traffic" and "PAN-OS
 * Traffic" are both "panostraffic" - so "tunnelevent" ends in "event" exactly as
 * "panostraffic" ends in "traffic", and no tokenizer can tell the two apart from
 * what it is given.
 *
 * THE TWO DIRECTIONS ARE NOT THE SAME CLAIM, which is what the rule turns on:
 *
 *   p.includes(key)   the tag is MORE specific than the expected name - it
 *                     carries a vendor or product qualifier the content's
 *                     literal does not. "panos-traffic" over "TRAFFIC". This is
 *                     the documented case and it stays permissive; it is also
 *                     the only thing that lets a Fortinet solution's literal
 *                     "event" be covered by a sample tagged "fortigate-event".
 *
 *   key.includes(p)   the tag is LESS specific than the expected name, and this
 *                     is the direction that invented coverage. Observed live: a
 *                     FortiGate sample tagged "event" was credited against a
 *                     Zscaler solution's "Tunnel Event", because "tunnelevent"
 *                     contains "event". The solution's unmet count dropped 9 to
 *                     8 and the operator was told a Zscaler tunnel detection was
 *                     covered by FortiGate system-event data carrying no Zscaler
 *                     tunnel fields - a real gap rendered as a false green.
 *
 * So the broader-tag direction now asks one more question: does what the tag
 * actually SAYS name a kind of data? "traffic" does, so "PAN-OS Traffic" is
 * still covered by a sample tagged "traffic" (pinned). "event" does not - it is
 * the generic noun for a log record ({@link GENERIC_LOG_WORDS}) - so it may only
 * match a log type genuinely called "event", by exact equality.
 *
 * WHY NOT JUST DELETE THE BROADER-TAG ARM. It is the arm the vendor catalog
 * leans on: "ZIA DNS" carries the alias "dns", and a dataset tagged
 * "zscalernss-dns" is recognised through it. That is the other direction, but
 * the same tolerance, and the aliases are why some Zscaler feeds match and
 * others do not - "ZIA Firewall" lists "NSSFWlog"/"firewall"/"fwlog" and none of
 * them is a substring of "zscalernssfw", which is the whole reason that one
 * reads as uncovered while its DNS sibling does not.
 *
 * BOTH empty-name guards are load-bearing and BOTH live here, not in the
 * callers. A name that normalizes to "" - an operator may tag a sample "-",
 * "_" or "--", since sample intake rejects only emptiness - would otherwise
 * match EVERY log type, because `key.includes("")` is always true. One
 * unlabeled sample would then read as total coverage and arm the pack build.
 * Requiring each caller to pre-filter is exactly what failed before: the copy
 * of this rule inside compareLogTypeCoverage forgot, and the two answers
 * contradicted each other on one screen.
 */
export function logTypeNameMatches(
  value: string,
  providedNorm: readonly string[],
): boolean {
  const key = normalizeLogTypeName(value);
  if (key === "") return false;
  return providedNorm.some((p) => {
    if (p === "") return false;
    if (p === key) return true;
    // The tag is the qualified form of the expected name: still permissive.
    if (p.includes(key)) return true;
    // The tag is the BROADER name. It counts only if it says something.
    return key.includes(p) && !GENERIC_LOG_WORDS.has(p);
  });
}

/** Escape a field name for safe inclusion in the extraction patterns. */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One alternation over the reconciled discriminator list, built once.
const FIELD_ALTERNATION = DISCRIMINATOR_FIELDS.map(escapeForPattern).join("|");

/** A single `field == "value"` style comparison found in a query. */
export interface DiscriminatorValue {
  field: string;
  value: string;
}

/**
 * Extract the literal values a query compares against a discriminator field.
 *
 * Deliberately does NOT reuse extractKqlFields' cleaning: that function strips
 * string literals before matching (it wants field NAMES), and the literals are
 * exactly what this needs. Only comments are removed here.
 *
 * Handles the equality/match forms Sentinel rules actually use:
 *   Field == "X"      Field =~ "X"      Field has "X"      Field contains "X"
 *   Field in ("X","Y")                  Field in~ ("X","Y")
 */
export function extractDiscriminatorValues(kql: string): DiscriminatorValue[] {
  const cleaned = kql.replace(/\/\/.*$/gm, "");
  const found: DiscriminatorValue[] = [];
  const seen = new Set<string>();

  const push = (field: string, raw: string): void => {
    const value = raw.trim();
    if (value === "") {
      return;
    }
    // Dedupe per (field, value) so a value repeated across clauses counts once.
    const key = `${field.toLowerCase()}\u0000${normalize(value)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({ field, value });
  };

  // Scalar comparisons: Field == "X" / =~ / has / contains.
  const scalar = new RegExp(
    `\\b(${FIELD_ALTERNATION})\\s*(?:==|=~|\\bhas\\b|\\bcontains\\b)\\s*(['"])([^'"]*)\\2`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = scalar.exec(cleaned)) !== null) {
    const field = match[1];
    const value = match[3];
    if (field !== undefined && value !== undefined) {
      push(field, value);
    }
  }

  // Set membership: Field in ("X", "Y") / in~ (...). Each literal inside the
  // parens is its own log type.
  const setMembership = new RegExp(
    `\\b(${FIELD_ALTERNATION})\\s+in~?\\s*\\(([^)]*)\\)`,
    "gi",
  );
  while ((match = setMembership.exec(cleaned)) !== null) {
    const field = match[1];
    const body = match[2];
    if (field === undefined || body === undefined) {
      continue;
    }
    const literals = body.matchAll(/(['"])([^'"]*)\1/g);
    for (const literal of literals) {
      const value = literal[2];
      if (value !== undefined) {
        push(field, value);
      }
    }
  }

  return found;
}

/**
 * Union the discriminator values across a solution's content items, keeping
 * first-seen casing and recording which items reference each one.
 *
 * Sorted by descending reference count, then by value, so the log types the
 * most detections depend on are the ones the operator is asked about first.
 */
export function deriveExpectedLogTypes(
  items: readonly ContentItem[],
): ExpectedLogType[] {
  const byKey = new Map<string, ExpectedLogType>();
  for (const item of items) {
    for (const query of item.queries) {
      for (const { field, value } of extractDiscriminatorValues(query)) {
        const key = normalize(value);
        if (key === "") {
          continue;
        }
        const existing = byKey.get(key);
        if (existing === undefined) {
          byKey.set(key, {
            value,
            field,
            referencedBy: [item.name],
            referencedTypes: [item.type],
          });
        } else {
          if (!existing.referencedBy.includes(item.name)) {
            existing.referencedBy.push(item.name);
          }
          if (!existing.referencedTypes.includes(item.type)) {
            existing.referencedTypes.push(item.type);
          }
        }
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.referencedBy.length - a.referencedBy.length ||
      a.value.localeCompare(b.value),
  );
}

/**
 * Reckon the expected log types against the ones the operator has provided.
 *
 * `provided` is the tagged-sample log-type list. Matching is separator- and
 * case-insensitive, and a provided name COUNTS as a match when it contains the
 * expected token (an operator who tags "panos-traffic" has covered "TRAFFIC").
 * A tag BROADER than the expected name counts too, but only when the tag names
 * a kind of data - see {@link logTypeNameMatches}, which is the one place that
 * decision is made.
 */
export function compareLogTypeCoverage(
  expected: readonly ExpectedLogType[],
  provided: readonly string[],
): LogTypeCoverage {
  const providedNorm = provided.map((p) => ({ raw: p, norm: normalize(p) }));
  const missing: ExpectedLogType[] = [];
  const matchedProvided = new Set<string>();

  for (const entry of expected) {
    // logTypeNameMatches is asked ONE CANDIDATE AT A TIME because this loop
    // needs the MATCHING entry (to record which provided name was consumed),
    // not just a boolean. Re-normalizing entry.value per candidate is free at
    // these sizes and is the price of there being ONE predicate: the copy that
    // used to sit here had already drifted from it, dropping the empty-name
    // guards, so a single sample tagged "-" made this function report every
    // log type covered while mergeLogTypeSources - rendering on the SAME
    // screen - reported none of them provided.
    const hit = providedNorm.find((p) =>
      logTypeNameMatches(entry.value, [p.norm]),
    );
    if (hit === undefined) {
      missing.push(entry);
    } else {
      matchedProvided.add(hit.raw);
    }
  }

  return {
    expected: [...expected],
    missing,
    matched: provided.filter((p) => matchedProvided.has(p)),
    unreferenced: provided.filter((p) => !matchedProvided.has(p)),
  };
}
