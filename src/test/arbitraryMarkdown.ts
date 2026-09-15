/**
 * Purpose: parse ARBITRARY markdown in a fuzz, soak or pathological sweep, and
 * tell the pipeline's one deliberate refusal apart from a crash.
 *
 * `parseMarkdown` refuses a document nested deeper than `MAX_NESTING_DEPTH`
 * (#1374): past that depth the parser's own dependencies overflow the stack, so
 * the refusal is the designed outcome, not a defect. A sweep over hostile input
 * must therefore count a refusal as "handled" — the OSS-Fuzz soak failed on a
 * 16382-level corpus file precisely because it treated the refusal as a crash
 * (#1407) — while every OTHER throw stays a failure.
 *
 * Both sweeps share this one classification so they cannot drift apart. It is
 * by TYPE along the `cause` chain (`nestingRefusal`), never by message text.
 *
 * Use it only on the INPUT of a sweep. A refusal when re-parsing the pipeline's
 * own serialized output would be a real defect, so round-trip legs must call
 * `parseMarkdown` directly and let it throw.
 *
 * @coordinates-with utils/markdownPipeline/nestingDepth.ts — the refusal
 * @coordinates-with test/externalCorpora.soak.test.ts — the OSS-Fuzz sweep
 * @coordinates-with utils/markdownPipeline/__tests__/pathological/runCases.ts
 * @module test/arbitraryMarkdown
 */
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { parseMarkdown } from "@/utils/markdownPipeline/adapter";
import { nestingRefusal, type NestingRefusal } from "@/utils/markdownPipeline/nestingDepth";

export type ArbitraryParseOutcome =
  | { kind: "parsed"; doc: PMNode }
  | { kind: "refused"; refusal: NestingRefusal };

/** Parse `markdown`; a nesting refusal is returned, anything else is thrown. */
export function parseArbitraryMarkdown(schema: Schema, markdown: string): ArbitraryParseOutcome {
  try {
    return { kind: "parsed", doc: parseMarkdown(schema, markdown) };
  } catch (error) {
    const refusal = nestingRefusal(error);
    if (!refusal) throw error;
    return { kind: "refused", refusal };
  }
}
