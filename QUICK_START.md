# Quick Start

The active project is the SOC Optimization Toolkit in
`soc-optimizationtoolkit/` - see the [repository README](README.md).

## Cribl.Cloud app (recommended)

```bash
cd soc-optimizationtoolkit
npm install
npm run package
```

Upload `apps/cribl-app/build/soc-optimizationtoolkit-<version>.tgz` to your
Cribl.Cloud workspace, then open it and follow the journey: Setup ->
Sentinel Integration -> DCR Automation -> Pack Maintenance.

## Local app

```bash
cd soc-optimizationtoolkit
npm install
npm run dev --workspace apps/local-app
```

The previous Electron quick start moved to `deprecated/` - see
[deprecated/README.md](deprecated/README.md).
