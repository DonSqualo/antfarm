/**
 * Minimal implementation for the ambiguous "testy test" requirement.
 *
 * Assumption/scope:
 * - "testy test" is interpreted as a lightweight self-check command that returns
 *   a concrete, deterministic payload proving code path + argument handling works.
 * - Out of scope for this story: persistence, network calls, or workflow side effects.
 */
export type TestyTestResult = {
  readonly name: string;
  readonly status: "ok";
  readonly message: string;
};

export function runTestyTest(rawName?: string): TestyTestResult {
  const normalized = (rawName ?? "default").trim().toLowerCase() || "default";

  return {
    name: normalized,
    status: "ok",
    message: `testy test ready: ${normalized}`,
  };
}
