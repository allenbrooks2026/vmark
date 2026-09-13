/**
 * Real-WebKit tier — a display equation's `\tag` sits at the right edge of
 * the BLOCK, not on the last term (#1376, #1402).
 *
 * jsdom computes no layout, so the node-tier
 * `plugins/latex/displayMathTag.test.ts` can only read stylesheets. That is
 * how #1376 shipped as fixed while users still saw the overlap: its rule and
 * its test both named a class nothing renders. This file measures the real
 * thing — the stylesheets the app loads, the renderer and sanitizer the
 * preview uses, inside the containers codePreview creates.
 *
 * It lives in codePreview, not latex: the containers it measures are
 * codePreview's, and codePreview is the fence-preview hub that the
 * `plugin-isolation` dependency rule licenses to import the latex plugin. From
 * `plugins/latex/` the same imports are a cross-plugin violation.
 *
 * **The failure is constructed, not assumed.** The first case forces
 * `.katex-display` back to `width: auto` and asserts the probe SEES the
 * overlap. Without it, a measurement that always reported "at the edge" would
 * make every other assertion vacuously true.
 */
import "katex/dist/katex.min.css";
import "@/styles/katexFixes.css";
import "./code-preview.css";
import { describe, it, expect, afterEach } from "vitest";
import { renderLatex } from "@/plugins/latex";
import { sanitizeKatex } from "@/utils/sanitize";

/** Short enough that a shrink-wrapped block leaves the tag on the equation. */
const EQUATION = "\\sigma_{\\mathrm{c}}=f_{\\mathrm{c}}\\tag{4}";
const CONTAINER_WIDTH = 600;
/** Sub-pixel rounding allowance for edge comparisons. */
const EDGE_TOLERANCE = 2;

interface Geometry {
  /** Right edge of the container's content box. */
  contentRight: number;
  /** Right edge of the tag. */
  tagRight: number;
  /** Left edge of the tag. */
  tagLeft: number;
  /** Right edge of the equation body (the last `.katex-base`). */
  equationRight: number;
}

async function renderInto(className: string, narrowBlock = false): Promise<Geometry> {
  const container = document.createElement("div");
  container.className = className;
  container.style.width = `${CONTAINER_WIDTH}px`;
  container.innerHTML = sanitizeKatex(await renderLatex(EQUATION));
  document.body.appendChild(container);

  const display = container.querySelector<HTMLElement>(".katex-display");
  expect(display, "renderLatex must produce display-mode output").not.toBeNull();
  if (narrowBlock) display!.style.width = "auto";

  // KaTeX 0.18 class names: the tag is `.katex-tag`, each equation run a
  // `.katex-base` (older releases used bare `.tag` / `.base`).
  const tag = container.querySelector<HTMLElement>(".katex-html > .katex-tag");
  expect(tag, "KaTeX must render the \\tag element").not.toBeNull();
  const bases = container.querySelectorAll<HTMLElement>(".katex-html > .katex-base");
  expect(bases.length).toBeGreaterThan(0);

  const box = container.getBoundingClientRect();
  const style = getComputedStyle(container);
  const tagBox = tag!.getBoundingClientRect();
  return {
    contentRight: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
    tagRight: tagBox.right,
    tagLeft: tagBox.left,
    equationRight: bases[bases.length - 1].getBoundingClientRect().right,
  };
}

describe("display-math \\tag placement in real WebKit", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("the probe sees the overlap when the block shrink-wraps (constructed failure)", async () => {
    const g = await renderInto("code-block-preview latex-preview", true);
    // The tag starts before the equation ends — it is drawn on top of it.
    expect(g.tagLeft).toBeLessThan(g.equationRight);
    expect(g.contentRight - g.tagRight).toBeGreaterThan(EDGE_TOLERANCE);
  });

  for (const [label, className] of [
    ["the rendered preview", "code-block-preview latex-preview"],
    ["the editing preview", "code-block-live-preview latex-live-preview"],
  ] as const) {
    it(`${label}: the tag reaches the block edge and clears the equation`, async () => {
      const g = await renderInto(className);
      expect(Math.abs(g.contentRight - g.tagRight)).toBeLessThanOrEqual(EDGE_TOLERANCE);
      expect(g.tagLeft).toBeGreaterThanOrEqual(g.equationRight);
    });
  }
});
