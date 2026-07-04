import { describe, expect, it } from "vitest";
import {
  CRIBL_OPTION_FIELDS,
  DEFAULT_CRIBL_OPTIONS,
  DEFAULT_OPERATION_OPTIONS,
  OPERATION_OPTION_FIELDS,
  OPTION_FORMS,
  applyOptionsPatch,
  destinationIdFromOptions,
  formValuesToOptions,
  getNestedValue,
  optionsToFormValues,
  parseAppOptions,
  parseCriblOptions,
  parseOperationOptions,
  serializeAppOptions,
  setNestedValue,
  validateOptions,
} from "./option-forms";
import type { AppOptions, OptionFormValues } from "./option-forms";
import { defaultSentinelDestinationId } from "../sentinel-destination";

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

describe("option form descriptors", () => {
  it("covers every typed field of both forms, in order", () => {
    expect(OPERATION_OPTION_FIELDS.map((f) => f.key)).toEqual(
      Object.keys(DEFAULT_OPERATION_OPTIONS),
    );
    expect(CRIBL_OPTION_FIELDS.map((f) => f.key)).toEqual(
      Object.keys(DEFAULT_CRIBL_OPTIONS),
    );
  });

  it("carries the legacy operational knowledge in the descriptions", () => {
    const createDce = OPERATION_OPTION_FIELDS.find(
      (f) => f.key === "createDCE",
    );
    expect(createDce?.description).toContain("64-character");
    expect(createDce?.description).toContain("30-character");
    expect(createDce?.description).toContain("4.14");
    const ampls = OPERATION_OPTION_FIELDS.find(
      (f) => f.key === "amplsResourceId",
    );
    expect(ampls?.description).toContain("privateLinkScopes");
  });

  it("lists the operation form before the cribl form", () => {
    expect(OPTION_FORMS.map((form) => form.id)).toEqual([
      "operation",
      "cribl",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tolerant parsing (azure-config discipline: junk -> defaults per field)
// ---------------------------------------------------------------------------

describe("parseAppOptions", () => {
  it("returns full defaults for null, blank, and malformed input", () => {
    for (const raw of [null, undefined, "", "   ", "{not json", "[1,2]"]) {
      const parsed = parseAppOptions(raw);
      expect(parsed.operation).toEqual(DEFAULT_OPERATION_OPTIONS);
      expect(parsed.cribl).toEqual(DEFAULT_CRIBL_OPTIONS);
    }
  });

  it("parses stored values and defaults junk PER FIELD", () => {
    const parsed = parseAppOptions(
      JSON.stringify({
        operation: {
          createDCE: true,
          skipExistingDCRs: "yes", // junk -> default true
          deploymentTimeoutSeconds: 300,
          keepTemplateVersions: -2, // below minimum -> default 1
          customTableRetentionDays: 45, // not 30|90 -> default 30
          amplsResourceId: 7, // junk -> ''
        },
        cribl: { destinationPrefix: "Sec-", workerGroup: "prod" },
      }),
    );
    expect(parsed.operation.createDCE).toBe(true);
    expect(parsed.operation.skipExistingDCRs).toBe(true);
    expect(parsed.operation.deploymentTimeoutSeconds).toBe(300);
    expect(parsed.operation.keepTemplateVersions).toBe(1);
    expect(parsed.operation.customTableRetentionDays).toBe(30);
    expect(parsed.operation.amplsResourceId).toBe("");
    // Fields the blob never carried get their defaults.
    expect(parsed.operation.templateOnly).toBe(false);
    expect(parsed.operation.dcePublicNetworkAccess).toBe(true);
    expect(parsed.cribl.destinationPrefix).toBe("Sec-");
    expect(parsed.cribl.destinationSuffix).toBe("-dest");
    expect(parsed.cribl.workerGroup).toBe("prod");
  });

  it("keeps a deliberately blank cribl suffix (empty string is a value)", () => {
    expect(
      parseCriblOptions({ destinationSuffix: "" }).destinationSuffix,
    ).toBe("");
  });

  it("round-trips through serializeAppOptions", () => {
    const options: AppOptions = {
      operation: {
        ...DEFAULT_OPERATION_OPTIONS,
        createDCE: true,
        deploymentTimeoutSeconds: 120,
        customTableRetentionDays: 90,
        amplsResourceId: "/subscriptions/s/resourceGroups/r",
      },
      cribl: {
        destinationPrefix: "P-",
        destinationSuffix: "-D",
        workerGroup: "edge",
      },
    };
    expect(parseAppOptions(serializeAppOptions(options))).toEqual(options);
  });

  it("parseOperationOptions returns defaults for non-objects", () => {
    expect(parseOperationOptions(null)).toEqual(DEFAULT_OPERATION_OPTIONS);
    expect(parseOperationOptions("x")).toEqual(DEFAULT_OPERATION_OPTIONS);
    expect(parseOperationOptions([])).toEqual(DEFAULT_OPERATION_OPTIONS);
  });
});

// ---------------------------------------------------------------------------
// Form-value projection and validation
// ---------------------------------------------------------------------------

describe("optionsToFormValues", () => {
  it("keeps booleans and stringifies numbers for the controls", () => {
    const values = optionsToFormValues(OPERATION_OPTION_FIELDS, {
      ...DEFAULT_OPERATION_OPTIONS,
    });
    expect(values["createDCE"]).toBe(false);
    expect(values["deploymentTimeoutSeconds"]).toBe("600");
    expect(values["customTableRetentionDays"]).toBe("30");
    expect(values["amplsResourceId"]).toBe("");
  });
});

describe("validateOptions", () => {
  const validValues = (): OptionFormValues =>
    optionsToFormValues(OPERATION_OPTION_FIELDS, {
      ...DEFAULT_OPERATION_OPTIONS,
    });

  it("accepts the defaults", () => {
    expect(validateOptions(OPERATION_OPTION_FIELDS, validValues())).toEqual(
      [],
    );
    expect(
      validateOptions(
        CRIBL_OPTION_FIELDS,
        optionsToFormValues(CRIBL_OPTION_FIELDS, {
          ...DEFAULT_CRIBL_OPTIONS,
        }),
      ),
    ).toEqual([]);
  });

  // LEGACY CONTRAST (the decision this test pins, porting-plan Unit 4): the
  // legacy save handler in IS/param-forms.ts coerced number fields with
  //   if (field.type === 'number' && typeof val === 'string') val = Number(val) || 0;
  // so a typo like '60O' or 'abc' SILENTLY persisted 0 - a 0-second
  // deployment timeout, zero kept template versions - with no error anywhere.
  // The new contract: non-numeric input REJECTS with an error naming the
  // field, and nothing is ever coerced to 0.
  it("REJECTS non-numeric number input with a named field error", () => {
    for (const junk of ["60O", "abc", "", "12.5", "1e3"]) {
      const values = { ...validValues(), deploymentTimeoutSeconds: junk };
      const errors = validateOptions(OPERATION_OPTION_FIELDS, values);
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe("deploymentTimeoutSeconds");
      expect(errors[0].message).toContain("whole number");
      // And the coercion path refuses to manufacture a 0 out of it.
      expect(() =>
        formValuesToOptions(OPERATION_OPTION_FIELDS, values),
      ).toThrow(/deploymentTimeoutSeconds/);
    }
  });

  it("enforces per-field minimums", () => {
    const timeout = validateOptions(OPERATION_OPTION_FIELDS, {
      ...validValues(),
      deploymentTimeoutSeconds: "0",
    });
    expect(timeout).toEqual([
      { key: "deploymentTimeoutSeconds", message: "Must be at least 1." },
    ]);
    const versions = validateOptions(OPERATION_OPTION_FIELDS, {
      ...validValues(),
      keepTemplateVersions: "-1",
    });
    expect(versions).toEqual([
      { key: "keepTemplateVersions", message: "Must be at least 0." },
    ]);
  });

  it("rejects a choice value outside the descriptor's choices", () => {
    const errors = validateOptions(OPERATION_OPTION_FIELDS, {
      ...validValues(),
      customTableRetentionDays: "45",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe("customTableRetentionDays");
    expect(errors[0].message).toContain("30, 90");
  });

  it("reports each offending field independently", () => {
    const errors = validateOptions(OPERATION_OPTION_FIELDS, {
      ...validValues(),
      deploymentTimeoutSeconds: "soon",
      keepTemplateVersions: "many",
    });
    expect(errors.map((e) => e.key).sort()).toEqual([
      "deploymentTimeoutSeconds",
      "keepTemplateVersions",
    ]);
  });

  // CROSS-FIELD RULE (porting-plan Unit 6, deferred from Unit 4). LEGACY
  // CONTRAST: Create-TableDCRs.ps1 lines 2752-2755 only WARNED ("Private
  // Link enabled but no AMPLS configured. DCE created with private-only
  // access but not associated with AMPLS.") and created a DCE nothing could
  // reach. The new contract blocks the save instead.
  describe("AMPLS cross-field rule", () => {
    const AMPLS_ID =
      "/subscriptions/sub-123/resourceGroups/rg-network/providers/" +
      "Microsoft.Insights/privateLinkScopes/ampls-prod";

    const privateDceValues = (amplsResourceId: string): OptionFormValues => ({
      ...validValues(),
      createDCE: true,
      dcePublicNetworkAccess: false,
      amplsResourceId,
    });

    it("REQUIRES amplsResourceId when createDCE=true and public access is disabled", () => {
      for (const blank of ["", "   "]) {
        const errors = validateOptions(
          OPERATION_OPTION_FIELDS,
          privateDceValues(blank),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].key).toBe("amplsResourceId");
        expect(errors[0].message).toContain("Required");
      }
    });

    it("format-checks the AMPLS id via the azure-resource-id parser", () => {
      for (const junk of ["garbage", "/subscriptions/sub-123", "ampls-prod"]) {
        const errors = validateOptions(
          OPERATION_OPTION_FIELDS,
          privateDceValues(junk),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0].key).toBe("amplsResourceId");
        expect(errors[0].message).toContain("Not a valid Azure resource ID");
      }
    });

    it("accepts a well-formed AMPLS id when the rule triggers", () => {
      expect(
        validateOptions(OPERATION_OPTION_FIELDS, privateDceValues(AMPLS_ID)),
      ).toEqual([]);
    });

    it("does NOT require an AMPLS id when public access stays enabled", () => {
      expect(
        validateOptions(OPERATION_OPTION_FIELDS, {
          ...validValues(),
          createDCE: true,
          dcePublicNetworkAccess: true,
          amplsResourceId: "",
        }),
      ).toEqual([]);
    });

    it("does NOT require an AMPLS id when createDCE is off (Direct mode)", () => {
      // dcePublicNetworkAccess=false without createDCE deploys no DCE at
      // all - nothing to associate, nothing to require.
      expect(
        validateOptions(OPERATION_OPTION_FIELDS, {
          ...validValues(),
          createDCE: false,
          dcePublicNetworkAccess: false,
          amplsResourceId: "",
        }),
      ).toEqual([]);
    });

    it("stays out of field sets without the participating fields", () => {
      expect(
        validateOptions(
          CRIBL_OPTION_FIELDS,
          optionsToFormValues(CRIBL_OPTION_FIELDS, {
            ...DEFAULT_CRIBL_OPTIONS,
          }),
        ),
      ).toEqual([]);
    });
  });
});

describe("formValuesToOptions", () => {
  it("throws on a numericChoice value outside its choices (no silent NaN/0)", () => {
    // Same loudness contract as the number-field path: a skipped validation
    // must never let '' become 0 or junk become NaN behind the user's back.
    for (const junk of ["", "45", "ninety"]) {
      expect(() =>
        formValuesToOptions(OPERATION_OPTION_FIELDS, {
          ...optionsToFormValues(OPERATION_OPTION_FIELDS, {
            ...DEFAULT_OPERATION_OPTIONS,
          }),
          customTableRetentionDays: junk,
        }),
      ).toThrow(/customTableRetentionDays/);
    }
  });

  it("coerces validated values to their typed shapes", () => {
    const values: OptionFormValues = {
      ...optionsToFormValues(OPERATION_OPTION_FIELDS, {
        ...DEFAULT_OPERATION_OPTIONS,
      }),
      createDCE: true,
      deploymentTimeoutSeconds: " 900 ",
      customTableRetentionDays: "90",
    };
    const options = formValuesToOptions(OPERATION_OPTION_FIELDS, values);
    expect(options["createDCE"]).toBe(true);
    expect(options["deploymentTimeoutSeconds"]).toBe(900);
    // numericChoice: the select's string comes back as the typed number.
    expect(options["customTableRetentionDays"]).toBe(90);
    expect(options["amplsResourceId"]).toBe("");
    // The full coerced record parses cleanly as OperationOptions.
    expect(parseOperationOptions(options)).toEqual({
      ...DEFAULT_OPERATION_OPTIONS,
      createDCE: true,
      deploymentTimeoutSeconds: 900,
      customTableRetentionDays: 90,
    });
  });
});

// ---------------------------------------------------------------------------
// Nested helpers
// ---------------------------------------------------------------------------

describe("getNestedValue / setNestedValue", () => {
  it("reads dot-notation paths and returns undefined off the path", () => {
    const obj = { operation: { createDCE: true } };
    expect(getNestedValue(obj, "operation.createDCE")).toBe(true);
    expect(getNestedValue(obj, "operation.missing")).toBeUndefined();
    expect(getNestedValue(obj, "missing.deeper")).toBeUndefined();
    expect(getNestedValue(null, "anything")).toBeUndefined();
    expect(getNestedValue("text", "anything")).toBeUndefined();
  });

  it("sets without mutating and preserves siblings at every level", () => {
    const original = {
      _comments: "keep me",
      operation: { createDCE: true, legacyKnob: "keep me too" },
    };
    const updated = setNestedValue(original, "operation.createDCE", false);
    expect(updated).toEqual({
      _comments: "keep me",
      operation: { createDCE: false, legacyKnob: "keep me too" },
    });
    // The input object is untouched (immutability contract).
    expect(original.operation.createDCE).toBe(true);
  });

  it("replaces non-object intermediates like the legacy helper did", () => {
    const updated = setNestedValue({ operation: 5 }, "operation.x", 1);
    expect(updated).toEqual({ operation: { x: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Merge-preserving save (the Unit 4 adapter contract)
// ---------------------------------------------------------------------------

describe("applyOptionsPatch", () => {
  it("PINS the merge-preserving save: unmanaged keys survive a round-trip", () => {
    // A stored blob carrying keys this app version does not manage: legacy
    // _comments, an operator note inside a managed section, and a whole
    // section written by some newer version.
    const stored = JSON.stringify({
      _comments: "hand-written note",
      operation: {
        createDCE: true,
        deploymentTimeoutSeconds: 600,
        futureKnob: { nested: "yes" },
      },
      futureSection: { added: "by a newer version" },
    });
    const merged = applyOptionsPatch(stored, {
      operation: { createDCE: false, keepTemplateVersions: 3 },
      cribl: { workerGroup: "prod" },
    });
    // Save round-trip: serialize, then look at what actually persisted.
    const persisted = JSON.parse(JSON.stringify(merged)) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({
      _comments: "hand-written note",
      operation: {
        createDCE: false,
        deploymentTimeoutSeconds: 600,
        keepTemplateVersions: 3,
        futureKnob: { nested: "yes" },
      },
      futureSection: { added: "by a newer version" },
      cribl: { workerGroup: "prod" },
    });
    // And the tolerant reader still yields well-formed options from it.
    const reread = parseAppOptions(JSON.stringify(persisted));
    expect(reread.operation.createDCE).toBe(false);
    expect(reread.operation.keepTemplateVersions).toBe(3);
    expect(reread.cribl.workerGroup).toBe("prod");
  });

  it("degrades junk stored blobs to an empty base without throwing", () => {
    for (const stored of [null, undefined, "", "{broken", 42, ["array"]]) {
      const merged = applyOptionsPatch(stored, {
        cribl: { destinationPrefix: "X-" },
      });
      expect(merged).toEqual({ cribl: { destinationPrefix: "X-" } });
    }
  });

  it("does not mutate an object passed as the stored blob", () => {
    const stored = { operation: { createDCE: true } };
    applyOptionsPatch(stored, { operation: { createDCE: false } });
    expect(stored.operation.createDCE).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Destination id composition
// ---------------------------------------------------------------------------

describe("destinationIdFromOptions", () => {
  it("reproduces defaultSentinelDestinationId under the default options", () => {
    // Pins the deliberately duplicated sanitize rule against the
    // characterized original so the two can never drift apart.
    for (const table of [
      "SecurityEvent",
      "Custom_CL",
      "My-App_CL",
      "Weird Name.2",
    ]) {
      expect(destinationIdFromOptions(table, DEFAULT_CRIBL_OPTIONS)).toBe(
        defaultSentinelDestinationId(table),
      );
    }
  });

  it("applies configured prefix and suffix", () => {
    expect(
      destinationIdFromOptions("CloudFlare_CL", {
        destinationPrefix: "Sec-",
        destinationSuffix: "-out",
        workerGroup: "",
      }),
    ).toBe("Sec-CloudFlare-out");
  });
});
