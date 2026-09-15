// @vitest-environment node
/**
 * Attention delimiters (`*`, `**`, `~~`) must come back as the marks they were.
 *
 * Found by the weekly soak's editing fuzz (#1407) once its seed stopped being
 * silently 0: italic typed next to bold was saved as a merged `***` run that no
 * longer flanked, and the italic came back as literal asterisks in the author's
 * text. The traces below are the fuzz's own minimized counterexamples, reduced
 * to the document they produce.
 */
import { describe, expect, it } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "./adapter";

const schema = getProductionSchema();

type MarkName = "bold" | "italic" | "strike";
type Run = [text: string, marks: MarkName[]];

/** A one-paragraph document from `[text, marks]` runs. */
function paragraph(runs: Run[]): PMNode {
  return schema.node("doc", null, [
    schema.node(
      "paragraph",
      null,
      runs.map(([text, marks]) => schema.text(text, marks.map((m) => schema.marks[m].create()))),
    ),
  ]);
}

/** The document's text as `[text, sorted marks]` runs, adjacent equal runs merged. */
function runsOf(doc: PMNode): Run[] {
  const out: Run[] = [];
  doc.descendants((node) => {
    if (!node.isText) return;
    const marks = node.marks.map((m) => m.type.name as MarkName).sort();
    const prev = out[out.length - 1];
    if (prev && prev[1].join() === marks.join()) prev[0] += node.text ?? "";
    else out.push([node.text ?? "", marks]);
  });
  return out;
}

function roundTrip(runs: Run[]): { markdown: string; runs: Run[] } {
  const markdown = serializeMarkdown(schema, paragraph(runs));
  return { markdown, runs: runsOf(parseMarkdown(schema, markdown)) };
}

const sorted = (runs: Run[]): Run[] => runs.map(([t, m]) => [t, [...m].sort()]);

describe("emphasis beside strong", () => {
  // Seed 20260805: `wordwor**wordword***#&#x20;*` — the italic merged into the
  // bold's closing run, which cannot open before `#`, so it was lost.
  it("keeps italic that directly follows bold (seed 20260805)", () => {
    const runs: Run[] = [["wordwor", []], ["wordword", ["bold"]], ["# ", ["italic"]]];
    expect(roundTrip(runs).runs).toEqual(runs);
  });

  // Seed 5: `**עברית&#x20;***word*` — the merged run could not close the bold.
  it("keeps bold that directly precedes italic (seed 5)", () => {
    const runs: Run[] = [["עברית ", []], ["עברית ", ["bold"]], ["word", ["italic"]]];
    expect(roundTrip(runs).runs).toEqual(runs);
  });

  // Seed 6: `***wordb**&#x20;***b** word` — the italic's closer merged into the
  // next bold's opener.
  it("keeps italic that directly precedes bold (seed 6)", () => {
    const runs: Run[] = [
      ["wordb", ["bold", "italic"]],
      [" ", ["italic"]],
      ["b", ["bold"]],
      [" word", []],
    ];
    expect(roundTrip(runs).runs).toEqual(sorted(runs));
  });

  it.each<[string, Run[]]>([
    ["letters on the far side", [["a", ["bold"]], ["b", ["italic"]], ["c", []]]],
    ["CJK on the far side", [["中文", []], ["粗体", ["bold"]], ["斜体", ["italic"]], ["中文", []]]],
    ["punctuation inside", [["x", []], ["#", ["bold"]], [".", ["italic"]], ["y", []]]],
    ["an emoji as the italic", [["a", ["bold"]], ["🙂", ["italic"]], ["b", []]]],
    ["italic, bold, italic", [["a", ["italic"]], ["b", ["bold"]], ["c", ["italic"]]]],
  ])("round-trips with %s", (_label, runs) => {
    const back = roundTrip(runs);
    expect(back.runs).toEqual(runs);
    expect(back.markdown).not.toContain("�");
  });

  // The alternate marker is a fix for one adjacency, not a new house style.
  it("keeps `*` wherever it already round-trips", () => {
    expect(roundTrip([["a ", []], ["b", ["italic"]], [" c", []]]).markdown).toBe("a *b* c\n");
    expect(roundTrip([["x", ["bold", "italic"]]]).markdown).toBe("***x***\n");
    expect(roundTrip([["a", ["bold"]], [" ", []], ["b", ["italic"]]]).markdown).toBe("**a** *b*\n");
  });

  it("spells italic beside bold with `_`, which cannot merge into `**`", () => {
    expect(roundTrip([["a", ["bold"]], ["b", ["italic"]]]).markdown).toBe("**a**_b_\n");
  });
});

describe("strikethrough beside non-ASCII punctuation", () => {
  // `文字~~。word~~` reparsed as literal tildes: the delimiter test counted only
  // ASCII punctuation, while micromark counts every Unicode P and S character.
  it.each<[string, Run[]]>([
    ["full stop opening the run", [["文字", []], ["。word", ["strike"]]]],
    ["full stop closing the run", [["word。", ["strike"]], ["文字", []]]],
    ["full-width parenthesis", [["文字", []], ["（注）", ["strike"]], ["文字", []]]],
  ])("keeps the strike with a %s", (_label, runs) => {
    expect(roundTrip(runs).runs).toEqual(runs);
  });
});
