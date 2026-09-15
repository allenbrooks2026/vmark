// @vitest-environment node
/**
 * #1407 — the pathological classes must scale LINEARLY with input size.
 *
 * The soak tier runs these classes at cmark's full sizes inside a killable
 * child, weekly. That is the only place a super-linear parse or serialize was
 * ever visible, and it was visible as a HANG: `link-closers-with-openers`
 * alone took 60s to parse and 276s to serialize at soak scale, against a 300s
 * wall ceiling for the whole suite. This file brings the property into the PR
 * tier, where it is cheap.
 *
 * It asserts a GROWTH EXPONENT, never a duration. Wall-clock bounds flake
 * under contention (`../performance.test.ts` is opt-in for exactly that
 * reason), and a busy machine slows a small run and a large run alike. What
 * contention cannot do is turn cost ∝ n into cost ∝ n²: for an 8× larger input
 * that is the difference between ~8× and ~64× the CPU time, so the exponent
 * separates them with a wide margin on both sides. Three things keep the
 * measurement honest under load:
 *
 *   - CPU time of this process (`process.cpuUsage`), not wall time, so being
 *     descheduled costs nothing. Vitest runs each file in its own fork.
 *   - Small and large runs are INTERLEAVED and the minimum of each is kept, so
 *     a burst of contention or a GC pause inflates one sample, not the answer.
 *   - A warm-up parse first, so JIT compilation is not billed to the small run
 *     (which would make growth look better or worse than it is).
 *
 * Fixed overhead per call (processor lookup, content analysis) can only pull
 * the exponent DOWN, so it can hide nothing the bound is meant to catch.
 *
 * @coordinates-with pathologicalCases.ts — the soak-tier shapes these mirror
 * @coordinates-with ../../parser/fastPaths/ — the linear decisions under test
 * @coordinates-with ../../serializerCosmetics.ts — the linear escape scan
 * @coordinates-with patches/micromark@4.0.2.patch — linear data-token merge
 * @coordinates-with patches/mdast-util-to-markdown@2.1.2.patch — linear escaping
 * @module utils/markdownPipeline/__tests__/pathological/pathologicalScaling.test
 */
import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import "../../dialect";
import { parseMarkdown, serializeMarkdown } from "../../adapter";

const schema = getSchema([StarterKit]);

/** Linear is 1, quadratic is 2. Measured with the fixes: 1.04–1.18 under a
 *  load average above 150. Without them: 1.82–2.35 for every case except
 *  `backtick-runs`, which carries its own bound below. */
const MAX_EXPONENT = 1.35;

interface ScalingCase {
  name: string;
  /** Build the input for size parameter `n`. */
  make: (n: number) => string;
  small: number;
  large: number;
  /** Measure parse alone — for a parser property whose input must be big. */
  parseOnly?: boolean;
  /** A tighter bound, for a class whose broken growth is below quadratic. */
  maxExponent?: number;
}

const backtickRuns = (n: number): string => {
  let out = "";
  for (let i = 1; i <= n; i += 1) out += `e${"`".repeat(i)}`;
  return `${out}\n`;
};

