/**
 * Option forms - deployment and naming options as TYPED FORM DATA
 * (porting-plan Unit 4, ENG-43).
 *
 * Mined from the legacy `IS/param-forms.ts` ParamFormDefinition objects, scoped
 * to what the new app needs now:
 *
 *   - The legacy AZURE form is superseded by azure-profiles + azure-targeting
 *     and is NOT ported.
 *   - The legacy OPERATION form is ported as {@link OperationOptions} (the
 *     fields the new deploy path actually consumes; script-runner knobs like
 *     verboseOutput/skipKnownIssues died with the PowerShell engine).
 *   - The legacy CRIBL form is ported as {@link CriblOptions} (naming +
 *     worker-group defaults; the connection fields live with each shell's
 *     credential handling, never here).
 *
 * The field DESCRIPTIONS carry the legacy operational knowledge forward
 * (30/64-character DCR name limits, the Cribl Stream 4.14+ requirement for
 * Kind:Direct ingestion, AMPLS/private-link implications) - they are product
 * documentation, not decoration.
 *
 * VALIDATION DECISION (pinned by test): the legacy save handler coerced number
 * fields with `Number(val) || 0`, silently persisting 0 for any typo (a
 * deployment timeout of '60O' became 0 seconds). {@link validateOptions}
 * REJECTS non-numeric input with a named per-field error instead; nothing is
 * ever coerced to 0 behind the user's back.
 *
 * MERGE-PRESERVING SAVES (pinned by test): {@link applyOptionsPatch} writes
 * managed fields into the stored blob while preserving every UNMANAGED key
 * (legacy `_comments`, keys written by newer app versions, operator notes), so
 * a save can never destroy what it does not understand.
 *
 * CROSS-FIELD VALIDATION (porting-plan Unit 6, deferred from Unit 4, pinned
 * by test): when createDCE is true and dcePublicNetworkAccess is false, the
 * DCE is reachable ONLY through Azure Monitor Private Link, so amplsResourceId
 * is REQUIRED and must parse as an ARM resource id. The legacy engine merely
 * warned and created an unreachable private-only DCE anyway
 * (Create-TableDCRs.ps1 lines 2752-2755: "Private Link enabled but no AMPLS
 * configured. DCE created with private-only access but not associated with
 * AMPLS."); {@link validateOptions} blocks the save instead.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import { parseResourceId } from "../azure-resource-id";

// ---------------------------------------------------------------------------
// Typed option shapes and defaults
// ---------------------------------------------------------------------------

/** The two supported interactive-retention windows for new custom tables. */
export type CustomTableRetentionDays = 30 | 90;

/**
 * Deployment behavior options (legacy operation-parameters.json, scoped to
 * the fields the new deploy path consumes).
 */
export interface OperationOptions {
  /** DCE-based DCRs (64-char names) vs Direct DCRs (30-char, Cribl 4.14+). */
  createDCE: boolean;
  /** Skip DCR creation when a same-named DCR already exists. */
  skipExistingDCRs: boolean;
  /** Max seconds to wait for each ARM deployment (legacy default 600). */
  deploymentTimeoutSeconds: number;
  /** Generate ARM templates as artifacts without deploying. */
  templateOnly: boolean;
  /** Timestamped backup template versions kept per table. */
  keepTemplateVersions: number;
  /** Interactive retention for newly created custom (_CL) tables. */
  customTableRetentionDays: CustomTableRetentionDays;
  /** Allow public network access on created DCEs (false = AMPLS only). */
  dcePublicNetworkAccess: boolean;
  /** Azure Monitor Private Link Scope resource ID ('' = none). */
  amplsResourceId: string;
}

/**
 * Cribl naming/targeting defaults (legacy cribl-parameters.json, minus the
 * connection fields - credentials live with each shell, never here).
 */
export interface CriblOptions {
  /** Prefix for generated Cribl destination IDs. */
  destinationPrefix: string;
  /** Suffix for generated Cribl destination IDs. */
  destinationSuffix: string;
  /** Worker group onboarding preselects ('' = pick from the live list). */
  workerGroup: string;
}

/** Everything the options store persists, one section per form. */
export interface AppOptions {
  operation: OperationOptions;
  cribl: CriblOptions;
}

