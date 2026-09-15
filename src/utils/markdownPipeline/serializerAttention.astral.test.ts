// @vitest-environment node
/**
 * An astral character beside an attention delimiter survives a save.
 *
 * A delimiter that would not flank is fixed by writing its neighbour as a
 * character reference. mdast-util-to-markdown did that one UTF-16 CODE UNIT at
 * a time, so an emoji came out as `&#xD83D;` plus a raw low surrogate — or, with
 * a delimiter on each side, as `&#xD83D;&#xDE42;` — and decoded to U+FFFD.
 *
 * VMark used to patch the string afterwards (`repairSplitSurrogateEntities`),
 * which saved the emoji but was too late for its neighbours: the delimiter
 * beside the pair had already decided it flanked a raw surrogate, a letter to
 * the parser, and after the repair it sat against `&`, which is punctuation.
 * The soak's editing fuzz lost an italic that way (#1407, seed 7). The encoding
 * now covers the whole code point at the moment it happens (the
 * mdast-util-to-markdown patch), so every flanking decision sees the final text.
 */
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "./adapter";

const schema = getProductionSchema();

type MarkName = "bold" | "italic" | "strike";
type Run = [text: string, marks: MarkName[]];

function roundTrip(runs: Run[]): { markdown: string; runs: Run[]; text: string } {
  const doc = schema.node("doc", null, [
    schema.node(
      "paragraph",
      null,
      runs.map(([text, marks]) => schema.text(text, marks.map((m) => schema.marks[m].create()))),
    ),
  ]);
  const markdown = serializeMarkdown(schema, doc);
  const reparsed: PMNode = parseMarkdown(schema, markdown);
  const out: Run[] = [];
  reparsed.descendants((node) => {
    if (!node.isText) return;
    const marks = node.marks.map((m) => m.type.name as MarkName).sort();
    const prev = out[out.length - 1];
    if (prev && prev[1].join() === marks.join()) prev[0] += node.text ?? "";
    else out.push([node.text ?? "", marks]);
  });
  return { markdown, runs: out, text: reparsed.textContent };
}

describe("astral characters beside an encoded delimiter", () => {
  // Seed 7: `wordword*&#x1F642;**#&#x20;***` — the italic opener had been
  // checked against the raw high surrogate, then the repair put `&` after it.
  it("keeps an italic that opens on an emoji followed by bold (seed 7)", () => {
    const runs: Run[] = [["wordword", []], ["🙂", ["italic"]], ["#", ["bold", "italic"]]];
    expect(roundTrip(runs).runs).toEqual(runs);
  });

  // A delimiter on EACH side of one emoji encoded each half separately.
  it.each<[string, Run[]]>([
    ["bold and strike", [[".", ["bold"]], ["🙂", []], [".", ["strike"]]]],
    ["bold and bold+italic", [["🙂", ["bold", "strike"]], ["🙂", []], ["d", ["bold", "italic", "strike"]]]],
  ])("keeps an emoji between two delimiters: %s", (_label, runs) => {
    const back = roundTrip(runs);
    expect(back.text).not.toContain("�");
    expect(back.runs).toEqual(runs.map(([t, m]) => [t, [...m].sort()]));
  });

  it.each<[MarkName, string]>([
    ["bold", "word*"],
    ["italic", "word*"],
    ["strike", "word*"],
  ])("preserves an emoji after a %s run ending in punctuation", (mark, marked) => {
    const back = roundTrip([[marked, [mark]], ["🙂word", []]]);
    expect(back.text).toBe("word*🙂word");
    expect(back.runs).toEqual([[marked, [mark]], ["🙂word", []]]);
  });

  it("writes the pair as one reference for the code point", () => {
    const { markdown } = roundTrip([["word*", ["bold"]], ["🙂word", []]]);
    expect(markdown).toContain("&#x1F642;");
    expect(markdown).not.toMatch(/&#xD[89A-F][0-9A-F]{2};/i);
  });

  // `_` letter/letter encodes the INSIDE character too — the handler's own
  // encoding, which must be code-point aware as well.
  it("keeps an emoji inside italic spelled `_` between letters", () => {
    const runs: Run[] = [["a", ["bold"]], ["🙂", ["italic"]], ["b", []]];
    const back = roundTrip(runs);
    expect(back.runs).toEqual(runs);
    expect(back.markdown).not.toMatch(/&#xD[89A-F][0-9A-F]{2};/i);
  });
});
