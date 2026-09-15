// @vitest-environment node
/**
 * Audit 20260906 — `~~` delimiters were emitted where GFM cannot parse them
 * back, turning the tildes into literal characters in the author's document.
 *
 * Found by the editing fuzz once the mark-edge whitespace normalization
 * stopped masking it. The failing shape is the one GFM's flanking rules
 * forbid: an opening run followed by punctuation while preceded by an
 * alphanumeric (and its mirror image at the closer).
 *
 * The handler lives in serializerAttention.ts; astral neighbours are covered by
 * serializerAttention.astral.test.ts.
 */
import { describe, expect, it } from "vitest";
import { getProductionSchema } from "@/test/productionSchema";
import { serializeMarkdown, parseMarkdown } from "./adapter";

const schema = getProductionSchema();

/** Build a paragraph of [plain?, struck, plain?] and round-trip it. */
function roundTrip(pre: string, marked: string, post: string) {
  const strike = schema.marks.strike.create();
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [
      ...(pre ? [schema.text(pre)] : []),
      schema.text(marked, [strike]),
      ...(post ? [schema.text(post)] : []),
    ]),
  ]);
  const markdown = serializeMarkdown(schema, doc);
  const reparsed = parseMarkdown(schema, markdown);
  return {
    markdown,
    text: reparsed.textContent,
    restruck: serializeMarkdown(schema, reparsed),
  };
}

/** Whether the reparsed doc still carries a strike mark over `marked`. */
function hasStrike(pre: string, marked: string, post: string): boolean {
  const strike = schema.marks.strike.create();
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [
      ...(pre ? [schema.text(pre)] : []),
      schema.text(marked, [strike]),
      ...(post ? [schema.text(post)] : []),
    ]),
  ]);
  const reparsed = parseMarkdown(schema, serializeMarkdown(schema, doc));
  let found = false;
  reparsed.descendants((node) => {
    if (node.isText && node.marks.some((m) => m.type.name === "strike")) found = true;
  });
  return found;
}

describe("strikethrough delimiter flanking", () => {
  // The reported defect. `plain~~* word~~tail` reparses with NO strike mark
  // and four literal tildes the author never typed.
  it("does not inject literal tildes when the content starts with punctuation", () => {
    const { markdown, text, restruck } = roundTrip("plain", "* word", "tail");

    expect(text).toBe("plain* wordtail");
    expect(text).not.toContain("~");
    expect(restruck).toBe(markdown);
  });

  it("does not inject literal tildes when the content ends with punctuation", () => {
    const { markdown, text, restruck } = roundTrip("plain", "word*", "tail");

    expect(text).toBe("plainword*tail");
    expect(text).not.toContain("~");
    expect(restruck).toBe(markdown);
  });

  it("keeps the mark alive across the round-trip", () => {
    expect(hasStrike("plain", "* word", "tail")).toBe(true);
    expect(hasStrike("plain", "word*", "tail")).toBe(true);
  });

  // The remedy is remark's own: character-reference the neighbour so it counts
  // as punctuation. It decodes back to the identical character, so nothing
  // about which text carries the mark changes.
  it("character-references the neighbour rather than moving the mark boundary", () => {
    expect(roundTrip("plain", "* word", "tail").markdown).toContain("&#x6E;");
  });

  it.each([
    ["punctuation both ends", "plain", "*word*", "tail"],
    ["whitespace before", "plain ", "* word", "tail"],
    ["whitespace after", "plain", "word*", " tail"],
    ["no punctuation at all", "plain", "more", "tail"],
    ["start of line", "", "* word", "tail"],
    ["end of line", "plain", "word*", ""],
    ["CJK neighbours", "文字", "* word", "文字"],
    ["marked run is only punctuation", "plain", "***", "tail"],
  ])("round-trips: %s", (_label, pre, marked, post) => {
    const { markdown, text, restruck } = roundTrip(pre, marked, post);

    expect(text).toBe(pre + marked + post);
    expect(restruck).toBe(markdown);
  });

  // A neighbour that already flanks must not be encoded — the fix has to be
  // conditional, or every strikethrough in the corpus grows entities.
  it("leaves an already-valid neighbour untouched", () => {
    expect(roundTrip("plain ", "* word", "tail").markdown).toBe("plain ~~* word~~tail\n");
    expect(roundTrip("plain", "more", "tail").markdown).toBe("plain~~more~~tail\n");
  });
});

