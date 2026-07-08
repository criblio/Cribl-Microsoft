// Anthropic proxy for the local host: the server-side twin of the cloud
// shell's PlatformLlmAssist + PlatformLlmKey adapters (apps/cribl-app/src/
// platform/adapters.ts), docs/ai-assisted-analysis-plan.md P0.
//
// The cloud shell reaches Anthropic through the platform proxy, which injects
// the key from the write-only KV slot (proxies.yml). This host instead OWNS
// the key: it stores it in data/anthropic.json (plaintext on disk, 0600
// best-effort, gitignored) and attaches the x-api-key header itself. The key
// NEVER leaves this process - the browser-facing API returns only { hasKey },
// never the key (write-only parity with the cloud KV slot).
//
// No browser-supplied URLs ever reach this proxy: complete() builds its own
// fixed api.anthropic.com/v1/messages request, so there is no SSRF surface.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, fetchTextWithTimeout, parseUpstreamBody } from './http-util.mjs';

const FILE_MODE = 0o600;
const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Default model for advisory calls (kept in sync with @soc/core
// DEFAULT_LLM_MODEL as a small constant - the host cannot import the TS core).
const DEFAULT_MODEL = 'claude-fable-5';
// Format precheck mirrored from @soc/core llmKeyFormatIssue.
const KEY_MIN_LENGTH = 20;
// Advisory calls are one-per-item with maxTokens <= 4096; bound the output cap
// here too so a buggy caller cannot request an unbounded completion.
const MAX_TOKENS_CAP = 4096;

/**
 * Build the Anthropic proxy + key store over {dataDir}/anthropic.json.
 *
 * @param {string} dataDir
 * @param {ReturnType<import('./logger.mjs').createFileLogger>} [logger]
 *   Optional file logger. Only METADATA is ever logged (status, token counts) -
 *   the key and the prompt/response text never reach a log line.
 */
export function createAnthropicProxy(dataDir, logger) {
  const filePath = path.join(dataDir, 'anthropic.json');
  let queue = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** @returns {Promise<{ key: string }>} */
  async function readState() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { key: '' };
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return { key: typeof parsed.key === 'string' ? parsed.key : '' };
    } catch {
      return { key: '' };
    }
  }

  /** @param {{ key: string }} state */
  async function writeState(state) {
    await mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: FILE_MODE });
    await rename(tmpPath, filePath);
    try {
      await chmod(filePath, FILE_MODE);
    } catch {
      // Best effort; mode bits are advisory on Windows.
    }
  }

  /**
   * Validate a candidate key with the zero-token models listing.
   * @param {string} key
   * @returns {Promise<{ ok: boolean, status: number }>}
   */
  async function probeKey(key) {
    const res = await fetchTextWithTimeout(`${ANTHROPIC_API}/v1/models`, {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        Accept: 'application/json',
      },
    });
    return { ok: res.ok, status: res.status };
  }

  return {
    /**
     * The non-secret key status the browser API returns. NEVER the key.
     * @returns {Promise<{ hasKey: boolean }>}
     */
    status() {
      return enqueue(async () => {
        const state = await readState();
        return { hasKey: state.key !== '' };
      });
    },

    /**
     * Validate `key` (zero-token GET /v1/models) and store it only on success.
     * @param {string} key
     * @returns {Promise<{ hasKey: boolean, error?: string }>}
     */
    validateAndStore(key) {
      return enqueue(async () => {
        if (typeof key !== 'string' || key.trim().length < KEY_MIN_LENGTH || /\s/.test(key.trim())) {
          return { hasKey: false, error: 'That does not look like an Anthropic API key.' };
        }
        const trimmed = key.trim();
        const probe = await probeKey(trimmed);
        if (!probe.ok) {
          const error =
            probe.status === 401
              ? 'Anthropic rejected the key (HTTP 401) - it is invalid, expired, or revoked.'
              : `Anthropic validation failed (HTTP ${probe.status}).`;
          logger?.warn('anthropic key validation failed', { status: probe.status });
          return { hasKey: false, error };
        }
        await writeState({ key: trimmed });
        logger?.info('anthropic key stored', {});
        return { hasKey: true };
      });
    },

    /** Remove the stored key. Idempotent. @returns {Promise<void>} */
    clear() {
      return enqueue(async () => {
        await writeState({ key: '' });
        logger?.info('anthropic key cleared', {});
      });
    },

    /**
     * One advisory completion with the stored key. Rejects 409 when no key is
     * stored (the picker-facing adapters catch and degrade), relays the
     * upstream failure status otherwise.
     *
     * @param {{ system: string, user: string, maxTokens: number, model?: string }} req
     * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number }>}
     */
    complete(req) {
      return enqueue(async () => {
        const state = await readState();
        if (state.key === '') {
          throw new HttpError(409, 'No Anthropic API key is stored - set it in the AI Assist settings.');
        }
        if (
          typeof req?.system !== 'string' ||
          typeof req?.user !== 'string' ||
          typeof req?.maxTokens !== 'number' ||
          !Number.isFinite(req.maxTokens) ||
          req.maxTokens < 1
        ) {
          throw new HttpError(400, 'POST /api/llm/complete: body must be { system, user, maxTokens, model? }');
        }
        const res = await fetchTextWithTimeout(`${ANTHROPIC_API}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': state.key,
            'anthropic-version': ANTHROPIC_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: typeof req.model === 'string' && req.model !== '' ? req.model : DEFAULT_MODEL,
            max_tokens: Math.min(Math.floor(req.maxTokens), MAX_TOKENS_CAP),
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
          }),
        });
        const body = parseUpstreamBody(res.text);
        if (!res.ok) {
          logger?.warn('anthropic completion failed', { status: res.status });
          throw new HttpError(502, `Anthropic API: HTTP ${res.status}`);
        }
        const content = body !== null && typeof body === 'object' ? body.content : undefined;
        let text = '';
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
              text += block.text;
            }
          }
        }
        const usage = body !== null && typeof body === 'object' ? body.usage : undefined;
        const inputTokens =
          usage !== null && typeof usage === 'object' && typeof usage.input_tokens === 'number'
            ? usage.input_tokens
            : 0;
        const outputTokens =
          usage !== null && typeof usage === 'object' && typeof usage.output_tokens === 'number'
            ? usage.output_tokens
            : 0;
        logger?.info('anthropic completion', { inputTokens, outputTokens });
        return { text, inputTokens, outputTokens };
      });
    },
  };
}
