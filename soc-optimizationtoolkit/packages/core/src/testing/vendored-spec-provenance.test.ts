/**
 * Provenance pins for the vendored Cribl OpenAPI spec (DBT-73).
 *
 * WHAT WENT WRONG. DBT-7 corrected a document by citing this asset: Cribl's own
 * spec titles the datagen knob "Events Per Second Per Worker Node", so the lab
 * note's "per worker PROCESS" reading was wrong, and had been for as long as it
 * was written down. The correction is now load-bearing prose - a whole paragraph
 * of docs/zscaler-lake-lab.md rests on that one string - and nothing held it.
 * On 2026-09-01 a reviewer flipped the title in the asset from "Worker Node" to
 * "Worker Process", which is precisely what a re-vendor can do silently, and
 * every gate stayed green: 5,069 tests across 297 files. `check-docs` holds only
 * that the FILE EXISTS, and a re-vendor cannot delete the file, so its coverage
 * of this risk was exactly zero.
 *
 * RE-VENDORING IS NORMAL, and that is the whole design constraint. The asset is
 * "pinned per Cribl version" (packages/core/CONTEXT.md), so it is expected to be
 * replaced wholesale, by someone whose task is "pick up the new spec" and who
 * has no reason to read a lab note from three weeks ago. These pins exist to put
 * that person in front of every sentence their update just falsified, at the
 * moment they can still do something about it.
 *
 * THE MESSAGE IS THE DELIVERABLE. A provenance pin that fails with "expected
 * 'Worker Process' to be 'Worker Node'" tells the next person nothing they can
 * act on - they will conclude the test is stale and change the expectation,
 * which converts a real finding into a silent one. Every pin here fails with the
 * claim it protects and the file that claim lives in, so the choice on the table
 * is the right one: correct the claim, or delete the claim AND the pin together.
 *
 * WHAT IS DELIBERATELY NOT HERE. This is NOT a copy of the spec. A pin per
 * schema would become a second spec that drifts from the first - the duplicated-
 * decision failure this codebase keeps filing cards about - and worse, a
 * re-vendor would then fail a hundred assertions nobody reads, which trains
 * people to update expectations in bulk without looking. Only facts that a
 * document or a derived constant ACTUALLY LEANS ON are pinned. Facts considered
 * and rejected, so the next person does not have to re-litigate them:
 *
 *   - "517 paths" (docs/sample-acquisition-phase0.md). TRUE today, but that doc
 *     is Status: Record - a dated account of a verification run. History is
 *     allowed to describe a world that no longer exists; failing the suite
 *     because a later Cribl release added a path would be this file arguing with
 *     a document that was correct when written.
 *   - CountedConfigGroup's shape (apps/cribl-app/src/platform/adapters.ts:505).
 *     Real, but the adapter reads `count`/`items` on every group listing, so a
 *     change breaks loudly at the first live call rather than silently in prose.
 *   - "the OpenAPI spec declares those paths bare" (query-lake-samples.ts:88,
 *     discover-sample-sources.ts:22). A claim that the spec is INCOMPLETE, and
 *     the addressing it fails to settle was settled live instead. A re-vendor
 *     that fixed the spec would make the sentence generous rather than wrong,
 *     and would change no behaviour - there is nothing here to protect.
 *   - "typed API client shapes are written against it" (packages/core/CONTEXT.md,
 *     ports/cribl-client.ts). No single checkable fact - these are statements of
 *     provenance for a WHOLE MODULE, and pinning them would mean pinning the
 *     module's entire surface against the spec, which is the second-spec failure
 *     above.
 *
 * An earlier draft of that bullet also listed usecases/install-pack, and it was
 * WRONG to. install-pack.ts:10-19 is not whole-module provenance: it cites two
 * exact strings, both trivially checkable, and it cites them to justify a code
 * path that three named live failures produced. They are pinned below. The
 * lesson generalises - "this module was written against the spec" and "the spec
 * says X, which is why this line is what it is" look alike in a header and are
 * not the same claim, and only the second one can be held.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BREAKER_CONFIGURABLE_INPUT_TYPES } from "../domain/live-architecture/live-architecture";

const SPEC_URL = new URL("../../assets/cribl-openapi.json", import.meta.url);
const SPEC_PATH = fileURLToPath(SPEC_URL);

/**
 * The spec as text AND as data, read once. Both views are needed: the schema
 * pins want the parse, and the Kusto pin below is a claim about the whole
 * document ("appears NOWHERE"), which only a text search can answer.
 *
 * Fails loudly when the asset is gone, in the shape entra-diagnostics.test.ts
 * established - a missing provenance source must never read as "nothing to
 * check here".
 */
