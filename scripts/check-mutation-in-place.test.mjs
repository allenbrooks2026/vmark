/**
 * #1409 — both mutation tools run IN PLACE, because both test suites read the
 * real repository tree.
 *
 * Purpose: pin the one property whose absence broke the mutation BASELINE
 * twice in two months, in both tools at once. By default cargo-mutants and
 * Stryker copy the project into a scratch directory and run the suite there,
 * and neither copy is the tree the suites were written against:
 *
 *   - cargo-mutants copies ONLY the crate (`src-tauri/`). Rust tests that bond
 *     to the frontend read `../src/…` — `command_error.test.rs` (#1210) and
 *     `pdf_export/renderer/progress.test.rs` (#1409) — and on macOS six
 *     `include_str!("../../../src/lib/browser/agent/*.src.js")` fail the BUILD
 *     before any test runs. A per-test sandbox skip cannot reach a compile-time
 *     include, which is why #1210's skip was an instance fix, not a class fix.
 *   - Stryker copies the project into `.stryker-tmp/sandbox-*` and SYMLINKS
 *     `node_modules` in from outside it. Vite's `server.fs.allow` is rooted at
 *     the sandbox (the copied `pnpm-workspace.yaml` marks it as the workspace),
 *     so a `?raw`/`?inline` import of a package asset resolves to a real path
 *     outside the allow list and fails with `Denied ID …/katex.min.css?raw` —
 *     which Vitest wraps as "There was an error when mocking a module" and the
 *     Stryker runner reports WITHOUT its cause. Three related test files failed
 *     that way (`printDocument`, `copyAsHtml`, `pickPrintHtmlSource`); CI named
 *     only the first, because the runner bails at the first failure.
 *
 * Running in place removes the copy, so no current or future test can depend
 * on something the copy left out. What this pins, and why each is needed:
 *
 *   1. Every cargo-mutants invocation passes `--in-place`. It is a CLI flag
 *      with NO `mutants.toml` key (verified against 27.1.0's `Config`), so it
 *      has to live on each invocation. cargo-mutants itself refuses
 *      `--in-place` together with `--jobs` or `CARGO_MUTANTS_JOBS` (a clap
 *      conflict, exit 1), so parallelising means dropping the flag — which is
 *      exactly what this refuses.
 *   2. Every `stryker run` names `stryker.config.json` as its first argument.
 *      With no argument Stryker DISCOVERS its config, trying `stryker.conf.*`
 *      before `stryker.config.*` (`config-file-formats.js`), so a stray config
 *      file would silently replace the one asserted below.
 *   3. `stryker.config.json` sets `inPlace: true` (a config key, so a local
 *      `pnpm mutation:ts` behaves exactly like CI) and `disableTypeChecks:
 *      false`: in place, Stryker's default preprocessor would rewrite every
 *      `src/**` script file with `// @ts-nocheck` in the working tree, and
 *      Vitest never type-checks anyway.
 *
 * Invocations are found by TOKENIZING each script, not by grepping lines, so a
 * flag in a comment, on a neighbouring command, or in a redirection cannot
 * satisfy the check. The tokenizer covers what a hand edit plausibly writes —
 * quotes, escapes, continuations, comments, separators, redirections, command
 * substitution, `sh -c` and `eval` — and is not a shell interpreter: a command
 * name assembled from variables is out of its reach. Workflows and package.json
 * scripts are discovered rather than listed, and the check refuses to pass
 * vacuously when it finds no invocation of either tool.
 *
 * @coordinates-with .github/workflows/mutation.yml
 * @coordinates-with stryker.config.json
 * @coordinates-with src-tauri/.cargo/mutants.toml
 * @module scripts/check-mutation-in-place.test
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(REPO, ".github/workflows");
const STRYKER_CONFIG = "stryker.config.json";

const SEPARATORS = new Set(["\n", ";", "&", "|", "(", ")", "`"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The last path segment of a word: `./node_modules/.bin/stryker` → `stryker`. */
const base = (word) => word.split("/").pop();

/** Index just past the `)` that closes a `$(` whose body starts at `from`. */
function closingParen(script, from) {
  let depth = 1;
  for (let i = from; i < script.length; i++) {
    if (script[i] === "(") depth++;
    if (script[i] === ")" && --depth === 0) return i;
  }
  return script.length;
}

