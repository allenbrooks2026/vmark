/**
 * Purpose: let a document normalizer stand down when the batch it is reacting
 * to is an undo or redo.
 *
 * An `appendTransaction` that changes the document in response to an undo
 * corrupts the undo history: prosemirror-history files the appended change in
 * the redo branch without remapping what remains in the undo branch, and the
 * next undo replays steps against a document that no longer exists
 * (`RangeError: Position N out of range`). It also shows a document the user
 * never had, since the undo was supposed to restore a recorded one.
 *
 * `plugins/undoIntegrity` refuses such appends for every transaction dispatched
 * through the editor. This is the half that holds however a transaction is
 * applied — including `state.apply` with no view — for the normalizers VMark
 * owns: each checks its batch and returns null.
 *
 * @coordinates-with plugins/undoIntegrity/tiptap.ts — the central, dispatch-level guard
 * @coordinates-with plugins/footnotePopup/tiptap.ts — footnote cleanup
 * @coordinates-with plugins/blankLinesGuard/blankLinesGuard.ts — blank-line reset
 * @module plugins/shared/historyBatch
 */
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Whether `transactions` — an `appendTransaction` batch — contains an undo or
 * redo, or a transaction appended to one. The second case matters: after the
 * first round of appends, ProseMirror passes a plugin only the transactions
 * added since its last call, which no longer include the undo itself.
 */
export function isHistoryBatch(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => {
    if (isHistoryTransaction(tr)) return true;
    const root: unknown = tr.getMeta("appendedTransaction");
    return root !== undefined && isHistoryTransaction(root as Transaction);
  });
}
