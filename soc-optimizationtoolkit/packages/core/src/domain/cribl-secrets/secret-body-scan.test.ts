/**
 * DBT-163: every POST/PATCH /system/secrets body the app sends comes from the
 * one builder, buildSecretBody (./secret-body.ts).
 *
 * A source scan over the three workspaces' src trees (tests excluded, comments
 * stripped), in three rules:
 *
 *   1. `secretType` appears in code ONLY in secret-body.ts. An inline secret
 *      body has to name its kind, so a hand-built one fails here.
 *   2. Every file whose code names the secrets API (`/system/secrets`) is on
 *      the reviewed ROLES table, and the table holds nothing stale. A new
 *      caller fails until someone reviews it. (The SECRETS_API_PATH constant
 *      and its barrel export, the old `constant` rows, were removed by DBT-187:
 *      nothing but tests had used them since DBT-152.)
 *   3. A `writer` calls buildSecretBody and carries no `type: "text"` body; a
 *      `reader` names the path only on GET lines; a `policy` row sends no
 *      request at all.
 *
 * What it cannot see: a body built by a helper in another file and passed in
 * (wiring-section and deploy-flowlog-pack call ensureTextSecret, DBT-152).
 * That helper is itself a writer on the table, and its bodies are pinned whole
 * in ensure-text-secret.test.ts and secret-provisioning.test.ts. Nor does rule
 * 3 count bodies: a writer that calls buildSecretBody once can still send a
 * second, kind-less body (no `secretType`, no `type`) that this scan passes.
 * The per-caller body pins catch that: ensure-text-secret.test.ts,
 * secret-provisioning.test.ts, manage-labs.test.ts and onboard-table.test.ts
 * compare whole bodies, and create-cribl-source.test.ts requires `secretType`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
/** soc-optimizationtoolkit/ */
const ROOT = join(HERE, "..", "..", "..", "..", "..");
const SRC_TREES = ["packages/core/src", "packages/ui/src", "apps/cribl-app/src"];
const BUILDER = "packages/core/src/domain/cribl-secrets/secret-body.ts";

type Role =
  /** Sends a secret body; must build it with buildSecretBody. */
  | "writer"
  /** Reads a secret; names the path only on GET lines. */
  | "reader"
  /** The policy coverage table (policies.yml); a description, not a request. */
  | "policy";

/** Reviewed: every non-test file whose code names the secrets API. */
const ROLES: Readonly<Record<string, Role>> = {
  "packages/core/src/usecases/create-cribl-source/apply-cribl-source.ts": "writer",
  "packages/core/src/usecases/onboard-table/onboard-table.ts": "writer",
  "packages/core/src/usecases/ensure-secret/ensure-text-secret.ts": "writer",
  "packages/core/src/usecases/create-cribl-source/plan-cribl-source.ts": "reader",
  "apps/cribl-app/src/platform/policies/paths.ts": "policy",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Block comments and whole-line or trailing `//` comments; URLs in strings survive. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;,{}()])\/\/.*$/gm, "$1");
}

interface Scanned {
  path: string;
  code: string;
}

function scan(): Scanned[] {
  return SRC_TREES.flatMap((tree) =>
    sourceFiles(join(ROOT, tree)).map((full) => ({
      path: relative(ROOT, full).split(sep).join("/"),
      code: stripComments(readFileSync(full, "utf8")),
    })),
  );
}

const SECRETS_API = /\/system\/secrets/;

describe("every Cribl secret body comes from buildSecretBody (DBT-163)", () => {
  const files = scan();

  it("scans the three src trees (the scan is not silently empty)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => f.path)).toContain(BUILDER);
  });

  it("names `secretType` in code only in the builder", () => {
    const carriers = files.filter((f) => /\bsecretType\b/.test(f.code)).map((f) => f.path);
    expect(carriers).toEqual([BUILDER]);
  });

  it("every file that names the secrets API is reviewed, and the review holds nothing stale", () => {
    const found = files.filter((f) => SECRETS_API.test(f.code)).map((f) => f.path).sort();
    expect(found).toEqual(Object.keys(ROLES).sort());
  });

  it.each(Object.entries(ROLES))("%s keeps to its role (%s)", (path, role) => {
    const file = files.find((f) => f.path === path);
    expect(file, path).toBeDefined();
    const code = file!.code;
    if (role === "writer") {
      expect(code).toMatch(/\bbuildSecretBody\(/);
      // The DBT-151 shape: a hand-built body that names its kind `type`.
      expect(code).not.toMatch(/\btype:\s*["'`]text["'`]/);
      return;
    }
    if (role === "reader") {
      const lines = code.split("\n").filter((l) => SECRETS_API.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(/["'`]GET["'`]/);
      return;
    }
    // policy: a table row naming a caller, not a request; it sends nothing.
    expect(code).not.toMatch(/\.request\(|\bfetch\(/);
  });
});
