/**
 * toggleTerminalFocus
 *
 * Purpose: the "Toggle Terminal Focus" command (default Mod-Shift-j) — moves
 * keyboard focus between the terminal panel and the active document editor
 * without closing the panel, so the terminal can stay open while you switch
 * back and forth with one key. `Ctrl-\`` (Toggle Terminal) is unchanged and
 * stays a plain open/close toggle; this command is a focus-only superset that
 * opens the panel when it's hidden (reusing the existing open+auto-focus
 * behavior) but otherwise only moves focus, never hides the panel.
 *
 * Key decisions:
 *   - Hidden -> requestToggleTerminal() (opens + auto-focuses via the
 *     existing switchVisibility() term.focus() call; unchanged behavior).
 *   - Visible + focus inside the terminal -> focus the active editor via the
 *     mode-gated useEditorStore().active lookup, the same read
 *     commandContext.resolveCommandContext uses, so it resolves correctly in
 *     a split view.
 *   - Visible + focus elsewhere -> dispatch a "terminal:focus-request"
 *     CustomEvent rather than adding new Zustand state. TerminalPanel already
 *     exposes the live xterm instance via useTerminalSessions().getActiveTerminal(),
 *     so no cross-boundary store field is needed to reach it — this follows
 *     the same store/service -> component signal idiom as
 *     uiStore/searchSlice.ts's "search:replace-current".
 *
 * @coordinates-with TerminalPanel.tsx — listens for TERMINAL_FOCUS_REQUEST_EVENT
 * @module services/terminal/toggleTerminalFocus
 */

import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import { isEffectiveSourceMode } from "@/services/editor/editorActionGates";
import { getCurrentWindowLabel } from "@/services/persistence/workspaceStorage";
import { requestToggleTerminal } from "./terminalGate";

/** Fired when focus should move INTO the terminal; TerminalPanel owns the xterm instance. */
export const TERMINAL_FOCUS_REQUEST_EVENT = "terminal:focus-request";

function isFocusInsideTerminal(): boolean {
  return !!document.activeElement?.closest(".terminal-panel");
}

function focusActiveEditor(): void {
  const active = useEditorStore.getState().active;
  if (isEffectiveSourceMode(getCurrentWindowLabel())) {
    active.activeSourceView?.focus();
  } else {
    active.activeWysiwygEditor?.view.focus();
  }
}

/** Move keyboard focus between the terminal panel and the active document editor. */
export function toggleTerminalFocus(): void {
  if (!useUIStore.getState().terminalVisible) {
    requestToggleTerminal();
    return;
  }
  if (isFocusInsideTerminal()) {
    focusActiveEditor();
  } else {
    window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_REQUEST_EVENT));
  }
}
