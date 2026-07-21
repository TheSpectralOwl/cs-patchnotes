import type { CanonicalBlockData, DetectionEvidence, PristineSource, RegisteredParser } from "./contract.js";

export const STEAM_PLAINTEXT_PARSER_VERSION = "1.0.0";

const RECOGNIZED_BLOCK_TAG = /\[(?:\/?(?:p|list|h[1-6]|img|carousel|video|previewyoutube|table|tr|td)\b|\/?\*)[^\]]*\]/i;
const BULLET_LINE = /^\s*(?:[-\u2013\u2014\u2022]|\[\*\])\s+\S/m;
const BULLET_PREFIX = /^(?:[-\u2013\u2014\u2022]|\[\*\])\s+/;
const BRACKET_HEADER = /^\[\s*([^\]=/]+?)\s*\]$/;

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
  const label = match[1].trim();
  if (/^(?:p|list|h[1-6]|img|carousel|video|previewyoutube|table|tr|td|\*)$/i.test(label)) {
    return null;
  }
  return label;
}

function detect(source: PristineSource): DetectionEvidence {
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
  const evidence = detect(source);
  if (!evidence.matched) {
    throw new Error("steam-patch-plaintext cannot parse a source its detector did not match");
  }

  const blocks: CanonicalBlockData[] = [];
  let currentHeadingIndex: number | null = null;

  for (const rawLine of sourceLines(source.pristineBody)) {
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
      const text = line.text.slice(prefix.length).trim();
      if (text.length > 0) {
        blocks.push(block("patch_change", currentHeadingIndex, text, line, "plain_bullet"));
      }
      continue;
    }

    blocks.push(block("paragraph", currentHeadingIndex, line.text, line, "plain_text"));
  }

  return { status: "complete" as const, blocks, diagnostics: [] };
}

export const steamPatchPlaintextParser: RegisteredParser = {
  key: "steam-patch-plaintext",
  version: STEAM_PLAINTEXT_PARSER_VERSION,
  detect,
  parse,
};
