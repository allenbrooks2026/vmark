// @vitest-environment node
/**
 * Property: bold, italic and strikethrough survive a save, whatever sits beside
 * their delimiters.
 *
 * The soak's editing fuzz found three separate ways a delimiter was emitted
 * where micromark cannot read it back — merged `*` runs, a split surrogate
 * pair, and punctuation classified as ASCII-only — each one after the others
 * had been fixed by example. Examples pin a shape; this pins the class: runs of
 * marked text drawn from the characters that decide flanking (letters, CJK,
 * RTL, emoji, ASCII and full-width punctuation, spaces), in every mark
 * combination.
 *
 * Whitespace-only runs are excluded, and that is a statement about markdown,
 * not a convenience: `~~ ~~` has no spelling, so VMark moves whitespace out of
 * a strikethrough (markEdgeWhitespace.ts). Every run here carries at least one
 * non-space character; edge spaces are still generated.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "../adapter";

const schema = getProductionSchema();
const MARKS = ["bold", "italic", "strike"] as const;
const CHARS = ["a", "d", "é", "1", "中", "文", "ע", "🙂", "#", ".", "*", "。", "（", " "];

/** Same budget reasoning as roundtrip.property.test.ts: a liveness bound only. */
const PROPERTY_TEST_TIMEOUT_MS = 30_000;

const run = fc.record({
  text: fc
    .array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 3 })
    .map((chars) => chars.join(""))
    .filter((text) => text.trim() !== ""),
  marks: fc.subarray([...MARKS]),
});

type Run = { text: string; marks: readonly string[] };

/**
 * Text as runs of [text, marks], with edge spaces moved out of marked runs —
 * the one normalization markdown forces (a closer cannot follow a space).
 */
function canonicalRuns(doc: PMNode): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const push = (text: string, marks: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev[1] === marks) prev[0] += text;
    else out.push([text, marks]);
  };
  doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    const marks = node.marks.map((m) => m.type.name).sort().join("+");
    if (!marks) return push(node.text, "");
    const [, lead, core, trail] = /^( *)(.*?)( *)$/su.exec(node.text) ?? ["", "", node.text, ""];
    push(lead, "");
    push(core, marks);
    push(trail, "");
  });
  // Line-edge spaces are not representable either.
  if (out.length) {
    out[0][0] = out[0][0].replace(/^ +/, "");
    out[out.length - 1][0] = out[out.length - 1][0].replace(/ +$/, "");
  }
  return out.filter(([text]) => text !== "");
}

describe("attention delimiters — round-trip property", () => {
  it("preserves every bold/italic/strike run through serialize and parse", () => {
    fc.assert(
      fc.property(fc.array(run, { minLength: 1, maxLength: 5 }), (runs: Run[]) => {
        const doc = schema.node("doc", null, [
          schema.node(
            "paragraph",
            null,
            runs.map((r) => schema.text(r.text, r.marks.map((m) => schema.marks[m].create()))),
          ),
        ]);
        const markdown = serializeMarkdown(schema, doc);
        const back = parseMarkdown(schema, markdown);
        expect(canonicalRuns(back), `markdown: ${JSON.stringify(markdown)}`).toEqual(canonicalRuns(doc));
      }),
      { numRuns: 400, seed: 20260915 },
    );
  }, PROPERTY_TEST_TIMEOUT_MS);
});