/**
 * Split a shell script into the programs it runs, each `{ name, args }` (see
 * `program`).
 *
 * A redirection and its target are not arguments (`cargo mutants > --in-place`
 * passes no flag), a `#` comment is not a command, and a command hidden in a
 * double-quoted `$(…)`/backtick, an `sh -c` script or an `eval` is scanned too.
 */
function shellCommands(script) {
  const commands = [];
  const nested = [];
  let words = [];
  let word = "";
  let inWord = false;
  let redirectTarget = false;
  const endWord = () => {
    if (inWord && !redirectTarget) words.push(word);
    if (inWord) redirectTarget = false;
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    redirectTarget = false;
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === "\\") {
      if (script.startsWith("\r\n", i + 1)) i += 2;
      else if (script[i + 1] === "\n") i += 1;
      else if (i + 1 < script.length) {
        word += script[++i];
        inWord = true;
      }
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      word += script.slice(i + 1, end === -1 ? script.length : end);
      inWord = true;
      i = end === -1 ? script.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        if (script[j] === "\\" && j + 1 < script.length) j++;
        else if (script[j] === "`") {
          const end = script.indexOf("`", j + 1);
          nested.push(script.slice(j + 1, end === -1 ? script.length : end));
        } else if (script.startsWith("$(", j)) {
          nested.push(script.slice(j + 2, closingParen(script, j + 2)));
        }
        word += script[j];
      }
      inWord = true;
      i = j;
    } else if (c === "#" && !inWord) {
      const newline = script.indexOf("\n", i);
      i = newline === -1 ? script.length : newline - 1;
    } else if (c === "<" || c === ">" || (c === "&" && script[i + 1] === ">")) {
      // `2>&1`: the fd number belongs to the redirection, not the command.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      while (i + 1 < script.length && /[<>&-]/.test(script[i + 1])) i++;
      redirectTarget = true;
    } else if (SEPARATORS.has(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  // A command inside a double-quoted substitution runs just like a bare one.
  const programs = commands.map(program).filter(Boolean);
  // `sh -c "…"` and `eval …` run a command line held in their arguments.
  const hidden = programs.flatMap(({ name, args }) => {
    if (name === "eval") return [args.join(" ")];
    const flag = SHELLS.has(name) ? args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
    return flag !== -1 && flag + 1 < args.length ? [args[flag + 1]] : [];
  });
  return [...programs, ...[...nested, ...hidden].flatMap(shellCommands)];
}

// Options that take a separate value word, per program.
const CARGO_VALUE_OPTIONS = new Set(["--config", "-Z", "-C", "--color"]);
const PNPM_VALUE_OPTIONS = new Set(["-C", "--dir", "-F", "--filter", "--workspace-dir", "--reporter", "--loglevel"]);
// Programs that run the rest of their command line.
const WRAPPERS = new Set(["env", "time", "nohup", "sudo", "exec", "command", "npx", "pnpx", "node"]);

/** Drop leading `-options` (and the value of any option in `valued`). */
function dropOptions(words, valued = new Set()) {
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += valued.has(words[i]) ? 2 : 1;
  return words.slice(i);
}

/**
 * The program a command actually runs, and its arguments — looking through
 * `NAME=value` assignments, wrappers (`env`, `time`, `sudo`, `npx`, `node
 * script.js`) and `pnpm exec`. Only this position counts: `echo cargo mutants`
 * runs `echo`, and `printf %s pnpm mutation:ts` runs no script.
 */
function program(words) {
  let rest = words;
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_]\w*=/.test(rest[0])) rest = rest.slice(1);
    if (rest.length === 0) return null;
    const name = base(rest[0]);
    const args = rest.slice(1);
    if (WRAPPERS.has(name)) {
      rest = dropOptions(args);
    } else if (name === "pnpm" && ["exec", "dlx"].includes(dropOptions(args, PNPM_VALUE_OPTIONS)[0])) {
      rest = dropOptions(dropOptions(args, PNPM_VALUE_OPTIONS).slice(1), PNPM_VALUE_OPTIONS);
    } else {
      return { name, args };
    }
  }
}

/** Arguments of a cargo-mutants invocation, or null. */
function cargoMutantsArgs({ name, args }) {
  if (name === "cargo-mutants") return args[0] === "mutants" ? args.slice(1) : null;
  if (name !== "cargo") return null;
  let i = 0;
  while (i < args.length && (args[i].startsWith("+") || args[i].startsWith("-"))) {
    i += CARGO_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  }
  return args[i] === "mutants" ? args.slice(i + 1) : null;
}

