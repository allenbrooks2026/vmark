import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { EditorView as CodeMirrorView } from "@codemirror/view";

const { requestToggleTerminal } = vi.hoisted(() => ({
  requestToggleTerminal: vi.fn(),
}));
vi.mock("./terminalGate", () => ({ requestToggleTerminal }));

const mockGetCurrentWindowLabel = vi.fn(() => "main");
vi.mock("@/services/persistence/workspaceStorage", () => ({
  getCurrentWindowLabel: () => mockGetCurrentWindowLabel(),
}));

import { useUIStore } from "@/stores/uiStore";
import { useEditorStore } from "@/stores/editorStore";
import {
  toggleTerminalFocus,
  TERMINAL_FOCUS_REQUEST_EVENT,
} from "./toggleTerminalFocus";

function makeTerminalPanelDom(): { panel: HTMLElement; innerButton: HTMLElement } {
  const panel = document.createElement("div");
  panel.className = "terminal-panel";
  const innerButton = document.createElement("button");
  panel.appendChild(innerButton);
  document.body.appendChild(panel);
  return { panel, innerButton };
}

function makeEditorButton(): HTMLElement {
  const button = document.createElement("button");
  document.body.appendChild(button);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  useUIStore.setState({ terminalVisible: false, sourceMode: false, markdownSplitView: false });
  useEditorStore.getState().clearActiveEditors();
  vi.clearAllMocks();
});

describe("toggleTerminalFocus — terminal hidden", () => {
  it("delegates to requestToggleTerminal (open + auto-focus) and touches nothing else", () => {
    useUIStore.setState({ terminalVisible: false });
    const editorButton = makeEditorButton();
    editorButton.focus();

    toggleTerminalFocus();

    expect(requestToggleTerminal).toHaveBeenCalledTimes(1);
    // Hidden branch never inspects/moves focus itself — that's on requestToggleTerminal.
    expect(document.activeElement).toBe(editorButton);
  });
});

describe("toggleTerminalFocus — terminal visible, focus inside the terminal", () => {
  it("focuses the active WYSIWYG editor when not in source mode", () => {
    useUIStore.setState({ terminalVisible: true, sourceMode: false });
    const { innerButton } = makeTerminalPanelDom();
    innerButton.focus();
    const focus = vi.fn();
    const fakeEditor = { view: { focus } } as unknown as TiptapEditor;
    useEditorStore.getState().setActiveWysiwygEditor(fakeEditor, "tab-1");

    toggleTerminalFocus();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(requestToggleTerminal).not.toHaveBeenCalled();
  });

  it("focuses the active source view when in source mode", () => {
    useUIStore.setState({ terminalVisible: true, sourceMode: true });
    const { innerButton } = makeTerminalPanelDom();
    innerButton.focus();
    const focus = vi.fn();
    const fakeView = { focus } as unknown as CodeMirrorView;
    useEditorStore.getState().setActiveSourceView(fakeView, "tab-1");

    toggleTerminalFocus();

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not throw when there is no active editor to focus", () => {
    useUIStore.setState({ terminalVisible: true, sourceMode: false });
    const { innerButton } = makeTerminalPanelDom();
    innerButton.focus();

    expect(() => toggleTerminalFocus()).not.toThrow();
  });
});

describe("toggleTerminalFocus — terminal visible, focus outside the terminal", () => {
  it("dispatches the terminal focus-request event instead of touching the store", () => {
    useUIStore.setState({ terminalVisible: true });
    const editorButton = makeEditorButton();
    editorButton.focus();
    const listener = vi.fn();
    window.addEventListener(TERMINAL_FOCUS_REQUEST_EVENT, listener);

    toggleTerminalFocus();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(requestToggleTerminal).not.toHaveBeenCalled();
    window.removeEventListener(TERMINAL_FOCUS_REQUEST_EVENT, listener);
  });

  it("also fires when nothing at all is focused (document.activeElement is body)", () => {
    useUIStore.setState({ terminalVisible: true });
    (document.activeElement as HTMLElement | null)?.blur?.();
    const listener = vi.fn();
    window.addEventListener(TERMINAL_FOCUS_REQUEST_EVENT, listener);

    toggleTerminalFocus();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(TERMINAL_FOCUS_REQUEST_EVENT, listener);
  });
});
