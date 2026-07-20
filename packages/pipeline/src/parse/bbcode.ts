/**
 * The era-aware BBCode clean/split boundary.
 *
 * This is the deliberately swappable internal: the parser dispatches by
 * structural era (`cs2-richtext`, `csgo-crlf`, `csgo-lf`) but its returned
 * section/line contract is the stable boundary. The primary entrypoint is
 * `parseBody(raw, postedAt?)`; `parseCs2Body(raw)` is retained as a
 * backward-compatible alias so existing callers keep compiling.
 *
 * The raw bodies are untrusted external BBCode/HTML. The searchable text this
 * produces carries no markup and no image URLs — the SPA renders it as escaped
 * plain text, never raw HTML (the stored-content mitigation).
 *
 * Structure — not meaning — is preserved: parent→child nesting (a subheader and
 * its bullets) is recorded structurally on each line, but NO semantic entity
 * tagging happens here (that is a later classification pass).
 */

/**
 * One cleaned note line, carrying its structural nesting.
 *
 * `subheader` is the literal parent-node text (e.g. a map name) when this line
 * is a child of a nested list; `parentLineIndex` is the `line_index` of that
 * parent within the SAME section. Both are null for a top-level line.
 */
export interface ParsedLine {
  text: string;
  subheader: string | null;
  parentLineIndex: number | null;
}

/** One `[ HEADER ]` split within an update, in document order. */
export interface ParsedSection {
  /** The bracket header (e.g. "MAPS"), or null for a pre-header/untitled block. */
  header: string | null;
  /** Cleaned, non-empty note lines under this header, in document order. */
  lines: ParsedLine[];
}

/**
 * The three structural parser eras across 14 years of Steam format drift.
 * Dispatched by structural sniff first (see `detectEra`), never by date alone.
 */
export type Era = "cs2-richtext" | "csgo-crlf" | "csgo-lf";

/**
 * BBCode tag names that must NEVER be read as a `[ SECTION ]` header. A bare
 * `[list]` / `[*]` / `[p]` / `[url]` fragment is markup, not a Valve header.
 */
const BBCODE_TAG_NAME = /^(?:list|\*|p|url|img|b|i|u|s|strike|spoiler|quote|code|h[1-6]|olist|table|tr|td)$/i;

/** Decode the handful of HTML entities that appear in Steam note bodies. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Shared normalize-before-split prelude reused across all three eras:
 *  1. unescape backslash-escaped brackets (`\[ MAPS ]` → `[ MAPS ]`);
 *  2. strip images entirely — `[img …]…[/img]`, self-closing `[img …]`,
 *     `{STEAM_CLAN_IMAGE}` tokens, and bare steamstatic URLs — BEFORE any header
 *     detection, so no image hash or URL can reach searchable text;
 *  3. normalize CRLF → LF so both CS:GO line-ending eras share one splitter.
 */
function normalize(raw: string): string {
  let s = raw.replace(/\\(\[|\])/g, "$1");
  s = s.replace(/\[img\b[^\]]*\][\s\S]*?\[\/img\]/gi, "\n");
  s = s.replace(/\[img\b[^\]]*\]/gi, "\n");
  s = s.replace(/\{STEAM_CLAN_IMAGE\}\S*/gi, " ");
  s = s.replace(/https?:\/\/\S*steamstatic\S*/gi, " ");
  s = s.replace(/\r\n/g, "\n");
  return s;
}

/** True when `trimmed` is a bare `[ HEADER ]` and not an inline BBCode tag. */
function headerOf(trimmed: string): string | null {
  const m = trimmed.match(/^\[\s*(.+?)\s*\]$/);
  if (!m) return null;
  const inner = m[1].trim();
  // Real headers carry no '=' or '/', and are never a BBCode tag name.
  if (/[=/]/.test(inner)) return null;
  if (BBCODE_TAG_NAME.test(inner)) return null;
  return inner;
}

/**
 * Remove a single matched pair of leading + trailing inline formatting-only
 * tags (`[b]`/`[i]`/`[u]` and their closers) wrapping a fragment, so a
 * formatting-wrapped bare bracket header (`[b][ MAPS ][/b]`) can be re-detected
 * as a header. Only the outermost matched pair is stripped — this is header
 * detection, not a general un-nester, and it never touches block tags
 * (`[list]`/`[p]`/`[*]`) which are boundaries handled elsewhere.
 *
 * The regexes are anchored to the fragment ends with no nested unbounded
 * quantifiers, so they run in linear time and cannot be forced into
 * catastrophic backtracking by an adversarial body.
 */
function stripInlineWrappers(fragment: string): string {
  const open = /^\[(?:b|i|u)\]/i;
  const close = /\[\/(?:b|i|u)\]$/i;
  if (open.test(fragment) && close.test(fragment)) {
    return fragment.replace(open, "").replace(close, "").trim();
  }
  return fragment;
}

/** Strip remaining inline BBCode tags to their inner text, then decode entities. */
function cleanInline(fragment: string): string {
  const stripped = fragment.replace(/\[\/?[a-z][^\]]*\]/gi, "");
  return decodeEntities(stripped).trim();
}

/**
 * The plain-text eras (`csgo-crlf` / `csgo-lf`). After CRLF→LF normalization the
 * two are identical: bare `[ HEADER ]` lines split sections and each remaining
 * non-empty line is a bullet (its leading `-` / `–` / `•` / `[*]` glyph stripped).
 * These older formats are flat — every line is top-level (null nesting).
 */
