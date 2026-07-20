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
  // NOTE: era-specific dispatch + nesting preservation is implemented in the
  // next task. This provisional body ports the CS2 clean/split so the contract
  // compiles and the existing callers/tests stay green.
  void detectEra(raw, postedAt);

  // 1. unescape backslash-escaped brackets
  let s = raw.replace(/\\(\[|\])/g, "$1");

  // 2. strip images entirely (both [img]URL[/img] and [img src="{STEAM_CLAN_IMAGE}/…png"][/img])
  s = s.replace(/\[img\b[^\]]*\][\s\S]*?\[\/img\]/gi, "\n");
  s = s.replace(/\{STEAM_CLAN_IMAGE\}\S*/gi, " ");
  s = s.replace(/https?:\/\/\S*steamstatic\S*/gi, " ");

  // 3. convert block-level tags into newline boundaries
  s = s.replace(/\[\/?(?:p|list|h[1-6])\b[^\]]*\]/gi, "\n");
  s = s.replace(/\[\/?\*\]/g, "\n"); // [*] and [/*]

  // 4. split into raw fragments (covers the original \n in older bodies too)
  const fragments = s.split(/\r?\n/);

  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  const ensureSection = (): ParsedSection => {
    if (current === null) {
      current = { header: null, lines: [] };
      sections.push(current);
    }
    return current;
  };

  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (trimmed.length === 0) continue;

    const headerMatch = trimmed.match(/^\[\s*(.+?)\s*\]$/);
    if (headerMatch && !/[=/]/.test(headerMatch[1])) {
      current = { header: headerMatch[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }

    let text = fragment.replace(/\[\/?[a-z][^\]]*\]/gi, "");
    text = decodeEntities(text).trim();

    if (text.length === 0) continue;
    ensureSection().lines.push({ text, subheader: null, parentLineIndex: null });
  }

  return sections.filter((sec) => sec.header !== null || sec.lines.length > 0);
}

/**
 * Backward-compatible alias preserving the Phase 1 caller signature. Delegates
 * to {@link parseBody}; the returned `{ header, lines }[]` contract is unchanged
 * (lines now carry nullable nesting fields).
 */
export function parseCs2Body(raw: string): ParsedSection[] {
  return parseBody(raw);
}
