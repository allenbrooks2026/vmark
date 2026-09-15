/**
 * Serialized-markdown code ranges — where the post-stringify passes must not
 * rewrite text.
 *
 * Purpose: the cosmetic pass and the hard-break pass both edit the string
 * remark-stringify produced, and both must leave fenced code blocks and inline
 * code spans alone. This module answers "is this offset inside code?" for
 * them, from one sorted range list.
 *
 * Split out of `serializerCosmetics.ts` to keep it within its size budget.
 *
 * @coordinates-with serializerCosmetics.ts — skips escapes inside code
 * @coordinates-with serializer.ts — the hard-break pass
 * @module utils/markdownPipeline/serializerCodeRanges
 */

/**
 * Build sorted, merged character ranges for fenced code blocks and inline
 * code spans. Ranges are non-overlapping and sorted by start, enabling
 * O(log N) `isInsideCode` lookups during escape processing.
 */
export function buildCodeRanges(markdown: string): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  const fenceRe = /^(`{3,}|~{3,}).*\n([\s\S]*?\n)\1\s*$/gm;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(markdown))) {
    raw.push([fm.index, fm.index + fm[0].length]);
  }
  // Only treat unescaped backticks as code-span boundaries. Without this,
  // serialized plain text such as `[\`LICENSE\`]\(./LICENSE).` would falsely
  // register `\`LICENSE\`` as an inline code range, blocking later escape
  // stripping on the contained `\``.
  const inlineRe = /(?<!\\)`[^`]+?(?<!\\)`/g;
  let im: RegExpExecArray | null;
  while ((im = inlineRe.exec(markdown))) {
    raw.push([im.index, im.index + im[0].length]);
  }
  if (raw.length <= 1) return raw;
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    const [s, e] = raw[i];
    if (s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

/**
 * Binary-search a sorted, non-overlapping ranges array for whether `offset`
 * falls inside any range. O(log N) vs the previous O(N) `Array.some`.
 */
export function isInsideCodeRange(
  ranges: Array<[number, number]>,
  offset: number
): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (s <= offset) {
      if (offset < e) return true;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return false;
}

/** Apply a regex replacement only outside code blocks and inline code. */
export function replaceOutsideCode(
  markdown: string,
  re: RegExp,
  replacement: string,
  ranges: Array<[number, number]>
): string {
  return markdown.replace(re, (match, ...args) => {
    const offset = args[args.length - 2] as number;
    if (isInsideCodeRange(ranges, offset)) return match;
    return match.replace(re, replacement);
  });
}
