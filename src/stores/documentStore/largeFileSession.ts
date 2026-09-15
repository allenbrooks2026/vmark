/**
 * Large-file session state — tracks which tabs were auto-opened in Source
 * mode, and why: the file exceeded the WYSIWYG threshold, or the WYSIWYG
 * parser refused it (#1407). Used to prevent unintended mode flips during the
 * session, and to tell the user the real reason.
 *
 * @module stores/documentStore/largeFileSession
 */

import { create } from "zustand";

/**
 * Why a tab was put in Source mode for the user.
 *
 * - `large-file`: over the size threshold; WYSIWYG would work, slowly.
 * - `unparseable`: the WYSIWYG parser refused the document (for example it
 *   nests past the limit), so WYSIWYG would be a blank editor.
 */
type ForcedSourceReason = "large-file" | "unparseable";

interface LargeFileSessionState {
  /** Tab IDs that were auto-opened in Source mode, with the reason. */
  forcedSourceTabs: Record<string, ForcedSourceReason>;
  markForcedSource: (tabId: string, reason?: ForcedSourceReason) => void;
  clearForcedSource: (tabId: string) => void;
  isForcedSource: (tabId: string) => boolean;
  forcedSourceReason: (tabId: string) => ForcedSourceReason | undefined;
}

export const useLargeFileSessionStore = create<LargeFileSessionState>((set, get) => ({
  forcedSourceTabs: {},
  markForcedSource: (tabId, reason = "large-file") =>
    set((state) => ({ forcedSourceTabs: { ...state.forcedSourceTabs, [tabId]: reason } })),
  clearForcedSource: (tabId) =>
    set((state) => {
      if (!state.forcedSourceTabs[tabId]) return state;
      const next = { ...state.forcedSourceTabs };
      delete next[tabId];
      return { forcedSourceTabs: next };
    }),
  isForcedSource: (tabId) => Boolean(get().forcedSourceTabs[tabId]),
  forcedSourceReason: (tabId) => get().forcedSourceTabs[tabId],
}));
