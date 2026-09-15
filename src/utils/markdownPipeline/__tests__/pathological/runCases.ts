/**
 * WI-3.1 — the pathological child entry, run under the `tsx` loader by
 * `pathological.test.ts` so a synchronous parser/serializer hang is
 * KILLABLE. A vitest timeout cannot interrupt a busy loop on its own event
 * loop; a child process can be terminated from outside.
 *
 * "From outside" only holds while THIS process is the parent's direct child.
 * The parent must therefore spawn `node --import tsx`, never the `.bin/tsx`
 * launcher: the launcher cannot relay the SIGKILL that enforces the timeout,
 * so it dies alone and leaves this process spinning under PID 1. See the
 * runChild comment in `pathological.test.ts`.
 *
 * Runs the markdown pipeline against a StarterKit-only schema: the pipeline
 * (`src/utils/markdownPipeline/`) is leaf-pure by ADR-013, but the FULL
 * production assembly is Vite-native (`import.meta.glob` in i18n), so the
 * child stresses parse + serialize on the core schema — which is where every
 * cmark pathological class lives. The full-schema pipeline is exercised by
 * the spec gates on the (already-nasty, small) spec corpora.
 *
 * Protocol: one JSON line per completed case on stdout
 * (`{"name","parseMs","serializeMs"}`, or `{"name","refusedMs","refusedDepth"}`
 * for a nesting refusal), `{"done":true}` at the end. The
 * PARENT owns all judgement; a case that hangs simply never prints, and the
 * last-started name (printed BEFORE running) identifies the culprit.
 *
 * `HANG_PROBE=1` runs a deliberate busy loop instead — the parent's
 * self-test proves the kill path works, per the plan's DoD.
 *
 * @module utils/markdownPipeline/__tests__/pathological/runCases
 */
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import "../../dialect";
import { serializeMarkdown } from "../../adapter";
import { parseArbitraryMarkdown } from "@/test/arbitraryMarkdown";
import { pathologicalCases, pathologicalScale } from "./pathologicalCases";

if (process.env.HANG_PROBE === "1") {
  console.log(JSON.stringify({ name: "hang-probe", starting: true }));
  for (;;) {
    // Deliberate synchronous hang — the parent must kill this process.
  }
}

const scale = pathologicalScale();
const schema = getSchema([StarterKit]);

for (const testCase of pathologicalCases(scale)) {
  console.log(JSON.stringify({ name: testCase.name, starting: true }));
  const t0 = performance.now();
  // A nesting refusal is a defined outcome here, and the only tolerated one.
  // This suite's contract is liveness — no hang, no stack overflow — and the
  // guard added for #1374 satisfies it deliberately rather than by luck. At
  // scale 1 `deep-blockquotes` is 500 levels and parses; at the soak's scale 8
  // it is 4000 and is refused. Any OTHER error still propagates and fails the
  // run. The PARENT decides whether a refusal was expected for this case.
  const outcome = parseArbitraryMarkdown(schema, testCase.markdown);
  if (outcome.kind === "refused") {
    console.log(
      JSON.stringify({
        name: testCase.name,
        refusedMs: Math.round(performance.now() - t0),
        refusedDepth: outcome.refusal.depth,
      }),
    );
    continue;
  }
  const doc = outcome.doc;
  const parseMs = performance.now() - t0;
  let serializeMs = 0;
  if (testCase.serialize) {
    const t1 = performance.now();
    serializeMarkdown(schema, doc);
    serializeMs = performance.now() - t1;
  }
  console.log(
    JSON.stringify({ name: testCase.name, parseMs: Math.round(parseMs), serializeMs: Math.round(serializeMs) }),
  );
}
console.log(JSON.stringify({ done: true }));