/** Legacy operation-parameters defaults, carried forward field by field. */
export const DEFAULT_OPERATION_OPTIONS: OperationOptions = {
  createDCE: false,
  skipExistingDCRs: true,
  deploymentTimeoutSeconds: 600,
  templateOnly: false,
  keepTemplateVersions: 1,
  customTableRetentionDays: 30,
  dcePublicNetworkAccess: true,
  amplsResourceId: "",
};

/**
 * Legacy cribl-parameters naming defaults. `workerGroup` deliberately
 * defaults to '' (the legacy default 'default' assumed a group name; the new
 * onboarding screen discovers live groups, so blank means "not pinned").
 */
export const DEFAULT_CRIBL_OPTIONS: CriblOptions = {
  destinationPrefix: "MS-Sentinel-",
  destinationSuffix: "-dest",
  workerGroup: "",
};

/** The canonical all-defaults options value. */
export const DEFAULT_APP_OPTIONS: AppOptions = {
  operation: DEFAULT_OPERATION_OPTIONS,
  cribl: DEFAULT_CRIBL_OPTIONS,
};

// ---------------------------------------------------------------------------
// Form-field descriptors (the data the generic UI renderer consumes)
// ---------------------------------------------------------------------------

/** How a field renders and validates. */
export type OptionFieldKind = "boolean" | "number" | "text" | "choice";

/** One selectable choice of a `choice` field. */
export interface OptionFieldChoice {
  /** The DOM/select value (always a string). */
  value: string;
  label: string;
}

/**
 * One field descriptor: everything a generic renderer needs to show the
 * field, explain it (InfoTip from `description`), and validate its input.
 */
export interface OptionFormField {
  /** Key within the form's options object (flat per form). */
  key: string;
  label: string;
  kind: OptionFieldKind;
  /**
   * Operator-facing explanation. Carries the legacy operational knowledge
   * (naming limits, version requirements, AMPLS implications) forward.
   */
  description: string;
  /** For kind 'choice': the allowed values. */
  choices?: readonly OptionFieldChoice[];
  /** For kind 'choice': emit the chosen value as a number, not a string. */
  numericChoice?: boolean;
  /** For kind 'number': inclusive minimum (numbers are always integers). */
  min?: number;
}

/** A form: identity, blurb, and its ordered field descriptors. */
export interface OptionFormDefinition {
  id: "operation" | "cribl";
  name: string;
  description: string;
  fields: readonly OptionFormField[];
}

/** Field descriptors for {@link OperationOptions}. */
export const OPERATION_OPTION_FIELDS: readonly OptionFormField[] = [
  {
    key: "createDCE",
    label: "Create DCE (Data Collection Endpoint)",
    kind: "boolean",
    description:
      "When enabled, deployments create DCE-based DCRs routed through a Data " +
      "Collection Endpoint (64-character DCR name limit). When disabled, " +
      "deployments create Direct DCRs (30-character name limit; Direct " +
      "ingestion requires Cribl Stream 4.14 or later).",
  },
  {
    key: "skipExistingDCRs",
    label: "Skip existing DCRs",
    kind: "boolean",
    description:
      "Skip DCR creation when a DCR with the same name already exists, " +
      "instead of redeploying over it.",
  },
  {
    key: "deploymentTimeoutSeconds",
    label: "Deployment timeout (seconds)",
    kind: "number",
    min: 1,
    description:
      "Maximum time in seconds to wait for each ARM deployment to reach a " +
      "terminal provisioning state before the job reports a timeout.",
  },
  {
    key: "templateOnly",
    label: "Template only (no deploy)",
    kind: "boolean",
    description:
      "Generate ARM templates without deploying them. Templates are saved " +
      "as downloadable artifacts for review or manual deployment.",
  },
  {
    key: "keepTemplateVersions",
    label: "Keep template versions",
    kind: "number",
    min: 0,
    description:
      "Number of timestamped backup template versions to keep per table " +
      "when generating templates.",
  },
  {
    key: "customTableRetentionDays",
    label: "Custom table retention (days)",
    kind: "choice",
    numericChoice: true,
    choices: [
      { value: "30", label: "30 days" },
      { value: "90", label: "90 days" },
    ],
    description:
      "Interactive retention period for newly created custom (_CL) tables. " +
      "30 days is the Log Analytics default; 90 days matches the default " +
      "total-retention window new custom tables are created with.",
  },
  {
    key: "dcePublicNetworkAccess",
    label: "DCE public network access",
    kind: "boolean",
    description:
      "Allow public network access on created Data Collection Endpoints. " +
      "Disable only when ingesting through Azure Monitor Private Link " +
      "(AMPLS): with public access disabled, events reach the DCE " +
      "exclusively over the private link, and the AMPLS resource ID below " +
      "is required.",
  },
  {
    key: "amplsResourceId",
    label: "AMPLS resource ID",
    kind: "text",
    description:
      "Full Azure resource ID of the Azure Monitor Private Link Scope, " +
      "e.g. /subscriptions/{sub}/resourceGroups/{rg}/providers/" +
      "Microsoft.Insights/privateLinkScopes/{name}. Required when DCE " +
      "public network access is disabled.",
  },
];

