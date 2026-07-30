# SOC Optimization Toolkit - Cribl App

The Cribl.Cloud app target of the SOC Optimization Toolkit: the shared
@soc/ui screens over the Cribl Apps (Preview) platform bridge.

## Install the latest release

The latest packaged app is committed at [release/](release/) - one .tgz,
replaced on every release. Install it without building anything:

1. Download the `soc-optimizationtoolkit-<version>.tgz` from `release/`.
2. In your Cribl.Cloud workspace, open the Apps page and upload the .tgz.
3. Open the app from the workspace navigation.

## Build and package from source

```bash
npm install          # from the soc-optimizationtoolkit/ workspace root
npm run package      # from apps/cribl-app: builds, mints the next version,
                     # writes build/<name>-<version>.tgz and refreshes release/
```

`npm run package -- --version=X.Y.Z` pins an explicit version; `--minor` /
`--major` bump those segments instead of the patch.

## Development

```bash
npm run dev          # Vite dev server with the local platform harness
npm run typecheck && npm run test && npm run lint
```

Configuration shipped inside the pack lives in [config/](config/)
(`policies.yml` allowlists the product-API routes the app may call;
`proxies.yml` declares the external proxies). See the repository root
CLAUDE.md and packages/*/CONTEXT.md for architecture context.
