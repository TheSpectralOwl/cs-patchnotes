import type { ParseDiagnostic, SourceSpan } from "./contract.js";

/** Hard parser-work limits for untrusted Steam source bodies. */
export const STEAM_MAX_SOURCE_BYTES = 1_048_576;
export const STEAM_MAX_TOKENS = 20_000;
export const STEAM_MAX_NESTING_DEPTH = 64;
export const STEAM_MAX_DIAGNOSTICS = 64;

const PLACEHOLDER = "{STEAM_CLAN_IMAGE}";
const RECOGNIZED_TAGS = new Set([
  "p",
  "list",
  "*",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "url",
  "img",
  "carousel",
  "b",
  "i",
  "u",
  "s",
  "strike",
  "code",
]);
const VOID_TAGS = new Set<string>();

interface BaseSteamToken {
  sourceSpan: SourceSpan;
}

export interface SteamTextToken extends BaseSteamToken {
  type: "text";
  value: string;
}

export interface SteamPlaceholderToken extends BaseSteamToken {
  type: "placeholder";
  name: "STEAM_CLAN_IMAGE";
}

export interface SteamTagToken extends BaseSteamToken {
  type: "tag";
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
}

export interface SteamUnknownToken extends BaseSteamToken {
  type: "unknown";
  name: string;
  closing: boolean;
}

export type SteamToken =
  | SteamTextToken
  | SteamPlaceholderToken
  | SteamTagToken
  | SteamUnknownToken;

export interface SteamTokenizeResult {
  status: "complete" | "partial" | "quarantined";
  tokens: SteamToken[];
  diagnostics: ParseDiagnostic[];
  consumedEnd: number;
}

function diagnostic(code: string, sourceSpan: SourceSpan | null): ParseDiagnostic {
  return { severity: "error", code, sourceSpan, details: {} };
}

function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
    if (cursor >= input.length) break;

    const keyStart = cursor;
    while (cursor < input.length && /[a-zA-Z0-9_-]/.test(input[cursor])) cursor += 1;
    if (cursor === keyStart) {
      cursor += 1;
      continue;
    }
    const key = input.slice(keyStart, cursor).toLowerCase();
    while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
    if (input[cursor] !== "=") {
      attributes[key] = "";
      continue;
    }

    cursor += 1;
    while (cursor < input.length && /\s/.test(input[cursor])) cursor += 1;
    const quote = input[cursor] === '"' || input[cursor] === "'" ? input[cursor++] : null;
    const valueStart = cursor;
    if (quote !== null) {
      while (cursor < input.length && input[cursor] !== quote) cursor += 1;
      attributes[key] = input.slice(valueStart, cursor);
      if (cursor < input.length) cursor += 1;
    } else {
      while (cursor < input.length && !/\s/.test(input[cursor])) cursor += 1;
      attributes[key] = input.slice(valueStart, cursor);
    }
  }

  return attributes;
}

function tagParts(raw: string): {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
} | null {
  if (raw.includes("[")) return null;
  let inner = raw.trim();
  const closing = inner.startsWith("/");
  if (closing) inner = inner.slice(1).trimStart();
  const selfClosing = !closing && /\s\/$/.test(inner);
  if (selfClosing) inner = inner.slice(0, -1).trimEnd();

  const nameMatch = inner.match(/^(\*|[a-zA-Z][a-zA-Z0-9]*)/);
  if (nameMatch === null) return null;
  const name = nameMatch[1].toLowerCase();
  let rest = inner.slice(nameMatch[0].length);
  if (rest.startsWith("=")) rest = `value${rest}`;
  return {
    name,
    closing,
    selfClosing: selfClosing || VOID_TAGS.has(name),
    attributes: closing ? {} : parseAttributes(rest),
  };
}

function looksLikeBracketHeading(
  inside: string,
  source: string,
  start: number,
  end: number,
): boolean {
  if (/[a-z][a-z0-9_-]*\s*=/i.test(inside)) return false;
  const trimmed = inside.trim();
  if (RECOGNIZED_TAGS.has(trimmed.toLowerCase())) return false;
  if (/^\s+[^\]=/]+?\s+$/.test(inside)) return true;
  const startsLine = start === 0 || source[start - 1] === "\n" || source[start - 1] === "\r";
  const endsLine = end === source.length || source[end] === "\n" || source[end] === "\r";
  return startsLine && endsLine && /^[a-z][a-z0-9 _-]*$/i.test(trimmed);
}

/**
 * Scans the closed Steam BBCode dialect once and retains half-open UTF-16 spans.
 * It emits data only: no HTML rendering, locator fetches, or source mutation.
 */
