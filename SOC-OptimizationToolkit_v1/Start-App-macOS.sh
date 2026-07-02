#!/usr/bin/env bash
#
# SOC-OptimizationToolkit Launcher (macOS / Linux)
#
# Runs the desktop GUI from source using Node.js + Electron, the same way
# the previous app launched. Running from source (not a packaged app) is
# deliberate: it avoids the EDR false positives that packaged executables
# trigger on corporate machines.
#
# Requires: Node.js 18+ (https://nodejs.org/) and pnpm
# (https://pnpm.io/installation, or run: corepack enable).
#
# NOTE: this launches the NEW toolkit, which is scaffolded in roadmap
# Phase 0. Until that scaffold exists, this script reports that the
# toolkit is not built yet and exits cleanly.
#
# Make executable once with:  chmod +x Start-App-macOS.sh
set -euo pipefail

# Clear ELECTRON_RUN_AS_NODE if inherited from a parent (VSCode, Cursor, ...).
unset ELECTRON_RUN_AS_NODE || true

# The launcher lives in the toolkit root, so this IS the workspace root.
cd "$(dirname "$0")"

echo "============================================================"
echo "  Cribl SOC Optimization Toolkit for Microsoft Sentinel"
echo "============================================================"
echo

# Scaffold guard: the monorepo is created in roadmap Phase 0.
if [ ! -f "pnpm-workspace.yaml" ]; then
  echo "[NOTICE] The toolkit has not been scaffolded yet."
  echo "         The monorepo (pnpm-workspace.yaml, packages/, apps/) is"
  echo "         created in roadmap Phase 0. See docs/roadmap.md."
  exit 0
fi

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not in PATH."
  echo "        Download it from https://nodejs.org/"
  exit 1
fi

# Check pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[ERROR] pnpm is not installed or not in PATH."
  echo "        Enable it with 'corepack enable' or see https://pnpm.io/installation"
  exit 1
fi

# First-run install (pnpm installs the whole workspace from the root)
if [ ! -d "node_modules" ]; then
  echo "[NOTICE] Workspace dependencies have not been installed yet."
  echo "         This will run 'pnpm install' for the whole workspace."
  echo
  read -r -p "Install dependencies now? (Y/N): " CONFIRM
  if [ "${CONFIRM}" != "Y" ] && [ "${CONFIRM}" != "y" ]; then
    echo "Cancelled. Install manually with: pnpm install"
    exit 0
  fi
  echo "Installing dependencies..."
  pnpm install
fi

# Clear desktop build cache (guarded; paths finalized in Phase 0)
rm -rf "apps/desktop/dist-electron" "apps/desktop/node_modules/.vite" 2>/dev/null || true

echo "Starting the desktop GUI from source..."
# Launches the Electron desktop app (apps/desktop). The exact dev script
# is defined in Phase 0; this targets the desktop workspace package.
pnpm --filter desktop dev
