/**
 * The CS2 BBCode clean/split boundary.
 *
 * This is the deliberately swappable internal: a later era-aware rewrite may
 * replace the body of `parseCs2Body` entirely, but its caller signature and the
 * returned `{ header, lines }[]` shape are the stable contract and MUST NOT
 * change. It is CS2-ONLY on purpose — do not add CS:GO-era title patterns or
 * golden-file era tests here; that 14-year format-drift work belongs to the
 * later full-historical-ingestion effort, not this module.
 *
 * The raw bodies are untrusted external BBCode/HTML. The searchable text this
 * produces carries no markup and no image URLs — the SPA renders it as escaped
 * plain text, never raw HTML (the stored-content mitigation).
 */

/** One `[ HEADER ]` split within an update, in document order. */
export interface ParsedSection {
  /** The bracket header (e.g. "MAPS"), or null for a pre-header/untitled block. */
  header: string | null;
  /** Cleaned, non-empty note lines under this header, in document order. */
  lines: string[];
}

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
 * Clean a raw CS2 update body and split it into sections and lines.
 *
 * Steps, in document order:
 *  1. unescape backslash-escaped brackets (`\[ MAPS ]` → `[ MAPS ]`);
 *  2. strip images entirely — `[img …]…[/img]`, `{STEAM_CLAN_IMAGE}` tokens, and
 *     bare steamstatic URLs — so no image hash or URL reaches searchable text;
 *  3. turn paragraph/list/heading block tags into explicit line boundaries;
 *  4. split into fragments, detecting bare `[ HEADER ]` fragments as section
 *     boundaries;
 *  5. strip remaining inline BBCode tags to their inner text and decode entities;
 *  6. trim and drop empty lines.
 *
 * Deterministic: the same input always yields the same sections and lines in the
 * same order — the ordinal-derived IDs upstream depend on that.
 */
export function parseCs2Body(raw: string): ParsedSection[] {
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

    // Detect a bare bracket header BEFORE stripping inline tags. Real headers
    // look like "[ MAPS ]" / "[ MAP SCRIPTING ]" — never a closing tag and never
    // an inline BBCode tag (which carry '=' or '/').
    const headerMatch = trimmed.match(/^\[\s*(.+?)\s*\]$/);
    if (headerMatch && !/[=/]/.test(headerMatch[1])) {
      current = { header: headerMatch[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }

    // 5. strip remaining inline BBCode tags ([url=…]…[/url], [b], [i], …) to inner text
    let text = fragment.replace(/\[\/?[a-z][^\]]*\]/gi, "");
    text = decodeEntities(text).trim();

    // 6. drop empty lines
    if (text.length === 0) continue;
    ensureSection().lines.push(text);
  }

  // Drop any section that ended up with neither a header nor any lines.
  return sections.filter((sec) => sec.header !== null || sec.lines.length > 0);
}