/** Field descriptors for {@link CriblOptions}. */
export const CRIBL_OPTION_FIELDS: readonly OptionFormField[] = [
  {
    key: "destinationPrefix",
    label: "Destination ID prefix",
    kind: "text",
    description:
      "Prefix for generated Cribl destination IDs. The default " +
      "'MS-Sentinel-' with the default suffix '-dest' turns table " +
      "SecurityEvent into 'MS-Sentinel-SecurityEvent-dest'.",
  },
  {
    key: "destinationSuffix",
    label: "Destination ID suffix",
    kind: "text",
    description: "Suffix for generated Cribl destination IDs.",
  },
  {
    key: "workerGroup",
    label: "Worker group",
    kind: "text",
    description:
      "Cribl worker group new Sentinel destinations are created in. When " +
      "set, onboarding preselects this group; leave blank to pick from the " +
      "live group list each time.",
  },
];

/** The operation-options form. */
export const OPERATION_OPTIONS_FORM: OptionFormDefinition = {
  id: "operation",
  name: "Deployment options",
  description:
    "Controls how DCR deployments run: Direct vs DCE mode, skip and timeout " +
    "behavior, template handling, custom-table retention, and Private Link.",
  fields: OPERATION_OPTION_FIELDS,
};

/** The cribl-options form. */
export const CRIBL_OPTIONS_FORM: OptionFormDefinition = {
  id: "cribl",
  name: "Cribl options",
  description:
    "Naming and targeting defaults for generated Cribl destinations.",
  fields: CRIBL_OPTION_FIELDS,
};

/** Both forms, in render order. */
export const OPTION_FORMS: readonly OptionFormDefinition[] = [
  OPERATION_OPTIONS_FORM,
  CRIBL_OPTIONS_FORM,
];

// ---------------------------------------------------------------------------
// Form values: descriptor-driven render/validate/coerce
// ---------------------------------------------------------------------------

/**
 * What a rendered form holds per field: booleans stay booleans (checkbox);
 * number, text, and choice fields hold the raw STRING the control carries.
 */
export type OptionFormValue = string | boolean;

/** The raw values of one rendered form, keyed by field key. */
export type OptionFormValues = Record<string, OptionFormValue>;

/** One per-field validation error, named by the field's key. */
export interface OptionFieldError {
  key: string;
  message: string;
}

/**
 * Project a typed options object onto raw form values for the given field
 * descriptors: booleans pass through, everything else becomes the string the
 * control edits. Accepts any object (typed options interfaces included);
 * unknown/missing values fall back to '' (never throws).
 */
