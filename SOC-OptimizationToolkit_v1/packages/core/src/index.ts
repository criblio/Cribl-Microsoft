// @soc/core — the pure domain core. ZERO imports of @azure/*, AWS SDK, the Cribl client,
// electron, fs, or child_process (enforced by the ESLint boundary rule).
// See ../../CONTEXT.md and docs/adr/0003-hexagonal-ports-and-adapters.md.

export * from './domain/dcr-name';
export * from './ports/index';
export * from './usecases/index';
