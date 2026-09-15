/**
 * An integer read from the environment goes through `readIntegerEnv`, never
 * through `Number(process.env…)` / `parseInt(process.env…)`.
 *
 * `Number(process.env.FUZZ_SEED ?? "20260805")` turned a set-but-empty variable
 * into 0 and a typo into NaN, with no error. The weekly soak ran its editing
 * fuzz at seed 0 on every scheduled run that way (#1407), and the pathological
 * suite would have shrunk to trivial inputs on an empty `PATHOLOGICAL_SCALE`.
 * `src/test/envInteger.ts` refuses both; this keeps the old shape from being
 * written again next to it.
 *
 * It walks a TypeScript AST rather than grepping, so an explanation of the
 * defect in a comment or a string — like the one above — is prose, not a
 * finding. Only files that mention `process.env` are parsed. Tracked and
 * untracked-not-ignored files are listed by `git ls-files`, so generated and
 * ignored trees cannot contribute.
 *
 * @coordinates-with src/test/envInteger.ts — the reader this requires
 * @coordinates-with scripts/check-workflow-input-fallbacks.test.mjs — the
 *   workflow half: inputs never reach a step as a silent empty string
 * @module scripts/check-numeric-env-reads.test
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVERTERS = new Set(["Number", "parseInt", "parseFloat", "Number.parseInt", "Number.parseFloat"]);

/** `a.b.c` for a chain of identifiers, or null for anything else. */
function dottedName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = dottedName(node.expression);
    return left === null ? null : `${left}.${node.name.text}`;
  }
  return null;
}

/** Whether `node` reads `process.env.X` / `process.env["X"]`, possibly with a `??`/`||` default. */
function readsProcessEnv(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (
    ts.isBinaryExpression(current) &&
    (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return readsProcessEnv(current.left);
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const owner = dottedName(current.expression);
    return owner === "process.env" || owner === "globalThis.process.env";
  }
  return false;
}

/** `file:line` for every numeric conversion applied directly to an environment read. */
function numericEnvReads(source, file) {
  if (!source.includes("process.env")) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const visit = (node) => {
    const converted =
      (ts.isCallExpression(node) &&
        CONVERTERS.has(dottedName(node.expression) ?? "") &&
        node.arguments.length > 0 &&
        readsProcessEnv(node.arguments[0])) ||
      (ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.PlusToken &&
        readsProcessEnv(node.operand));
    if (converted) {
      out.push(`${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"],
  { cwd: REPO, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

describe("numeric environment reads", () => {
  it("scans the repository (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain("src/test/editingFuzz.test.ts");
  });

  it("go through readIntegerEnv", () => {
    const offenders = files.flatMap((file) => {
      let source;
      try {
        source = readFileSync(path.join(REPO, file), "utf8");
      } catch {
        return []; // listed by git but deleted in the working tree
      }
      return numericEnvReads(source, file);
    });
    expect(offenders).toEqual([]);
  });
});

describe("SELF-TEST: the detector", () => {
  it.each([
    'const SEED = Number(process.env.FUZZ_SEED ?? "20260805");',
    "const n = parseInt(process.env.N, 10);",
    "const s = Number.parseFloat( (process.env.SCALE) );",
    'const k = Number(process.env["KNOB"] || "3");',
    "const p = +process.env.PORT;",
    "const g = Number(globalThis.process.env.G);",
  ])("flags %s", (line) => {
    expect(numericEnvReads(line, "x.ts")).toEqual(["x.ts:1"]);
  });

  it.each([
    'const SEED = readIntegerEnv("FUZZ_SEED", 20260805);',
    'const base = process.env.VMARK_CHANGED_BASE ?? "origin/main";',
    "const n = Number(settings.count);",
    '// the old shape: Number(process.env.FUZZ_SEED ?? "20260805")',
    'const doc = "Number(process.env.X)";',
  ])("leaves %s alone", (line) => {
    expect(numericEnvReads(line, "x.ts")).toEqual([]);
  });
});
