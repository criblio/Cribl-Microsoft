/**
 * input-id pins (DBT-162): the `__inputId` value is `<type>:<id>`, a bare-id
 * selection is `legacy` and never `match`, and the typed form wins.
 */

import { describe, expect, it } from "vitest";
import { inputIdValue, matchInputIdFilter } from "./input-id";

const EH = { type: "eventhub", id: "hub" };

describe("inputIdValue", () => {
  it("is <type>:<id>", () => {
    expect(inputIdValue(EH)).toBe("eventhub:hub");
    expect(inputIdValue({ type: "collection", id: "job" })).toBe("collection:job");
  });
});

describe("matchInputIdFilter", () => {
  it("a catch-all is a match", () => {
    expect(matchInputIdFilter({ kind: "all" }, EH)).toBe("match");
  });

  it("an equality on the typed value is a match; on the bare id it is legacy", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["eventhub:hub"] }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub"] }, EH)).toBe("legacy");
  });

  it("the typed form wins when a list names both", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub", "eventhub:hub"] }, EH)).toBe("match");
  });

  it("another type with the same id is none, never legacy", () => {
    expect(matchInputIdFilter({ kind: "inputs", ids: ["azure_blob:hub"] }, EH)).toBe("none");
    expect(matchInputIdFilter({ kind: "inputs", ids: ["hub2", "eventhub:hub2"] }, EH)).toBe("none");
  });

  it("a prefix matches the typed value, including Cribl's trailing-colon form", () => {
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:" }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:hub:" }, EH)).toBe("match");
    expect(matchInputIdFilter({ kind: "prefix", value: "eventhub:hub2" }, EH)).toBe("none");
    expect(matchInputIdFilter({ kind: "prefix", value: "syslog:" }, EH)).toBe("none");
  });

  it("a prefix only the bare id satisfies is legacy", () => {
    expect(matchInputIdFilter({ kind: "prefix", value: "hu" }, EH)).toBe("legacy");
  });
});
