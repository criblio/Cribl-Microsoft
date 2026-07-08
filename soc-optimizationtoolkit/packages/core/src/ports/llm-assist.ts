/**
 * LlmAssist port - the ONE seam for AI-assisted analysis (the Fable 5 plan,
 * docs/ai-assisted-analysis-plan.md). The model call is IO, so it lives behind
 * this port exactly like AzureManagement/SentinelContent; prompt construction
 * and response parsing stay PURE in domain/ai-advisory.
 *
 * Adapters (bound by each shell, NOT here):
 * - Cloud shell: POST api.anthropic.com/v1/messages through proxies.yml with
 *   the key injected server-side from the encrypted KV entry (anthropicKey);
 *   the browser never sets an auth header.
 * - Local shell: the Node host holds the key in its file store and does the
 *   fetch; the key never reaches browser code.
 *
 * ADVISORY-ONLY CONTRACT: everything built on this port is a suggestion layer.
 * The deterministic analyzers remain the source of truth and the deploy gate;
 * canDeploy / canDeployContentPath never read any LLM output. Both `llm` and
 * `llmKey` are OPTIONAL on the UI ports bundle - absent, no AI control renders
 * and every analysis behaves exactly as it does today.
 *
 * Timeout discipline: one advisory per call, maxTokens <= 4096, so each call
 * stays inside the cloud proxy's 30s budget (the SYN-12 lesson).
 */

/**
 * The default model for advisory calls: Fable 5. Fixed (no user-facing model
 * picker in the MVP - plan decision 1); adapters use it when a request does
 * not override.
 */
export const DEFAULT_LLM_MODEL = "claude-fable-5";

/** One completion request. Prompts are built by pure domain code. */
export interface LlmCompletionRequest {
  /** The system prompt (role + output-format contract). */
  system: string;
  /** The user prompt (the redacted analysis input). */
  user: string;
  /** Hard output cap; keep <= 4096 so the call fits the 30s proxy budget. */
  maxTokens: number;
  /** Model override; adapters default to {@link DEFAULT_LLM_MODEL}. */
  model?: string;
}

/** One completion result. The raw text is parsed by PURE core validators. */
export interface LlmCompletionResult {
  /** The model's raw text output (never trusted; always schema-validated). */
  text: string;
  /** Prompt tokens billed, when the API reported them (else 0). */
  inputTokens: number;
  /** Completion tokens billed, when the API reported them (else 0). */
  outputTokens: number;
}

/**
 * The completion seam. `complete` rejects on transport/auth failure (adapter
 * surfaces an actionable message, NEVER the key); usecases catch and degrade
 * to the deterministic result - an LLM failure is never a feature failure.
 */
export interface LlmAssist {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/**
 * Status of the stored Anthropic API key - the exact GithubPatManager shape
 * (hasKey + optional user-facing error), because the lifecycle is identical:
 * VALIDATE-THEN-STORE, WRITE-ONLY, never returned to the renderer.
 */
export interface LlmKeyStatus {
  /** True when a validated key is stored for this app/host. */
  hasKey: boolean;
  /**
   * The reason a `validateAndStore` attempt did not result in a stored key -
   * a user-facing message, NEVER the key. Present only on failed validation.
   */
  error?: string;
}

/**
 * LlmKeyManager - the Anthropic API key lifecycle, mirroring GithubPatManager:
 * {@link validateAndStore} verifies the key with a zero-token call (GET
 * /v1/models) and stores it encrypted ONLY on success; {@link status} exposes
 * hasKey, never the secret. All fetching/storage lives in the shell adapters.
 */
export interface LlmKeyManager {
  /** Resolve whether a validated key is stored. Never the key itself. */
  status(): Promise<LlmKeyStatus>;

  /**
   * Validate `key` and, only on success, store it encrypted. A failed
   * validation resolves `{ hasKey: false, error }` and rolls back any
   * provisional write.
   */
  validateAndStore(key: string): Promise<LlmKeyStatus>;

  /** Remove the stored key (and its status marker). Idempotent. */
  clear(): Promise<void>;
}

/**
 * Cheap client-side format precheck before any network call (mirrors
 * patFormatIssue): a user-facing issue string, or null when the shape is
 * plausible. Anthropic keys are long single tokens; this deliberately does
 * NOT hard-require the current "sk-ant-" prefix (prefixes change) - just
 * enough to catch pastes of the wrong thing.
 */
export function llmKeyFormatIssue(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed === "") {
    return "Enter an Anthropic API key.";
  }
  if (trimmed.length < 20) {
    return "That does not look like an Anthropic API key (too short).";
  }
  if (/\s/.test(trimmed)) {
    return "An API key cannot contain spaces - check the paste.";
  }
  return null;
}