function readSpec(): { text: string; doc: Record<string, unknown> } {
  let text: string;
  try {
    text = readFileSync(SPEC_URL, "utf8");
  } catch {
    throw new Error(
      `The vendored Cribl spec is missing: ${SPEC_PATH}\n` +
        "Nine claim sites in this repo cite it as their evidence - five source " +
        "files and four documents, and every assertion below names its own. " +
        "Either restore the asset, or delete these provenance pins AND the " +
        "claims together.",
    );
  }
  return { text, doc: JSON.parse(text) as Record<string, unknown> };
}

const SPEC = readSpec();

/** Every `components.schemas` entry, or a failure that says the spec's shape moved. */
function schemas(): Record<string, SchemaNode> {
  const components = SPEC.doc.components as { schemas?: Record<string, SchemaNode> } | undefined;
  const found = components?.schemas;
  if (found === undefined) {
    throw new Error(
      `${SPEC_PATH} has no components.schemas.\n` +
        "That is not drift in one field, it is a different document shape - a " +
        "re-vendor from a different generator, or a truncated download. Check " +
        "the asset before touching any expectation below.",
    );
  }
  return found;
}

/** One `paths` entry, or a failure that names the path that vanished. */
function path(route: string): Record<string, { summary?: string }> {
  const paths = SPEC.doc.paths as Record<string, Record<string, { summary?: string }>> | undefined;
  const found = paths?.[route];
  if (found === undefined) {
    throw new Error(
      `${SPEC_PATH} no longer declares the path ${route}.\n` +
        "A path disappearing is a bigger event than a field being reworded: the " +
        "endpoint this app CALLS is gone from the spec. Find what replaced it " +
        "before touching any expectation below.",
    );
  }
  return found;
}

