/**
 * GitHub PAT policy - the PURE contract (porting-plan Unit 14; ENG-30).
 *
 * The flow (from auth.ts saveGitHubPat/testGitHubPat/loadGitHubPat and the
 * github-save handler) redesigned for the two shells:
 *
 *   1. VALIDATE-THEN-STORE. A submitted PAT is validated by calling GET /user
 *      with it (testGitHubPat). Only a 200 stores it.
 *   2. STORE ENCRYPTED, WRITE-ONLY. The token is written encrypted (KV-encrypted
 *      on cloud, host secret store on local) and is NEVER returned to the
 *      renderer. The only thing that crosses back is a `hasPat` boolean (plus
 *      the resolved GitHub login, which is not a secret).
 *   3. SERVER-SIDE HEADER INJECTION. Content requests carry no token from the
 *      browser: the proxy (proxies.yml) injects `Authorization: Bearer <pat>`
 *      server-side. This module therefore has NO token-taking function - core
 *      never builds an auth header, so a renderer bundle can never leak one.
 *   4. REQUIRED ON CLOUD. The cloud shell shares one egress IP across all
 *      tenants, so anonymous GitHub quota (60 req/hr per IP) is unreliable and a
 *      PAT is effectively required. On local the process has its own IP, so a
 *      PAT is strongly recommended (lifts 60/hr -> 5000/hr) but not mandatory.
 *
 * This module encodes only decisions the UI reads (hasPat-only status, the
 * platform gate, the format precheck). Pure: no IO, no fetch, no React.
 */

/** Which shell is asking (governs whether the PAT is mandatory). */
export type ContentPlatform = "cloud" | "local";

/** The endpoint a PAT is validated against (validate-then-store step 1). */
export const PAT_VALIDATION_ENDPOINT = "https://api.github.com/user";

/**
 * Minimum trimmed length for the format precheck (auth.ts github-save:
 * `pat.trim().length < 10 -> "PAT is required"`).
 */
export const PAT_MIN_LENGTH = 10;

/** Minimal scope guidance surfaced in onboarding (public-read only). */
export const PAT_SCOPE_GUIDANCE =
  "Read-only access to public repositories is sufficient. Classic token: no " +
  "scopes are required to read public repos (or select 'public_repo'). " +
  "Fine-grained token: grant 'Public Repositories (read-only)'. The token is " +
  "used only to raise GitHub's anonymous rate limit; it needs no write access.";

/**
 * The ONLY PAT-derived shape that crosses to the renderer. Never carries the
 * token - by construction the renderer cannot receive it.
 */
export interface PatStatus {
  hasPat: boolean;
  /** The GitHub login resolved at validation time (not a secret). */
  login?: string;
}

/** The result of the GET /user validation the adapter performs (step 1). */
export interface PatValidationResult {
  ok: boolean;
  login?: string;
  error?: string;
}

/** The per-platform PAT policy the onboarding UI reads. */
export interface PatPolicy {
  platform: ContentPlatform;
  /** True on cloud (shared egress IP); false (recommended) on local. */
  required: boolean;
  /** Why - shown in onboarding. */
  rationale: string;
  /** Minimal-scope guidance. */
  scopeGuidance: string;
}

/** The runtime gate for content operations, given a platform and hasPat. */
export interface PatGate {
  /** May content operations proceed at all? */
  allowed: boolean;
  /** Is the absence of a PAT a hard block (vs a soft advisory)? */
  blocking: boolean;
  /** User-facing explanation (empty when a PAT is present). */
  message: string;
}

/**
 * Format precheck before ever calling GitHub. Returns an error message when the
 * PAT is missing/too short, or null when it is worth validating (auth.ts guard).
 */
export function patFormatIssue(pat: string | null | undefined): string | null {
  if (!pat || pat.trim().length < PAT_MIN_LENGTH) return "PAT is required";
  return null;
}

/**
 * The hasPat-only status that crosses to the renderer after a validation. The
 * token is intentionally absent from the return type and the return value.
 */
export function patStatusFrom(validation: PatValidationResult): PatStatus {
  return validation.ok
    ? { hasPat: true, login: validation.login }
    : { hasPat: false };
}

/**
 * The store decision: only a successful GET /user validation stores the token
 * (validate-then-store). Returns whether to persist and the renderer-facing
 * status; NEVER the token.
 */
export function decidePatStore(validation: PatValidationResult): {
  store: boolean;
  status: PatStatus;
} {
  return { store: validation.ok, status: patStatusFrom(validation) };
}

/** The PAT policy for a platform. */
export function patPolicyFor(platform: ContentPlatform): PatPolicy {
  if (platform === "cloud") {
    return {
      platform,
      required: true,
      rationale:
        "The Cribl-hosted app shares one egress IP across tenants, so GitHub's " +
        "anonymous per-IP rate limit is unreliable. A PAT is required to browse " +
        "solutions and fetch content.",
      scopeGuidance: PAT_SCOPE_GUIDANCE,
    };
  }
  return {
    platform,
    required: false,
    rationale:
      "The local app has its own egress IP, so anonymous GitHub access works " +
      "for light use. A PAT is strongly recommended - it raises the rate limit " +
      "from 60 to 5000 requests/hour and avoids throttling while browsing.",
    scopeGuidance: PAT_SCOPE_GUIDANCE,
  };
}

/**
 * Evaluate whether content operations may proceed. On cloud, no PAT is a hard
 * block; on local, no PAT is allowed but advisory. A present PAT is always
 * allowed with no message.
 */
export function evaluatePatGate(
  platform: ContentPlatform,
  hasPat: boolean,
): PatGate {
  if (hasPat) return { allowed: true, blocking: false, message: "" };
  if (platform === "cloud") {
    return {
      allowed: false,
      blocking: true,
      message:
        "A GitHub personal access token is required on the hosted app before " +
        "browsing solutions or fetching content. Add one in Repositories settings.",
    };
  }
  return {
    allowed: true,
    blocking: false,
    message:
      "No GitHub token set. Content browsing works anonymously but may be rate-" +
      "limited; add a token in Repositories settings to avoid throttling.",
  };
}
