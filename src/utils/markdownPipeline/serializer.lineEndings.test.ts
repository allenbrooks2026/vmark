// @vitest-environment node
/**
 * A line ending in paragraph text that would start or end a blank line is
 * written as a character reference.
 *
 * The serializer wrote text line endings raw. A paragraph whose text begins or
 * ends with one therefore gained an empty line the parser drops, and two in a
 * row became a blank line that split the paragraph in two. Inside a list item
 * the empty first line also meant the item "started with a blank line", so a
 * nested list could no longer interrupt the paragraph above it and was read
 * back as that paragraph's text (the branch's cross-model audit, reproducing it
 * from `- b\n  1. &#10;x`). Such text only arrives through character
 * references, which is exactly why it must leave through them too.
 */
import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { getProductionSchema } from "@/test/productionSchema";
import { parseMarkdown, serializeMarkdown } from "./adapter";
import { serializeMdastToMarkdown } from "./serializer";

const schema = getProductionSchema();

const paragraphOf = (value: string): Root => ({
  type: "root",
  children: [{ type: "paragraph", children: [{ type: "text", value }] }],
});

/** Text content of the first paragraph after serializing and reparsing. */
function reparsedText(value: string): string {
  const markdown = serializeMdastToMarkdown(paragraphOf(value));
  return parseMarkdown(schema, markdown).textContent;
}

describe("line endings at the edges of paragraph text", () => {
  it.each([
    ["a leading LF", "\nx"],
    ["a leading CR", "\rx"],
    ["a trailing LF", "x\n"],
    ["a blank line inside", "a\n\nb"],
    ["a blank line with spaces", "a\n  \nb"],
    ["only an LF", "\n"],
  ])("keeps %s", (_label, value) => {
    expect(reparsedText(value)).toBe(value);
  });

  it("keeps the paragraph whole when its text holds a blank line", () => {
    const markdown = serializeMdastToMarkdown(paragraphOf("a\n\nb"));
    expect(parseMarkdown(schema, markdown).childCount).toBe(1);
  });

  // A single soft line break is ordinary markdown and stays raw.
  it.each(["a\nb", "a\r\nb"])("writes the single interior line break in %j raw", (value) => {
    expect(serializeMdastToMarkdown(paragraphOf(value))).toBe(`${value}\n`);
  });

  it("keeps a CRLF blank line", () => {
    expect(reparsedText("a\r\n\r\nb")).toBe("a\r\n\r\nb");
  });

  it("round-trips the audit's list source", () => {
    const doc = parseMarkdown(schema, "- b\n  1. &#10;x\n");
    const again = parseMarkdown(schema, serializeMarkdown(schema, doc));
    expect(again.toJSON()).toEqual(doc.toJSON());
  });
});
