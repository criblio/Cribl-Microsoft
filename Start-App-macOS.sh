#!/bin/bash
# Cribl SOC Optimization Toolkit for Microsoft Sentinel - macOS/Linux launcher

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/Cribl-Microsoft_IntegrationSolution" || { echo "[ERROR] Solution directory not found."; exit 1; }

echo "============================================================"
echo "  Cribl SOC Optimization Toolkit for Microsoft Sentinel"
echo "============================================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed or not in PATH."
    echo "        Download it from https://nodejs.org/"
    echo "        Or install via: brew install node (macOS) / sudo apt install nodejs (Linux)"
    exit 1
fi

# Check if dependencies need to be installed
if [ ! -d "node_modules" ]; then
    echo "[NOTICE] Node.js dependencies have not been installed yet."
    echo "         This will run 'npm install' to download packages"
    echo "         defined in package.json from the npm registry."
    echo ""
    echo "         Review package.json before proceeding if this is"
    echo "         your first time running the application."
    echo ""
    read -rp "Install dependencies now? (Y/N): " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "Cancelled. Install dependencies manually with: npm install"
        exit 0
    fi
    echo ""
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[ERROR] npm install failed. Check your network connection."
        exit 1
    fi
    echo ""
fi

echo "Clearing build cache and session config..."
CONFIG_DIR="${HOME}/.cribl-microsoft/config"
[ -f "$CONFIG_DIR/integration-mode.json" ] && rm "$CONFIG_DIR/integration-mode.json"
[ -d "dist-electron" ] && rm -rf "dist-electron"
[ -d "node_modules/.vite" ] && rm -rf "node_modules/.vite"

echo "Starting application..."
npm run dev
