import type { BlockKind, BodyFormat, MediaKind } from "@cs-patchnotes/shared";

/** Immutable parser input selected through an explicit source-record head. */
export interface PristineSource {
  documentId: string;
  sourceRecordId: string;
  sourceAdapter: string;
  bodyFormat: BodyFormat;
  pristineBody: string;
  bodySha256: string;
}

/** Half-open UTF-16 offsets into `PristineSource.pristineBody`. */
export interface SourceSpan {
  start: number;
  end: number;
}

export type DetectionDetail = string | number | boolean | null | string[];

/** Serializable structural evidence returned by one detector. */
export interface DetectionEvidence {
  matched: boolean;
  codes: string[];
  spans: SourceSpan[];
  details: Record<string, DetectionDetail>;
}

/** Evidence persisted by the registry, including the detector identity. */
export interface RecordedDetectionEvidence extends DetectionEvidence {
  parserKey: string;
}

/** A parser-produced canonical block before stable IDs and sibling order are assigned. */
export interface CanonicalBlockData {
  kind: BlockKind;
  parentIndex: number | null;
  text: string | null;
  label: string | null;
  sourceSpan: SourceSpan;
  sourceNodeType: string;
  diagnosticCode: string | null;
}

/** A parser-produced media item owned by a `media_group` block index. */
export interface CanonicalMediaItemData {
  groupBlockIndex: number;
  mediaKind: MediaKind;
  originalLocator: string;
  archiveLocator: string | null;
  caption: string | null;
  altText: string | null;
  sourceSpan: SourceSpan;
}

/** Bounded, structured parser diagnostic without pristine-body excerpts. */
export interface ParseDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  sourceSpan: SourceSpan | null;
  details: Record<string, DetectionDetail>;
}

/** Pure parser output. Persistence and fragment grouping are separate passes. */
export interface CanonicalParseOutput {
  status: "complete" | "partial";
  blocks: CanonicalBlockData[];
  mediaItems?: CanonicalMediaItemData[];
  diagnostics: ParseDiagnostic[];
}

/** A deterministic detector/parser pair registered under a durable key and version. */
export interface RegisteredParser {
  key: string;
  version: string;
  detect(source: PristineSource): DetectionEvidence;
  parse(source: PristineSource): CanonicalParseOutput;
}

/** Auditable operator choice that may bypass exact-one detector selection. */
export interface ReviewedParserOverride {
  parserKey: string;
  reviewedBy: string;
  reason: string;
  reviewedAt: number;
}

export interface SelectedParserResult {
  status: "selected";
  parserKey: string;
  parserVersion: string;
  parser: RegisteredParser;
  evidence: RecordedDetectionEvidence[];
  matchKeys: string[];
  override: ReviewedParserOverride | null;
}

export interface QuarantinedParserResult {
  status: "quarantined";
  reason: "zero_match" | "multiple_match";
  evidence: RecordedDetectionEvidence[];
  matchKeys: string[];
}

export type ParserSelectionResult = SelectedParserResult | QuarantinedParserResult;