export function optionsToFormValues(
  fields: readonly OptionFormField[],
  options: object,
): OptionFormValues {
  const record = options as Record<string, unknown>;
  const values: OptionFormValues = {};
  for (const field of fields) {
    const value = record[field.key];
    if (field.kind === "boolean") {
      values[field.key] = typeof value === "boolean" ? value : false;
    } else if (typeof value === "string") {
      values[field.key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      values[field.key] = String(value);
    } else {
      values[field.key] = "";
    }
  }
  return values;
}

/** Whole number (optional leading minus), the only accepted number syntax. */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * The AMPLS cross-field rule (porting-plan Unit 6, deferred from Unit 4).
 * Runs only when the field set carries all three participating fields (i.e.
 * the operation form); appends at most one error, keyed 'amplsResourceId'.
 *
 * The rule mirrors when the deploy path actually USES the AMPLS id: the
 * legacy engine associated the DCE with the AMPLS only when creating DCEs
 * with network access "Disabled" (Create-TableDCRs.ps1 line 2739), and
 * warned-but-proceeded when none was configured (lines 2752-2755) - leaving
 * a DCE nothing could reach. Here the combination createDCE=true +
 * dcePublicNetworkAccess=false REQUIRES a well-formed amplsResourceId.
 */
function validateAmplsCrossField(
  fields: readonly OptionFormField[],
  values: OptionFormValues,
  errors: OptionFieldError[],
): void {
  const participating = ["createDCE", "dcePublicNetworkAccess", "amplsResourceId"];
  if (!participating.every((key) => fields.some((f) => f.key === key))) {
    return;
  }
  // Booleans that fail their own per-field validation cannot trigger the
  // cross-field rule (=== true / === false, never truthiness).
  if (values["createDCE"] !== true || values["dcePublicNetworkAccess"] !== false) {
    return;
  }
  const raw = values["amplsResourceId"];
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id === "") {
    errors.push({
      key: "amplsResourceId",
      message:
        "Required when Create DCE is enabled and DCE public network access " +
        "is disabled: a private-only DCE is reachable exclusively through " +
        "the AMPLS.",
    });
    return;
  }
  const parsed = parseResourceId(id);
  if (
    parsed.subscriptionId === "" ||
    parsed.resourceGroup === "" ||
    parsed.name === ""
  ) {
    errors.push({
      key: "amplsResourceId",
      message:
        "Not a valid Azure resource ID - expected /subscriptions/{sub}/" +
        "resourceGroups/{rg}/providers/Microsoft.Insights/" +
        "privateLinkScopes/{name}.",
    });
  }
}

/**
 * Validate raw form values against their field descriptors, returning one
 * error per offending field (empty array = valid).
 *
 * THE DECISION THIS PINS (porting-plan Unit 4): the legacy save handler
 * silently coerced number fields with `Number(val) || 0` - a typo persisted
 * 0. Here, non-numeric input for a number field REJECTS with a named field
 * error; nothing is coerced. Number fields must be whole numbers and respect
 * the descriptor's `min`.
 *
 * CROSS-FIELD RULE (porting-plan Unit 6): on field sets containing createDCE,
 * dcePublicNetworkAccess, and amplsResourceId (the operation form), the
 * combination createDCE=true + dcePublicNetworkAccess=false additionally
 * requires a well-formed amplsResourceId - see
 * {@link validateAmplsCrossField}.
 */
export function validateOptions(
  fields: readonly OptionFormField[],
  values: OptionFormValues,
): OptionFieldError[] {
  const errors: OptionFieldError[] = [];
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === "boolean") {
      if (typeof value !== "boolean") {
        errors.push({ key: field.key, message: "Must be a boolean." });
      }
      continue;
    }
    if (typeof value !== "string") {
      errors.push({ key: field.key, message: "Must be text." });
      continue;
    }
    if (field.kind === "number") {
      const raw = value.trim();
      if (!INTEGER_PATTERN.test(raw)) {
        errors.push({
          key: field.key,
          message: `'${value}' is not a number - enter a whole number.`,
        });
        continue;
      }
      const parsed = Number(raw);
      if (field.min !== undefined && parsed < field.min) {
        errors.push({
          key: field.key,
          message: `Must be at least ${field.min}.`,
        });
      }
      continue;
    }
    if (field.kind === "choice") {
      const allowed = field.choices ?? [];
      if (!allowed.some((choice) => choice.value === value)) {
        const list = allowed.map((choice) => choice.value).join(", ");
        errors.push({
          key: field.key,
          message: `Must be one of: ${list}.`,
        });
      }
    }
    // kind 'text': any string is acceptable per-field; cross-field rules
    // below may still constrain specific text fields.
  }
  validateAmplsCrossField(fields, values, errors);
  return errors;
}

/**
 * Coerce validated raw form values back into a typed options record:
 * number fields become numbers, numericChoice fields become numbers, text
 * and string-choice fields stay strings, booleans pass through.
 *
 * PRECONDITION: {@link validateOptions} returned no errors for these values.
 * Fields that would not survive coercion (a non-numeric number field, a
 * numericChoice value outside its choices) throw, so a skipped validation is
 * a loud bug rather than a silent 0 or NaN - the exact failure mode the
 * legacy `Number(val) || 0` coercion had.
 */
