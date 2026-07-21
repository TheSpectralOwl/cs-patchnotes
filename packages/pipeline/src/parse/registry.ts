import type {
  DetectionDetail,
  DetectionEvidence,
  ParserSelectionResult,
  PristineSource,
  RecordedDetectionEvidence,
  RegisteredParser,
  ReviewedParserOverride,
} from "./contract.js";

const MAX_EVIDENCE_CODES = 8;
const MAX_EVIDENCE_SPANS = 8;
const MAX_EVIDENCE_DETAILS = 8;
const MAX_CODE_LENGTH = 64;
const MAX_DETAIL_KEY_LENGTH = 64;
const MAX_DETAIL_STRING_LENGTH = 160;

function cleanCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
  return (normalized.slice(0, MAX_CODE_LENGTH) || "UNSPECIFIED");
}

function cleanSpan(source: PristineSource, span: { start: number; end: number }) {
  const start = Math.max(0, Math.min(source.pristineBody.length, Math.trunc(span.start)));
  const end = Math.max(start, Math.min(source.pristineBody.length, Math.trunc(span.end)));
  return { start, end };
}

function redactDetailString(source: PristineSource, value: string): string {
  const environmentValues = Object.values(process.env).filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length >= 8,
  );
  if (
    environmentValues.includes(value) ||
    value === source.pristineBody ||
    (value.length >= 16 && source.pristineBody.includes(value))
  ) {
    return "[redacted]";
  }
  return value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_DETAIL_STRING_LENGTH);
}

function cleanDetail(source: PristineSource, detail: DetectionDetail): DetectionDetail {
  if (Array.isArray(detail)) {
    return detail.slice(0, 8).map((value) => redactDetailString(source, value));
  }
  if (typeof detail === "string") return redactDetailString(source, detail);
  if (typeof detail === "number" && !Number.isFinite(detail)) return null;
  return detail;
}

function recordEvidence(
  source: PristineSource,
  parserKey: string,
  evidence: DetectionEvidence,
): RecordedDetectionEvidence {
  const details = Object.fromEntries(
    Object.entries(evidence.details)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_EVIDENCE_DETAILS)
      .map(([key, value]) => [
        key.slice(0, MAX_DETAIL_KEY_LENGTH),
        cleanDetail(source, value),
      ]),
  );

  return {
    parserKey,
    matched: evidence.matched === true,
    codes: evidence.codes.slice(0, MAX_EVIDENCE_CODES).map(cleanCode),
    spans: evidence.spans
      .slice(0, MAX_EVIDENCE_SPANS)
      .map((span) => cleanSpan(source, span)),
    details,
  };
}

function validateOverride(override: ReviewedParserOverride): void {
  if (
    override.parserKey.trim().length === 0 ||
    override.reviewedBy.trim().length === 0 ||
    override.reason.trim().length === 0 ||
    !Number.isSafeInteger(override.reviewedAt) ||
    override.reviewedAt < 0
  ) {
    throw new Error("Reviewed parser override is missing valid audit fields");
  }
}

/** Exact-one parser dispatch with order-independent, bounded evidence. */
export class ParserRegistry {
  readonly #byKey: Map<string, RegisteredParser>;

  constructor(parsers: readonly RegisteredParser[]) {
    this.#byKey = new Map();
    for (const parser of parsers) {
      if (parser.key.trim().length === 0 || parser.version.trim().length === 0) {
        throw new Error("Parser key and version must be non-empty");
      }
      if (this.#byKey.has(parser.key)) {
        throw new Error(`Duplicate parser key: ${parser.key}`);
      }
      this.#byKey.set(parser.key, parser);
    }
  }

  require(key: string): RegisteredParser {
    const parser = this.#byKey.get(key);
    if (parser === undefined) throw new Error(`Unknown parser key: ${key}`);
    return parser;
  }

  all(): RegisteredParser[] {
    return [...this.#byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  selectParser(
    source: PristineSource,
    override?: ReviewedParserOverride,
  ): ParserSelectionResult {
    const evidence = this.all().map((parser) =>
      recordEvidence(source, parser.key, parser.detect(source)),
    );
    const matchKeys = evidence
      .filter((entry) => entry.matched)
      .map((entry) => entry.parserKey);

    if (override !== undefined) {
      validateOverride(override);
      const parser = this.require(override.parserKey);
      return {
        status: "selected",
        parserKey: parser.key,
        parserVersion: parser.version,
        parser,
        evidence,
        matchKeys,
        override: { ...override },
      };
    }

    if (matchKeys.length === 1) {
      const parser = this.require(matchKeys[0]);
      return {
        status: "selected",
        parserKey: parser.key,
        parserVersion: parser.version,
        parser,
        evidence,
        matchKeys,
        override: null,
      };
    }

    return {
      status: "quarantined",
      reason: matchKeys.length === 0 ? "zero_match" : "multiple_match",
      evidence,
      matchKeys,
    };
  }
}

export function selectParser(
  registry: ParserRegistry,
  source: PristineSource,
  override?: ReviewedParserOverride,
): ParserSelectionResult {
  return registry.selectParser(source, override);
}