const CASES: ScalingCase[] = [
  {
    // `]` with no opener anywhere: every one used to walk the whole paragraph.
    name: "link-closers-with-openers",
    make: (n) => `${"a](".repeat(n)}\n`,
    small: 500,
    large: 4000,
  },
  {
    // Parses linearly, but its SERIALIZED form escapes every `[` — so the
    // cosmetic pass re-parses a paragraph of openerless `]`.
    name: "unclosed-inline-links",
    make: (n) => `${"[a](<b".repeat(n)}\n`,
    small: 400,
    large: 3200,
  },
  {
    // A balanced image label is where the footnote-call scan stops — so it
    // must not turn every later `]` back into a walk to it.
    name: "link-closers-after-an-image",
    make: (n) => `![x] ${"a](".repeat(n)}\n`,
    small: 500,
    large: 4000,
  },
  {
    // …including an image label that LOOKS like a footnote call while
    // footnotes are defined, so the footnote-call check has something to look
    // up. A later `]` still cannot complete that call (its label would contain
    // a bare `]`, which no definition label can), so it must not reintroduce
    // the walk either.
    name: "link-closers-after-a-footnote-like-image",
    make: (n) => `![^y] ${"a](".repeat(n)}\n\n[^x]: note\n`,
    small: 500,
    large: 4000,
  },
  {
    // Real links between the stray `]`s: each one rewrites the event list, so
    // the opener index must re-index from the link — not from the start of
    // the paragraph, which would put the quadratic walk back one link at a time.
    name: "link-closers-between-links",
    make: (n) => `${"[a](b) ] ".repeat(n)}\n`,
    small: 300,
    large: 2400,
  },
  {
    // Every `_` closes and none opens: each used to walk back to the start.
    name: "emph-closers-without-openers",
    make: (n) => `${"a_ ".repeat(n)}\n`,
    small: 500,
    large: 4000,
  },
  {
    // Runs of distinct lengths never close, so each opener scanned to the end
    // of the paragraph. And every backtick is escaped on the way out, which is
    // where remark-stringify's escaping was quadratic in the escape count.
    // Input size grows with n², so these sizes are a ~16× size step — and the
    // broken scan costs n³, i.e. size^1.5, not size². Measured: 1.04–1.11
    // fixed, 1.41–1.48 broken, so the bound sits between them.
    name: "backtick-runs",
    make: backtickRuns,
    small: 120,
    large: 480,
    maxExponent: 1.25,
  },
  {
    // Ordinary escaped prose — what the serializer's conservative output looks
    // like. micromark merged adjacent data tokens with one `splice` per run,
    // each moving the rest of the paragraph's events: harmless until the event
    // list outgrows V8's regular heap objects, then ~10× per 1.3× more text.
    // So this case needs a paragraph past that size (~100 KB), and measures
    // parse alone to keep the cost of doing so down.
    name: "escaped-prose",
    make: (n) => `${"\\*ab c".repeat(n)}\n`,
    small: 6000,
    large: 24000,
    parseOnly: true,
  },
];

function roundTrip(markdown: string): void {
  serializeMarkdown(schema, parseMarkdown(schema, markdown));
}

function parseOnce(markdown: string): void {
  parseMarkdown(schema, markdown);
}

function cpuMs(fn: () => void): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

/** Minimum CPU cost of small and large inputs, interleaved. */
function measure(
  run: (markdown: string) => void,
  small: string,
  large: string,
): { small: number; large: number } {
  run(small); // warm-up: JIT and processor caches
  let bestSmall = Number.POSITIVE_INFINITY;
  let bestLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    bestSmall = Math.min(bestSmall, cpuMs(() => run(small)));
    bestLarge = Math.min(bestLarge, cpuMs(() => run(large)));
    bestSmall = Math.min(bestSmall, cpuMs(() => run(small)));
  }
  return { small: bestSmall, large: bestLarge };
}

describe("pathological inputs scale linearly (#1407)", () => {
  it.each(CASES)("$name: cost grows linearly with input size", (c) => {
    const small = c.make(c.small);
    const large = c.make(c.large);
    const cost = measure(c.parseOnly ? parseOnce : roundTrip, small, large);
    // A floor on the small sample keeps a sub-millisecond reading from
    // manufacturing a huge ratio out of timer resolution.
    const smallCost = Math.max(cost.small, 1);
    const exponent = Math.log(cost.large / smallCost) / Math.log(large.length / small.length);
    expect(
      exponent,
      `${c.name}: ${small.length} chars → ${cost.small.toFixed(1)}ms, ` +
        `${large.length} chars → ${cost.large.toFixed(1)}ms ` +
        `(exponent ${exponent.toFixed(2)}; 1 is linear, 2 is quadratic)`,
    ).toBeLessThan(c.maxExponent ?? MAX_EXPONENT);
  }, 600_000);
});
