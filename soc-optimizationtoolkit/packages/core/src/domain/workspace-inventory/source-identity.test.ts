import { describe, expect, it } from "vitest";
import { identityKql, SOURCE_IDENTITY_AS_OF, SOURCE_IDENTITY_RULES } from "./source-identity";

describe("the identity map", () => {
  it("is dated and names the three mapped tables", () => {
    expect(SOURCE_IDENTITY_AS_OF).toBe("2026-11-04");
    expect(SOURCE_IDENTITY_RULES.map((r) => [r.table, r.attribution, r.keepsCollector])).toEqual([
      ["CommonSecurityLog", "product", true],
      ["SecurityAlert", "product", true],
      ["Syslog", "computer", false],
    ]);
  });
});

describe("identityKql", () => {
  const kql = identityKql();

  it("reads every identity column through column_ifexists, never bare", () => {
    for (const c of ["DeviceVendor", "DeviceProduct", "ProductName", "ProviderName", "Computer", "Facility"]) {
      expect(kql).toContain(`column_ifexists('${c}', '')`);
    }
    expect(kql.replace(/column_ifexists\('[^']+'/g, "")).not.toMatch(
      /\b(DeviceVendor|DeviceProduct|ProductName|ProviderName|Facility|_ResourceId)\b/,
    );
  });

  it("branches per mapped table, only when its identity is non-empty", () => {
    expect(kql).toContain("SourceTable =~ 'CommonSecurityLog' and isnotempty(_id0)");
    expect(kql).toContain("SourceTable =~ 'SecurityAlert' and isnotempty(_id1)");
    expect(kql).toContain("SourceTable =~ 'Syslog' and isnotempty(_id2)");
  });

  it("falls through to the default order for unmapped tables and empty identities", () => {
    expect(kql).toContain("isnotempty(_rid), _rid, isnotempty(_comp), _comp, isnotempty(_dev), _dev, ''");
  });

  it("keeps a collector for CommonSecurityLog and SecurityAlert, not Syslog", () => {
    const collector = kql.slice(kql.indexOf("Collector = case("));
    expect(collector).toContain("SourceTable =~ 'CommonSecurityLog'");
    expect(collector).toContain("SourceTable =~ 'SecurityAlert'");
    expect(collector).not.toContain("Syslog");
  });

  it("takes the collector from _ResourceId's last path segment, else Computer", () => {
    expect(kql).toContain("iff(isnotempty(_rid), tostring(split(_rid, '/')[-1]), _comp)");
  });

  it("falls back from ProductName to ProviderName", () => {
    expect(kql).toMatch(/case\(isnotempty\(tostring\(column_ifexists\('ProductName', ''\)\)\)/);
  });
});
