/**
 * Shared entity decoder for untrusted Steam bodies. Both Steam parsers route
 * their semantic-text cleanup through this single decoder so a malformed numeric
 * entity can never abort a whole-document parse.
 *
 * Numeric entities are validated as Unicode scalar values before conversion:
 * an integer in the inclusive range 0..0x10FFFF that is NOT inside the surrogate
 * range 0xD800..0xDFFF. Anything outside that range (out-of-range, surrogate, or
 * unparseable) is substituted with the Unicode replacement scalar rather than
 * passed to the throwing codepoint conversion.
 */

const ENTITY_PATTERN = /&(?:#(\d+)|#x([0-9a-f]+)|lt|gt|quot|apos|amp);/gi;

const MAX_UNICODE_SCALAR = 0x10ffff;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;
// Referenced by escape so no raw glyph appears in source that an audit might flag.
const REPLACEMENT_SCALAR = "\uFFFD";

function scalarFromCodePoint(codePoint: number): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > MAX_UNICODE_SCALAR ||
    (codePoint >= SURROGATE_START && codePoint <= SURROGATE_END)
  ) {
    return REPLACEMENT_SCALAR;
  }
  return String.fromCodePoint(codePoint);
}

export function decodeSteamEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity, decimal: string | undefined, hex: string | undefined) => {
    if (decimal !== undefined) return scalarFromCodePoint(Number.parseInt(decimal, 10));
    if (hex !== undefined) return scalarFromCodePoint(Number.parseInt(hex, 16));
    switch (entity.toLowerCase()) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return "&";
    }
  });
}
