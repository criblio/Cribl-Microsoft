/**
 * In-memory fakes for the SentinelContent port and the ContentCache abstraction
 * (porting-plan Unit 14). Pure and deterministic - no clock, no ids, no IO.
 *
 * FakeSentinelContent models a tiny virtual repo as a flat `path -> content`
 * map. Recursion (listConnectorFiles) and deprecation are computed with the
 * SAME domain helpers the real adapters use (selectConnectorFiles,
 * classifySolutionDeprecation), so a test that passes against the fake pins the
 * real contract. rawFetch ignores the commit (the fake serves one snapshot);
 * the seeded commit SHA drives cache-key derivation tests.
 */

import type {
  SentinelContent,
  ContentCache,
  SolutionRef,
  SolutionFileRef,
} from "../ports/sentinel-content";
import { classifySolutionDeprecation } from "../domain/sentinel-content/deprecation";
import { selectConnectorFiles } from "../domain/sentinel-content/discovery";

/** Seed for {@link FakeSentinelContent}. */
export interface FakeSentinelContentSeed {
  /** Repo-relative path -> file text (e.g. "Solutions/Foo/Data Connectors/x.json"). */
  files: Record<string, string>;
  /** The HEAD commit SHA getCommitSha resolves; defaults to a fixed value. */
  commitSha?: string;
}

const DEFAULT_COMMIT = "abcdef012345";

export class FakeSentinelContent implements SentinelContent {
  private readonly files: Map<string, string>;
  private readonly commitSha: string;

  constructor(seed: FakeSentinelContentSeed) {
    this.files = new Map(Object.entries(seed.files));
    this.commitSha = seed.commitSha ?? DEFAULT_COMMIT;
  }

  private allPaths(): string[] {
    return [...this.files.keys()];
  }

  private solutionNames(): string[] {
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith("Solutions/")) continue;
      const name = path.split("/")[1];
      if (name) names.add(name);
    }
    return [...names];
  }

  async listSolutions(): Promise<SolutionRef[]> {
    const refs = this.solutionNames().map((name): SolutionRef => {
      const dataPrefix = `Solutions/${name}/Data/`;
      const solutionDataContents: string[] = [];
      for (const [path, content] of this.files) {
        if (!path.startsWith(dataPrefix)) continue;
        const base = path.slice(dataPrefix.length);
        if (base.includes("/")) continue; // direct children only
        if (base.startsWith("Solution_") && base.endsWith(".json")) {
          solutionDataContents.push(content);
        }
      }
      const connectorContents = selectConnectorFiles(this.allPaths(), name).map(
        (f) => this.files.get(f.path) ?? "",
      );
      const { deprecated, reason } = classifySolutionDeprecation({
        name,
        solutionDataContents,
        connectorContents,
      });
      const ref: SolutionRef = { name, path: `Solutions/${name}` };
      if (deprecated) {
        ref.deprecated = true;
        ref.deprecationReason = reason;
      }
      return ref;
    });
    refs.sort((a, b) => a.name.localeCompare(b.name));
    return refs;
  }

  async listSolutionFiles(
    solutionName: string,
    subDir: string,
  ): Promise<SolutionFileRef[]> {
    const prefix = `Solutions/${solutionName}/${subDir}/`;
    const out: SolutionFileRef[] = [];
    for (const [path, content] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/") || rest.length === 0) continue; // direct children
      out.push({ name: rest, path, size: content.length });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  async listConnectorFiles(solutionName: string): Promise<SolutionFileRef[]> {
    return selectConnectorFiles(this.allPaths(), solutionName, (path) =>
      (this.files.get(path) ?? "").length,
    );
  }

  async readFile(relativePath: string): Promise<string | null> {
    return this.files.get(relativePath) ?? null;
  }

  async rawFetch(relativePath: string, _commitSha: string): Promise<string | null> {
    return this.files.get(relativePath) ?? null;
  }

  async getCommitSha(): Promise<string | null> {
    return this.commitSha;
  }
}

/**
 * In-memory {@link ContentCache}. Values round-trip through JSON on the way in
 * and out (mirroring the KV/host adapters' serialization), so a mutated
 * returned value never affects the store. `get` resolves null on a miss.
 */
export class FakeContentCache implements ContentCache {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<unknown | null> {
    const raw = this.entries.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as unknown);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.entries.set(key, JSON.stringify(value));
  }

  /** Test helper: how many entries are cached. */
  get size(): number {
    return this.entries.size;
  }
}
