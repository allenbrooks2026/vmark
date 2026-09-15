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
 * Expressions are PARSED (a small reader for the expression grammar), not
 * matched: a fallback must protect the input it follows, `github['event']`
 * and `INPUTS.x` are the same read, a comparison is never empty, and an
 * expression the reader cannot parse is a finding, never a pass.
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

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const MARKER = /^\s*input-empty-ok:\s*(\S.*)?$/;
const TOKEN =
  /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?|0x[0-9a-fA-F]+)|([A-Za-z_][A-Za-z0-9_-]*)|(\|\||&&|==|!=|<=|>=|[()[\].,!<>*]))/y;
/** Functions whose result is a boolean, and so never an empty string. */
const BOOLEAN_FUNCTIONS = new Set(["contains", "startswith", "endswith", "success", "failure", "always", "cancelled"]);

/**
 * Parse one GitHub Actions expression body into a small AST:
 * `lit`, `ref` (a lowercase property path; a computed key becomes `*`),
 * `call`, `or`, `and`, and `bool` for comparisons and negation.
 * Throws on anything it cannot read, so an unparseable expression is a finding
 * rather than a pass.
 */
function parseExpression(body) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < body.length && body.slice(TOKEN.lastIndex).trim() !== "") {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(body);
    if (!m) throw new Error(`unexpected character at ${at}`);
    if (m[1] !== undefined) tokens.push({ kind: "str", value: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) tokens.push({ kind: "num" });
    else if (m[3] !== undefined) tokens.push({ kind: "id", value: m[3].toLowerCase() });
    else tokens.push({ kind: m[4] });
  }
  let i = 0;
  const peek = (kind) => tokens[i]?.kind === kind;
  const take = (kind) => {
    if (!peek(kind)) throw new Error(`expected ${kind} at token ${i}`);
    return tokens[i++];
  };
  const binary = (next, op, type) => () => {
    let left = next();
    while (peek(op)) {
      i++;
      left = { type, left, right: next() };
    }
    return left;
  };
  const primary = () => {
    if (peek("str")) return { type: "lit", value: take("str").value };
    if (peek("num")) return i++, { type: "lit", value: "0" };
    if (peek("(")) {
      i++;
      const inner = or();
      take(")");
      return inner;
    }
    const name = take("id").value;
    if (name === "true" || name === "false") return { type: "bool" };
    if (name === "null") return { type: "lit", value: "" };
    if (peek("(")) {
      i++;
      const args = [];
      while (!peek(")")) {
        args.push(or());
        if (!peek(")")) take(",");
      }
      take(")");
      return BOOLEAN_FUNCTIONS.has(name) ? { type: "bool" } : { type: "call", args };
    }
    let path = [name];
    for (;;) {
      if (peek(".")) {
        i++;
        path.push(peek("*") ? (i++, "*") : take("id").value);
      } else if (peek("[")) {
        i++;
        const key = or();
        take("]");
        path.push(key.type === "lit" ? key.value.toLowerCase() : "*");
      } else {
        return { type: "ref", path };
      }
    }
  };
  const unary = () => (peek("!") ? (i++, unary(), { type: "bool" }) : primary());
  const compare = () => {
    const left = unary();
    if (["==", "!=", "<", "<=", ">", ">="].some((op) => peek(op))) {
      i++;
      unary();
      return { type: "bool" };
    }
    return left;
  };
  const and = binary(compare, "&&", "and");
  const or = binary(and, "||", "or");
  const tree = or();
  if (i !== tokens.length) throw new Error(`unexpected token ${tokens[i].kind}`);
  return tree;
}

/** Whether `node` is a read of a workflow input. */
function isInputRead(node) {
  if (node.type !== "ref") return false;
  const [a, b, c] = node.path;
  return a === "inputs" || (a === "github" && b === "event" && c === "inputs");
}

/** Whether `node` reads an input anywhere. */
function readsInput(node) {
  if (isInputRead(node)) return true;
  if (node.type === "or" || node.type === "and") return readsInput(node.left) || readsInput(node.right);
  if (node.type === "call") return node.args.some(readsInput);
  return false;
}

/**
 * Whether `node` can evaluate to the empty string BECAUSE an input was empty.
 * `a || b` is `b` whenever `a` is empty, so it leaks what `b` leaks — or what
 * `a` leaks, if `b` can itself be empty. `a && b` can be either operand. A call is
 * assumed to pass an empty argument through; a comparison never does.
 */
function leaksEmptyInput(node) {
  switch (node.type) {
    case "ref":
      return isInputRead(node);
    case "or":
      return leaksEmptyInput(node.right) || (mayBeEmpty(node.right) && leaksEmptyInput(node.left));
    case "and":
      return leaksEmptyInput(node.left) || leaksEmptyInput(node.right);
    case "call":
      return node.args.some(leaksEmptyInput);
    default:
      return false;
  }
}

