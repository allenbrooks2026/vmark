// @vitest-environment node
/**
 * `\tag{…}` on display math must sit at the right edge of the BLOCK, not of
 * the equation (#1376, #1402).
 *
 * The mechanism, from KaTeX's own stylesheet: the tag is placed with
 * `position: absolute; right: 0` inside `.katex-html`, which fills
 * `.katex-display`. Everywhere else that works, because `.katex-display` is a
 * plain block filling its container.
 *
 * VMark's math previews are FLEX containers (`display: flex; justify-content:
 * center`), which makes `.katex-display` a flex ITEM — and a flex item with
 * `width: auto` shrink-wraps to its content. The block then ends where the
 * equation ends, `right: 0` resolves to the equation's own right edge, and the
 * tag lands on top of the last term: `[\Delta V] \tag{9}` renders as
 * `[\Delta V(9)]`.
 *
 * `width: 100%` restores the block's full width. Centring is unaffected —
 * KaTeX centres display math itself with `text-align: center`.
 *
 * Why this suite asserts a CLASS, not a selector. The #1376 fix scoped the
 * rule to `.math-block-preview`, a class no renderer produces: every `$$…$$`
 * block is a `$$math$$` code block drawn by codePreview into
 * `.code-block-preview.latex-preview` (rendered) or
 * `.code-block-live-preview` (editing). The old test pinned the dead selector
 * and stayed green while users still saw the overlap (#1402). So the fix is
 * now one unscoped rule in the stylesheet both the app and export load, the
 * containers are derived from the renderers that create them, and every
 * stylesheet is scanned for a rule that would narrow the block again.
 *
 * A layout assertion is not available here: jsdom computes no geometry, so a
 * test that rendered the equation and measured the tag would pass on a broken
 * stylesheet. The stylesheets are therefore the subject, in the same shape as
 * `src/test/reducedMotionGlobal.test.ts`.
 *
 * @coordinates-with styles/katexFixes.css — the rule under test
 * @coordinates-with plugins/codePreview/code-preview.css — the flex containers
 * @module plugins/latex/displayMathTag.test
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Comments are stripped BEFORE any rule is matched, not after.
 *
 * A body matched with `[^}]*` ends at the first `}` in the file, and a CSS
 * comment may contain one — a comment citing `` `\tag{…}` `` truncated the
 * body and failed the assertion against the very fix that had just been
 * applied.
 */
function readCss(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of the first rule whose ENTIRE selector is `selector`. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}{;])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1] : null;
}

/** Every stylesheet under `src/`. */
function allStylesheets(): string[] {
  return (readdirSync("src", { recursive: true }) as string[])
    .filter((p) => p.endsWith(".css"))
    .map((p) => join("src", p));
}

const KATEX_FIXES = "src/styles/katexFixes.css";
const CODE_PREVIEW_CSS = "src/plugins/codePreview/code-preview.css";

describe("display-math \\tag placement (#1376, #1402)", () => {
  it("gives every .katex-display the full block width, unscoped", () => {
    const body = ruleBody(readCss(KATEX_FIXES), ".katex-display");
    expect(
      body,
      "a container-scoped copy is how the #1376 fix landed on a class nothing renders",
    ).not.toBeNull();
    expect(
      body,
      "a flex item shrink-wraps without an explicit width, which puts `right: 0` " +
        "on the equation's edge instead of the block's",
    ).toMatch(/(?:^|[;\s])width\s*:\s*100%/);
  });

  it("is loaded by both the app and the export bundle", () => {
    expect(readFileSync("src/main.tsx", "utf8")).toContain('import "./styles/katexFixes.css"');
    expect(readFileSync("src/export/editorCSSBundle.ts", "utf8")).toContain(
      "@/styles/katexFixes.css?raw",
    );
  });

  it("no stylesheet narrows .katex-display again", () => {
    const offenders: string[] = [];
    for (const path of allStylesheets()) {
      for (const [, selector, body] of readCss(path).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!selector.includes(".katex-display")) continue;
        const width = /(?:^|[;\s])width\s*:\s*([^;]+)/.exec(body);
        if (width && width[1].trim() !== "100%") {
          offenders.push(`${path}: ${selector.trim()} { width: ${width[1].trim()} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  describe("the premise: display math renders inside flex containers", () => {
    // Pinned because it is WHY the rule above is load-bearing. The containers
    // are taken from the renderers that create them, so a pinned selector can
    // never again be one nothing produces. If a container stops being flex,
    // revisit the fix rather than keep this passing out of habit.
    const codePreviewCss = readCss(CODE_PREVIEW_CSS);

    it("the rendered preview is a flex .code-block-preview.latex-preview", () => {
      const renderer = readFileSync("src/plugins/codePreview/renderers/renderLatex.ts", "utf8");
      expect(renderer).toContain('"code-block-preview latex-preview"');
      expect(ruleBody(codePreviewCss, ".code-block-preview.latex-preview")).toMatch(
        /display:\s*flex/,
      );
    });

    it("the editing preview is a flex .code-block-live-preview", () => {
      const helpers = readFileSync("src/plugins/codePreview/previewHelpers.ts", "utf8");
      expect(helpers).toContain("code-block-live-preview ${");
      expect(ruleBody(codePreviewCss, ".code-block-live-preview")).toMatch(/display:\s*flex/);
    });
  });

  it("does not try to fix it by overriding KaTeX's tag positioning", () => {
    // The tempting alternative is to re-place the tag by hand. That fights
    // KaTeX's own layout, breaks `leqno` (which flips the tag to the left), and
    // has to be re-tuned whenever KaTeX changes. Widening the block leaves
    // KaTeX's rule doing exactly what it was written to do.
    const offenders = allStylesheets().filter((path) =>
      /\.katex-tag\b|\.katex-html\s*>\s*\.tag\b|\.katex-display[^{]*\.tag\b/.test(readCss(path)),
    );
    expect(offenders).toEqual([]);
  });
});
