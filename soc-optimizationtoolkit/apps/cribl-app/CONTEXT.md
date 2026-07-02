# CONTEXT: cribl-app (Cloud shell)

Purpose: the Cribl App Platform target - a Vite/React SPA packaged as a .tgz and installed into a Cribl.Cloud leader, running in a sandboxed iframe.

Platform rules live in AGENTS.md (read it before touching fetch, navigation, or config): locked fetch with automatic auth, app-scoped KV store (encrypted entries are write-only from the client), proxies.yml external-domain declarations with server-side header injection, policies.yml product API grants, 30s proxy timeout, 100 req/min.

Boundaries: binds platform adapters to @soc/core ports and renders @soc/ui. App-specific code here should shrink toward wiring-only as core/ui fill in.

Key files: config/proxies.yml and config/policies.yml (admin-reviewed external surface - update in the same PR as the feature needing them), scripts/package.mjs (version bump + .tgz build), vite.config.ts (dev-mode config watcher + package endpoint).

Status: stock scaffold; feature implementation follows the roadmap in ../../docs/feature-catalog.md.
