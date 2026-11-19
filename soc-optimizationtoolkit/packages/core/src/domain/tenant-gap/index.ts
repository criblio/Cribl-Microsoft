/** Tenant logging gap dashboard cells (ADR 0009 decision 6, AZR-63). */
export { GAP_SOURCES, NOT_READ_REASON, azureGapIndicator, criblGapIndicator, legacyRecordSentence, rowUnknown } from "./tenant-gap";
export type { CriblGapInput, GapCell, LegacyCriblEvidence, GapCheck, GapIndicator, GapState, TenantGapRow } from "./tenant-gap";
/** Each tenant's latest gap read, saved in the app KV store (AZR-147). */
export {
  TENANT_GAP_READS_KEY,
  TENANT_GAP_READS_KIND,
  TENANT_GAP_READS_VERSION,
  canWriteGapReads,
  decodeGapReads,
  emptyGapReads,
  encodeGapReads,
  gapReadsFrom,
  gapReadsLoadNote,
  readGapReadsDocument,
  savedGapReadFor,
  withGapRead,
} from "./saved-reads";
export type { DecodedGapReads, GapReadsDocument, SavedGapRead, TenantGapReads } from "./saved-reads";
/** The active tenant's focus summary and the chooser's gap badges (AZR-147). */
export { focusSummary, gapSourceIds } from "./focus";
export type { FocusGap, FocusIndicator, FocusSummary } from "./focus";
