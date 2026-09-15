/**
 * Undo integrity — keep document normalizers from rewriting an undo or redo.
 *
 * Purpose: an undo must restore the document it recorded, and leave the rest
 * of the history applicable to the result.
 *
 * Tiptap core's `clearDocument` plugin (the `keymap` core extension) turns a
 * document emptied by select-all-and-delete back into a plain paragraph. Its
 * test is "the old selection covered everything and the new document is
 * empty", which an UNDO taken with the text fully selected also passes whenever
 * it leaves an empty list item or heading behind — so it lifted that item in an
 * appended transaction. prosemirror-history files a transaction appended to an
 * undo in the redo branch WITHOUT remapping the undo branch, so the next undo
 * replayed steps recorded for a document that no longer existed:
 * `RangeError: Position 6 out of range` (#1407 soak, editing fuzz seed 4).
 *
 * Key decisions:
 *   - Opt out with the plugin's own `preventClearDocument` meta rather than
 *     disabling the core extension, which also owns Backspace/Delete/Enter.
 *   - Tag in the extension `dispatchTransaction` hook, which every view
 *     dispatch passes through — the undo/redo commands and prosemirror-history's
 *     own `beforeinput` handler alike — before the state applies it.
 *   - Only history transactions are tagged; select-all-and-delete keeps its
 *     normalization.
 *
 * @coordinates-with services/assembly/tiptapExtensions.ts — registers it
 * @module plugins/undoIntegrity/tiptap
 */
import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";

/** The meta Tiptap's `clearDocument` plugin honours as an opt-out. */
const PREVENT_CLEAR_DOCUMENT = "preventClearDocument";

export const undoIntegrityExtension = Extension.create({
  name: "undoIntegrity",

  dispatchTransaction({ transaction, next }) {
    if (isHistoryTransaction(transaction)) {
      transaction.setMeta(PREVENT_CLEAR_DOCUMENT, true);
    }
    next(transaction);
  },
});
