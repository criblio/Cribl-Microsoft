# CONTEXT: @soc/local-app

Purpose: the local deployment target for customer-managed (on-prem) Cribl - a Node host that serves the shared UI in a browser and fulfills the same @soc/core port contracts the cloud platform provides to cribl-app. Launched from source (EDR-friendly, per the repo's established launcher pattern).

Responsibilities (planned):
- Serve packages/ui in a browser; provide port adapters: outbound HTTP to Azure/Graph/leader, OS-local encrypted secret store (or no-storage device-code mode), job scheduler (drift checks run scheduled here; on-demand only in the cloud app).
- Talk to the Cribl leader directly: on-prem bearer login or Cloud org token.
- First-run onboarding GUI covering BOTH targets: explain tradeoffs, then either walk through packaging/uploading the cribl-app .tgz and admin approval, or connect this local app to a leader.
- Outbound domain allowlist reviewed in the same PR as features needing it (mirror of cloud proxies.yml discipline).

Advantages over the cloud target (capability superset): private network reach, no 30s/100rpm proxy limits, scheduling, can run inside air-gapped networks beside a local leader.

Status: placeholder host only.