/** Arguments of a `stryker run` invocation, or null. `pnpm stryker` runs the bin. */
function strykerRunArgs({ name, args }) {
  const run = name === "pnpm" ? dropOptions(args, PNPM_VALUE_OPTIONS) : [name, ...args];
  return /^stryker(\.js)?$/.test(base(run[0] ?? "")) && run[1] === "run" ? run.slice(2) : null;
}

/** Does this program run the package script `script` through pnpm? */
function runsPnpmScript({ name, args }, script) {
  if (name !== "pnpm") return false;
  const rest = dropOptions(args, PNPM_VALUE_OPTIONS);
  return (rest[0] === "run" ? dropOptions(rest.slice(1), PNPM_VALUE_OPTIONS)[0] : rest[0]) === script;
}

/** Why a cargo-mutants invocation would test a copy, or `[]` if it would not. */
function cargoMutantsProblems(args) {
  // Words after a bare `--` go to `cargo test`, not to cargo-mutants.
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  return own.includes("--in-place") ? [] : ["cargo-mutants without --in-place"];
}

/** Why a Stryker invocation might not read stryker.config.json, or `[]`. */
function strykerProblems(args) {
  // The config is Stryker's one positional; only the first word is certainly
  // it, since a later one may be the value of an option like --ignorePatterns.
  return args[0] === STRYKER_CONFIG
    ? []
    : [`stryker run whose first argument is not ${STRYKER_CONFIG} (got: ${args[0] ?? "nothing"})`];
}

/** Every invocation of either tool in a shell script, with its problems. */
function scriptFindings(script) {
  const findings = [];
  for (const prog of shellCommands(script)) {
    const command = [prog.name, ...prog.args].join(" ");
    const cargoArgs = cargoMutantsArgs(prog);
    if (cargoArgs) findings.push({ tool: "cargo-mutants", command, problems: cargoMutantsProblems(cargoArgs) });
    const strykerArgs = strykerRunArgs(prog);
    if (strykerArgs) findings.push({ tool: "stryker", command, problems: strykerProblems(strykerArgs) });
  }
  return findings;
}

/** Every `run:` script in a parsed workflow. */
function runScripts(doc) {
  return Object.values(doc?.jobs ?? {}).flatMap((job) =>
    (job?.steps ?? []).map((step) => step?.run).filter((run) => typeof run === "string"),
  );
}

const problemsOf = (script) => scriptFindings(script).flatMap((f) => f.problems);

