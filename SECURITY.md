# Security Policy

## About This Application

This is a **local developer toolkit** that runs on the user's workstation. It is not a hosted service or production application. See [SECURITY_DISCLAIMER.md](SECURITY_DISCLAIMER.md) for full details on what the app can do, how credentials are stored, and the available operating modes (including Air-Gapped mode for offline-only operation).

## Reporting a Vulnerability

If you believe you have found a security vulnerability, please report it responsibly.

### Do NOT:
- Report vulnerabilities through public GitHub issues
- Exploit vulnerabilities beyond what is necessary to demonstrate them

### How to Report

1. **GitHub private reporting:** Go to the Security tab of this repository and click "Report a vulnerability"
2. **Email:** [jpederson@cribl.io](mailto:jpederson@cribl.io)

### What to Include

- Type of issue (e.g., credential exposure, command injection, path traversal)
- Affected source file(s) and line numbers
- Steps to reproduce
- Potential impact

### What to Expect

- **Acknowledgment** within 48 hours
- **Initial assessment** within 5 business days
- **Fix and disclosure** coordinated with the reporter

## Scope

This toolkit interacts with external systems only when the user explicitly connects to them:

| System | How it connects | What it can do |
|--------|----------------|----------------|
| **Azure** | User's PowerShell session (`Connect-AzAccount`) | Create/modify resources with user's permissions |
| **Cribl Stream** | OAuth or admin credentials provided by user | Upload packs, create routes, deploy configs |
| **GitHub** | Personal Access Token (read-only) | Fetch public repo content |

In **Air-Gapped mode**, no external connections are made. All artifacts are generated locally.

## Credential Storage

- Cribl and GitHub credentials are encrypted using Windows DPAPI via Electron `safeStorage`
- Azure credentials are not stored by this app (managed by the Az PowerShell module)
- No credentials are transmitted to third parties

---

Thank you for helping keep this project safe.
