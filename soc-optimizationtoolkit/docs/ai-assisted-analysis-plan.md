# AI-Assisted Analysis Plan (Fable 5)

Status: P0/P1/P2 SHIPPED (2026-07-08); P3 (cost tracking + caching) remains.
Owner: analysis flow. Model of record: Fable 5 (`claude-fable-5`), overridable
per call. Decisions taken as recommended: fixed default model (no picker),
redaction = names + types + one truncated example, caching deferred to P3.

## Goal (user request, verbatim intent)

Use the Fable 5 model to improve the three sample-driven analyses so the app can
propose the BEST result from the samples the user provides:

1. the best DCR field mapping (and, when ambiguous, the best destination table),
2. the best analytics-rule coverage read, and
3. the best workbook coverage read.

AI is ADVISORY. The deterministic analyzers already in `@soc/core` stay the
source of truth and the deploy gate; the model adds a ranked suggestion and
rationale layer on top. Nothing the model returns can, by itself, change a
mapping or unblock a deploy - a human accepts each suggestion.

## Where it plugs in (what already exists)

The three analyses are pure domain code today, fed by the sample flow:

- DCR mapping / gap: `packages/core/src/domain/gap-analysis` (the
  `GapAnalysisField` actions passthrough/rename/coerce/overflow/drop/enrich) and
  `usecases/coverage-analysis` for destination-table resolution.
- Rule + workbook coverage: `packages/core/src/domain/coverage-analysis`
  (`analyzeContentCoverage` over the generic `ContentItem`; rules from the repo
  via `SentinelContent`, workbooks from the repo via `acquireSolutionWorkbooks`
  and from ARM via `acquireWorkbooks`).
- Samples: `usecases/acquire-samples` + `usecases/analyze-samples` +
  `domain/sample-acquisition` (the field set, inferred types, and examples the
  mapping is built from).

Each of these produces a deterministic result object. The AI layer consumes that
same object plus the sampled fields and returns a suggestion object of the same
vocabulary - it never invents a parallel result shape.

## The seam: an `LlmAssist` port (purity preserved)

`packages/core` must stay pure (no fetch, no `Date`, no crypto, no
`Math.random`). The model call is IO, so it lives behind a new port, injected by
each shell exactly like `AzureManagement` and `SentinelContent`:

```
// packages/core/src/ports/llm-assist.ts
export interface LlmCompletionRequest {
  system: string;
  user: string;
  maxTokens: number;          // keep <= 4096 per call (30s proxy budget)
  model?: string;             // defaults to claude-fable-5 in the adapter
  responseSchemaName?: string; // for telemetry/cost attribution
}
export interface LlmCompletionResult {
  text: string;               // raw model text; parsed by PURE core validators
  inputTokens: number;
  outputTokens: number;
}
export interface LlmAssist {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}
```

- Cloud shell adapter: POST to `api.anthropic.com` through `proxies.yml` with the
  Anthropic key injected server-side from the encrypted KV entry
  (`anthropicKey`), exactly like `githubPat`/`azureArmToken`. Only
  Content-Type/Accept are forwarded so Origin never reaches Anthropic.
- Local shell adapter: the Node host calls the Anthropic SDK with the key from
  its secrets store.
- `LlmAssist` is OPTIONAL on `UiPorts`. Absent -> the AI controls do not render
  and every analysis behaves exactly as it does today. This is how we ship the
  deterministic app first and light up AI where the key is configured.

### Purity rule for prompts and parsing

Prompt construction and response validation are PURE and live in core, so they
are unit-testable against fixed strings with no network:

- `buildMappingPrompt(input): { system, user }`
- `parseMappingSuggestion(text): MappingSuggestion | { error }` - strict JSON
  extraction (tolerate markdown fences), then validate against the expected
  schema; a malformed response yields a typed error, never a throw.

Only `LlmAssist.complete` is impure. Given a recorded model response, every
suggestion is a deterministic function of its input - tests pin the mapping from
`(analysis, response)` to `suggestion` with zero AI dependency.

## The three advisories

### A1. AI DCR mapping proposal

- Input: the sampled source fields (name, inferred type, 1-2 example values,
  redacted) + the candidate destination table schema(s) + the deterministic
  `DcrGapAnalysis` already computed.
- Ask: for each unmapped/overflow field, propose the best destination column (or
  confirm overflow), the transform action in the existing vocabulary
  (rename/coerce/overflow/drop/enrich), a confidence 0-1, and a one-line reason.
  When more than one destination table is plausible for a sample, rank the
  tables (this is the model half of "propose a table per sample").
- Output -> merged into the mapping review as SUGGESTED rows the user accepts or
  rejects; accepted rows flow through the identical deterministic path. The
  deterministic mapping is the default; AI only fills/ranks the residual gap.

