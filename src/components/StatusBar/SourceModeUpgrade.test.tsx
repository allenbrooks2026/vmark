import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/contexts/WindowContext", () => ({
  useWindowLabel: () => "main",
}));

import { SourceModeUpgrade } from "./SourceModeUpgrade";
import { useUIStore } from "@/stores/uiStore";
import { useTabStore } from "@/stores/tabStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useLargeFileSessionStore } from "@/stores/documentStore";

function setActiveTab(tabId: string | null) {
  useTabStore.setState((state) => ({
    ...state,
    activeTabId: { ...state.activeTabId, main: tabId },
  }));
}

describe("SourceModeUpgrade", () => {
  beforeEach(() => {
    cleanup();
    useLargeFileSessionStore.setState({ forcedSourceTabs: {} });
    useUIStore.getState().resetEditorFlags();
    setActiveTab(null);
  });

  it("renders nothing when no tab is forced-source", () => {
    const { container } = render(<SourceModeUpgrade />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the offer when active tab is forced-source (independent of global sourceMode)", () => {
    setActiveTab("tab-1");
    useLargeFileSessionStore.getState().markForcedSource("tab-1");

    render(<SourceModeUpgrade />);

    expect(screen.getByText("largeFile.openedInSourceMode")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /largeFile\.switchToWysiwygAria/i })
    ).toBeInTheDocument();
  });

  it("clicking the action lifts the marker and leaves a WYSIWYG window in WYSIWYG", async () => {
    const user = userEvent.setup();
    setActiveTab("tab-1");
    useDocumentStore.getState().initDocument("tab-1", "# notes", "/repo/notes.md");
    useLargeFileSessionStore.getState().markForcedSource("tab-1");

    render(<SourceModeUpgrade />);
    await user.click(
      screen.getByRole("button", { name: /largeFile\.switchToWysiwygAria/i })
    );

    expect(useLargeFileSessionStore.getState().isForcedSource("tab-1")).toBe(false);
    expect(useUIStore.getState().sourceMode).toBe(false);
  });

  it("clicking the action SWITCHES even when the window itself is in Source mode (#1407)", async () => {
    // Lifting only the marker used to leave global Source mode on, so the tab
    // stayed in Source and the button did nothing visible. Audit repro: refuse
    // a document, turn Source mode on from another tab, come back, click.
    const user = userEvent.setup();
    setActiveTab("tab-1");
    useDocumentStore.getState().initDocument("tab-1", "# notes", "/repo/notes.md");
    useLargeFileSessionStore.getState().markForcedSource("tab-1", "unparseable");
    useUIStore.getState().setSourceMode(true);

    render(<SourceModeUpgrade />);
    await user.click(
      screen.getByRole("button", { name: /largeFile\.switchToWysiwygAria/i })
    );

    expect(useLargeFileSessionStore.getState().isForcedSource("tab-1")).toBe(false);
    expect(useUIStore.getState().sourceMode).toBe(false);
  });

  it("says a refused document is in Source mode because WYSIWYG cannot show it, not because it is large", () => {
    // #1407: the marker is shared with the large-file path; its label must
    // not claim the file is large when the parser refused it.
    setActiveTab("tab-1");
    useLargeFileSessionStore.getState().markForcedSource("tab-1", "unparseable");

    render(<SourceModeUpgrade />);

    expect(screen.getByText("unparseable.openedInSourceMode")).toBeInTheDocument();
    expect(screen.queryByText("largeFile.openedInSourceMode")).not.toBeInTheDocument();
    // The way back stays: after reducing the nesting in Source mode, this is
    // how the user asks for WYSIWYG again.
    expect(
      screen.getByRole("button", { name: /largeFile\.switchToWysiwygAria/i })
    ).toBeInTheDocument();
  });

  it("does not render for an unrelated active tab", () => {
    setActiveTab("tab-1");
    useLargeFileSessionStore.getState().markForcedSource("tab-9");

    const { container } = render(<SourceModeUpgrade />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does NOT render the offer for a YAML/YML file even if forced-source", () => {
    setActiveTab("tab-yaml");
    useLargeFileSessionStore.getState().markForcedSource("tab-yaml");
    useDocumentStore
      .getState()
      .initDocument(
        "tab-yaml",
        "name: ci\non: push\njobs: {}\n",
        "/repo/.github/workflows/ci.yml",
      );
    const { container } = render(<SourceModeUpgrade />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders the offer for a non-YAML forced-source file", () => {
    setActiveTab("tab-md");
    useLargeFileSessionStore.getState().markForcedSource("tab-md");
    useDocumentStore
      .getState()
      .initDocument("tab-md", "# big notes", "/repo/notes.md");
    render(<SourceModeUpgrade />);
    expect(screen.getByText("largeFile.openedInSourceMode")).toBeInTheDocument();
  });
});
