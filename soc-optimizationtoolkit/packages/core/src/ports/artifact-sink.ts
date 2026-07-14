/**
 * ArtifactSink port: delivery channel for generated files (ARM templates,
 * Cribl pack .tgz archives, reports).
 *
 * Implementations:
 * - Cloud shell: adapter triggers a browser download or writes to platform
 *   storage, per the platform's capabilities.
 * - Local shell: the Node host writes the artifact into its configured
 *   output directory.
 */
export interface ArtifactSink {
  /**
   * Persist one artifact.
   *
   * @param name File name for the artifact (e.g. "dcr-SecurityEvent.json").
   *   A bare name, not a path: adapters own placement and must sanitize or
   *   reject names containing path separators.
   * @param mimeType MIME type of the payload (e.g. "application/json",
   *   "application/gzip").
   * @param data Payload. Strings are written as UTF-8; Uint8Array is written
   *   verbatim (binary artifacts such as .tgz).
   *
   * Error semantics: rejects when the artifact cannot be persisted (storage
   * full, permission denied, invalid name). Saving the same name twice
   * overwrites; adapters that cannot overwrite must reject.
   */
  save(name: string, mimeType: string, data: Uint8Array | string): Promise<void>;
}
