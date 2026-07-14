/**
 * Headerless-CSV resolution with externally-supplied column names - porting-plan
 * Unit 12 (ENG-17, GUI-07). Used when the parsed sample looks like headerless
 * positional CSV (see {@link isHeaderlessCsv} from Unit 11) and the user supplies
 * the column names by uploading a header file or pasting a vendor feed config
 * (see parseFeedConfig).
 *
 * Ported from the legacy sample-parser.ts `parseCsvWithHeaders`, emitting the
 * Unit 11 {@link ParsedSample} shape (reusing collectFields + the merge lattice
 * and guessTimestampField rather than re-implementing them).
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import {
  RAW_EVENTS_CAP,
  type ParsedSample,
} from "./models";
import { stripSyslogPrefix } from "./parsers";
import { collectFields, guessTimestampField } from "./parse-sample";

/** Options for {@link parseCsvWithHeaders}. */
export interface ParseCsvWithHeadersOptions {
  /**
   * Drop the first data line before applying headers. Set when the pasted CSV
   * still carries its own header row that the supplied `headers` replace.
   * Defaults to false.
   */
  skipFirstRow?: boolean;
  /** Label recorded on the result; defaults to "csv-with-headers". */
  sourceName?: string;
}

/**
 * Resolve headerless CSV `content` into a {@link ParsedSample} by naming each
 * positional value from `headers`. Behavior pinned by csv-headers.test.ts:
 *
 * - The syslog prefix is stripped from every line BEFORE splitting on commas
 *   (via the Unit 11 {@link stripSyslogPrefix}), so a syslog-wrapped PAN-OS line
 *   lines up with the supplied headers.
 * - A header named `future_use*` is SKIPPED (its positional value is discarded),
 *   matching PAN-OS placeholder columns.
 * - When a row has MORE values than headers, the surplus values are kept as
 *   overflow columns named `_extra_${i}` where `i` is the absolute value index
 *   (starts at `headers.length`), so no data is silently dropped.
 * - QUOTED-COMMA LIMITATION (documented, NOT fixed): splitting is a naive
 *   `String.split(",")`. A quoted value that itself contains a comma (e.g.
 *   `"a,b"`) is split into two fields, shifting every column after it and
 *   spilling one value into the `_extra_*` overflow. This matches the legacy
 *   parser; a real CSV state machine is out of scope for this unit.
 */
export function parseCsvWithHeaders(
  content: string,
  headers: readonly string[],
  options: ParseCsvWithHeadersOptions = {},
): ParsedSample {
  const skipFirstRow = options.skipFirstRow ?? false;
  const sourceName = options.sourceName ?? "csv-with-headers";

  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return {
      format: "csv",
      records: [],
      eventCount: 0,
      fields: [],
      rawEvents: [],
      sourceName,
      errors: ["No data lines found"],
    };
  }

  const dataLines = skipFirstRow ? lines.slice(1) : lines;
  const records: Array<Record<string, unknown>> = [];

  for (const line of dataLines) {
    // Strip the syslog prefix (if any) BEFORE splitting - see the module note.
    const stripped = stripSyslogPrefix(line);
    const values = stripped
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""));
    const record: Record<string, unknown> = {};

    const named = Math.min(headers.length, values.length);
    for (let i = 0; i < named; i += 1) {
      const name = headers[i].trim();
      if (name && !name.startsWith("future_use")) {
        record[name] = values[i] ?? "";
      }
    }
    // Overflow: values beyond the supplied headers become _extra_${i}.
    for (let i = headers.length; i < values.length; i += 1) {
      record[`_extra_${i}`] = values[i];
    }

    if (Object.keys(record).length > 0) {
      records.push(record);
    }
  }

  const fields = collectFields(records);
  const timestampField = guessTimestampField(fields);
  const rawEvents = records
    .slice(0, RAW_EVENTS_CAP)
    .map((record) => JSON.stringify(record));

  return {
    format: "csv",
    records,
    eventCount: records.length,
    fields,
    rawEvents,
    sourceName,
    ...(timestampField !== undefined ? { timestampField } : {}),
    errors: [],
  };
}