### A2. AI analytics-rule coverage

- Input: a rule's KQL + its referenced fields + the proposed mapping's available
  fields + the destination schema union.
- Ask: does the mapping SEMANTICALLY satisfy the rule beyond exact name match
  (aliases, ASIM normalization, computed columns)? For each still-missing field,
  suggest the rename/enrichment that would close it.
- Output -> annotates the existing coverage items with a "why this is really
  missing / how to fix" note. `analyzeContentCoverage` still computes the
  authoritative covered/missing/unknown counts and the RULE badges.

### A3. AI workbook coverage

- Same as A2 for workbook query fields (now sourced from the solution repo via
  `acquireSolutionWorkbooks`). Workbook tiles that would stay empty get a
  concrete "map field X to column Y" suggestion.

## Guardrails

- Advisory, never a gate: `canDeploy` / `canDeployContentPath` never read any AI
  output. The deploy-gate partition stays byte-intact.
- Redaction before egress: only field NAMES, inferred TYPES, and at most 1-2
  example values go to the model, and example values pass the existing sample
  redaction before they leave the app. No secrets, tokens, or full raw events.
- Deterministic fallback: if `LlmAssist` is absent, errors, times out, or
  returns unparseable JSON, the analysis is exactly the deterministic result -
  the same principle the SYN-14 deterministic template generator established.
- Cost + caching: attribute tokens per call (port SYN-11's cost tracker), and
  cache a suggestion by a hash of its input (reuse `ContentCache`) so re-opening
  a solution does not re-bill. Immutable inputs (repo content at a commit SHA)
  cache indefinitely; sample-derived inputs cache per capture.
- Timeout: keep `maxTokens <= 4096` and one advisory per call so each stays
  inside the 30s cloud proxy budget (the SYN-12 full-pack-generation timeout
  lesson). Fan out per-rule/per-table rather than one mega-prompt.

## Cloud platform work

Add to `apps/cribl-app/config/proxies.yml`:

```
api.anthropic.com:
  timeout: 30000
  headers:
    inject:
      x-api-key: '`${kv.anthropicKey}`'
      anthropic-version: '2023-06-01'
    allowlist:
      - Content-Type
      - Accept
  rejectUnauthorized: true
```

The `anthropicKey` KV entry is written encrypted/write-only and validated once
(a cheap models call) before it is stored, mirroring the `githubPat` flow. Admins
approve `api.anthropic.com` at install time as an explicit, reviewable surface.

## Rollout phases

- P0 - seam: SHIPPED. `LlmAssist` + `LlmKeyManager` ports, cloud adapters
  (proxies.yml api.anthropic.com, encrypted KV `anthropicKey`,
  validate-then-store via the zero-token GET /v1/models), local adapters
  (host/anthropic.mjs + /api/llm routes), and the "AI Assist" key section on
  the Repositories screen. App unchanged when the key is absent.
- P1 - A1 mapping proposal: SHIPPED. domain/ai-advisory (buildMappingPrompt,
  fence-tolerant parseMappingSuggestion, never-trusted
  sanitizeMappingSuggestion) + usecases adviseMapping (never rejects) + the
  per-table "AI suggestions" panel in the mapping review; Apply flows through
  the same edit-mapping dispatch as the manual dropdowns; tableRanking
  surfaces the better-table hint.
- P2 - A2/A3 coverage annotations: SHIPPED. buildCoveragePrompt /
  parseCoverageAdvice (fixes filtered to REAL missing fields) + adviseCoverage
  + the per-item "Explain missing fields with AI" block on both the rules and
  workbooks coverage sections.
- P3 - cost tracking + input-hash caching + a per-run AI cost line in the job
  record. (Per-call token counts already render in every advisory block.)

## Open decisions (promote to ADRs when taken)

1. Model default + override: Fable 5 (`claude-fable-5`) as default; expose an
   override in Options? (Recommend: fixed default, no user-facing model picker in
   MVP.)
2. Redaction depth: send example values at all, or field-names + types only?
   (Recommend: names + types + at most one already-redacted example.)
3. Caching horizon for sample-derived suggestions (per capture vs. per session).

## Alignment with the existing catalog

This extends the AI approach the feature catalog already scopes (SYN-02 AI schema
extraction, SYN-03 AI schema inference from samples, SYN-11 cost tracker, SYN-12
AI pack generation, SYN-13/14 deterministic fallback) from the schema-drift
engine to the interactive Sentinel Integration analyses. Same Anthropic proxy,
same key-in-KV model, same deterministic-fallback discipline - applied to DCR
mapping, rule coverage, and workbook coverage instead of pack generation.
