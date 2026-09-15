/**
 * Undo restores the document it recorded, and the undo history stays usable.
 *
 * Tiptap's core `clearDocument` plugin turns a document emptied by
 * "select everything, then delete" back into a plain paragraph. It keys on the
 * OLD selection covering the whole document and the NEW document being empty,
 * so an UNDO taken with the text fully selected qualifies too, whenever it
 * leaves an empty list item or heading behind. The plugin then lifted that
 * item in an appended transaction.
 *
 * prosemirror-history files a transaction appended to an undo in the REDO
 * branch without remapping what remains in the undo branch. The next undo
 * applied steps recorded for a document that no longer existed and threw
 * `RangeError: Position 6 out of range` — found by the soak's editing fuzz
 * (#1407, seed 4). Before it threw, the first undo had already produced a
 * document that never existed: a paragraph where the empty list item was.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Selection } from "@tiptap/pm/state";
import { createTypingSession, type TypingSession } from "@/test/typingHarness";

let session: TypingSession | null = null;

afterEach(() => {
  session?.destroy();
  session = null;
});

/** Select from the first to the last text position, as a drag or Shift-click does. */
function selectAllText(s: TypingSession): void {
  const { doc } = s.editor.state;
  s.select(Selection.atStart(doc).from, Selection.atEnd(doc).to);
}

const blockTypes = (s: TypingSession): string[] => {
  const types: string[] = [];
  s.editor.state.doc.descendants((node) => {
    if (node.isBlock) types.push(node.type.name);
  });
  return types;
};

/** Undo until the history is exhausted; returns how many undos ran. */
function undoAll(s: TypingSession): number {
  let count = 0;
  while (s.undo()) {
    count += 1;
    if (count > 200) throw new Error("undo did not terminate");
  }
  return count;
}

describe("undo with the whole document selected", () => {
  // Seed 4's minimized trace.
  function typeListThenSelectAll(): TypingSession {
    const s = createTypingSession({ markdown: "" });
    s.type("* ");
    s.type("wordword");
    s.press("Enter");
    s.type("word");
    selectAllText(s);
    return s;
  }

  it("restores the empty list item the typing started from", () => {
    session = typeListThenSelectAll();
    session.undo();
    expect(blockTypes(session)).toEqual(["bulletList", "listItem", "paragraph", "paragraph"]);
  });

  it("keeps undoing back to the empty document without throwing (seed 4)", () => {
    session = typeListThenSelectAll();
    expect(() => undoAll(session as TypingSession)).not.toThrow();
    expect(session.editor.state.doc.textContent).toBe("");
    expect(blockTypes(session)).not.toContain("bulletList");
  });

  it("redoes everything it undid", () => {
    session = typeListThenSelectAll();
    const before = session.editor.state.doc.toJSON();
    undoAll(session);
    let redone = 0;
    expect(() => {
      while (session?.redo()) redone += 1;
    }).not.toThrow();
    expect(redone).toBeGreaterThan(0);
    expect(session.editor.state.doc.toJSON()).toEqual(before);
  });
});

// The guard is scoped to history transactions: the case clearDocument exists
// for must keep working.
describe("select everything, then delete", () => {
  it("still turns an emptied heading back into a paragraph", () => {
    session = createTypingSession({ markdown: "# Title\n" });
    selectAllText(session);
    session.press("Backspace");
    expect(blockTypes(session)).toEqual(["paragraph"]);
  });
});
