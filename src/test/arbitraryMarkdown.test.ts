// @vitest-environment node
/**
 * #1407 — the sweep-side classification of the nesting refusal.
 *
 * The OSS-Fuzz soak died on a corpus file nested 16382 levels deep because it
 * treated the pipeline's designed refusal as a crash. The helper under test is
 * the one place a sweep decides which is which, so both halves are pinned:
 * a refusal comes back as data, and every other failure still throws.
 *
 * @coordinates-with arbitraryMarkdown.ts
 * @module test/arbitraryMarkdown.test
 */
import { describe, it, expect } from "vitest";
import type { Schema } from "@tiptap/pm/model";
import { parseArbitraryMarkdown } from "./arbitraryMarkdown";
import { MAX_NESTING_DEPTH } from "@/utils/markdownPipeline/nestingDepth";
import { testSchema } from "@/utils/markdownPipeline/testSchema";

describe("parseArbitraryMarkdown", () => {
  it("returns the document for ordinary markdown", () => {
    const outcome = parseArbitraryMarkdown(testSchema, "# Title\n\nbody 中文\n");
    expect(outcome.kind).toBe("parsed");
    expect(outcome.kind === "parsed" && outcome.doc.childCount).toBe(2);
  });

  it("returns an empty document for empty input", () => {
    const outcome = parseArbitraryMarkdown(testSchema, "");
    expect(outcome.kind).toBe("parsed");
  });

  it.each([
    ["blockquotes", `${"> ".repeat(MAX_NESTING_DEPTH + 1)}a\n`, MAX_NESTING_DEPTH + 1],
    ["lists", Array.from({ length: MAX_NESTING_DEPTH + 5 }, (_, i) => `${"  ".repeat(i)}- a`).join("\n"), MAX_NESTING_DEPTH + 5],
  ])("returns a refusal, with its numbers, for too-deep %s", (_shape, markdown, depth) => {
    expect(parseArbitraryMarkdown(testSchema, markdown)).toEqual({
      kind: "refused",
      refusal: { depth, limit: MAX_NESTING_DEPTH },
    });
  });

  it("parses a document exactly at the limit", () => {
    const outcome = parseArbitraryMarkdown(testSchema, `${"> ".repeat(MAX_NESTING_DEPTH)}a\n`);
    expect(outcome.kind).toBe("parsed");
  });

  it("rethrows every other failure", () => {
    const exploding = new Proxy({} as Schema, {
      get() {
        throw new Error("schema exploded");
      },
    });
    expect(() => parseArbitraryMarkdown(exploding, "a paragraph\n")).toThrow(/schema exploded/);
  });
});
