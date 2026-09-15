// @vitest-environment node
/**
 * #1407 — the inline fast paths must never change a parse.
 *
 * Each fast path settles a character only on a proof that micromark's own
 * construct would fail there, so a parser with the fast paths must produce the
 * SAME mdast as one without — node for node, and position for position. This
 * file checks exactly that, three ways:
 *
 *   1. every example of every vendored spec corpus (CommonMark, GFM, and the
 *      rest of the registry) — the constructs' documented behaviour;
 *   2. hand-picked inputs at each fast path's decision boundary — the cases a
 *      wrong proof would get wrong first;
 *   3. a seeded fuzz over an alphabet dense in `[`, `]`, `![`, `^`, backticks,
 *      `*` and `_` — the interactions nobody thought to write down.
 *
 * That they make anything FASTER is the other half of the contract, and lives
 * in `__tests__/pathological/pathologicalScaling.test.ts`.
 *
 * @coordinates-with remarkInlineFastPaths.ts — the plugin under test
 * @coordinates-with ../../__tests__/spec/corpusRegistry.ts — the corpora
 * @module utils/markdownPipeline/parser/fastPaths/inlineFastPaths.test
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkFrontmatter from "remark-frontmatter";
import { remarkInlineFastPaths } from "./remarkInlineFastPaths";
import { CORPORA, loadExamples } from "../../__tests__/spec/corpusRegistry";

const stock = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMath)
  .use(remarkFrontmatter, ["yaml"]);

const fast = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkInlineFastPaths)
  .use(remarkMath)
  .use(remarkFrontmatter, ["yaml"]);

/** What the comparison needs from a processor: parsing, and nothing else. */
interface Parses {
  parse(markdown: string): unknown;
  data(): unknown;
}

/** The syntax tree with positions, as a comparable string. */
function tree(processor: Parses, markdown: string): string {
  return JSON.stringify(processor.parse(markdown));
}

function expectSameTree(markdown: string): void {
  expect(tree(fast, markdown), JSON.stringify(markdown)).toBe(tree(stock, markdown));
}

const BRACKET_BOUNDARIES = [
  "[a](b)", "[a]", "[a][]", "[a][b]\n\n[b]: /u", "[a]\n\n[a]: /u", "![a](b)", "![a]",
  "[![a](b)](c)", "[a [b](c) d](e)", "[a](b]c)", "\\[a](b)", "a]", "]", "]]]", "[]", "[](x)",
  "![]()", "[a\nb](c)", "[`a]`](b)", "`[a`](b)", "<a title=\"]\">x</a>]", "<https://x.y/]>",
  "[a](<b]>)", "*[a*](b)", "[中文](链接)", "[😀]\n\n[😀]: /e", "a](a](a](", "[a](<b[a](<b",
  "> [a\n> ](b)", "- [a\n  ](b)", "| a | [b |\n|---|---|\n| ] | c](d) |", "[a] ]\n\n[a]: /u",
  "[a](b) ] [c](d) ]", "[a [b] c](d)", "[[a]](b)", "![[a](b)](c) ]", "![a] ] ]",
  // Footnote calls and the potential call behind a balanced image label.
  "[^1]\n\n[^1]: note", "![^1]\n\n[^1]: note", "![ ^1]\n\n[^1]: note", "![\t^1]\n\n[^1]: note",
  "![\n^1]\n\n[^1]: note", "![x] a] b]\n\n[^1]: note", "![^1] ] ]\n\n[^1]: note",
  "![^2]\n\n[^1]: note", "![^1\n\n[^1]: note", "![ ]\n\n[^1]: note", "![^1] [^1]\n\n[^1]: note",
  "[^1] ] ![^1]\n\n[^1]: note", "![x] [^1]\n\n[^1]: note",
  // A LATER `]` behind a balanced `![^…` can never complete a footnote call —
  // its label would hold a bare `]`, and no definition label can. These are the
  // spellings that argument has to survive: escaped brackets and backslash
  // runs in the definition, in the call, and between them.
  "![^y] a] b]\n\n[^x]: note", "![^a] ]\n\n[^a\\]]: note", "![^a\\] ]\n\n[^a\\]]: note",
  "![^a\\\\] ]\n\n[^a\\\\]: note", "![^a] b]\n\n[^a]b]: note", "![^\\]] ]\n\n[^\\]]: note",
  "![^a]\\] ]\n\n[^a]: note", "![^a `]` ] c]\n\n[^a]: note", "![^a] ]\n\n[^a]: note\n[^a] ]: n",
];

