// @vitest-environment node
/**
 * #1407 — a document the WYSIWYG parser refuses must land in Source mode with
 * a message, never in a blank rich-text editor.
 *
 * Before this, the editor caught the parse failure, logged it to the console
 * and carried on with an EMPTY document — editable, and flushed to the store on
 * the first keystroke, so typing into it would have saved over the file the
 * user just opened. A 16382-level corpus
 * file refused by the nesting guard (#1374) takes exactly that path.
 *
 * @coordinates-with unparseableDocument.ts
 * @module services/editor/unparseableDocument.test
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockToastError = vi.fn();
vi.mock("@/services/ime/imeToast", () => ({
  imeToast: { error: (...a: unknown[]) => mockToastError(...a), info: vi.fn(), success: vi.fn() },
}));

import { reportUnparseableDocument } from "./unparseableDocument";
import { useLargeFileSessionStore } from "@/stores/documentStore";
import { MAX_NESTING_DEPTH } from "@/utils/markdownPipeline/nestingDepth";
import { parseMarkdown } from "@/utils/markdownPipeline/adapter";
import { testSchema } from "@/utils/markdownPipeline/testSchema";

function refusalFromParser(depth: number): unknown {
  try {
    parseMarkdown(testSchema, `${"> ".repeat(depth)}a\n`);
  } catch (error) {
    return error;
  }
  throw new Error("expected the parser to refuse");
}

beforeEach(() => {
  mockToastError.mockReset();
  useLargeFileSessionStore.setState({ forcedSourceTabs: {} });
});

describe("reportUnparseableDocument", () => {
  it("puts a too-deep document in Source mode and says how deep, and the limit", () => {
    reportUnparseableDocument("tab-1", refusalFromParser(MAX_NESTING_DEPTH + 382));

    expect(useLargeFileSessionStore.getState().forcedSourceReason("tab-1")).toBe("unparseable");
    expect(mockToastError).toHaveBeenCalledTimes(1);
    const message = String(mockToastError.mock.calls[0][0]);
    expect(message).toContain(String(MAX_NESTING_DEPTH + 382));
    expect(message).toContain(String(MAX_NESTING_DEPTH));
    expect(message).toMatch(/Source mode/);
  });

  it("puts any OTHER parse failure in Source mode too, with a general message", () => {
    reportUnparseableDocument("tab-1", new Error("[MarkdownPipeline] Parse failed: boom"));

    expect(useLargeFileSessionStore.getState().forcedSourceReason("tab-1")).toBe("unparseable");
    expect(mockToastError).toHaveBeenCalledTimes(1);
    const message = String(mockToastError.mock.calls[0][0]);
    expect(message).toMatch(/Source mode/);
    // The pipeline's internal wording is not the user's message.
    expect(message).not.toContain("MarkdownPipeline");
  });

  it("reports once when several editors of one tab fail on the same document", () => {
    // A split view mounts a preview and an editable pane over one document.
    const error = refusalFromParser(MAX_NESTING_DEPTH + 1);
    reportUnparseableDocument("tab-1", error);
    reportUnparseableDocument("tab-1", error);

    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("re-marks a tab already in Source mode for its size, without a second toast", () => {
    // The user is already looking at Source mode, so no toast. But the reason
    // must become the refusal: it is what stops the refused editor's writes.
    useLargeFileSessionStore.getState().markForcedSource("tab-1", "large-file");
    reportUnparseableDocument("tab-1", refusalFromParser(MAX_NESTING_DEPTH + 1));

    expect(useLargeFileSessionStore.getState().forcedSourceReason("tab-1")).toBe("unparseable");
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("still tells the user when the editor has no tab to put in Source mode", () => {
    reportUnparseableDocument(undefined, refusalFromParser(MAX_NESTING_DEPTH + 1));

    expect(useLargeFileSessionStore.getState().forcedSourceTabs).toEqual({});
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("reports a thrown non-Error value instead of throwing on it", () => {
    expect(() => reportUnparseableDocument("tab-1", "boom")).not.toThrow();
    expect(useLargeFileSessionStore.getState().forcedSourceReason("tab-1")).toBe("unparseable");
  });
});
