/**
 * WI-3.1 — pathological input generators, ported from cmark's
 * `pathological_tests.py` classes (BSD-2): inputs that historically drive
 * markdown parsers super-linear or into deep recursion.
 *
 * Pure data, scale-parameterized: the PR tier runs `scale = 1` (reduced
 * sizes — the point there is "no hang, no stack overflow", not benchmark
 * numbers); the soak tier raises the scale toward cmark's originals.
 *
 * `serialize: true` marks classes whose PARSED document is itself deep or
 * huge, so the serializer leg gets stressed too — a parser that survives
 * deep blockquotes proves nothing about the serializer that must walk them.
 *
 * @coordinates-with runCases.ts — the child-process entry that executes these
 * @coordinates-with pathological.test.ts — the killing parent
 * @module utils/markdownPipeline/__tests__/pathological/pathologicalCases
 */
import { readIntegerEnv } from "@/test/envInteger";

export interface PathologicalCase {
  name: string;
  markdown: string;
  /** Also run the parse→ProseMirror→markdown leg. */
  serialize: boolean;
  /**
   * How deeply the input nests CONTAINERS (blockquotes, lists), stated from
   * the generator rather than measured by the guard — so a case above
   * `MAX_NESTING_DEPTH` is one the parent EXPECTS to be refused, and a refusal
   * of any other case is a failure rather than a quiet pass.
   */
  containerDepth: number;
}

/** The scale a run uses: `PATHOLOGICAL_SCALE`, read in ONE place so the child
 *  that generates the inputs and the parent that judges them cannot disagree.
 *  Read strictly: `Number("")` is 0, and `pathologicalCases` clamps every size
 *  to at least 4, so an empty value used to shrink the soak to trivial inputs
 *  that pass without testing anything. */
export function pathologicalScale(): number {
  return readIntegerEnv("PATHOLOGICAL_SCALE", 1, { min: 1 });
}

export function pathologicalCases(scale = 1): PathologicalCase[] {
  const n = (base: number) => Math.max(4, Math.floor(base * scale));
  const backtickRuns = (max: number) => {
    let out = "";
    for (let i = 1; i <= max; i += 1) out += `e${"`".repeat(i)}`;
    return out;
  };
  return [
    {
      name: "nested-brackets",
      markdown: `${"[".repeat(n(2000))}a${"]".repeat(n(2000))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "nested-strong-emph",
      markdown: `${"*a **a ".repeat(n(300))}b${" a** a*".repeat(n(300))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "emph-closers-without-openers",
      markdown: `${"a_ ".repeat(n(3000))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "emph-openers-without-closers",
      markdown: `${"_a ".repeat(n(3000))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "link-closers-with-openers",
      markdown: `${"a](".repeat(n(3000))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "backtick-runs",
      markdown: `${backtickRuns(n(250))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "unclosed-inline-links",
      markdown: `${"[a](<b".repeat(n(2000))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "deep-blockquotes",
      markdown: `${"> ".repeat(n(500))}a\n`,
      serialize: true,
      containerDepth: n(500),
    },
    {
      name: "deep-lists",
      markdown: Array.from({ length: n(200) }, (_, i) => `${"  ".repeat(i)}- a`).join("\n") + "\n",
      serialize: true,
      containerDepth: n(200),
    },
    {
      // Deep mdast NESTING (not just long delimiter runs): alternating
      // emphasis markers nest one level per pair. The OSS-Fuzz soak found a
      // per-child recursion in remarkPlugins that blew the call stack on
      // exactly this shape (WI-5.1); fixed to an explicit stack.
      name: "deep-inline-nesting",
      markdown: `${"*_".repeat(n(1500))}x${"_*".repeat(n(1500))}\n`,
      serialize: true,
      containerDepth: 0,
    },
    {
      name: "many-link-references",
      markdown:
        Array.from({ length: n(1000) }, (_, i) => `[ref${i}]: /url${i}`).join("\n") +
        `\n\n${Array.from({ length: n(1000) }, (_, i) => `[ref${i}]`).join(" ")}\n`,
      serialize: true,
      containerDepth: 0,
    },
  ];
}
