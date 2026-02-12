import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTestyTest } from "../src/lib/testy-test.ts";

describe("runTestyTest", () => {
  it("returns default normalized payload when name is missing", () => {
    assert.deepEqual(runTestyTest(), {
      name: "default",
      status: "ok",
      message: "testy test ready: default",
    });
  });

  it("normalizes provided names", () => {
    assert.deepEqual(runTestyTest("  Fancy Name  "), {
      name: "fancy name",
      status: "ok",
      message: "testy test ready: fancy name",
    });
  });
});
