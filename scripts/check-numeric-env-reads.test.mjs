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
 * finding. It sees through parentheses, type assertions, `process["env"]`,
 * both sides of a fallback, conditionals and templates, and counts arithmetic
 * coercion (`x * 1`, `-x`, `x | 0`) as a conversion.
 * Only files that mention `process` are parsed. Tracked and
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

/** `node` without the wrappers that do not change its value: parentheses and type assertions. */
function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** `a.b.c` for a chain of identifiers and string-keyed element accesses, or null. */
function dottedName(node) {
  const current = unwrap(node);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) {
    const left = dottedName(current.expression);
    return left === null ? null : `${left}.${current.name.text}`;
  }
  if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
    const left = dottedName(current.expression);
    return left === null ? null : `${left}.${current.argumentExpression.text}`;
  }
  return null;
}

/** Whether `node` is a direct `process.env.X` / `process.env["X"]` read. */
function isEnvRead(node) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const owner = dottedName(node.expression);
  return owner === "process.env" || owner === "globalThis.process.env";
}

/** Operators that pass an operand's VALUE through, so an env read inside still decides the result. */
const PASS_THROUGH = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.PlusToken,
]);

/**
 * Whether the value of `node` can be an environment string: a read itself, or
 * one reachable through a fallback (either side of `??`, `||`, `&&`), string
 * concatenation, a conditional branch, or a template. A function call is a
 * boundary: whatever it returns is its own contract.
 */
function carriesEnvValue(node) {
  const current = unwrap(node);
  if (isEnvRead(current)) return true;
  if (ts.isBinaryExpression(current) && PASS_THROUGH.has(current.operatorToken.kind)) {
    return carriesEnvValue(current.left) || carriesEnvValue(current.right);
  }
  if (ts.isConditionalExpression(current)) {
    return carriesEnvValue(current.whenTrue) || carriesEnvValue(current.whenFalse);
  }
  if (ts.isTemplateExpression(current)) {
    return current.templateSpans.some((span) => carriesEnvValue(span.expression));
  }
  return false;
}

/** Arithmetic operators that coerce an operand to a number, as `Number()` does. */
const NUMERIC_BINARY = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const NUMERIC_UNARY = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken]);

/** A converter's name with any global-object qualifier removed: `globalThis.Number` is `Number`. */
const converterName = (callee) => (dottedName(callee) ?? "").replace(/^(?:globalThis|window|self|global)\./, "");

/** Whether `node` converts an environment value to a number. */
function convertsEnvToNumber(node) {
  if (ts.isCallExpression(node)) {
    return CONVERTERS.has(converterName(node.expression)) && node.arguments.length > 0 && carriesEnvValue(node.arguments[0]);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return NUMERIC_UNARY.has(node.operator) && carriesEnvValue(node.operand);
  }
  if (ts.isBinaryExpression(node) && NUMERIC_BINARY.has(node.operatorToken.kind)) {
    return carriesEnvValue(node.left) || carriesEnvValue(node.right);
  }
  return false;
}

/** The parser dialect for a file: `<T>x` is a type assertion in `.ts` and JSX in `.tsx`. */
function scriptKind(file) {
  if (/\.[jt]sx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.[mc]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** `file:line` for every numeric conversion applied directly to an environment read. */
function numericEnvReads(source, file) {
  // A cheap filter that cannot hide a read: every form reaches the global `process`.
  if (!/\bprocess\b/.test(source)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const out = [];
  const visit = (node) => {
    if (convertsEnvToNumber(node)) {
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
    // Found by the branch's cross-model audit.
    "const a = Number(process . env.X);",
    'const b = Number(process["env"].X);',
    "const c = Number(process.env.X as string);",
    "const d = Number(process.env.X!);",
    "const e = parseInt(<string>process.env.X, 10);",
    // Round 2 of the audit: a read on EITHER side of a fallback reaches the conversion.
    "const f = Number(override ?? process.env.FUZZ_SEED);",
    "const g = Number(flag && process.env.X);",
    "const h = Number(cond ? process.env.X : 3);",
    'const i = Number(`${process.env.X}`);',
    'const j = Number("" + process.env.X);',
    "const k = process.env.X * 1;",
    "const l = -process.env.X;",
    "const m = process.env.X | 0;",
    // Round 3 of the audit: a qualified built-in is the same converter.
    "const q = globalThis.Number(process.env.N);",
    "const r = globalThis.Number.parseInt(process.env.N, 10);",
    "const t = window.parseFloat(process.env.N);",
  ])("flags %s", (line) => {
    expect(numericEnvReads(line, "x.ts")).toEqual(["x.ts:1"]);
  });

  it.each([
    'const SEED = readIntegerEnv("FUZZ_SEED", 20260805);',
    'const base = process.env.VMARK_CHANGED_BASE ?? "origin/main";',
    "const n = Number(settings.count);",
    '// the old shape: Number(process.env.FUZZ_SEED ?? "20260805")',
    'const doc = "Number(process.env.X)";',
    "const n = Number(parseEnv(process.env.X));",
    "const o = Number(process.env.X === undefined);",
  ])("leaves %s alone", (line) => {
    expect(numericEnvReads(line, "x.ts")).toEqual([]);
  });
});
