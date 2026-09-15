// @vitest-environment node
/**
 * A list that cannot interrupt a paragraph is separated from it by a blank line.
 *
 * CommonMark §5.2: when the first item of a list would start on a line that
 * could continue a paragraph, it may interrupt that paragraph only if it does
 * not start with a blank line and, if ordered, starts at 1. Inside a tight list
 * item a nested list is joined to the paragraph above it with NO blank line, so
 * an empty first item — `1. **b**\n   1.` — or a `3.` start was read back as
 * paragraph text. The soak's editing fuzz found it as an empty nested ordered
 * item turning into the characters "1." (#1407, seed 3).
 *
 * Bullets are in the same rule. micromark happens to accept `- b\n  -`, but a
 * CommonMark parser reads that `-` as a setext underline and the item becomes a
 * heading, so the file was only readable by VMark.
 */
import { describe, expect, it } from "vitest";
import type { List, ListItem, Paragraph, Root } from "mdast";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { serializeMdastToMarkdown } from "./serializer";

const schema = getProductionSchema();
const { nodes, marks } = schema;

const p = (text?: string) =>
  nodes.paragraph.create(null, text ? [schema.text(text)] : []);
const li = (...content: ReturnType<typeof p>[]) => nodes.listItem.create(null, content);

/** Round-trip a document and return [markdown, reparsed JSON, original JSON]. */
function roundTrip(doc: ReturnType<typeof nodes.doc.create>) {
  const markdown = serializeMarkdown(schema, doc);
  const strip = (json: unknown): unknown =>
    JSON.parse(
      JSON.stringify(json, (key, value: unknown) =>
        key === "sourceLine" || key === "blankLinesBefore" ? undefined : value,
      ),
    );
  return {
    markdown,
    back: strip(parseMarkdown(schema, markdown).toJSON()),
    want: strip(doc.toJSON()),
  };
}

describe("nested list after a paragraph in a list item", () => {
  // Seed 3, reduced: an empty nested ordered item under "**b**".
  it("keeps an empty nested ordered item (seed 3)", () => {
    const nested = nodes.orderedList.create({ start: 1 }, [li(p())]);
    const bold = nodes.paragraph.create(null, [schema.text("b", [marks.bold.create()])]);
    const doc = nodes.doc.create(null, [
      nodes.orderedList.create({ start: 1 }, [nodes.listItem.create(null, [bold, nested])]),
    ]);
    const { markdown, back, want } = roundTrip(doc);
    expect(back).toEqual(want);
    expect(markdown).toBe("1. **b**\n\n   1.\n");
  });

  it("separates an empty nested bullet item so CommonMark does not read a heading", () => {
    const doc = nodes.doc.create(null, [
      nodes.bulletList.create(null, [li(p("b"), nodes.bulletList.create(null, [li(p())]))]),
    ]);
    const { markdown, back, want } = roundTrip(doc);
    expect(back).toEqual(want);
    expect(markdown).toBe("- b\n\n  -\n");
  });

  it.each([0, 3])("keeps a nested ordered list that starts at %i", (start) => {
    const doc = nodes.doc.create(null, [
      nodes.bulletList.create(null, [li(p("b"), nodes.orderedList.create({ start }, [li(p("c"))]))]),
    ]);
    const { markdown, back, want } = roundTrip(doc);
    expect(back).toEqual(want);
    expect(markdown).toBe(`- b\n\n  ${start}. c\n`);
  });

  // An item whose text begins with a line ending also starts with a blank
  // line: the serializer writes the character raw, so the marker line is
  // empty. Found by the branch's cross-model audit.
  it.each(["&#10;x", "&#13;x", "&#10;"])("keeps a nested item whose text starts with %s", (content) => {
    const source = `- b\n  1. ${content}\n`;
    const doc = parseMarkdown(schema, source);
    const { back, want } = roundTrip(doc);
    expect(back).toEqual(want);
  });

  // The rule is narrow on purpose: a list that CAN interrupt keeps the tight
  // spelling authors wrote, so no existing document gains blank lines.
  it("leaves a list that can interrupt the paragraph tight", () => {
    const doc = nodes.doc.create(null, [
      nodes.bulletList.create(null, [
        li(p("b"), nodes.orderedList.create({ start: 1 }, [li(p("c")), li(p())])),
      ]),
    ]);
    expect(roundTrip(doc).markdown).toBe("- b\n  1. c\n  2.\n");
  });

  // An empty paragraph writes no text, so there is nothing to interrupt.
  it("does not add a blank line after an empty paragraph", () => {
    const doc = nodes.doc.create(null, [
      nodes.bulletList.create(null, [li(p(), nodes.bulletList.create(null, [li(p()), li(p("x"))]))]),
    ]);
    expect(roundTrip(doc).markdown).toBe("-\n  -\n  - x\n");
  });
});

describe("captured blank lines before a list that cannot interrupt", () => {
  const paragraph: Paragraph = { type: "paragraph", children: [{ type: "text", value: "b" }] };
  const emptyItemList = (blankLinesBefore?: number): List => ({
    type: "list",
    ordered: false,
    spread: false,
    children: [{ type: "listItem", spread: false, children: [{ type: "paragraph", children: [] }] } satisfies ListItem],
    ...(blankLinesBefore === undefined ? {} : { data: { blankLinesBefore } }),
  });
  const serialize = (list: List) =>
    serializeMdastToMarkdown({ type: "root", children: [paragraph, list] } satisfies Root);

  // preserveBlankLines can capture 0 from a source where the list DID
  // interrupt, and an edit can then empty its first item.
  it("raises a captured 0 to the one blank line the list needs", () => {
    expect(serialize(emptyItemList(0))).toBe("b\n\n-\n");
  });

  it("keeps a captured run longer than one", () => {
    expect(serialize(emptyItemList(2))).toBe("b\n\n\n-\n");
  });
});
