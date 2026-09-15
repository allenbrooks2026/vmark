/**
 * Every tracked shell script must check out with LF line endings on every
 * platform.
 *
 * Git for Windows defaults to core.autocrlf=true, which rewrites text files to
 * CRLF on checkout, and bash reads the \r as part of each line: a CRLF copy of
 * `scripts/lint-console.sh` dies with `$'\r': command not found` and
 * `set: pipefail: invalid option name`. The repo had no `.gitattributes`, so a
 * contributor on Windows could not run `pnpm check:all` at all (PR #1403
 * reported it) and the git hooks broke the same way.
 *
 * The fix is per-path `eol=lf` in `.gitattributes`, which wins over autocrlf.
 * This test asks git itself (`git check-attr`) rather than parsing the file, so
 * it checks the rule git actually applies. Scripts are found by extension AND by
 * shebang: the hooks in `.githooks/` have no extension, so an extension-only
 * scan would pass while missing exactly the files that break a push.
 *
 * @coordinates-with .gitattributes — the rules under test
 * @module scripts/shell-script-eol.test
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SHELL_EXTENSION = /\.(sh|bash|zsh)$/;
/** `#!/bin/bash`, `#!/usr/bin/env bash`, `#!/bin/sh -e`, … */
const SHELL_SHEBANG = /^#!.*[/\s](?:ba|z|da|k)?sh(?:\s|$)/;

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function nulList(output) {
  return output.split("\0").filter(Boolean);
}

function firstLine(file) {
  const fd = openSync(path.join(REPO, file), "r");
  try {
    const buffer = Buffer.alloc(128);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/)[0];
  } finally {
    closeSync(fd);
  }
}

function isShellScript(file) {
  if (SHELL_EXTENSION.test(file)) return true;
  try {
    return SHELL_SHEBANG.test(firstLine(file));
  } catch {
    // Tracked but absent from the working tree (e.g. a sparse checkout).
    return false;
  }
}

/** `git check-attr -z eol` prints path NUL attr NUL value NUL per path. */
function eolAttributes(paths) {
  const fields = nulList(execFileSync("git", ["check-attr", "-z", "--stdin", "eol"], {
    cwd: REPO,
    encoding: "utf8",
    input: paths.join("\0"),
  }));
  const result = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) result.set(fields[i], fields[i + 2]);
  return result;
}

const shellScripts = nulList(git(["ls-files", "-z"])).filter(isShellScript);

describe("shell scripts keep LF line endings on every checkout", () => {
  it("finds the scripts it guards, including extensionless hooks", () => {
    // Guards the guard: a discovery that matched nothing would pass every
    // assertion below while checking no file at all.
    expect(shellScripts).toEqual(
      expect.arrayContaining([
        "scripts/lint-console.sh",
        ".githooks/pre-push",
        ".githooks/commit-msg",
        "src-tauri/resources/shell-integration/vmark.bash",
        "src-tauri/resources/shell-integration/vmark.zsh",
      ]),
    );
  });

  it("every tracked shell script is pinned to eol=lf", () => {
    const attributes = eolAttributes(shellScripts);
    const unpinned = shellScripts.filter((file) => attributes.get(file) !== "lf");
    expect(unpinned, `add an eol=lf rule to .gitattributes for: ${unpinned.join(", ")}`).toEqual([]);
  });

  it("a new script is covered before it is ever committed", () => {
    const probes = [
      "scripts/__eol_probe__.sh",
      "some/new/dir/__eol_probe__.bash",
      "some/new/dir/__eol_probe__.zsh",
      ".githooks/__eol_probe__",
    ];
    const attributes = eolAttributes(probes);
    expect(probes.map((probe) => [probe, attributes.get(probe)])).toEqual(
      probes.map((probe) => [probe, "lf"]),
    );
  });

  it("no shell script is committed with CRLF", () => {
    // eol=lf normalises on the NEXT add; a blob already stored with CRLF would
    // still check out broken until someone re-adds it.
    // Each record is "i/<index> w/<worktree> attr/<attrs>\t<path>".
    const committedCrlf = nulList(git(["ls-files", "-z", "--eol", "--", ...shellScripts]))
      .map((record) => record.split("\t"))
      .filter(([meta]) => /^i\/(?:crlf|mixed)\b/.test(meta))
      .map(([, file]) => file);
    expect(committedCrlf).toEqual([]);
  });
});
