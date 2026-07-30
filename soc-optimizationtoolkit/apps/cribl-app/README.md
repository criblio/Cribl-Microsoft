# SOC Optimization Toolkit - Cribl App

The Cribl.Cloud app target of the SOC Optimization Toolkit: the shared
@soc/ui screens over the Cribl Apps (Preview) platform bridge.

## Install the latest release

The latest packaged app is committed at [release/](release/) - one .tgz,
replaced on every release. Install it without building anything
(Organization administrator required; Cribl Apps is a Preview capability):

1. Download the `soc-optimizationtoolkit-<version>.tgz` from `release/`.
2. In your Cribl.Cloud workspace: **Apps** (top navigation) - **Add App**
   - **Import from File** - select the .tgz.
3. Review the install summary (the declared external endpoints from
   `config/proxies.yml` and the product-API policies from
   `config/policies.yml`) and confirm.
4. Share it: **Apps** - **Installed** - row actions - **Share** - assign
   **App user** to the members or teams who should run it.
5. Users open it from the Apps bar. First run: start at the **Setup**
   page to connect Azure. Upgrades go through **Apps** - **Installed** -
   **Upgrade** and preserve the app's KV-stored settings.

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
