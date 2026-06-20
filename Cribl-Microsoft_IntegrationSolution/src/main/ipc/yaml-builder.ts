// YAML emission helpers for Cribl pipeline conf files.
//
// The pack-builder hand-writes pipeline YAML as arrays of strings. The byte-exact formatting
// is a load-bearing contract: Cribl parses these files, and quoting/indentation differences
// can change behaviour. This module owns the two reusable, contract-defining pieces -- the
// filter-expression quoting rule and the Cribl-function skeleton -- so they live (and are
// tested) in one place. Conf bodies remain caller-provided pre-indented lines, so output is
// reproduced exactly.

// Escape a Cribl filter/JS expression for embedding inside a double-quoted YAML scalar.
// Backslashes first, then double quotes. An empty/missing expression becomes the literal true.
export function escapeYamlFilter(expr: string | undefined | null): string {
  if (!expr) return 'true';
  return expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface CriblFunctionSpec {
  id: string;
  // Pre-escaped filter expression (caller applies escapeYamlFilter where needed). Defaults to true.
  filter?: string;
  // Defaults to false.
  disabled?: boolean;
  // The conf body lines, already indented (the lines that follow the `conf:` key). Omit for none.
  conf?: string[];
  description?: string;
  groupId?: string;
}

// Render a single Cribl pipeline function block in the exact shape the pack-builder emits:
//
//   - id: <id>
//     filter: "<filter>"
//     disabled: <disabled>
//     conf:
//       <conf lines...>
//     description: <description>
//     groupId: <groupId>
//
// description/groupId lines are omitted when not provided; conf collapses to `conf: {}` when empty.
export function emitCriblFunction(spec: CriblFunctionSpec): string {
  const lines: string[] = [
    `  - id: ${spec.id}`,
    `    filter: "${spec.filter ?? 'true'}"`,
    `    disabled: ${spec.disabled ?? false}`,
  ];
  if (spec.conf && spec.conf.length > 0) {
    lines.push('    conf:');
    lines.push(...spec.conf);
  } else {
    lines.push('    conf: {}');
  }
  if (spec.description !== undefined) lines.push(`    description: ${spec.description}`);
  if (spec.groupId !== undefined) lines.push(`    groupId: ${spec.groupId}`);
  return lines.join('\n');
}