const BACKTICK_BOUNDARIES = [
  "`a`", "``a``", "`a``", "``a`", "` `` `", "\\`a`", "\\``a``", "`a\nb`", "e`e``e```",
  "`` ` ``", "```a```", "a ` b ` c ` d", "`a` `b`", "``` `a` ```", "`[a](b)`", "\\\\`a`",
  "` a`b` `", "> `a\n> b`", "`a`\n\n`b`", "`é`", "``中``", "`\t`", "`a` ``b`` `c", "``a` `b``",
  "`a\\`b`", "\\`\\``a`", "e`e``e```e``e`", "`", "``", "a`", "`\n`", "- `a\n  b`",
  "| `a | b` |\n|---|---|\n| `c` | d |", "<code>`</code>`", "[`](`)", "*`a*`",
  // Container continuations: a lookahead reading past the line ending moved a
  // text node's end by a column (audit counterexamples).
  "*\t`x`\n\t`x`", "1. \n\t]]\n  `x`_\n\t`x`", "> `a`\n> `b`\n> `", "- `a\n\t`b`\n  ``c",
];

const EMPHASIS_BOUNDARIES = [
  "a_ a_ a_", "*a*", "**a**", "_a_", "a*b*c", "a_b_c", "*a_", "_a*", "***a***", "*a **b** c*",
  "**a*", "a** b*", "* a *", "a_ _b_", "_a_ b_", "*a* b* c*", "foo*bar*", "__a__", "_ a_",
  "a* *b", "*a\n*", "[*a](b*)", "*[a*](b)", "`*a`*", "\\*a*", "a**b**c**", "*(*a*)*",
  "_(_a_)_", "a ** b", "**a*b***", "a* b* *c", "a_ b_ _c_", "*a**b*", "a***b* c**",
  "中*文*", "a*😀*b", "_a_\n\n_b", "a_ *b* c_", "a* _b_ c*",
];

describe("inline fast paths leave every parse unchanged (#1407)", () => {
  it("on every vendored spec corpus example", () => {
    let checked = 0;
    for (const entry of CORPORA) {
      for (const example of loadExamples(entry)) {
        expectSameTree(example.markdown);
        checked += 1;
      }
    }
    // Non-vacuity: the registry is large; a loader that returned nothing
    // would otherwise pass this with zero comparisons.
    expect(checked).toBeGreaterThan(600);
  });

  it.each(BRACKET_BOUNDARIES)("at a `]` decision boundary: %j", expectSameTree);

  it.each(BACKTICK_BOUNDARIES)("at a backtick decision boundary: %j", expectSameTree);

  it.each(EMPHASIS_BOUNDARIES)("at an emphasis decision boundary: %j", expectSameTree);

  it("defers to a catch-all construct another extension registers for EVERY character", () => {
    // micromark tries `text.null` constructs at every code, after the code's
    // own list. A fast path that only read the list for `]` and backtick would
    // settle a character such a construct was about to claim. (Audit finding.)
    const claimsBracketsAndBackticks = {
      name: "testCatchAll",
      tokenize(effects: { enter(t: string): void; exit(t: string): void; consume(c: number): void }, ok: unknown, nok: (c: number) => unknown) {
        return (code: number) => {
          if (code !== 93 && code !== 96) return nok(code);
          effects.enter("htmlText");
          effects.enter("htmlTextData");
          effects.consume(code);
          effects.exit("htmlTextData");
          effects.exit("htmlText");
          return ok;
        };
      },
    };
    const withCatchAll = (processor: Parses): Parses => {
      const data = processor.data() as { micromarkExtensions?: unknown[] };
      (data.micromarkExtensions ??= []).push({ text: { null: [claimsBracketsAndBackticks] } });
      return processor;
    };
    const stockWith = withCatchAll(unified().use(remarkParse).use(remarkGfm, { singleTilde: false }));
    const fastWith = withCatchAll(unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkInlineFastPaths));
    for (const markdown of ["a ] b", "a ` b", "a](a](", "e`e``e```", "*a*"]) {
      expect(tree(fastWith, markdown), JSON.stringify(markdown)).toBe(tree(stockWith, markdown));
    }
  });

  const SEED = Number(process.env.FAST_PATH_SEED ?? "1407");
  const TOKENS = [
    "[", "]", "![", "(", ")", "<", ">", "^", " ", "\t", "\n", "\n\n", "a", "b", "\\", "`", "``",
    "*", "**", "_", "__", ":", "/", "中", "😀", "[^1]", "[^1]: n\n\n", "[a]: /u\n\n", "> ", "- ",
    "\\\\", "\\]", "![^1", "[^1\\]]: n\n\n",
  ];
  const document = fc.array(fc.constantFrom(...TOKENS), { maxLength: 40 }).map((t) => t.join(""));

  it(`on fuzzed delimiter-dense documents (seed ${SEED})`, () => {
    fc.assert(
      fc.property(document, (markdown) => {
        expect(tree(fast, markdown)).toBe(tree(stock, markdown));
      }),
      { numRuns: 3000, seed: SEED },
    );
  }, 120_000);
});
