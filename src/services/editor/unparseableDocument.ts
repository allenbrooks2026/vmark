/**
 * Purpose: land a document the WYSIWYG parser refuses in Source mode, and tell
 * the user why, instead of leaving them a blank rich-text editor (#1407).
 *
 * The editor used to catch the failure, log it with a dev-only logger — silent
 * in release builds — and carry on with an EMPTY document. That editor was
 * live: the first keystroke flushed the empty document to the store, so typing
 * would have saved over the file the user had just opened. The nesting guard
 * (#1374) refuses documents past `MAX_NESTING_DEPTH` by design, so this path is
 * reachable from any sufficiently deep file.
 *
 * Source mode shows the text as it is and needs no parse, so it is the one
 * place such a document is both visible and safely editable. The per-tab
 * forced-Source marker already exists for large files; it carries the reason,
 * so the status bar can say the true one.
 *
 * Key decisions:
 *   - ONE report per tab. A split view parses the same document in more than
 *     one editor; the marker doubles as the "already told them" flag.
 *   - A tab already forced for its SIZE keeps that reason: it is not showing
 *     WYSIWYG either way, and a second toast would be noise.
 *   - Any parse failure, not only the nesting refusal. A blank editor that can
 *     overwrite the file is the same hazard whatever the cause; the nesting
 *     refusal just gets the more specific message.
 *
 * @coordinates-with components/Editor/TiptapEditor.tsx — initial parse
 * @coordinates-with components/Editor/tiptapEditorHelpers.ts — external sync
 * @coordinates-with stores/documentStore/largeFileSession.ts — the marker
 * @coordinates-with components/StatusBar/SourceModeUpgrade.tsx — the status line
 * @module services/editor/unparseableDocument
 */
import i18n from "@/i18n";
import { imeToast } from "@/services/ime/imeToast";
import { useLargeFileSessionStore } from "@/stores/documentStore";
import { tiptapError } from "@/utils/debug";
import { nestingRefusal } from "@/utils/markdownPipeline/nestingDepth";

/** Report that the WYSIWYG editor for `tabId` could not parse its document. */
export function reportUnparseableDocument(tabId: string | undefined, error: unknown): void {
  tiptapError(" Document could not be parsed; falling back to Source mode:", error);

  if (tabId !== undefined) {
    const session = useLargeFileSessionStore.getState();
    if (session.isForcedSource(tabId)) return;
    session.markForcedSource(tabId, "unparseable");
  }

  const refusal = nestingRefusal(error);
  imeToast.error(
    refusal
      ? i18n.t("editor:unparseable.tooDeeplyNested", { depth: refusal.depth, limit: refusal.limit })
      : i18n.t("editor:unparseable.parseFailed"),
  );
}
