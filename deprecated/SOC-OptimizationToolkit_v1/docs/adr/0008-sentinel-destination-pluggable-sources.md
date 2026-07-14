# 8. Single Sentinel destination, pluggable source connectors

Date: 2026-06-22

## Status

Accepted

## Context

This is a **Microsoft Sentinel SOC Optimization Toolkit**. The destination is always Microsoft
Sentinel (a Log Analytics workspace, reached via Data Collection Rules); Cribl Stream is the pipe in
the middle. A full-repository census found capabilities that look like "other clouds" — most notably
`Dev/AWS/Labs/AWSIntegrationLab/` (Terraform deploying S3/SQS/Kinesis/CloudWatch + IAM, Python
generating Cribl S3/Kinesis/CloudWatch configs). It is tempting to read this as "multi-cloud" and
build a provider-neutral core where Azure and AWS are interchangeable destinations.

That reading is wrong, and an earlier draft of this ADR made that mistake. **AWS (and any other
cloud) is a data _source_, not a destination.** The flow is: AWS data source -> Cribl Stream ->
Microsoft Sentinel. The destination machinery — DCRs/DCEs, AMPLS, custom `_CL` tables, the column-type
and reserved-column rules — is Sentinel-specific and central, not one of N symmetric clouds. Forcing a
"generic cloud destination" abstraction would create a false symmetry and leak Sentinel concepts into a
fake neutral shape.

## Decision

Model the system as **one destination (Microsoft Sentinel) and many pluggable sources.**

- The destination is Sentinel-specific. Its ports name it honestly: `SentinelClient`, `DcrDeployer`,
  `SchemaStore`, `PolicyClient`. They are not abstracted into a provider-neutral "cloud" interface.
- The source side is pluggable behind a single `SourceConnector` port: configure a data source for
  Cribl collection and emit its Cribl source config. Adding a source (AWS, Event Hub, vNet Flow, O365)
  is a new `SourceConnector` adapter and never touches the destination.
- `adapters-aws` implements `SourceConnector` for AWS (S3/SQS/Kinesis/CloudWatch + IAM), generating
  the Cribl source config so Cribl collects AWS data and forwards it to Sentinel. AWS infra for labs is
  provisioned via Terraform through `adapters-infra`.
- `OnboardSource` reads "configure the source via a `SourceConnector`, route through Cribl, land in
  Sentinel via `DcrDeployer`." Varying the source varies which connector is injected; the destination
  is constant.
- Microsoft **Fabric RTI** (`Azure/dev/FabricRTI/`, empty) is the only thing that could become a
  second _destination_. If it is ever built, it gets its own destination adapter alongside Sentinel —
  but we do not pre-abstract a generic destination for a capability that does not exist yet. Sentinel
  remains the single destination.

## Consequences

- The destination code stays clear and honest about being Sentinel — no leaky "generic cloud"
  abstraction, no pretending AMPLS or `_CL` tables are provider-agnostic.
- Broadening source coverage is cheap and isolated: a new `SourceConnector` adapter, its Cribl
  source-config generation, and contract tests — with zero risk to the destination.
- AWS work (Phase 8) is scoped as "add an AWS source connector", not "add a second cloud destination",
  which is both smaller and accurate.
- If Fabric RTI is later adopted as an alternative destination, that is a separate, explicit decision
  (a future ADR) introducing a destination port — not something this design forces now.
