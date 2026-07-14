/**
 * Characterization tests: every vector in legacy-vectors.json was produced
 * by executing the legacy PowerShell naming logic verbatim and is the
 * golden compatibility contract. If one of these fails, the implementation
 * is wrong - never the vector.
 */
import { describe, expect, it } from "vitest";
import { generateDcrName } from "./index";
import type { DcrNamingMode } from "./index";
import legacyVectors from "./legacy-vectors.json";

interface LegacyVector {
  table: string;
  mode: string;
  prefix: string;
  suffix: string;
  location: string;
  custom: boolean;
  expected: string;
}

const vectors: LegacyVector[] = legacyVectors;

function toMode(value: string): DcrNamingMode {
  if (value === "direct" || value === "dce" || value === "dce-endpoint") {
    return value;
  }
  throw new Error(`Unknown mode in legacy-vectors.json: '${value}'`);
}

describe("legacy characterization vectors", () => {
  it("pins all 276 recorded vectors", () => {
    expect(vectors).toHaveLength(276);
  });

  for (const [index, vector] of vectors.entries()) {
    const label =
      `[${index}] ${vector.mode} ${vector.table} ` +
      `(prefix='${vector.prefix}', suffix='${vector.suffix}', ` +
      `location='${vector.location}', custom=${vector.custom}) ` +
      `-> ${vector.expected}`;

    it(label, () => {
      const result = generateDcrName({
        table: vector.table,
        mode: toMode(vector.mode),
        prefix: vector.prefix,
        suffix: vector.suffix,
        location: vector.location,
        isCustomTable: vector.custom,
      });
      expect(result.name).toBe(vector.expected);
    });
  }
});
