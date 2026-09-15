/**
 * Split-surrogate repair for attention neighbour encoding.
 *
 * Purpose: undo the damage `mdast-util-to-markdown` does when it character-
 * references a delimiter's neighbour one UTF-16 code unit at a time.
 *
 * The `delete` handler that used to live here moved to serializerAttention.ts,
 * which owns all three attention delimiters.
 *
 * @coordinates-with serializer.ts — runs the repair on every serialization
 * @module utils/markdownPipeline/serializerStrikethrough
 */

/**
 * Repair numeric character references that split an astral character.
 *
 * `mdast-util-to-markdown` fixes a non-flanking delimiter by character-
 * referencing the neighbour, but it does so by UTF-16 CODE UNIT. When that
 * neighbour is an astral character — an emoji, most CJK extension-B
 * ideographs — it encodes only the leading HIGH SURROGATE and leaves the low
 * surrogate raw:
 *
 *     **word\***🙂word   →   **word\***&#xD83D;\uDE42word
 *
 * which reparses as U+FFFD followed by a lone low surrogate. The emoji is
 * destroyed. It is upstream, it predates VMark's `delete` handler — plain
 * `**bold**` ending in punctuation and followed by an emoji reproduces it with
 * no strikethrough anywhere — and it is real text corruption, not a cosmetic
 * artefact (audit 20260906, found by the editing fuzz).
 *
 * The repair is to finish the job the library started: re-encode the PAIR as
 * one reference for the actual code point. Decoding back to the raw character
 * would be wrong — the encoding is what makes the delimiter flank, so undoing
 * it would break the emphasis instead.
 *
 * BOTH directions occur. Which half gets encoded depends on which side of the
 * delimiter the astral character sits: encoding the neighbour AFTER a closer
 * takes its first code unit (the high surrogate), while encoding the neighbour
 * BEFORE an opener takes its last (the low surrogate).
 *
 * Applied unconditionally, and NOT in the cosmetic pass: that pass is skipped
 * above a size ceiling, and a correctness repair must not have one.
 */
export function repairSplitSurrogateEntities(markdown: string): string {
  if (!markdown.includes("&#x")) return markdown;

  /** One reference for the code point the pair encodes. */
  const joined = (high: number, low: number): string =>
    `&#x${(((high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000)
      .toString(16)
      .toUpperCase())};`;

  return (
    markdown
      // Encoded HIGH surrogate followed by a raw low one.
      .replace(
        /&#x(D[89ab][0-9a-f]{2});([\uDC00-\uDFFF])/gi,
        (whole, hex: string, low: string) => {
          const high = Number.parseInt(hex, 16);
          if (high < 0xd800 || high > 0xdbff) return whole;
          return joined(high, low.charCodeAt(0));
        },
      )
      // Raw HIGH surrogate followed by an encoded low one.
      .replace(
        /([\uD800-\uDBFF])&#x(D[c-f][0-9a-f]{2});/gi,
        (whole, high: string, hex: string) => {
          const low = Number.parseInt(hex, 16);
          if (low < 0xdc00 || low > 0xdfff) return whole;
          return joined(high.charCodeAt(0), low);
        },
      )
  );
}
