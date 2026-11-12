import { describe, expect, it } from "vitest";
import {
  GAP_SOURCES,
  azureGapIndicator,
  criblGapIndicator,
  rowUnknown,
  type CriblGapInput,
} from "./tenant-gap";
import { ONBOARDING_SOURCES } from "../onboarding-howto/sources";
import type { StepVerdict } from "../onboarding-howto/check-kinds";

const OK: StepVerdict = { kind: "as-expected" };
const ABSENT: StepVerdict = { kind: "absent" };
const DENIED: StepVerdict = { kind: "unknown", reason: "denied", detail: "HTTP 403" };
const MISSING: StepVerdict = { kind: "unknown", reason: "missing-value", detail: "Event Hub namespace" };
const DIFFERS: StepVerdict = {
  kind: "present-differs",
  diffs: [{ field: "eventHubName", expected: "hub-a", actual: "hub-b" }],
};

describe("GAP_SOURCES", () => {
  it("is the onboarding source catalog, every source in its order", () => {
    expect(GAP_SOURCES.map((s) => s.id)).toEqual(ONBOARDING_SOURCES.map((s) => s.id));
    expect(GAP_SOURCES.length).toBe(8);
  });
});

describe("azureGapIndicator", () => {
  it("is green only when every check matched, and says how many", () => {
    const i = azureGapIndicator([
      { kind: "eh-namespace", verdict: OK },
      { kind: "entra-setting", verdict: OK },
    ]);
    expect(i.state).toBe("green");
    expect(i.reason).toContain("2 checks");
  });

  it("is unknown with no checks at all - nothing checked is not all good", () => {
    expect(azureGapIndicator([]).state).toBe("unknown");
  });

  it("is red when something was measured absent, even beside an unread check", () => {
    const i = azureGapIndicator([
      { kind: "eh-namespace", verdict: DENIED },
      { kind: "entra-setting", verdict: ABSENT },
    ]);
    expect(i.state).toBe("red");
    expect(i.reason).toContain("the Entra diagnostic setting");
    expect(i.reason).toContain("1 other check could not be read");
  });

  it("is red when a setting exists but differs from the plan, naming the field", () => {
    const i = azureGapIndicator([{ kind: "entra-setting", verdict: DIFFERS }]);
    expect(i.state).toBe("red");
    expect(i.reason).toContain("eventHubName");
    expect(i.reason).toContain("hub-a");
    expect(i.reason).toContain("hub-b");
  });

  it("a refused read is unknown, never red", () => {
    const i = azureGapIndicator([
      { kind: "eh-namespace", verdict: OK },
      { kind: "entra-setting", verdict: DENIED },
    ]);
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("no permission");
  });

  it("an unset plan value is unknown and points at where to set it", () => {
    const i = azureGapIndicator([{ kind: "eh-namespace", verdict: MISSING }]);
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("Azure Native Source Onboarding");
  });

  it("the same object under another name with nothing different is configured", () => {
    const i = azureGapIndicator([
      { kind: "entra-setting", verdict: { kind: "present-other-name", name: "corp-setting", diffs: [] } },
    ]);
    expect(i.state).toBe("green");
    expect(i.reason).toContain("corp-setting");
  });

  it("another name that also differs is red", () => {
    const i = azureGapIndicator([
      {
        kind: "entra-setting",
        verdict: { kind: "present-other-name", name: "corp", diffs: [{ field: "logs", expected: "a", actual: "b" }] },
      },
    ]);
    expect(i.state).toBe("red");
  });
});

const RECORD = { groupId: "default", inputId: "in_entra_1a2b3c4d", inputType: "eventhub", secretId: "s1" } as const;
const TENANT = "1a2b3c4d-0000-0000-0000-000000000000";

function cribl(over: Partial<CriblGapInput>): CriblGapInput {
  return {
    title: "Entra ID",
    tenantId: TENANT,
    record: RECORD,
    group: { kind: "mapped", groupId: "default", mode: "shared" },
    inputs: { state: "read", items: [{ id: RECORD.inputId, type: "eventhub" }] },
    ...over,
  };
}