function parsePlainText(normalized: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  const ensureSection = (): ParsedSection => {
    if (current === null) {
      current = { header: null, lines: [] };
      sections.push(current);
    }
    return current;
  };

  for (const fragment of normalized.split(/\n/)) {
    const trimmed = fragment.trim();
    if (trimmed.length === 0) continue;

    const header = headerOf(trimmed);
    if (header !== null) {
      current = { header, lines: [] };
      sections.push(current);
      continue;
    }

    // Strip a leading bullet glyph (hyphen, en/em dash, bullet, or [*]).
    const debulleted = trimmed.replace(/^(?:[-\u2013\u2014\u2022]|\[\*\])\s*/, "");
    const text = cleanInline(debulleted);
    if (text.length === 0) continue;
    ensureSection().lines.push({ text, subheader: null, parentLineIndex: null });
  }

  return sections.filter((sec) => sec.header !== null || sec.lines.length > 0);
}

/**
 * The `cs2-richtext` era: `[p]` paragraphs and `[list]`/`[*]` items, arbitrarily
 * nested. Block tags become boundaries; nesting is captured (not flattened):
 * when a line sits at list-depth `d`, its parent is the most recent line at
 * depth `d-1` within the same section — that parent's text becomes the child's
 * `subheader` and its index becomes `parentLineIndex`. Top-level lines
 * (no shallower line in the section) stay null.
 */
function parseRichText(normalized: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  // parentStack[d] = line_index (within `current`) of the most recent line at depth d.
  let parentStack: number[] = [];

  const startSection = (header: string | null): void => {
    current = { header, lines: [] };
    sections.push(current);
    parentStack = [];
  };
  const ensureSection = (): ParsedSection => {
    if (current === null) startSection(null);
    return current as ParsedSection;
  };

  let listDepth = 0;
  const tagRe = /\[(\/?)(list\b|p\b|h[1-6]\b|\*)[^\]]*\]/gi;

  const emitText = (chunk: string): void => {
    // A chunk of text sits between two block boundaries at the current listDepth.
    for (const piece of chunk.split(/\n/)) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;

      // Detect headers whose bare brackets are wrapped in inline formatting
      // (`[b][ MAPS ][/b]`) as well as unwrapped bare `[ MAPS ]` headers: strip
      // any outer formatting wrapper BEFORE header detection, then re-detect.
      const header = headerOf(stripInlineWrappers(trimmed));
      if (header !== null) {
        startSection(header);
        continue;
      }

      const text = cleanInline(trimmed);
      if (text.length === 0) continue;

      const section = ensureSection();
      const lineIndex = section.lines.length;
      let subheader: string | null = null;
      let parentLineIndex: number | null = null;
      if (listDepth >= 1 && parentStack[listDepth - 1] !== undefined) {
        parentLineIndex = parentStack[listDepth - 1];
        subheader = section.lines[parentLineIndex].text;
      }
      section.lines.push({ text, subheader, parentLineIndex });
      parentStack[listDepth] = lineIndex;
      parentStack.length = listDepth + 1; // drop any deeper stale parents
    }
  };

  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(normalized)) !== null) {
    emitText(normalized.slice(lastIndex, m.index));
    lastIndex = tagRe.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag.startsWith("list")) {
      listDepth = closing ? Math.max(0, listDepth - 1) : listDepth + 1;
    }
    // [p], [*], and [h1-6] are pure boundaries — their text is handled above.
  }
  emitText(normalized.slice(lastIndex));

  return sections.filter((sec) => sec.header !== null || sec.lines.length > 0);
}

/**
 * Choose the parser era for a raw body.
 *
 * Structural sniff FIRST (never trust the post date alone, per the era model):
 *  - any CS2 rich-text block tag (`[p]` / `[list]` / `[*]`) ⇒ `cs2-richtext`
 *  - otherwise CRLF line endings ⇒ `csgo-crlf`
 *  - otherwise ⇒ `csgo-lf`
 *
 * `postedAt` is an optional secondary tiebreaker only — it is never the sole
 * signal and does not override a decisive structural match.
 */
export function detectEra(raw: string, postedAt?: number): Era {
  if (/\[\/?(?:p|list)\b|\[\/?\*\]/i.test(raw)) return "cs2-richtext";
  if (raw.includes("\r\n")) return "csgo-crlf";
  // `postedAt` is reserved as a secondary tiebreaker; the structural sniff above
  // is decisive for the current corpus, so it does not change the outcome here.
  void postedAt;
  return "csgo-lf";
}

/**
 * The era-dispatching parse entrypoint. Cleans a raw update body and splits it
 * into sections and lines, preserving parent→child nesting.
 *
 * Deterministic: the same input always yields the same sections and lines in the
 * same order — the ordinal-derived IDs upstream depend on that.
 */
export function parseBody(raw: string, postedAt?: number): ParsedSection[] {
  const era = detectEra(raw, postedAt);
  const normalized = normalize(raw);
  return era === "cs2-richtext" ? parseRichText(normalized) : parsePlainText(normalized);
}

/**
 * Backward-compatible alias preserving the original CS2-only caller signature. Delegates
 * to {@link parseBody}; the returned `{ header, lines }[]` contract is unchanged
 * (lines now carry nullable nesting fields).
 */
export function parseCs2Body(raw: string): ParsedSection[] {
  return parseBody(raw);
}
