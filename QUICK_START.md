# Quick Start

The active project is the SOC Optimization Toolkit in
`soc-optimizationtoolkit/` - a Cribl App for the Cribl Apps platform
(Cribl.Cloud), with a local Node-hosted variant for customer-managed
deployments. This page gets the app installed and producing value; the
[repository README](README.md) describes what it does.

## Install the app in Cribl.Cloud (recommended)

No build needed - the latest release is committed in the repository.

### 1. Get the package

Download the single `.tgz` from
[`soc-optimizationtoolkit/apps/cribl-app/release/`](soc-optimizationtoolkit/apps/cribl-app/release/).
It is always the latest release; the version is in the filename and inside
the package metadata.

### 2. Install it (Organization administrator)

Cribl Apps is a Cribl.Cloud Preview capability, and only Organization
administrators can install, upgrade, or delete Apps.

1. In your Cribl.Cloud workspace, select **Apps** in the top navigation.
2. Select **Add App**, then **Import from File**, and choose the `.tgz`.
3. Review the install summary. The app declares up front:
   - External endpoints it calls (`proxies.yml`): Azure management and
     login endpoints, GitHub content access.
   - Cribl product-API routes it may call (`policies.yml`): read/write
     scopes reviewed line by line at install time.
4. Confirm to finish the install.

### 3. Grant access

1. Open **Apps** - **Installed**, find the app row, and choose **Share**.
2. On the **Members** and **Teams** tabs assign **App user** to whoever
   should run it, then save.

Users open the app from the Apps bar (or **Apps** - **Installed**).

### 4. First run inside the app

The app lands on **Dataflow** (the journey overview). Do these once:

1. **Setup**: connect the Entra app registration (tenant, client id,
   secret - stored in the app's encrypted KV store), discover and select
   the Azure subscription/resource group/workspace, and run the generated
   role-assignment script if permissions are missing.
2. Optional: connect a GitHub PAT on **Repositories** for Sentinel
   solution content access.

From there the journey is: **Sentinel Integration** (pick a solution,
analyze samples, deploy DCRs + Cribl pack) - **DCR Automation** -
**Pack Maintenance**.

### Upgrading

**Apps** - **Installed** - row actions - **Upgrade** - upload the new
`.tgz` - confirm. KV store data and settings are preserved, so the Azure
connection and app state survive upgrades; access permissions are kept.

## Local app (customer-managed Cribl)

For self-hosted leaders where Cribl Apps is not available:

```bash
cd soc-optimizationtoolkit
npm install
npm run local     # builds and starts the local Node host
```

The first run is an onboarding GUI that walks through connecting the
leader and Azure. Configuration lives in
`apps/local-app/config/local-config.json`.

## Build the package from source

```bash
cd soc-optimizationtoolkit
npm install
npm run package   # from apps/cribl-app: mints the next version, writes
                  # build/<name>-<version>.tgz and refreshes release/
```

The previous Electron quick start moved to `deprecated/` - see
[deprecated/README.md](deprecated/README.md).
