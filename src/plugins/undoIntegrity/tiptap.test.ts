/**
 * Undo restores the document it recorded, and the undo history stays usable.
 *
 * prosemirror-history files a transaction APPENDED to an undo in the redo
 * branch without remapping what remains in the undo branch, so a plugin that
 * rewrites the document in response to an undo leaves the next undo replaying
 * steps recorded for a document that no longer exists. Two did:
 *
 *   - Tiptap core's `clearDocument` turns an emptied, fully selected document
 *     back into a paragraph, and lifted the empty list item an undo restored.
 *     The next undo threw `RangeError: Position 6 out of range` — found by the
 *     soak's editing fuzz (#1407, seed 4).
 *   - Footnote cleanup deletes a definition whose last reference was removed,
 *     and deleted it when an undo removed the reference: `Position 18`.
 *
 * In both, the first undo had already shown a document that never existed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { closeHistory } from "@tiptap/pm/history";
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

// The same mechanism through a second plugin: footnote cleanup deletes a
// definition whose last reference an edit removed, and an UNDO that removes a
// reference is such an edit. Found by the branch's cross-model audit, which is
// why the guard refuses every document change appended to a history
// transaction instead of opting one plugin out.
describe("undo that removes a footnote reference", () => {
  function editDefinitionThenAddReference(): TypingSession {
    const s = createTypingSession({ markdown: "Text here.\n\n[^1]: note\n" });
    // Loading is itself a history event; close it so the edit below is not
    // grouped with the load, as it would not be for a user typing later.
    s.editor.view.dispatch(closeHistory(s.editor.state.tr));
    let definitionTextEnd = -1;
    s.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "footnote_definition") definitionTextEnd = pos + node.nodeSize - 2;
    });
    s.setCursor(definitionTextEnd);
    s.type("x");
    const reference = s.editor.schema.nodes.footnote_reference.create({ label: "1" });
    // Away from the definition, so history records it as a separate event.
    s.editor.view.dispatch(s.editor.state.tr.insert(5, reference));
    return s;
  }

  const hasDefinition = (s: TypingSession): boolean => blockTypes(s).includes("footnote_definition");

  it("keeps the definition the document had before the reference", () => {
    session = editDefinitionThenAddReference();
    session.undo();
    expect(hasDefinition(session)).toBe(true);
    expect(session.editor.state.doc.textContent).toBe("Text here.notex");
  });

  it("undoes the definition edit too, without throwing", () => {
    session = editDefinitionThenAddReference();
    session.undo();
    expect(() => session?.undo()).not.toThrow();
    expect(session.editor.state.doc.textContent).toBe("Text here.note");
    expect(hasDefinition(session)).toBe(true);
    // The rest of the history (the harness's own load) still applies.
    expect(() => undoAll(session as TypingSession)).not.toThrow();
  });
});

// The guard is scoped to history transactions: the normalizations it keeps
// off an undo must still run on the user edits they exist for.
describe("normalizers on ordinary edits", () => {
  it("still deletes a definition when the user deletes its only reference", () => {
    session = createTypingSession({ markdown: "Text[^1] here.\n\n[^1]: note\n" });
    let referenceAt = -1;
    session.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "footnote_reference") referenceAt = pos;
    });
    session.editor.view.dispatch(session.editor.state.tr.delete(referenceAt, referenceAt + 1));
    expect(blockTypes(session)).not.toContain("footnote_definition");
  });

  it("still turns an emptied heading back into a paragraph", () => {
    session = createTypingSession({ markdown: "# Title\n" });
    selectAllText(session);
    session.press("Backspace");
    expect(blockTypes(session)).toEqual(["paragraph"]);
  });
});
