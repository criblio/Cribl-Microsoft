// Test-only: shared by the pipeline-generation pins that read an emitted
// `value:` line back. Not exported from the barrel; nothing ships it.

/**
 * YAML 1.2 double-quoted scalar body -> its value, refusing any escape the
 * spec does not define (so `\'`, which a JS author reaches for, is an ERROR
 * here as it is in a YAML parser) and any bare `"`, which would end the scalar
 * early. Only the escapes this emitter could plausibly write are decoded.
 */
export function readYamlDoubleQuoted(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') throw new Error(`unescaped " at ${i}: ${body}`);
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[++i];
    if (next === "\\" || next === '"' || next === "/") out += next;
    else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else throw new Error(`invalid YAML escape \\${String(next)} at ${i - 1}: ${body}`);
  }
  return out;
}
