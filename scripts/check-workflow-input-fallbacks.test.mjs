/**
 * A workflow input handed to a step must never arrive as a silent empty string.
 *
 * `inputs.*` (and `github.event.inputs.*`) is the EMPTY STRING whenever the run
 * was not a dispatch that supplied it: every scheduled run, every push, every
 * release event, and every dispatch that left an optional field blank. A
 * consumer written for "unset" does not see "unset". The weekly soak passed
 * `FUZZ_SEED: ${{ inputs.fuzz_seed }}` to a test that read
 * `Number(process.env.FUZZ_SEED ?? "20260805")`: `??` does not fire on "", and
 * `Number("")` is 0. Every scheduled soak ran seed 0 instead of the documented
 * seed, and the three editor bugs the documented seed finds stayed hidden
 * (#1407). The step was green the whole time.
 *
 * So this asserts, for every workflow:
 *
 *   1. An `env:` value that reads an input either supplies the fallback in the
 *      expression — `${{ inputs.x || 'default' }}` — or carries a trailing
 *      `# input-empty-ok: <reason>` comment saying why its consumer handles ""
 *      on purpose. The reason is required: a bare marker is a mute button.
 *   2. No `run:` body interpolates an input at all. There the value is pasted
 *      into the shell before it runs, which both skips this check and is the
 *      workflow-injection shape the repo's workflows already route through
 *      `env:` to avoid.
 *
 * `with:` is out of scope deliberately: actions read inputs through
 * `core.getInput`, which already treats "" as not provided.
 *
 * Workflows are discovered, not listed, so a new one is covered on creation.
 *
 * @coordinates-with .github/workflows/*.yml
 * @coordinates-with src/test/envInteger.ts — the consumer-side half: an
 *   integer knob that is present but not an integer fails instead of reading 0
 * @module scripts/check-workflow-input-fallbacks.test
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isPair, isScalar, parseDocument, visit } from "yaml";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, ".github/workflows");

/** An `inputs.<id>` read inside one `${{ … }}` expression. */
const INPUT_READ = /\b(?:github\.event\.)?inputs\.[A-Za-z_][A-Za-z0-9_-]*/;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const MARKER = /^\s*input-empty-ok:\s*(\S.*)?$/;

/** Every `${{ … }}` body in `text` that reads an input. */
function inputExpressions(text) {
  return [...text.matchAll(EXPRESSION)].map((m) => m[1]).filter((body) => INPUT_READ.test(body));
}

/** Whether an expression supplies a fallback after the input it reads. */
function hasFallback(body) {
  const read = INPUT_READ.exec(body);
  return read !== null && /\|\|\s*\S/.test(body.slice(read.index + read[0].length));
}

/**
 * Findings for one workflow source. Exported shape is `{ where, problem }` so
 * the self-tests below can assert against synthetic workflows.
 */
function findings(source, file) {
  const doc = parseDocument(source);
  const out = [];
  visit(doc, {
    Pair(_key, pair) {
      if (!isScalar(pair.key)) return;
      const key = String(pair.key.value);

      if (key === "env" && isMap(pair.value)) {
        for (const entry of pair.value.items) {
          if (!isPair(entry) || !isScalar(entry.value) || typeof entry.value.value !== "string") continue;
          const name = String(isScalar(entry.key) ? entry.key.value : "?");
          for (const body of inputExpressions(entry.value.value)) {
            if (hasFallback(body)) continue;
            const marker = MARKER.exec(entry.value.comment ?? "");
            if (marker && marker[1]) continue;
            out.push({
              where: `${file} env ${name}`,
              problem: marker
                ? "input-empty-ok marker has no reason"
                : `reads \`${body.trim()}\` with no fallback and no input-empty-ok marker`,
            });
          }
        }
      }

      if (key === "run" && isScalar(pair.value) && typeof pair.value.value === "string") {
        for (const body of inputExpressions(pair.value.value)) {
          out.push({
            where: `${file} run`,
            problem: `interpolates \`${body.trim()}\` into the shell; pass it through env:`,
          });
        }
      }
    },
  });
  return out;
}

const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map((f) => ({ file: f, source: readFileSync(path.join(DIR, f), "utf8") }));

describe("workflow inputs reach steps with a fallback", () => {
  it("finds the workflows (guards against a silently empty sweep)", () => {
    expect(workflows.length).toBeGreaterThan(5);
    expect(workflows.map((w) => w.file)).toContain("soak.yml");
  });

  it("every input read in env: has a fallback or a reasoned marker, and none is pasted into run:", () => {
    const all = workflows.flatMap(({ file, source }) => findings(source, file));
    expect(all).toEqual([]);
  });
});

// The checker is only worth what it can still catch.
describe("SELF-TEST: the checker", () => {
  const wf = (env, run = "echo ok") =>
    `on: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n${env}\n        run: ${run}\n`;

  it("flags the soak's original line", () => {
    expect(findings(wf("          FUZZ_SEED: ${{ inputs.fuzz_seed }}"), "t.yml")).toHaveLength(1);
  });

  it("flags github.event.inputs as well", () => {
    expect(findings(wf("          TAG: ${{ github.event.inputs.tag }}"), "t.yml")).toHaveLength(1);
  });

  it("accepts a fallback in the expression", () => {
    expect(findings(wf("          FUZZ_SEED: ${{ inputs.fuzz_seed || '20260805' }}"), "t.yml")).toEqual([]);
  });

  it("does not count a fallback that precedes the input", () => {
    expect(findings(wf("          X: ${{ github.ref || inputs.x }}"), "t.yml")).toHaveLength(1);
  });

  it("accepts a reasoned marker and refuses a bare one", () => {
    expect(
      findings(wf("          TAG: ${{ inputs.tag }} # input-empty-ok: the step defaults it"), "t.yml"),
    ).toEqual([]);
    const bare = findings(wf("          TAG: ${{ inputs.tag }} # input-empty-ok:"), "t.yml");
    expect(bare.map((f) => f.problem)).toEqual(["input-empty-ok marker has no reason"]);
  });

  it("flags an input pasted into a run body, even with a fallback", () => {
    const run = `|\n          echo "\${{ inputs.version || 'v0' }}"`;
    expect(findings(wf("          A: plain", run), "t.yml")).toHaveLength(1);
  });

  it("ignores env values that read no input", () => {
    expect(findings(wf("          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"), "t.yml")).toEqual([]);
  });
});