/** Only the slices these pins navigate. Not a model of OpenAPI. */
type SchemaNode = {
  title?: string;
  description?: string;
  type?: string;
  enum?: string[];
  required?: string[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
};

/**
 * The explanation attached to every assertion below. Vitest prints it above the
 * diff, so the reader gets the WHY before the two strings that differ.
 */
function drifted(claim: string, livesIn: string): string {
  return (
    "\n\nA CLAIM IN THIS REPO CITES THE VENDORED SPEC, AND THE SPEC NO LONGER SAYS IT.\n" +
    `  The claim:  ${claim}\n` +
    `  Written in: ${livesIn}\n` +
    `  The asset:  ${SPEC_PATH}\n` +
    "\n" +
    "  If this is a re-vendor, the SPEC is right and the claim is now stale.\n" +
    "  Go and correct the claim first, then move this pin to the new wording.\n" +
    "  If the claim no longer matters, delete the claim AND this pin together:\n" +
    "  a pin that outlives the sentence it protected is unreadable to the next\n" +
    "  person, who has no way to tell what it was ever guarding.\n"
  );
}

/**
 * Walk to a nested schema by path, failing with the path travelled rather than
 * with `undefined`. "expected undefined to be 'Events Per Second Per Worker
 * Node'" is the message this file exists to avoid: it does not say whether the
 * title CHANGED or the whole schema moved, and those need different fixes.
 *
 * WHAT THIS THROW CANNOT TELL YOU, and why it no longer pretends to. An earlier
 * version said "The schema was RESTRUCTURED, not just reworded ... Find where it
 * moved". That is only one of the two ways to get here, and it was the WRONG one
 * for the case that actually bit: dropping a single leaf field sent the reader
 * hunting for a schema that had moved nowhere. A missing node means the path
 * stopped resolving; from inside here, "moved" and "dropped" are the same
 * observation. It also throws BEFORE `expect` runs, so it replaces the calling
 * pin's citation with this generic text - which is why a pin whose claim names a
 * source file asserts existence through `drifted()` first and only then walks
 * here for the detail.
 */
function at(root: Record<string, SchemaNode>, path: readonly string[]): SchemaNode {
  let node: SchemaNode | undefined = root[path[0]];
  for (let i = 1; i < path.length && node !== undefined; i += 1) {
    const step = path[i];
    node = step === "items" ? node.items : node.properties?.[step];
  }
  if (node === undefined) {
    throw new Error(
      `${SPEC_PATH} no longer has components.schemas.${path.join(".")}\n` +
        "The path stopped resolving, so the claims resting on it cannot be " +
        "checked at all. Either the schema MOVED or the field was DROPPED - " +
        "this walk cannot tell which, and they need different fixes. Settle " +
        "that against the asset before editing any expectation below.",
    );
  }
  return node;
}

// ---------------------------------------------------------------------------

describe("InputDatagen samples[].eventsPerSec - the DBT-7 correction", () => {
  const eventsPerSec = () =>
    at(schemas(), ["InputDatagen", "samples", "items", "eventsPerSec"]);

  it("is titled 'Events Per Second Per Worker Node' - Cribl's own wording", () => {
    // The one string DBT-7 turned into prose. docs/zscaler-lake-lab.md quotes it
    // to establish the UNIT of the datagen knob, and then argues from that unit
    // that the observed factor of 2 is plausibly a two-Worker-NODE lab rather
    // than a worker-process count. Change "Node" to "Process" and the section's
    // correction reverts to the error it was written to fix.
    expect(
      eventsPerSec().title,
      drifted(
        "eventsPerSec is per Worker NODE, because the spec titles it " +
          "'Events Per Second Per Worker Node'",
        "docs/zscaler-lake-lab.md, section 'eventsPerSec is per Worker NODE' " +
          "(the 'Unit corrected 2026-09-01 (DBT-7)' paragraph)",
      ),
    ).toBe("Events Per Second Per Worker Node");
  });

  it("keeps the description the doc quotes verbatim", () => {
    // Pinned in full because the doc reproduces it in full, inside quote marks.
    // A verbatim quotation is a stronger claim than a paraphrase and needs the
    // stronger check: a reader who greps the doc's sentence must find it here.
    expect(
      eventsPerSec().description,
      drifted(
        'the spec describes eventsPerSec as "Maximum number of events to ' +
          'generate per second per Worker Node. Defaults to 10."',
        "docs/zscaler-lake-lab.md - the sentence is quoted there in full",
      ),
    ).toBe(
      "Maximum number of events to generate per second per Worker Node. Defaults to 10.",
    );
  });
});

describe("Input* breaker configurability - live-architecture's '19 of 68'", () => {
  /**
   * Re-derives the constant instead of restating it, which is the only form of
   * this pin worth having. BREAKER_CONFIGURABLE_INPUT_TYPES carries the
   * instruction "Re-derive when the spec is re-vendored rather than editing by
   * hand" - an instruction with nothing behind it until now, and one nobody
   * re-vendoring a spec would think to look for.
   *
   * The stake is not cosmetic. The list decides whether a source's breaking is
   * drawn as "built-in" (fixed, nothing to show) or "default" (configurable,
   * Cribl chose). A new Cribl input type with breaker config would be drawn as
   * built-in - stating, in a diagram an operator reads, that a knob they have
   * does not exist.
   */
  const derive = () => {
    const all = Object.entries(schemas()).filter(([name]) => name.startsWith("Input"));
    // "Input types" means the 68 with a `type` enum, not all 74 Input* schemas:
    // Input, InputResponse, InputStatus, InputElementConfig, InputElementType and
    // the collection-constraint schema are envelopes and shared shapes, not
    // source types an operator can pick.
    const types = all.filter(([, s]) => Array.isArray(s.properties?.type?.enum));
    const breakers = types.filter(([, s]) => s.properties?.breakerRulesets !== undefined);
    return {
      typeCount: types.length,
      breakerTypes: breakers
        .map(([, s]) => s.properties?.type?.enum?.[0] ?? "")
        .sort((a, b) => a.localeCompare(b)),
    };
  };

  it("still counts 68 input types in the spec", () => {
    expect(
      derive().typeCount,
      drifted(
        "the spec defines 68 Cribl input types (the denominator in '19 of 68')",
        "packages/core/src/domain/live-architecture/live-architecture.ts, the " +
          "BREAKER_CONFIGURABLE_INPUT_TYPES header",
      ),
    ).toBe(68);
  });

  it("still counts 19 of them exposing breakerRulesets", () => {
    expect(
      derive().breakerTypes.length,
      drifted(
        "19 of those 68 input types expose breakerRulesets",
        "packages/core/src/domain/live-architecture/live-architecture.ts, the " +
          "BREAKER_CONFIGURABLE_INPUT_TYPES header",
      ),
    ).toBe(19);
  });

  it("names exactly the types the constant hand-carries", () => {
    // The count agreeing is not enough: one type dropped and another added keeps
    // 19 and puts a wrong name in the diagram. This is the assertion that
    // actually holds the list.
    expect(
      derive().breakerTypes,
      drifted(
        "BREAKER_CONFIGURABLE_INPUT_TYPES is DERIVED from the spec's Input* " +
          "schemas, not hand-written, and is to be re-derived on re-vendor",
        "packages/core/src/domain/live-architecture/live-architecture.ts - " +
          "re-derive the constant there rather than editing this expectation",
      ),
    ).toEqual([...BREAKER_CONFIGURABLE_INPUT_TYPES].sort((a, b) => a.localeCompare(b)));
  });
});

describe("InputRest's ABSENCE - the fact DBT-1's dependents are waiting on", () => {
  /**
   * An absence claim, which is why it needs holding more than a presence one
   * does: nothing about adding a schema looks like a breaking change, and the
   * reader who adds it has no reason to suspect other cards were sequenced
   * around its not being there.
   *
   * "`InputRest` has no schema under that name in the vendored OpenAPI spec"
   * lives in docs/backlog.md item 10, and item 6 sends a future implementer to
   * "pin the conf against cribl-openapi.json instead of hand-writing it" on the
   * strength of it. docs/board.json records the same fact on DBT-1, ANSWERED.
   * The header's "Status: Record" argument - the one that lets the "517 paths"
   * claim go unpinned - cannot cover this: backlog.md opens "Status: Living",
   * so it is not describing a world that has passed, it is describing this one.
   *
   * WHICH CARDS, AND WHY THIS DOES NOT NAME THEM. An earlier version of this
   * block and of the failure message below said "blocking AZR-7 and WIN-5",
   * copied from DBT-1's own detail. There is no card with id WIN-5 - the WIN
   * epic runs WIN-1..WIN-3 plus WIN-F1..WIN-F3, and "WIN-5" survives on the
   * board only as prose inside DBT-1's detail and D-5's title. So the message
   * sent the reader to a phantom id and, worse, PAST the real dependent: the
   * cards that actually declare `dependsOn: ["DBT-1"]` are AZR-7 and DBT-4, and
   * DBT-4 outranks the one id that was right. A hand-copied id list is stale the
   * moment the graph moves and nothing checks it, so this pin points at the
   * dependency edge instead and lets the board answer.
   *
   * The direction of the failure is the point. If Cribl ADDS InputRest, the
   * REST collector is modelled directly after all, and the answer recorded on
   * DBT-1 - collector conf carried as an InputCollection - stops being the only
   * option for the cards that declare `dependsOn` DBT-1. Nobody would look; the
   * schema would simply be there, and they would be built the long way round for
   * no reason.
   *
   * SCOPE: this pin holds the ABSENCE only. DBT-1's own remaining work is the
   * positive pin (that InputCollection and RestCollectorConf are still the right
   * names), and duplicating it here would be the second-copy failure - the two
   * would drift and nobody would know which was authoritative.
   */
  it("still has no schema named InputRest, and none that is one renamed", () => {
    const inputRest = "InputRest" in schemas();
    expect(
      inputRest,
      drifted(
        "`InputRest` has no schema under that name in the vendored spec, which " +
          "is why the REST collector is modelled as an InputCollection carrying " +
          "a collector conf",
        "docs/backlog.md item 10 (Status: Living, so this is a claim about the " +
          "spec as it is now) and item 6's instruction to pin the collector conf " +
          "against the asset; docs/board.json DBT-1, ANSWERED. If Cribl now " +
          "ships InputRest, that answer is REOPENED - say so on DBT-1, and on " +
          "every card that declares `dependsOn` DBT-1, before any of them is " +
          "built the long way round",
      ),
    ).toBe(false);
  });

  it("has no Input* schema named for REST, and no input type declaring itself REST", () => {
    // Stops the pin above passing for the wrong reason. "InputRest is absent"
    // is only interesting if the REST collector is genuinely not modelled as an
    // Input type; a rename to InputRESTCollector would satisfy the check above
    // while falsifying everything DBT-1 concluded from it.
    //
    // WHY THIS IS A TOKEN MATCH AND NOT /rest/i. A bare substring search over
    // the name matches any schema with those four letters anywhere in it -
    // InputRestore, InputForestry - and would then tell the reader the FALSE
    // thing, that InputRest had been renamed, about a schema with nothing to do
    // with REST. So the match is anchored to a REST token at the front of the
    // name after "Input", case-sensitively: "Rest"/"REST" followed by the end or
    // by something that is not a lowercase letter. The `i` flag cannot be used
    // for this - under `i`, the `[a-z]` in the lookahead matches uppercase too,
    // which silently lets InputRestCollector through.
    //
    // The `type` enum is checked alongside the name because the two can drift
    // apart: a schema could be named anything and still declare itself the REST
    // source type, and that discriminator is what an operator actually picks.
    const restToken = (candidate: string) => /^(?:rest|Rest|REST)(?![a-z])/.test(candidate);
    const inputs = Object.entries(schemas()).filter(([name]) => name.startsWith("Input"));
    const byName = inputs
      .map(([name]) => name)
      .filter((name) => restToken(name.slice("Input".length)));
    const byType = inputs
      .flatMap(([, schema]) => schema.properties?.type?.enum ?? [])
      .filter(restToken);

    expect(
      [...byName, ...byType],
      drifted(
        "no Input* schema is named for REST and no input type declares `type` " +
          "REST - the absence is a modelling decision, not a rename",
        "docs/backlog.md item 10 and docs/board.json DBT-1. Anything listed " +
          "here is either InputRest under a new name or a REST input type that " +
          "did not exist before, and DBT-1's conclusion needs rewriting either " +
          "way. This is a tripwire, not a proof of absence: it reads the name " +
          "and the `type` enum only, so confirm against the asset before " +
          "concluding what was added",
      ),
    ).toEqual([]);
  });
});

describe("the null-ish Kusto predicate the Lake filter was built from", () => {
  /**
   * `where tostring(field)=="value"` cannot express "there is no value": every
   * literal IS a value. buildLogTypeEventQuery therefore emits
   * `isnotempty(field)==false`, and both the code and the plan justify that
   * choice by what the spec ATTESTS - one null-ish predicate, and no isempty,
   * isnull or not(). That justification is the thing being pinned: the query
   * string is already pinned in query-lake-samples.test.ts, but nothing there
   * can tell whether the spec still supports the reasoning behind it.
   *
   * A re-vendor that ADDS `isempty` does not break the app - it means a clearer
   * filter became available and two documents now overstate their evidence.
   * That is worth a failing test precisely because it is the kind of thing
   * nobody would otherwise ever look for.
   */
  const occurrences = (needle: string) => SPEC.text.split(needle).length - 1;

  it("still attests isnotempty(), as a dataset ruleset's kustoExpression", () => {
    // The positive half, and it is here to stop the three absence checks below
    // passing VACUOUSLY. A truncated or replaced asset would satisfy "isempty
    // appears nowhere" perfectly while attesting nothing at all.
    expect(
      SPEC.text.includes('"kustoExpression": "isnotempty(vendor)"'),
      drifted(
        "the spec attests exactly one null-ish Kusto predicate for Cribl " +
          "Search - isnotempty(vendor), as a dataset ruleset's kustoExpression",
        "docs/sample-acquisition-plan.md ('The fetch filter is grounded in the " +
          "spec, not guessed') and the header above " +
          "buildLogTypeEventQuery in " +
          "packages/core/src/usecases/query-lake-samples/query-lake-samples.ts",
      ),
    ).toBe(true);
  });

  for (const absent of ["isempty(", "isnull(", "not("]) {
    it(`still mentions ${absent}) nowhere`, () => {
      expect(
        occurrences(absent),
        drifted(
          `the spec mentions ${absent}) NOWHERE, which is why the Lake ` +
            "filter is composed from isnotempty()==false instead of using it",
          "docs/sample-acquisition-plan.md ('isempty, isnull and not() appear " +
            "NOWHERE in the spec') and the fetch-filter comment in " +
            "packages/core/src/usecases/query-lake-samples/query-lake-samples.ts. " +
            "If Cribl now attests it, the honest fix is to USE it and rewrite " +
            "both notes - not to raise this number",
        ),
      ).toBe(0);
    });
  }
});

describe("OutputSentinel - the schema sentinel-destination calls AUTHORITATIVE", () => {
  /**
   * sentinel-destination.ts opens by naming this schema "AUTHORITATIVE for field
   * names and enums" and then lists the five required fields and three enums it
   * read off it. Everything downstream - every Sentinel destination this app
   * writes into a customer's Cribl - is built to that list.
   *
   * The builder's own tests pin what it EMITS, which means they would keep
   * passing while the emitted config drifted away from what Cribl accepts. Only
   * the spec can settle that.
   *
   * WHAT IS HELD, and the boundary an earlier draft of this comment got wrong.
   * OutputSentinel declares 66 properties; buildSentinelDestination writes 29 of
   * them, and all 29 exist in the schema today (counted, not estimated). The
   * header this block cites names ten of those 29 as read off the spec, and all
   * ten are now held: type, endpointURLConfiguration and authType by their enum
   * pins, client_id by its description pin, loginUrl and secret by the required
   * set, and dcrID, dceEndpoint, streamName and scope by the existence pins
   * below.
   *
   * The 18 the builder writes but does not pin are the legacy template's tuning
   * defaults - keepAlive, concurrency, the payload caps, the retry and
   * backpressure settings, id/systemFields/streamtags. The header sources those
   * to Generate-CriblDestinations.ps1, not to this schema, and a rename there
   * degrades a DEFAULT rather than stopping delivery: the destination still
   * addresses the right DCR. The remaining 37 properties the builder never
   * writes are not pinned at all - a list of 37 would be the
   * second-copy-of-the-spec failure this file's header rejects.
   *
   * The earlier draft said "the remaining ~60 properties are not pinned, because
   * the builder does not lean on them". That was false of four of them by name,
   * and it is recorded here rather than deleted because a wrong boundary written
   * down as settled reasoning is the exact failure this file exists to prevent.
   */
  const sentinel = () => at(schemas(), ["OutputSentinel"]);

  it("still requires exactly the five fields the header lists", () => {
    expect(
      sentinel().required,
      drifted(
        "OutputSentinel requires type, endpointURLConfiguration, loginUrl, " +
          "secret and client_id",
        "packages/core/src/domain/sentinel-destination/sentinel-destination.ts, " +
          "the 'AUTHORITATIVE for field names and enums' header",
      ),
    ).toEqual(["type", "endpointURLConfiguration", "loginUrl", "secret", "client_id"]);
  });

  it("still closes the three enums the builder writes constants into", () => {
    const props = sentinel().properties;
    const claim = (field: string) =>
      drifted(
        `OutputSentinel.${field} is a closed enum the builder writes a ` +
          "constant into",
        "packages/core/src/domain/sentinel-destination/sentinel-destination.ts " +
          "- buildSentinelDestination emits that constant unconditionally",
      );

    expect(props?.type?.enum, claim("type")).toEqual(["sentinel"]);
    // "ID" is the value the legacy generator chose and this app kept; "url" is
    // the alternative. Losing either changes what a valid destination looks like.
    expect(props?.endpointURLConfiguration?.enum, claim("endpointURLConfiguration")).toEqual([
      "url",
      "ID",
    ]);
    // Single-valued today, which is exactly why the builder hard-codes it.
    expect(props?.authType?.enum, claim("authType")).toEqual(["oauth"]);
  });

  /**
   * The FIELD NAMES half of "AUTHORITATIVE for field names and enums". The
   * enums above hold the second half; without these the first half was held by
   * nothing, and that gap was real: renaming dcrID to dcrId in the asset, or
   * deleting dceEndpoint or scope outright, left every assertion in this block
   * green.
   *
   * These four are written UNCONDITIONALLY into every Sentinel destination this
   * app creates (sentinel-destination.ts:230-235). They are also the ones whose
   * loss is SILENT: Cribl accepts a POST carrying a field it no longer declares,
   * the destination appears healthy in the UI, and the events go nowhere -
   * misaddressed, or authenticated against the wrong audience. Every gate in
   * this repo stays green while that happens, which is the whole reason the
   * spec, rather than the builder's own output, has to be the thing checked.
   *
   * Existence, not shape. What a re-vendor does to a field name is rename it or
   * drop it; pinning `type: "string"` alongside would fail on a widening that
   * costs nothing and trains people to edit expectations in bulk.
   */
  const OPERATIVE_FIELDS: readonly (readonly [string, string])[] = [
    ["dcrID", "the immutable id of the DCR the events are addressed to"],
    ["dceEndpoint", "the ingestion host, after the DCR-28 control-plane repair"],
    ["streamName", "the stream within the DCR that selects the destination table"],
    ["scope", "the OAuth scope the token is minted for (monitor.azure.com/.default)"],
  ];

  for (const [field, role] of OPERATIVE_FIELDS) {
    it(`still declares ${field}, which the builder writes unconditionally`, () => {
      expect(
        sentinel().properties?.[field] !== undefined,
        drifted(
          `OutputSentinel declares ${field} - ${role}`,
          "packages/core/src/domain/sentinel-destination/sentinel-destination.ts, " +
            "the 'AUTHORITATIVE for field names and enums' header, emitted at " +
            ":230-235. If Cribl renamed the field, rename it in the builder; the " +
            "destination is otherwise written with a key Cribl ignores and no " +
            "test in this repo can see it",
        ),
      ).toBe(true);
    });
  }

  it("still declares url, the composed endpoint carried for legacy fidelity", () => {
    // Held apart from the four above because its justification is different and
    // weaker. Under endpointURLConfiguration "ID" the routing comes from
    // dcrID/dceEndpoint/streamName, and sentinel-destination.ts:176-180 calls
    // the composed url "harmless under 'ID' configuration, kept for fidelity".
    // So a re-vendor dropping `url` breaks no delivery - it turns that sentence
    // into "we write a field the schema does not declare", which is a claim to
    // correct rather than a defect to chase. Pinned so the reader is told which
    // of the two it is.
    expect(
      sentinel().properties?.url !== undefined,
      drifted(
        "OutputSentinel declares url, the fully composed ingestion URL the " +
          "legacy template also carries",
        "packages/core/src/domain/sentinel-destination/sentinel-destination.ts:" +
          "176-180 ('harmless under \"ID\" configuration, kept for fidelity'), " +
          "emitted at :239-241. If the spec dropped it, drop it from the builder " +
          "and delete that sentence - fidelity to a template Cribl no longer " +
          "accepts is not fidelity",
      ),
    ).toBe(true);
  });

  it("still documents client_id as a JavaScript EXPRESSION", () => {
    // The single strangest thing this builder does, and the only reason it does
    // it. Because Cribl evaluates client_id as an expression, the legacy
    // generator wraps the id in single quotes to make it a string CONSTANT, and
    // this app copied that verbatim. If a re-vendor made client_id a plain
    // string, those quotes stop being a fix and become two literal characters
    // inside the client id of every Sentinel destination this app writes -
    // failing OAuth in a customer's Cribl, with every test in this repo green.
    expect(
      sentinel().properties?.client_id?.description,
      drifted(
        "the OpenAPI documents client_id as a JavaScript expression, which is " +
          "why the emitted id is wrapped in single quotes",
        "packages/core/src/domain/sentinel-destination/sentinel-destination.ts, " +
          "the 'single-quoted client_id' note in the header",
      ),
    ).toBe(
      "JavaScript expression to compute the Client ID for the Azure application. Can be a constant.",
    );
  });
});

describe("SearchJobStatusResponseExamplesRunning - why the bare status read survives", () => {
  /**
   * A citation BY NAME into someone else's document, which is the most fragile
   * kind there is: rename the example and the sentence pointing at it becomes
   * unfollowable without becoming false-looking.
   *
   * The stake is a live code path. Cribl's real
   * `GET /search/jobs/{id}/status?advanced=true` answers in the `{items, count}`
   * envelope - confirmed live 2026-08-24, and reading only the top level is the
   * defect that made every Lake query report a completed job as pending. The
   * bare top-level read was KEPT as a fallback anyway, purely because the spec's
   * own example is the flattened shape. That is the whole justification for a
   * branch that would otherwise look like dead code, so if the example ever
   * stops being flat, the next reader deserves to be told the branch has lost
   * its reason to exist rather than left to guess.
   */
  it("is still the FLAT shape, with status at the top level and no items envelope", () => {
    const examples = (SPEC.doc.components as { examples?: Record<string, { value?: unknown }> })
      .examples;
    const value = examples?.SearchJobStatusResponseExamplesRunning?.value as
      | Record<string, unknown>
      | undefined;
    const claim = drifted(
      "the spec's own SearchJobStatusResponseExamplesRunning is the FLATTENED " +
        "{status, timeCreated, ...}, not the {items, count} envelope live Cribl " +
        "sends - which is why the bare top-level status read is kept as a fallback",
      "packages/core/src/usecases/query-lake-samples/query-lake-samples.test.ts, " +
        "the header above the status-shape pins",
    );

    expect(value?.status, claim).toBe("running");
    // The half that actually matters: flat means NO envelope. Asserting the
    // status alone would still pass if Cribl wrapped it and left a stray
    // top-level status behind.
    expect(value !== undefined && "items" in value, claim).toBe(false);
  });
});

describe("the two spec facts the pack-install ladder is built on", () => {
  /**
   * install-pack.ts:10-19 cites the spec twice, and both citations exist to
   * explain a rung of the conflict ladder that would otherwise read as
   * superstition. Each was written after a LIVE failure, and each names a thing
   * the spec still has to say for the rung to be right:
   *
   *   - PATCH /packs/{id} is Cribl's documented reinstall ("Upgrade a Pack"),
   *     which is why the ladder does not use POST {source, force: true}. That
   *     POST did not overwrite in production - it RENAMED the pack to a suffixed
   *     id and left a stray nothing in the app matched.
   *   - PackRequestBody carries `id`, which is why every install POST pins one.
   *     A POST without it let the server DERIVE the id from the randomised
   *     upload filename (the "fi...entinel_1" stray).
   *
   * A re-vendor that retitles the PATCH, or drops `id` from the request body,
   * does not break either rung today - it means the reason WRITTEN DOWN for the
   * rung no longer matches the document it cites, and the next person to touch
   * the ladder is reasoning from a citation they cannot follow. That is the
   * whole failure mode this file was filed for, and it is why these were moved
   * out of the header's "no single checkable fact" bullet.
   */
  it("still titles PATCH /packs/{id} 'Upgrade a Pack'", () => {
    expect(
      path("/packs/{id}").patch?.summary,
      drifted(
        "PATCH /packs/{id} is Cribl's documented 'Upgrade a Pack' - in place, " +
          "id preserved, route references intact - which is why the reinstall " +
          "rung PATCHes rather than POSTing with force: true",
        "packages/core/src/usecases/install-pack/install-pack.ts:10-15, the " +
          "second of the three 2026-07-13 live failures. If the spec renamed " +
          "this operation, correct the citation; if it removed the PATCH, the " +
          "merge rung has lost its documented basis and force-POST's renaming " +
          "behaviour is back on the table",
      ),
    ).toBe("Upgrade a Pack");
  });

  it("still declares PackRequestBody.id, the field that stops a server-guessed name", () => {
    // EXISTENCE FIRST, then the type - the order is the whole point, and getting
    // it backwards cost this pin its message. The drift this pin was written for
    // is `id` being DROPPED from the request body, and reading
    // at(..., ["PackRequestBody", "id"]).type throws inside at() before `expect`
    // ever runs, so that drift used to fail with at()'s generic text and no
    // mention of install-pack.ts at all. The full citation below printed only in
    // the weaker case where `id` survived with a different type. Same shape as
    // OPERATIVE_FIELDS above, and for the same reason.
    const claim = drifted(
      "PackRequestBody carries `id`, which is why every install POST pins the " +
        "pack id explicitly instead of letting the server derive it from the " +
        "randomised upload filename",
      "packages/core/src/usecases/install-pack/install-pack.ts:16-19, the " +
        "third of the three 2026-07-13 live failures (the 'fi...entinel_1' " +
        "stray). If the field is gone, the install POST is once again at the " +
        "mercy of the filename and the ladder needs rethinking, not renaming",
    );

    expect(at(schemas(), ["PackRequestBody"]).properties?.id !== undefined, claim).toBe(true);
    expect(at(schemas(), ["PackRequestBody", "id"]).type, claim).toBe("string");
  });
});
