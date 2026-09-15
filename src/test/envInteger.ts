/**
 * Purpose: read an integer tuning knob (a fuzz seed, a run count, a scale)
 *   from the environment without ever turning a bad value into 0.
 *
 * `Number(process.env.X ?? "default")` has two silent failure modes, and the
 * weekly soak hit the first: `??` falls back on null/undefined only, so a
 * variable that is SET but EMPTY — which is what a GitHub Actions
 * `${{ inputs.x }}` expands to on a scheduled run — reaches `Number("")` and
 * becomes 0. The soak's editing fuzz ran seed 0 instead of its documented seed
 * on every scheduled run, and missed three editor bugs (#1407). The second mode
 * is `Number("abc")`: NaN, which most consumers then clamp or ignore.
 *
 * So: unset means "use the default"; set means "this exact integer", and
 * anything else throws with the variable's name and the value it held.
 *
 * @coordinates-with scripts/check-workflow-input-fallbacks.test.mjs — the
 *   workflow-side half: no input reaches a step as a silent empty string
 * @module test/envInteger
 */

/** An optional-sign run of ASCII digits and nothing else. */
const INTEGER_LITERAL = /^-?[0-9]+$/;

/**
 * The integer in `process.env[name]`, or `fallback` when it is unset.
 *
 * @throws when the variable is set to anything but an integer literal that
 *   fits exactly in a double (empty, whitespace, `1.5`, `1e3`, `0x10`, …), or
 *   to one below `options.min`.
 */
export function readIntegerEnv(name: string, fallback: number, options: { min?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!INTEGER_LITERAL.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(
      `${name} must be an integer, got ${JSON.stringify(raw)}. ` +
        `Unset it to use the default (${fallback}).`,
    );
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be at least ${options.min}, got ${value}.`);
  }
  return value;
}
