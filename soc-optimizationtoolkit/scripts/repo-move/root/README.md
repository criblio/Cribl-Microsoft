# SOC Optimization Toolkit

Status: Living - the repository entry page; corrected to match the app.

Cribl + Microsoft Sentinel SOC optimization, delivered as a Cribl App Platform
app for Cribl.Cloud. It takes a Microsoft Sentinel solution from sample data to
a deployed Cribl pack and Data Collection Rule: sample acquisition, gap analysis
against the destination table schema, pack generation, and DCR automation.

- **Install it:** [QUICK_START.md](QUICK_START.md)
- **Work on it:** [soc-optimizationtoolkit/README.md](soc-optimizationtoolkit/README.md)
- **What is planned and why:** [soc-optimizationtoolkit/docs/board.md](soc-optimizationtoolkit/docs/board.md)
  and [soc-optimizationtoolkit/docs/backlog.md](soc-optimizationtoolkit/docs/backlog.md)

The DCR ARM templates for customer-managed leaders, and the earlier PowerShell
tooling, live in [criblio/Cribl-Microsoft](https://github.com/criblio/Cribl-Microsoft),
where this app was developed until its history was extracted here.

## Repository layout

```
soc-optimizationtoolkit/   the app (npm workspaces: packages/core, packages/ui, apps/cribl-app)
.github/workflows/         CI
.claude/                   Claude Code hooks and project skills
```

## Security

Never commit credentials - the app keeps Azure and Cribl secrets in its own
encrypted store, configured on its Setup page.