export function formValuesToOptions(
  fields: readonly OptionFormField[],
  values: OptionFormValues,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.kind === "boolean") {
      options[field.key] = value === true;
      continue;
    }
    const raw = typeof value === "string" ? value : "";
    if (field.kind === "number") {
      const trimmed = raw.trim();
      if (!INTEGER_PATTERN.test(trimmed)) {
        throw new Error(
          `formValuesToOptions: field '${field.key}' holds non-numeric ` +
            `'${raw}' - validateOptions must run (and pass) before coercion`,
        );
      }
      options[field.key] = Number(trimmed);
      continue;
    }
    if (field.kind === "choice" && field.numericChoice === true) {
      const allowed = field.choices ?? [];
      if (!allowed.some((choice) => choice.value === raw)) {
        throw new Error(
          `formValuesToOptions: field '${field.key}' holds '${raw}', not one ` +
            `of its choices - validateOptions must run (and pass) before ` +
            `coercion`,
        );
      }
      options[field.key] = Number(raw);
      continue;
    }
    options[field.key] = raw;
  }
  return options;
}

// ---------------------------------------------------------------------------
// Tolerant parse / canonical serialize (azure-config discipline)
// ---------------------------------------------------------------------------

/** True when `value` is a plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Integer with an inclusive minimum, else the fallback (junk -> default). */
function asBoundedInteger(
  value: unknown,
  min: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min
    ? value
    : fallback;
}

function asRetentionDays(
  value: unknown,
  fallback: CustomTableRetentionDays,
): CustomTableRetentionDays {
  return value === 30 || value === 90 ? value : fallback;
}

/**
 * Parse an untrusted `operation` section into well-formed
 * {@link OperationOptions}. TOLERANT and TOTAL, per field: junk in any field
 * falls back to that field's default while its neighbors survive.
 */
export function parseOperationOptions(value: unknown): OperationOptions {
  if (!isPlainObject(value)) {
    return { ...DEFAULT_OPERATION_OPTIONS };
  }
  const defaults = DEFAULT_OPERATION_OPTIONS;
  return {
    createDCE: asBoolean(value["createDCE"], defaults.createDCE),
    skipExistingDCRs: asBoolean(
      value["skipExistingDCRs"],
      defaults.skipExistingDCRs,
    ),
    deploymentTimeoutSeconds: asBoundedInteger(
      value["deploymentTimeoutSeconds"],
      1,
      defaults.deploymentTimeoutSeconds,
    ),
    templateOnly: asBoolean(value["templateOnly"], defaults.templateOnly),
    keepTemplateVersions: asBoundedInteger(
      value["keepTemplateVersions"],
      0,
      defaults.keepTemplateVersions,
    ),
    customTableRetentionDays: asRetentionDays(
      value["customTableRetentionDays"],
      defaults.customTableRetentionDays,
    ),
    dcePublicNetworkAccess: asBoolean(
      value["dcePublicNetworkAccess"],
      defaults.dcePublicNetworkAccess,
    ),
    amplsResourceId: asString(
      value["amplsResourceId"],
      defaults.amplsResourceId,
    ),
  };
}

/**
 * Parse an untrusted `cribl` section into well-formed {@link CriblOptions}.
 * TOLERANT and TOTAL, per field. Note that '' is a VALID stored string (an
 * operator may deliberately blank the suffix); only non-strings fall back.
 */
export function parseCriblOptions(value: unknown): CriblOptions {
  if (!isPlainObject(value)) {
    return { ...DEFAULT_CRIBL_OPTIONS };
  }
  const defaults = DEFAULT_CRIBL_OPTIONS;
  return {
    destinationPrefix: asString(
      value["destinationPrefix"],
      defaults.destinationPrefix,
    ),
    destinationSuffix: asString(
      value["destinationSuffix"],
      defaults.destinationSuffix,
    ),
    workerGroup: asString(value["workerGroup"], defaults.workerGroup),
  };
}

/**
 * Parse an untrusted persisted blob into well-formed {@link AppOptions}.
 * TOLERANT and TOTAL - never throws. null/undefined, blank input, malformed
 * JSON, and non-objects all parse to the defaults; a valid object parses
 * per section and per field (junk -> that field's default). Unknown keys are
 * ignored here but are PRESERVED on save by {@link applyOptionsPatch}.
 */