describe("criblGapIndicator", () => {
  it("is green when the recorded input is in Cribl's listing of its group", () => {
    const i = criblGapIndicator(cribl({}));
    expect(i.state).toBe("green");
    expect(i.reason).toContain(RECORD.inputId);
    expect(i.reason).toContain("default");
  });

  it("is red with no record, says what is not counted, and names the mapped group", () => {
    const i = criblGapIndicator(cribl({ record: null, inputs: null }));
    expect(i.state).toBe("red");
    expect(i.reason).toContain("by hand");
    expect(i.reason).toContain("default");
  });

  it("with no record and no group mapped, says so", () => {
    const i = criblGapIndicator(cribl({ record: null, inputs: null, group: { kind: "unset", why: "no-mode" } }));
    expect(i.state).toBe("red");
    expect(i.reason).toContain("No worker group is mapped");
  });

  it("is unknown when the group's listing was refused", () => {
    const i = criblGapIndicator(cribl({ inputs: { state: "refused", detail: "the inputs list: HTTP 403" } }));
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("HTTP 403");
  });

  it("is unknown when Cribl was not read", () => {
    expect(criblGapIndicator(cribl({ inputs: null })).state).toBe("unknown");
  });

  it("an EMPTY listing is unknown, never red - a permission filter looks the same", () => {
    const i = criblGapIndicator(cribl({ inputs: { state: "read", items: [] } }));
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("permission");
  });

  it("is red when a non-empty listing lacks the recorded input", () => {
    const i = criblGapIndicator(cribl({ inputs: { state: "read", items: [{ id: "other", type: "eventhub" }] } }));
    expect(i.state).toBe("red");
    expect(i.reason).toContain("no longer has");
  });

  it("is red when the input is disabled", () => {
    const i = criblGapIndicator(
      cribl({ inputs: { state: "read", items: [{ id: RECORD.inputId, type: "eventhub", disabled: true }] } }),
    );
    expect(i.state).toBe("red");
    expect(i.reason).toContain("disabled");
  });

  it("is red when the id now belongs to another input type", () => {
    const i = criblGapIndicator(
      cribl({ inputs: { state: "read", items: [{ id: RECORD.inputId, type: "azure_blob" }] } }),
    );
    expect(i.state).toBe("red");
  });

  it("is unknown when the input's description names another tenant", () => {
    const i = criblGapIndicator(
      cribl({
        inputs: {
          state: "read",
          items: [{ id: RECORD.inputId, type: "eventhub", description: "Entra (tenant 99999999-0000)" }],
        },
      }),
    );
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("99999999-0000");
  });

  it("is unknown on a malformed listing row", () => {
    expect(criblGapIndicator(cribl({ inputs: { state: "read", items: ["x"] } })).state).toBe("unknown");
  });

  it("stays green when the mapping now names another group, and says new sources go there", () => {
    const i = criblGapIndicator(cribl({ group: { kind: "mapped", groupId: "tenant-a", mode: "per-tenant" } }));
    expect(i.state).toBe("green");
    expect(i.reason).toContain("tenant-a");
  });
});

describe("criblGapIndicator with the legacy key (AZR-108)", () => {
  const OLD = { groupId: "grp-old", inputId: "in_entra_old", inputType: "eventhub", secretId: "s0" } as const;

  it("no own record but one recorded by an earlier version is unknown, not red, and names it as not adopted", () => {
    const i = criblGapIndicator(
      cribl({ record: null, inputs: null, legacy: { kind: "record", record: OLD, attribution: "this-tenant" } }),
    );
    expect(i.state).toBe("unknown");
    expect(i.reason).toBe(
      "This app holds no Cribl source for Entra ID under this tenant. An earlier app version recorded input " +
        "in_entra_old in worker group grp-old for this tenant. It was recorded by an earlier app version and not " +
        "adopted: this dashboard does not count it, and nothing here moves it. Review it on Azure Native Source Onboarding.",
    );
  });

  it("an unattributed earlier record says whose it is is unknown", () => {
    const i = criblGapIndicator(
      cribl({ record: null, inputs: null, legacy: { kind: "record", record: OLD, attribution: "unattributed" } }),
    );
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("with no tenant named, so whose it is is unknown");
    expect(i.reason).not.toContain("for this tenant.");
  });

  it("an unreadable legacy key makes a no-record cell could-not-check, never red", () => {
    const i = criblGapIndicator(
      cribl({
        record: null,
        inputs: null,
        legacy: { kind: "unknown", reason: "the earlier single-tenant copy could not be read (HTTP 503)" },
      }),
    );
    expect(i.state).toBe("unknown");
    expect(i.reason).toContain("could not be checked: the earlier single-tenant copy could not be read (HTTP 503)");
  });

  it("an unreadable legacy key does not change a cell this app has its own record for", () => {
    const withLegacy = criblGapIndicator(cribl({ legacy: { kind: "unknown", reason: "HTTP 503" } }));
    expect(withLegacy).toEqual(criblGapIndicator(cribl({})));
    expect(withLegacy.state).toBe("green");
  });

  it("an own record keeps its colour and also names a differing earlier record", () => {
    const i = criblGapIndicator(cribl({ legacy: { kind: "record", record: OLD, attribution: "this-tenant" } }));
    expect(i.state).toBe("green");
    expect(i.reason.startsWith(`Onboarded: input ${RECORD.inputId}`)).toBe(true);
    expect(i.reason).toContain("in_entra_old in worker group grp-old");
  });
});

describe("rowUnknown", () => {
  it("makes every cell of the row unknown, both indicators, with the reason", () => {
    const cells = rowUnknown("the tenant proof failed");
    expect(cells.length).toBe(GAP_SOURCES.length);
    for (const c of cells) {
      expect(c.azure).toEqual({ state: "unknown", reason: "the tenant proof failed" });
      expect(c.cribl).toEqual({ state: "unknown", reason: "the tenant proof failed" });
    }
  });
});
