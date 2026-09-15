// @vitest-environment node
/**
 * An integer knob read from the environment is the default when unset, and an
 * error — never 0 — when set to anything that is not an integer.
 *
 * The weekly soak ran its editing fuzz at seed 0 on every scheduled run: the
 * workflow passed `FUZZ_SEED: ${{ inputs.fuzz_seed }}`, which is the EMPTY
 * STRING when no dispatch inputs exist, and the test read
 * `Number(process.env.FUZZ_SEED ?? "20260805")`. `??` falls back on
 * null/undefined only, and `Number("") === 0`. At the documented seed the fuzz
 * failed on three real editor bugs that seed 0 never reached (#1407).
 */
import { afterEach, describe, expect, it } from "vitest";
import { readIntegerEnv } from "./envInteger";

const NAME = "VMARK_TEST_INTEGER_KNOB";

afterEach(() => {
  delete process.env[NAME];
});

describe("readIntegerEnv", () => {
  it("returns the fallback when the variable is unset", () => {
    expect(readIntegerEnv(NAME, 20260805)).toBe(20260805);
  });

  it.each([
    ["500", 500],
    ["0", 0],
    ["-7", -7],
    ["20260805", 20260805],
  ])("reads %j as %i", (raw, expected) => {
    process.env[NAME] = raw;
    expect(readIntegerEnv(NAME, 1)).toBe(expected);
  });

  // The defect: present but empty must not quietly become 0.
  it("refuses an empty value, naming the variable", () => {
    process.env[NAME] = "";
    expect(() => readIntegerEnv(NAME, 20260805)).toThrow(/VMARK_TEST_INTEGER_KNOB/);
    expect(() => readIntegerEnv(NAME, 20260805)).toThrow(/""/);
  });

  it.each(["abc", "1.5", "1e3", "0x10", " 5", "5 ", "+5", "NaN", "Infinity", "٣"])(
    "refuses %j",
    (raw) => {
      process.env[NAME] = raw;
      expect(() => readIntegerEnv(NAME, 1)).toThrow(/must be an integer/);
    },
  );

  it("refuses an integer too large to hold exactly", () => {
    process.env[NAME] = "9007199254740993";
    expect(() => readIntegerEnv(NAME, 1)).toThrow(/must be an integer/);
  });

  it("enforces a minimum", () => {
    process.env[NAME] = "0";
    expect(() => readIntegerEnv(NAME, 25, { min: 1 })).toThrow(/at least 1/);
    process.env[NAME] = "1";
    expect(readIntegerEnv(NAME, 25, { min: 1 })).toBe(1);
  });
});
