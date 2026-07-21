import type { CanonicalBlockData, DetectionEvidence, PristineSource, RegisteredParser } from "./contract.js";
import { STEAM_MAX_SOURCE_BYTES, STEAM_MAX_TOKENS } from "./steam-tokenizer.js";

export const STEAM_PLAINTEXT_PARSER_VERSION = "1.0.0";

const RECOGNIZED_BLOCK_TAG = /\[(?:\/?(?:p|list|h[1-6]|img|carousel|video|previewyoutube|table|tr|td)\b|\/?\*)[^\]]*\]/i;
const BULLET_LINE = /^\s*(?:[-\u2013\u2014\u2022]|\[\*\])\s+\S/m;
const BULLET_PREFIX = /^(?:[-\u2013\u2014\u2022]|\[\*\])\s+/;
const BRACKET_HEADER = /^\[\s*([^\]=/]+?)\s*\]$/;

function cleanSemanticText(value: string): string {
  return value
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|lt|gt|quot|apos|amp);/gi, (entity, decimal, hex) => {
      if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      switch (entity.toLowerCase()) {
        case "&lt;": return "<";
        case "&gt;": return ">";
        case "&quot;": return '"';
        case "&apos;": return "'";
        default: return "&";
      }
    })
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function sourceLines(body: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const newline = body.indexOf("\n", cursor);
    const nextCursor = newline === -1 ? body.length : newline + 1;
    let lineEnd = newline === -1 ? body.length : newline;
    if (lineEnd > cursor && body[lineEnd - 1] === "\r") lineEnd -= 1;
    lines.push({ text: body.slice(cursor, lineEnd), start: cursor, end: lineEnd });
    cursor = nextCursor;
  }
  return lines;
}

function trimmedLine(line: SourceLine): SourceLine | null {
  const leading = line.text.length - line.text.trimStart().length;
  const trailing = line.text.length - line.text.trimEnd().length;
  const start = line.start + leading;
  const end = line.end - trailing;
  if (end <= start) return null;
  return { text: line.text.slice(leading, line.text.length - trailing), start, end };
}

function headerLabel(value: string): string | null {
  const match = value.match(BRACKET_HEADER);
  if (match === null) return null;
  const label = cleanSemanticText(match[1]);
  if (/^(?:p|list|h[1-6]|img|carousel|video|previewyoutube|table|tr|td|\*)$/i.test(label)) {
    return null;
  }
  return label;
}

function detect(source: PristineSource): DetectionEvidence {
  if (Buffer.byteLength(source.pristineBody, "utf8") > STEAM_MAX_SOURCE_BYTES) {
    return {
      matched: false,
      codes: ["SOURCE_LIMIT_EXCEEDED"],
      spans: [{ start: 0, end: source.pristineBody.length }],
      details: { sourceTooLarge: true },
    };
  }
  const hasBlockTag = RECOGNIZED_BLOCK_TAG.test(source.pristineBody);
  const header = sourceLines(source.pristineBody)
    .map(trimmedLine)
    .find((line) => line !== null && headerLabel(line.text) !== null);
  const hasBullet = BULLET_LINE.test(source.pristineBody);
  const matched = !hasBlockTag && (header !== undefined || hasBullet);

  return {
    matched,
    codes: [
      hasBlockTag
        ? "RECOGNIZED_BLOCK_TAG"
        : matched
          ? "PLAIN_PATCH_STRUCTURE"
          : "NO_PLAIN_PATCH_STRUCTURE",
    ],
    spans: header === undefined || header === null ? [] : [{ start: header.start, end: header.end }],
    details: {
      hasRecognizedBlockTag: hasBlockTag,
      hasBracketHeader: header !== undefined,
      hasBullet,
    },
  };
}

function block(
  kind: CanonicalBlockData["kind"],
  parentIndex: number | null,
  text: string,
  line: SourceLine,
  sourceNodeType: string,
): CanonicalBlockData {
  return {
    kind,
    parentIndex,
    text,
    label: kind === "heading" ? text : null,
    sourceSpan: { start: line.start, end: line.end },
    sourceNodeType,
    diagnosticCode: null,
  };
}

function parse(source: PristineSource) {
  if (Buffer.byteLength(source.pristineBody, "utf8") > STEAM_MAX_SOURCE_BYTES) {
    return {
      status: "partial" as const,
      blocks: [{
        kind: "unsupported" as const,
        parentIndex: null,
        text: null,
        label: null,
        sourceSpan: { start: 0, end: source.pristineBody.length },
        sourceNodeType: "source_limit",
        diagnosticCode: "SOURCE_LIMIT_EXCEEDED",
      }],
      diagnostics: [{
        severity: "error" as const,
        code: "SOURCE_LIMIT_EXCEEDED",
        sourceSpan: { start: 0, end: source.pristineBody.length },
        details: {},
      }],
    };
  }
  const evidence = detect(source);
  if (!evidence.matched) {
    throw new Error("steam-patch-plaintext cannot parse a source its detector did not match");
  }

  const blocks: CanonicalBlockData[] = [];
  let bounded = false;
  let currentHeadingIndex: number | null = null;

  for (const rawLine of sourceLines(source.pristineBody)) {
    if (blocks.length >= STEAM_MAX_TOKENS) {
      bounded = true;
      break;
    }
    const line = trimmedLine(rawLine);
    if (line === null) continue;

    const heading = headerLabel(line.text);
    if (heading !== null) {
      blocks.push(block("heading", null, heading, line, "bracket_heading"));
      currentHeadingIndex = blocks.length - 1;
      continue;
    }

    if (BULLET_PREFIX.test(line.text)) {
      const prefix = line.text.match(BULLET_PREFIX)?.[0] ?? "";
      const text = cleanSemanticText(line.text.slice(prefix.length));
      if (text.length > 0) {
        blocks.push(block("patch_change", currentHeadingIndex, text, line, "plain_bullet"));
      }
      continue;
    }

    const text = cleanSemanticText(line.text);
    if (text.length > 0) blocks.push(block("paragraph", currentHeadingIndex, text, line, "plain_text"));
  }

  return {
    status: bounded ? "partial" as const : "complete" as const,
    blocks,
    diagnostics: bounded ? [{
      severity: "error" as const,
      code: "TOKEN_LIMIT_EXCEEDED",
      sourceSpan: null,
      details: {},
    }] : [],
  };
}

export const steamPatchPlaintextParser: RegisteredParser = {
  key: "steam-patch-plaintext",
  version: STEAM_PLAINTEXT_PARSER_VERSION,
  detect,
  parse,
};