export function tokenizeSteamBbcode(raw: string): SteamTokenizeResult {
  if (Buffer.byteLength(raw, "utf8") > STEAM_MAX_SOURCE_BYTES) {
    return {
      status: "quarantined",
      tokens: [],
      diagnostics: [diagnostic("SOURCE_LIMIT_EXCEEDED", { start: 0, end: raw.length })],
      consumedEnd: 0,
    };
  }

  const tokens: SteamToken[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let cursor = 0;
  const openTags: string[] = [];
  let status: SteamTokenizeResult["status"] = "complete";

  const addDiagnostic = (code: string, sourceSpan: SourceSpan | null): void => {
    status = "partial";
    if (diagnostics.length < STEAM_MAX_DIAGNOSTICS) diagnostics.push(diagnostic(code, sourceSpan));
  };

  const push = (token: SteamToken): boolean => {
    if (tokens.length >= STEAM_MAX_TOKENS) {
      addDiagnostic("TOKEN_LIMIT_EXCEEDED", { start: cursor, end: raw.length });
      return false;
    }
    tokens.push(token);
    return true;
  };

  while (cursor < raw.length) {
    if (tokens.length >= STEAM_MAX_TOKENS) {
      addDiagnostic("TOKEN_LIMIT_EXCEEDED", { start: cursor, end: raw.length });
      break;
    }

    if (raw.startsWith(PLACEHOLDER, cursor)) {
      const end = cursor + PLACEHOLDER.length;
      if (!push({
        type: "placeholder",
        name: "STEAM_CLAN_IMAGE",
        sourceSpan: { start: cursor, end },
      })) break;
      cursor = end;
      continue;
    }

    if (raw[cursor] === "[") {
      if (cursor > 0 && raw[cursor - 1] === "\\") {
        if (!push({ type: "text", value: "[", sourceSpan: { start: cursor, end: cursor + 1 } })) break;
        cursor += 1;
        continue;
      }
      const close = raw.indexOf("]", cursor + 1);
      if (close === -1) {
        push({
          type: "unknown",
          name: "malformed",
          closing: false,
          sourceSpan: { start: cursor, end: raw.length },
        });
        addDiagnostic("MALFORMED_TAG", { start: cursor, end: raw.length });
        cursor = raw.length;
        break;
      }

      const inside = raw.slice(cursor + 1, close);
      const end = close + 1;
      if (looksLikeBracketHeading(inside, raw, cursor, end)) {
        if (!push({ type: "text", value: raw.slice(cursor, end), sourceSpan: { start: cursor, end } })) break;
        cursor = end;
        continue;
      }
      if (/^[A-Z0-9]{1,2}$/.test(inside)) {
        if (!push({ type: "text", value: raw.slice(cursor, end), sourceSpan: { start: cursor, end } })) break;
        cursor = end;
        continue;
      }

      const parts = tagParts(inside);
      if (parts !== null && RECOGNIZED_TAGS.has(parts.name)) {
        if (!parts.closing && !parts.selfClosing) {
          if (parts.name === "*") {
            const openItem = openTags.lastIndexOf("*");
            const openList = openTags.lastIndexOf("list");
            if (openItem > openList) openTags.length = openItem;
          }
          openTags.push(parts.name);
          if (openTags.length > STEAM_MAX_NESTING_DEPTH) {
            addDiagnostic("NESTING_LIMIT_EXCEEDED", { start: cursor, end });
            break;
          }
        } else if (parts.closing) {
          const matchingOpen = openTags.lastIndexOf(parts.name);
          if (matchingOpen >= 0) openTags.length = matchingOpen;
        }
        if (!push({ type: "tag", ...parts, sourceSpan: { start: cursor, end } })) break;
      } else {
        const fallbackName = parts?.name ?? inside.replace(/^\s*\/?/, "").match(/^[^\s=/\]]+/)?.[0]?.toLowerCase() ?? "malformed";
        if (!push({
          type: "unknown",
          name: fallbackName.slice(0, 64),
          closing: parts?.closing ?? /^\s*\//.test(inside),
          sourceSpan: { start: cursor, end },
        })) break;
      }
      cursor = end;
      continue;
    }

    const nextTag = raw.indexOf("[", cursor);
    const nextPlaceholder = raw.indexOf(PLACEHOLDER, cursor);
    const candidates = [nextTag, nextPlaceholder].filter((position) => position >= 0);
    const end = candidates.length === 0 ? raw.length : Math.min(...candidates);
    if (!push({ type: "text", value: raw.slice(cursor, end), sourceSpan: { start: cursor, end } })) break;
    cursor = end;
  }

  return { status, tokens, diagnostics, consumedEnd: cursor };
}
