import { describe, expect, it } from "vitest";

import {
  // domain/dcr-naming
  DIRECT_DCR_NAME_MAX_LENGTH,
  DIRECT_DCR_TABLE_ABBREVIATIONS,
  DcrNamingError,
  generateDcrName,
  stripCustomTableSuffix,
  // domain/schema-mapping
  buildDcrColumnSet,
  buildStreamDeclaration,
  mapColumnType,
  NATIVE_SYSTEM_COLUMNS,
  SchemaMappingError,
  // testing fakes
  DEFAULT_FAKE_USER,
  FakeArtifactSink,
  FakeAzureManagement,
  FakeCriblClient,
  FakeJobStore,
  FakeSecretsStore,
  FakeUserContext,
  REDACTED_SECRET_PLACEHOLDER,
} from "./index";
import type {
  // ports (type-only)
  ArtifactSink,
  AzureManagement,
  CriblClient,
  JobStore,
  SecretsStore,
  UserContext,
} from "./index";

describe("@soc/core root barrel", () => {
  it("re-exports the dcr-naming domain module", () => {
    expect(typeof generateDcrName).toBe("function");
    expect(typeof stripCustomTableSuffix).toBe("function");
    expect(DcrNamingError.prototype).toBeInstanceOf(Error);
    expect(DIRECT_DCR_NAME_MAX_LENGTH).toBe(30);
    expect(Object.keys(DIRECT_DCR_TABLE_ABBREVIATIONS).length).toBeGreaterThan(0);
  });

  it("re-exports the schema-mapping domain module", () => {
    expect(typeof buildDcrColumnSet).toBe("function");
    expect(typeof buildStreamDeclaration).toBe("function");
    expect(typeof mapColumnType).toBe("function");
    expect(SchemaMappingError.prototype).toBeInstanceOf(Error);
    expect(NATIVE_SYSTEM_COLUMNS.length).toBeGreaterThan(0);
  });

  it("re-exports a fake implementing each port interface", () => {
    const secrets: SecretsStore = new FakeSecretsStore();
    const user: UserContext = new FakeUserContext();
    const artifacts: ArtifactSink = new FakeArtifactSink();
    const jobs: JobStore = new FakeJobStore();
    const azure: AzureManagement = new FakeAzureManagement();
    const cribl: CriblClient = new FakeCriblClient();
    for (const fake of [secrets, user, artifacts, jobs, azure, cribl]) {
      expect(fake).toBeDefined();
    }
    expect(typeof REDACTED_SECRET_PLACEHOLDER).toBe("string");
    expect(DEFAULT_FAKE_USER).toBeDefined();
  });
});