export function parseAppOptions(raw: string | null | undefined): AppOptions {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      operation: { ...DEFAULT_OPERATION_OPTIONS },
      cribl: { ...DEFAULT_CRIBL_OPTIONS },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const blob = isPlainObject(parsed) ? parsed : {};
  return {
    operation: parseOperationOptions(blob["operation"]),
    cribl: parseCriblOptions(blob["cribl"]),
  };
}

/**
 * Serialize options to CANONICAL JSON: exactly the managed sections and
 * fields, nothing else. For saving OVER an existing stored blob use
 * {@link applyOptionsPatch} instead - this canonical form would drop the
 * blob's unmanaged keys.
 */
export function serializeAppOptions(options: AppOptions): string {
  const canonical: AppOptions = {
    operation: { ...options.operation },
    cribl: { ...options.cribl },
  };
  return JSON.stringify(canonical);
}

// ---------------------------------------------------------------------------
// Nested get/set helpers and the merge-preserving save
// ---------------------------------------------------------------------------

/**
 * Read a dot-notation path (e.g. "operation.createDCE") from an unknown
 * value. Returns undefined when any path segment is missing or non-object.
 * (Legacy getNestedValue, made total over unknown input.)
 */
export function getNestedValue(obj: unknown, key: string): unknown {
  let current: unknown = obj;
  for (const part of key.split(".")) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/**
 * Set a dot-notation path, returning a NEW object - the input is never
 * mutated (the legacy setNestedValue mutated in place; core stays
 * side-effect free). Only the objects along the path are cloned; sibling
 * keys at every level are preserved as-is. A non-object intermediate value
 * is replaced by a fresh object (legacy behavior).
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parts = key.split(".");
  const result = { ...obj };
  let target: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = target[part];
    const clone = isPlainObject(existing) ? { ...existing } : {};
    target[part] = clone;
    target = clone;
  }
  target[parts[parts.length - 1]] = value;
  return result;
}

/** A partial update to persist: only the provided fields are written. */
export interface AppOptionsPatch {
  operation?: Partial<OperationOptions>;
  cribl?: Partial<CriblOptions>;
}

/**
 * Apply an options patch onto the STORED blob, preserving every unmanaged
 * key - the merge-preserving save contract (pinned by test):
 *
 *   - `stored` may be the raw persisted string, an already-parsed object, or
 *     junk; anything unusable degrades to an empty base (never throws).
 *   - Top-level keys other than the patched sections survive untouched
 *     (legacy `_comments`, sections written by newer app versions).
 *   - Within a patched section, keys the patch does not name survive too.
 *
 * Returns a NEW plain object ready for JSON serialization; the input is
 * never mutated. The caller persists it (typically JSON.stringify) and
 * reads it back through the tolerant {@link parseAppOptions}.
 */
export function applyOptionsPatch(
  stored: unknown,
  patch: AppOptionsPatch,
): Record<string, unknown> {
  let base: unknown = stored;
  if (typeof stored === "string") {
    try {
      base = JSON.parse(stored);
    } catch {
      base = null;
    }
  }
  let result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  if (patch.operation !== undefined) {
    for (const [key, value] of Object.entries(patch.operation)) {
      result = setNestedValue(result, `operation.${key}`, value);
    }
  }
  if (patch.cribl !== undefined) {
    for (const [key, value] of Object.entries(patch.cribl)) {
      result = setNestedValue(result, `cribl.${key}`, value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Destination id from options
// ---------------------------------------------------------------------------

/**
 * Compose a Cribl destination id from the configured prefix/suffix and a
 * table name. The table sanitization is the PINNED legacy rule shared with
 * sentinel-destination's defaultSentinelDestinationId (strip one trailing
 * "_CL" case-insensitively, then map every non-alphanumeric character to
 * "_"); with {@link DEFAULT_CRIBL_OPTIONS} this reproduces that function
 * exactly - a test pins the two against each other so they cannot drift.
 */
export function destinationIdFromOptions(
  table: string,
  options: CriblOptions,
): string {
  const sanitized = table.replace(/_CL$/i, "").replace(/[^a-zA-Z0-9]/g, "_");
  return `${options.destinationPrefix}${sanitized}${options.destinationSuffix}`;
}