describe("shell tokenizing (fixtures)", () => {
  it("finds cargo-mutants in every spelling, and not in an install, a comment or prose", () => {
    const script = [
      "cargo install cargo-mutants",
      "# cargo mutants --manifest-path x",
      'echo "Running cargo mutants"; echo "stryker run"',
      "echo cargo mutants; echo stryker run; printf '%s' pnpm exec stryker run",
      "cargo mutants --in-place --manifest-path src-tauri/Cargo.toml 2>&1 | tee log",
      "cargo +stable mutants --in-place",
      "cargo --locked --config k=v mutants --in-place",
      "~/.cargo/bin/cargo-mutants mutants --in-place",
      "CARGO_TERM_COLOR=always env -i time cargo mutants --in-place",
    ].join("\n");
    const found = scriptFindings(script);
    expect(found.map((f) => f.tool)).toEqual(Array(5).fill("cargo-mutants"));
    expect(found.flatMap((f) => f.problems)).toEqual([]);
  });

  it.each([
    ["no flag at all", "cargo mutants --manifest-path x"],
    ["a flag in a trailing comment", "cargo mutants # --in-place"],
    ["a flag on a backgrounded neighbour", "cargo mutants & echo --in-place"],
    ["a flag on a chained neighbour", "echo --in-place && cargo mutants --manifest-path x"],
    ["a flag after -- (it goes to cargo test)", "cargo mutants -- --in-place"],
    ["a flag as a redirection target", "cargo mutants > --in-place"],
    ["a flag as a here-string", "cargo mutants --manifest-path x <<< --in-place"],
    ["a quoted flag that is one word with its neighbour", "cargo mutants '--in-place --list'"],
    ["a toolchain prefix", "cargo +nightly mutants --list"],
    ["a command substitution", "out=$(cargo mutants --list)"],
    ["a quoted command substitution", 'echo "result: $(cargo mutants --list)"'],
    ["backticks", "out=`cargo mutants --list`"],
    ["a nested shell", 'bash -ec "cargo mutants --manifest-path x"'],
    ["a nested shell behind sudo", "sudo sh -c 'cargo mutants --list'"],
    ["eval", "eval cargo mutants --list"],
    ["a quoted eval", 'eval "cargo mutants --list"'],
  ])("refuses %s", (_label, script) => {
    expect(problemsOf(script)).toEqual(["cargo-mutants without --in-place"]);
  });

  it("joins backslash continuations and honours an escaped separator", () => {
    expect(problemsOf("cargo mutants \\\n  --in-place \\\n  --manifest-path x\n")).toEqual([]);
    expect(problemsOf("cargo mutants \\; --in-place")).toEqual([]);
  });

  it("requires Stryker's first argument to be the config", () => {
    expect(problemsOf(`stryker run ${STRYKER_CONFIG}`)).toEqual([]);
    expect(problemsOf(`pnpm exec stryker run ${STRYKER_CONFIG} --dryRunOnly --disableBail`)).toEqual([]);
    expect(problemsOf(`node ./node_modules/@stryker-mutator/core/bin/stryker.js run ${STRYKER_CONFIG} --mutate a.ts`)).toEqual([]);
    const refused = (got) => [`stryker run whose first argument is not ${STRYKER_CONFIG} (got: ${got})`];
    expect(problemsOf("stryker run")).toEqual(refused("nothing"));
    expect(problemsOf("npx stryker run stryker.conf.json")).toEqual(refused("stryker.conf.json"));
    expect(problemsOf("pnpm --dir . stryker run --dryRunOnly")).toEqual(refused("--dryRunOnly"));
    expect(problemsOf("pnpm --filter vmark exec stryker run")).toEqual(refused("nothing"));
    expect(problemsOf(`stryker run --ignorePatterns ${STRYKER_CONFIG}`)).toEqual(refused("--ignorePatterns"));
    expect(scriptFindings("stryker init")).toEqual([]);
  });

  it("recognises a pnpm script run, and not a mention of one", () => {
    const runs = (script) => shellCommands(script).some((prog) => runsPnpmScript(prog, "mutation:ts"));
    expect(runs("pnpm mutation:ts")).toBe(true);
    expect(runs("pnpm --silent run mutation:ts")).toBe(true);
    expect(runs("pnpm --dir . mutation:ts")).toBe(true);
    expect(runs("# pnpm mutation:ts\necho skipped")).toBe(false);
    expect(runs('echo "pnpm mutation:ts"')).toBe(false);
    expect(runs("echo pnpm mutation:ts")).toBe(false);
    expect(runs('printf "%s\\n" pnpm mutation:ts')).toBe(false);
  });
});

describe("the real repository runs both mutation tools in place", () => {
  const workflowScripts = readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .flatMap((f) =>
      runScripts(parse(readFileSync(path.join(WORKFLOW_DIR, f), "utf8"))).map((script) => ({ where: f, script })),
    );
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const packageScripts = Object.entries(pkg.scripts ?? {}).map(([name, script]) => ({
    where: `package.json scripts.${name}`,
    script,
  }));
  const findings = [...workflowScripts, ...packageScripts].flatMap(({ where, script }) =>
    scriptFindings(script).map((f) => ({ ...f, where })),
  );

  it("invokes each tool at least once (a parser that stopped seeing them fails here)", () => {
    expect(findings.filter((f) => f.tool === "cargo-mutants").length).toBeGreaterThan(0);
    expect(findings.filter((f) => f.tool === "stryker").length).toBeGreaterThan(0);
  });

  it("every invocation of either tool tests the real tree", () => {
    const problems = findings.flatMap((f) => f.problems.map((p) => `${f.where}: ${p}: ${f.command}`));
    expect(problems).toEqual([]);
  });

  it("mutation.yml runs the mutation:ts script that the check above covers", () => {
    const runsScript = workflowScripts.some(
      ({ where, script }) =>
        where === "mutation.yml" && shellCommands(script).some((prog) => runsPnpmScript(prog, "mutation:ts")),
    );
    expect(runsScript).toBe(true);
    expect(scriptFindings(pkg.scripts["mutation:ts"]).map((f) => f.tool)).toEqual(["stryker"]);
  });

  it("Stryker mutates in place and leaves every other source file untouched", () => {
    const config = JSON.parse(readFileSync(path.join(REPO, STRYKER_CONFIG), "utf8"));
    expect(config.inPlace).toBe(true);
    expect(config.disableTypeChecks).toBe(false);
  });
});
