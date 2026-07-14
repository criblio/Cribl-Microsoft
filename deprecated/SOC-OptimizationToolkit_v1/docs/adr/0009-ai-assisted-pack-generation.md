# 9. AI-assisted pack generation and the autonomous schema-drift engine

Date: 2026-06-22

## Status

Accepted

## Context

The capability census found that `Azure/dev/windows-schema-sync/` is far more than "schema sync": it
is an AI-powered autonomous onboarding and drift-monitoring system. Its Python layer
(`src/orchestrator.py`, `src/monitors/*`, `src/generators/cribl_generator.py`,
`src/autonomous_onboarding.py`, `src/utils/cost_tracker.py`) uses the Anthropic API (Claude) at three
points: extracting structured schemas from Microsoft HTML docs, inferring schemas from sample events,
and generating/updating Cribl Stream packs. It detects drift between source (Windows Security Events)
and destination (Sentinel SecurityEvent) schemas, regenerates packs when they diverge, commits via
GitOps (GitHub Actions, daily), and tracks token cost (~$0.70/run). The owner confirmed this is
first-class scope.

This introduces two things new to the rest of the product: a dependency on an LLM, and
non-deterministic output in a codebase whose whole testing strategy is built on determinism
([testing-strategy.md](../testing-strategy.md)).

## Decision

Model AI as just another driven port, and quarantine its non-determinism.

- A single `AiClient` port owns all LLM access; `adapters-ai` implements it with the Anthropic API.
  The core depends on the port, never on the SDK. Default to the latest capable Claude models;
  pin the model id in config.
- The three AI operations become explicit usecases/domain steps: schema extraction, schema inference,
  and `GeneratePackWithAI`. The drift detection itself (`MonitorSchemaDrift`) is **deterministic
  Python/TS logic** — comparing two schemas is not an AI task and must not be one.
- The **AI prompts are versioned assets** with golden-output tests: a recorded request/response pair
  pins expected behavior, and the prompts are treated like the other preserve-verbatim assets in
  [../CONTEXT.md](../CONTEXT.md).
- AI **output is always validated** before use: generated Cribl YAML must parse and pass the same
  pack contract/golden tests as hand-built packs; invalid output triggers a retry with a stricter
  prompt, then a fallback to the last known-good pack. The LLM proposes; deterministic validation
  disposes.
- A human gate stays in the loop: AI-generated packs land via GitOps pull request, not direct
  auto-deploy, so a person reviews before anything reaches a tenant.
- Cost is tracked and bounded (the existing `cost_tracker` logic is ported); schema extractions are
  cached because they rarely change.

## Consequences

- The product gains autonomous drift onboarding without making the rest of the codebase
  non-deterministic: the AI is isolated behind one port, its output is gated by deterministic
  validation, and tests fake the `AiClient` with recorded responses.
- We take on an external paid dependency (Anthropic API) and must manage keys, cost, rate limits, and
  model-version drift; pinning the model and caching extractions contains this.
- AI output is never trusted blindly: the validation-and-PR gate is mandatory, which is what makes an
  LLM acceptable in a tool that writes to customer cloud environments.
- Reusing the existing Python intelligence layer as a sidecar behind `AiClient` is an allowed
  implementation of this ADR if porting the prompts/logic to TS proves slower than wrapping them; the
  port boundary is the same either way.