/**
 * Whether `node` can evaluate to the empty string at all, input or not: the
 * test a fallback must fail to protect anything. A context read other than an
 * input is assumed non-empty; a function call is assumed able to return "".
 */
function mayBeEmpty(node) {
  switch (node.type) {
    case "lit":
      return node.value === "";
    case "ref":
      return isInputRead(node);
    case "or":
      return mayBeEmpty(node.left) && mayBeEmpty(node.right);
    case "and":
      return mayBeEmpty(node.left) || mayBeEmpty(node.right);
    case "call":
      return true;
    default:
      return false;
  }
}

/** Every `${{ … }}` body in `text`, parsed, or with the parse error. */
function expressions(text) {
  return [...text.matchAll(EXPRESSION)].map((match) => {
    try {
      return { body: match[1].trim(), tree: parseExpression(match[1]) };
    } catch (error) {
      return { body: match[1].trim(), error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Findings for one workflow source. Exported shape is `{ where, problem }` so
 * the self-tests below can assert against synthetic workflows.
 */
function findings(source, file) {
  const doc = parseDocument(source);
  const out = [];
  const unparseable = (where, body, error) =>
    out.push({ where, problem: `cannot parse \`${body}\` (${error}); rewrite it or fix the checker` });
  visit(doc, {
    Pair(_key, pair) {
      if (!isScalar(pair.key)) return;
      const key = String(pair.key.value);

      if (key === "env" && isMap(pair.value)) {
        for (const entry of pair.value.items) {
          if (!isPair(entry) || !isScalar(entry.value) || typeof entry.value.value !== "string") continue;
          const where = `${file} env ${String(isScalar(entry.key) ? entry.key.value : "?")}`;
          for (const { body, tree, error } of expressions(entry.value.value)) {
            if (error) {
              unparseable(where, body, error);
              continue;
            }
            if (!leaksEmptyInput(tree)) continue;
            const marker = MARKER.exec(entry.value.comment ?? "");
            if (marker && marker[1]) continue;
            out.push({
              where,
              problem: marker
                ? "input-empty-ok marker has no reason"
                : `reads \`${body}\` with no fallback and no input-empty-ok marker`,
            });
          }
        }
      }

      if (key === "run" && isScalar(pair.value) && typeof pair.value.value === "string") {
        for (const { body, tree, error } of expressions(pair.value.value)) {
          if (error) unparseable(`${file} run`, body, error);
          else if (readsInput(tree)) {
            out.push({ where: `${file} run`, problem: `interpolates \`${body}\` into the shell; pass it through env:` });
          }
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

  // Found by the branch's cross-model audit.
  it("flags bracket access to an input", () => {
    expect(findings(wf("          S: ${{ inputs['fuzz_seed'] }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ github.event.inputs[ 'fuzz_seed' ] }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ inputs['fuzz_seed'] || '1' }}"), "t.yml")).toEqual([]);
  });

  it("does not count an empty fallback", () => {
    expect(findings(wf("          S: ${{ inputs.fuzz_seed || '' }}"), "t.yml")).toHaveLength(1);
  });

  it("checks a fallback that is itself an input", () => {
    expect(findings(wf("          S: ${{ inputs.a || inputs.b }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ inputs.a || inputs.b || 'c' }}"), "t.yml")).toEqual([]);
  });

  // Round 2 of the audit: a fallback must protect the input it follows.
  it("does not accept a fallback that belongs to another operand", () => {
    expect(findings(wf("          S: ${{ format('{0}', inputs.seed, github.ref || '1') }}"), "t.yml")).toHaveLength(1);
  });

  // Round 3 of the audit: a fallback that can itself be empty protects nothing.
  it("does not accept a fallback that can evaluate to empty", () => {
    expect(findings(wf("          S: ${{ inputs.seed || ('' || '') }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ inputs.seed || format('{0}', '') }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ inputs.seed || github.ref }}"), "t.yml")).toEqual([]);
  });

  it("resolves a fully bracketed and case-varied input read", () => {
    expect(findings(wf("          S: ${{ github['event']['inputs']['seed'] }}"), "t.yml")).toHaveLength(1);
    expect(findings(wf("          S: ${{ INPUTS.seed }}"), "t.yml")).toHaveLength(1);
  });

  it("does not flag a comparison, which is never empty", () => {
    expect(findings(wf("          S: ${{ inputs.seed == '' }}"), "t.yml")).toEqual([]);
  });

  it("refuses an expression it cannot parse instead of passing it", () => {
    const out = findings(wf("          S: ${{ inputs.seed ||| 'x' }}"), "t.yml");
    expect(out.map((f) => f.problem)).toEqual([expect.stringMatching(/cannot parse/)]);
  });

  it("ignores `inputs.x` inside a string literal", () => {
    expect(findings(wf("          S: ${{ format('see inputs.x') }}"), "t.yml")).toEqual([]);
  });

  it("ignores env values that read no input", () => {
    expect(findings(wf("          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"), "t.yml")).toEqual([]);
  });
});
