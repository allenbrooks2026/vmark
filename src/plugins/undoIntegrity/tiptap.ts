/**
 * Undo integrity — no plugin may rewrite the document an undo or redo restores.
 *
 * Purpose: an undo must restore the document it recorded, and leave the rest
 * of the history applicable to the result.
 *
 * prosemirror-history files a transaction APPENDED to an undo in the redo
 * branch without remapping what remains in the undo branch. Any
 * `appendTransaction` that changes the document in response to an undo
 * therefore leaves the next undo replaying steps recorded for a document that
 * no longer exists. Two plugins did it, each through a rule that is right for
 * a user edit and wrong for an undo:
 *   - Tiptap core's `clearDocument` turns an emptied, fully selected document
 *     back into a paragraph — and lifted the empty list item an undo restored:
 *     `RangeError: Position 6 out of range` (#1407 soak, editing fuzz seed 4).
 *   - Footnote cleanup deletes a definition whose last reference an edit
 *     removed — and deleted it when an undo removed the reference:
 *     `RangeError: Position 18 out of range`.
 *
 * Key decisions:
 *   - Refuse the appended change centrally (`filterTransaction`) instead of
 *     opting plugins out one by one: the defect belongs to the combination of
 *     appendTransaction and history, so every present and future normalizer
 *     has it, including Tiptap's own.
 *   - The history transaction being applied is known because every view
 *     dispatch passes through the extension `dispatchTransaction` hook first —
 *     the undo/redo commands and prosemirror-history's own `beforeinput`
 *     handler alike — and applying it (including every appendTransaction) is
 *     synchronous inside `next`. A transaction dispatched while it applies
 *     (a view update reacting to it) comes through the hook again and is its
 *     own root, so it is not refused.
 *   - Only DOCUMENT changes are refused. Stored marks and plugin metadata
 *     appended to an undo carry no steps and do not touch history.
 *   - The recorded document was already normalized when it was recorded, so
 *     undo returns to a state the normalizers accepted; the next user edit
 *     runs them again.
 *
 * Boundary: the guard needs the dispatch context. ProseMirror's
 * `filterTransaction` cannot tell a transaction appended in this batch from
 * the next root transaction, so a transaction applied with `state.apply` and
 * never dispatched is outside it — no VMark code does that. VMark's own
 * normalizers also stand down on a history batch by themselves
 * (plugins/shared/historyBatch), which holds on any path.
 *
 * @coordinates-with plugins/shared/historyBatch.ts — the path-independent half
 * @coordinates-with services/assembly/tiptapExtensions.ts — registers it
 * @module plugins/undoIntegrity/tiptap
 */
import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

interface UndoIntegrityStorage {
  /** The undo/redo transaction currently being applied, if any. */
  historyRoot: Transaction | null;
}

const undoIntegrityKey = new PluginKey("undoIntegrity");

export const undoIntegrityExtension = Extension.create<Record<string, never>, UndoIntegrityStorage>({
  name: "undoIntegrity",

  addStorage() {
    return { historyRoot: null };
  },

  dispatchTransaction({ transaction, next }) {
    const outer = this.storage.historyRoot;
    this.storage.historyRoot = isHistoryTransaction(transaction) ? transaction : null;
    try {
      next(transaction);
    } finally {
      this.storage.historyRoot = outer;
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: undoIntegrityKey,
        filterTransaction(transaction) {
          const root = storage.historyRoot;
          return root === null || transaction === root || !transaction.docChanged;
        },
      }),
    ];
  },
});
